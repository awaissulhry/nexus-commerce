/**
 * AUTO.A4 — conflicts BY ENTITY: "what else can touch this campaign", not "which pairs share a
 * trigger".
 *
 * REPLACES the shipped detector's model (`automations/ruleText.ts:detectConflicts`), which flags
 * 0 of 22 live rules: its first line skips any pair with different triggers — so the budget
 * ratchet pair, which differ only in trigger, is never compared — its `sameScope` reads only
 * marketplace, and it cannot see the engines or the operator at all. This service is the
 * prototype `scripts/_auto-page-conflicts.mts` proved against the live account (it catches the
 * ratchet pair, the bid_to_target_acos cluster and the engine overlaps), promoted with its logic
 * intact:
 *
 *   1. reach  — every actor resolves to a SET OF CAMPAIGNS. Rules from their scope columns;
 *               engines and everything else from what they DEMONSTRABLY wrote (the action log,
 *               AD_TARGET rows joined back to their campaign).
 *   2. field  — every action type resolves to the FIELD it writes. Two actors collide over a
 *               (campaign × field) — which is what an entity actually experiences.
 *   3. classes — SAME-FIELD · OPPOSED · DUPLICATE · CADENCE.
 *   4. output — per entity first ("5 things can change this campaign's budget"), pairs second
 *               (for the rule drawer), plus a per-rule index for grid badges.
 *
 * Server-side because reach resolution needs Campaign, AdTarget and the action log — none of
 * which the browser has. Every other page renders this; none computes it.
 */
import { prisma } from '@nexus/database'
import { resolveAutonomy } from './ads-autonomy.js'

const DAY = 86_400_000

export type ConflictField = 'bid' | 'budget' | 'placement' | 'negative' | 'keyword' | 'state'
type Dir = 'up' | 'down' | 'either' | 'create' | 'destroy'

/**
 * The field each action writes, and which way it pushes. `null` field = notify-only.
 *
 * EA7 — **exported.** Priority arbitration decides "these two rules both write this campaign's
 * budget, so the lower-priority one yields", which is the same question this map answers for
 * conflict DETECTION. Two copies would drift the first time an action type is added, and then the
 * page would report a collision the engine did not arbitrate — or worse, the reverse.
 */
export const ACTION_WRITES_FIELD: Record<string, { field: ConflictField | null; dir: Dir }> = {
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
  placement_apply: { field: 'placement', dir: 'either' },
  defend_top_of_search: { field: 'placement', dir: 'up' },
  refresh_dayparting: { field: 'bid', dir: 'either' },
  dayparting_apply: { field: 'bid', dir: 'either' },
  bid_apply: { field: 'bid', dir: 'either' },
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
  // P2.4 — builder slugs, resolved to what they translate into (BUILDER_SLUG_ACTIONS is the
  // authority; these mirror it at field grain so a stored builder rule is never invisible here).
  budget: { field: 'budget', dir: 'either' },
  placement: { field: 'placement', dir: 'either' },
  bid: { field: 'bid', dir: 'either' },
  sov: { field: 'bid', dir: 'either' },
  'keyword-tracker': { field: 'bid', dir: 'either' },
  'negative-targeting': { field: 'negative', dir: 'create' },
  'keyword-harvesting': { field: 'keyword', dir: 'create' },
  'dayparting-schedule': { field: 'bid', dir: 'either' },
  notify: { field: null, dir: 'either' },
  alert_operator: { field: null, dir: 'either' },
  log_only: { field: null, dir: 'either' },
}

/** The evidence window each trigger's context builder reads, from the evaluator's own constants. */
const TRIGGER_WINDOW_DAYS: Record<string, number> = {
  CAMPAIGN_PERFORMANCE_BUDGET: 7,
  CAC_SPIKE: 7,
  AD_TARGET_UNDERPERFORMING: 14,
  KEYWORD_LOW_CTR: 14,
  KEYWORD_WASTED_SPEND: 14,
  KEYWORD_HIGH_ACOS: 14,
  CVR_DROP: 14,
  SEARCH_TERM_CONVERTING: 30,
  SEARCH_TERM_WASTING: 30,
  KEYWORD_ZERO_IMPRESSIONS: 7,
  SOV_BID: 30,
  KEYWORD_RANK_BID: 30,
  SCHEDULE: 30,
}
const TICKS_PER_DAY = 96 // NEXUS_ADVERTISING_RULE_SCHEDULE ?? '*/15 * * * *'

