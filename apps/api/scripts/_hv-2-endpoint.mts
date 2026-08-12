/**
 * HV.2 — the criteria and the policy, proven end to end.
 *
 * Writes policy rows and REMOVES EVERY ONE IT CREATES. Nothing else is written: no keyword, no
 * negative, nothing at Amazon. It fails loudly if it cannot clean up.
 *
 * Proves, in order:
 *   1. with no policy anywhere, the shipped defaults apply and say so
 *   2. the attrition steps reconcile: base − Σremoved = candidates
 *   3. a URL override beats the policy, and `overridden` names exactly which criteria
 *   4. an account policy is picked up, and a market policy overrides it for that market only
 *   5. a more specific scope wins; a less specific one does not
 *   6. removing an override falls back to what is above it
 */
import '../src/env.js'
const { getKeywordHarvest } = await import('../src/services/advertising/keyword-harvest.service.js')
const { saveHarvestPolicy, deleteHarvestPolicy, resolveHarvestPolicy } = await import('../src/services/advertising/harvest-policy.service.js')
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '🔴'} ${pad(label, 62)} ${detail}`)
}
const created: Array<{ scopeGrain: string; scopeId: string | null }> = []
const save = async (scopeGrain: string, scopeId: string | null, c: Record<string, unknown>) => {
  const r = await saveHarvestPolicy({ scopeGrain: scopeGrain as never, scopeId, criteria: c as never, updatedBy: 'probe:_hv-2-endpoint' })
  created.push({ scopeGrain, scopeId })
  return r
}

console.log('\n═══ HV.2 — criteria + policy, end to end ═══\n')

const pre = await prisma.adsHarvestPolicy.count()
if (pre > 0) { console.log(`🔴 ${pre} policy rows already exist; this probe assumes a clean table. Aborting.`); process.exit(1) }

try {
  // ── 1 · the shipped defaults ────────────────────────────────────────────────
  console.log('═══ 1 · no policy anywhere → the shipped defaults ═══\n')
  const base = await getKeywordHarvest({ market: 'all' })
  const c = base.criteria
  console.log(`  in force: ${JSON.stringify(c.inForce)}`)
  console.log(`  source:   ${c.policy.source} · saveGrain ${c.policy.saveGrain} · hasOwn ${c.policy.hasOwn}`)
  check('source is "default"', c.policy.source === 'default')
  check('defaults are 2 / 3 / 45% / 60d / excludeExact', c.inForce.minOrders === 2 && c.inForce.minClicks === 3 && c.inForce.maxAcosPct === 45 && c.inForce.windowDays === 60 && c.inForce.excludeExactMatched === true)
  check('nothing is overridden', c.overridden.length === 0, JSON.stringify(c.overridden))
  check('saveGrain for market=all is "account"', c.policy.saveGrain === 'account')

  // ── 2 · the attrition reconciles ────────────────────────────────────────────
  console.log('\n═══ 2 · the attrition reconciles with the grid ═══\n')
  console.log(`  base: ${base.attrition.base} ${base.attrition.baseLabel}`)
  for (const s of base.attrition.steps) console.log(`    ${pad(s.label, 30)} removes ${pad(String(s.removed), 4)} → ${pad(String(s.remaining), 4)}${s.removedNew > 0 ? `  ⚠ ${s.removedNew} of them NEW` : ''}`)
  const removed = base.attrition.steps.reduce((a, s) => a + s.removed, 0)
  check('base − Σremoved === candidates', base.attrition.base - removed === base.census.candidates, `${base.attrition.base} − ${removed} = ${base.attrition.base - removed} vs census ${base.census.candidates}`)
  check('last step remaining === candidates', base.attrition.steps[base.attrition.steps.length - 1].remaining === base.census.candidates)
  check('candidates === rows returned', base.census.candidates === base.total, `${base.census.candidates} vs ${base.total}`)
  check('the four states still partition', base.census.new + base.census.alreadyExactHere + base.census.exactElsewhere + base.census.localOnly === base.census.candidates)

  // ── 3 · a URL override beats the policy ─────────────────────────────────────
  console.log('\n═══ 3 · a URL override beats the policy, and is named ═══\n')
  const o = await getKeywordHarvest({ market: 'all', minOrders: 1, matched: 'all' })
  console.log(`  minOrders=1 & matched=all → ${o.census.candidates} candidates (default view: ${base.census.candidates})`)
  check('inForce reflects the override', o.criteria.inForce.minOrders === 1 && o.criteria.inForce.excludeExactMatched === false)
  check('overridden names exactly the two', o.criteria.overridden.sort().join(',') === 'excludeExactMatched,minOrders', JSON.stringify(o.criteria.overridden))
  check('the policy half is untouched', o.criteria.policy.criteria.minOrders === 2 && o.criteria.policy.criteria.excludeExactMatched === true)
  check('more candidates than the default view', o.census.candidates > base.census.candidates)
  const none = await getKeywordHarvest({ market: 'all', maxAcosPct: 'none' })
  check('maxAcos="none" clears the ceiling', none.criteria.inForce.maxAcosPct === null && none.criteria.overridden.includes('maxAcosPct'))

  // ── 4 · an account policy, then a market override ───────────────────────────
  console.log('\n═══ 4 · account policy, then a market override ═══\n')
  await save('account', null, { minOrders: 1, minClicks: 0, maxAcosPct: null, windowDays: 60, excludeExactMatched: false })
  const acct = await getKeywordHarvest({ market: 'all' })
  console.log(`  account policy 1o/0c/no-ceiling/any-match → ${acct.census.candidates} candidates`)
  check('source is now "account"', acct.criteria.policy.source === 'account')
  check('the grid moved with it', acct.census.candidates !== base.census.candidates, `${base.census.candidates} → ${acct.census.candidates}`)
  check('still nothing overridden (no URL params)', acct.criteria.overridden.length === 0)

  await save('market', 'IT', { minOrders: 3, minClicks: 0, maxAcosPct: null, windowDays: 60, excludeExactMatched: false })
  const it = await getKeywordHarvest({ market: 'IT' })
  const de = await getKeywordHarvest({ market: 'DE' })
  console.log(`  IT (own policy, 3 orders): ${it.census.candidates} · DE (inherits account, 1 order): ${de.census.candidates}`)
  check('IT resolves to its own market policy', it.criteria.policy.source === 'market' && it.criteria.inForce.minOrders === 3)
  check('DE still inherits the account policy', de.criteria.policy.source === 'account' && de.criteria.inForce.minOrders === 1)
  check('IT hasOwn = true, DE hasOwn = false', it.criteria.policy.hasOwn === true && de.criteria.policy.hasOwn === false)
  check('market=all does NOT pick up the IT policy', (await getKeywordHarvest({ market: 'all' })).criteria.policy.source === 'account')

  // ── 5 · most specific wins; less specific does not ──────────────────────────
  console.log('\n═══ 5 · most specific wins, whole ═══\n')
  const campId = base.rows.find((r) => r.market === 'IT' && r.campaign.id)?.campaign.id
    ?? (await prisma.campaign.findFirst({ where: { marketplace: 'IT' }, select: { id: true } }))?.id
  if (campId) {
    const beforeCamp = await getKeywordHarvest({ market: 'IT', campaign: campId })
    check('a campaign with no policy inherits the IT market policy', beforeCamp.criteria.policy.source === 'market', `source=${beforeCamp.criteria.policy.source}`)
    check('saveGrain is now "campaign"', beforeCamp.criteria.policy.saveGrain === 'campaign' && beforeCamp.criteria.policy.saveScopeId === campId)
    await save('campaign', campId, { minOrders: 7, minClicks: 0, maxAcosPct: null, windowDays: 60, excludeExactMatched: false })
    const afterCamp = await getKeywordHarvest({ market: 'IT', campaign: campId })
    check('the campaign policy now wins', afterCamp.criteria.policy.source === 'campaign' && afterCamp.criteria.inForce.minOrders === 7)
    check('the IT market view is unaffected', (await getKeywordHarvest({ market: 'IT' })).criteria.inForce.minOrders === 3)
  } else check('found an IT campaign to test the campaign grain', false)

  // a policy at a grain the operator did NOT pick must not leak in
  const chainProof = await resolveHarvestPolicy({ market: 'DE' })
  check('a campaign policy does not leak into an unrelated market', chainProof.source === 'account')

  // ── 6 · removal falls back ──────────────────────────────────────────────────
  console.log('\n═══ 6 · removing an override falls back ═══\n')
  await deleteHarvestPolicy('market', 'IT')
  created.splice(created.findIndex((x) => x.scopeGrain === 'market' && x.scopeId === 'IT'), 1)
  const itAfter = await getKeywordHarvest({ market: 'IT' })
  check('IT falls back to the account policy', itAfter.criteria.policy.source === 'account' && itAfter.criteria.inForce.minOrders === 1)
  let refused = false
  try { await deleteHarvestPolicy('market', 'IT') } catch { refused = true }
  check('removing a policy that is not there is refused, not a silent no-op', refused)
} finally {
  // ── clean up, loudly ────────────────────────────────────────────────────────
  console.log('\n═══ cleanup ═══\n')
  for (const c of created) {
    try { await deleteHarvestPolicy(c.scopeGrain as never, c.scopeId); console.log(`  removed ${c.scopeGrain}/${c.scopeId ?? '*'}`) }
    catch (e) { failures++; console.log(`  🔴 COULD NOT REMOVE ${c.scopeGrain}/${c.scopeId ?? '*'}: ${(e as Error).message}`) }
  }
  const left = await prisma.adsHarvestPolicy.count()
  check('the table is back to empty', left === 0, `${left} rows left`)
}

console.log(`\n═══ ${failures === 0 ? '✅ all checks passed' : `🔴 ${failures} CHECK(S) FAILED`} ═══\n`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
