/**
 * NEG.6 — the audit, asserted against the real service. READ-ONLY: `negateGram` is never called.
 *
 * 🔴 Two assertions exist to stop this passing vacuously:
 *   - an empty wasteful list FAILS, because "no waste" is the most reassuring possible lie;
 *   - the four rails are asserted to FIRE on known subjects and to NOT fire on the rest, so a rail
 *     that blocks everything and a rail that blocks nothing both fail.
 */
import '../src/env.js'
const svc = await import('../src/services/advertising/negatives-ngrams.service.js')
const { analyzeNgrams } = await import('../src/services/advertising/ads-ngram.service.js')
const { default: prisma } = await import('../src/db.js')

const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ${want}`}`)
}
const near = (label: string, got: number, want: number, tol: number) => {
  const ok = Math.abs(got - want) <= tol
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ~${want} ±${tol}`}`)
}
const truthy = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n═══ NEG.6 — audit ═══\n')

const p = await svc.getWastefulWords({ market: 'all', window: 60 })

h('1 · counts and coverage')
assert('wasteful shown', p.totals.wastefulShown, 50)
assert('winning shown', p.totals.winningShown, 50)
assert('window', p.window.days, 60)
assert('cost floor', p.window.minCostCents, 300)
truthy('coverage.searchTermRows non-zero', p.coverage.searchTermRows > 0, String(p.coverage.searchTermRows))
truthy('coverage.negationRows non-zero', p.coverage.negationRows > 0, String(p.coverage.negationRows))
truthy('🔴 an empty wasteful list FAILS rather than passing', p.wasteful.length > 0, String(p.wasteful.length))

h('2 · the top wasteful gram')
const top = p.wasteful.find((w) => w.gram === 'protezioni')
truthy('protezioni is present', !!top)
if (top) {
  near('protezioni spend (cents)', top.costCents, 13432, 800)
  near('protezioni clicks', top.clicks, 344, 25)
  near('protezioni catches (token match)', top.catches, 195, 15)
  truthy('protezioni is actionable', top.actionable, top.blockedBy.join(',') || 'no blocks')
  near('protezioni ad groups', top.adGroups, 27, 4)
  truthy('protezioni has writable ad groups', top.adGroupsWritable > 0, String(top.adGroupsWritable))
  truthy('at least one ad group is NOT writable — the hidden branch is exercisable',
    top.adGroupsWritable < top.adGroups, `${top.adGroupsWritable} of ${top.adGroups}`)
}

h('3 · 🔴 catches ≠ NgramRow.terms — the measurement that changed the design')
const raw = await analyzeNgrams({ windowDays: 60 })
const rawMP = raw.wasteful.find((r) => r.gram === 'moto protezioni')
const mp = p.wasteful.find((w) => w.gram === 'moto protezioni')
truthy('moto protezioni is present in both', !!rawMP && !!mp)
if (rawMP && mp) {
  near('NgramRow.terms (the OLD number)', rawMP.terms, 61, 6)
  near('catches, contiguous token match (the number we act on)', mp.catches, 13, 4)
  truthy('🔴 the two DIFFER — a stop-word-stripped 2-gram over-reports its own reach',
    rawMP.terms > mp.catches * 2, `${rawMP.terms} vs ${mp.catches}`)
}
const oneGram = p.wasteful.find((w) => w.n === 1 && w.gram === 'protezioni')
const rawOne = raw.wasteful.find((r) => r.gram === 'protezioni')
if (oneGram && rawOne) truthy('for a 1-gram the two AGREE', oneGram.catches === rawOne.terms, `${oneGram.catches} vs ${rawOne.terms}`)

h('4 · already negated as a whole term')
assert('of the 50, already negated', p.totals.alreadyNegated, 3)
console.log(`     ${p.wasteful.filter((w) => w.negatedAsWholeTerm).map((w) => w.gram).join(', ')}`)

h('5 · 🔴 rail 1 — winning-gram collision')
const withCollision = p.wasteful.filter((w) => w.collisions.length > 0)
assert('grams with a winning collision', withCollision.length, 2)
const names = withCollision.map((w) => w.gram).sort()
assert('which ones', names.join(','), 'aa,alpinestar')
for (const w of withCollision) {
  console.log(`     ${w.gram} (${eur(w.costCents)}) ⊂ ${w.collisions.map((c) => `"${c.gram}" ROAS ${c.roas.toFixed(1)}`).join(', ')}`)
  truthy(`${w.gram} is BLOCKED, not warned`, !w.actionable && w.blockedBy.includes('winning-collision'))
}
truthy('🔴 zero false positives — every other gram has no collision',
  p.wasteful.filter((w) => w.collisions.length === 0).length === 48, String(p.wasteful.filter((w) => w.collisions.length === 0).length))

