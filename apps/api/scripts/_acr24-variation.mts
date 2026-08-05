/**
 * ACR.2.4 — the variation experiment. READ-ONLY.
 *
 * QUESTION: do two child ASINs of one parent ever co-occupy a SERP — i.e. does AIREON's
 * unified parent cost us coverage?
 *
 * WHY A RAW COUNT IS NOT THE ANSWER. SQP is a WEEKLY aggregate of (term × ASIN) rows. Ten
 * siblings each carrying impressions on one term is equally consistent with:
 *   (A) ten independent SERP slots — the parent costs nothing, or
 *   (B) ONE slot that Amazon filled with a different featured child on different searches,
 *       the impressions merely attributed to whichever child was shown.
 * Weekly aggregation cannot tell those apart by counting.
 *
 * THE DISCRIMINATOR. Under (B) a family holds one slot however many children it has, so the
 * family's TOTAL share is flat in k and each child's share falls as 1/k. Under (A) each child
 * earns its own share, so per-child share is flat in k and the family total rises with k.
 * Those predictions are opposite and both are measurable on one week.
 *
 * THE CONFOUND, and the control for it. More of our ASINs appear on bigger, broader terms, so
 * a naive across-term comparison measures term size, not slot mechanics. Every comparison below
 * is therefore WITHIN-TERM: on a single term, families that have k children present are
 * compared against families that have exactly one, so the term (its market size, its breadth,
 * its competition) is held fixed by construction.
 *
 * Market impressions use MAX, never SUM — the query-level totals are duplicated on every ASIN
 * row (ACR.2.7).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const q = <T>(sql: string, ...a: unknown[]) => prisma.$queryRawUnsafe<T[]>(sql, ...a)
const n = (v: unknown) => Number(v ?? 0)

const wk = await q<{ week: string }>(`
  SELECT "startDate"::text AS week FROM "SearchQueryPerformance"
  WHERE marketplace='IT' GROUP BY 1 HAVING SUM("impressionsBrand") > 0 ORDER BY 1 DESC LIMIT 1`)
const week = wk[0]!.week.slice(0, 10)
console.log(`\n═══ ACR.2.4 · variation experiment · IT · week ${week} ═══`)

/** One row per (term, ASIN) that took impressions, with its family and the family's size on that term. */
type Cell = {
  term: string; asin: string; parent: string; parent_name: string
  ours: number; mkt: number; k: number; families: number
}
const cells = (await q<{
  term: string; asin: string; parent: string; parent_name: string
  ours: bigint; mkt: bigint; k: bigint; families: bigint
}>(`
  WITH fam AS (
    SELECT p."amazonAsin" AS asin, COALESCE(p."parentId", p.id) AS parent
    FROM "Product" p
    WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
    GROUP BY 1, 2
  ),
  -- Market size once per term. MAX, never SUM (ACR.2.7): the query-level totals are
  -- duplicated identically on every ASIN row.
  mkt AS (
    SELECT "searchQuery" AS term, MAX("impressionsTotal") AS mkt
    FROM "SearchQueryPerformance"
    WHERE marketplace = 'IT' AND "startDate" = $1::date
    GROUP BY 1
  ),
  cell AS (
    SELECT s."searchQuery" AS term, s.asin, fam.parent, SUM(s."impressionsBrand") AS ours
    FROM "SearchQueryPerformance" s
    JOIN fam ON fam.asin = s.asin
    WHERE s.marketplace = 'IT' AND s."startDate" = $1::date AND s."impressionsBrand" > 0
    GROUP BY 1, 2, 3
  )
  SELECT c.term, c.asin, c.parent, COALESCE(par.name, c.parent) AS parent_name,
         c.ours, m.mkt,
         COUNT(*) OVER (PARTITION BY c.term, c.parent) AS k,
         0::bigint AS families
  FROM cell c
  JOIN mkt m ON m.term = c.term
  LEFT JOIN "Product" par ON par.id = c.parent
  WHERE m.mkt > 0`, week)).map((r): Cell => ({
    term: r.term, asin: r.asin, parent: r.parent, parent_name: String(r.parent_name),
    ours: n(r.ours), mkt: n(r.mkt), k: n(r.k), families: n(r.families),
  }))

