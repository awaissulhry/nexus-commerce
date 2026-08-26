/**
 * AUTO page study — a REBUILT conflict detector, run against the live account. READ-ONLY.
 *
 * The shipped detector (`automations/ruleText.ts:261`) flags 0 of 22 live rules. Its first line is
 * `if (a.trigger !== b.trigger) continue`, so the budget ratchet pair — which differ only in
 * trigger — is never compared at all.
 *
 * This is the replacement, as a working prototype, so the proposal can be judged on what it
 * actually catches rather than on a description:
 *
 *   1. reach   — every actor resolves to a SET OF CAMPAIGNS. Rules from their scope columns;
 *                engines from what they demonstrably wrote (the action log, AD_TARGET rows
 *                joined back to their campaign).
 *   2. field   — every action type resolves to the FIELD it writes. Two actors collide over a
 *                (campaign × field), which is what an entity actually experiences.
 *   3. classes — SAME-FIELD overlap · OPPOSED direction · DUPLICATE · CADENCE.
 *   4. output  — reported PER ENTITY, not per pair: "5 things can change this campaign's budget"
 *                is the sentence; 10 pairwise warnings is not.
 *
 * Nothing here writes. It reads AutomationRule, Campaign, AdTarget, AdGroup and
 * AdvertisingActionLog, and it calls the existing registry for the engines.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAutonomy } = await import('../src/services/advertising/ads-autonomy.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const DAY = 86_400_000
const since = new Date(Date.now() - 60 * DAY)

// ── the field each action writes, and which way it pushes ────────────────────────────────────
type Field = 'bid' | 'budget' | 'placement' | 'negative' | 'keyword' | 'state' | null
type Dir = 'up' | 'down' | 'either' | 'create' | 'destroy'
const FIELD: Record<string, { field: Field; dir: Dir }> = {
  bid_to_target_acos: { field: 'bid', dir: 'either' },
  bid_up: { field: 'bid', dir: 'up' },
  bid_down: { field: 'bid', dir: 'down' },
  set_bid: { field: 'bid', dir: 'either' },
  lower_bid_to_floor: { field: 'bid', dir: 'down' },
  raise_bids_for_rank_defense: { field: 'bid', dir: 'up' },
  adjust_ad_budget: { field: 'budget', dir: 'either' },
  budget_apply: { field: 'budget', dir: 'either' },
  shift_budget: { field: 'budget', dir: 'either' },
  set_placement_multiplier: { field: 'placement', dir: 'either' },
  defend_top_of_search: { field: 'placement', dir: 'up' },
  refresh_dayparting: { field: 'bid', dir: 'either' },
  promote_to_exact: { field: 'keyword', dir: 'create' },
  harvest_and_negate: { field: 'negative', dir: 'create' },
  add_negative_exact: { field: 'negative', dir: 'create' },
  add_negative_phrase: { field: 'negative', dir: 'create' },
  sync_negatives_across_campaigns: { field: 'negative', dir: 'create' },
  archive_keyword: { field: 'keyword', dir: 'destroy' },
  pause_campaign: { field: 'state', dir: 'destroy' },
  pause_ad_group: { field: 'state', dir: 'destroy' },
  pause_all_campaigns: { field: 'state', dir: 'destroy' },
  pause_target: { field: 'state', dir: 'destroy' },
  pause_ads_for_product: { field: 'state', dir: 'destroy' },
  retail_guard: { field: 'state', dir: 'destroy' },
  create_amazon_promotion: { field: 'state', dir: 'create' },
  notify: { field: null, dir: 'either' },
  alert_operator: { field: null, dir: 'either' },
  log_only: { field: null, dir: 'either' },
}

/** The evidence window each trigger's context builder reads, from the evaluator's own constants. */
const TRIGGER_WINDOW_DAYS: Record<string, number> = {
  CAMPAIGN_PERFORMANCE_BUDGET: 7,     // BUDGET_RULE_WINDOW_DAYS
  CAC_SPIKE: 7,
  AD_TARGET_UNDERPERFORMING: 14,
  KEYWORD_LOW_CTR: 14,
  KEYWORD_WASTED_SPEND: 14,
  CVR_DROP: 14,
  SEARCH_TERM_CONVERTING: 60,
  KEYWORD_ZERO_IMPRESSIONS: 14,
  SCHEDULE: 30,
}
/** `NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*​/15 * * * *'` — 96 evaluator ticks a day. */
const TICKS_PER_DAY = 96

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
    actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true,
    scopeCampaignId: true, scopeProductId: true, maxExecutionsPerDay: true,
  },
})
const campaigns = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, liveBidWritesEnabled: true },
})
const campById = new Map(campaigns.map((c) => [c.id, c]))
const acts = (r: { actions: unknown }) =>
  (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : [])

