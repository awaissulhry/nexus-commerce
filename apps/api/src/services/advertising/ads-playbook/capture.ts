/**
 * ADS PLAYBOOK PB-2 — capture a template from live campaigns (design report 9 §1.4, §2.1; Owner decision D-PB6: the
 * first template is captured from a product's live set, which is then adopted, never rebuilt). Pure: the campaigns
 * (in the blueprint reader's shape), their hourly plans and the floor targets come in; nothing is read or written here.
 *
 *   slots       each campaign becomes one slot: Auto, a keyword slot (match type × brand / competitor / category, from
 *               the name the campaign carries, else from what its keywords are) or a product-targeting slot; its name
 *               words, bidding strategy, start bid, budget share, placements and, for Auto, its four groups
 *   naming      the campaign names with the product token, the market and the slot words taken out
 *   product     what only this product has: its token, portfolio, daily budget (the sum), base bid (the middle start
 *               bid), and its terms — brand, category (marked exact at start where an Exact slot holds them),
 *               competitor, competitor ASINs, and the negatives every slot carries
 *   rank        the campaigns' hourly plans: the plan that pushes the most hours is `performance`, the plan most of the
 *               other campaigns share is `research` (read both, never one group's copy: a group writes its windows to
 *               every member); campaigns without a plan have no rank role
 *   isolation   which cross-negatives the live set already carries
 *   harvest, phases   the defaults for these slots (defaults.ts): nothing live says them
 *
 * Bids are today's values with the 2¢ floor left out. Under a floor an engine holds (the campaign's, or an ad group's
 * own: an hourly plan's Min-bid window, a stop, a launch at the floor) a bid the floor remembers is read instead: the bid
 * held before the floor, said once per slot. A campaign at the floor with nothing remembered names no start bid: it is
 * asked for. Budget shares add up to exactly 100.
 * Everything uncertain is said in `warnings`; a doc that does not pass the template checks comes back with `problems`.
 */
import {
  autoClauseOf,
  classifyTarget,
  extractBlueprint,
  parameterise,
  PRODUCT_TOKEN,
  type AutoClause,
  type SourceCampaign,
  type SourceFloor,
  type TargetClass,
} from '../../ads-core/ads-blueprint.js'
import { BIDDING_STRATEGIES } from '../../ads-core/ads-blueprint-apply.js'
import { defaultHarvest, defaultPhases } from './defaults.js'
import {
  checkTemplateDoc,
  RANK_WINDOW,
  type ProductTerms,
  type RankRole,
  type RankWindow,
  type Slot,
  type TemplateDoc,
} from './doc.js'

/** The floor every stop and floor launch holds a bid at; a bid at it says nothing about the planned bid. */
const FLOOR_BID_CENTS = 2

export interface CaptureSchedule {
  campaignId: string
  windows: unknown
  defaultTargetKey: string | null
  timezone: string
  targetOverrides: unknown
}

export interface CaptureInput {
  market: string
  /** The product's token in the campaign names ("the name token"): taken out of names, BRAND where a keyword holds it. */
  productToken: string
  /** Rival brand words (a competitor keyword cannot be known from the inside); a well-named campaign says it anyway. */
  competitorTokens?: string[]
  /** The live campaigns in the blueprint reader's shape (ads-blueprint.service.ts loadSourceCampaigns), each with its id. */
  campaigns: Array<{ id: string; source: SourceCampaign }>
  /** The campaigns' hourly plans (AdSchedule rows), one per campaign at most. */
  schedules: readonly CaptureSchedule[]
  /** The RankTarget keys that hold bids at the floor (Min bid). */
  floorTargets: ReadonlySet<string>
  /** The name of the portfolio the campaigns share, if they share one. */
  portfolioName?: string | null
}

export interface CapturedSlot {
  campaignId: string
  campaignName: string
  slotKey: string
  /** The blueprint role its name gives ("Exact-Brand"). */
  role: string
}

