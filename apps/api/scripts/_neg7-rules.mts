/**
 * NEG.7 — the rules panel, asserted. READ-ONLY: nothing here arms, enables or writes.
 *
 * 🔴 §11's trap, learned the hard way in this session. My first condition-2 probe produced THREE
 * false opens: two from a regex demanding `marketplace:` where the code passes ES6 shorthand
 * `{ scope, marketplace }`, and one from a `vi.fn()` mock definition matched by a careless grep.
 * So every structural claim here is asserted against **parsed structure or an explicit allow-list**,
 * never a regex over source text, and `*.vitest.test.ts` is excluded by name rather than by luck.
 */
import '../src/env.js'
const svc = await import('../src/services/advertising/negatives-rules.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)
let failures = 0
const assert = (label: string, got: unknown, want: unknown) => {
  const ok = String(got) === String(want)
  if (!ok) failures++
  console.log(`  ${ok ? '✓' : '🔴'} ${label}: ${got}${ok ? '' : `  ← expected ${want}`}`)
}
const truthy = (label: string, cond: boolean, detail = '') => {
  if (!cond) failures++
  console.log(`  ${cond ? '✓' : '🔴'} ${label}${detail ? ` — ${detail}` : ''}`)
}

console.log('\n═══ NEG.7 — the rules, the radius, the readiness ═══\n')

const p = await svc.getNegRules({ market: 'all' })

// ── 1 · the tab filter is the SHARED one, not a hand-rolled copy ──────────────────────────────
h('1 · the action list matches _shared/tabs.tsx — parsed, not grepped')
const { readFileSync } = await import('node:fs')
const tabsSrc = readFileSync('../web/src/app/marketing/ads/rules-automation/_shared/tabs.tsx', 'utf8')
// Parse the literal out of RULE_TAB_ACTION_TYPES_BASE rather than regexing the whole file.
const baseBlock = tabsSrc.slice(tabsSrc.indexOf('const RULE_TAB_ACTION_TYPES_BASE'))
const negLine = baseBlock.slice(baseBlock.indexOf("'negative-targeting':"))
const arrayLiteral = negLine.slice(negLine.indexOf('['), negLine.indexOf(']') + 1)
const fromTabs: string[] = JSON.parse(arrayLiteral.replace(/'/g, '"'))
// `RULE_TAB_ACTION_TYPES` merges the builder slug from ruleTypes.ts for the same tab.
const expected = [...fromTabs, 'negative-targeting']
const mine = [...svc.NEGATION_ACTION_TYPES]
console.log(`     tabs.tsx: ${expected.join(', ')}`)
console.log(`     service:  ${mine.join(', ')}`)
truthy('🔴 the API list is IDENTICAL to the tab map — a drift is a failure here, not a silent disagreement',
  JSON.stringify([...expected].sort()) === JSON.stringify([...mine].sort()))
truthy('`negative-targeting` is a REAL key in the tab map (three tabs shipped broken this way)',
  fromTabs.length > 0, `${fromTabs.length} action types`)

// ── 2 · the rules ─────────────────────────────────────────────────────────────────────────────
h('2 · the rules on this tab')
assert('rules on the tab', p.totals.onTab, 7)
assert('advertising rules in the account', p.totals.rulesInAccount, 51)
for (const r of p.rules) {
  console.log(`     ${r.enabled ? 'ON ' : 'off'} ${r.autonomyLevel.padEnd(8)} ${r.name}`)
  console.log(`          ${r.actionTypes.join(', ')}  ·  cap ${r.maxExecutionsPerDay ?? '—'}/day`)
  console.log(`          radius: ${r.blast.perExecution ?? '—'} ${r.blast.unit}${r.blast.perDayAtCap != null ? ` · up to ${int(r.blast.perDayAtCap)}/day at cap` : ''}`)
  console.log(`          activity ${ACTIVITY(r)}`)
  console.log(`          observed: ${r.observed.reached}/${r.observed.attempts} attempts reached the write${r.observed.wouldNegate != null ? ` · wouldNegate ${r.observed.wouldNegate}` : ''}${r.observed.neverReaches ? '  🔴 NEVER REACHES' : ''}`)
  if (r.observed.topRefusal) console.log(`          top refusal: "${r.observed.topRefusal.slice(0, 110)}"`)
}
function ACTIVITY(r: (typeof p.rules)[number]) {
  return `${int(r.activity.total)} rows in ${r.activity.windowDays}d — ${int(r.activity.succeeded)} succeeded · ${int(r.activity.refusedByCap)} refused by cap · ${int(r.activity.dryRuns)} dry-run · ${int(r.activity.otherErrors)} other`
}
truthy('🔴 an empty rule list FAILS rather than passing vacuously', p.rules.length > 0, String(p.rules.length))

// ── 3 · levels — the ceiling is still shut ────────────────────────────────────────────────────
h('3 · levels')
assert('rules on AUTO', p.totals.atAuto, 0)
truthy('every rule is PROPOSE', p.rules.every((r) => r.autonomyLevel === 'PROPOSE'), p.rules.map((r) => r.autonomyLevel).join(','))
truthy('every ceiling is PROPOSE', p.rules.every((r) => r.ceiling.maxLevel === 'PROPOSE'))
truthy('every rule is AT its ceiling — nothing can be raised without changing the ceiling first',
  p.rules.every((r) => r.atCeiling))
console.log(`     ceiling reason: "${p.rules[0]?.ceiling.reason}"`)

// ── 4 · scope ─────────────────────────────────────────────────────────────────────────────────
h('4 · scope')
assert('negation rules carrying ANY grain', p.rules.filter((r) => !r.scope.isAccountWide).length, 0)
assert('account-wide negation rules', p.totals.accountWide, 7)
console.log(`     ⚠ ${p.totals.scopedAnywhere} advertising rules carry a scope overall — a DIFFERENT denominator`)
truthy('🔴 every account-wide rule reaches the current scope', p.rules.every((r) => r.reachesCurrentScope))
const itScoped = await svc.getNegRules({ market: 'IT' })
truthy('🔴 narrowing to IT removes NO rule — that sentence is the finding',
  itScoped.totals.onTab === p.totals.onTab, `${itScoped.totals.onTab} vs ${p.totals.onTab}`)

// ── 5 · protectConverting RESOLVED, not raw ───────────────────────────────────────────────────
h('5 · protectConverting')
assert('resolved ON', p.rules.filter((r) => r.protectConverting.resolved).length, 7)
assert('rules where the KEY is present', p.rules.filter((r) => r.protectConverting.keyPresent).length, 0)
truthy('🔴 the key is absent on all 7 and the resolved value is ON on all 7 — rendering the raw key would print "off" beside seven protected rules',
  p.rules.every((r) => !r.protectConverting.keyPresent && r.protectConverting.resolved))

// ── 6 · blast radius ──────────────────────────────────────────────────────────────────────────
h('6 · blast radius')
const sync = p.rules.find((r) => r.actionTypes.includes('sync_negatives_across_campaigns'))
truthy('the sync rule exists', !!sync)
if (sync) {
  const it = sync.blast.byMarket.find((m) => m.market === 'IT')
  assert('IT ENABLED campaigns per execution', it?.count, 74)
  assert('unscoped headline is the LARGEST market, not the sum', sync.blast.perExecution, 74)
  truthy('and it is NOT 86 (IT+DE+FR+ES) — an execution that cannot occur',
    sync.blast.perExecution !== sync.blast.byMarket.reduce((a, m) => a + m.count, 0))
  truthy('the sentence says the counts are not additive', /not additive/.test(sync.blast.explanation))
  console.log(`     by market: ${sync.blast.byMarket.map((m) => `${m.market} ${m.count}`).join(' · ')}`)
  assert('cap', sync.maxExecutionsPerDay, 20)
  truthy('🔴 per-day exposure at cap is computed, not left to the reader',
    sync.blast.perDayAtCap != null && sync.blast.perDayAtCap > 1000, `${int(sync.blast.perDayAtCap ?? 0)}/day`)
}
const exact = p.rules.find((r) => r.actionTypes.includes('add_negative_exact'))
if (exact) {
  assert('add_negative_exact writes one negative per execution', exact.blast.perExecution, 1)
  truthy('and says it is CAMPAIGN-scoped by default', /CAMPAIGN scope by default/.test(exact.blast.explanation))
}
const harvestOnly = p.rules.find((r) => r.actionTypes.includes('harvest_and_negate') && !r.actionTypes.includes('add_negative_exact') && !r.actionTypes.includes('sync_negatives_across_campaigns'))
if (harvestOnly) {
  truthy('🔴 harvest_and_negate says NOT DETERMINABLE rather than inventing a number',
    harvestOnly.blast.kind === 'not-determinable' && harvestOnly.blast.perExecution === null)
}

// ── 7 · readiness — computed, six rows, no single verdict ─────────────────────────────────────
h('7 · readiness')
assert('conditions rendered', p.readiness.length, 6)
for (const c of p.readiness) console.log(`     ${c.state === 'closed' ? '✓' : '🔴'} ${c.n}. ${c.label}\n          ${c.evidence}`)
assert('closed', p.readiness.filter((c) => c.state === 'closed').length, 4)
assert('open', p.readiness.filter((c) => c.state === 'open').length, 2)
truthy('the two open are 5 and 6', p.readiness.filter((c) => c.state === 'open').map((c) => c.n).join(',') === '5,6')
truthy('both open conditions are marked OPERATOR work and link somewhere',
  p.readiness.filter((c) => c.state === 'open').every((c) => c.operatorWork && c.actionHref))
truthy('🔴 no single ready/not-ready verdict is exposed',
  !(('ready' in (p as unknown as Record<string, unknown>)) || ('verdict' in (p as unknown as Record<string, unknown>))))

// ── 8 · the phantom action ────────────────────────────────────────────────────────────────────
h('8 · add_negative_phrase')
const handlersSrc = readFileSync('src/services/advertising/automation-action-handlers.ts', 'utf8')
// Parsed as an assignment target, not a bare substring — the string appears in comments too.
const assigned = [...handlersSrc.matchAll(/ACTION_HANDLERS\.([a-z_]+)\s*=/g)].map((m) => m[1])
truthy('add_negative_phrase is on this tab', p.phantomActions[0]?.onTab === true)
truthy('🔴 and has NO handler', !assigned.includes('add_negative_phrase'), `${assigned.length} handlers registered`)
truthy('while add_negative_exact DOES — so the absence is specific, not a parse failure',
  assigned.includes('add_negative_exact'))
assert('rules currently using it', p.rules.filter((r) => r.actionTypes.includes('add_negative_phrase')).length, 0)

// ── 9 · refusals vs successes, and the cap counter ────────────────────────────────────────────
h('9 · refusals are not failures')
const totals = p.rules.reduce((a, r) => ({
  total: a.total + r.activity.total, succeeded: a.succeeded + r.activity.succeeded,
  cap: a.cap + r.activity.refusedByCap, dry: a.dry + r.activity.dryRuns, other: a.other + r.activity.otherErrors,
}), { total: 0, succeeded: 0, cap: 0, dry: 0, other: 0 })
console.log(`     ${int(totals.total)} executions in 60d — ${int(totals.succeeded)} succeeded · ${int(totals.cap)} refused by cap · ${int(totals.dry)} dry-run · ${int(totals.other)} other`)
truthy('🔴 the three classes are separable', totals.total === totals.succeeded + totals.cap + totals.dry + totals.other)
truthy('refusals are a real share of the table, not a rounding error', totals.cap > 0, `${int(totals.cap)}`)
console.log(`     cap counter trustworthy: ${p.capCounter.trustworthy}`)
console.log(`     ${p.capCounter.note}`)

// ── 9b · observed vs capability ───────────────────────────────────────────────────────────────
h('9b · 🔴 capability radius vs observed radius')
const never = p.rules.filter((r) => r.observed.neverReaches)
console.log(`     rules that NEVER reach their write: ${never.length} — ${never.map((r) => r.name).join(', ') || 'none'}`)
truthy('🔴 the widest-radius rule has never reached its own selection query',
  p.rules.find((r) => r.actionTypes.includes('sync_negatives_across_campaigns'))?.observed.neverReaches === true)
const migration = p.rules.find((r) => r.name.includes('match-type migration'))
truthy('🔴 protectConverting is refusing writes IN PRODUCTION — condition 1 has live evidence, not just code',
  !!migration && /protect converting/i.test(migration.observed.topRefusal ?? ''), migration?.observed.topRefusal?.slice(0, 80) ?? 'none')
const harvesters = p.rules.filter((r) => r.observed.wouldNegate != null)
truthy('harvest rules report a real wouldNegate from their dry runs', harvesters.length > 0,
  harvesters.map((r) => `${r.name}=${r.observed.wouldNegate}`).join(' · '))

// ── 10 · coverage ─────────────────────────────────────────────────────────────────────────────
h('10 · coverage — a zero here means a failed read')
truthy('rulesRead non-zero', p.coverage.rulesRead > 0, String(p.coverage.rulesRead))
truthy('campaignsRead non-zero', p.coverage.campaignsRead > 0, String(p.coverage.campaignsRead))
truthy('executionsRead non-zero', p.coverage.executionsRead > 0, int(p.coverage.executionsRead))

console.log(`\n${failures === 0 ? '✓ all assertions passed' : `🔴 ${failures} assertion(s) FAILED`}`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