interface Actor {
  key: string
  name: string
  kind: 'rule' | 'engine'
  level: string
  fields: Map<Field, Set<Dir>>
  reach: Set<string>
  reachLabel: string
  trigger: string | null
  windowDays: number | null
  capPerDay: number | null
  compoundingPct: number | null
}
const actors: Actor[] = []

// ── rules: declared reach from the four scope columns ────────────────────────────────────────
for (const r of rules) {
  const level = resolveAutonomy(r as never)
  if (level === 'OFF') continue
  let reach = campaigns.map((c) => c.id)
  const applied: string[] = []
  if (r.scopeMarketplace) { reach = reach.filter((id) => campById.get(id)!.marketplace === r.scopeMarketplace); applied.push(`market ${r.scopeMarketplace}`) }
  if (r.scopeCampaignId) { reach = reach.filter((id) => id === r.scopeCampaignId); applied.push('one campaign') }
  else if (r.scopePortfolioId) { reach = reach.filter((id) => campById.get(id)!.portfolioId === r.scopePortfolioId); applied.push('one portfolio') }
  const fields = new Map<Field, Set<Dir>>()
  let pct: number | null = null
  for (const a of acts(r)) {
    const t = String(a?.type ?? '')
    const f = FIELD[t]
    if (!f || f.field == null) continue
    const s = fields.get(f.field) ?? new Set<Dir>()
    s.add(f.dir); fields.set(f.field, s)
    const p = typeof a.percent === 'number' ? a.percent : typeof a.percentage === 'number' ? a.percentage : null
    // `bid_down` stores a POSITIVE percent and the handler negates it (`-Math.abs(percent)`,
    // automation-action-handlers.ts:143). Reading the column raw is how the rule list renders
    // "+25%" for a rule that cuts bids a quarter (study 9). The sign has to come from the
    // action's DIRECTION, not from the stored number.
    if (p != null) pct = f.dir === 'down' ? -Math.abs(p) : f.dir === 'up' ? Math.abs(p) : p
  }
  if (fields.size === 0) continue
  actors.push({
    key: `rule:${r.id}`, name: r.name, kind: 'rule', level,
    fields, reach: new Set(reach),
    reachLabel: applied.length ? applied.join(' + ') : 'whole account',
    trigger: r.trigger,
    windowDays: TRIGGER_WINDOW_DAYS[r.trigger] ?? null,
    capPerDay: r.maxExecutionsPerDay,
    compoundingPct: pct,
  })
}

// ── engines: OBSERVED reach, from what they actually wrote ───────────────────────────────────
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since } },
  select: { userId: true, actionType: true, entityType: true, entityId: true },
})
// AD_TARGET → campaign, so a bid writer's reach is stated in campaigns like everyone else's.
const targetIds = [...new Set(logs.filter((l) => l.entityType === 'AD_TARGET').map((l) => l.entityId))]
const targets = targetIds.length
  ? await prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, adGroup: { select: { campaignId: true } } } })
  : []
