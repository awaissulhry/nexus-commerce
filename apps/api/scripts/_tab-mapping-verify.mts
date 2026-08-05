import { config } from 'dotenv'
config({ path: '/Users/awais/nexus-commerce/.env' })
const MAP: Record<string, string[]> = {
  bid: ['bid_to_target_acos','bid_up','bid_down','lower_bid_to_floor','raise_bids_for_rank_defense'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier','defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact','harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate','add_negative_exact','add_negative_phrase','sync_negatives_across_campaigns'],
}
const { PrismaClient } = await import('@prisma/client'); const p = new PrismaClient()
const rules = await p.automationRule.findMany({ where: { domain: 'advertising' }, select: { name: true, actions: true, enabled: true } })
const belongs = (actions: unknown, key: string) => {
  const want = MAP[key]; const list = Array.isArray(actions) ? actions : []
  return list.some((a) => want.includes(String((a as { type?: unknown })?.type ?? '')))
}
console.log('tab                    OLD (actions[0].type === key)   NEW (any action in map)')
for (const key of Object.keys(MAP)) {
  const oldN = rules.filter((r) => { const a = (Array.isArray(r.actions) ? r.actions[0] : null) as { type?: string } | null; return a?.type === key }).length
  const hits = rules.filter((r) => belongs(r.actions, key))
  console.log(`  ${key.padEnd(20)} ${String(oldN).padStart(3)}                          ${String(hits.length).padStart(3)}  (${hits.filter((h) => h.enabled).length} enabled)`)
}
const unmapped = new Set<string>()
for (const r of rules) for (const a of (Array.isArray(r.actions) ? r.actions : [])) {
  const t = String((a as { type?: unknown })?.type ?? '')
  if (t && !Object.values(MAP).flat().includes(t)) unmapped.add(t)
}
console.log('\naction types deliberately unmapped:', [...unmapped].sort().join(', '))
await p.$disconnect()
