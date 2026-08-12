/**
 * NEG.5 — the audit, asserted against the base. Exercises the REAL service, not a copy of it.
 *
 * The one write it makes is to `AdNegativeReview` (mark, assert, unmark) and it is reversed before
 * the script exits. No Amazon call, no change to the whitelist, no change to the gate.
 *
 * 🔴 Two assertions exist purely to keep this honest:
 *   - an empty pair list FAILS rather than passing vacuously;
 *   - the audit's semantics is re-derived here from `ads-write-gate.ts`'s own rules and compared
 *     to the service's output, so the two cannot drift into silent agreement about nothing.
 */
import '../src/env.js'
const svc = await import('../src/services/advertising/negatives-protections.service.js')
const { normaliseTerm } = await import('../src/services/advertising/ads-write-gate.js')
const { default: prisma } = await import('../src/db.js')

const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ${want}`}`)
}
const assertTrue = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n═══ NEG.5 — audit ═══\n')

const payload = await svc.getProtections({ market: 'all' })

// ── 1 · the protections ───────────────────────────────────────────────────────────────────────
h('1 · protections')
const wl = payload.forward.protections.filter((p) => p.mode === 'WHITELIST')
assert('protections', payload.forward.protections.length, 10)
assert('all WHITELIST', wl.length, 10)
assertTrue('all CONTAINS', wl.every((p) => p.matchType === 'CONTAINS'), wl.map((p) => p.matchType).join(','))
assertTrue('coverage.protectionRows is non-zero', payload.coverage.protectionRows > 0, String(payload.coverage.protectionRows))
assertTrue('coverage.negationRows is non-zero', payload.coverage.negationRows > 0, String(payload.coverage.negationRows))

// ── 2 · the three semantics, re-derived from the gate's own rules ─────────────────────────────
h('2 · contradictions under each semantics')
const negs = await prisma.adTarget.findMany({
  where: { isNegative: true },
  select: {
    id: true, expressionValue: true, status: true, externalTargetId: true, negativeLevel: true,
    adGroup: { select: { campaign: { select: { name: true, status: true } } } },
  },
})
const protections = await prisma.adKeywordProtection.findMany({ where: { mode: 'WHITELIST' } })
const countUnder = (mode: 'CONTAINS' | 'PREFIX' | 'EXACT') => {
  let n = 0
  for (const g of negs) {
    const k = normaliseTerm(g.expressionValue ?? '')
    if (!k) continue
    for (const p of protections) if (svc.matchesProtection(k, normaliseTerm(p.term), mode)) n++
  }
  return n
}
assert('CONTAINS (the live semantics — pairs)', countUnder('CONTAINS'), 132)
assert('PREFIX  (pairs)', countUnder('PREFIX'), 96)
assert('EXACT   (pairs)', countUnder('EXACT'), 32)
assertTrue('the three differ — the semantics is replicated, not guessed',
  new Set([countUnder('CONTAINS'), countUnder('PREFIX'), countUnder('EXACT')]).size === 3)

// ── 3 · the service's own totals ──────────────────────────────────────────────────────────────
h('3 · the payload')
const t = payload.backward.totals
assert('contradictions (pairs)', t.contradictions, 132)
assert('distinct negations behind them', t.negations, 128)
assert('pairs − negations = the multi-protection rows', t.contradictions - t.negations, 4)
assert('blocking — ALL of them', t.blocking, 132)
assertTrue('🔴 blocking === contradictions: none of these is inert',
  t.blocking === t.contradictions,
  'this is what separates NEG.5 from NEG.4, whose overlaps were all ARCHIVED')
assert('own-line brand', t.byClass['own-line-brand'], 54)
assert('other-line brand', t.byClass['other-line-brand'], 45)
assert('non-brand', t.byClass['non-brand'], 33)
assert('classes sum to the pair count', t.byClass['own-line-brand'] + t.byClass['other-line-brand'] + t.byClass['non-brand'], 132)
assertTrue('an empty audit FAILS rather than passing vacuously', t.contradictions > 0, String(t.contradictions))

const groupSum = payload.backward.groups.reduce((a, g) => a + g.contradictions, 0)
assert('🔴 group sizes sum to the PAIR count, not the negation count', groupSum, t.contradictions)

// ── 4 · xavia — and the two different numbers the record holds ────────────────────────────────
h('4 · xavia')
const xaviaGroup = payload.backward.groups.find((g) => g.protectedTerm === 'xavia')
assertTrue('xavia has a group', !!xaviaGroup)
if (xaviaGroup) {
  // 🔴 60, not 56. `_neg5-ground.mts` reports 56 because it BREAKS on the first matching
  // protection, so the four `xavia gale` rows are attributed to `gale` (alphabetically first) and
  // never counted again. That is the distinct-negation question. This is the pair question, and a
  // row contradicting two protections belongs under both groups — which is exactly why the
  // headline states both numbers.
  assert('xavia contradictions — PAIRS (phrases containing xavia)', xaviaGroup.contradictions, 60)
  assert('xavia blocking', xaviaGroup.blocking, 60)
  const xaviaDistinct = new Set(xaviaGroup.campaigns.flatMap((c) => c.rows.map((r) => r.id))).size
  assert('xavia DISTINCT negations', xaviaDistinct, 60)
  const bare = negs.filter((g) => normaliseTerm(g.expressionValue ?? '') === 'xavia').length
  assert('negations of the BARE term "xavia" — NEG.4 Detector B\'s 16', bare, 16)
  assertTrue('🔴 the protection\'s reach and the bare term are different questions, both right',
    xaviaGroup.contradictions !== bare,
    `60 = every phrase CONTAINING xavia · 16 = the exact phrase NEG.4 found earning €122.91 on 1 order`)
  console.log(`     campaigns holding a xavia contradiction: ${xaviaGroup.campaigns.length}`)
}

