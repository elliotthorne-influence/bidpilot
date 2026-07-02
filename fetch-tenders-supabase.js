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

/* ---- Supabase connection (from environment, never hard-coded) ---- */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key: server-side only
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables.");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
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
      const noticeId = (pkg.ocid ?? "").replace("ocds-h6vhtk-", "");
      out.push({
        id: pkg.ocid,
        source: "Find a Tender",
        title: t.title ?? "Untitled notice",
        buyer: pkg.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
        description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
        pre_engagement: null,
        question_deadline: t.enquiryPeriod?.endDate ?? null,
        submission_deadline: submissionDeadline,
        url: noticeId
          ? `https://www.find-tender.service.gov.uk/Notice/${noticeId}`
          : "https://www.find-tender.service.gov.uk/"
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


/* ---- 3. SELL2WALES ---- */
// API: https://api.sell2wales.gov.wales/v1/Notices?dateFrom=MM-YYYY&noticeType=N&outputType=0
// noticeType 2 = OJEU Contract Notice, 102 = Website Contract Notice
async function fetchS2W() {
  const out = [];
  const d = new Date();
  const months = [
    `${String(d.getMonth() + 1).padStart(2,"0")}-${d.getFullYear()}`,
    `${String((new Date(d.getFullYear(), d.getMonth()-1,1)).getMonth()+1).padStart(2,"0")}-${(new Date(d.getFullYear(), d.getMonth()-1,1)).getFullYear()}`
  ];
  for (const month of months) {
    for (const noticeType of [2, 102]) {
      const url = `https://api.sell2wales.gov.wales/v1/Notices?dateFrom=${month}&noticeType=${noticeType}&outputType=0`;
      let res;
      try { res = await fetch(url, { headers: { Accept: "application/json" } }); }
      catch (e) { console.error("S2W network error:", e.message); continue; }
      if (!res.ok) { console.error("S2W HTTP", res.status); continue; }
      let data;
      try { data = await res.json(); }
      catch (e) { console.error("S2W JSON parse error:", e.message); continue; }
      for (const pkg of data.releases ?? data ?? []) {
        const t = pkg.tender ?? {};
        const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
        if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
        const submissionDeadline = t.tenderPeriod?.endDate ?? null;
        const publishedDate = pkg.date ?? pkg.publishedDate ?? null;
        if (!stillOpen(submissionDeadline, publishedDate)) continue;
        const noticeNum = (pkg.ocid ?? "").replace("ocds-kuma6s-", "");
        out.push({
          id: pkg.ocid ?? `s2w-${out.length}`,
          source: "Sell2Wales",
          title: t.title ?? "Untitled notice",
          buyer: pkg.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
          description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
          pre_engagement: null,
          question_deadline: t.enquiryPeriod?.endDate ?? null,
          submission_deadline: submissionDeadline,
          url: noticeNum
            ? `https://www.sell2wales.gov.wales/search/search_switch.aspx?ID=${noticeNum}`
            : "https://www.sell2wales.gov.wales/"
        });
      }
    }
  }
  const seen = new Set();
  return out.filter(r => { if(seen.has(r.id)) return false; seen.add(r.id); return true; });
}

/* ---- 4. PUBLIC CONTRACTS SCOTLAND ---- */
// API: https://api.publiccontractsscotland.gov.uk/v1/Notices?dateFrom=MM-YYYY&noticeType=N&outputType=0
// noticeType 2 = OJEU Contract Notice, 102 = Website Contract Notice
async function fetchPCS() {
  const out = [];
  const d = new Date();
  const months = [
    `${String(d.getMonth() + 1).padStart(2,"0")}-${d.getFullYear()}`,
    `${String((new Date(d.getFullYear(), d.getMonth()-1,1)).getMonth()+1).padStart(2,"0")}-${(new Date(d.getFullYear(), d.getMonth()-1,1)).getFullYear()}`
  ];
  for (const month of months) {
    for (const noticeType of [2, 102]) {
      const url = `https://api.publiccontractsscotland.gov.uk/v1/Notices?dateFrom=${month}&noticeType=${noticeType}&outputType=0`;
      let res;
      try { res = await fetch(url, { headers: { Accept: "application/json" } }); }
      catch (e) { console.error("PCS network error:", e.message); continue; }
      if (!res.ok) { console.error("PCS HTTP", res.status); continue; }
      let data;
      try { data = await res.json(); }
      catch (e) { console.error("PCS JSON parse error:", e.message); continue; }
      for (const pkg of data.releases ?? data ?? []) {
        const t = pkg.tender ?? {};
        const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
        if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
        const submissionDeadline = t.tenderPeriod?.endDate ?? null;
        const publishedDate = pkg.date ?? pkg.publishedDate ?? null;
        if (!stillOpen(submissionDeadline, publishedDate)) continue;
        const noticeNum = (pkg.ocid ?? "").replace("ocds-r6ebe6-", "");
        out.push({
          id: pkg.ocid ?? `pcs-${out.length}`,
          source: "Public Contracts Scotland",
          title: t.title ?? "Untitled notice",
          buyer: pkg.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
          description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
          pre_engagement: null,
          question_deadline: t.enquiryPeriod?.endDate ?? null,
          submission_deadline: submissionDeadline,
          url: noticeNum
            ? `https://www.publiccontractsscotland.gov.uk/search/show/search_view.aspx?ID=${noticeNum}`
            : "https://www.publiccontractsscotland.gov.uk/"
        });
      }
    }
  }
  const seen = new Set();
  return out.filter(r => { if(seen.has(r.id)) return false; seen.add(r.id); return true; });
}

/* ---- Run, merge, de-duplicate, upsert into Supabase ---- */
async function main() {
  const [fts, cf, s2w, pcs] = await Promise.all([fetchFTS(), fetchCF(), fetchS2W(), fetchPCS()]);
  const byId = new Map();
  for (const row of [...fts, ...cf, ...s2w, ...pcs]) if (!byId.has(row.id)) byId.set(row.id, row);
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
  console.log(`Upserted ${rows.length} live opportunities into Supabase (FTS ${fts.length}, CF ${cf.length}, S2W ${s2w.length}, PCS ${pcs.length}).`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