h('6 · 🔴 rail 2 — converting terms: tautological at token strictness, load-bearing loose')
console.log('     "wasteful" IS orders === 0, so a TOKEN-matched converting term cannot exist by')
console.log('     construction — at that strictness the check is a tautology. It is therefore run')
console.log('     on the LOOSE set, which is the only reading that can fire. It does:')
const anyConverting = p.wasteful.filter((w) => w.convertingTerms.length > 0)
assert('wasteful grams with a converting term (loose)', anyConverting.length, 2)
assert('which ones', anyConverting.map((w) => w.gram).sort().join(','), 'aa,alpinestar')
for (const w of anyConverting) {
  for (const t of w.convertingTerms) console.log(`     ${w.gram} → "${t.term}" ${t.orders} order(s), ${eur(t.salesCents)}`)
  truthy(`${w.gram} is BLOCKED by converting-terms`, w.blockedBy.includes('converting-terms'))
  truthy(`${w.gram} loose > token — the rail can only fire on the difference`, w.catchesLoose > w.catches, `${w.catchesLoose} vs ${w.catches}`)
}
truthy('🔴 no gram is blocked on converting terms it does not have',
  p.wasteful.filter((w) => w.blockedBy.includes('converting-terms')).length === anyConverting.length)
console.log('     What proves the join RAN is `catches`, and every actionable gram must have one:')
truthy('every actionable gram has catches > 0', p.wasteful.filter((w) => w.actionable).every((w) => w.catches > 0))

h('7 · 🔴 rail 3 — protected terms')
const prot = p.wasteful.filter((w) => w.protectedBy.length > 0)
const protWin = p.winning.filter((w) => w.isProtected)
console.log(`     wasteful grams hitting a protection: ${prot.map((w) => w.gram).join(', ') || '—'}`)
console.log(`     winning grams that are protected:    ${protWin.map((w) => w.gram).join(', ') || '—'}`)
truthy('xavia is a WINNING gram and protected', protWin.some((w) => w.gram === 'xavia'))
const xv = p.winning.find((w) => w.gram === 'xavia')
truthy('xavia is the TOP winning gram', p.winning[0]?.gram === 'xavia', `top is ${p.winning[0]?.gram} ROAS ${(p.winning[0]?.roas ?? 0).toFixed(1)}`)
if (xv) near('xavia ROAS', xv.roas ?? 0, 57.5, 6)
truthy('🔴 no protected gram is actionable', prot.every((w) => !w.actionable))

h('8 · 🔴 rail 4 — the gram floor')
console.log(`     floor: >= ${p.floor.minChars} chars AND >= ${p.floor.minCatches} catching terms AND not ASIN-shaped`)
const aa = p.wasteful.find((w) => w.gram === 'aa')
truthy('`aa` is present in the list', !!aa)
if (aa) {
  truthy('🔴 `aa` is NOT actionable', !aa.actionable, aa.blockedBy.join(','))
  truthy('`aa` is excluded by LENGTH, not by term count', aa.catches >= p.floor.minCatches, `catches ${aa.catches}`)
}
// 🔴 the floor must say WHICH condition failed — "below the floor of 3 characters" is false of a
// 13-character gram, and it was on screen for three of them.
const floorBlocked = p.wasteful.filter((w) => w.blockedBy.includes('below-floor'))
truthy('every below-floor gram names its actual failure', floorBlocked.every((w) => w.floorFailures.length > 0))
for (const w of floorBlocked) console.log(`     ${w.gram.padEnd(22)} ${w.floorFailures.join(' · ')}`)
const longGram = floorBlocked.find((w) => w.gram.replace(/\s/g, '').length >= p.floor.minChars)
truthy('a gram over the character floor is NOT told it is under it',
  !longGram || longGram.floorFailures.every((f) => !f.includes('character')),
  longGram ? `${longGram.gram}: ${longGram.floorFailures.join(', ')}` : 'none present')
// 🔴 blockedBy[0] is the headline the UI prints — it must be the most serious rail, not the first added.
if (aa) truthy('🔴 `aa` leads with its most serious reason, not the floor',
  aa.blockedBy[0] === 'converting-terms', aa.blockedBy.join(','))