console.log(`\n${cells.length} (term × ASIN) cells carrying impressions · ${new Set(cells.map((c) => c.term)).size} terms · ${new Set(cells.map((c) => c.asin)).size} ASINs`)

// ── Test 1 · WITHIN-TERM: per-ASIN share as k rises ─────────────────────────────────────────
// Only terms that contain BOTH a k=1 family and a k≥2 family can discriminate. On those terms
// the k=1 families are the control group and the term itself is held fixed.
const byTerm = new Map<string, Cell[]>()
for (const c of cells) { const a = byTerm.get(c.term) ?? []; a.push(c); byTerm.set(c.term, a) }

type Pair = { term: string; k: number; soloShare: number; multiPerAsinShare: number; multiFamilyShare: number; mkt: number }
const pairs: Pair[] = []
for (const [term, cs] of byTerm) {
  const byFam = new Map<string, Cell[]>()
  for (const c of cs) { const a = byFam.get(c.parent) ?? []; a.push(c); byFam.set(c.parent, a) }
  const solo = [...byFam.values()].filter((f) => f.length === 1)
  const multi = [...byFam.values()].filter((f) => f.length >= 2)
  if (solo.length === 0 || multi.length === 0) continue
  const mkt = cs[0]!.mkt
  const soloShare = solo.reduce((s, f) => s + f[0]!.ours, 0) / solo.length / mkt
  for (const f of multi) {
    const famImpr = f.reduce((s, c) => s + c.ours, 0)
    pairs.push({ term, k: f.length, soloShare, multiPerAsinShare: famImpr / f.length / mkt, multiFamilyShare: famImpr / mkt, mkt })
  }
}
console.log(`\n── Test 1 · within-term control (${pairs.length} multi-child families on ${new Set(pairs.map((p) => p.term)).size} terms that also carry a single-child family) ──`)
console.log('   If ONE slot rotates: per-ASIN share ≈ solo share / k, and family share ≈ solo share.')
console.log('   If slots are independent: per-ASIN share ≈ solo share, and family share ≈ solo share × k.\n')
console.log('   k   families  per-ASIN share   solo share (same terms)   ratio    family share   family/solo')
const kBuckets = new Map<number, Pair[]>()
for (const p of pairs) { const a = kBuckets.get(p.k) ?? []; a.push(p); kBuckets.set(p.k, a) }
for (const k of [...kBuckets.keys()].sort((a, b) => a - b)) {
  const ps = kBuckets.get(k)!
  const perAsin = ps.reduce((s, p) => s + p.multiPerAsinShare, 0) / ps.length
  const soloAvg = ps.reduce((s, p) => s + p.soloShare, 0) / ps.length
  const famAvg = ps.reduce((s, p) => s + p.multiFamilyShare, 0) / ps.length
  console.log(`   ${String(k).padStart(2)}   ${String(ps.length).padStart(6)}    ${(perAsin * 100).toFixed(4)}%        ${(soloAvg * 100).toFixed(4)}%            ${(perAsin / soloAvg).toFixed(2)}×   ${(famAvg * 100).toFixed(4)}%      ${(famAvg / soloAvg).toFixed(2)}×`)
}
console.log('\n   Predictions to compare the "ratio" and "family/solo" columns against:')
for (const k of [...kBuckets.keys()].sort((a, b) => a - b)) {
  console.log(`     k=${k}: one-slot → ratio ${(1 / k).toFixed(2)}×, family/solo 1.00×  |  independent → ratio 1.00×, family/solo ${k.toFixed(2)}×`)
}

