/**
 * Negative Targeting page, decision D1 (Owner GO 2026-10-10) — the page's two STOP-WASTE rules may run alone (Auto), inside
 * caps. Everything else the graduation ceiling holds below Auto stays there (ads-graduation.ts).
 *
 * Only the PAGE'S SHAPE may reach Auto (review M1 + S1, 2026-10-11): the rule carries the page's test on its first action
 * (`stopWaste`, saved by the waste rules' save or Claude's save-ad-rule) AND its one writing action is
 *   PAUSE_KEYWORD  `pause_target` that keeps the keyword paused (the lock is the pause handler's, lane NWRITE), or
 *   NEGATE_TERM    `add_negative_exact` in the AD GROUP the term served in — no mapped destinations, no campaign level.
 * A Negative Targeting builder rule, a campaign-wide negative, a phrase, a mapped wire, or any older (or Claude-saved) rule
 * whose only action is a pause or a negative exact but which carries no `stopWaste` test keeps asking, as before.
 *
 * The ceiling (`stopWasteCeiling`, called by graduationCeiling with the rule's actions) says how far such a rule may be
 * SET: Auto, after the graduation gate (14 days watched, 10 runs, 1 match) and a person's click. A caller that passes no
 * actions gets the old answer (below Auto). What it may DO alone is judged per change at the one place an Auto ads rule
 * acts, the evaluator's pass (jobs/advertising-rule-evaluator.job.ts applyMarketplaceScope → `openStopWasteGate`):
 *   · the product's day cap, reserved WITH the change (S11): at most 10 keyword pauses and 20 negatives per product per
 *     UTC day, counted from the rules' live runs of the day and the changes this pass already reserved;
 *   · the never-list (`neverListReason`): a protected term · a person's Skip still open (S9) · a sale where it lands (or a
 *     keyword that sold, or a search under it — orders counted up to today) · a keyword of ours where the negative would
 *     land · a keyword Harvest made whose source negative stands (the brain's harvest, or a HARVEST-authored negative exact
 *     of its text in another of the product's ad groups — S10) · the home a brain funnel negative points to · a keyword
 *     made less than 30 days ago · a place less than 14 days old · a campaign no single product owns (shared, or none —
 *     M2) · for a negative, a market with no protected term at all.
 * Otherwise the change ASKS: the rule is evaluated for that one context as Ask me (it proposes; a person decides), and
 * the context carries why (`stopWaste.asks`), stored with the run.
 *
 * This file: the pure half (shape, kinds, caps, the ceiling, the never-list in words) and the gate the evaluator opens once
 * per pass (database reads through dynamic imports, so graduationCeiling's import of this file stays pure).
 */
import type { GraduationVerdict } from './ads-graduation.js'
import {
  FIXED_KEYWORD_SPEND_BAR_CENTS, FIXED_TERM_SPEND_BAR_CENTS, KEYWORD_CPA_BAR, MIN_CLICKS_FLOOR, TERM_CPA_BAR, WASTE_WINDOW_DAYS,
} from './waste/pure.js'

export type StopWasteKind = 'PAUSE_KEYWORD' | 'NEGATE_TERM'

/** D1 caps: what the stop-waste rules together may do alone for one product in one UTC day. */
export const STOP_WASTE_CAPS = { pausesPerProductPerDay: 10, negativesPerProductPerDay: 20 } as const

/** The never-list's ages: a keyword younger than this is never paused alone; a place younger than this is never touched alone. */
export const STOP_WASTE_AGES = { keywordDays: 30, placeDays: 14 } as const

/** The page's window (waste/pure.ts WASTE_WINDOW_DAYS): 60 click-days ending today − 3, orders through today. */
export const STOP_WASTE_DEFAULT_WINDOW_DAYS = WASTE_WINDOW_DAYS

/** Action types that only tell someone something: they never decide a rule's kind. */
const NOTIFY = new Set(['notify', 'alert_operator', 'log_only'])

/**
 * The stop-waste family of a rule from the action types it PRODUCES (ads-rule-adapter producedActionTypes, or a stored
 * engine rule's own types): exactly one writing type, and it is one of the two. Mixed rules are not a kind. Pure.
 * The family alone never makes a rule Auto: `stopWasteShapeOf` does.
 */