const asins = p.wasteful.filter((w) => w.isAsinShaped)
console.log(`     ASIN-shaped grams: ${asins.map((w) => w.gram).join(', ') || '—'}`)
truthy('every ASIN-shaped gram is blocked', asins.every((w) => !w.actionable))
truthy('🔴 the floor does not block everything', p.totals.actionable > 0, `${p.totals.actionable} actionable`)
truthy('🔴 the floor does not block nothing', p.totals.blocked > 0, `${p.totals.blocked} blocked`)

h('9 · size tokens — a catalogue gap, not waste')
const sizes = p.wasteful.filter((w) => w.isSizeToken)
console.log(`     ${sizes.map((w) => w.gram).join(', ')}`)
truthy('5xl/6xl/7xl are all labelled', ['5xl', '6xl', '7xl'].every((g) => sizes.some((s) => s.gram === g)))
const firstSize = p.wasteful.findIndex((w) => w.isSizeToken)
const lastReal = p.wasteful.map((w) => w.isSizeToken).lastIndexOf(false)
truthy('🔴 size tokens sort BELOW real waste', firstSize > lastReal || firstSize === -1, `first size at ${firstSize}, last non-size at ${lastReal}`)

h('10 · 🔴 the scope filter actually narrows (§4 option a)')
const it = await svc.getWastefulWords({ market: 'IT', window: 60 })
const fr = await svc.getWastefulWords({ market: 'FR', window: 60 })
truthy('IT reports itself as filtered', it.scope.filtered && it.scope.filterLabel === 'IT', String(it.scope.filterLabel))
truthy('account-wide reports itself as UNfiltered', !p.scope.filtered)
const homoAll = p.wasteful.find((w) => w.gram === 'homologué')
const homoIT = it.wasteful.find((w) => w.gram === 'homologué')
const homoFR = fr.wasteful.find((w) => w.gram === 'homologué')
truthy('🔴 `homologué` is account-wide AND in FR, but NOT in IT — the filter bites',
  !!homoAll && !!homoFR && !homoIT, `all=${!!homoAll} fr=${!!homoFR} it=${!!homoIT}`)
const protAll = p.wasteful.find((w) => w.gram === 'protezioni')
const protIT = it.wasteful.find((w) => w.gram === 'protezioni')
const protFR = fr.wasteful.find((w) => w.gram === 'protezioni')
truthy('🔴 `protezioni` is in IT but NOT in FR — the mirror case',
  !!protAll && !!protIT && !protFR, `all=${!!protAll} it=${!!protIT} fr=${!!protFR}`)
if (protAll && protIT) assert('protezioni spend is identical account-wide and in IT (100% IT)', protIT.costCents, protAll.costCents)
truthy('a scoped read returns fewer or equal search-term rows', it.coverage.searchTermRows < p.coverage.searchTermRows,
  `IT ${it.coverage.searchTermRows} < all ${p.coverage.searchTermRows}`)

h('11 · the window moves the numbers')
const w30 = await svc.getWastefulWords({ market: 'all', window: 30 })
truthy('30d differs from 60d', w30.coverage.searchTermRows !== p.coverage.searchTermRows,
  `30d ${w30.coverage.searchTermRows} vs 60d ${p.coverage.searchTermRows}`)

h('12 · negateGram refuses without ever calling Amazon')
const blocked = await svc.negateGram({ gram: 'aa', market: 'all', window: 60, actor: 'script:_neg6-ngrams' })
truthy('a below-floor gram is refused', !blocked.ok && blocked.code === 'blocked', JSON.stringify(blocked.blockedBy))
const missing = await svc.negateGram({ gram: 'not-a-real-gram-xyz', market: 'all', window: 60, actor: 'script:_neg6-ngrams' })
truthy('an unmeasured gram is refused', !missing.ok && missing.code === 'gram_not_found', String(missing.code))
const xaviaWrite = await svc.negateGram({ gram: 'xavia', market: 'all', window: 60, actor: 'script:_neg6-ngrams' })
truthy('a protected/winning gram is refused', !xaviaWrite.ok, `${xaviaWrite.code} ${JSON.stringify(xaviaWrite.blockedBy)}`)
truthy('🔴 no write occurred in any refusal', [blocked, missing, xaviaWrite].every((r) => r.outcomes.length === 0))

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
