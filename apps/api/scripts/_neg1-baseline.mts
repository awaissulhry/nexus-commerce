/**
 * NEG.1 — baseline. READ-ONLY.
 *
 * The numbers this page's census strip and inventory grid must render, measured directly from the
 * database, so the endpoint can be checked against them rather than against the study's prose.
 *
 * Re-derives, rather than trusting, the four counts the study fixed on 2026-08-11 — and the one
 * that has since moved (`expressionType`).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 76 - s.length))}`)
const tally = <T>(xs: T[], f: (x: T) => string) => {
  const m = new Map<string, number>()
  for (const x of xs) m.set(f(x), (m.get(f(x)) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1])
}
/** The one normalisation. Whitespace-collapsing, so `giacca  moto` and `giacca moto` are one term. */
const normTerm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()

console.log('\n═══ NEG.1 — baseline ═══\n')

const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, kind: true, expressionType: true, expressionValue: true, negativeLevel: true,
    status: true, externalTargetId: true, orphanedAt: true, createdAt: true,
    adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, portfolioId: true } } } },
  },
})

h('1 · The base')
console.log(`negatives: ${int(negs.length)}`)
console.log(`kind:          ${tally(negs, (n) => String(n.kind)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`negativeLevel: ${tally(negs, (n) => String(n.negativeLevel ?? 'null')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`status:        ${tally(negs, (n) => String(n.status)).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`market:        ${tally(negs, (n) => String(n.adGroup?.campaign?.marketplace ?? 'null')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)
console.log(`campaign state:${tally(negs, (n) => String(n.adGroup?.campaign?.status ?? 'null')).map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

h('2 · 🔴 expressionType — the study said EXACT 1,393 / PHRASE 579 / _EXACT 32 / _PHRASE 30')
// JSON.stringify so a leading space, an underscore or a case difference is VISIBLE. A padded
// console column would have hidden exactly the thing this section exists to check.
for (const [k, v] of tally(negs, (n) => JSON.stringify(n.expressionType))) console.log(`  ${k.padEnd(20)} ${int(v)}`)

h('3 · The census strip — the four counts, each computed the way the page will')
const live = negs.filter((n) => n.status === 'ENABLED' && n.adGroup?.campaign?.status === 'ENABLED' && n.externalTargetId != null)
const inEnabledCampaign = negs.filter((n) => n.adGroup?.campaign?.status === 'ENABLED')
const notAtAmazon = negs.filter((n) => n.externalTargetId == null)
const terms = new Set(negs.map((n) => normTerm(n.expressionValue)))
console.log(`negatives:            ${int(negs.length)}`)
console.log(`terms (normalised):   ${int(terms.size)}`)
console.log(`🔴 BLOCKING NOW:      ${int(live.length)}  (target ENABLED ∧ campaign ENABLED ∧ externalTargetId NOT NULL)`)
console.log(`   in an ENABLED campaign, ignoring the other two: ${int(inEnabledCampaign.length)}  ← the study's 1,045`)
console.log(`not at Amazon:        ${int(notAtAmazon.length)}`)
console.log(`in a PAUSED/ARCHIVED campaign (inert): ${int(negs.length - inEnabledCampaign.length)}`)
console.log(`orphanedAt set:       ${int(negs.filter((n) => n.orphanedAt != null).length)}`)

h('4 · Attribution — four values, never blank')
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: { in: ['create_negative_keyword', 'create_negative_product_target'] } },
  select: { entityId: true, userId: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
// Oldest-first, and never overwritten: the FIRST log for a row is the one that created it.
const byEntity = new Map<string, string | null>()
for (const l of logs) if (l.entityId && !byEntity.has(l.entityId)) byEntity.set(l.entityId, l.userId)
const attr = tally(negs, (n) => {
  if (!byEntity.has(n.id)) return 'unattributed (no log row)'
  const u = byEntity.get(n.id)
  if (!u) return 'actor not recorded (log row, null userId)'
  return u.startsWith('automation:') ? `engine · ${u}` : `user · ${u}`
})
for (const [k, v] of attr) console.log(`  ${k.padEnd(44)} ${int(v)}  ${((v / negs.length) * 100).toFixed(1)}%`)
console.log(`create_negative_* logs: ${int(logs.length)} · distinct entityIds: ${int(byEntity.size)}`)

h('5 · Spread — the chip on a term row')
const byTerm = new Map<string, typeof negs>()
for (const n of negs) {
  const k = normTerm(n.expressionValue)
  const arr = byTerm.get(k) ?? []
  arr.push(n); byTerm.set(k, arr)
}
const spreads = [...byTerm.entries()]
  .map(([t, rows]) => ({
    term: t, rows: rows.length,
    adGroups: new Set(rows.map((r) => r.adGroup?.id).filter(Boolean)).size,
    campaigns: new Set(rows.map((r) => r.adGroup?.campaign?.id).filter(Boolean)).size,
  }))
  .sort((a, b) => b.rows - a.rows)
console.log(`distinct terms: ${int(spreads.length)}`)
for (const s of spreads.slice(0, 5)) console.log(`  ${s.term.padEnd(34)} ${s.rows} rows · ${s.adGroups} ad groups · ${s.campaigns} campaigns`)

h('6 · Scope reach — what a portfolio-scoped view cannot see')
const noPf = negs.filter((n) => !n.adGroup?.campaign?.portfolioId).length
console.log(`negatives in a campaign carrying NO portfolioId: ${int(noPf)} of ${int(negs.length)} (${((noPf / negs.length) * 100).toFixed(0)}%)`)
console.log(`distinct campaigns holding a negative: ${int(new Set(negs.map((n) => n.adGroup?.campaign?.id).filter(Boolean)).size)}`)
console.log(`distinct ad groups holding a negative: ${int(new Set(negs.map((n) => n.adGroup?.id).filter(Boolean)).size)}`)

h('7 · The row Amazon has no ad group for — does the CAMPAIGN grain hold?')
console.log(`negatives with no adGroup row at all: ${int(negs.filter((n) => !n.adGroup).length)}`)
console.log(`negatives with an adGroup but no campaign: ${int(negs.filter((n) => n.adGroup && !n.adGroup.campaign).length)}`)
const campLevel = negs.filter((n) => n.negativeLevel === 'CAMPAIGN')
console.log(`CAMPAIGN-level rows: ${int(campLevel.length)} · of those with an adGroup: ${int(campLevel.filter((n) => !!n.adGroup).length)} · with an Amazon id: ${int(campLevel.filter((n) => n.externalTargetId != null).length)}`)

await prisma.$disconnect()
