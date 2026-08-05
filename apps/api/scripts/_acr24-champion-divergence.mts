/**
 * ACR.2.4c — do the two champion rules ever name different winners? READ-ONLY.
 *
 * There are two live implementations of "which of our campaigns should own this keyword":
 *   · RD.6 `detectSelfCompetition` — what the rank engine ACTS on every 15 minutes.
 *       rank = [acos ?? +Inf, -spendCents].  Lowest ACOS; unknown ranks worst; ties to higher spend.
 *   · RC3.2 `pickChampion` — what the operator is SHOWN on the conflicts endpoint.
 *       Orders>0 → prefer clicks>=3 → lowest ACOS → most orders → LOWEST bid.
 *       Else clicks>0 → most impressions → most clicks.  Else → HIGHEST bid.
 *
 * They can disagree: on an ACOS tie one prefers the bigger spender and the other the lower bid;
 * with no sales at all one picks by spend and the other by impressions. An operator acting on the
 * conflicts view could therefore be acting against what the engine will do on its next tick.
 *
 * This does not change either rule. It measures whether the disagreement is real here.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { pickChampion } = await import('../src/services/advertising/keyword-conflicts.service.js')
const { detectSelfCompetition } = await import('../src/services/advertising/rank-self-competition.js')

const MARKET = 'IT'
const targets = await prisma.adTarget.findMany({
  where: {
    kind: 'KEYWORD', isNegative: false, status: 'ENABLED',
    adGroup: { campaign: { marketplace: MARKET, status: 'ENABLED' } },
  },
  select: {
    expressionValue: true, expressionType: true, bidCents: true,
    impressions: true, clicks: true, spendCents: true, salesCents: true, ordersCount: true,
    adGroup: { select: { campaign: { select: { id: true, name: true, spend: true, acos: true } } } },
  },
})

interface C { campaignId: string; name: string; bidCents: number; impressions: number; clicks: number; spendCents: number; salesCents: number; orders: number }
const byKey = new Map<string, Map<string, C>>()
for (const t of targets) {
  const c = t.adGroup.campaign
  const key = `${t.expressionValue.trim().toLowerCase()}|${t.expressionType}`
  const m = byKey.get(key) ?? new Map<string, C>()
  const prev = m.get(c.id)
  m.set(c.id, {
    campaignId: c.id, name: c.name, bidCents: Math.max(prev?.bidCents ?? 0, t.bidCents ?? 0),
    impressions: (prev?.impressions ?? 0) + (t.impressions ?? 0),
    clicks: (prev?.clicks ?? 0) + (t.clicks ?? 0),
    spendCents: (prev?.spendCents ?? 0) + (t.spendCents ?? 0),
    salesCents: (prev?.salesCents ?? 0) + (t.salesCents ?? 0),
    orders: (prev?.orders ?? 0) + (t.ordersCount ?? 0),
  })
  byKey.set(key, m)
}

const contested = [...byKey.entries()].filter(([, m]) => m.size > 1)
console.log(`\n${MARKET}: ${byKey.size} distinct (term|match) keys, ${contested.length} contested by 2+ campaigns\n`)

let agree = 0
let tiedEngine = 0
const disagreements: string[] = []
for (const [key, m] of contested) {
  const list = [...m.values()]
  const rc3 = pickChampion(list.map((c) => ({
    campaignId: c.campaignId, campaignName: c.name, bidCents: c.bidCents,
    impressions: c.impressions, clicks: c.clicks, spendCents: c.spendCents,
    salesCents: c.salesCents, orders: c.orders,
    acos: c.salesCents > 0 ? c.spendCents / c.salesCents : null,
    cvr: c.clicks > 0 ? c.orders / c.clicks : null, tosBias: 0,
  })) as never)
  const rd6 = detectSelfCompetition(list.map((c) => ({
    campaignId: c.campaignId, keywords: [key], isAuto: false,
    acos: c.salesCents > 0 ? c.spendCents / c.salesCents : null, spendCents: c.spendCents,
  })))
  const rd6Winner = list.map((c) => c.campaignId).find((id) => !rd6.demoted.has(id))
  if (rd6Winner === rc3.championId) { agree += 1; continue }

  /**
   * A difference only MATTERS when the engine actually has an opinion. Its rank key is
   * [acos ?? +Inf, -spend]; when two contenders tie on both, its sort is stable and it simply
   * keeps input order — an arbitrary answer, not a judgement. Breaking that tie by traffic is
   * the console being MORE decisive, not contradicting anything.
   */
  const rankKeyOf = (c: typeof list[number]) => `${c.salesCents > 0 ? c.spendCents / c.salesCents : 'inf'}|${c.spendCents}`
  const engineOpinionated = new Set(list.map(rankKeyOf)).size > 1
  if (!engineOpinionated) { tiedEngine += 1; continue }
  const nameOf = (id?: string) => list.find((c) => c.campaignId === id)?.name ?? '(none)'
  disagreements.push(
    `  "${key}"\n     rank engine keeps : ${nameOf(rd6Winner)}\n     conflicts view says: ${nameOf(rc3.championId)}  (${rc3.reason})`,
  )
}

console.log(`Agree outright        : ${agree} of ${contested.length}`)
console.log(`Engine had NO opinion : ${tiedEngine}  (tied on both acos and spend — console breaks it by traffic)`)
console.log(`REAL contradictions   : ${disagreements.length}\n`)
for (const d of disagreements.slice(0, 12)) console.log(d)
if (disagreements.length > 12) console.log(`  … and ${disagreements.length - 12} more`)
await prisma.$disconnect()
