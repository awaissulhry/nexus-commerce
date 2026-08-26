/**
 * RA.TABS — retirement coverage proof. READ-ONLY: no writes, no mutations, no rule creation.
 *
 * The question the tab cull has to answer before anything is deleted:
 *
 *   For every advertising AutomationRule — which of the five doomed rule-type tabs listed it
 *   today, and which Automations family will list it tomorrow? Is there a rule that TODAY has
 *   a tab home and TOMORROW has none?
 *
 * Three vocabularies are compared, all reproduced from the code that ships:
 *
 *   1. RULE_TAB_ACTION_TYPES — the CLIENT map (_shared/tabs.tsx:83). What the five tabs filter by.
 *   2. `liveType` — the string RulesAutomationClient actually passes to each RuleListTab. It is
 *      NOT always the tab key, and where it differs the tab renders nothing.
 *   3. ruleCategory() — the SERVER's 8-family taxonomy (rule-category.ts), imported not copied,
 *      which is exactly what GET /advertising/autonomy/rules returns and the Automations Type
 *      filter groups by.
 *
 * The Automations route (advertising.routes.ts:6443) selects `where: { domain: 'advertising' }`
 * with no further filter, so its universe is every row counted here — that is what makes the
 * category column a reachability claim and not just a label.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { ruleCategory, RULE_CATEGORY_META } = await import('../src/services/advertising/rule-category.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

// ── vocabulary 1: the CLIENT tab map, copied verbatim from _shared/tabs.tsx:83 ──
const RULE_TAB_ACTION_TYPES: Record<string, string[]> = {
  bid: ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier', 'defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact', 'harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'],
}

// ── vocabulary 2: what RulesAutomationClient.tsx actually passes as `liveType` ──
// tab key → liveType prop. Four match their key; 'keyword-harvest' passes 'keyword-harvesting',
// which is not a key of the map above, so ruleBelongsToTab() returns false for every rule.
const LIVE_TYPE_BY_TAB: Record<string, string> = {
  bid: 'bid',                                   // RulesAutomationClient.tsx:376
  budget: 'budget',                             // :344
  placement: 'placement',                       // :359
  'keyword-harvest': 'keyword-harvesting',      // :391  ← mismatch
  'negative-targeting': 'negative-targeting',   // :410
}

const TAB_KEYS = Object.keys(RULE_TAB_ACTION_TYPES)

/** _shared/tabs.tsx:92 — verbatim. Matches ANY action, not actions[0]. */
function ruleBelongsToTab(actions: unknown, tabKey: string): boolean {
  const want = RULE_TAB_ACTION_TYPES[tabKey]
  if (!want) return false
  const list = Array.isArray(actions) ? actions : []
  return list.some((a) => want.includes(String((a as { type?: unknown })?.type ?? '')))
}

const actionTypesOf = (actions: unknown): string[] =>
  (Array.isArray(actions) ? actions : []).map((a) => String((a as { type?: unknown })?.type ?? '')).filter(Boolean)

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, actions: true },
  orderBy: [{ name: 'asc' }],
})

console.log(`\n═══ RA.TABS coverage — ${rules.length} advertising AutomationRule rows ═══\n`)

// ── the per-rule table ────────────────────────────────────────────────────────
console.log(
  `${pad('rule', 44)} ${pad('mode', 8)} ${pad('tabs that LIST it today', 26)} ${pad('tabs that CLAIM it', 26)} ${pad('Automations family', 18)}`,
)
console.log('─'.repeat(126))

let orphanedByCull = 0        // had a real tab home, lands in no family — the blocker
let listedNowhereToday = 0    // no tab lists it today
let claimedButNotListed = 0   // the map claims it, the liveType string loses it
const familyCount = new Map<string, number>()
const tabListedCount = new Map<string, number>()   // what the tab GRID shows
const tabClaimedCount = new Map<string, number>()  // what the tab COUNT badge shows
const unmappedActions = new Map<string, number>()

