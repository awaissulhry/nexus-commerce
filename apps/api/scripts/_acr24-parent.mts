/**
 * ACR.2.4 — is the 10-ASIN SERP presence ONE Amazon variation family? READ-ONLY.
 *
 * Part 3.1 of the plan states the rule: "True variations of one parent collapse to one tile."
 * ACR.2.1 counted ten of our ASINs on `giacca moto estiva uomo` and concluded multi-product
 * presence is the status quo. Those two statements are only compatible if the ten ASINs are
 * ten DIFFERENT parents. This checks, against Amazon's own parentAsin — not our internal
 * Product.parentId, which is our hierarchy and need not match Amazon's variation family.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(sql: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...a)

console.log('\n══ The 10 measured ASINs, by AMAZON parentAsin ══')
const rows = await q<{ asin: string; sku: string; parent_asin: string; our_parent: string; impr: bigint }>(`
  SELECT s.asin,
         COALESCE(MAX(p.sku), '(not in catalogue)') AS sku,
         COALESCE(MAX(p."parentAsin"), '(null)') AS parent_asin,
         COALESCE(MAX(par.name), '(none)') AS our_parent,
         SUM(s."impressionsBrand") AS impr
  FROM "SearchQueryPerformance" s
  LEFT JOIN "Product" p ON p."amazonAsin" = s.asin AND p."deletedAt" IS NULL
  LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE s.marketplace = 'IT' AND s."impressionsBrand" > 0
  GROUP BY s.asin ORDER BY 5 DESC`)
for (const r of rows) console.log(`  ${r.asin}  ${String(r.sku).padEnd(26)} amazonParent=${String(r.parent_asin).padEnd(12)} impr=${String(r.impr).padStart(6)}`)
const parents = new Set(rows.map((r) => r.parent_asin))
console.log(`\n  distinct Amazon parentAsin values among the measured ASINs: ${parents.size} → ${[...parents].join(', ')}`)

console.log('\n══ Does family share depend on k? (single family, market-size controlled) ══')
console.log('   Part 3.1 predicts ONE tile per variation family, so family share should NOT rise with k.\n')
const cells = await q<{ term: string; mkt: bigint; k: bigint; ours: bigint }>(`
  WITH mkt AS (
    SELECT "searchQuery" AS term, MAX("impressionsTotal") AS mkt
    FROM "SearchQueryPerformance" WHERE marketplace='IT' AND "startDate" = '2026-07-19'::date GROUP BY 1
  )
  SELECT s."searchQuery" AS term, m.mkt,
         COUNT(DISTINCT s.asin) AS k, SUM(s."impressionsBrand") AS ours
  FROM "SearchQueryPerformance" s JOIN mkt m ON m.term = s."searchQuery"
  WHERE s.marketplace='IT' AND s."startDate" = '2026-07-19'::date AND s."impressionsBrand" > 0 AND m.mkt > 0
  GROUP BY 1, 2 ORDER BY 2 DESC`)

const bands: Array<[string, number, number]> = [
  ['100k+', 100_000, Infinity], ['25k–100k', 25_000, 100_000],
  ['5k–25k', 5_000, 25_000], ['1k–5k', 1_000, 5_000], ['under 1k', 0, 1_000],
]
for (const [label, lo, hi] of bands) {
  const inBand = cells.filter((c) => Number(c.mkt) >= lo && Number(c.mkt) < hi)
  if (inBand.length === 0) continue
  const byK = new Map<number, typeof inBand>()
  for (const c of inBand) { const k = Number(c.k); const a = byK.get(k) ?? []; a.push(c); byK.set(k, a) }
  const parts = [...byK.keys()].sort((a, b) => a - b).map((k) => {
    const cs = byK.get(k)!
    // Pooled, not an average of ratios — the same trap ACR.2.1 recorded.
    const ours = cs.reduce((s, c) => s + Number(c.ours), 0)
    const mkt = cs.reduce((s, c) => s + Number(c.mkt), 0)
    return `k=${k}: ${((ours / mkt) * 100).toFixed(2)}% (n=${cs.length})`
  })
  console.log(`   ${label.padEnd(9)} ${parts.join('  ')}`)
}

console.log('\n══ Per-ASIN share as k rises (pooled within market-size band) ══')
for (const [label, lo, hi] of bands) {
  const inBand = cells.filter((c) => Number(c.mkt) >= lo && Number(c.mkt) < hi)
  if (inBand.length === 0) continue
  const byK = new Map<number, typeof inBand>()
  for (const c of inBand) { const k = Number(c.k); const a = byK.get(k) ?? []; a.push(c); byK.set(k, a) }
  const parts = [...byK.keys()].sort((a, b) => a - b).map((k) => {
    const cs = byK.get(k)!
    const ours = cs.reduce((s, c) => s + Number(c.ours), 0)
    const mkt = cs.reduce((s, c) => s + Number(c.mkt), 0)
    return `k=${k}: ${((ours / mkt / k) * 100).toFixed(3)}%`
  })
  console.log(`   ${label.padEnd(9)} ${parts.join('  ')}`)
}

await prisma.$disconnect()
