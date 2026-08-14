/** CAP — pre-flight for the approved data changes. READ-ONLY: prints the before/after table only. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const L: string[] = []
const say = (s = '') => L.push(s)

const PROPOSED: Record<string, number | null> = {
  'Low CTR bid reduction': 200,
  'Wasted keyword instant negate': 200,
  'Bulk bid floor protection': 100,
  'CVR drop alert + bid cut': 50,
  'Auto match-type migration (broad → exact)': 100,
  'Scale budget-capped winners': 10,
  'Boost budget on profitable campaigns': 10,
  'Stale campaign cleanup': 200,
  'Auto harvest & negate': 36,
  'AIREON — Target ACoS bidding': 36,
  'Daily automation digest': 9,
  'Target ACOS setter (from profit)': 36,
  'Profit-native bid optimisation': 36,
  'Weekend budget boost': 36,
  'ACoS convergence (proportional correction)': 10,
  'Reduce bids on ACOS spike': 10,
  'Campaign ACOS rebalance (cut + scale)': 10,
  'Alert: ACOS spike': 24,
  'Trim budget on weak ACOS': 10,
  'Retail guard': null, // 🔴 EXEMPT — operator decision 2026-08-14; bounded at 20 WRITES/day in step 6
  'New-to-brand optimizer': 10, // unchanged; this rule is DISABLED instead
}

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true },
  select: { id: true, name: true, autonomyLevel: true, maxExecutionsPerDay: true, enabled: true, actions: true },
  orderBy: { name: 'asc' },
})
say(`enabled advertising rules: ${rules.length}\n`)
say('  rule                                        level     cap NOW   cap AFTER   change')
let changes = 0
for (const r of rules) {
  const want = r.name in PROPOSED ? PROPOSED[r.name] : undefined
  if (want === undefined) { say(`  🔴 ${r.name.padEnd(43)} NOT IN THE PROPOSAL — refusing to guess`); continue }
  const now = r.maxExecutionsPerDay
  const same = now === want
  if (!same) changes++
  say(`  ${r.name.slice(0, 42).padEnd(43)} ${String(r.autonomyLevel).padEnd(8)} ${String(now ?? 'null').padStart(8)}  ${String(want ?? 'null').padStart(10)}   ${same ? '—' : '← CHANGE'}`)
}
say(`\n  rows whose cap changes: ${changes}`)

// names in the proposal that match no enabled rule — a typo would silently do nothing
const names = new Set(rules.map((r) => r.name))
const orphans = Object.keys(PROPOSED).filter((n) => !names.has(n))
say(orphans.length ? `  🔴 proposal names matching NO enabled rule: ${orphans.join(' · ')}` : '  ✓ every proposal name matches exactly one enabled rule')
const dupes = rules.filter((r, i) => rules.findIndex((x) => x.name === r.name) !== i)
say(dupes.length ? `  🔴 DUPLICATE names among enabled rules: ${dupes.map((d) => d.name).join(' · ')}` : '  ✓ no duplicate names among enabled rules')

// ── the two config fixes: check them before touching either ──
say('\n── the two proposed config fixes, re-read before acting ──')
for (const n of ['AIREON — Target ACoS bidding', 'Reduce bids on ACOS spike']) {
  const r = await prisma.automationRule.findFirst({
    where: { domain: 'advertising', name: n },
    select: { name: true, autonomyLevel: true, dryRun: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true, actions: true },
  })
  if (!r) { say(`  🔴 ${n} — not found`); continue }
  say(`  ${r.name} [${r.autonomyLevel}] dryRun=${r.dryRun} maxValueCentsEur=${r.maxValueCentsEur ?? 'null'} maxDailyAdSpendCentsEur=${r.maxDailyAdSpendCentsEur ?? 'null'}`)
  for (const a of (Array.isArray(r.actions) ? (r.actions as unknown[]) : [])) say(`     ${JSON.stringify(a)}`)
}

say('\n── the rule to disable ──')
const ntb = await prisma.automationRule.findFirst({
  where: { domain: 'advertising', name: 'New-to-brand optimizer' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, conditions: true, actions: true, maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true, scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true },
})
say(`  FULL ROW SNAPSHOT (so this is one click to reverse):`)
say(`  ${JSON.stringify(ntb)}`)
const execs = await prisma.automationRuleExecution.count({ where: { ruleId: ntb!.id } })
say(`  🔴 execution rows that would be DESTROYED by a delete (onDelete: Cascade): ${execs.toLocaleString('en-IE')} — disable, never delete`)

process.stdout.write('\n<<<CAP-PREFLIGHT>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