export interface ConflictActor {
  key: string
  name: string
  kind: 'rule' | 'engine' | 'operator' | 'other'
  ruleId: string | null
  level: string
  fields: Partial<Record<ConflictField, Dir[]>>
  reach: string[]
  reachLabel: string
  trigger: string | null
  windowDays: number | null
  capPerDay: number | null
  compoundingPct: number | null
}

export interface ConflictPair {
  cls: 'SAME-FIELD' | 'OPPOSED'
  a: string
  b: string
  field: ConflictField
  shared: number
  note: string
}

/** Pure — pinned by tests: the (campaign × field) contest report and the pair classes. */
/** Internal alias — the map was `FIELD` throughout this file before EA7 exported it. */
const FIELD = ACTION_WRITES_FIELD

export function classifyConflicts(actors: ConflictActor[]) {
  const FIELDS: ConflictField[] = ['bid', 'budget', 'placement', 'negative', 'keyword', 'state']
  const byField = FIELDS.map((field) => {
    const perCampaign = new Map<string, ConflictActor[]>()
    for (const a of actors) {
      if (!a.fields[field]) continue
      for (const c of a.reach) perCampaign.set(c, [...(perCampaign.get(c) ?? []), a])
    }
    const contested = [...perCampaign.entries()].filter(([, v]) => v.length > 1)
    const dist = new Map<number, number>()
    for (const [, v] of perCampaign) dist.set(v.length, (dist.get(v.length) ?? 0) + 1)
    const worst = contested.sort((x, y) => y[1].length - x[1].length)[0] ?? null
    return {
      field,
      reachable: perCampaign.size,
      contested: contested.length,
      dist: [...dist.entries()].sort((x, y) => x[0] - y[0]).map(([actorsN, campaignsN]) => ({ actors: actorsN, campaigns: campaignsN })),
      worst: worst ? { campaignId: worst[0], actors: worst[1].map((a) => ({ name: a.name, kind: a.kind, level: a.level })) } : null,
      contestedCampaignIds: contested.map(([id]) => id),
    }
  })

  const pairs: ConflictPair[] = []
  for (let i = 0; i < actors.length; i++) {
    for (let j = i + 1; j < actors.length; j++) {
      const a = actors[i]!, b = actors[j]!
      const bReach = new Set(b.reach)
      const shared = a.reach.filter((c) => bReach.has(c)).length
      if (shared === 0) continue
      for (const field of FIELDS) {
        const da = a.fields[field], db = b.fields[field]
        if (!da || !db) continue
        const opposed = (da.includes('up') && db.includes('down')) || (da.includes('down') && db.includes('up'))
        pairs.push({
          cls: opposed ? 'OPPOSED' : 'SAME-FIELD',
          a: a.name, b: b.name, field, shared,
          note: `both write ${field} on ${shared} shared campaign${shared === 1 ? '' : 's'}${opposed ? ' — in opposite directions' : ''}`,
        })
      }
    }
  }

  // Per-rule index for grid badges and the drawer — OPPOSED before SAME-FIELD, worst first.
  const perRule: Record<string, string[]> = {}
  const nameToRule = new Map(actors.filter((a) => a.ruleId).map((a) => [a.name, a.ruleId!]))
  const ranked = [...pairs].sort((x, y) => (x.cls === y.cls ? y.shared - x.shared : x.cls === 'OPPOSED' ? -1 : 1))
  for (const p of ranked) {
    for (const side of [p.a, p.b] as const) {
      const rid = nameToRule.get(side)
      if (!rid) continue
      const other = side === p.a ? p.b : p.a
      const line = `${p.cls === 'OPPOSED' ? 'Opposed to' : 'Shares a field with'} “${other}” — ${p.note}`
      perRule[rid] = [...(perRule[rid] ?? []), line].slice(0, 6)
    }
  }
  return { byField, pairs, perRule }
}

