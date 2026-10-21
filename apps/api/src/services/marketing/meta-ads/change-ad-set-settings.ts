/**
 * Meta step 18 — set-meta-ad-set as a draft: an ad set's name, goal, billing, budget, spend limits under a campaign
 * budget, bid strategy, bid, ROAS goal, start and end, restart, ad scheduling, pacing, frequency caps, attribution,
 * promoted object, EU payer and beneficiary, regional identities, customer lifecycle goal, creative sequence and rotation,
 * comments, contextual bundling and two SDK-only switches. Master rows AS-040–062, AS-064, AS-065, AS-068–072,
 * AS-074–079, AS-101. ONE request (POST /{ad_set_id}) — two for a restart (its end time, then switching it on). Pure.
 *
 * Meta's rules it follows (checked 2026-10-21, developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/ad-campaign.md (no update table: the create table and Meta's SDK adset.py api_update): budgets only
 *     without a campaign budget; lowering a budget keeps it ≥ 110% of what was spent; lifetime_budget needs end_time;
 *     end_time=0 = ongoing (daily budgets); daily_/lifetime_min_spend_target and _spend_cap only under a campaign budget
 *     of that type; frequency_control_specs "only available in ad sets where REACH and THRUPLAY are the performance goal"
 *     (RECHECK CMP-072 CORRECTED); ad_set_goal (OUTCOME_SALES only, 1870252; never non-broad in a special-category
 *     campaign, 1870261; writes MERGE, so Nexus sends every list that must change); brand_safety_config "limited
 *     availability"; time_based_ad_rotation_* (≥ 2 ranges, the first at the start, the last ≥ 1 h before the end).
 *   - bidding/overview/bid-strategy.md: COST_CAP needs IMPRESSIONS billing and standard pacing; LOWEST_COST_WITH_MIN_ROAS
 *     needs the VALUE goal, takes bid_constraints {roas_average_floor} and never bid_amount; under a campaign budget the
 *     strategy is the campaign's and the floor is per ad set (advantage-campaign-budget.md); removing a ROAS goal under a
 *     campaign budget is impossible (RECHECK AS-051 CORRECTED); without one it is documented (bid-strategy.md "Remove
 *     roas_average_floor from minimum ROAS bidding ad set": bid_strategy=LOWEST_COST_WITHOUT_CAP + bid_constraints={}).
 *   - bidding/overview/pacing-and-scheduling.md: day_parting needs a lifetime budget; blocks on the hour, ≥ 1 hour; off =
 *     pacing_type ["standard"] + adset_schedule [] (RECHECK AS-058 CONFIRMED); under a campaign budget pacing is the
 *     campaign's (CMP-073), so an ad set then sends its schedule only.
 *   - reference/ad-campaign-group.md attribution_spec table: OUTCOME_SALES / CONVERSIONS / PRODUCT_CATALOG_SALES with
 *     OFFSITE_CONVERSIONS — 1-day click, 7-day click, 1-day click + 1-day view, 7-day click + 1-day view; with LINK_CLICKS /
 *     APP_INSTALLS objectives — 1-day or 7-day click; everything else 1-day click only.
 *   - graph-api/reference/ad-promoted-object (master AS-064 / AS-065): an ad set's promoted object is immutable except a
 *     new pixel, pixel rule or event of an OFFSITE_CONVERSIONS ad set of a sales objective, and adding a catalog to an ad
 *     set with none (which may not be removable: no undo).
 *   - best-practices.md "Ad changes triggering ad reviews": optimization goal and billing event edits send every ad back
 *     to review; budget, bid and schedule edits do not.
 *   - product-set-optimization/promoted-products-optimization.md (RECHECK AS-101 CORRECTED): promoted products optimisation
 *     is for Retail Media Network accounts only — answered in words, never sent.
 *   - STILL-UNVERIFIED and sent (Meta's answer decides; LIVE-PROBES): AS-046 daily ⇄ lifetime, AS-053 min/max budget
 *     share, AS-056 restart, AS-062 incremental attribution, AS-078 full-funnel exploration, AS-079 setup state.
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { isOn, money, settingsView, type SettingsRecord } from './change-settings-common.js'
import { promotedBack, promotedMerged, promotedProblem, type MetaBidStrategy, type PromotedObjectAsk } from './change-campaign-settings.js'
import { targetsEu, type LiveAdSet, type LiveCampaign } from './live-settings.js'
import { adSetSpendCapParam, bidAmountMeaning, bidAmountParam, budgetParam, metaUnitsToMinor, MetaUnitError, minSpendTargetParam, roasFloorParam, roasOfFloor, unixSecondsParam } from './settings-units.js'
import { ADSET_CORE_FIELDS } from './live-objects.js'
import { ATTRIBUTION_SPECS, BID_STRATEGIES, BILLING_EVENTS, FREQUENCY_EVENTS, META_NAME_TEXT, META_STRICT_TEXT, typedTextOk, CUSTOMER_LABELS, ENGAGED_LABELS, META_NO_CAP, OPTIMIZATION_GOALS, OPTIMIZATION_SUB_EVENTS, REGIONAL_CATEGORIES, REGIONAL_IDENTITY_KEYS } from '../../gateway/meta-settings-rules.js'

export type AttributionPreset = '1d_click' | '7d_click' | '1d_click_1d_view' | '7d_click_1d_view'
export const ATTRIBUTION_PRESETS: readonly AttributionPreset[] = ['1d_click', '7d_click', '1d_click_1d_view', '7d_click_1d_view']
const PRESET_SPEC: Readonly<Record<AttributionPreset, string>> = {
  '1d_click': ATTRIBUTION_SPECS[0], '7d_click': ATTRIBUTION_SPECS[1], '1d_click_1d_view': ATTRIBUTION_SPECS[2], '7d_click_1d_view': ATTRIBUTION_SPECS[3],
}
export type CustomerGoalType = 'broad' | 'exclude-existing' | 'exclude-existing-and-engaged'
/** Meta's mapping trap (reference/ad-campaign.md "Ad set goal"): 2 excludes existing customers, 1 existing AND engaged. */
const GOAL_TYPE: Readonly<Record<CustomerGoalType, 0 | 1 | 2>> = { broad: 0, 'exclude-existing': 2, 'exclude-existing-and-engaged': 1 }
const GOAL_NAME: Readonly<Record<number, CustomerGoalType>> = { 0: 'broad', 2: 'exclude-existing', 1: 'exclude-existing-and-engaged' }

export interface DaypartBlock { days: number[]; startHour: number; endHour: number; timezone?: 'USER' | 'ADVERTISER' }
export interface FrequencyCapAsk { event?: 'IMPRESSIONS'; intervalDays: number; maxFrequency: number }
export interface CustomerGoalAsk {
  type: CustomerGoalType
  existingCustomerAudienceIds?: string[]
  engagedAudienceIds?: string[]
  existingCustomerLabels?: string[]
  engagedLabels?: string[]
}

export interface AdSetSettingsRequest {
  adSetId: string
  name?: string
  optimizationGoal?: string
  optimizationSubEvent?: string
  billingEvent?: string
  dailyBudgetCents?: number
  lifetimeBudgetCents?: number
  /** Under a campaign budget: 0 removes it. */
  minSpendTargetCents?: number
  /** Under a campaign budget: null removes it. */
  spendCapCents?: number | null
  budgetSharePercent?: { min?: number; max?: number }
  bidStrategy?: MetaBidStrategy
  bidAmountCents?: number
  roasGoal?: number
  removeRoasGoal?: boolean
  startTime?: string
  /** null: no end (daily budgets only). */
  endTime?: string | null
  restart?: boolean
  /** off: ad scheduling off, with the pacing it goes back to (standard unless named; review A9). */
  dayparting?: { off?: boolean; pacing?: 'standard' | 'no_pacing'; blocks?: DaypartBlock[] }
  pacing?: 'standard' | 'no_pacing'
  frequencyCaps?: FrequencyCapAsk[]
  attribution?: AttributionPreset
  incrementalAttribution?: boolean
  promotedObject?: PromotedObjectAsk
  dsa?: { payor: string; beneficiary: string }
  regional?: { categories: string[]; identities: Record<string, string> }
  customerGoal?: CustomerGoalAsk
  creativeSequence?: { adIds: string[]; repetition?: 'FULL_SEQUENCE' | 'LAST_AD' }
  adRotation?: { blocks: Array<{ startTime: string; adIds: string[] }> }
  comments?: 'on' | 'off'
  contextualBundling?: 'OPT_IN' | 'OPT_OUT'
  fullFunnelExploration?: 'NONE_EXPLORATION' | 'LIMITED_EXPLORATION' | 'EXTENDED_EXPLORATION'
  setupState?: 'UNSET' | 'AUTOMATIC' | 'MANUAL'
}

export interface AdSetSettingsLive {
  adSet: LiveAdSet
  campaign: LiveCampaign
  currency: string | null
  /** The ad set's ads (read when a sequence or rotation is asked). */
  ads: string[] | null
  pixels: Set<string> | null
  /** The catalog rule's answer for the catalog / product set the promoted object will name (null: it may; undefined: none named). */
  catalogProblem?: string | null
}