// ── Test 2 · the same comparison, weighted by market size ───────────────────────────────────
// A mean over terms lets a hundred tail terms outvote the head terms the programme is about.
const wPerAsin = pairs.reduce((s, p) => s + p.multiPerAsinShare * p.mkt, 0) / pairs.reduce((s, p) => s + p.mkt, 0)
const wSolo = pairs.reduce((s, p) => s + p.soloShare * p.mkt, 0) / pairs.reduce((s, p) => s + p.mkt, 0)
const wFam = pairs.reduce((s, p) => s + p.multiFamilyShare * p.mkt, 0) / pairs.reduce((s, p) => s + p.mkt, 0)
console.log(`\n── Test 2 · impression-weighted (head terms dominate, as they should) ──`)
console.log(`   per-ASIN share ${(wPerAsin * 100).toFixed(4)}%  ·  solo share ${(wSolo * 100).toFixed(4)}%  ·  ratio ${(wPerAsin / wSolo).toFixed(2)}×`)
console.log(`   family share   ${(wFam * 100).toFixed(4)}%  ·  family/solo ${(wFam / wSolo).toFixed(2)}×`)

// ── Test 3 · AIREON specifically ────────────────────────────────────────────────────────────
console.log('\n── Test 3 · AIREON, the unified parent ──')
const air = await q<{ id: string; name: string; asins: bigint }>(`
  SELECT COALESCE(p."parentId", p.id) AS id, MAX(par.name) AS name, COUNT(DISTINCT p."amazonAsin") AS asins
  FROM "Product" p LEFT JOIN "Product" par ON par.id = COALESCE(p."parentId", p.id)
  WHERE p."amazonAsin" IS NOT NULL AND p."deletedAt" IS NULL
    AND (par.name ILIKE '%AIREON%' OR p.name ILIKE '%AIREON%' OR p.sku ILIKE '%AIREON%')
  GROUP BY 1 ORDER BY 3 DESC`)
for (const a of air) console.log(`   parent ${a.id} · ${String(a.name).slice(0, 46)} · ${a.asins} ASINs`)
const airIds = new Set(air.map((a) => a.id))
const airCells = cells.filter((c) => airIds.has(c.parent))
const airTerms = new Map<string, Cell[]>()
for (const c of airCells) { const a = airTerms.get(c.term) ?? []; a.push(c); airTerms.set(c.term, a) }
const airMulti = [...airTerms.entries()].filter(([, cs]) => cs.length >= 2).sort((a, b) => b[1].length - a[1].length)
console.log(`   AIREON appears on ${airTerms.size} terms; on ${airMulti.length} of them TWO OR MORE AIREON children carried impressions in the same week.`)
for (const [term, cs] of airMulti.slice(0, 10)) {
  const mkt = cs[0]!.mkt
  const tot = cs.reduce((s, c) => s + c.ours, 0)
  console.log(`     ${term.slice(0, 32).padEnd(34)} children=${cs.length} ours=${tot} of ${mkt.toLocaleString()} (${((tot / mkt) * 100).toFixed(2)}%)  [${cs.map((c) => `${c.asin}:${c.ours}`).join(' ')}]`)
}

// ── Test 4 · does a family's share keep growing past its first child? ───────────────────────
// The operational question, phrased as money: on the terms that matter, is the 10th sibling
// adding share or splitting it?
console.log('\n── Test 4 · head terms, family by family ──')
const head = [...byTerm.entries()].filter(([, cs]) => cs[0]!.mkt >= 20_000).sort((a, b) => b[1][0]!.mkt - a[1][0]!.mkt).slice(0, 8)
for (const [term, cs] of head) {
  const mkt = cs[0]!.mkt
  const byFam = new Map<string, Cell[]>()
  for (const c of cs) { const a = byFam.get(c.parent) ?? []; a.push(c); byFam.set(c.parent, a) }
  const parts = [...byFam.values()].sort((a, b) => b.length - a.length)
    .map((f) => `${String(f[0]!.parent_name).replace(/^XAVIA /i, '').slice(0, 14)}×${f.length}=${((f.reduce((s, c) => s + c.ours, 0) / mkt) * 100).toFixed(2)}%`)
  console.log(`   ${term.slice(0, 30).padEnd(32)} mkt=${mkt.toLocaleString().padStart(9)}  ${parts.join('  ')}`)
}

await prisma.$disconnect()
