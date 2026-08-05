/**
 * ACR.2.0b — GALE keyword consolidation: which campaign should own each shared term. READ-ONLY.
 *
 * The baseline found the real problem, and it is not bidding: `giacca moto` is carried by 8
 * campaigns across 42 targets, in every match type at once, on €1/day budgets. Fragmented AND
 * starved is the worst case for learning — no campaign accumulates enough signal on any term
 * for anyone, human or engine, to decide about it. Consolidating that is worth more than any
 * bid change, and it needs no new engine.
 *
 * This PROPOSES; it changes nothing. Structural change stays operator-gated — every failure
 * mode in the competitor research says so, and it is the one thing the industry agrees should
 * never be automatic.
 *
 * Champion rule, same as `rank-self-competition.ts` so the manual and automatic paths cannot
 * disagree: lowest ACOS wins; unknown ACOS ranks worst; ties break toward higher spend (more
 * proven). Applied per (term, matchType) — an EXACT and a BROAD on the same words are doing
 * different jobs and should not be collapsed into each other.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr2-gale-consolidate.mts [FAMILY=GALE] [market=IT]
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config()
config({ path: resolve(new URL('.', import.meta.url).pathname, '../../../.env') })

const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const q = <T = Record<string, unknown>>(sql: string) => p.$queryRawUnsafe<T[]>(sql)
const h = (s: string) => console.log(`\n${'─'.repeat(80)}\n${s}\n${'─'.repeat(80)}`)

const FAMILY = (process.argv[2] ?? 'GALE').toUpperCase()
const MARKET = process.argv[3] ?? 'IT'

interface Row {
  term: string; match: string; campaign: string; campaign_id: string
  targets: number; impressions: number; clicks: number; spend_c: number; sales_c: number
}

const rows = await q<Row>(`
  SELECT LOWER(t."expressionValue") AS term,
         t."expressionType" AS match,
         c.name AS campaign,
         c.id AS campaign_id,
         COUNT(DISTINCT t.id)::int AS targets,
         COALESCE(SUM(d.impressions), 0)::int AS impressions,
         COALESCE(SUM(d.clicks), 0)::int AS clicks,
         COALESCE(SUM(d."costMicros")/10000, 0)::int AS spend_c,
         COALESCE(SUM(d."sales7dCents"), 0)::int AS sales_c
  FROM "AdTarget" t
  JOIN "AdGroup" g ON g.id = t."adGroupId"
  JOIN "Campaign" c ON c.id = g."campaignId"
  LEFT JOIN "AmazonAdsDailyPerformance" d
         ON d."entityType" = 'AD_TARGET' AND d."entityId" = t."externalTargetId"
  WHERE UPPER(c.name) LIKE '%${FAMILY}%'
    AND c.status = 'ENABLED' AND c.marketplace = '${MARKET}'
    AND t.kind = 'KEYWORD'
    -- isNegative, NOT the match type. 1,068 targets are expressionType 'EXACT' AND negative;
    -- only 20 rows use 'NEGATIVE_EXACT'. The first cut of this analysis compared negative
    -- keywords against positives as if they contested the same auction. They do not.
    AND t."isNegative" = false
  GROUP BY 1,2,3,4
`)

// (term, matchType) — an EXACT and a BROAD on the same words are different jobs.
const groups = new Map<string, Row[]>()
for (const r of rows) {
  const norm = r.match.replace(/^_/, '') // legacy _EXACT / _PHRASE are the same job as EXACT / PHRASE
  const k = `${r.term}|${norm}`
  const g = groups.get(k) ?? []
  g.push({ ...r, match: norm })
  groups.set(k, g)
}

const acos = (r: Row) => (r.sales_c > 0 ? r.spend_c / r.sales_c : null)
const rank = (r: Row): [number, number] => [acos(r) ?? Number.POSITIVE_INFINITY, -r.spend_c]
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

const contested = [...groups.entries()]
  .filter(([, g]) => g.length > 1)
  .sort((a, b) => b[1].length - a[1].length)

h(`${FAMILY} ${MARKET} — terms carried by more than one ENABLED campaign`)
console.log(`  ${contested.length} contested (term × match) pairs across ${rows.length} campaign-term rows.\n`)

let totalRetire = 0
let evidenced = 0

for (const [key, g] of contested.slice(0, 18)) {
  const [term, match] = key.split('|')
  const withData = g.filter((r) => r.impressions > 0)
  const sorted = [...g].sort((a, b) => {
    const [aa, as] = rank(a); const [ba, bs] = rank(b)
    return aa === ba ? as - bs : aa - ba
  })
  const champ = sorted[0]
  const losers = sorted.slice(1)
  totalRetire += losers.length
  if (withData.length > 0) evidenced++

  console.log(`\n  "${term}"  [${match}]  — ${g.length} campaigns`)
  for (const r of sorted) {
    const a = acos(r)
    const mark = r === champ ? '→ KEEP  ' : '  retire'
    const perf = r.impressions === 0
      ? 'no impressions in 30 days of target-grain history'
      : `${r.impressions} impr · ${r.clicks} clicks · ${eur(r.spend_c)} spend · ${eur(r.sales_c)} sales${a != null ? ` · ACOS ${(a * 100).toFixed(0)}%` : ' · no sales'}`
    console.log(`    ${mark} ${r.campaign.padEnd(42).slice(0, 42)} ${perf}`)
  }
}

h('What this says')
console.log(`  Contested pairs        : ${contested.length}`)
console.log(`  Duplicate targets to retire (if every champion stands): ${totalRetire}`)
console.log(`  Pairs with ANY performance evidence: ${evidenced} of ${contested.length}`)
console.log(`
  Target-grain history was backfilled on 2026-08-05 — 30 days, 1,217 rows — so a pair marked
  "no data" now means the keyword genuinely took no impressions in a month, not that we were
  not looking. That is itself a finding: two thirds of GALE's positive keywords never served.

  The defensible move today is the subset that HAS data. The rest should wait for the
  target-grain history to fill — retiring a keyword on no evidence is exactly the kind of
  irreversible structural change the research says to keep human and slow.`)

await p.$disconnect()
console.log('\nDone — read-only. Nothing was changed.\n')
