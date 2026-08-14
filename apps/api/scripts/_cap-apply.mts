/**
 * CAP — apply the operator-approved data changes. WRITES to AutomationRule rows.
 *
 * Approved 2026-08-14: "Data changes only, counter stays off" + "Retail guard exempt from the row
 * cap, bounded at 20 writes/day". Scope of this script, and nothing else:
 *
 *   1. re-size `maxExecutionsPerDay` per docs/2026-08-14-cap-sizing.md §6.1/§6.2   (12 rows)
 *   2. `enabled: false` on `New-to-brand optimizer`                                (§7.2)
 *
 * 🔴 NOT done, and each for a reason found while pre-flighting — see §7.3 of the doc:
 *   · AIREON `targetAcos: 30 → 0.3` — `ads-bid-optimizer.service.ts:253-274` records a DELIBERATE
 *     refusal to coerce ("a wrong guess here moves real money"), and a SECOND guard would refuse it
 *     anyway: the rule stores `campaignIds` (11), which the handler cannot honour.
 *   · `Reduce bids on ACOS spike` `maxValueCentsEur: 0 → null` — it is AUTO with dryRun=false, so
 *     un-blocking it while the counter is still broken creates a NEW uncapped writer. Belongs after
 *     `maxWritesPerDay` exists (step 6).
 *
 * Every row is snapshotted in full before it is touched, and the counter is NOT armed, so nothing
 * here binds anything until `automation-rule.service.ts:573` is fixed. Reverse with the snapshot.
 *
 * Requires --apply to write. Without it, it prints the plan and exits.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const APPLY = process.argv.includes('--apply')
const L: string[] = []
const say = (s = '') => L.push(s)

/** §6.1/§6.2. null = deliberately EXEMT from the row cap (Retail guard only). */
const CAPS: Record<string, number | null> = {
  'ACoS convergence (proportional correction)': 10,
  'AIREON — Target ACoS bidding': 36,
  'Alert: ACOS spike': 24,
  'Auto harvest & negate': 36,
  'Campaign ACOS rebalance (cut + scale)': 10,
  'Daily automation digest': 9,
  'Low CTR bid reduction': 200,
  'Profit-native bid optimisation': 36,
  'Reduce bids on ACOS spike': 10,
  'Retail guard': null,
  'Target ACOS setter (from profit)': 36,
  'Weekend budget boost': 36,
}
const DISABLE = ['New-to-brand optimizer']

const targets = await prisma.automationRule.findMany({
  where: { domain: 'advertising', enabled: true, name: { in: [...Object.keys(CAPS), ...DISABLE] } },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, dryRun: true, trigger: true,
    maxExecutionsPerDay: true, maxValueCentsEur: true, maxDailyAdSpendCentsEur: true,
    conditions: true, actions: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  },
})

// 🔴 a name that matches nothing must FAIL, not silently do nothing.
const found = new Set(targets.map((t) => t.name))
const missing = [...Object.keys(CAPS), ...DISABLE].filter((n) => !found.has(n))
if (missing.length) { console.error(`🔴 REFUSING: these names match no enabled advertising rule — ${missing.join(' · ')}`); process.exit(1) }
const dupe = targets.filter((t, i) => targets.findIndex((x) => x.name === t.name) !== i)
if (dupe.length) { console.error(`🔴 REFUSING: duplicate names among enabled rules — ${dupe.map((d) => d.name).join(' · ')}`); process.exit(1) }

say('── SNAPSHOT (every row, in full, before anything is written) ──')
for (const t of targets) say(`  ${JSON.stringify(t)}`)

say('\n── PLAN ──')
say('  rule                                        level     cap NOW   cap AFTER   enabled NOW → AFTER')
const plan: Array<{ id: string; name: string; cap?: number | null; enable?: boolean }> = []
for (const t of targets) {
  const wantCap = t.name in CAPS ? CAPS[t.name] : t.maxExecutionsPerDay
  const wantEnabled = DISABLE.includes(t.name) ? false : t.enabled
  const capChanges = wantCap !== t.maxExecutionsPerDay
  const enChanges = wantEnabled !== t.enabled
  if (capChanges || enChanges) plan.push({ id: t.id, name: t.name, ...(capChanges ? { cap: wantCap } : {}), ...(enChanges ? { enable: wantEnabled } : {}) })
  say(`  ${t.name.slice(0, 42).padEnd(43)} ${String(t.autonomyLevel).padEnd(8)} ${String(t.maxExecutionsPerDay ?? 'null').padStart(8)}  ${String(wantCap ?? 'null').padStart(10)}   ${t.enabled} → ${wantEnabled}${enChanges ? '  🔴 DISABLE' : ''}`)
}
say(`\n  rows to update: ${plan.length}`)

if (!APPLY) {
  say('\n  DRY RUN — nothing written. Re-run with --apply.')
  process.stdout.write('\n<<<CAP-APPLY>>>\n' + L.join('\n') + '\n')
  await prisma.$disconnect()
  process.exit(0)
}

say('\n── APPLYING ──')
for (const p of plan) {
  await prisma.automationRule.update({
    where: { id: p.id },
    data: { ...(p.cap !== undefined ? { maxExecutionsPerDay: p.cap } : {}), ...(p.enable !== undefined ? { enabled: p.enable } : {}) },
  })
  say(`  ✓ ${p.name.padEnd(43)} ${p.cap !== undefined ? `cap → ${p.cap ?? 'null'}` : ''} ${p.enable !== undefined ? `enabled → ${p.enable}` : ''}`)
}

say('\n── READ BACK (a write is not confirmed until it is read back) ──')
let bad = 0
const after = await prisma.automationRule.findMany({
  where: { domain: 'advertising', name: { in: [...Object.keys(CAPS), ...DISABLE] } },
  select: { name: true, enabled: true, maxExecutionsPerDay: true },
})
for (const a of after) {
  const wantCap = a.name in CAPS ? CAPS[a.name] : undefined
  const wantEn = DISABLE.includes(a.name) ? false : true
  const okCap = wantCap === undefined || a.maxExecutionsPerDay === wantCap
  const okEn = a.enabled === wantEn
  if (!okCap || !okEn) bad++
  say(`  ${okCap && okEn ? '✓' : '🔴'} ${a.name.padEnd(43)} cap=${a.maxExecutionsPerDay ?? 'null'} enabled=${a.enabled}`)
}
say(bad === 0 ? '\n✓ every change read back as intended' : `\n🔴 ${bad} rows did NOT read back as intended`)

// the counter must still be broken — this step deliberately does not arm it
const stillBroken = await prisma.automationRuleExecution.count({
  where: { startedAt: { gte: new Date(Date.now() - 60 * 86400_000) }, NOT: { errorMessage: 'DAILY_CAP_EXCEEDED' } },
})
say(`\n  counter still unarmed: the OLD clause matches ${stillBroken} rows (must be 0 — nothing binds yet)`)
if (stillBroken !== 0) bad++

process.stdout.write('\n<<<CAP-APPLY>>>\n' + L.join('\n') + '\n')
await prisma.$disconnect()
process.exit(bad === 0 ? 0 : 1)