export interface CaptureResult {
  doc: TemplateDoc | null
  /** Why `doc` is null: the captured doc does not pass the template checks. */
  problems: string[]
  slots: CapturedSlot[]
  product: {
    nameToken: string
    portfolioName: string | null
    dailyBudgetCents: number | null
    baseBidCents: number | null
    terms: ProductTerms
  }
  warnings: string[]
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lower = (s: string) => s.trim().toLowerCase()
const round2 = (n: number) => Math.round(n * 100) / 100
const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
const top = <T extends string>(counts: Map<T, number>): T | null =>
  [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? null
const count = <T extends string>(values: T[]) => {
  const out = new Map<T, number>()
  for (const v of values) out.set(v, (out.get(v) ?? 0) + 1)
  return out
}
/** A keyword's match type, from either spelling (EXACT, NEGATIVE_EXACT). */
const matchOf = (expressionType: string) => expressionType.toUpperCase().replace(/^NEGATIVE_/, '').replace(/^_/, '')
const isKeyword = (kind: string) => (kind ?? '').toUpperCase() === 'KEYWORD'
const words = (role: string) => role.split('-').filter(Boolean)

const PLACEMENT_KEYS: Record<string, 'top' | 'productPage' | 'restOfSearch'> = {
  PLACEMENT_TOP: 'top', PLACEMENT_PRODUCT_PAGE: 'productPage', PLACEMENT_REST_OF_SEARCH: 'restOfSearch',
}

interface Draft {
  campaignId: string
  campaignName: string
  role: string
  slot: Omit<Slot, 'rankRole'> & { rankRole: Slot['rankRole'] }
  startBidCents: number | null
  dailyBudgetCents: number | null
  placements: { top: number; productPage: number; restOfSearch: number }
  pattern: string | null
  separator: string | null
  positives: Array<{ text: string; match: string; targetClass: TargetClass; kind: string }>
  negatives: Array<{ text: string; match: string }>
}

/** The slot a campaign plays: its targeting, match type and intent, from its name first, else from its keywords. */
export function slotShape(role: string, source: SourceCampaign, positives: Draft['positives'], warnings: string[], name: string) {
  const roleWords = words(role).map((w) => w.toLowerCase())
  const auto = (source.targetingType ?? '').toUpperCase() === 'AUTO' || source.adGroups.some((g) => g.targets.some((t) => !t.isNegative && autoClauseOf(t)))
  if (auto) return { targeting: 'AUTO' as const, intent: 'ANY' as const }
  const keywords = positives.filter((p) => isKeyword(p.kind))
  const products = positives.filter((p) => p.targetClass === 'ASIN')
  if (products.length > keywords.length || (!keywords.length && roleWords.some((w) => ['pat', 'asin', 'product'].includes(w)))) {
    return { targeting: 'PRODUCT' as const, intent: 'ANY' as const }
  }
  const named = (['exact', 'phrase', 'broad'] as const).find((m) => roleWords.includes(m))
  const match = named ? (named.toUpperCase() as 'EXACT' | 'PHRASE' | 'BROAD') : top(count(keywords.map((k) => k.match).filter((m): m is 'EXACT' | 'PHRASE' | 'BROAD' => ['EXACT', 'PHRASE', 'BROAD'].includes(m))))
  const namedIntent = (['brand', 'competitor', 'category'] as const).find((i) => roleWords.includes(i))
  const intent = namedIntent
    ? (namedIntent.toUpperCase() as 'BRAND' | 'COMPETITOR' | 'CATEGORY')
    : top(count(keywords.map((k) => k.targetClass).filter((c): c is 'BRAND' | 'COMPETITOR' | 'CATEGORY' => ['BRAND', 'COMPETITOR', 'CATEGORY'].includes(c)))) ?? 'CATEGORY'
  if (!match) warnings.push(`"${name}": no match type in its name or its keywords; taken as Broad`)
  if (!namedIntent) warnings.push(`"${name}": its name does not say brand, competitor or category; taken as ${intent.toLowerCase()} from its keywords`)
  return { targeting: 'KEYWORD' as const, match: match ?? ('BROAD' as const), intent }
}

/** The naming pattern a campaign name follows once the product token, the market and the slot words are taken out. */
function namePattern(name: string, productToken: string, market: string, parts: string[]): { pattern: string; separator: string } | null {
  const tokenised = parameterise(name, productToken)
  const join = parts.map(escapeRe).join('(\\s*[|\\-_]\\s*|\\s+)')
  const m = new RegExp(`^(.*?)${join}\\s*$`, 'i').exec(tokenised)
  if (!m) return null
  const prefix = m[1]
  const separator = m[2] ?? /(\s*[|\-_]\s*|\s+)$/.exec(prefix)?.[1] ?? ' | '
  const pattern = `${prefix}{parts}`
    .split(PRODUCT_TOKEN).join('{product}')
    .replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(market)}(?=[^A-Za-z0-9]|$)`), `$1{market}`)
  return { pattern, separator }
}

/** An hourly plan's windows in the playbook's shape; windows of the older multiplier kind (no target) are left out. */
function windowsOf(value: unknown): { windows: RankWindow[]; skipped: number } {
  const list = Array.isArray(value) ? value : []
  const windows: RankWindow[] = []
  let skipped = 0
  for (const w of list) {
    const parsed = RANK_WINDOW.safeParse({
      days: (w as Record<string, unknown>)?.days, startHour: (w as Record<string, unknown>)?.startHour,
      endHour: (w as Record<string, unknown>)?.endHour, targetKey: (w as Record<string, unknown>)?.targetKey,
    })
    if (parsed.success) windows.push(parsed.data)
    else skipped++
  }
  return { windows, skipped }
}

const hoursOf = (w: { days: number[]; startHour: number; endHour: number }) =>
  w.days.length * ((w.endHour >= w.startHour ? w.endHour - w.startHour : w.endHour + 24 - w.startHour) + 1)

/**
 * Each slot's share of the daily budget, in percent with one decimal, adding up to exactly 100 (largest remainder: every
 * share rounded down to a tenth, the tenths left over go to the largest remainders, the earlier slot on a tie). A slot
 * without a budget has 0; none with one: all 0.
 */
export function budgetShares(budgetsCents: ReadonlyArray<number | null>): number[] {
  const total = budgetsCents.reduce<number>((sum, b) => sum + (b ?? 0), 0)
  if (!(total > 0)) return budgetsCents.map(() => 0)
  const tenths = budgetsCents.map((b) => Math.floor(((b ?? 0) * 1000) / total))
  const byRemainder = budgetsCents.map((b, i) => ({ i, rest: (b ?? 0) * 1000 - tenths[i] * total })).sort((a, b) => b.rest - a.rest || a.i - b.i)
  const left = 1000 - tenths.reduce((sum, n) => sum + n, 0)
  for (let k = 0; k < left; k++) tenths[byRemainder[k].i]++
  return tenths.map((n) => n / 10)
}

/** Per-campaign RankTarget overrides ({ targetKey: { field: number } }), kept only when they read as numbers. */
function overridesOf(value: unknown): Record<string, Record<string, number>> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, Record<string, number>> = {}
  for (const [key, fields] of Object.entries(value as Record<string, unknown>)) {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) continue
    const numbers = Object.fromEntries(Object.entries(fields as Record<string, unknown>).filter(([, v]) => typeof v === 'number' && Number.isFinite(v)))
    if (Object.keys(numbers).length) out[key] = numbers as Record<string, number>
  }
  return Object.keys(out).length ? out : null
}

export function captureTemplate(input: CaptureInput): CaptureResult {
  const warnings: string[] = []
  const { market, productToken } = input
  const competitorTokens = input.competitorTokens ?? []
  const blueprint = extractBlueprint(input.campaigns.map((c) => c.source), { productToken, competitorTokens })

  // ── Each campaign → one slot ──
  const keySeen = new Map<string, number>()
  const drafts: Draft[] = input.campaigns.map(({ id, source }, i) => {
    const role = blueprint.campaigns[i].role
    if (source.adGroups.length !== 1) warnings.push(`"${source.name}": ${source.adGroups.length} ad groups; a slot has one (the playbook builds one per campaign)`)
    const targets = source.adGroups.flatMap((g) => g.targets)
    const classified = (asRole: string) => targets.filter((t) => !t.isNegative).map((t) => ({
      text: t.expressionValue.trim(), match: matchOf(t.expressionType), kind: t.kind,
      targetClass: classifyTarget(t, productToken, competitorTokens, asRole),
    }))
    const negatives = targets.filter((t) => t.isNegative && isKeyword(t.kind)).map((t) => ({ text: t.expressionValue.trim(), match: matchOf(t.expressionType) }))
    const shape = slotShape(role, source, classified(role), warnings, source.name)
    // A keyword in a brand or competitor slot is that by construction (the product token still makes it brand):
    // classifyTarget reads the intent from a role that starts with it ("Competitor-Exact").
    const positives = shape.targeting === 'KEYWORD' && shape.intent !== 'CATEGORY'
      ? classified(`${shape.intent.charAt(0)}${shape.intent.slice(1).toLowerCase()}-${shape.match}`)
      : classified(role)
    const base = shape.targeting === 'AUTO' ? 'auto' : shape.targeting === 'PRODUCT' ? 'pat' : `${shape.match!.toLowerCase()}-${shape.intent.toLowerCase()}`
    const n = (keySeen.get(base) ?? 0) + 1
    keySeen.set(base, n)
    const key = n === 1 ? base : `${base}-${n}`
    if (n > 1) warnings.push(`"${source.name}" plays the same slot as another campaign (${base}); it is kept as its own slot "${key}"`)

    // The start bid: the middle of today's bids above the floor (keyword, product or auto-group bids), else the ad group's.
    // Under an engine's floor (the campaign's, or the ad group's own) a bid it remembers is read: the bid held before
    // the floor, not the floor.
    const heldBy = new Set<string>()
    let held = 0
    const planned = (floors: Array<SourceFloor | null | undefined>, current: number | null, remembered: number | null | undefined) => {
      const on = floors.filter((f): f is SourceFloor => !!f)
      if (!on.length || typeof remembered !== 'number') return current
      for (const f of on) heldBy.add(f.by ?? 'an unrecorded owner')
      held++
      return remembered
    }
    const bidOf = new Map(source.adGroups.flatMap((g) => g.targets.filter((t) => !t.isNegative).map((t) => [t, planned([g.floor, source.floor], t.bidCents, t.suppressedFromBidCents)] as const)))
    const aboveFloor = (b: number | null | undefined): b is number => typeof b === 'number' && b > FLOOR_BID_CENTS
    const bids = targets.filter((t) => !t.isNegative).map((t) => bidOf.get(t)).filter(aboveFloor)
    const groupBids = source.adGroups.map((g) => planned([g.floor, source.floor], g.defaultBidCents, g.suppressedFromBidCents)).filter(aboveFloor)
    const startBidCents = median(bids) ?? median(groupBids)
    if (held) warnings.push(`"${source.name}": ${held} bid(s) held at the floor; read the bid held before the floor (by ${[...heldBy].join(', ')})`)
    if (startBidCents == null) warnings.push(`"${source.name}": every bid is at the floor (or none is set), so it names no start bid; set its ladder factor by hand`)

    let autoGroups: Slot['autoGroups']
    if (shape.targeting === 'AUTO') {
      autoGroups = {}
      const clauses = new Map<AutoClause, number | null>()
      for (const t of targets) {
        const clause = !t.isNegative ? autoClauseOf(t) : null
        const bid = bidOf.get(t)
        if (clause) clauses.set(clause, aboveFloor(bid) ? bid : null)
      }
      for (const clause of ['CLOSE_MATCH', 'LOOSE_MATCH', 'SUBSTITUTES', 'COMPLEMENTS'] as const) {
        const bid = clauses.get(clause)
        autoGroups[clause] = { on: clauses.has(clause), factor: bid != null && startBidCents ? Math.max(round2(bid / startBidCents), 0.01) : 1 }
      }
    }

    const strategy = (source.biddingStrategy ?? '').toUpperCase()
    const biddingStrategy = (BIDDING_STRATEGIES as readonly string[]).includes(strategy) ? (strategy as Slot['biddingStrategy']) : 'LEGACY_FOR_SALES'
    if (source.biddingStrategy && biddingStrategy !== strategy) warnings.push(`"${source.name}": bidding strategy "${source.biddingStrategy}" is not one Nexus builds with; taken as down only`)

    const placements = { top: 0, productPage: 0, restOfSearch: 0 }
    for (const p of source.placementBidding ?? []) {
      const at = PLACEMENT_KEYS[(p.placement ?? '').toUpperCase()]
      if (at && Number.isFinite(p.percentage)) placements[at] = Math.min(Math.max(Math.round(p.percentage), 0), 900)
    }

    const parts = words(role.replace(/-\d+$/, ''))
    const named = namePattern(source.name, productToken, market, parts)
    const feeds: Slot['feeds'] = shape.targeting === 'PRODUCT' ? ['competitorAsins']
      : shape.targeting === 'AUTO' ? []
        : shape.intent === 'BRAND' ? ['brand']
          : shape.intent === 'COMPETITOR' ? ['competitor']
            : [shape.match === 'EXACT' ? 'categoryExactAtStart' : 'category']
    return {
      campaignId: id,
      campaignName: source.name,
      role,
      slot: {
        key,
        targeting: shape.targeting,
        ...(shape.targeting === 'KEYWORD' ? { match: shape.match } : {}),
        intent: shape.intent,
        rankRole: 'none',
        feeds,
        ...(autoGroups ? { autoGroups } : {}),
        nameParts: parts.length ? parts : [key],
        biddingStrategy,
        optional: shape.intent === 'BRAND',
      },
      startBidCents,
      dailyBudgetCents: typeof source.dailyBudget === 'number' && Number.isFinite(source.dailyBudget) ? Math.round(source.dailyBudget * 100) : null,
      placements,
      pattern: named?.pattern ?? null,
      separator: named?.separator ?? null,
      positives,
      negatives,
    }
  })

  // ── Naming: the pattern most names follow ──
  const patterns = count(drafts.map((d) => (d.pattern ? `${d.pattern}\u0000${d.separator}` : '')).filter(Boolean))
  const chosen = top(patterns)
  const [pattern, partSeparator] = chosen ? chosen.split('\u0000') : ['{product} | {market} | {parts}', ' | ']
  const offPattern = drafts.filter((d) => !d.pattern || `${d.pattern}\u0000${d.separator}` !== chosen)
  if (!chosen) warnings.push('No campaign name ends with its slot words; the naming pattern is the default "{product} | {market} | {parts}"')
  else if (offPattern.length) warnings.push(`${offPattern.length} campaign name(s) follow another pattern than "${pattern}": ${offPattern.map((d) => `"${d.campaignName}"`).join(', ')}`)

  // ── Bids and budget: the base bid is the middle start bid; each slot's start bid is a factor of it ──
  const baseBidCents = median(drafts.map((d) => d.startBidCents).filter((b): b is number => b != null))
  const ladder = Object.fromEntries(drafts.map((d) => [d.slot.key, d.startBidCents != null && baseBidCents ? Math.max(round2(d.startBidCents / baseBidCents), 0.01) : 1]))
  const budgets = drafts.map((d) => d.dailyBudgetCents)
  const total = budgets.reduce<number>((sum, b) => sum + (b ?? 0), 0)
  const shares = budgetShares(budgets)
  const weights = Object.fromEntries(drafts.map((d, i) => [d.slot.key, shares[i]]))
  if (budgets.some((b) => b == null)) warnings.push('A campaign has no daily budget in Nexus; its budget share is 0')

  // ── Rank roles: the campaigns' own hourly plans ──
  const byCampaign = new Map(input.schedules.map((s) => [s.campaignId, s]))
  const plans = new Map<string, { windows: RankWindow[]; baseline: string | null; timezone: string; campaigns: string[]; pushHours: number }>()
  for (const d of drafts) {
    const schedule = byCampaign.get(d.campaignId)
    if (!schedule) continue
    const { windows, skipped } = windowsOf(schedule.windows)
    if (skipped) warnings.push(`"${d.campaignName}": ${skipped} hourly window(s) without a bid target (the older multiplier kind) are left out`)
    if (!windows.length && !schedule.defaultTargetKey) continue
    const id = JSON.stringify([windows, schedule.defaultTargetKey ?? null, schedule.timezone])
    const plan = plans.get(id) ?? {
      windows, baseline: schedule.defaultTargetKey ?? null, timezone: schedule.timezone, campaigns: [],
      pushHours: windows.filter((w) => !input.floorTargets.has(w.targetKey)).reduce((n, w) => n + hoursOf(w), 0),
    }
    plan.campaigns.push(d.campaignId)
    plans.set(id, plan)
  }
  const ordered = [...plans.values()].sort((a, b) => b.pushHours - a.pushHours || b.campaigns.length - a.campaigns.length)
  const roles: Partial<Record<RankRole, (typeof ordered)[number]>> = {}
  if (ordered[0]) roles.performance = ordered[0]
  const rest = ordered.slice(1).sort((a, b) => b.campaigns.length - a.campaigns.length || b.pushHours - a.pushHours)
  if (rest[0]) roles.research = rest[0]
  if (rest.length > 1) {
    const left = rest.slice(1).flatMap((p) => p.campaigns).map((id) => drafts.find((d) => d.campaignId === id)!.campaignName)
    warnings.push(`${rest.length + 1} different hourly plans; a playbook holds two (performance, research). Left without a rank role: ${left.map((n) => `"${n}"`).join(', ')}`)
  }
  const roleOf = new Map<string, RankRole>()
  for (const role of ['performance', 'research'] as const) for (const id of roles[role]?.campaigns ?? []) roleOf.set(id, role)
  for (const d of drafts) d.slot.rankRole = roleOf.get(d.campaignId) ?? 'none'
  const rank: TemplateDoc['rank'] = { roles: {} }
  for (const role of ['performance', 'research'] as const) {
    const plan = roles[role]
    if (!plan) continue
    const slotOverrides = Object.fromEntries(drafts.filter((d) => roleOf.get(d.campaignId) === role).flatMap((d) => {
      const own = overridesOf(byCampaign.get(d.campaignId)?.targetOverrides)
      return own ? [[d.slot.key, own]] : []
    }))
    rank.roles[role] = { windows: plan.windows, baseline: plan.baseline, timezone: plan.timezone, ...(Object.keys(slotOverrides).length ? { slotOverrides } : {}) }
  }
  if (!plans.size) warnings.push('None of these campaigns has an hourly plan: no rank role is captured')

  // ── The product's terms ──
  const keywordSlots = drafts.filter((d) => d.slot.targeting !== 'PRODUCT')
  const brand = new Map<string, string>()
  const category = new Map<string, { text: string; exactAtStart: boolean }>()
  const competitor = new Map<string, string>()
  const asins = new Map<string, string>()
  for (const d of drafts) {
    for (const p of d.positives) {
      if (p.targetClass === 'ASIN' && /^b0[a-z0-9]{8}$/i.test(p.text)) asins.set(lower(p.text), p.text.toUpperCase())
      if (!isKeyword(p.kind) || !p.text) continue
      const k = lower(p.text)
      if (p.targetClass === 'BRAND') brand.set(k, p.text)
      else if (p.targetClass === 'COMPETITOR') competitor.set(k, p.text)
      else if (p.targetClass === 'CATEGORY') {
        const exact = d.slot.targeting === 'KEYWORD' && d.slot.match === 'EXACT'
        const seen = category.get(k)
        category.set(k, { text: seen?.text ?? p.text, exactAtStart: (seen?.exactAtStart ?? false) || exact })
      }
    }
  }
  // A negative every keyword and auto slot carries is the product's own; the others are flows (isolation, harvest).
  const negativeKey = (n: { text: string; match: string }) => `${n.match}|${lower(n.text)}`
  const everywhere = keywordSlots.length
    ? keywordSlots.map((d) => new Set(d.negatives.map(negativeKey))).reduce((a, b) => new Set([...a].filter((k) => b.has(k))))
    : new Set<string>()
  const negatives = [...new Map(keywordSlots.flatMap((d) => d.negatives).filter((n) => everywhere.has(negativeKey(n)) && (n.match === 'EXACT' || n.match === 'PHRASE'))
    .map((n) => [negativeKey(n), { text: n.text, match: n.match as 'EXACT' | 'PHRASE' }])).values()]

  // ── Isolation: what the live set already negates across its slots ──
  const exactTerms = new Set(drafts.filter((d) => d.slot.match === 'EXACT').flatMap((d) => d.positives.filter((p) => isKeyword(p.kind)).map((p) => lower(p.text))))
  const phraseTerms = new Set(drafts.filter((d) => d.slot.match === 'PHRASE').flatMap((d) => d.positives.filter((p) => isKeyword(p.kind)).map((p) => lower(p.text))))
  const holds = (filter: (d: Draft) => boolean, match: string, terms: Set<string>) =>
    drafts.filter(filter).some((d) => d.negatives.some((n) => n.match === match && terms.has(lower(n.text)) && !everywhere.has(negativeKey(n))))
  const research = (d: Draft) => d.slot.targeting === 'AUTO' || (d.slot.targeting === 'KEYWORD' && d.slot.match !== 'EXACT')
  const isolation: TemplateDoc['isolation'] = {
    exactIntoResearch: holds(research, 'EXACT', exactTerms),
    brandPhraseIntoCategoryAndCompetitor: holds((d) => d.slot.intent === 'CATEGORY' || d.slot.intent === 'COMPETITOR', 'PHRASE', new Set(brand.keys())),
    phraseIntoBroadAndAuto: holds((d) => d.slot.targeting === 'AUTO' || d.slot.match === 'BROAD', 'PHRASE', phraseTerms),
  }

  const slots = drafts.map((d) => d.slot as Slot)
  const portfolioName = input.portfolioName?.trim() || null
  const portfolioPattern = portfolioName
    ? parameterise(portfolioName, productToken).split(PRODUCT_TOKEN).join('{product}').replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(market)}(?=[^A-Za-z0-9]|$)`), '$1{market}')
    : '{product} {market}'
  const doc = {
    structure: {
      naming: { pattern, partSeparator },
      portfolio: { pattern: portfolioPattern, mode: portfolioName ? 'reuse-or-create' : 'none' },
      productAds: { fulfilment: 'FBA' },
      sharedTerms: 'skip',
      slots,
    },
    budget: { weights, minPerSlotCents: 100 },
    bids: { ladder, launch: 'floor' },
    placements: Object.fromEntries(drafts.map((d) => [d.slot.key, d.placements])),
    harvest: defaultHarvest(slots),
    isolation,
    rank,
    phases: defaultPhases(slots, weights),
  }
  const checked = checkTemplateDoc(doc)
  warnings.push(
    'Which seller SKU advertises a child with both an FBA and an FBM offer is not read from live: the template says FBA; change it if the live ads use FBM.',
    'Harvest edges and the phase table are the defaults for these slots: nothing live says them.',
  )
  return {
    doc: 'doc' in checked ? checked.doc : null,
    problems: 'problems' in checked ? checked.problems : [],
    slots: drafts.map((d) => ({ campaignId: d.campaignId, campaignName: d.campaignName, slotKey: d.slot.key, role: d.role })),
    product: {
      nameToken: productToken,
      portfolioName,
      dailyBudgetCents: total > 0 ? total : null,
      baseBidCents,
      terms: {
        brand: [...brand.values()],
        category: [...category.values()],
        competitor: [...competitor.values()],
        competitorAsins: [...asins.values()],
        negatives,
      },
    },
    warnings,
  }
}