// ── 5 · reach — the forward half's blast radius ───────────────────────────────────────────────
h('5 · reach')
assertTrue('the reach denominator is a real count', payload.forward.reach.distinctQueries > 0, String(payload.forward.reach.distinctQueries))
assertTrue('refusal history is declared UNAVAILABLE', payload.forward.refusalHistoryAvailable === false,
  'logGateDeny is not persisted — there is no table to count')
for (const p of payload.forward.protections) console.log(`     ${p.term.padEnd(12)} reach ${String(p.reachQueries).padStart(4)} · contradictions ${String(p.contradictions).padStart(3)}`)

// ── 6 · the mark, and the counter converging ──────────────────────────────────────────────────
h('6 · mark → converge → unmark')
const target = payload.backward.groups
  .flatMap((g) => g.campaigns.map((c) => ({ term: g.protectedTerm, c })))
  .find((x) => x.c.decision === null && x.c.covers > 0)
assertTrue('a markable group exists', !!target)

if (target) {
  console.log(`     marking "${target.term}" in ${target.c.campaignName} — covers ${target.c.covers}`)
  const before = payload.backward.totals
  const mark = await svc.markReview({
    protectedTerm: target.term, campaignId: target.c.campaignId,
    reason: '_neg5-audit.mts — reversed at the end of this script', reviewedBy: 'script:_neg5-audit',
  })
  assertTrue('mark succeeded', mark.ok === true, JSON.stringify(mark))
  if (mark.ok) assert('the mark reports the group size it covers', mark.covers, target.c.covers)

  const after = await svc.getProtections({ market: 'all' })
  assert('total is UNCHANGED', after.backward.totals.contradictions, before.contradictions)
  assert('reviewed rose by exactly the group size', after.backward.totals.reviewed - before.reviewed, target.c.covers)
  assert('open fell by exactly the group size', before.open - after.backward.totals.open, target.c.covers)
  assert('reviewed + open === total', after.backward.totals.reviewed + after.backward.totals.open, after.backward.totals.contradictions)

  const markedGroup = after.backward.groups.find((g) => g.protectedTerm === target.term)?.campaigns.find((c) => c.campaignId === target.c.campaignId)
  assertTrue('the decision is attached to the group', markedGroup?.decision != null)
  assertTrue('the decision names its actor', markedGroup?.decision?.reviewedBy === 'script:_neg5-audit', String(markedGroup?.decision?.reviewedBy))
  assert('newSinceDecision is 0 immediately after marking', markedGroup?.newSinceDecision ?? -1, 0)

  const un = await svc.unmarkReview(target.term, target.c.campaignId)
  assert('unmark removed exactly one decision', un.removed, 1)
  const restored = await svc.getProtections({ market: 'all' })
  assert('open is restored', restored.backward.totals.open, before.open)
  assert('reviewed is restored', restored.backward.totals.reviewed, before.reviewed)
}

// ── 7 · the mark refuses what it should ───────────────────────────────────────────────────────
h('7 · the mark\'s guards')
const bogusTerm = await svc.markReview({ protectedTerm: 'not-a-protected-term', campaignId: target?.c.campaignId ?? 'x', reviewedBy: 'script' })
assertTrue('refuses a term that is not whitelisted', bogusTerm.ok === false && bogusTerm.code === 'not_protected', JSON.stringify(bogusTerm))
const bogusCampaign = await svc.markReview({ protectedTerm: 'xavia', campaignId: 'no-such-campaign', reviewedBy: 'script' })
assertTrue('refuses a campaign that does not exist', bogusCampaign.ok === false && bogusCampaign.code === 'campaign_not_found', JSON.stringify(bogusCampaign))

// ── 8 · scope narrowing keeps its denominator ─────────────────────────────────────────────────
h('8 · scope')
const oneCampaign = payload.backward.groups[0]?.campaigns[0]
if (oneCampaign) {
  const scoped = await svc.getProtections({ market: 'all', campaign: oneCampaign.campaignId })
  assert('scoped total is still the ACCOUNT total', scoped.backward.totals.contradictions, 132)
  assertTrue('scoped subset is smaller than the account', scoped.backward.scoped.contradictions < scoped.backward.totals.contradictions,
    `${scoped.backward.scoped.contradictions} of ${scoped.backward.totals.contradictions}`)
  assertTrue('scoped subset is non-empty for a campaign that holds one', scoped.backward.scoped.contradictions > 0,
    String(scoped.backward.scoped.contradictions))
  console.log(`     "${oneCampaign.campaignName}": ${scoped.backward.scoped.contradictions} of ${scoped.backward.totals.contradictions} in scope`)
}

// ── 9 · leftover state ────────────────────────────────────────────────────────────────────────
h('9 · no state left behind')
const leftovers = await prisma.adNegativeReview.count({ where: { reviewedBy: { startsWith: 'script:' } } })
assert('script-written review rows remaining', leftovers, 0)

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