export function stopWasteKindOf(actionTypes: readonly string[]): StopWasteKind | null {
  const writing = [...new Set(actionTypes.filter((t) => t && !NOTIFY.has(t)))]
  if (writing.length !== 1) return null
  if (writing[0] === 'pause_target') return 'PAUSE_KEYWORD'
  if (writing[0] === 'add_negative_exact') return 'NEGATE_TERM'
  return null
}

const asList = (actions: unknown) => (Array.isArray(actions) ? actions : []) as Array<Record<string, unknown> | null>

/**
 * The page's shape (M1 + S1): the rule carries the page's test (`stopWaste` on its first action) and its one writing action
 * is a pause that keeps the keyword paused, or a negative exact in the ad group the term served in (no mapped
 * destinations, no campaign level). The kind it is, or null. Pure.
 */
export function stopWasteShapeOf(actions: unknown): StopWasteKind | null {
  const params = stopWasteParamsOf(actions)
  if (!params) return null
  const writing = asList(actions).filter((a) => !!a && !NOTIFY.has(String(a.type ?? '')))
  if (writing.length !== 1 || writing[0] !== asList(actions)[0]) return null
  const a = writing[0]!
  if (params.kind === 'PAUSE_KEYWORD') return a.type === 'pause_target' && a.keepPaused !== false ? 'PAUSE_KEYWORD' : null
  if (a.type !== 'add_negative_exact') return null
  const wire = a.negative as { blocks?: unknown } | null | undefined
  if (wire != null && Array.isArray(wire.blocks) && wire.blocks.length > 0) return null
  const levels = Array.isArray(a.levels) ? (a.levels as unknown[]).map(String) : []
  if (a.scope === 'CAMPAIGN' || levels.some((l) => l !== 'AD_GROUP')) return null
  if (a.negationLevel === 'campaign' || a.negationLevel === 'both') return null
  return 'NEGATE_TERM'
}

const CAP_WORDS = `at most ${STOP_WASTE_CAPS.pausesPerProductPerDay} keyword pauses and ${STOP_WASTE_CAPS.negativesPerProductPerDay} negatives per product a day`

/**
 * D1 — graduationCeiling's hook: the page's stop-waste rule may be set to Auto (the gate and a person's click still decide
 * WHEN). Null for every other rule — and for any caller that passes no actions — which the ceiling judges as before. Pure.
 */
export function stopWasteCeiling(actionTypes: readonly string[], actions?: unknown): GraduationVerdict | null {
  const kind = stopWasteKindOf(actionTypes)
  if (!kind || actions === undefined || stopWasteShapeOf(actions) !== kind) return null
  return {
    maxLevel: 'AUTO',
    reason: kind === 'PAUSE_KEYWORD'
      ? `Pauses a wasting keyword and keeps it paused. On Auto it acts alone inside its caps (${CAP_WORDS}); past a cap, or for a row it must never stop alone, it asks.`
      : `Negates a wasting search term (exact, in its ad group). On Auto it acts alone inside its caps (${CAP_WORDS}); past a cap, or for a row it must never stop alone, it asks.`,
    blockedBy: [],
  }
}

/** The day's cap of a kind, for one product. */
export const capOf = (kind: StopWasteKind): number =>
  kind === 'PAUSE_KEYWORD' ? STOP_WASTE_CAPS.pausesPerProductPerDay : STOP_WASTE_CAPS.negativesPerProductPerDay

/**
 * Why a change past the product's cap asks; null while there is room for `n` more. `used` counts the day's live changes of
 * this kind and the ones already reserved; the change is reserved WITH its check (S11), so `used + n` never passes the cap.
 * Pure.
 */
export function capReason(kind: StopWasteKind, used: number, productName: string, n = 1): string | null {
  const cap = capOf(kind)
  if (used + n <= cap) return null
  return kind === 'PAUSE_KEYWORD'
    ? `${productName} reached its ${cap} keyword pauses for today: this pause waits for your yes.`
    : `${productName} reached its ${cap} negatives for today: this negative waits for your yes.`
}

