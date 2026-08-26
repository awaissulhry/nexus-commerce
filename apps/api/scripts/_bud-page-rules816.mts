/**
 * BUD.8 §3.3 — the two REVERSIBLE rule fixes. Dry-run unless --apply is passed.
 *
 * Authorised: the rename and the retire. NOT authorised and NOT done here: the hard delete of the
 * duplicate (destructive, and it is already `enabled=false` so removing the row changes no
 * behaviour), and any change to `autonomyLevel` (a separate gate the operator has not given).
 *
 * Writes `name` / `enabled` only. That is exactly what
 * `PATCH /advertising/automation-rules/:id` does with these two fields — its extra validation
 * (`listUntranslatableMetrics`) runs only when `actions` or `conditions` change, which this does
 * not — so this is the endpoint's own code path, not a way around it.
 *
 * Idempotent: re-running after a successful apply is a no-op.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const APPLY = process.argv.includes('--apply')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
    actions: true, evaluationCount: true, matchCount: true, executionCount: true, lastExecutedAt: true,
  },
})
const budget = rules.filter((r) => (Array.isArray(r.actions) ? r.actions : []).some((a) => String((a as { type?: unknown })?.type ?? '') === 'adjust_ad_budget'))

console.log(`\n══ BUD.8 §3.3 — ${APPLY ? '🔴 APPLYING' : 'DRY RUN (pass --apply to write)'} ══\n`)
console.log(`  ${pad('rule', 44)} ${pad('level', 8)} ${pad('evals', 8)} ${pad('matches', 8)} lastExec`)
for (const r of budget) {
  const lvl = resolveAutonomy({ enabled: r.enabled, dryRun: r.dryRun, autonomyLevel: r.autonomyLevel })
  console.log(`  ${pad(r.name, 44)} ${pad(lvl, 8)} ${pad(String(r.evaluationCount), 8)} ${pad(String(r.matchCount), 8)} ${r.lastExecutedAt?.toISOString().slice(0, 16) ?? 'never'}`)
}

// ── 1 · rename the rule whose name promises a half it does not contain ───────────────────────
const REBALANCE_OLD = 'Campaign ACOS rebalance (cut + scale)'
const REBALANCE_NEW = 'Campaign ACOS trim (cut only)'
const rebalance = budget.find((r) => r.name === REBALANCE_OLD)
console.log(`\n── 1 · rename: a rule that only cuts must not be called "cut + scale" ──`)
if (!rebalance) {
  console.log(`  already renamed, or not found — nothing to do`)
} else {
  const acts = (Array.isArray(rebalance.actions) ? rebalance.actions : []).map((a) => String((a as { type?: unknown })?.type ?? ''))
  const pct = (Array.isArray(rebalance.actions) ? rebalance.actions : []).map((a) => (a as { percent?: unknown }).percent).find((p) => typeof p === 'number')
  console.log(`  actions        : [${acts.join(', ')}]  percent=${String(pct)}`)
  console.log(`  🔴 no scale action present, and it is on ${resolveAutonomy({ enabled: rebalance.enabled, dryRun: rebalance.dryRun, autonomyLevel: rebalance.autonomyLevel })}`)
  console.log(`  "${REBALANCE_OLD}"`)
  console.log(`   → "${REBALANCE_NEW}"`)
  if (APPLY) {
    const r = await prisma.automationRule.update({ where: { id: rebalance.id }, data: { name: REBALANCE_NEW } })
    console.log(`  ✓ renamed. name is now "${r.name}"`)
  }
}

// ── 2 · retire the rule that cannot match ────────────────────────────────────────────────────
const BOOST = 'Boost budget on profitable campaigns'
const boost = budget.find((r) => r.name === BOOST)
console.log(`\n── 2 · retire: a rule bound to a trigger whose context it cannot read ──`)
if (!boost) {
  console.log(`  not found — nothing to do`)
} else if (!boost.enabled) {
  console.log(`  already disabled — nothing to do`)
} else {
  console.log(`  trigger        : ${boost.trigger}  (supplies an ad-target context)`)
  console.log(`  conditions read: campaign.*                     → can never be true`)
  console.log(`  evidence       : ${boost.evaluationCount} evaluations, ${boost.matchCount} matches, lastExecutedAt=${boost.lastExecutedAt?.toISOString() ?? 'never'}`)
  console.log(`  action         : enabled true → false (reversible; autonomyLevel untouched)`)
  console.log(`  NOT rebinding it to CAMPAIGN_PERFORMANCE_BUDGET: that would create a NEW +15%`)
  console.log(`  raiser in an account with €12.62/day of pacing headroom — a spend change wearing`)
  console.log(`  a bug fix's clothes. Retiring is the reversible half; rebinding needs its own gate.`)
  if (APPLY) {
    const r = await prisma.automationRule.update({ where: { id: boost.id }, data: { enabled: false } })
    console.log(`  ✓ retired. enabled=${r.enabled}, effective level=${resolveAutonomy({ enabled: r.enabled, dryRun: r.dryRun, autonomyLevel: r.autonomyLevel })}`)
  }
}

// ── 3 · the duplicate — deliberately NOT deleted ─────────────────────────────────────────────
const dupes = budget.filter((r) => r.name === 'Trim budget on weak ACOS')
console.log(`\n── 3 · the duplicate "Trim budget on weak ACOS" — NOT deleted ──`)
for (const d of dupes) {
  console.log(`  ${d.id}  enabled=${d.enabled}  level=${resolveAutonomy({ enabled: d.enabled, dryRun: d.dryRun, autonomyLevel: d.autonomyLevel })}  execs=${d.executionCount}`)
}
console.log(`  The disabled copy is already OFF, so deleting the row changes no behaviour — it is`)
console.log(`  tidying, and row deletion is destructive. Left for an explicit yes.`)

if (!APPLY) console.log(`\n  (dry run — nothing was written)`)
await prisma.$disconnect()
