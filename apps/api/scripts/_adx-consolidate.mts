/**
 * ADX.3a — rule-set consolidation. Reversible: flips `enabled`, deletes nothing.
 * Dry-run by default; pass --apply to write. Prints a reversal list either way.
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve(process.cwd(), '../../.env') })
const { PrismaClient } = await import('@prisma/client')
const p = new PrismaClient()
const APPLY = process.argv.includes('--apply')

const ENGINE_ACTIONS = ['defend_top_of_search', 'refresh_dayparting', 'set_placement_multiplier', 'raise_bids_for_rank_defense']
const rules = await p.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, trigger: true, enabled: true, actions: true, maxExecutionsPerDay: true, createdAt: true },
  orderBy: { createdAt: 'asc' },
})
const actionTypes = (r: typeof rules[number]) =>
  (Array.isArray(r.actions) ? r.actions : []).map((a) => (a as { type?: string })?.type).filter(Boolean) as string[]
// Behaviour key, not just action-type key. Grouping on trigger+type alone is too coarse:
// "Trim budget on weak ACOS" (percent -15) and "Scale budget-capped winners" (percent +20) share
// CAMPAIGN_PERFORMANCE_BUDGET::adjust_ad_budget but do OPPOSITE things, and collapsing them would
// drop the downside protection while keeping the upside. Direction and mode are part of identity.
const behaviour = (a: Record<string, unknown>): string => {
  const bits = [String(a?.type ?? '')]
  if (typeof a?.percent === 'number') bits.push((a.percent as number) >= 0 ? 'up' : 'down')
  if (a?.acosMode) bits.push(String(a.acosMode))
  if (a?.profitMode != null) bits.push(`profit:${String(a.profitMode)}`)
  if (a?.placement) bits.push(String(a.placement))
  return bits.join('/')
}
const fnKey = (r: typeof rules[number]) => {
  const acts = (Array.isArray(r.actions) ? r.actions : []) as Record<string, unknown>[]
  const sig = [...new Set(acts.filter((a) => !['notify', 'alert_operator'].includes(String(a?.type))).map(behaviour))]
  return `${r.trigger}::${sig.sort().join(',')}`
}

const disable = new Map<string, string>()   // id -> reason
for (const r of rules) {
  if (!r.enabled) continue
  if (actionTypes(r).some((t) => ENGINE_ACTIONS.includes(t))) {
    disable.set(r.id, 'duplicates the rank/dayparting engine')
  }
}
// Functional duplicates: same trigger + same non-notify action set. Keep the oldest still-enabled one.
const byFn = new Map<string, typeof rules>()
for (const r of rules) {
  if (!r.enabled || disable.has(r.id)) continue
  const k = fnKey(r)
  if (!k.endsWith('::')) byFn.set(k, [...(byFn.get(k) ?? []), r])
}
for (const [k, group] of byFn) {
  if (group.length < 2) continue
  const [keep, ...rest] = group
  for (const r of rest) disable.set(r.id, `functional duplicate of "${keep.name}" (${k})`)
}

const affected = rules.filter((r) => disable.has(r.id))
console.log(`\n${APPLY ? 'APPLYING' : 'DRY RUN'} — advertising rules: ${rules.length} total, ${rules.filter(r=>r.enabled).length} enabled\n`)
console.log(`WOULD DISABLE ${affected.length}:`)
for (const r of affected) console.log(`  · ${r.name.slice(0, 72)}\n      cap=${r.maxExecutionsPerDay} — ${disable.get(r.id)}`)
const keeping = rules.filter((r) => r.enabled && !disable.has(r.id))
console.log(`\nSTAYS ENABLED ${keeping.length}:`)
for (const r of keeping) console.log(`  · ${r.name.slice(0, 72)}  [${fnKey(r).split('::')[1] || 'alert-only'}] cap=${r.maxExecutionsPerDay}`)

if (APPLY && affected.length) {
  await p.automationRule.updateMany({ where: { id: { in: affected.map((r) => r.id) } }, data: { enabled: false } })
  console.log(`\n✅ disabled ${affected.length} rules.`)
  console.log(`REVERSAL: UPDATE "AutomationRule" SET enabled=true WHERE id IN (${affected.map((r) => `'${r.id}'`).join(',')});`)
}
await p.$disconnect()