const campOfTarget = new Map(targets.map((t) => [t.id, t.adGroup?.campaignId ?? null]))
const ACTION_FIELD: Record<string, Field> = {
  AD_BID_UPDATE: 'bid', AD_BUDGET_UPDATE: 'budget', update_placement_bidding: 'placement',
  create_negative_keyword: 'negative', create_keyword: 'keyword', create_product_ad: 'keyword',
}
const engineReach = new Map<string, { fields: Map<Field, Set<Dir>>; reach: Set<string>; rows: number }>()
const familyOf = (userId: string | null): string => {
  if (!userId) return '(unattributed)'
  const m = /^automation:([a-z-]+?)(-cm[a-z0-9]+)?$/.exec(userId)
  return m ? `automation:${m[1]}` : userId
}
const ruleIds = new Set(rules.map((r) => r.id))
for (const l of logs) {
  const f = ACTION_FIELD[l.actionType]
  if (!f) continue
  // `automation:<ruleId>` is a RULE writing, not an engine — attributed separately below.
  const bare = (l.userId ?? '').replace(/^automation:/, '')
  if (ruleIds.has(bare)) continue
  const key = familyOf(l.userId)
  const e = engineReach.get(key) ?? { fields: new Map<Field, Set<Dir>>(), reach: new Set<string>(), rows: 0 }
  const s = e.fields.get(f) ?? new Set<Dir>(); s.add('either'); e.fields.set(f, s)
  const cid = l.entityType === 'CAMPAIGN' ? l.entityId : l.entityType === 'AD_TARGET' ? campOfTarget.get(l.entityId) ?? null : null
  if (cid && campById.has(cid)) e.reach.add(cid)
  e.rows++
  engineReach.set(key, e)
}
for (const [key, e] of engineReach) {
  if (e.rows < 10) continue
  actors.push({
    key, name: key, kind: 'engine', level: 'AUTO',
    fields: e.fields, reach: e.reach,
    reachLabel: `${e.reach.size} campaigns, measured from ${int(e.rows)} writes`,
    trigger: null, windowDays: null, capPerDay: null, compoundingPct: null,
  })
}

console.log(`\n═══ actors that can change this account ═══\n`)
console.log(`${pad('actor', 46)} ${pad('kind', 7)} ${pad('level', 8)} ${pad('fields', 22)} reach`)
for (const a of actors.sort((x, y) => y.reach.size - x.reach.size)) {
  console.log(`   ${pad(a.name, 46)} ${pad(a.kind, 7)} ${pad(a.level, 8)} ${pad([...a.fields.keys()].join(','), 22)} ${a.reach.size} — ${a.reachLabel}`)
}

