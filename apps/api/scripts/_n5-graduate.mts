/**
 * ADX N5 — graduate every rule whose gate is ALREADY open.
 *
 * This does not bypass the 14-day observation window; it discovers the window is
 * already satisfied. These rules are 60-80 days old with hundreds of real matches —
 * their matching logic has been proven for months. Only the action dispatch was broken,
 * and that was the ADX.1 cap ratchet, now fixed and demonstrated by the retail guard.
 *
 * Applies the same eight checks as POST /automation-rules/:id/graduate plus the N3
 * action-type ceiling. Dry-run unless --apply.
 */
import { resolve } from 'path'; import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const { graduationCeiling } = await import('../src/services/advertising/ads-graduation.js')
const APPLY = process.argv.includes('--apply')

const conn = await p.amazonAdsConnection.findFirst({ where: { isActive: true }, select: { mode: true, writesEnabledAt: true } })
const prot = await p.adKeywordProtection.count({ where: { mode: 'WHITELIST' } })
const rules = await p.automationRule.findMany({
  where: { domain: 'advertising', enabled: true, dryRun: true },
  select: { id: true, name: true, actions: true, createdAt: true, evaluationCount: true,
            matchCount: true, maxExecutionsPerDay: true, maxDailyAdSpendCentsEur: true },
})

const ready = rules.filter((r) => {
  const types = (Array.isArray(r.actions) ? r.actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)
  if (graduationCeiling({ actionTypes: types, hasKeywordProtections: prot > 0 }).maxLevel !== 'AUTO') return false
  const days = Math.floor((Date.now() - r.createdAt.getTime()) / 86_400_000)
  return days >= 14 && r.evaluationCount >= 10 && r.matchCount >= 1
    && conn?.mode === 'production' && !!conn?.writesEnabledAt
})

console.log(`\n${APPLY ? 'GRADUATING' : 'DRY RUN'} — ${ready.length} rules pass every gate check\n`)
for (const r of ready) {
  console.log(`  ${r.name.slice(0, 46).padEnd(46)} ${String(r.maxExecutionsPerDay ?? '∞').padStart(4)}/day · €${((r.maxDailyAdSpendCentsEur ?? 0) / 100).toFixed(0)}/day cap`)
}
const totalDaily = ready.reduce((s, r) => s + (r.maxDailyAdSpendCentsEur ?? 0), 0)
console.log(`\n  worst-case combined daily exposure: €${(totalDaily / 100).toFixed(0)} (sum of per-rule daily spend caps)`)

if (APPLY && ready.length) {
  await p.automationRule.updateMany({ where: { id: { in: ready.map((r) => r.id) } }, data: { dryRun: false, autonomyLevel: 'AUTO' } })
  console.log(`\n✅ ${ready.length} rules are now AUTONOMOUS`)
  console.log(`REVERSAL: UPDATE "AutomationRule" SET "dryRun"=true, "autonomyLevel"='PROPOSE' WHERE id IN (${ready.map((r) => `'${r.id}'`).join(',')});`)
}
await p.$disconnect()
