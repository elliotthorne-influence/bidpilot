// fetch-tenders.js
// Pulls live marketing/creative tenders from Find a Tender + Contracts Finder
// (OCDS APIs) and writes a single tenders.json that BidPilot reads.
//
// Run locally:  node fetch-tenders.js
// Run on a schedule: see .github/workflows/fetch-tenders.yml
//
// No API key required for these public OCDS feeds (Open Government Licence).
// IMPORTANT: confirm endpoint paths/params against the current official docs:
//   Find a Tender:   https://www.find-tender.service.gov.uk/Developer/Documentation
//   Contracts Finder: https://www.contractsfinder.service.gov.uk/apidocumentation/home

import fs from "node:fs/promises";

/* ---- Filter: CPV codes that map to agency disciplines ---- */
const CPV = [
  "79340000", // advertising and marketing services
  "79341000", // advertising services
  "79341400", // advertising campaign services
  "79342000", // marketing services
  "79822500", // graphic design services
  "79416000", // public relations services
  "72413000", // website design services
  "92111000", // motion picture / video production
  "79952000"  // event services
];

const KEYWORDS = [
  "marketing","advertising","creative","social media","paid media","media buying",
  "media planning","brand","campaign","content","audience","insight","communications",
  "digital marketing","public relations","film production","video production","design agency"
];

/* ---- Lookback window for each run ---- */
const LOOKBACK_DAYS = 30; // generous so nothing is missed between runs
const since = new Date(Date.now() - LOOKBACK_DAYS * 864e5);
const now   = new Date();
const isoNoMs = d => d.toISOString().split(".")[0];          // FTS: 2026-06-08T00:00:00
const dayOnly = d => d.toISOString().split("T")[0];          // CF:  2026-06-08

/* ---- Relevance test ---- */
function isRelevant(title, desc, cpvList) {
  if (cpvList.some(c => CPV.includes((c || "").slice(0, 8)))) return true;
  const text = `${title} ${desc}`.toLowerCase();
  return KEYWORDS.some(k => text.includes(k));
}

/* ---- Keep only opportunities still open (deadline in the future) ---- */
// Drop anything with a submission deadline more than 3 months in the past.
// If no deadline is stated, only keep if published within the last 3 months.
const THREE_MONTHS_AGO = new Date(Date.now() - 90 * 864e5);

function stillOpen(submissionDeadline, publishedDate) {
  if (submissionDeadline) {
    return new Date(submissionDeadline) >= THREE_MONTHS_AGO;
  }
  if (publishedDate) {
    return new Date(publishedDate) >= THREE_MONTHS_AGO;
  }
  // No deadline and no published date — drop to avoid ancient notices
  return false;
}

/* ---- 1. FIND A TENDER ---- */
async function fetchFTS() {
  const out = [];
  let next = `https://www.find-tender.service.gov.uk/api/1.0/ocdsReleasePackages`
           + `?updatedFrom=${isoNoMs(since)}&updatedTo=${isoNoMs(now)}`;
  let pages = 0;
  while (next && pages < 50) {           // safety cap on pagination
    let res;
    try { res = await fetch(next, { headers: { "Accept": "application/json" } }); }
    catch (e) { console.error("FTS network error:", e.message); break; }
    if (!res.ok) { console.error("FTS HTTP", res.status); break; }
    const data = await res.json();
    for (const pkg of data.releases ?? []) {
      const t = pkg.tender ?? {};
      const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
      if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
      if (!["active", "planning"].includes(t.status)) continue;
      const submissionDeadline = t.tenderPeriod?.endDate ?? null;
      const publishedDate = pkg.date ?? pkg.publishedDate ?? null;
      if (!stillOpen(submissionDeadline, publishedDate)) continue;
      // Find the real notice URL from the documents array first,
      // then try tender.id, then fall back to null (portalUrl in the HTML will handle it)
      const docUrl = (t.documents ?? []).find(d => d.url?.includes("find-tender"))?.url ?? null;
      const tenderId = t.id ?? "";
      // tender.id sometimes contains the real notice number e.g. "054201-2026"
      const ftsUrl = docUrl
        ?? (tenderId ? `https://www.find-tender.service.gov.uk/Notice/${tenderId}` : null);
      out.push({
        id: pkg.ocid,
        source: "Find a Tender",
        title: t.title ?? "Untitled notice",
        buyer: pkg.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
        description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
        preEngagement: null,
        questionDeadline: t.enquiryPeriod?.endDate ?? null,
        submissionDeadline,
        url: ftsUrl ?? "https://www.find-tender.service.gov.uk/"
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
  try { res = await fetch(url, { headers: { "Accept": "application/json" } }); }
  catch (e) { console.error("CF network error:", e.message); return out; }
  if (!res.ok) { console.error("CF HTTP", res.status); return out; }
  const data = await res.json();
  for (const rec of data.results ?? []) {
    const r = rec.releases?.[0] ?? rec;
    const t = r.tender ?? {};
    const cpv = (t.items ?? []).map(i => i.classification?.id ?? "");
    if (!isRelevant(t.title ?? "", t.description ?? "", cpv)) continue;
    const submissionDeadline = t.tenderPeriod?.endDate ?? null;
    const publishedDate = r.date ?? r.publishedDate ?? null;
    if (!stillOpen(submissionDeadline, publishedDate)) continue;
    out.push({
      id: r.ocid ?? `cf-${out.length}`,
      source: "Contracts Finder",
      title: t.title ?? "Untitled notice",
      buyer: r.buyer?.name ?? r.parties?.find(p => p.roles?.includes("buyer"))?.name ?? "",
      description: (t.description ?? "").replace(/\s+/g, " ").trim().slice(0, 600),
      preEngagement: null,
      questionDeadline: t.enquiryPeriod?.endDate ?? null,
      submissionDeadline,
      url: t.documents?.[0]?.url
        ?? `https://www.contractsfinder.service.gov.uk/notice/${r.ocid ?? ""}`
    });
  }
  return out;
}

/* ---- Run, merge, de-duplicate, sort, save ---- */
async function main() {
  const [fts, cf] = await Promise.all([fetchFTS(), fetchCF()]);
  const merged = [...fts, ...cf];

  // de-duplicate by id
  const byId = new Map();
  for (const row of merged) if (!byId.has(row.id)) byId.set(row.id, row);
  const rows = Array.from(byId.values());

  // sort by soonest submission deadline (nulls last)
  rows.sort((a, b) => {
    const da = a.submissionDeadline ? new Date(a.submissionDeadline) : Infinity;
    const db = b.submissionDeadline ? new Date(b.submissionDeadline) : Infinity;
    return da - db;
  });

  const payload = { generatedAt: new Date().toISOString(), count: rows.length, tenders: rows };
  await fs.writeFile("tenders.json", JSON.stringify(payload, null, 2));
  console.log(`Saved ${rows.length} live opportunities to tenders.json (FTS ${fts.length}, CF ${cf.length}).`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