// ── the report an entity actually experiences ────────────────────────────────────────────────
console.log(`\n═══ CONFLICTS BY ENTITY — "what else can touch this campaign" ═══\n`)
const FIELDS: Field[] = ['bid', 'budget', 'placement', 'negative', 'keyword', 'state']
const perField = new Map<Field, Map<string, Actor[]>>()
for (const f of FIELDS) {
  const m = new Map<string, Actor[]>()
  for (const a of actors) {
    if (!a.fields.has(f)) continue
    for (const c of a.reach) m.set(c, [...(m.get(c) ?? []), a])
  }
  perField.set(f, m)
}
for (const f of FIELDS) {
  const m = perField.get(f)!
  const contested = [...m.entries()].filter(([, v]) => v.length > 1)
  if (m.size === 0) continue
  const dist = new Map<number, number>()
  for (const [, v] of m) dist.set(v.length, (dist.get(v.length) ?? 0) + 1)
  console.log(`${pad(f!, 10)} ${int(m.size)} campaigns reachable · ${int(contested.length)} with MORE THAN ONE actor`)
  console.log(`           actors per campaign: ${[...dist.entries()].sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}→${v}`).join(' · ')}`)
  const worst = contested.sort((a, b) => b[1].length - a[1].length)[0]
  if (worst) {
    console.log(`           worst: "${campById.get(worst[0])?.name}" — ${worst[1].length} actors:`)
    for (const a of worst[1]) console.log(`             · ${pad(a.name, 44)} ${a.kind} ${a.level}`)
  }
}

// ── the pair classes, for the rule drawer ────────────────────────────────────────────────────
console.log(`\n═══ PAIR CLASSES ═══\n`)
interface Flag { cls: string; a: string; b: string; shared: number; note: string }
const flags: Flag[] = []
for (let i = 0; i < actors.length; i++) {
  for (let j = i + 1; j < actors.length; j++) {
    const a = actors[i], b = actors[j]
    const shared = [...a.reach].filter((c) => b.reach.has(c)).length
    if (shared === 0) continue
    for (const f of FIELDS) {
      const da = a.fields.get(f), db = b.fields.get(f)
      if (!da || !db) continue
      const opposed = (da.has('up') && db.has('down')) || (da.has('down') && db.has('up'))
      flags.push({
        cls: opposed ? 'OPPOSED' : 'SAME-FIELD',
        a: a.name, b: b.name, shared,
        note: `both write ${f} on ${shared} shared campaigns${opposed ? ' — in opposite directions' : ''}`,
      })
    }
  }
}
// duplicates — at ANY level, because a dormant duplicate is invisible until someone arms it
const seenBody = new Map<string, string[]>()
for (const r of rules) {
  const k = `${r.trigger}|${JSON.stringify(r.actions)}|${JSON.stringify(r.conditions)}`
  seenBody.set(k, [...(seenBody.get(k) ?? []), `${r.name} [${resolveAutonomy(r as never)}]`])
}
const dupBody = [...seenBody.values()].filter((v) => v.length > 1)
const seenName = new Map<string, string[]>()
for (const r of rules) {
  const k = r.name.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase()
  seenName.set(k, [...(seenName.get(k) ?? []), `${r.name} [${resolveAutonomy(r as never)}]`])
}
const dupName = [...seenName.values()].filter((v) => v.length > 1)

// cadence — a compounding percent, read on a window far longer than the tick, with no cooldown
const cadence = actors.filter((a) =>
  a.kind === 'rule' && a.compoundingPct != null && a.windowDays != null && a.windowDays >= 7)

console.log(`SAME-FIELD  ${flags.filter((f) => f.cls === 'SAME-FIELD').length} pair-flags`)
console.log(`OPPOSED     ${flags.filter((f) => f.cls === 'OPPOSED').length} pair-flags`)
console.log(`DUPLICATE   ${dupBody.length} identical bodies · ${dupName.length} identical names (ignoring an emoji prefix)`)
for (const d of dupName) console.log(`               ${d.join('  ⇄  ')}`)
console.log(`CADENCE     ${cadence.length} rules apply a compounding % on evidence older than their tick`)
for (const c of cadence) {
  console.log(`               ${pad(c.name, 44)} ${c.compoundingPct! > 0 ? '+' : ''}${c.compoundingPct}% · ${c.windowDays}d window · read ${TICKS_PER_DAY}×/day · cap ${c.capPerDay ?? '∞'}/day`)
  const worst = Math.pow(1 + c.compoundingPct! / 100, c.capPerDay ?? 1)
  console.log(`               ${' '.repeat(44)} at its cap: ×${worst.toFixed(3)} of the starting value in one day`)
}

// ── does it catch the two things nine studies measured? ──────────────────────────────────────
console.log(`\n═══ THE PROOF — the conflicts the shipped detector misses ═══\n`)
const has = (nameA: string, nameB: string) =>
  flags.filter((f) => (f.a.includes(nameA) && f.b.includes(nameB)) || (f.a.includes(nameB) && f.b.includes(nameA)))
const ratchet = has('Trim budget on weak ACOS', 'Campaign ACOS rebalance')
console.log(`1. the budget ratchet pair (study 6):`)
console.log(ratchet.length ? ratchet.map((f) => `   ✅ ${f.cls} — ${f.note}`).join('\n') : '   🔴 still missed')
const acosNames = actors.filter((a) => a.kind === 'rule' && rules.find((r) => r.name === a.name && acts(r).some((x) => x.type === 'bid_to_target_acos')))
console.log(`\n2. the ${acosNames.length} live bid_to_target_acos rules (study 9):`)
for (const a of acosNames) {
  const n = flags.filter((f) => f.a === a.name || f.b === a.name).length
  console.log(`   ${n > 0 ? '✅' : '🔴'} ${pad(a.name, 46)} ${n} flags`)
}
console.log(`\n3. the engines, which the shipped detector cannot see at all:`)
for (const f of flags.filter((x) => actors.find((a) => a.name === x.a)?.kind === 'engine' || actors.find((a) => a.name === x.b)?.kind === 'engine').slice(0, 8)) {
  console.log(`   ✅ ${pad(f.a, 34)} ⇄ ${pad(f.b, 30)} ${f.note}`)
}

await prisma.$disconnect()