for (const r of rules) {
  const types = actionTypesOf(r.actions)
  // What the tab bar's count badge claims (it uses the tab KEY — tabs.tsx:125).
  const claimed = TAB_KEYS.filter((k) => ruleBelongsToTab(r.actions, k))
  // What the grid actually renders (it uses the liveType PROP — RuleListTab.tsx:62).
  const listed = TAB_KEYS.filter((k) => ruleBelongsToTab(r.actions, LIVE_TYPE_BY_TAB[k]))
  const cat = ruleCategory(types)
  const level = resolveAutonomy(r as never)

  familyCount.set(cat, (familyCount.get(cat) ?? 0) + 1)
  for (const k of listed) tabListedCount.set(k, (tabListedCount.get(k) ?? 0) + 1)
  for (const k of claimed) tabClaimedCount.set(k, (tabClaimedCount.get(k) ?? 0) + 1)
  for (const t of types) if (!Object.values(RULE_TAB_ACTION_TYPES).flat().includes(t)) unmappedActions.set(t, (unmappedActions.get(t) ?? 0) + 1)

  if (!listed.length) listedNowhereToday++
  if (claimed.length && !listed.length) claimedButNotListed++
  // A rule is orphaned by the cull only if it is reachable today and unreachable after.
  // Every rule lands in some family (ruleCategory is total), so this can only fire if the
  // Automations route stopped returning it — kept as an assertion, not decoration.
  if (claimed.length && !cat) orphanedByCull++

  console.log(
    `${pad(r.name, 44)} ${pad(String(level), 8)} ${pad(listed.join(', ') || '— none —', 26)} ${pad(claimed.join(', ') || '— none —', 26)} ${pad(RULE_CATEGORY_META[cat].label, 18)}`,
  )
}

// ── the two summaries ─────────────────────────────────────────────────────────
console.log(`\n── the five doomed tabs: what each shows vs what its badge claims ──`)
for (const k of TAB_KEYS) {
  const listedN = tabListedCount.get(k) ?? 0
  const claimedN = tabClaimedCount.get(k) ?? 0
  const flag = listedN === claimedN ? '' : `   ⚠ badge says ${claimedN}, grid shows ${listedN} (liveType="${LIVE_TYPE_BY_TAB[k]}")`
  console.log(`  ${pad(k, 20)} grid ${String(listedN).padStart(3)}   badge ${String(claimedN).padStart(3)}${flag}`)
}

console.log(`\n── the Automations Type filter: every rule lands somewhere ──`)
for (const [cat, meta] of Object.entries(RULE_CATEGORY_META)) {
  const n = familyCount.get(cat) ?? 0
  if (n) console.log(`  ${pad(meta.label, 20)} ${String(n).padStart(3)}`)
}
console.log(`  ${pad('TOTAL', 20)} ${String([...familyCount.values()].reduce((a, b) => a + b, 0)).padStart(3)}  (of ${rules.length} rules)`)

console.log(`\n── action types the five tabs never mapped (the orphans Automations picks up) ──`)
for (const [t, n] of [...unmappedActions].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(t, 34)} ${String(n).padStart(3)} rule(s)`)

console.log(`\n═══ VERDICT ═══`)
console.log(`  rules reachable today via the five tabs' GRIDS   : ${rules.length - listedNowhereToday}`)
console.log(`  rules invisible today (no tab grid lists them)   : ${listedNowhereToday}`)
console.log(`  rules whose tab BADGE claims them but grid drops : ${claimedButNotListed}`)
console.log(`  rules reachable after the cull (Automations)     : ${[...familyCount.values()].reduce((a, b) => a + b, 0)}`)
console.log(`  rules made UNREACHABLE by the cull               : ${orphanedByCull}`)
console.log(orphanedByCull === 0
  ? `\n  ✔ No rule becomes unreachable. The retirement is safe on coverage grounds.\n`
  : `\n  ✖ ${orphanedByCull} rule(s) would become unreachable. The retirement is BLOCKED.\n`)

await prisma.$disconnect()
