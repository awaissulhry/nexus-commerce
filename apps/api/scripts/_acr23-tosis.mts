/** ACR.2.3 — is topOfSearchIS null everywhere, or only in IT/30d? READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(sql: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...a)

const all = await q<{ mkt: string; rows: bigint; with_is: bigint; first: Date; last: Date }>(`
  SELECT marketplace AS mkt, COUNT(*) AS rows,
         COUNT(*) FILTER (WHERE "topOfSearchIS" IS NOT NULL) AS with_is,
         MIN(date) AS first, MAX(date) AS last
  FROM "AmazonAdsPlacementReport" GROUP BY 1 ORDER BY 2 DESC`)
console.log('══ AmazonAdsPlacementReport, ALL TIME, all markets ══')
for (const r of all) console.log(`  ${r.mkt}  rows=${r.rows}  with ToS-IS=${r.with_is}  ${String(r.first).slice(0,10)} → ${String(r.last).slice(0,10)}`)

const ever = await q<{ c: bigint }>(`SELECT COUNT(*) AS c FROM "AmazonAdsPlacementReport" WHERE "topOfSearchIS" IS NOT NULL`)
console.log(`  rows with a non-null topOfSearchIS anywhere, ever: ${ever[0]?.c}`)

// Is the metric available on any OTHER surface? Search for an impression-share store.
const tabs = await q<{ table_name: string }>(`
  SELECT table_name::text AS table_name FROM information_schema.columns
  WHERE column_name ILIKE '%impressionshare%' OR column_name ILIKE '%topofsearch%'
     OR column_name ILIKE '%searchtermimpr%' GROUP BY 1 ORDER BY 1`)
console.log('  columns that look like impression share live in:', tabs.map((t) => t.table_name).join(', ') || '(none)')

for (const t of tabs) {
  const cols = await q<{ column_name: string }>(`
    SELECT column_name::text AS column_name FROM information_schema.columns WHERE table_name = $1
      AND (column_name ILIKE '%impressionshare%' OR column_name ILIKE '%topofsearch%' OR column_name ILIKE '%searchtermimpr%')`, t.table_name)
  for (const c of cols) {
    const cnt = await q<{ rows: bigint; nn: bigint }>(
      `SELECT COUNT(*) AS rows, COUNT("${c.column_name}") AS nn FROM "${t.table_name}"`)
    console.log(`    ${t.table_name}.${c.column_name}: ${cnt[0]?.nn} non-null of ${cnt[0]?.rows}`)
  }
}

// Placement mix per campaign — the substrate that CAN be computed today.
console.log('\n══ Placement mix, IT, 30d — top campaigns by impressions ══')
const mix = await q<{ camp: string; top: bigint; rest: bigint; detail: bigint; top_clicks: bigint; rest_clicks: bigint }>(`
  SELECT c.name AS camp,
    SUM(p.impressions) FILTER (WHERE p.placement = 'Top of Search on-Amazon') AS top,
    SUM(p.impressions) FILTER (WHERE p.placement = 'Other on-Amazon') AS rest,
    SUM(p.impressions) FILTER (WHERE p.placement = 'Detail Page on-Amazon') AS detail,
    SUM(p.clicks) FILTER (WHERE p.placement = 'Top of Search on-Amazon') AS top_clicks,
    SUM(p.clicks) FILTER (WHERE p.placement = 'Other on-Amazon') AS rest_clicks
  FROM "AmazonAdsPlacementReport" p
  JOIN "Campaign" c ON c."externalCampaignId" = p."campaignId" AND c.marketplace = p.marketplace
  WHERE p.date > now() - interval '30 days' AND p.marketplace = 'IT'
  GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 10`)
for (const m of mix) {
  const top = Number(m.top ?? 0), rest = Number(m.rest ?? 0), det = Number(m.detail ?? 0)
  const tot = top + rest + det
  console.log(`  ${String(m.camp).slice(0,34).padEnd(36)} top=${top.toLocaleString()} (${tot ? ((top/tot)*100).toFixed(1) : '0'}%) rest=${rest.toLocaleString()} detail=${det.toLocaleString()}`)
}

// Account-level CTR by placement — the measured position weight.
console.log('\n══ Measured CTR by placement (IT, 90d) — the position weight ══')
const ctr = await q<{ placement: string; impr: bigint; clicks: bigint; sales: bigint }>(`
  SELECT placement, SUM(impressions) AS impr, SUM(clicks) AS clicks, SUM("sales7dCents") AS sales
  FROM "AmazonAdsPlacementReport" WHERE marketplace='IT' AND date > now() - interval '90 days'
  GROUP BY 1 ORDER BY 2 DESC`)
const byP = new Map(ctr.map((r) => [r.placement, r]))
const topR = byP.get('Top of Search on-Amazon'), restR = byP.get('Other on-Amazon')
for (const r of ctr) {
  const c = Number(r.impr) > 0 ? Number(r.clicks) / Number(r.impr) : 0
  console.log(`  ${String(r.placement).padEnd(26)} impr=${Number(r.impr).toLocaleString()} CTR=${(c*100).toFixed(3)}%`)
}
if (topR && restR) {
  const tc = Number(topR.clicks) / Number(topR.impr), rc = Number(restR.clicks) / Number(restR.impr)
  console.log(`  → rest-of-search CTR / top-of-search CTR = ${(rc / tc).toFixed(3)}`)
}
await prisma.$disconnect()