export async function getConflicts(windowDays = 60) {
  const since = new Date(Date.now() - windowDays * DAY)
  const [rules, campaigns] = await Promise.all([
    prisma.automationRule.findMany({
      where: { domain: 'advertising' },
      select: {
        id: true, name: true, enabled: true, dryRun: true, autonomyLevel: true, trigger: true,
        actions: true, conditions: true, scopeMarketplace: true, scopePortfolioId: true,
        scopeCampaignId: true, scopeProductId: true, maxExecutionsPerDay: true,
      },
    }),
    prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true, portfolioId: true } }),
  ])
  const campById = new Map(campaigns.map((c) => [c.id, c]))
  const acts = (r: { actions: unknown }) => (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : [])

  const actors: ConflictActor[] = []

  // rules: DECLARED reach, from the four scope columns
  for (const r of rules) {
    const level = resolveAutonomy(r as never)
    if (level === 'OFF') continue
    let reach = campaigns.map((c) => c.id)
    const applied: string[] = []
    if (r.scopeMarketplace) { reach = reach.filter((id) => campById.get(id)!.marketplace === r.scopeMarketplace); applied.push(`market ${r.scopeMarketplace}`) }
    if (r.scopeCampaignId) { reach = reach.filter((id) => id === r.scopeCampaignId); applied.push('one campaign') }
    else if (r.scopePortfolioId) { reach = reach.filter((id) => campById.get(id)!.portfolioId === r.scopePortfolioId); applied.push('one portfolio') }
    const fields: Partial<Record<ConflictField, Dir[]>> = {}
    let pct: number | null = null
    for (const a of acts(r)) {
      const t = String(a?.type ?? '')
      const f = FIELD[t]
      if (!f || f.field == null) continue
      fields[f.field] = [...new Set([...(fields[f.field] ?? []), f.dir])]
      const p = typeof a.percent === 'number' ? a.percent : typeof a.percentage === 'number' ? a.percentage : null
      // `bid_down` stores a POSITIVE percent and the handler negates it — the sign must come
      // from the action's direction, not the stored number (study 9's "+25%" for a cut).
      if (p != null) pct = f.dir === 'down' ? -Math.abs(p) : f.dir === 'up' ? Math.abs(p) : p
    }
    if (Object.keys(fields).length === 0) continue
    actors.push({
      key: `rule:${r.id}`, name: r.name, kind: 'rule', ruleId: r.id, level,
      fields, reach,
      reachLabel: applied.length ? applied.join(' + ') : 'whole account',
      trigger: r.trigger,
      windowDays: TRIGGER_WINDOW_DAYS[r.trigger] ?? null,
      capPerDay: r.maxExecutionsPerDay,
      compoundingPct: pct,
    })
  }

  // engines / operator / scripts: OBSERVED reach, from what they actually wrote
  const logs = await prisma.advertisingActionLog.findMany({
    where: { createdAt: { gte: since } },
    select: { userId: true, actionType: true, entityType: true, entityId: true },
  })
  const targetIds = [...new Set(logs.filter((l) => l.entityType === 'AD_TARGET').map((l) => l.entityId))]
  const targets = targetIds.length
    ? await prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, adGroup: { select: { campaignId: true } } } })
    : []
  const campOfTarget = new Map(targets.map((t) => [t.id, t.adGroup?.campaignId ?? null]))
  const ACTION_FIELD: Record<string, ConflictField> = {
    AD_BID_UPDATE: 'bid', AD_BUDGET_UPDATE: 'budget', update_placement_bidding: 'placement',
    create_negative_keyword: 'negative', create_keyword: 'keyword', create_product_ad: 'keyword',
  }
  const familyOf = (userId: string | null): string => {
    if (!userId) return '(unattributed)'
    const m = /^automation:([a-z-]+?)(-cm[a-z0-9]+)?$/.exec(userId)
    return m ? `automation:${m[1]}` : userId
  }
  const ruleIds = new Set(rules.map((r) => r.id))
  const observed = new Map<string, { fields: Partial<Record<ConflictField, Dir[]>>; reach: Set<string>; rows: number }>()
  for (const l of logs) {
    const f = ACTION_FIELD[l.actionType]
    if (!f) continue
    const bare = (l.userId ?? '').replace(/^automation:/, '')
    if (ruleIds.has(bare)) continue // a rule writing — declared above
    const key = familyOf(l.userId)
    const e = observed.get(key) ?? { fields: {}, reach: new Set<string>(), rows: 0 }
    e.fields[f] = [...new Set([...(e.fields[f] ?? []), 'either' as Dir])]
    const cid = l.entityType === 'CAMPAIGN' ? l.entityId : l.entityType === 'AD_TARGET' ? campOfTarget.get(l.entityId) ?? null : null
    if (cid && campById.has(cid)) e.reach.add(cid)
    e.rows++
    observed.set(key, e)
  }
  for (const [key, e] of observed) {
    if (e.rows < 10) continue // below this, one manual test write would read as an actor
    const isOperator = key.startsWith('user:') || key === 'user' || key === 'operator'
    actors.push({
      key, name: isOperator ? 'you' : key, kind: isOperator ? 'operator' : key.startsWith('automation:') ? 'engine' : 'other',
      ruleId: null, level: isOperator ? '—' : 'AUTO',
      fields: e.fields, reach: [...e.reach],
      reachLabel: `${e.reach.size} campaigns, measured from ${e.rows.toLocaleString('en-IE')} writes`,
      trigger: null, windowDays: null, capPerDay: null, compoundingPct: null,
    })
  }

  const { byField, pairs, perRule } = classifyConflicts(actors)

  // duplicates — at ANY level: a dormant duplicate is invisible until someone arms it
  const byBody = new Map<string, string[]>()
  const byName = new Map<string, string[]>()
  for (const r of rules) {
    const label = `${r.name} [${resolveAutonomy(r as never)}]`
    const bodyKey = `${r.trigger}|${JSON.stringify(r.actions)}|${JSON.stringify(r.conditions)}`
    byBody.set(bodyKey, [...(byBody.get(bodyKey) ?? []), label])
    const nameKey = r.name.replace(/^[^\p{L}\p{N}]+/u, '').trim().toLowerCase()
    byName.set(nameKey, [...(byName.get(nameKey) ?? []), label])
  }

  // cadence — a compounding percent, read on a window far longer than the tick, with no cooldown
  const cadence = actors
    .filter((a) => a.kind === 'rule' && a.compoundingPct != null && a.windowDays != null && a.windowDays >= 7)
    .map((a) => ({
      name: a.name,
      ruleId: a.ruleId,
      pct: a.compoundingPct!,
      windowDays: a.windowDays!,
      capPerDay: a.capPerDay,
      ticksPerDay: TICKS_PER_DAY,
      atCapFactor: Number(Math.pow(1 + a.compoundingPct! / 100, a.capPerDay ?? 1).toFixed(3)),
    }))

  // resolve worst-campaign names for the field cards
  const byFieldNamed = byField.map((f) => ({
    ...f,
    worst: f.worst ? { ...f.worst, name: campById.get(f.worst.campaignId)?.name ?? f.worst.campaignId } : null,
  }))

  return {
    windowDays,
    totalCampaigns: campaigns.length,
    actors: actors.map((a) => ({ ...a, reach: a.reach.length })),
    byField: byFieldNamed,
    pairs,
    perRule,
    duplicates: {
      bodies: [...byBody.values()].filter((v) => v.length > 1),
      names: [...byName.values()].filter((v) => v.length > 1),
    },
    cadence,
  }
}