/** Answers in words for what set-meta-ad-set does not send (row AS-101; budget schedules: set-meta-budget-schedule). */
export const AD_SET_NOT_SENT = [
  'Promoted products optimisation (boosting chosen products): Meta offers it to Retail Media Network accounts only — not sent.',
  'Scheduled budget increases: set-meta-budget-schedule.',
]

export function adSetReadsNeeded(request: AdSetSettingsRequest, adSet: LiveAdSet): { ads: boolean; pixels: boolean; catalog: { catalogId: string | null; productSetId: string | null } | null } {
  const merged = request.promotedObject ? promotedMerged(adSet.promotedObject, request.promotedObject) : {}
  return {
    ads: !!(request.creativeSequence || request.adRotation), pixels: !!merged.pixel_id,
    catalog: merged.product_catalog_id || merged.product_set_id ? { catalogId: merged.product_catalog_id ?? null, productSetId: merged.product_set_id ?? null } : null,
  }
}

const SALES_OBJECTIVES = new Set(['OUTCOME_SALES', 'CONVERSIONS', 'PRODUCT_CATALOG_SALES'])
const CLICK_OBJECTIVES = new Set(['OUTCOME_TRAFFIC', 'LINK_CLICKS', 'OUTCOME_APP_PROMOTION', 'APP_INSTALLS'])
const CAPS: ReadonlySet<string> = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'])
/** Fields Meta documents as readable on an ad set (step 6's list): a change of any other is recorded as sent. */
const READABLE: ReadonlySet<string> = new Set(ADSET_CORE_FIELDS.split(',').map((f) => f.replace(/\{.*$/, '')))
const named = (a: LiveAdSet) => `ad set "${a.name ?? 'no name'}" (${a.id})`
const iso = (unix: string | null) => (unix && unix !== '0' ? new Date(Number(unix) * 1000).toISOString() : null)

/** The preset an attribution_spec is, or null (another spec Nexus does not send). */
export function attributionPresetOf(spec: unknown[] | null): AttributionPreset | null {
  if (!spec) return null
  const view = settingsView('attribution_spec', spec.map((s) => {
    const o = (s ?? {}) as Record<string, unknown>
    return { event_type: o.event_type, window_days: o.window_days }
  }))
  return (Object.entries(PRESET_SPEC) as Array<[AttributionPreset, string]>).find(([, v]) => settingsView('attribution_spec', v) === view)?.[0] ?? null
}

/** The attribution presets Meta allows for this objective and goal (its table). */
export function allowedAttribution(objective: string | null, goal: string | null): readonly AttributionPreset[] {
  if (goal === 'OFFSITE_CONVERSIONS' && objective && SALES_OBJECTIVES.has(objective)) return ATTRIBUTION_PRESETS
  if (goal === 'OFFSITE_CONVERSIONS' && objective && CLICK_OBJECTIVES.has(objective)) return ['1d_click', '7d_click']
  return ['1d_click']
}

export function adSetSettingsDraft(request: AdSetSettingsRequest, live: AdSetSettingsLive, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live, now)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function draft(request: AdSetSettingsRequest, live: AdSetSettingsLive, now: Date): MetaChangeDraft | { refusal: string } {
  const a = live.adSet
  const c = live.campaign
  const cur = live.currency
  const who = named(a)
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const noUndo: string[] = []
  const undo: Record<string, unknown> = {}
  const broken = (why: string) => { noUndo.push(why) }
  // Review A6 — a restart switches the ad set on in this same change: it counts as on (its campaign decides).
  const on = request.restart ? isOn(c.status) : isOn(a.status, c.status)
  const spendWord = request.restart
    ? (on ? 'the restart switches it on and its campaign is on, so it spends at once' : 'nothing spends yet: its campaign is not on (the restart switches the ad set on; it spends once the campaign is on)')
    : on ? 'the ad set and its campaign are on, so it can spend more from now' : 'nothing spends yet: the ad set or its campaign is not on (it spends once both are)'
  const cbo = !!(c.dailyBudget || c.lifetimeBudget)
  const cboType: 'daily' | 'lifetime' | null = c.dailyBudget ? 'daily' : c.lifetimeBudget ? 'lifetime' : null
  const nowSec = Math.floor(now.getTime() / 1000)

  const asked = Object.entries(request).filter(([k, v]) => k !== 'adSetId' && v !== undefined)
  if (!asked.length) return { refusal: `Name at least one setting to change for ad set ${request.adSetId}. ${AD_SET_NOT_SENT.join(' ')}` }
  if (a.status === 'DELETED' || a.status === 'ARCHIVED') {
    if (asked.some(([k]) => k !== 'name')) return { refusal: `${who} is ${a.status === 'DELETED' ? 'deleted' : 'archived'}: Meta lets only its name change.` }
  }
  if (c.smartPromotionType === 'AUTOMATED_SHOPPING_ADS' || c.smartPromotionType === 'SMART_APP_PROMOTION') {
    return { refusal: `${who} is in a legacy Advantage+ shopping or app campaign: Meta refuses every edit of these through its API since v25.` }
  }

  // ── name (AS-040), goal (AS-041), sub-event (AS-042), billing (AS-043) ──
  if (request.name !== undefined) {
    if (request.name === a.name) skipped.push(`${who} is already named "${a.name}".`)
    else { params.name = request.name; lines.push(['Name', a.name, request.name]); if (typedTextOk(a.name, META_NAME_TEXT, 400)) undo.name = a.name; else broken(a.name ? 'The old name has characters (or a length) Nexus does not send, so undo cannot put it back.' : 'The ad set had no name to put back.') }
  }
  const goal = request.optimizationGoal ?? a.optimizationGoal
  if (request.optimizationGoal !== undefined && request.optimizationGoal !== a.optimizationGoal) {
    params.optimization_goal = request.optimizationGoal
    lines.push(['Performance goal', a.optimizationGoal, request.optimizationGoal])
    warnings.push(`A new performance goal sends every ad of ${who} back to Meta's review and starts learning again; under a campaign budget Meta refuses it once the campaign's ads have run, and the goals Meta allows depend on the objective (${c.objective ?? 'unknown'}).`)
    if (inList(OPTIMIZATION_GOALS, a.optimizationGoal)) undo.optimizationGoal = a.optimizationGoal; else broken(`The previous goal (${a.optimizationGoal ?? 'unknown'}) is not one Nexus sends.`)
  } else if (request.optimizationGoal !== undefined) skipped.push(`${who}'s goal is already ${a.optimizationGoal}.`)
  if (request.optimizationSubEvent !== undefined) {
    if (request.optimizationSubEvent === (a.optimizationSubEvent ?? 'NONE')) skipped.push(`${who}'s optimisation sub-event is already ${request.optimizationSubEvent}.`)
    else {
      params.optimization_sub_event = request.optimizationSubEvent
      lines.push(['Optimisation sub-event', a.optimizationSubEvent ?? 'NONE', request.optimizationSubEvent])
      if (inList(OPTIMIZATION_SUB_EVENTS, a.optimizationSubEvent ?? 'NONE')) undo.optimizationSubEvent = a.optimizationSubEvent ?? 'NONE'; else broken('The previous sub-event is not one Nexus sends.')
    }
  }
  const billing = request.billingEvent ?? a.billingEvent
  if (request.billingEvent !== undefined) {
    if (request.billingEvent === a.billingEvent) skipped.push(`${who} already pays for ${a.billingEvent}.`)
    else {
      params.billing_event = request.billingEvent
      lines.push(['Pays for (billing event)', a.billingEvent, request.billingEvent])
      warnings.push(`A new billing event sends every ad of ${who} back to Meta's review.`)
      if (inList(BILLING_EVENTS, a.billingEvent)) undo.billingEvent = a.billingEvent; else broken(`The previous billing event (${a.billingEvent ?? 'unknown'}) is not one Nexus sends.`)
    }
  }
  if (params.optimization_goal || params.billing_event) {
    const ok = goal === 'LINK_CLICKS' ? ['LINK_CLICKS', 'IMPRESSIONS'] : goal === 'THRUPLAY' ? ['THRUPLAY', 'IMPRESSIONS'] : ['IMPRESSIONS']
    if (billing && !ok.includes(billing)) warnings.push(`Meta's billing guide pairs the ${goal} goal with ${ok.join(' or ')} billing, not ${billing}: Meta may refuse it.`)
  }

  // ── budget (AS-044, AS-045, AS-046) ──
  if (request.dailyBudgetCents !== undefined && request.lifetimeBudgetCents !== undefined) return { refusal: 'Name a daily or a lifetime budget, not both.' }
  if (request.dailyBudgetCents !== undefined || request.lifetimeBudgetCents !== undefined) {
    if (cbo) return { refusal: `${who} is under a campaign budget: its budget is the campaign's (set-meta-campaign), or a minimum / cap here (minSpendTargetCents, spendCapCents).` }
    const type = request.dailyBudgetCents !== undefined ? 'daily' : 'lifetime'
    const newCents = (type === 'daily' ? request.dailyBudgetCents : request.lifetimeBudgetCents)!
    const oldType: 'daily' | 'lifetime' = a.lifetimeBudget ? 'lifetime' : 'daily'
    const oldCents = metaUnitsToMinor(oldType === 'daily' ? a.dailyBudget : a.lifetimeBudget, cur)
    if (type === 'lifetime' && request.endTime === null) return { refusal: 'A lifetime budget needs an end time.' }
    if (type === 'lifetime' && !a.endTime && request.endTime === undefined) return { refusal: `A lifetime budget needs an end time, and ${who} has none: give endTime with it.` }
    if (oldType === type && oldCents === newCents) skipped.push(`${who}'s ${type} budget is already ${money(newCents, cur)}.`)
    else {
      params[type === 'daily' ? 'daily_budget' : 'lifetime_budget'] = budgetParam(newCents, cur)
      lines.push([`Budget (${type})`, oldCents === null ? 'none' : `${money(oldCents, cur)} ${oldType}`, `${money(newCents, cur)} ${type}`])
      if (oldCents !== null) undo[oldType === 'daily' ? 'dailyBudgetCents' : 'lifetimeBudgetCents'] = oldCents
      else broken('The budget was not readable before.')
      if (oldType === type) {
        if (oldCents !== null && newCents > oldCents) spendsMoney.push(`Raising ${who}'s ${type} budget from ${money(oldCents, cur)} to ${money(newCents, cur)}: ${spendWord}.`)
        if (type === 'lifetime' && oldCents !== null && a.budgetRemaining) {
          const spent = oldCents - (metaUnitsToMinor(a.budgetRemaining, cur) ?? 0)
          if (newCents < Math.ceil(spent * 1.1)) return { refusal: `Meta keeps a lowered budget at least 10% above what was spent: ${who} spent ${money(spent, cur)}, so its lifetime budget can go down to ${money(Math.ceil(spent * 1.1), cur)} at most.` }
        } else if (oldCents !== null && newCents < oldCents) warnings.push('Meta keeps a lowered budget at least 10% above what the ad set spent already; below that it refuses.')
      } else {
        warnings.push(`Switching ${who} from a ${oldType} to a ${type} budget: Meta says a budget type may be adjusted, but not how — Nexus sends the ${type} budget alone and Meta's answer decides.`)
        spendsMoney.push(`A ${type} budget of ${money(newCents, cur)} instead of ${oldCents === null ? 'none' : `${money(oldCents, cur)} ${oldType}`} changes how much ${who} may spend: ${spendWord}.`)
      }
      warnings.push(`Meta allows 4 budget changes of an ad set an hour (then its budget is blocked for an hour) — this change and its undo each count. Every budget change starts learning again.`)
    }
  }

  // ── minimum spend and spend cap under a campaign budget (AS-047, AS-052), budget share (AS-053) ──
  if (request.minSpendTargetCents !== undefined || request.spendCapCents !== undefined) {
    if (!cbo) return { refusal: `${who} has its own budget: a minimum spend or a spend cap is for an ad set under a campaign budget.` }
    const field = cboType === 'daily' ? 'daily' : 'lifetime'
    if (request.minSpendTargetCents !== undefined) {
      const old = metaUnitsToMinor(field === 'daily' ? a.dailyMinSpendTarget : a.lifetimeMinSpendTarget, cur) ?? 0
      if (old === request.minSpendTargetCents) skipped.push(`${who}'s ${field} minimum spend is already ${money(old, cur)}.`)
      else {
        params[`${field}_min_spend_target`] = minSpendTargetParam(request.minSpendTargetCents, cur)
        lines.push([`Minimum spend (${field})`, old ? money(old, cur) : 'none', request.minSpendTargetCents ? money(request.minSpendTargetCents, cur) : 'none (removed)'])
        undo.minSpendTargetCents = old
        if (request.minSpendTargetCents > old) spendsMoney.push(`A ${field} minimum spend of ${money(request.minSpendTargetCents, cur)} steers more of the campaign budget to ${who} (Meta: "best effort"): ${spendWord}.`)
      }
    }
    if (request.spendCapCents !== undefined) {
      const raw = field === 'daily' ? a.dailySpendCap : a.lifetimeSpendCap
      const old = raw && raw !== META_NO_CAP ? metaUnitsToMinor(raw, cur) : null
      if (old === request.spendCapCents) skipped.push(`${who}'s ${field} spend cap is already ${old === null ? 'none' : money(old, cur)}.`)
      else {
        params[`${field}_spend_cap`] = adSetSpendCapParam(request.spendCapCents, cur)
        lines.push([`Spend cap (${field})`, old === null ? 'none' : money(old, cur), request.spendCapCents === null ? 'none (removed)' : money(request.spendCapCents, cur)])
        undo.spendCapCents = old
        if (request.spendCapCents === null || (old !== null && request.spendCapCents > old)) {
          spendsMoney.push(`${request.spendCapCents === null ? 'Removing' : 'Raising'} ${who}'s ${field} spend cap lets more of the campaign budget go to it: ${spendWord}.`)
        }
      }
    }
    warnings.push('Whether a minimum spend or a spend cap counts toward Meta\'s 4 budget changes an hour is not documented.')
  }
  if (request.budgetSharePercent) {
    // AS-053 — STILL-UNVERIFIED: names only on Meta's page (LIVE-PROBES AS-053).
    const { min, max } = request.budgetSharePercent
    if (min === undefined && max === undefined) return { refusal: 'Name a minimum or a maximum budget share.' }
    if (min !== undefined && max !== undefined && min > max) return { refusal: 'The minimum budget share is at most the maximum.' }
    const oldMin = a.minBudgetSpendPercentage === null ? null : Number(a.minBudgetSpendPercentage)
    const oldMax = a.maxBudgetSpendPercentage === null ? null : Number(a.maxBudgetSpendPercentage)
    const back: Record<string, number> = {}
    if (min !== undefined && min !== oldMin) { params.min_budget_spend_percentage = String(min); lines.push(['Minimum budget share %', oldMin, min]); if (oldMin !== null) back.min = oldMin; else broken('The minimum budget share was not readable before.'); if (min > (oldMin ?? 0)) spendsMoney.push(`A minimum budget share of ${min}% may steer more of the campaign budget to ${who} (Meta does not document these fields): ${spendWord}.`) }
    if (max !== undefined && max !== oldMax) { params.max_budget_spend_percentage = String(max); lines.push(['Maximum budget share %', oldMax, max]); if (oldMax !== null) back.max = oldMax; else broken('The maximum budget share was not readable before.'); if (oldMax === null || max > oldMax) spendsMoney.push(`A maximum budget share of ${max}% (from ${oldMax === null ? 'a value Nexus could not read' : `${oldMax}%`}) may let more of the campaign budget go to ${who}: ${spendWord}.`) }
    if (Object.keys(back).length) undo.budgetSharePercent = back
    if (params.min_budget_spend_percentage || params.max_budget_spend_percentage) warnings.push('Meta lists min_budget_spend_percentage and max_budget_spend_percentage by name only; Nexus sends them and Meta\'s answer decides what they do.')
    else skipped.push(`${who}'s budget shares are already so.`)
  }

  // ── bid strategy (AS-048), bid (AS-049), ROAS goal (AS-050, AS-051) ──
  const strategyNow = cbo ? c.bidStrategy : a.bidStrategy
  if (request.roasGoal !== undefined && request.removeRoasGoal) return { refusal: 'Name a ROAS goal or remove it, not both.' }
  let strategy = strategyNow
  if (request.bidStrategy !== undefined) {
    if (cbo) return { refusal: `${who} is under a campaign budget: the bid strategy is the campaign's (set-meta-campaign bidStrategy).` }
    // Review B7 — adset-budget-sharing.md: the bid strategy cannot change mid-flight while ad sets share budget (4834006).
    if (c.budgetSharing === true && request.bidStrategy !== a.bidStrategy) return { refusal: `${who}'s campaign shares budget between its ad sets: Meta refuses a bid strategy change mid-flight then (4834006).` }
    if (request.bidStrategy === a.bidStrategy) skipped.push(`${who}'s bid strategy is already ${a.bidStrategy}.`)
    else {
      if (request.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && request.roasGoal === undefined) return { refusal: 'A ROAS goal strategy needs the minimum ROAS (roasGoal).' }
      if (CAPS.has(request.bidStrategy) && request.bidAmountCents === undefined && !a.bidAmount) return { refusal: `A ${request.bidStrategy} strategy needs the cap (bidAmountCents).` }
      if (request.bidStrategy === 'COST_CAP' && (billing !== 'IMPRESSIONS' || (request.pacing ?? a.pacingType?.[0] ?? 'standard') !== 'standard')) return { refusal: 'A cost cap needs billing on impressions and standard pacing (Meta\'s bid strategy guide).' }
      params.bid_strategy = request.bidStrategy
      lines.push(['Bid strategy', a.bidStrategy, request.bidStrategy])
      strategy = request.bidStrategy
      if (inList(BID_STRATEGIES, a.bidStrategy)) {
        undo.bidStrategy = a.bidStrategy
        if (CAPS.has(a.bidStrategy) && a.bidAmount) undo.bidAmountCents = metaUnitsToMinor(a.bidAmount, cur)
        if (a.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && typeof a.bidConstraints?.roas_average_floor === 'number') undo.roasGoal = roasOfFloor(a.bidConstraints.roas_average_floor)
      } else broken('The bid strategy was not readable before.')
      if (request.bidStrategy === 'LOWEST_COST_WITHOUT_CAP' && a.bidStrategy && a.bidStrategy !== 'LOWEST_COST_WITHOUT_CAP') spendsMoney.push(`Removing ${who}'s ${a.bidStrategy}: without a cap Meta may pay more per result — ${spendWord}.`)
      // Round 2 N1 — as set-meta-campaign: a cap → a ROAS goal removes the cap; a bid cap → a cost cap (even at the same
      // amount) lets single bids go above it (a cost cap is an average).
      if (request.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' && CAPS.has(a.bidStrategy ?? '')) spendsMoney.push(`${who}'s ${a.bidStrategy} is removed for a ROAS goal: Meta then has no ceiling per result — ${spendWord}.`)
      if (request.bidStrategy === 'COST_CAP' && a.bidStrategy === 'LOWEST_COST_WITH_BID_CAP') spendsMoney.push(`From a bid cap to a cost cap for ${who}: Meta keeps the AVERAGE cost near the cap, so single bids may go above it — ${spendWord}.`)
      warnings.push('A bid strategy change starts learning again.')
    }
  }
  if (request.bidAmountCents !== undefined) {
    if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') return { refusal: 'A ROAS goal takes no bid amount (Meta refuses bid_amount with LOWEST_COST_WITH_MIN_ROAS).' }
    if (!CAPS.has(strategy ?? '')) return { refusal: `${who} bids automatically (${strategy ?? 'no cap'}): Meta refuses a bid amount then ("set your bid to automatic", 1885204). Move it to a bid cap or cost cap${cbo ? ' on the campaign' : ''} first.` }
    const old = metaUnitsToMinor(a.bidAmount, cur)
    if (old === request.bidAmountCents && !params.bid_strategy) skipped.push(`${who}'s bid is already ${money(old, cur)}.`)
    else {
      params.bid_amount = bidAmountParam(request.bidAmountCents, cur)
      lines.push([`Bid (${bidAmountMeaning(billing)})`, old === null ? 'none' : money(old, cur), money(request.bidAmountCents, cur)])
      if (old !== null && !params.bid_strategy) undo.bidAmountCents = old
      if (old !== null && request.bidAmountCents > old) spendsMoney.push(`Raising ${who}'s ${strategy === 'COST_CAP' ? 'cost cap' : 'bid cap'} from ${money(old, cur)} to ${money(request.bidAmountCents, cur)} (${bidAmountMeaning(billing)}): ${spendWord}.`)
      warnings.push('A new ad set bid overwrites any bid set on its ads (Meta).')
    }
  }
  if (request.roasGoal !== undefined) {
    const floor = roasFloorParam(request.roasGoal)
    const oldFloor = typeof a.bidConstraints?.roas_average_floor === 'number' ? a.bidConstraints.roas_average_floor : null
    if (cbo && c.bidStrategy !== 'LOWEST_COST_WITH_MIN_ROAS') return { refusal: `${who}'s campaign bids for ${c.bidStrategy ?? 'no ROAS goal'}: under a campaign budget the ROAS goal strategy is the campaign's (set-meta-campaign bidStrategy LOWEST_COST_WITH_MIN_ROAS), the floor each ad set's.` }
    if (!cbo && strategy !== 'LOWEST_COST_WITH_MIN_ROAS') {
      if ((request.optimizationGoal ?? a.optimizationGoal) !== 'VALUE') return { refusal: 'A ROAS goal needs the VALUE performance goal (Meta\'s bid strategy guide).' }
      params.bid_strategy = 'LOWEST_COST_WITH_MIN_ROAS'
      if (!lines.some(([l]) => l === 'Bid strategy')) lines.push(['Bid strategy', a.bidStrategy, 'LOWEST_COST_WITH_MIN_ROAS'])
      // Round 2 N1 — a cap gives way to the ROAS goal: the cap is removed.
      if (CAPS.has(a.bidStrategy ?? '') && !spendsMoney.some((x) => x.includes('is removed for a ROAS goal'))) spendsMoney.push(`${who}'s ${a.bidStrategy} is removed for a ROAS goal: Meta then has no ceiling per result — ${spendWord}.`)
      if (inList(BID_STRATEGIES, a.bidStrategy) && undo.bidStrategy === undefined) undo.bidStrategy = a.bidStrategy
      if (a.bidStrategy && CAPS.has(a.bidStrategy) && a.bidAmount) undo.bidAmountCents = metaUnitsToMinor(a.bidAmount, cur)
    }
    if (oldFloor === floor && !params.bid_strategy) skipped.push(`${who}'s ROAS goal is already ${request.roasGoal}.`)
    else {
      params.bid_constraints = JSON.stringify({ roas_average_floor: floor })
      lines.push(['Minimum ROAS', oldFloor === null ? 'none' : roasOfFloor(oldFloor), request.roasGoal])
      if (oldFloor !== null) undo.roasGoal = roasOfFloor(oldFloor)
      if (oldFloor !== null && floor < oldFloor) spendsMoney.push(`Lowering ${who}'s minimum ROAS from ${roasOfFloor(oldFloor)} to ${request.roasGoal}: Meta may buy results it skipped before — ${spendWord}.`)
      warnings.push('Meta needs the ad account to be allowed ROAS goals (value optimisation); a ROAS goal change starts learning again.')
    }
  }
  if (request.removeRoasGoal) {
    if (strategyNow !== 'LOWEST_COST_WITH_MIN_ROAS') skipped.push(`${who} has no ROAS goal.`)
    else if (cbo) return { refusal: `${who}'s campaign has a ROAS goal under a campaign budget: Meta says "you cannot currently switch to other bid strategies after you create your campaign". Copy it into a new campaign without one.` }
    else {
      // AS-051 without a campaign budget — documented (bid-strategy.md "Remove roas_average_floor from minimum ROAS bidding
      // ad set"): bid_strategy=LOWEST_COST_WITHOUT_CAP + bid_constraints={} (review B2).
      params.bid_strategy = 'LOWEST_COST_WITHOUT_CAP'
      params.bid_constraints = '{}'
      lines.push(['Bid strategy', 'LOWEST_COST_WITH_MIN_ROAS', 'LOWEST_COST_WITHOUT_CAP (no ROAS goal)'])
      spendsMoney.push(`Removing ${who}'s ROAS goal: Meta then buys the most results for the budget whatever their value — ${spendWord}.`)
      warnings.push('Meta\'s bid strategy guide removes a ROAS goal from an ad set with its own budget this way: highest volume and empty bid constraints.')
      undo.bidStrategy = 'LOWEST_COST_WITH_MIN_ROAS'
      if (typeof a.bidConstraints?.roas_average_floor === 'number') undo.roasGoal = roasOfFloor(a.bidConstraints.roas_average_floor)
      else broken('The ROAS goal was not readable before.')
    }
  }

  // ── start, end, restart (AS-054, AS-055, AS-056) ──
  const startNow = a.startTime ? Math.floor(Date.parse(a.startTime) / 1000) : null
  const endNow = a.endTime ? Math.floor(Date.parse(a.endTime) / 1000) : null
  if (request.startTime !== undefined) {
    const start = Number(unixSecondsParam(request.startTime))
    if (start === startNow) skipped.push(`${who} already starts then.`)
    else {
      params.start_time = String(start)
      lines.push(['Starts', a.startTime, iso(String(start))])
      if (a.startTime) undo.startTime = new Date(startNow! * 1000).toISOString(); else broken('The start time was not readable before.')
      // Review A2 — an earlier start is a longer run (and one at or before now starts at once).
      if (startNow === null || start < startNow) spendsMoney.push(`${who} starts ${start <= nowSec ? 'now' : 'earlier'} (${iso(String(start))} instead of ${a.startTime ?? 'no start'}): more days of delivery — ${spendWord}.`)
    }
  }
  let endAsked: number | null | undefined
  if (request.endTime !== undefined) {
    if (request.endTime === null) {
      if (a.lifetimeBudget || params.lifetime_budget) return { refusal: 'An ad set with a lifetime budget needs an end time.' }
      endAsked = null
    } else {
      endAsked = Number(unixSecondsParam(request.endTime))
      if (endAsked <= nowSec) return { refusal: `The end time ${request.endTime} has passed: Meta refuses an end in the past (1487033).` }
      const start = params.start_time ? Number(params.start_time) : startNow
      if (start !== null && endAsked <= start) return { refusal: 'The end time comes after the start time.' }
    }
    if (endAsked === endNow) skipped.push(`${who} already ends then.`)
    else {
      params.end_time = endAsked === null ? '0' : String(endAsked)
      lines.push(['Ends', a.endTime ?? 'no end', endAsked === null ? 'no end (runs on)' : iso(String(endAsked))])
      if (a.endTime && endNow! > nowSec) undo.endTime = new Date(endNow! * 1000).toISOString()
      else if (!a.endTime) undo.endTime = null
      else broken('Its old end time has passed: Meta refuses an end in the past.')
      if (endAsked === null || (endNow !== null && endAsked > endNow)) spendsMoney.push(`${who} runs ${endAsked === null ? 'without an end' : 'longer'}: more days of delivery — ${spendWord}.`)
    }
  }
  // ── ad scheduling (AS-057, AS-058) and pacing (AS-059) ──
  const pacingNow = a.pacingType?.length === 1 ? a.pacingType[0] : a.pacingType?.length ? JSON.stringify(a.pacingType) : 'standard'
  if (request.dayparting) {
    const { off, blocks } = request.dayparting
    if (!!off === !!blocks?.length) return { refusal: 'Dayparting is either off: true or a list of blocks.' }
    if (blocks?.length && request.dayparting.pacing) return { refusal: 'Ad scheduling sets the pacing to day_parting itself: name a pacing only with dayparting off.' }
    if (off) {
      if (pacingNow !== 'day_parting' && !a.adsetSchedule?.length) skipped.push(`${who} has no ad schedule.`)
      else {
        const after = request.dayparting.pacing ?? 'standard'
        // Round 2 N5 — as the pacing path: under a campaign budget pacing is the campaign's; a cost cap needs standard.
        if (request.dayparting.pacing && cbo) return { refusal: `${who} is under a campaign budget: pacing is the campaign's (set-meta-campaign pacing); turn scheduling off without naming a pacing.` }
        if (after === 'no_pacing' && strategy === 'COST_CAP') return { refusal: 'A cost cap needs standard pacing (Meta\'s bid strategy guide).' }
        if (!cbo) params.pacing_type = JSON.stringify([after])
        params.adset_schedule = '[]'
        lines.push(['Ad scheduling', 'on', `off (all day${!cbo && after === 'no_pacing' ? ', accelerated' : ''})`])
        spendsMoney.push(`Without its schedule ${who} delivers at every hour${!cbo && after === 'no_pacing' ? ', as fast as Meta can' : ''}: ${spendWord}.`)
        const back = scheduleBack(a.adsetSchedule)
        if (back) undo.dayparting = { blocks: back }; else broken('The previous schedule was not readable in a shape Nexus sends.')
      }
    } else {
      if (!(cbo ? c.lifetimeBudget : (a.lifetimeBudget || params.lifetime_budget))) return { refusal: 'Ad scheduling needs a lifetime budget (Meta schedules only lifetime budgets; a daily budget\'s increases are set-meta-budget-schedule).' }
      if (cbo && !(c.pacingType ?? []).includes('day_parting')) return { refusal: `${who} is under a campaign budget: pacing is the campaign's — set its pacing to day_parting first (set-meta-campaign pacing).` }
      const spec = blocks!.map((b) => {
        if (!Number.isInteger(b.startHour) || !Number.isInteger(b.endHour) || b.startHour < 0 || b.endHour > 24 || b.endHour <= b.startHour) throw new MetaUnitError('A schedule block starts and ends on a whole hour (0–24), at least one hour long.')
        return { start_minute: b.startHour * 60, end_minute: b.endHour * 60, days: [...new Set(b.days)].sort((x, y) => x - y), timezone_type: b.timezone ?? 'USER' }
      })
      const value = JSON.stringify(spec)
      if (settingsView('adset_schedule', value) === settingsView('adset_schedule', a.adsetSchedule) && pacingNow === 'day_parting') skipped.push(`${who} already has this schedule.`)
      else {
        if (!cbo) params.pacing_type = '["day_parting"]'
        params.adset_schedule = value
        lines.push(['Ad scheduling', a.adsetSchedule?.length ? `${a.adsetSchedule.length} block(s)` : 'off (all day)', `${spec.length} block(s), ${spec[0].timezone_type === 'USER' ? 'in the viewer\'s time zone' : 'in the account\'s time zone'}`])
        const hoursNow = pacingNow === 'day_parting' ? weeklyHours(a.adsetSchedule) : 168
        if (weeklyHours(spec) > hoursNow) spendsMoney.push(`The new schedule lets ${who} deliver ${weeklyHours(spec)} hours a week instead of ${hoursNow}: ${spendWord}.`)
        const back = pacingNow === 'day_parting' ? scheduleBack(a.adsetSchedule) : null
        // Review A9 — the undo turns scheduling off again with the pacing it had (accelerated stays accelerated).
        if (pacingNow === 'day_parting') { if (back) undo.dayparting = { blocks: back }; else broken('The previous schedule was not readable in a shape Nexus sends.') } else undo.dayparting = { off: true, ...(pacingNow === 'no_pacing' ? { pacing: 'no_pacing' } : {}) }
        warnings.push('Ad schedule changes do not send the ads back to review.')
      }
    }
  }
  if (request.pacing !== undefined) {
    if (cbo) return { refusal: `${who} is under a campaign budget: pacing is the campaign's (set-meta-campaign pacing).` }
    if (request.dayparting) return { refusal: 'Dayparting sets the pacing itself: name one of the two.' }
    if (pacingNow === 'day_parting') return { refusal: `${who} has an ad schedule: turn it off (dayparting off) to change its pacing.` }
    if (request.pacing === 'no_pacing' && strategy === 'COST_CAP') return { refusal: 'A cost cap needs standard pacing (Meta\'s bid strategy guide).' }
    if (pacingNow === request.pacing) skipped.push(`${who}'s pacing is already ${request.pacing}.`)
    else {
      params.pacing_type = JSON.stringify([request.pacing])
      lines.push(['Pacing', pacingNow, request.pacing])
      if (request.pacing === 'no_pacing') spendsMoney.push(`Accelerated delivery for ${who}: Meta spends its budget as fast as it can — ${spendWord}.`)
      if (pacingNow === 'standard' || pacingNow === 'no_pacing') undo.pacing = pacingNow; else broken(`The previous pacing (${pacingNow}) is not one Nexus sends.`)
    }
  }

  // ── frequency caps (AS-060): REACH / THRUPLAY goals only ──
  if (request.frequencyCaps) {
    if (goal !== 'REACH' && goal !== 'THRUPLAY') return { refusal: `Meta takes frequency caps only on an ad set whose goal is REACH or THRUPLAY; ${who}'s is ${goal}.` }
    const spec = request.frequencyCaps.map((f) => ({ event: f.event ?? 'IMPRESSIONS', interval_days: f.intervalDays, max_frequency: f.maxFrequency }))
    const value = JSON.stringify(spec)
    if (settingsView('frequency_control_specs', value) === settingsView('frequency_control_specs', a.frequencyControlSpecs ?? [])) skipped.push(`${who}'s frequency caps are already so.`)
    else {
      params.frequency_control_specs = value
      lines.push(['Frequency caps', capsWords(a.frequencyControlSpecs), capsWords(spec)])
      const back = capsBack(a.frequencyControlSpecs)
      if (back) undo.frequencyCaps = back; else broken('The previous frequency caps were not readable in a shape Nexus sends.')
      if (request.frequencyCaps.length === 0 && a.frequencyControlSpecs?.length) spendsMoney.push(`Without a frequency cap Meta may show ${who}'s ads more often: ${spendWord}.`)
      else if (looserCaps(a.frequencyControlSpecs, spec)) spendsMoney.push(`A looser frequency cap lets Meta show ${who}'s ads more often: ${spendWord}.`)
    }
  }

  // ── attribution (AS-061), incremental attribution (AS-062) ──
  if (request.attribution !== undefined) {
    const allowed = allowedAttribution(c.objective, goal)
    if (!allowed.includes(request.attribution)) return { refusal: `Meta allows ${allowed.join(', ')} for a ${c.objective ?? 'campaign'} with the ${goal} goal (its attribution_spec table).` }
    const old = attributionPresetOf(a.attributionSpec)
    if (old === request.attribution) skipped.push(`${who} already optimises on ${request.attribution}.`)
    else {
      params.attribution_spec = PRESET_SPEC[request.attribution]
      lines.push(['Attribution for optimisation', old ?? settingsView('attribution_spec', a.attributionSpec) ?? 'Meta\'s default', request.attribution])
      warnings.push('Meta does not say whether a running ad set may change its attribution or whether that restarts learning: its answer decides. Reports use their own attribution (meta insights).')
      if (old) undo.attribution = old; else broken('The previous attribution was not one of the four Nexus sends.')
    }
  }
  if (request.incrementalAttribution !== undefined) {
    if (request.incrementalAttribution === a.incrementalAttribution) skipped.push(`${who}'s incremental attribution is already ${request.incrementalAttribution ? 'on' : 'off'}.`)
    else {
      params.is_incremental_attribution_enabled = String(request.incrementalAttribution)
      lines.push(['Incremental attribution', a.incrementalAttribution === null ? 'unknown' : a.incrementalAttribution ? 'on' : 'off', request.incrementalAttribution ? 'on' : 'off'])
      warnings.push('Meta lists is_incremental_attribution_enabled as a read field; only its SDK writes it — Meta\'s answer decides.')
      if (a.incrementalAttribution !== null) undo.incrementalAttribution = a.incrementalAttribution; else broken('It was not readable before.')
    }
  }

  // ── promoted object (AS-064, AS-065) ──
  if (request.promotedObject) {
    const ask = request.promotedObject
    const current = a.promotedObject ?? {}
    const merged = promotedMerged(a.promotedObject, ask)
    const changed = Object.keys(merged).filter((k) => settingsView(k, merged[k]) !== settingsView(k, (current as Record<string, unknown>)[k] ?? null))
    const addsCatalog = changed.includes('product_catalog_id') && !current.product_catalog_id
    const eventKeys = new Set(['pixel_id', 'pixel_rule', 'custom_event_type', 'custom_event_str'])
    const other = changed.filter((k) => !eventKeys.has(k) && !(k === 'product_catalog_id' && addsCatalog))
    if (other.length) return { refusal: `Meta keeps an ad set's promoted object as it is (${other.join(', ')} cannot change): only a new pixel, pixel rule or event of a conversions ad set, or a catalog for an ad set without one. Make a new ad set instead.` }
    if (changed.some((k) => eventKeys.has(k)) && !(goal === 'OFFSITE_CONVERSIONS' && c.objective && SALES_OBJECTIVES.has(c.objective))) {
      return { refusal: `Meta lets an ad set's pixel or event change only for a sales campaign with the OFFSITE_CONVERSIONS goal; ${who} has ${goal} in a ${c.objective ?? 'campaign'}. Make a new ad set instead.` }
    }
    const problem = promotedProblem(merged, live)
    if (problem) return { refusal: problem }
    if (!changed.length) skipped.push(`${who}'s promoted object is already so.`)
    else {
      params.promoted_object = JSON.stringify(merged)
      lines.push(['Promoted object', a.promotedObject ? settingsView('promoted_object', a.promotedObject) : 'none', settingsView('promoted_object', params.promoted_object)])
      if (addsCatalog) broken('A catalog added to an ad set may not be removable (Meta documents no way back).')
      else { const back = promotedBack(a.promotedObject); if (back) undo.promotedObject = back; else broken('The previous promoted object holds keys Nexus does not send.') }
      warnings.push('A new pixel event starts learning again.')
    }
  }

  // ── EU payer and beneficiary (AS-068), regional identities (AS-069) ──
  if (request.dsa) {
    if (request.dsa.payor === a.dsaPayor && request.dsa.beneficiary === a.dsaBeneficiary) skipped.push(`${who}'s payer and beneficiary are already so.`)
    else {
      params.dsa_payor = request.dsa.payor
      params.dsa_beneficiary = request.dsa.beneficiary
      lines.push(['EU payer / beneficiary (shown to people in the EU)', `${a.dsaPayor ?? 'none'} / ${a.dsaBeneficiary ?? 'none'}`, `${request.dsa.payor} / ${request.dsa.beneficiary}`])
      if (!targetsEu(a.targetingCountries)) warnings.push(`${who} does not target the EU: Meta does not keep a payer and beneficiary for it.`)
      // Round 2 N3 — only text that passes the same check as a new one goes back (else said).
      if (typedTextOk(a.dsaPayor, META_STRICT_TEXT, 512) && typedTextOk(a.dsaBeneficiary, META_STRICT_TEXT, 512)) undo.dsa = { payor: a.dsaPayor, beneficiary: a.dsaBeneficiary }
      else broken(a.dsaPayor || a.dsaBeneficiary ? 'The old payer or beneficiary has characters (or a length) Nexus does not send, so undo cannot put them back.' : 'There was no payer and beneficiary before: Meta documents no way to clear them.')
    }
  }
  if (request.regional) {
    const value = JSON.stringify(request.regional.categories)
    params.regional_regulated_categories = value
    params.regional_regulation_identities = JSON.stringify(request.regional.identities)
    lines.push(['Regional regulated categories', a.regionalRegulatedCategories?.join(', ') || 'none', request.regional.categories.join(', ') || 'none'])
    warnings.push('Regional categories are for ads shown in Taiwan, Australia, India, Singapore, Thailand, Malaysia or Brazil (not the EU, where the payer and beneficiary apply). Nexus does not check whose these identity ids are: Meta verifies them, and refuses an id that is not a verified identity of this advertiser.')
    if (a.regionalRegulatedCategories?.every((c) => inList(REGIONAL_CATEGORIES, c)) && a.regionalRegulationIdentities && Object.keys(a.regionalRegulationIdentities).length
      && Object.keys(a.regionalRegulationIdentities).every((k) => inList(REGIONAL_IDENTITY_KEYS, k))) {
      undo.regional = { categories: a.regionalRegulatedCategories, identities: Object.fromEntries(Object.entries(a.regionalRegulationIdentities).map(([k, v]) => [k, String(v)])) }
    } else broken('There were no regional identities before: Meta documents no way to clear them.')
  }

  // ── customer lifecycle goal (AS-070, AS-071, AS-072) ──
  if (request.customerGoal) {
    const g = request.customerGoal
    if (c.objective !== 'OUTCOME_SALES') return { refusal: `Meta takes a customer goal only on a Sales (OUTCOME_SALES) ad set; ${who}'s campaign is ${c.objective ?? 'unknown'} (1870252).` }
    // Review B9 — the restricted categories (reference/ad-campaign.md "Ad set goal"): housing, employment, credit, financial
    // products and services, online gambling — not NONE, not political ads.
    const restricted = (c.specialAdCategories ?? []).some((x) => x !== 'NONE' && x !== 'ISSUES_ELECTIONS_POLITICS')
    if (restricted && g.type !== 'broad') return { refusal: `${who}'s campaign is in a restricted special ad category (housing, employment, credit, financial products and services, online gambling): Meta allows only a broad customer goal there (1870261).` }
    const type = GOAL_TYPE[g.type]
    const existing = [...(g.existingCustomerAudienceIds ?? [])]
    const existingLabels = [...(g.existingCustomerLabels ?? [])]
    const engaged = [...(g.engagedAudienceIds ?? [])]
    const engagedLabels = [...(g.engagedLabels ?? [])]
    if (type !== 0 && !existing.length && !existingLabels.length) return { refusal: 'Excluding existing customers needs their audiences (existingCustomerAudienceIds) or labels (existingCustomerLabels).' }
    if (type === 1 && !engaged.length && !engagedLabels.length) return { refusal: 'Excluding engaged customers too needs their audiences (engagedAudienceIds) or labels (engagedLabels).' }
    if (type !== 1 && (engaged.length || engagedLabels.length)) return { refusal: 'Engaged audiences are excluded only with exclude-existing-and-engaged (Meta 1870254).' }
    if (type === 0 && (existing.length || existingLabels.length)) return { refusal: 'A broad goal excludes nobody: name no audiences.' }
    // Meta MERGES a goal: a list left out keeps its value. Nexus sends every list the goal must hold or clear.
    const now = a.adSetGoal ?? {}
    const hasList = (k: string) => Array.isArray(now[k]) && (now[k] as unknown[]).length > 0
    const goalSpec: Record<string, unknown> = { type }
    const set = (k: string, v: string[], allowed: boolean) => { if (allowed) goalSpec[k] = v; else if (hasList(k)) goalSpec[k] = [] }
    set('existing_customers_exclusions', existing, type !== 0)
    set('engaged_audiences_exclusions', engaged, type === 1)
    set('existing_customers_audience_label_exclusions', existingLabels, type !== 0)
    set('engaged_audiences_audience_label_exclusions', engagedLabels, type === 1)
    const value = JSON.stringify(goalSpec)
    const oldType = typeof now.type === 'number' ? now.type : 0
    if (settingsView('ad_set_goal', goalView(now)) === settingsView('ad_set_goal', goalView(goalSpec))) skipped.push(`${who}'s customer goal is already so.`)
    else {
      params.ad_set_goal = value
      lines.push(['Customer goal', GOAL_NAME[oldType] ?? String(oldType), g.type])
      if (type === 0 && oldType !== 0) spendsMoney.push(`A broad customer goal for ${who} shows its ads to existing customers again (a wider audience): ${spendWord}.`)
      else if (type !== 0 && (excludedLess(now, goalSpec) || (oldType === 1 && type === 2))) spendsMoney.push(`${who} excludes fewer people than before (a wider audience): ${spendWord}.`)
      const back = goalBack(a.adSetGoal)
      if (back) undo.customerGoal = back; else broken('The previous customer goal was not readable in a shape Nexus sends.')
    }
  }

  // ── creative sequence (AS-074), rotation by date (AS-075) ──
  if (request.creativeSequence || request.adRotation) {
    if (!live.ads) return { refusal: `Nexus could not read ${who}'s ads.` }
  }
  if (request.creativeSequence) {
    const ids = request.creativeSequence.adIds
    const foreign = ids.filter((id) => !live.ads!.includes(id))
    if (foreign.length) return { refusal: `Not ads of ${who}: ${foreign.join(', ')}.` }
    if (new Set(ids).size !== ids.length) return { refusal: 'Name each ad once in the sequence.' }
    params.creative_sequence = JSON.stringify(ids)
    if (request.creativeSequence.repetition) params.creative_sequence_repetition_pattern = request.creativeSequence.repetition
    lines.push(['Ad sequence', a.creativeSequence?.join(' → ') || 'none', ids.join(' → ') || 'none'])
    warnings.push('Meta refuses to pause or archive an ad that is part of a sequence (pause the ad set instead).')
    // Review A9 — the repetition pattern goes back too (read in its own group; when Meta did not answer it, said).
    undo.creativeSequence = { adIds: a.creativeSequence ?? [], ...(a.sequenceRepetition === 'FULL_SEQUENCE' || a.sequenceRepetition === 'LAST_AD' ? { repetition: a.sequenceRepetition } : {}) }
    if (request.creativeSequence.repetition && !a.sequenceRepetition) broken('The previous repetition pattern was not readable, so undo cannot put it back.')
  }
  if (request.adRotation) {
    const blocks = request.adRotation.blocks
    if (blocks.length < 2) return { refusal: 'Meta rotates ads in at least two date ranges.' }
    const starts = blocks.map((b) => Number(unixSecondsParam(b.startTime)))
    if (starts.some((t, i) => i > 0 && t <= starts[i - 1])) return { refusal: 'The ranges start one after the other.' }
    if (startNow !== null && starts[0] !== startNow) return { refusal: `Meta's first range starts with the ad set (${a.startTime}).` }
    const end = endAsked ?? endNow
    if (!end) return { refusal: 'Rotating ads by date needs an end time: Meta\'s last range ends at least an hour before it.' }
    if (starts[starts.length - 1] > end - 3600) return { refusal: 'Meta\'s last range starts at least an hour before the end.' }
    const foreign = blocks.flatMap((b) => b.adIds).filter((id) => !live.ads!.includes(id))
    if (foreign.length) return { refusal: `Not ads of ${who}: ${[...new Set(foreign)].join(', ')}.` }
    // Ad ids may pass 2^53: written as digits, never through a JS number.
    params.time_based_ad_rotation_id_blocks = `[${blocks.map((b) => `[${b.adIds.join(',')}]`).join(',')}]`
    params.time_based_ad_rotation_intervals = JSON.stringify(starts)
    lines.push(['Ad rotation by date', a.rotationBlocks?.length ? `${a.rotationBlocks.length} ranges` : 'none', `${blocks.length} ranges`])
    const back = rotationBack(a.rotationBlocks, a.rotationIntervals)
    if (back) undo.adRotation = back; else broken('There was no rotation before: Meta documents no way to clear one.')
  }

  // ── comments (AS-076), contextual bundling (AS-077), SDK-only switches (AS-078, AS-079) ──
  if (request.comments) {
    const old = a.brandSafety?.comment_moderation_filter === 'AD_DISABLED' ? 'off' : 'on'
    if (old === request.comments) skipped.push(`${who}'s comments are already ${old}.`)
    else {
      params.brand_safety_config = JSON.stringify({ comment_moderation_filter: request.comments === 'off' ? 'AD_DISABLED' : 'DEFAULT' })
      lines.push(['Comments on its ads', old, request.comments])
      warnings.push('Meta offers the comment switch to some ad accounts only (others get an error); turning comments off hides earlier comments too.')
      undo.comments = old
    }
  }
  if (request.contextualBundling) {
    const old = typeof a.contextualBundling?.status === 'string' ? a.contextualBundling.status : null
    if (old === request.contextualBundling) skipped.push(`${who}'s contextual bundling is already ${old}.`)
    else {
      params.contextual_bundling_spec = JSON.stringify({ status: request.contextualBundling })
      lines.push(['Contextual bundles (Facebook surfaces)', old ?? 'Meta\'s default (not read)', request.contextualBundling])
      if (request.contextualBundling === 'OPT_IN') spendsMoney.push(`Contextual bundles open more Facebook placements to ${who}: ${spendWord}.`)
      if (old === 'OPT_IN' || old === 'OPT_OUT') undo.contextualBundling = old; else broken('Its previous value was not readable.')
    }
  }
  if (request.fullFunnelExploration) {
    if (request.fullFunnelExploration === a.fullFunnelExploration) skipped.push(`${who}'s full-funnel exploration is already ${a.fullFunnelExploration}.`)
    else {
      params.full_funnel_exploration_mode = request.fullFunnelExploration
      lines.push(['Full-funnel exploration', a.fullFunnelExploration ?? 'not read', request.fullFunnelExploration])
      warnings.push('full_funnel_exploration_mode is in Meta\'s SDK only (no page explains it): Nexus sends it and Meta\'s answer decides.')
      const rank = (m: string | null) => ['NONE_EXPLORATION', 'LIMITED_EXPLORATION', 'EXTENDED_EXPLORATION'].indexOf(m ?? 'NONE_EXPLORATION')
      if (rank(request.fullFunnelExploration) > rank(a.fullFunnelExploration)) spendsMoney.push(`More exploration may let Meta reach further for ${who} (Meta does not explain the mode): ${spendWord}.`)
      if (inList(['NONE_EXPLORATION', 'LIMITED_EXPLORATION', 'EXTENDED_EXPLORATION'], a.fullFunnelExploration)) undo.fullFunnelExploration = a.fullFunnelExploration; else broken('Its previous value was not readable.')
    }
  }
  if (request.setupState) {
    if (request.setupState === a.automaticManualState) skipped.push(`${who}'s setup state is already ${a.automaticManualState}.`)
    else {
      params.automatic_manual_state = request.setupState
      lines.push(['Setup (automatic / manual)', a.automaticManualState ?? 'not read', request.setupState])
      warnings.push('automatic_manual_state is listed by name only on Meta\'s page: Nexus sends it and Meta\'s answer decides.')
      if (request.setupState === 'AUTOMATIC') spendsMoney.push(`An automatic setup may let Meta choose more of ${who}'s delivery (Meta does not explain the flag): ${spendWord}.`)
      if (inList(['UNSET', 'AUTOMATIC', 'MANUAL'], a.automaticManualState)) undo.setupState = a.automaticManualState; else broken('Its previous value was not readable.')
    }
  }

  // The first request makes the account spend more only for what came before the restart's own switch-on.
  const firstRaises = spendsMoney.length > 0
  const requests2: MetaChangeRequest[] = []
  if (request.restart) {
    // AS-056 — STILL-UNVERIFIED: the end time first (1487007 until it moves), then the switch-on (LIVE-PROBES AS-056).
    if (!(endNow !== null && endNow <= nowSec)) return { refusal: `${who} has not ended: a restart is for an ad set past its end time (set-meta-status switches a paused one on).` }
    if (!params.end_time || params.end_time === '0' && (a.lifetimeBudget || params.lifetime_budget)) return { refusal: 'A restart needs a new end time in the future (endTime) first: Meta refuses any change of an ended ad set until its end moves (1487007).' }
    noUndo.push('The restart\'s switch-on is undone by set-meta-status (pause it); its old end time has passed, which Meta does not take back.')
    requests2.push({
      step: 2, label: `Switch on ${who} (restart)`, kind: 'adset', objectId: a.id, params: { status: 'ACTIVE' },
      // Meta documents validate_only on campaign changes only; an ad set's status change has no check (LIVE-PROBES ST17-02).
      check: 'none', raisesSpend: true, readBackInPost: false, budget: false, undoable: false,
    })
    spendsMoney.push(c.status === 'ACTIVE'
      ? `Restarting ${who}: switched on with a new end, it delivers and spends at once (its campaign is on).`
      : `Restarting ${who}: switched on with a new end — nothing spends yet, its campaign is not on.`)
    warnings.push('Meta documents moving the end time and switching on, but not a restart as such: Nexus sends the end time, then the switch-on 30 s later (one change of an object every 30 s); the switch-on is never sent if the end time did not change.')
  }

  if (!Object.keys(params).length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  // Review A7 — the times too (judged as Unix seconds): a restart whose end did not move never sends its switch-on.
  const EXPECTED = ['name', 'optimization_goal', 'optimization_sub_event', 'billing_event', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'bid_amount', 'min_budget_spend_percentage', 'dsa_payor', 'dsa_beneficiary', 'start_time', 'end_time']
  const expect: Record<string, string> = Object.fromEntries(Object.entries(params).filter(([k]) => EXPECTED.includes(k)))
  const readFields = Object.keys(params).filter((k) => READABLE.has(k))
  const budget = !!(params.daily_budget || params.lifetime_budget)
  const what = Object.keys(params).map((k) => k.replace(/_/g, ' ')).join(', ')
  const first: MetaChangeRequest = {
    step: 1,
    label: `Change ${who}: ${what}`,
    kind: 'adset',
    objectId: a.id,
    params,
    // Meta documents validate_only on creates and campaign updates only; an ad set update has none (LIVE-PROBES ST17-02).
    check: 'none',
    raisesSpend: firstRaises,
    readBackInPost: false,
    budget,
    undoable: Object.keys(undo).length > 0,
    operation: 'adset.settings',
    expect,
    readBackFields: ['id', ...readFields].join(','),
  }
  const { changes, more } = changeLines(lines)
  const fields = Object.keys(params)
  const before: SettingsRecord = {
    kind: 'adset', id: a.id,
    fields: Object.fromEntries(fields.map((f) => [f, settingsView(f, adSetFieldOf(a, f))])),
    undo: Object.keys(undo).length ? undo : null,
    noUndo,
  }
  const after: SettingsRecord = { kind: 'adset', id: a.id, fields: Object.fromEntries(fields.map((f) => [f, settingsView(f, params[f])])), unread: fields.filter((f) => !READABLE.has(f)) }
  return {
    summary: `Meta: ${first.label}${requests2.length ? '; then switch it on' : ''}.`,
    changes,
    totals: { fields: fields.length, requests: 1 + requests2.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, ...(noUndo.length ? [`No undo for: ${noUndo.join(' ')}`] : [])],
    spendsMoney,
    skipped,
    requests: [first, ...requests2],
    // What moves on its own is not part of it: effective statuses, and the budget left (it falls as the ad set spends; the
    // 110% rule that reads it is judged again when the change runs).
    stands: { adSet: { ...a, effectiveStatus: undefined, budgetRemaining: undefined, unread: undefined }, campaign: { ...c, effectiveStatus: undefined }, ads: live.ads },
    before,
    after,
  }
}

/** An ad set field as Meta sent it (for the record's view). */
function adSetFieldOf(a: LiveAdSet, field: string): unknown {
  const map: Record<string, unknown> = {
    name: a.name, optimization_goal: a.optimizationGoal, optimization_sub_event: a.optimizationSubEvent, billing_event: a.billingEvent,
    daily_budget: a.dailyBudget, lifetime_budget: a.lifetimeBudget, daily_min_spend_target: a.dailyMinSpendTarget, lifetime_min_spend_target: a.lifetimeMinSpendTarget,
    daily_spend_cap: a.dailySpendCap, lifetime_spend_cap: a.lifetimeSpendCap, min_budget_spend_percentage: a.minBudgetSpendPercentage, max_budget_spend_percentage: a.maxBudgetSpendPercentage,
    bid_strategy: a.bidStrategy, bid_amount: a.bidAmount, bid_constraints: a.bidConstraints, start_time: a.startTime, end_time: a.endTime, pacing_type: a.pacingType,
    adset_schedule: a.adsetSchedule, frequency_control_specs: a.frequencyControlSpecs, attribution_spec: a.attributionSpec, is_incremental_attribution_enabled: a.incrementalAttribution,
    promoted_object: a.promotedObject, dsa_payor: a.dsaPayor, dsa_beneficiary: a.dsaBeneficiary, regional_regulated_categories: a.regionalRegulatedCategories,
    regional_regulation_identities: a.regionalRegulationIdentities, ad_set_goal: a.adSetGoal, creative_sequence: a.creativeSequence,
    time_based_ad_rotation_id_blocks: a.rotationBlocks, time_based_ad_rotation_intervals: a.rotationIntervals, brand_safety_config: a.brandSafety,
    contextual_bundling_spec: a.contextualBundling, full_funnel_exploration_mode: a.fullFunnelExploration, automatic_manual_state: a.automaticManualState,
  }
  return map[field] ?? null
}

/** A schedule Meta sent back as set-meta-ad-set dayparting blocks (on the hour only), or null. */
function scheduleBack(schedule: unknown[] | null): DaypartBlock[] | null {
  if (!schedule?.length) return null
  const out: DaypartBlock[] = []
  for (const raw of schedule) {
    const b = (raw ?? {}) as Record<string, unknown>
    const start = Number(b.start_minute)
    const end = Number(b.end_minute)
    const days = Array.isArray(b.days) ? b.days.map(Number) : []
    if (!Number.isInteger(start) || !Number.isInteger(end) || start % 60 || end % 60 || !days.length) return null
    out.push({ days, startHour: start / 60, endHour: end / 60, timezone: b.timezone_type === 'ADVERTISER' ? 'ADVERTISER' : 'USER' })
  }
  return out
}

function capsBack(specs: unknown[] | null): FrequencyCapAsk[] | null {
  if (!specs) return []
  const out: FrequencyCapAsk[] = []
  for (const raw of specs) {
    const s = (raw ?? {}) as Record<string, unknown>
    const event = s.event as FrequencyCapAsk['event']
    // Round 2 N2 — only the events the tool sends (impressions): any other has no undo through it.
    if (!(FREQUENCY_EVENTS as readonly string[]).includes(String(event)) || !Number.isInteger(s.interval_days) || !Number.isInteger(s.max_frequency)) return null
    out.push({ event, intervalDays: s.interval_days as number, maxFrequency: s.max_frequency as number })
  }
  return out
}

const capsWords = (specs: unknown[] | null) => (specs?.length ? specs.map((raw) => { const s = (raw ?? {}) as Record<string, unknown>; return `${s.max_frequency}× per ${s.interval_days} day(s) (${s.event})` }).join('; ') : 'none')

const GOAL_LISTS = ['existing_customers_exclusions', 'engaged_audiences_exclusions', 'existing_customers_audience_label_exclusions', 'engaged_audiences_audience_label_exclusions']
/** A goal with its type and its non-empty lists only (two goals that exclude the same compare the same). */
function goalView(goal: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { type: typeof goal.type === 'number' ? goal.type : 0 }
  for (const k of GOAL_LISTS) if (Array.isArray(goal[k]) && (goal[k] as unknown[]).length) out[k] = [...(goal[k] as unknown[])].map(String).sort()
  return out
}

function goalBack(goal: Record<string, unknown> | null): CustomerGoalAsk | null {
  const g = goal ?? { type: 0 }
  const type = typeof g.type === 'number' ? GOAL_NAME[g.type] : 'broad'
  if (!type) return null
  const list = (k: string) => (Array.isArray(g[k]) ? (g[k] as unknown[]).map(String) : [])
  if (!list(GOAL_LISTS[2]).every((l) => inList(CUSTOMER_LABELS, l)) || !list(GOAL_LISTS[3]).every((l) => inList(ENGAGED_LABELS, l))) return null
  const out: CustomerGoalAsk = { type }
  if (type !== 'broad') {
    if (list(GOAL_LISTS[0]).length) out.existingCustomerAudienceIds = list(GOAL_LISTS[0])
    if (list(GOAL_LISTS[2]).length) out.existingCustomerLabels = list(GOAL_LISTS[2])
  }
  if (type === 'exclude-existing-and-engaged') {
    if (list(GOAL_LISTS[1]).length) out.engagedAudienceIds = list(GOAL_LISTS[1])
    if (list(GOAL_LISTS[3]).length) out.engagedLabels = list(GOAL_LISTS[3])
  }
  return out
}

function rotationBack(blocks: unknown[] | null, intervals: unknown[] | null): { blocks: Array<{ startTime: string; adIds: string[] }> } | null {
  if (!blocks?.length || !intervals?.length || blocks.length !== intervals.length) return null
  const out = blocks.map((b, i) => ({ startTime: new Date(Number(intervals[i]) * 1000).toISOString(), adIds: Array.isArray(b) ? b.map(String) : [] }))
  return out.every((b) => b.adIds.length && Number.isFinite(Date.parse(b.startTime))) ? { blocks: out } : null
}

/** Hours a week a schedule delivers (Meta's blocks, or Nexus's spec). */
function weeklyHours(schedule: unknown[] | null): number {
  if (!schedule?.length) return 0
  return schedule.reduce<number>((n, raw) => {
    const b = (raw ?? {}) as Record<string, unknown>
    const days = Array.isArray(b.days) ? new Set(b.days).size : 0
    return n + Math.max(0, (Number(b.end_minute) - Number(b.start_minute)) / 60) * days
  }, 0)
}

/** Does the new cap let Meta show the ads more often (more impressions per day allowed, or no cap where there was one)? */
function looserCaps(before: unknown[] | null, after: Array<{ event: string; interval_days: number; max_frequency: number }>): boolean {
  const rate = (specs: unknown[] | null) => (specs ?? []).map((raw) => { const s = (raw ?? {}) as Record<string, unknown>; return Number(s.max_frequency) / Number(s.interval_days) }).filter(Number.isFinite)
  const old = rate(before)
  const now = rate(after)
  if (!old.length) return false
  return !now.length || Math.max(...now) > Math.min(...old)
}

/** Does the new goal exclude fewer audiences or labels than the old one (a list that lost an entry)? */
function excludedLess(before: Record<string, unknown>, after: Record<string, unknown>): boolean {
  return GOAL_LISTS.some((k) => {
    const old = Array.isArray(before[k]) ? (before[k] as unknown[]).map(String) : []
    if (!(k in after)) return false
    const now = new Set(Array.isArray(after[k]) ? (after[k] as unknown[]).map(String) : [])
    return old.some((id) => !now.has(id))
  })
}

/** Is a value Meta sent one of the values Nexus sends (so an undo can send it back)? */
const inList = (list: readonly string[], value: unknown): value is string => typeof value === 'string' && list.includes(value)