/** Why an Auto rule that is not the page's shape asks for every change (M1 + S1). */
export const NOT_PAGE_SHAPE = 'Auto is only for rules made on this page: this rule asks first.'

/** What the never-list reads about one change (the gate loads it; tests build it). */
export interface StopWasteFacts {
  kind: StopWasteKind
  /** The keyword's text, or the search term. */
  text: string
  /** The protected term it matches, null when none does. */
  protectedTerm: string | null
  /** NEGATE_TERM: the market has no protected term at all. */
  noProtectedTerms: boolean
  /** A person's Skip of this row still open (S9): until when, and who. */
  skipped: { until: Date; by: string } | null
  /** Orders in the window, counted up to today: the keyword's own and its searches' (PAUSE), the term's where it lands (NEGATE). */
  soldOrders: number
  /** NEGATE_TERM: a keyword of ours with this text where the negative would land (Harvest's, or a person's). */
  ownKeywordThere: boolean
  /** PAUSE_KEYWORD: Harvest made this keyword and negated the search in its source (the brain's, or a HARVEST negative — S10). */
  harvestDestination: boolean
  /** PAUSE_KEYWORD: a brain funnel negative points to this keyword as the search's home. */
  funnelHome: boolean
  /** PAUSE_KEYWORD: days since the keyword was made; null when unknown (treated as new). */
  keywordAgeDays: number | null
  /** Days since the place it lands (the ad group) was made; null when unknown. */
  placeAgeDays: number | null
  /** Who owns the campaign: one product, several (shared), or none Nexus can tie. */
  owner: 'product' | 'shared' | 'none'
  /** The window the orders were counted over. */
  windowDays: number
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`
const dayWords = (d: Date) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/Rome' }).format(d)
const whoWords = (by: string) => (by.startsWith('user:') ? 'you' : by.replace(/^[a-z]+:/, ''))

/**
 * The first never-list item that holds this change, in words (the reason the change asks instead of acting); null when
 * none does. The order is the Owner's list (PLAN §2). Pure.
 */
export function neverListReason(f: StopWasteFacts): string | null {
  const what = f.kind === 'PAUSE_KEYWORD' ? 'keyword' : 'search term'
  if (f.protectedTerm) return `"${f.text}" matches the protected term "${f.protectedTerm}": a protected term is never stopped alone.`
  if (f.skipped) return `Skipped by ${whoWords(f.skipped.by)} until ${dayWords(f.skipped.until)}: a skipped row waits for your yes.`
  if (f.kind === 'NEGATE_TERM' && f.noProtectedTerms) return 'No protected term is set for this market: a negative waits for your yes until your brand terms are protected.'
  if (f.soldOrders > 0) {
    return f.kind === 'PAUSE_KEYWORD'
      ? `This keyword (or a search under it) sold ${f.soldOrders} in the last ${days(f.windowDays)}, counted up to today: it is never paused alone.`
      : `This search term sold ${f.soldOrders} where the negative would land in the last ${days(f.windowDays)}, counted up to today: it is never negated alone.`
  }
  if (f.kind === 'NEGATE_TERM' && f.ownKeywordThere) return `"${f.text}" is a keyword of ours where the negative would land (Harvest's or yours): never negated alone.`
  if (f.kind === 'PAUSE_KEYWORD' && f.harvestDestination) return 'Harvest made this keyword and negated the search in its source: pausing it would leave the search served nowhere, so it asks.'
  if (f.kind === 'PAUSE_KEYWORD' && f.funnelHome) return 'The Brain keeps this search out of the product\'s other ad groups because this keyword serves it: pausing it would leave the search served nowhere, so it asks.'
  if (f.kind === 'PAUSE_KEYWORD' && (f.keywordAgeDays == null || f.keywordAgeDays < STOP_WASTE_AGES.keywordDays)) {
    return `This keyword is ${f.keywordAgeDays == null ? 'of unknown age' : `${days(f.keywordAgeDays)} old`}: a keyword gets ${STOP_WASTE_AGES.keywordDays} days before a rule pauses it alone.`
  }
  if (f.placeAgeDays == null || f.placeAgeDays < STOP_WASTE_AGES.placeDays) {
    return `The place it lands is ${f.placeAgeDays == null ? 'of unknown age' : `${days(f.placeAgeDays)} old`}: a place gets ${STOP_WASTE_AGES.placeDays} days before a rule stops a ${what} there alone.`
  }
  if (f.owner === 'shared') return 'Several products share this campaign and none owns it: a stop there waits for your yes.'
  if (f.owner !== 'product') return 'No single product owns this campaign: a stop there waits for your yes.'
  return null
}

/** A rule's stop-waste test settings, stored on its first action (`actions[0].stopWaste`) by the waste rules' save. */
export interface StopWasteParams {
  kind: StopWasteKind
  /** Click-days of the window (ending today − 3); orders run to today. */
  windowDays: number
  /** The clicks floor (PLAN §2: 20), raised to the product's 95 % call (≈ 3 ÷ its conversion rate) where that is higher. */
  minClicks: number
  /** Spend must reach this many target costs per order (2 for a keyword, 1.5 for a search term). */
  cpaMultiple: number
  /** The spend bar when the product has no target cost per order (no target ACoS, or no order value). Cents. */
  spendFloorCents: number
}

/** The stop-waste params a rule's first action carries (the page's defaults where one is missing); null when it carries none. Pure. */
export function stopWasteParamsOf(actions: unknown): StopWasteParams | null {
  const a0 = asList(actions)[0]
  const p = a0?.stopWaste as Partial<StopWasteParams> | undefined
  if (!p || typeof p !== 'object' || (p.kind !== 'PAUSE_KEYWORD' && p.kind !== 'NEGATE_TERM')) return null
  const n = (v: unknown, lo: number, hi: number, dflt: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt)
  const keyword = p.kind === 'PAUSE_KEYWORD'
  return {
    kind: p.kind,
    windowDays: Math.round(n(p.windowDays, 14, 87, STOP_WASTE_DEFAULT_WINDOW_DAYS)),
    minClicks: Math.round(n(p.minClicks, 1, 10_000, MIN_CLICKS_FLOOR)),
    cpaMultiple: n(p.cpaMultiple, 0.5, 10, keyword ? KEYWORD_CPA_BAR : TERM_CPA_BAR),
    spendFloorCents: Math.round(n(p.spendFloorCents, 1, 10_000_000, keyword ? FIXED_KEYWORD_SPEND_BAR_CENTS : FIXED_TERM_SPEND_BAR_CENTS)),
  }
}

// ── the gate the evaluator opens once per pass ──────────────────────────────────────────────────────────────────────

/** One rule as the evaluator's pass holds it. */
export interface GateRule { id: string; trigger?: string | null; actions: unknown; conditions?: unknown; enabled?: boolean; dryRun?: boolean; autonomyLevel?: string | null }

/** What the gate says for one context: the rules that act alone, the ones that ask (each with why), and whose day it counts on. */
export interface GateSplit { act: string[]; ask: Array<{ ruleId: string; why: string }>; product?: { key: string; name: string } | null }

export interface StopWasteGate {
  /** Which rules act alone on this context; each one that does reserves its change on the product's day (S11). */
  split(ruleIds: readonly string[], ctx: unknown): Promise<GateSplit>
  /** Settle what the acting rules really wrote on this context against their reservations. */
  count(ctx: unknown, results: ReadonlyArray<{ ruleId?: string; actionResults?: ReadonlyArray<{ type?: string; ok?: boolean; output?: unknown }> }>): Promise<void>
}

const DAY = 86_400_000
const utcDayStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ')
const ageDays = (at: Date | null | undefined, now: Date) => (at ? Math.floor((now.getTime() - at.getTime()) / DAY) : null)

/** The live changes one action result made: a pause landed or queued (1), negatives that reached Amazon (n). Pure. */
export function changesOf(kind: StopWasteKind, a: { type?: string; ok?: boolean; output?: unknown }): number {
  const o = (a.output && typeof a.output === 'object' ? a.output : {}) as Record<string, unknown>
  if (o.dryRun || o.skipped || o.noChange) return 0
  if (kind === 'PAUSE_KEYWORD') return a.type === 'pause_target' && a.ok !== false && o.status === 'PAUSED' ? 1 : 0
  if (a.type !== 'add_negative_exact' && a.type !== 'add_negative_phrase') return 0
  if (typeof o.confirmed === 'number') return o.confirmed
  return a.ok !== false && o.externalTargetId != null && !o.alreadyExisted ? 1 : 0
}

/** The place a context names: the ad group (local id or Amazon's), the keyword, the search term, the market. Pure. */
export function placeOf(ctx: unknown): { marketplace: string | null; adGroupId: string | null; externalAdGroupId: string | null; externalCampaignId: string | null; targetId: string | null; text: string | null; match: string | null } {
  const c = (ctx ?? {}) as {
    marketplace?: string | null
    adGroup?: { id?: string | null }
    adTarget?: { id?: string | null; expressionValue?: string | null; expressionType?: string | null }
    searchTerm?: { query?: string | null; externalAdGroupId?: string | null; externalCampaignId?: string | null }
  }
  return {
    marketplace: c.marketplace ?? null,
    adGroupId: c.adGroup?.id ?? null,
    externalAdGroupId: c.searchTerm?.externalAdGroupId ?? null,
    externalCampaignId: c.searchTerm?.externalCampaignId ?? null,
    targetId: c.adTarget?.id ?? null,
    text: c.searchTerm?.query ?? c.adTarget?.expressionValue ?? null,
    match: c.adTarget?.expressionType ?? null,
  }
}

/** The level a negative lands at, from the rule's action (`levels` of a wire, `scope`, or a builder's level): campaign or ad group. Pure. */
export function negativeLevelOf(actions: unknown): 'AD_GROUP' | 'CAMPAIGN' {
  const a0 = asList(actions)[0] as { scope?: unknown; levels?: unknown; negationLevel?: unknown } | null | undefined
  const levels = Array.isArray(a0?.levels) ? (a0!.levels as unknown[]).map(String) : []
  if (levels.includes('CAMPAIGN')) return 'CAMPAIGN'
  if (a0?.scope === 'CAMPAIGN' || a0?.negationLevel === 'campaign' || a0?.negationLevel === 'both') return 'CAMPAIGN'
  return 'AD_GROUP'
}

interface PlaceFacts { adGroupId: string; campaignId: string; marketplace: string | null; externalAdGroupId: string | null; externalCampaignId: string | null; adGroupAt: Date; campaignAt: Date }
interface OwnerFacts { key: string; name: string; owner: 'product' | 'shared' | 'none'; root: string | null }

/**
 * Open the gate for one evaluator pass over these rules (null when none of them is on Auto with a stop-waste family, so a
 * pass without one reads nothing). Today's live changes per product are read once; each context's facts as it comes.
 * `asIfAuto` (the preview): every rule is judged as if it were on Auto, and nothing it would do is ever settled.
 */
export async function openStopWasteGate(rules: readonly GateRule[], opts: { now?: Date; asIfAuto?: boolean } = {}): Promise<StopWasteGate | null> {
  const now = opts.now ?? new Date()
  const [{ producedActionTypes }, { resolveAutonomy }] = await Promise.all([
    import('./ads-rule-adapter.service.js'),
    import('./ads-autonomy.js'),
  ])
  /** The page's stop-waste rules (they may act alone), and Auto rules of the family that are not the page's shape (they ask). */
  const kindOf = new Map<string, StopWasteKind>()
  const autoRules = new Map<string, GateRule>()
  const notShaped = new Set<string>()
  for (const r of rules) {
    const family = stopWasteKindOf(producedActionTypes(r))
    if (!family) continue
    const auto = opts.asIfAuto || resolveAutonomy({ enabled: r.enabled ?? true, dryRun: r.dryRun ?? true, autonomyLevel: r.autonomyLevel ?? null }) === 'AUTO'
    const shape = stopWasteShapeOf(r.actions)
    if (shape === family) {
      kindOf.set(r.id, family)
      if (auto) autoRules.set(r.id, r)
    } else if (auto) notShaped.add(r.id)
  }
  if (!autoRules.size && !notShaped.size) return null

  const { default: prisma } = await import('../../db.js')
  const { resolveCampaignOwnership, productFamily } = await import('./brain/ownership.js')
  const { loadProtectedTerms, protectedTermHit } = await import('./ads-negation-policy.js')
  const { activeSkips } = await import('./waste/skip.js')
  const { keywordRowId, termRowId, termKeyOf } = await import('./waste/pure.js')
  const { strategyMarket } = await import('./ads-strategy/bids.js')

  const places = new Map<string, PlaceFacts | null>()
  const extGroups = new Map<string, string | null>()
  const owners = new Map<string, OwnerFacts>()
  const families = new Map<string, string[]>()
  const protections = new Map<string, Awaited<ReturnType<typeof loadProtectedTerms>>>()
  /** Each product's day per kind: the live changes of today, plus what this pass reserved and has not settled. */
  const used = new Map<string, number>()
  const usedKey = (kind: StopWasteKind, key: string) => `${kind}|${key}`
  /** What each context's acting rules reserved (S11), settled by `count`. */
  const reserved = new WeakMap<object, Array<{ ruleId: string; key: string; n: number }>>()

  async function placeOfAdGroup(id: string): Promise<PlaceFacts | null> {
    if (places.has(id)) return places.get(id)!
    const g = await prisma.adGroup.findUnique({
      where: { id },
      select: { id: true, createdAt: true, externalAdGroupId: true, campaignId: true, campaign: { select: { createdAt: true, marketplace: true, externalCampaignId: true } } },
    })
    const facts = g ? { adGroupId: g.id, campaignId: g.campaignId, marketplace: g.campaign?.marketplace ?? null, externalAdGroupId: g.externalAdGroupId ?? null, externalCampaignId: g.campaign?.externalCampaignId ?? null, adGroupAt: g.createdAt, campaignAt: g.campaign?.createdAt ?? g.createdAt } : null
    places.set(id, facts)
    return facts
  }
  async function localAdGroup(ctx: unknown): Promise<string | null> {
    const p = placeOf(ctx)
    if (p.adGroupId) return p.adGroupId
    if (p.targetId) {
      const t = await prisma.adTarget.findUnique({ where: { id: p.targetId }, select: { adGroupId: true } })
      return t?.adGroupId ?? null
    }
    if (!p.externalAdGroupId) return null
    if (!extGroups.has(p.externalAdGroupId)) {
      const g = await prisma.adGroup.findFirst({ where: { externalAdGroupId: p.externalAdGroupId }, select: { id: true } })
      extGroups.set(p.externalAdGroupId, g?.id ?? null)
    }
    return extGroups.get(p.externalAdGroupId) ?? null
  }
  async function ownerOf(campaignId: string): Promise<OwnerFacts> {
    if (owners.has(campaignId)) return owners.get(campaignId)!
    const o = (await resolveCampaignOwnership([campaignId])).get(campaignId)
    let facts: OwnerFacts
    if (o?.owner.kind === 'product') {
      const p = await prisma.product.findUnique({ where: { id: o.owner.productId }, select: { sku: true, name: true } })
      facts = { key: `product:${o.owner.productId}`, name: p?.sku || p?.name || 'This product', owner: 'product', root: o.owner.productId }
    } else {
      facts = { key: `campaign:${campaignId}`, name: o?.name ? `Campaign ${o.name}` : 'This campaign', owner: o?.owner.kind === 'shared' ? 'shared' : 'none', root: null }
    }
    owners.set(campaignId, facts)
    return facts
  }
  async function familyOf(root: string): Promise<string[]> {
    if (!families.has(root)) families.set(root, ((await productFamily(root))?.members ?? []).map((m) => m.id))
    return families.get(root)!
  }
  async function protectionsOf(marketplace: string | null, campaignId: string | null) {
    const key = `${marketplace ?? ''}|${campaignId ?? ''}`
    if (!protections.has(key)) protections.set(key, await loadProtectedTerms({ marketplace, campaignId }))
    return protections.get(key)!
  }

  // Today's live changes of every page stop-waste rule (any level: an Auto run of the morning counts in the afternoon).
  const dayStart = utcDayStart(now)
  const ran = kindOf.size && !opts.asIfAuto ? await prisma.automationRuleExecution.findMany({
    where: { ruleId: { in: [...kindOf.keys()] }, startedAt: { gte: dayStart }, dryRun: false },
    select: { ruleId: true, triggerData: true, actionResults: true },
  }) : []
  for (const run of ran) {
    const kind = kindOf.get(run.ruleId)!
    const n = (Array.isArray(run.actionResults) ? run.actionResults as Array<{ type?: string; ok?: boolean; output?: unknown }> : []).reduce((s, a) => s + changesOf(kind, a), 0)
    if (!n) continue
    const groupId = await localAdGroup(run.triggerData)
    const place = groupId ? await placeOfAdGroup(groupId) : null
    if (!place) continue
    const owner = await ownerOf(place.campaignId)
    used.set(usedKey(kind, owner.key), (used.get(usedKey(kind, owner.key)) ?? 0) + n)
  }

  /** The never-list's facts for one rule's change on one context. */
  async function factsOf(rule: GateRule, kind: StopWasteKind, ctx: unknown, place: PlaceFacts, owner: OwnerFacts): Promise<StopWasteFacts> {
    const p = placeOf(ctx)
    const windowDays = stopWasteParamsOf(rule.actions)?.windowDays ?? STOP_WASTE_DEFAULT_WINDOW_DAYS
    // The window's first day (ending today − 3), orders counted from there to today.
    const from = new Date(dayStart.getTime() - (windowDays - 1 + 3) * DAY)
    const text = (p.text ?? '').trim()
    const marketplace = p.marketplace ?? place.marketplace
    const market = strategyMarket(marketplace) ?? marketplace ?? ''
    if (kind === 'PAUSE_KEYWORD') {
      const t = p.targetId ? await prisma.adTarget.findUnique({ where: { id: p.targetId }, select: { createdAt: true, externalTargetId: true, expressionValue: true, expressionType: true } }) : null
      const keywordText = (t?.expressionValue ?? text).trim()
      const members = owner.root ? await familyOf(owner.root) : []
      const [own, terms, harvest, harvestNegative, funnel, skips] = await Promise.all([
        p.targetId ? prisma.amazonAdsDailyPerformance.aggregate({ where: { entityType: 'AD_TARGET', localEntityId: p.targetId, date: { gte: from } }, _sum: { orders7d: true } }) : Promise.resolve(null),
        t?.externalTargetId ? prisma.amazonAdsSearchTerm.aggregate({ where: { matchedKeywordId: t.externalTargetId, date: { gte: from } }, _sum: { orders7d: true } }) : Promise.resolve(null),
        p.targetId ? prisma.adsBrainHarvest.count({ where: { keywordTargetId: p.targetId, status: { in: ['DONE', 'HALF_DONE'] } } }) : Promise.resolve(0),
        // S10 — Harvest's source negative of this text standing in another of the product's ad groups (any harvest path).
        keywordText && members.length ? prisma.adTarget.count({
          where: {
            isNegative: true, negativeOrigin: 'HARVEST', status: { not: 'ARCHIVED' }, expressionValue: { equals: keywordText, mode: 'insensitive' },
            expressionType: { in: ['NEGATIVE_EXACT', 'EXACT', 'negativeExact'] }, adGroupId: { not: place.adGroupId },
            adGroup: { productAds: { some: { productId: { in: members } } } },
          },
        }) : Promise.resolve(0),
        keywordText ? prisma.adsBrainNegative.count({ where: { action: 'ADD', reasons: { has: 'funnel' }, status: 'WRITTEN', text: { equals: keywordText, mode: 'insensitive' }, ...(marketplace ? { marketplace: market } : {}) } }) : Promise.resolve(0),
        p.targetId ? activeSkips([keywordRowId(p.targetId)], now) : Promise.resolve(new Map()),
      ])
      const hit = keywordText ? protectedTermHit(keywordText, t?.expressionType ?? p.match, await protectionsOf(marketplace, place.campaignId)) : null
      const skip = [...skips.values()][0] ?? null
      return {
        kind, text: keywordText, protectedTerm: hit ? norm(hit.protection.term) : null, noProtectedTerms: false,
        skipped: skip ? { until: skip.until, by: skip.by } : null,
        soldOrders: (own?._sum.orders7d ?? 0) + (terms?._sum.orders7d ?? 0),
        ownKeywordThere: false, harvestDestination: harvest > 0 || harvestNegative > 0, funnelHome: funnel > 0,
        keywordAgeDays: ageDays(t?.createdAt, now), placeAgeDays: ageDays(place.adGroupAt, now), owner: owner.owner, windowDays,
      }
    }
    const list = await protectionsOf(marketplace, place.campaignId)
    const hit = text ? protectedTermHit(text, 'NEGATIVE_EXACT', list) : null
    const rowKey = place.externalAdGroupId && text ? termRowId(market, place.externalAdGroupId, termKeyOf(text)) : null
    const [sold, ownKw, marketProtections, skips] = await Promise.all([
      text ? prisma.amazonAdsSearchTerm.aggregate({ where: { query: { equals: text, mode: 'insensitive' }, date: { gte: from }, adGroupId: place.externalAdGroupId ?? '-' }, _sum: { orders7d: true } }) : Promise.resolve(null),
      text ? prisma.adTarget.count({ where: { isNegative: false, status: { not: 'ARCHIVED' }, expressionValue: { equals: text, mode: 'insensitive' }, adGroupId: place.adGroupId } }) : Promise.resolve(0),
      protectionsOf(marketplace, null),
      rowKey ? activeSkips([rowKey], now) : Promise.resolve(new Map()),
    ])
    const skip = [...skips.values()][0] ?? null
    return {
      kind, text, protectedTerm: hit ? norm(hit.protection.term) : null, noProtectedTerms: marketProtections.length === 0,
      skipped: skip ? { until: skip.until, by: skip.by } : null,
      soldOrders: sold?._sum.orders7d ?? 0, ownKeywordThere: ownKw > 0, harvestDestination: false, funnelHome: false,
      keywordAgeDays: null, placeAgeDays: ageDays(place.adGroupAt, now), owner: owner.owner, windowDays,
    }
  }

  return {
    async split(ruleIds, ctx) {
      const act: string[] = []
      const ask: GateSplit['ask'] = []
      if (!ruleIds.some((id) => autoRules.has(id) || notShaped.has(id))) return { act: [...ruleIds], ask }
      const groupId = await localAdGroup(ctx)
      const place = groupId ? await placeOfAdGroup(groupId) : null
      const owner = place ? await ownerOf(place.campaignId) : null
      const product = owner ? { key: owner.key, name: owner.name } : null
      const mine: Array<{ ruleId: string; key: string; n: number }> = []
      for (const id of ruleIds) {
        if (notShaped.has(id)) { ask.push({ ruleId: id, why: NOT_PAGE_SHAPE }); continue }
        const rule = autoRules.get(id)
        if (!rule) { act.push(id); continue }
        const kind = kindOf.get(id)!
        if (!place || !owner) { ask.push({ ruleId: id, why: 'Nexus cannot tell which ad group this change lands in: it waits for your yes.' }); continue }
        const never = neverListReason(await factsOf(rule, kind, ctx, place, owner))
        // S11 — the cap is reserved with the change: a page rule writes one change per context.
        const key = usedKey(kind, owner.key)
        const cap = never ? null : capReason(kind, used.get(key) ?? 0, owner.name, 1)
        if (never || cap) { ask.push({ ruleId: id, why: (never ?? cap)! }); continue }
        used.set(key, (used.get(key) ?? 0) + 1)
        mine.push({ ruleId: id, key, n: 1 })
        act.push(id)
      }
      if (mine.length && ctx && typeof ctx === 'object') reserved.set(ctx, [...(reserved.get(ctx) ?? []), ...mine])
      return { act, ask, product }
    },
    async count(ctx, results) {
      const mine = ctx && typeof ctx === 'object' ? reserved.get(ctx) ?? [] : []
      if (!mine.length) return
      reserved.delete(ctx as object)
      for (const r of mine) {
        const kind = kindOf.get(r.ruleId)!
        const result = results.find((x) => x.ruleId === r.ruleId)
        const wrote = (result?.actionResults ?? []).reduce((s, a) => s + changesOf(kind, a), 0)
        // Settle the reservation: a change that did not happen gives its place back; one never counts twice.
        used.set(r.key, Math.max(0, (used.get(r.key) ?? 0) - r.n + wrote))
      }
    },
  }
}
