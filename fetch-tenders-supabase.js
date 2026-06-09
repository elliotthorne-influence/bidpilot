// fetch-tenders-supabase.js
// Same fetching/filtering as fetch-tenders.js, but instead of writing a flat
// tenders.json it UPSERTS rows into a Supabase table ("tenders"). This is the
// shared-team version: every colleague's BidPilot reads from the same database,
// and the pursue-pipeline / bid-history can live alongside it.
//
// Run locally:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node fetch-tenders-supabase.js
// On a schedule: see .github/workflows/fetch-tenders.yml (Supabase secrets added).
//
// Requires: npm install @supabase/supabase-js
//
// Confirm endpoint paths/params against the official docs before relying on it:
//   Find a Tender:    https://www.find-tender.service.gov.uk/Developer/Documentation
//   Contracts Finder: https://www.contractsfinder.service.gov.uk/apidocumentation/home

import { createClient } from "@supabase/supabase-js";
import ws from "ws";

/* ---- Supabase connection (from environment, never hard-coded) ---- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key: server-side only
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
  realtime: { transport: ws }
});

/* ---- Filter: CPV codes that map to agency disciplines ---- */
const CPV = [
  "79340000","79341000","79341400","79342000",
  "79822500","79416000","72413000","92111000","79952000"
];
const KEYWORDS = [
  "marketing","advertising","creative","social media","paid media","media buying",
  "media planning","brand","campaign","content","audience","insight","communications",
  "digital marketing","public relations","film production","video production","design agency"
];

const LOOKBACK_DAYS = 30;
const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
const now   = new Date();
const isoNoMs = d => d.toISOString().split(".")[0];
const dayOnly = d => d.toISOString().split("T")[0];

function isRelevant(title, desc, cpvList) {
  if (cpvList.some(c => CPV.includes((c || "").slice(0, 8)))) return true;
  const text = `${title} ${desc}`.toLowerCase();
  return KEYWORDS.some(k => text.includes(k));
}
function stillOpen(submissionDeadline) {
  if (!submissionDeadline) return true;
  return new Date(submissionDeadline) >= new Date();
}

/* ---- 1. FIND A TENDER ---- */
async function fetchFTS() {
  const out = [];
  let next = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`
           + `?updatedFrom=${isoNoMs(since)}&updatedTo=${isoNoMs(now)}`;
  let pages = 0;
  while (next && pages < 50) {
    let res;
    try { res = await fetch(next, { headers: { Accept: "application/json" } }); }
    catch (e) { console.error("FTS network error:", e.message); break; }
    if (!res.ok) { console.error("FTS HTTP", res.status); break; }
    const data = await res.json();
    for (const pkg of data.releases ?? []) {
      const t = pkg.tender ?? {};
      const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
      if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
      if (!["active", "planning"].includes(t.status)) continue;
      const submissionDeadline = t.tenderPeriod?.endDate ?? null;
      if (!stillOpen(submissionDeadline)) continue;
      // Pull the real notice URL from the documents array first,
      // then fall back to tender.id, then null
      const docUrl = (t.documents ?? []).find(d => d.url?.includes("find-tender"))?.url ?? null;
      const tenderId = t.id ?? "";
      const ftsUrl = docUrl
        ?? (tenderId ? `https://www.find-tender.service.gov.uk/Notice/${tenderId}` : null)
        ?? "https://www.find-tender.service.gov.uk/";
      out.push({
        id: pkg.ocid,
        source: "Find a Tender",
        title: t.title ?? "Untitled notice",
        buyer: pkg.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
        description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
        pre_engagement: null,
        question_deadline: t.enquiryPeriod?.endDate ?? null,
        submission_deadline: submissionDeadline,
        url: ftsUrl
      });
    }
    next = data.links?.next ?? null;
    pages++;
  }
  return out;
}

/* ---- 2. CONTRACTS FINDER ---- */
async function fetchCF() {
  const out = [];
  const url = `https://www.contractsfinder.service.gov.uk/Published/Notices/OCDS/Search`
            + `?publishedFrom=${dayOnly(since)}&publishedTo=${dayOnly(now)}&size=100`;
  let res;
  try { res = await fetch(url, { headers: { Accept: "application/json" } }); }
  catch (e) { console.error("CF network error:", e.message); return out; }
  if (!res.ok) { console.error("CF HTTP", res.status); return out; }
  const data = await res.json();
  for (const rec of data.results ?? []) {
    const r = rec.releases?.[0] ?? rec;
    const t = r.tender ?? {};
    const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
    if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
    const submissionDeadline = t.tenderPeriod?.endDate ?? null;
    if (!stillOpen(submissionDeadline)) continue;
    out.push({
      id: r.ocid ?? `cf-${out.length}`,
      source: "Contracts Finder",
      title: t.title ?? "Untitled notice",
      buyer: r.buyer?.name ?? r.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
      description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      pre_engagement: null,
      question_deadline: t.enquiryPeriod?.endDate ?? null,
      submission_deadline: submissionDeadline,
      url: t.documents?.[0]?.url
        ?? `https://www.contractsfinder.service.gov.uk/notice/${r.ocid ?? ""}`
    });
  }
  return out;
}

/* ---- Run, merge, de-duplicate, upsert into Supabase ---- */
async function main() {
  const [fts, cf] = await Promise.all([fetchFTS(), fetchCF()]);
  const byId = new Map();
  for (const row of [...fts, ...cf]) if (!byId.has(row.id)) byId.set(row.id, row);
  const rows = Array.from(byId.values()).map(r => ({ ...r, refreshed_at: new Date().toISOString() }));

  if (!rows.length) {
    console.log("No relevant open tenders found this run — nothing to upsert.");
    return;
  }

  // Upsert on the primary key `id`: new notices inserted, existing ones updated.
  const { error } = await supabase
    .from("tenders")
    .upsert(rows, { onConflict: "id" });

  if (error) {
    console.error("Supabase upsert failed:", error.message);
    process.exit(1);
  }
  console.log(`Upserted ${rows.length} live opportunities into Supabase (FTS ${fts.length}, CF ${cf.length}).`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
