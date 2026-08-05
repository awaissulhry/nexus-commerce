/**
 * ADX N1 — remove the proposals my ADX.2 regression created.
 *
 * Deletes rather than dismisses: "dismissed" asserts the operator saw it and said no,
 * and nobody ever saw these. They are rows that should never have existed —
 * notifications and explicitly-zero-change results — from the window between making
 * every dry-run propose and teaching it what a proposal is.
 *
 * Real, entity-level proposals are KEPT. Dry-run unless --apply.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

const all = await p.adsRuleSuggestion.findMany({ where: { status: 'pending' } })
const isNoise = (s: typeof all[number]) => {
  const a = (s.proposedAction ?? {}) as Record<string, unknown>
  if (['notify', 'alert_operator', 'log_only'].includes(String(a.type ?? ''))) return true
  if (a.wouldChange === 0 || a.wouldChange === '0') return true
  return false
}
const noise = all.filter(isNoise)
const aggregate = all.filter((s) => !isNoise(s) && s.entityType === 'MARKETPLACE')
const real = all.filter((s) => !isNoise(s) && s.entityType !== 'MARKETPLACE')

console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — pending proposals: ${all.length}`)
console.log(`  noise (notification / zero-change)  : ${noise.length}  → DELETE`)
console.log(`  marketplace-aggregate               : ${aggregate.length}  → DELETE (not an approvable entity)`)
console.log(`  real, entity-level                  : ${real.length}  → KEEP`)
for (const s of real) console.log(`    · ${s.entityType} ${s.entityName ?? s.entityId} — ${s.ruleName}`)

if (APPLY) {
  const ids = [...noise, ...aggregate].map((s) => s.id)
  const r = await p.adsRuleSuggestion.deleteMany({ where: { id: { in: ids } } })
  const left = await p.adsRuleSuggestion.count({ where: { status: 'pending' } })
  console.log(`\n✅ deleted ${r.count} · ${left} real proposals remain`)
}
await p.$disconnect()
