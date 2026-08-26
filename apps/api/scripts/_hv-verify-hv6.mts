/**
 * HV — independent verification of HV.6. READ-ONLY.
 * The headline check: HV.6 says the adapter NEVER RUNS, so the 6-of-11 metric drop the brief
 * commissioned a table for has zero victims. Run the real predicate verbatim against real bodies.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { isBuilderShapedAdsRule, maybeTranslateAdsRule } = await import('../src/services/advertising/ads-rule-adapter.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))

console.log('\n═══ HV.6 verification ═══\n')

// ── 1 · does the adapter ever run? ──────────────────────────────────────────
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true },
})
console.log(`── 1 · the adapter, run verbatim against ${all.length} advertising rules ──`)
let builderShaped = 0, translated = 0, withLeaves = 0, discarded = 0
for (const r of all) {
  if (!isBuilderShapedAdsRule(r as never)) continue
  builderShaped++
  const t = maybeTranslateAdsRule(r as never)
  if (t) { translated++; if (t.conditions.length) withLeaves++ }
}
// how many rules carry a builder-shaped CONDITION leaf ({metric, op, value}) at all?
let builderCondRules = 0
for (const r of all) {
  const groups = Array.isArray(r.conditions) ? r.conditions : []
  const hasMetric = (groups as Array<Record<string, unknown>>).some((g) =>
    Array.isArray(g?.conditions) && (g.conditions as Array<Record<string, unknown>>).some((c) => typeof c?.metric === 'string'))
  if (hasMetric) builderCondRules++
}
console.log(`  builder-shaped (actions[0].type in BUILDER_SLUGS): ${builderShaped}`)
console.log(`  translated by maybeTranslateAdsRule:               ${translated}`)
console.log(`  rules carrying a builder condition leaf {metric}:  ${builderCondRules}`)
console.log(`  ⇒ translateConditions ${builderShaped === 0 ? 'NEVER RUNS — the 6-of-11 drop has ZERO victims ✅' : 'RUNS'}`)
console.log(`  [HV.6 said 0 of 62 builder-shaped, 0 condition leaves, 0 discarded]`)

const typeCount = new Map<string, number>()
for (const r of all) for (const t of types(r.actions)) typeCount.set(t, (typeCount.get(t) ?? 0) + 1)
console.log(`\n  every action type in the account (${typeCount.size}):`)
console.log(`  ${[...typeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' · ')}`)

// ── 2 · the harvest actor population ────────────────────────────────────────
const HARVEST = ['promote_to_exact', 'harvest_and_negate', 'keyword-harvesting']
const hv = all.filter((r) => types(r.actions).some((t) => HARVEST.includes(t)))
console.log(`\n── 2 · harvest rules ──`)
console.log(`  rules with a harvest action: ${hv.length}   [HV.6 said 7]`)
console.log(`  ${pad('rule', 46)} ${pad('on', 4)} ${pad('level', 9)} ${pad('trigger', 26)} criteria?`)
for (const r of hv) {
  const groups = Array.isArray(r.conditions) ? r.conditions : []
  const leaves = (groups as Array<Record<string, unknown>>).reduce((n, g) =>
    n + (Array.isArray(g?.conditions) ? (g.conditions as unknown[]).length : (g?.field ? 1 : 0)), 0)
  console.log(`  ${pad(r.name, 46)} ${pad(r.enabled ? 'ON' : '—', 4)} ${pad(String(r.autonomyLevel), 9)} ${pad(r.trigger, 26)} ${leaves === 0 ? '🔴 NONE' : `${leaves} leaf/leaves`}`)
}

// ── 3 · has any rule ever written a keyword? ────────────────────────────────
const ck = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'create_keyword' },
  select: { userId: true, executionId: true },
})
const byWriter = new Map<string, number>()
for (const l of ck) byWriter.set(l.executionId ? 'RULE EXECUTION' : (l.userId ?? '(no userId)'), (byWriter.get(l.executionId ? 'RULE EXECUTION' : (l.userId ?? '(no userId)')) ?? 0) + 1)
console.log(`\n── 3 · create_keyword writers, all time (${int(ck.length)} rows) ──`)
for (const [w, n] of [...byWriter.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(w, 30)} ${int(n)}`)
console.log(`  ⇒ writes from a rule execution: ${byWriter.get('RULE EXECUTION') ?? 0}   [HV.6 said 0, ever]`)

// ── 4 · the Control Room disagreement ───────────────────────────────────────
console.log('\n── 4 · Control Room vs HV.0 ──')
console.log(`  ads-control-room.service.ts:293 — mk('auto-harvest', …, masterOff ? 'OFF' : 'AUTO', …)`)
console.log(`  NEXUS_ADS_AUTO_HARVEST_ARMED in this process: ${process.env.NEXUS_ADS_AUTO_HARVEST_ARMED ?? '(unset)'}`)
const runs = await prisma.cronRun.findMany({ where: { jobName: 'ads-auto-harvest' }, orderBy: { startedAt: 'desc' }, take: 3, select: { startedAt: true, outputSummary: true } })
for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${r.outputSummary}`)
console.log(`  ⇒ the cron is dry-running; the registry entry reads no flag ⇒ the disagreement is real`)

// ── 5 · write state ─────────────────────────────────────────────────────────
const since = new Date('2026-08-12T00:00:00Z')
const newT = await prisma.adTarget.count({ where: { createdAt: { gte: since } } })
const newL = await prisma.advertisingActionLog.count({ where: { createdAt: { gte: since }, actionType: { in: ['create_keyword', 'create_negative_keyword'] } } })
console.log(`\n── 5 · write state ──`)
console.log(`  AdTarget created since 2026-08-12: ${newT} · create_* audit rows: ${newL}`)
console.log(`  ⇒ HV.4's live write ${newT === 0 && newL === 0 ? 'has STILL not run' : 'HAS run'}`)

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
