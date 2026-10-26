/**
 * Meta step 28 — apply-meta-recommendations as a draft (pure: no reads). Meta applies 14 recommendation types by API
 * (master RC-008…RC-021; overview/performance-recommendations "Recommendation-specific parameters"): ONE request,
 * `POST /act_<id>/recommendations` with the recommendation's signature and `extra_data`. Every other type is answered
 * with the Nexus tool that does the same or Meta's screens (step 8's howToAct).
 *
 * Per type (what Nexus sends, what it can spend, what undo can put back):
 *   ADVANTAGE_PLUS_AUDIENCE, AUTOMATIC_PLACEMENTS     every ad set Meta names; wider delivery → SPENDS MONEY when one is on;
 *                                                     no undo in Nexus yet (putting targeting back is set-meta-targeting's)
 *   PERFORMANT_CREATIVE_REELS_OPT_IN, SHOPS_ADS_SAOFF the ad sets chosen (object_selection); as above
 *   LANDING_PAGE_VIEW_OPTIMIZATION_GOAL               every ad set; Meta's texts differ (a goal change, or a new campaign) →
 *                                                     SPENDS MONEY, only with allowNewObjects: true; undo sets the old goal
 *                                                     (and billing) back and pauses copies Meta made
 *   PRODUCT_SET_BOOSTING                              every ad; wider delivery → SPENDS MONEY when one is on; no undo
 *                                                     (Meta documents no switch back)
 *   CONVERSION_LEADS_OPTIMIZATION                     every ad set; Meta COPIES the ad sets and ads and does not say
 *                                                     whether the copies run → always SPENDS MONEY, and only with
 *                                                     allowNewObjects: true (Nexus's `activate: true`); undo pauses the copies
 *   CREATIVE_FATIGUE                                  the ads chosen; Meta makes new ad variations (Meta's two texts differ:
 *                                                     a copy of the ad, or AI variations) → always SPENDS MONEY, only with
 *                                                     allowNewObjects: true; undo pauses new ads it finds
 * Copies are found by Meta's source field (source_adset_id / source_ad_id) among the account's objects changed since the
 * run started; one with no source is found by its time only and named so in the undo. "On" is the configured status chain
 * (deliversNow).
 *   APLUSC_STANDARD_ENHANCEMENTS_BUNDLE               the ads chosen, EVERY feature named (Nexus sends the opt-ins
 *                                                     explicitly, standard_enhancements always); no undo (a creative's)
 *   AUTOFLOW_OPT_IN, MUSIC, UNCROP_IMAGE              the ads chosen (Nexus always names them); no undo (a creative's)
 *   BACKGROUND_GENERATION                             the ads chosen, OPT_IN or OPT_OUT; undo = the other one, which needs
 *                                                     a recommendation Meta offers again
 *   SCALE_GOOD_CAMPAIGN                               a raise per ad set (no campaign budget) or campaign (campaign
 *                                                     budget), in Meta's budget unit ("cents, 6000 = $60") → SPENDS MONEY;
 *                                                     undo sets the old budgets back
 * Meta has no check (validate_only) for an apply, and its answer is `{"success": true}` — "If it was not successfully
 * applied, your ad objects will remain unchanged". Applying means accepting Meta's terms (the preview says so).
 */
import { CREATIVE_FEATURES, MAX_APPLY_OBJECTS, signatureParam } from '../../gateway/meta-optimize-rules.js'
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { campaignSettingsCheck, money, spendingNow } from './change-settings-common.js'
import { APPLY_BY_API, howToAct } from './live-optimize.js'
import { BILLING_EVENTS, OPTIMIZATION_GOALS } from '../../gateway/meta-settings-rules.js'
import type { ApplyTarget, LiveRecommendation } from './live-optimize-changes.js'
import { budgetParam, metaUnitsToMinor, MetaUnitError } from './settings-units.js'

export type CreativeFeature = typeof CREATIVE_FEATURES[number]

/** What a person asks of apply-meta-recommendations. */
export interface ApplyRequest {
  signature: string
  /** The objects to apply it to (types that take a selection): a subset of the recommendation's; default all of them. */
  objectIds?: string[]
  /** APLUSC_STANDARD_ENHANCEMENTS_BUNDLE: the features each ad opts in to (standard_enhancements always). */
  creativeFeatures?: CreativeFeature[]
  /** BACKGROUND_GENERATION: switch AI backgrounds on or off. */
  backgroundAction?: 'OPT_IN' | 'OPT_OUT'
  /** SCALE_GOOD_CAMPAIGN: the raise per ad set or campaign, in minor units of the account currency. */
  budgetRaises?: Array<{ objectId: string; additionalBudgetCents: number }>
  /**
   * CONVERSION_LEADS_OPTIMIZATION, CREATIVE_FATIGUE, LANDING_PAGE_VIEW_OPTIMIZATION_GOAL: the person accepts that Meta makes
   * new ad sets, ads or a campaign that may start running (Meta does not say) — like `activate: true` on a create: without
   * it Nexus does not apply these.
   */
  allowNewObjects?: boolean
}

type Level = 'adset' | 'ad' | 'campaign' | 'adset-or-campaign'
type Spend = 'wider' | 'copies' | 'new-ads' | 'budget' | 'none'
type UndoKind = 'budgets' | 'goal' | 'background' | 'none'

/**
 * `copies`: Meta may make new objects of this kind (ad sets, ads) whose source is an object applied to: the run finds them
 * by Meta's source field and undo pauses them.
 */
interface TypeRule { level: Level; selection: 'none' | 'optional' | 'required'; spend: Spend; undo: UndoKind; copies?: 'adset' | 'ad'; noUndo?: string; warn: string[] }

const TARGETING_NO_UNDO = 'Putting an ad set back is a change of its own: set-meta-targeting (Advantage+ audience) or set-meta-placements (placements); the record keeps how each ad set was before (Advantage+ audience and placements).'
const CREATIVE_NO_UNDO = 'Meta switches the feature on in each ad\'s creative, and a creative cannot change once made: switching it off again is a new creative with the feature off (create-meta-creative) swapped onto the ad (set-meta-ad), which sends an active ad back to Meta\'s review.'
const LEARNING = 'Meta\'s learning phase may restart for the ad sets it changes.'
const REVIEW = 'Meta may review the changed ads again before they deliver.'

/** The 14 types Meta applies by API, and how Nexus treats each (see the header). */
export const APPLY_TYPES: Readonly<Record<string, TypeRule>> = {
  ADVANTAGE_PLUS_AUDIENCE: { level: 'adset', selection: 'none', spend: 'wider', undo: 'none', noUndo: TARGETING_NO_UNDO, warn: ['Advantage+ audience is one of Meta\'s silent opt-ins: Meta may show these ads beyond the audience each ad set names (its own audience becomes a suggestion).', LEARNING] },
  AUTOMATIC_PLACEMENTS: { level: 'adset', selection: 'none', spend: 'wider', undo: 'none', noUndo: TARGETING_NO_UNDO, warn: ['Advantage+ placements: Meta picks the placements (Facebook, Instagram, Messenger, Audience Network) instead of the ones each ad set names.', LEARNING] },
  PERFORMANT_CREATIVE_REELS_OPT_IN: { level: 'adset', selection: 'optional', spend: 'wider', undo: 'none', noUndo: TARGETING_NO_UNDO, warn: ['Meta adds Facebook and Instagram Reels placements to the ad sets (it skips ad sets on Advantage+ placements).', LEARNING] },
  SHOPS_ADS_SAOFF: { level: 'adset', selection: 'optional', spend: 'wider', undo: 'none', noUndo: 'Meta documents no way to turn a Shops ad set back to website only: Ads Manager.', warn: ['Meta turns the ad sets into Shops ads (website AND shop): some buyers browse and fill a cart inside Facebook or Instagram, checkout stays on the website. It needs a Meta shop with checkout on the website (since v26 Meta also defaults eligible creatives to website and shop).'] },
  // Review B2 — Meta's two texts differ: the parameters say it changes the ad sets' goal, the type table says "Create a
  // campaign with the performance goal of Maximize landing page views" (LIVE-PROBES RC-010). Both are covered: undo puts
  // each goal back AND pauses copies of the ad sets Meta made.
  LANDING_PAGE_VIEW_OPTIMIZATION_GOAL: { level: 'adset', selection: 'none', spend: 'copies', undo: 'goal', copies: 'adset', warn: ['Meta\'s texts differ on this type: its parameters say it changes the ad sets\' performance goal to landing page views, its type table says it makes a campaign with that goal (new objects next to the old ones).', LEARNING, REVIEW] },
  PRODUCT_SET_BOOSTING: { level: 'ad', selection: 'none', spend: 'wider', undo: 'none', noUndo: 'Meta documents no way to switch product set expansion off by API: Ads Manager.', warn: ['Product set expansion: the catalog ads may show products of the whole catalog beyond their product set — including products Nexus has at stock 0. Check stock first (stock-levels).'] },
  CONVERSION_LEADS_OPTIMIZATION: { level: 'adset', selection: 'none', spend: 'copies', undo: 'none', copies: 'adset', warn: ['Meta COPIES the ad sets and their ads with the "maximise conversion leads" goal (lead ads only). The copies are new objects next to the old ones.'] },
  CREATIVE_FATIGUE: { level: 'ad', selection: 'optional', spend: 'new-ads', undo: 'none', copies: 'ad', warn: ['Meta makes new versions of the ads (its texts say a copy of each ad with a new creative, or AI-made creative variations): generated content in the business\'s name — check them in meta-ad-details.', REVIEW] },
  APLUSC_STANDARD_ENHANCEMENTS_BUNDLE: { level: 'ad', selection: 'optional', spend: 'none', undo: 'none', noUndo: CREATIVE_NO_UNDO, warn: ['Advantage+ creative enhancements are silent creative changes: Meta alters each ad\'s image, text or video as it sees fit. Nexus opts in only to the features named below.', REVIEW] },
  AUTOFLOW_OPT_IN: { level: 'ad', selection: 'optional', spend: 'none', undo: 'none', noUndo: CREATIVE_NO_UNDO, warn: ['Standard enhancements (Autoflow): Meta delivers variations of each ad when it expects better results.', REVIEW] },
  MUSIC: { level: 'ad', selection: 'optional', spend: 'none', undo: 'none', noUndo: CREATIVE_NO_UNDO, warn: ['Meta picks and adds music to the ads; Meta\'s Sound Collection Terms apply.', REVIEW] },
  UNCROP_IMAGE: { level: 'ad', selection: 'optional', spend: 'none', undo: 'none', noUndo: CREATIVE_NO_UNDO, warn: ['Meta\'s AI extends the images to fit more placements: generated imagery in the business\'s name (brand risk).', REVIEW] },
  BACKGROUND_GENERATION: { level: 'ad', selection: 'required', spend: 'none', undo: 'background', warn: ['Meta\'s AI makes backgrounds for the product images and shows the version it expects to work best: generated imagery in the business\'s name.', REVIEW] },
  SCALE_GOOD_CAMPAIGN: { level: 'adset-or-campaign', selection: 'none', spend: 'budget', undo: 'budgets', warn: ['Meta raises the budgets by the amounts named. A budget change restarts Meta\'s learning only when it is large.'] },
}

/** The most ads one APLUSC_STANDARD_ENHANCEMENTS_BUNDLE apply names (each with its own feature list). */
export const MAX_FEATURE_ADS = 20

/** Meta's terms of applying (performance-recommendations, first paragraph). */
export const APPLY_TERMS = 'Applying a Meta recommendation means agreeing to Meta\'s Terms of Service, Self-serve Ad Terms, Commercial Terms and Advertising Policies (Meta\'s words on its recommendations page).'

/** The level of objects a type works on (the reads take this kind). */
export const applyLevel = (type: string | null): Level | null => (type && APPLY_TYPES[type] ? APPLY_TYPES[type].level : null)

/**
 * SCALE_GOOD_CAMPAIGN's additional_budget: Meta's budget unit of the account currency ("in cents e.g., 6000 = $60" —
 * the currency's offset unit, like every Meta budget: settings-units.ts budgetParam), from minor units. ONE helper.
 */
export function additionalBudgetParam(cents: number, currency: string | null): number {
  return Number(budgetParam(cents, currency))
}

/** One object as the record keeps it: the fields an apply moves, as Meta sent them (Meta's units). */
export interface ApplyObject { kind: 'campaign' | 'adset' | 'ad'; id: string; name: string | null; fields: Record<string, string | null> }

/** What undo asks of apply-meta-recommendations (its `restore`): the values each object had, in minor units. */
export interface RestoreItem {
  kind: 'campaign' | 'adset' | 'ad'
  id: string
  dailyBudgetCents?: number
  lifetimeBudgetCents?: number
  optimizationGoal?: string
  billingEvent?: string
  /** A copy Meta made: paused. */
  status?: 'PAUSED'
  /** A copy found by its time only (Meta named no source): undo names it so, and a person decides. */
  foundBy?: 'time'
}

/** The record of an apply (AgentChange before / after; undo reads it). */
export interface ApplyRecord {
  type: string
  signature: string
  currency: string | null
  objects: ApplyObject[]
  /** after: the copies an apply made that Nexus found (ad sets or ads), and whether the lists could be read. */
  copies?: Array<{ kind: 'adset' | 'ad'; id: string; name: string | null; status: string | null }>
  copiesUnread?: boolean
  /** before: what undo puts back (null: nothing), and what has no way back, in words. */
  undo?: RestoreItem[] | null
  noUndo?: string[]
}

const who = (t: ApplyTarget) => `${t.kind === 'adset' ? 'ad set' : t.kind} "${t.name ?? t.id}" (${t.id})`
/**
 * Review A2 — can it deliver (spend) now? Its own configured status and every parent's (an ad set with its campaign, an ad
 * with its ad set and campaign: change-settings-common.ts isOn's chain), each ACTIVE — a status not read counts as on (it
 * may be). Effective statuses such as IN_PROCESS, PENDING_REVIEW, WITH_ISSUES or PREAPPROVED under ACTIVE parents deliver.
 */
export const deliversNow = (t: Pick<ApplyTarget, 'kind' | 'status' | 'campaignStatus' | 'adSetStatus'>): boolean =>
  (t.kind === 'campaign' ? [t.status] : t.kind === 'adset' ? [t.status, t.campaignStatus] : [t.status, t.adSetStatus, t.campaignStatus])
    .every((status) => status === null || status === 'ACTIVE')
const isOn = deliversNow
const placementsWords = (p: Record<string, unknown> | null) => (!p ? 'not read' : Object.keys(p).length ? Object.entries(p).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`).join('; ') : 'Advantage+ placements (Meta picks)')

/** The fields of one object an apply of this type moves, as Meta sent them (the record compares and restores exactly these). */
export function applyFields(type: string, t: ApplyTarget): Record<string, string | null> {
  switch (APPLY_TYPES[type]?.undo === 'budgets' ? 'budgets' : type) {
    case 'budgets': return { daily_budget: t.dailyBudget, lifetime_budget: t.lifetimeBudget }
    case 'LANDING_PAGE_VIEW_OPTIMIZATION_GOAL': return { optimization_goal: t.optimizationGoal, billing_event: t.billingEvent }
    case 'ADVANTAGE_PLUS_AUDIENCE': return { advantage_audience: t.advantageAudience === null ? null : String(t.advantageAudience) }
    case 'AUTOMATIC_PLACEMENTS':
    case 'PERFORMANT_CREATIVE_REELS_OPT_IN': return { placements: t.placements ? JSON.stringify(t.placements) : null }
    case 'SHOPS_ADS_SAOFF': return { destination_type: t.destinationType }
    case 'CONVERSION_LEADS_OPTIMIZATION': return { status: t.status }
    default: return t.kind === 'ad' ? { creative_id: t.creativeId } : { status: t.status }
  }
}

export interface ApplyLive {
  recommendation: LiveRecommendation | null
  /** The objects it works on, read now (every one the recommendation names, or the ones chosen). */
  targets: ApplyTarget[]
  currency: string | null
  adAccountId: string
  /** Each ad set's budget changes in the last hour (Meta allows 4; an undo counts). */
  budgetChangesLastHour: Record<string, number>
}

/** The objects an apply of this recommendation works on: the chosen ones (a subset), or every one it names. */
export function applyTargetIds(request: ApplyRequest, recommendation: LiveRecommendation): string[] | { refusal: string } {
  const rule = recommendation.type ? APPLY_TYPES[recommendation.type] : undefined
  if (!rule) return { refusal: notByApi(recommendation) }
  if (rule.undo === 'budgets') {
    const raises = request.budgetRaises ?? []
    if (!raises.length) return { refusal: `A ${recommendation.type} recommendation raises budgets by amounts you name: give budgetRaises (each ad set or campaign it names — ${recommendation.objectIds.join(', ') || 'none named'} — with its additionalBudgetCents). Meta does not say its own amount by API.` }
    const outside = raises.filter((r) => !recommendation.objectIds.includes(r.objectId))
    if (outside.length) return { refusal: `Meta takes only the objects its recommendation names (${recommendation.objectIds.join(', ')}); ${outside.map((r) => r.objectId).join(', ')} ${outside.length === 1 ? 'is' : 'are'} not one of them.` }
    return raises.map((r) => r.objectId)
  }
  if (rule.selection === 'none') {
    // Review A1 — Meta picks the objects: one that names none is never applied ("to 0 ad sets").
    if (!recommendation.objectIds.length) return { refusal: `This ${recommendation.type} recommendation names no object, so Nexus cannot say what Meta would change: it is not applied (read meta-recommendations again, or use the Ads Manager link).` }
    if (request.objectIds?.length) return { refusal: `Meta applies ${recommendation.type} to every object the recommendation names (${plural(recommendation.objectIds.length, 'object')}), with no choice of them: apply it as it is, or change the objects one by one with Nexus's own tools.` }
    if (recommendation.objectIds.length > MAX_APPLY_OBJECTS) return { refusal: `This recommendation names ${recommendation.objectIds.length} objects; Nexus applies one that names at most ${MAX_APPLY_OBJECTS} (each is checked to be the chosen ad account's): use the Ads Manager link.` }
    return [...recommendation.objectIds]
  }
  const chosen = request.objectIds?.length ? [...new Set(request.objectIds)] : [...recommendation.objectIds]
  const outside = chosen.filter((id) => !recommendation.objectIds.includes(id))
  if (outside.length) return { refusal: `Meta takes only the objects its recommendation names (${recommendation.objectIds.join(', ')}); ${outside.join(', ')} ${outside.length === 1 ? 'is' : 'are'} not one of them.` }
  if (!chosen.length) return { refusal: 'This recommendation names no object, so there is nothing to apply it to.' }
  if (chosen.length > MAX_APPLY_OBJECTS) return { refusal: `Name at most ${MAX_APPLY_OBJECTS} objects (objectIds) in one apply; the recommendation names ${chosen.length}.` }
  // Each ad of a creative-feature apply carries its own feature list: 20 keep the request well inside the gateway's length.
  if (recommendation.type === 'APLUSC_STANDARD_ENHANCEMENTS_BUNDLE' && chosen.length > MAX_FEATURE_ADS) return { refusal: `Name at most ${MAX_FEATURE_ADS} ads (objectIds) in one creative-enhancements apply (each carries its feature list); apply the rest in a second request.` }
  return chosen
}

function notByApi(rec: LiveRecommendation): string {
  const how = howToAct(rec.type, true)
  return `Meta does not apply ${rec.type ?? 'this type'} by API. ${how.sentence}${rec.adsManagerUrl ? ` Ads Manager: ${rec.adsManagerUrl}` : ''}`
}

/** The draft of an apply (ONE request) from the live recommendation and its objects. */
export function applyDraft(request: ApplyRequest, live: ApplyLive): MetaChangeDraft | { refusal: string } {
  const rec = live.recommendation
  if (!rec) return { refusal: 'Meta no longer lists a recommendation with this signature for the chosen ad account (signatures go stale; Meta refreshes its recommendations): read meta-recommendations view list again and use the signature it shows now.' }
  const type = rec.type ?? ''
  const rule = APPLY_TYPES[type]
  if (!rule || !APPLY_BY_API[type]) return { refusal: notByApi(rec) }
  const cur = live.currency
  const targets = live.targets
  if (!targets.length) return { refusal: 'Nexus read no object this recommendation works on, so it is not applied.' }
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = [APPLY_TERMS, ...rule.warn]
  const spendsMoney: string[] = []
  const extra: Record<string, string> = {}
  const noUndo: string[] = rule.noUndo ? [rule.noUndo] : []
  let undo: RestoreItem[] | null = null

  if (request.creativeFeatures?.length && type !== 'APLUSC_STANDARD_ENHANCEMENTS_BUNDLE') return { refusal: 'creativeFeatures go with an APLUSC_STANDARD_ENHANCEMENTS_BUNDLE recommendation only.' }
  if (request.backgroundAction && type !== 'BACKGROUND_GENERATION') return { refusal: 'backgroundAction goes with a BACKGROUND_GENERATION recommendation only.' }
  if (request.budgetRaises?.length && rule.undo !== 'budgets') return { refusal: 'budgetRaises go with a SCALE_GOOD_CAMPAIGN recommendation only.' }
  // Nexus makes nothing that may run without a person saying so (born paused, or `activate: true`): Meta's copies are
  // made by Meta, with no word on their status — so the person says it here.
  if ((rule.spend === 'copies' || rule.spend === 'new-ads') && request.allowNewObjects !== true) {
    return { refusal: `Meta makes new ${rule.spend === 'copies' ? 'ad sets and ads (or a campaign)' : 'ads'} for ${type} and does not say whether they start running (Nexus makes nothing that may run unless a person says so): ask again with allowNewObjects: true to accept that — it is SPENDS MONEY, and undo pauses the new ones Nexus finds — or apply it in Ads Manager${rec.adsManagerUrl ? ` (${rec.adsManagerUrl})` : ''}.` }
  }
  if (request.allowNewObjects && rule.spend !== 'copies' && rule.spend !== 'new-ads') return { refusal: 'allowNewObjects goes with CONVERSION_LEADS_OPTIMIZATION, CREATIVE_FATIGUE and LANDING_PAGE_VIEW_OPTIMIZATION_GOAL only (the types where Meta makes new objects).' }

  const ids = targets.map((t) => t.id)
  if (rule.selection !== 'none' || type === 'BACKGROUND_GENERATION') extra.object_selection = ids.join(',')

  switch (type) {
    case 'SCALE_GOOD_CAMPAIGN': {
      const adsets: Array<{ ad_object_id: string; additional_budget: number }> = []
      const campaigns: Array<{ ad_object_id: string; additional_budget: number }> = []
      undo = []
      for (const raise of request.budgetRaises ?? []) {
        const t = targets.find((x) => x.id === raise.objectId)
        if (!t) return { refusal: `${raise.objectId} could not be read.` }
        if (t.kind === 'adset' && t.campaignHasBudget) return { refusal: `${who(t)} is under a campaign budget (Advantage campaign budget): Meta raises the campaign's budget then — name campaign ${t.campaignId}.` }
        if (t.kind === 'campaign' && !t.dailyBudget && !t.lifetimeBudget) return { refusal: `${who(t)} has no campaign budget: Meta raises its ad sets' budgets then — name the ad sets.` }
        const field = t.dailyBudget ? 'daily' : t.lifetimeBudget ? 'lifetime' : null
        if (!field) return { refusal: `${who(t)} has no budget of its own to raise.` }
        let additional: number
        try { additional = additionalBudgetParam(raise.additionalBudgetCents, cur) } catch (err) { if (err instanceof MetaUnitError) return { refusal: err.message }; throw err }
        const nowUnits = field === 'daily' ? t.dailyBudget! : t.lifetimeBudget!
        const fromCents = metaUnitsToMinor(nowUnits, cur)
        const toCents = metaUnitsToMinor(String(Number(nowUnits) + additional), cur)
        lines.push([`${who(t)} ${field} budget`, money(fromCents, cur), `${money(toCents, cur)} (+${money(raise.additionalBudgetCents, cur)})`])
        spendsMoney.push(`A ${field} budget raise of ${money(raise.additionalBudgetCents, cur)} on ${who(t)} (${money(fromCents, cur)} → ${money(toCents, cur)}): ${spendingNow(who(t), isOn(t))}.`)
        ;(t.kind === 'adset' ? adsets : campaigns).push({ ad_object_id: t.id, additional_budget: additional })
        // Review A9 — an undo argument passes the tool's own input (a positive amount of at most 1e11 minor units).
        if (fromCents !== null && fromCents > 0 && fromCents <= 100_000_000_000) undo.push({ kind: t.kind, id: t.id, ...(field === 'daily' ? { dailyBudgetCents: fromCents } : { lifetimeBudgetCents: fromCents }) })
        else noUndo.push(`${who(t)}: its ${field} budget now (${nowUnits} in Meta's unit) is not an amount Nexus can set back.`)
        if (t.kind === 'adset') {
          const used = live.budgetChangesLastHour[t.id] ?? 0
          if (used + 2 > 4) warnings.push(`${who(t)}: its budget changed ${used} time${used === 1 ? '' : 's'} in the last hour; Meta allows 4 an hour per ad set and then blocks its budget for an hour (an undo counts too)${used + 1 > 4 ? ', so Meta may refuse this one now' : ', so this change leaves no room for its undo within the hour'}.`)
        }
      }
      if (adsets.length) extra.adsets = JSON.stringify(adsets)
      if (campaigns.length) extra.campaigns = JSON.stringify(campaigns)
      break
    }
    case 'APLUSC_STANDARD_ENHANCEMENTS_BUNDLE': {
      const features = [...new Set<CreativeFeature>(['standard_enhancements', ...(request.creativeFeatures ?? [])])]
      extra.creative_feature_opt_in_overrides = JSON.stringify(targets.map((t) => ({ ad_id: t.id, opted_in_creative_feature_names: features })))
      lines.push(['Creative features each ad opts in to', 'as each ad has them now', features.join(', ')])
      const off = CREATIVE_FEATURES.filter((f) => !features.includes(f))
      if (off.length) warnings.push(`Not opted in (Nexus names each feature explicitly; Meta may still offer them in Ads Manager): ${off.join(', ')}.`)
      break
    }
    case 'BACKGROUND_GENERATION': {
      if (!request.backgroundAction) return { refusal: 'Say whether AI backgrounds go on or off: backgroundAction OPT_IN or OPT_OUT (Meta needs one).' }
      extra.action_type = request.backgroundAction
      lines.push(['AI backgrounds of the ads', request.backgroundAction === 'OPT_IN' ? 'as now' : 'as now', request.backgroundAction === 'OPT_IN' ? 'on' : 'off'])
      noUndo.push(`Meta switches AI backgrounds ${request.backgroundAction === 'OPT_IN' ? 'off' : 'on'} again only through a BACKGROUND_GENERATION recommendation it offers: when meta-recommendations lists one for these ads, apply it with backgroundAction ${request.backgroundAction === 'OPT_IN' ? 'OPT_OUT' : 'OPT_IN'}.`)
      break
    }
    case 'LANDING_PAGE_VIEW_OPTIMIZATION_GOAL':
      undo = []
      for (const t of targets) {
        lines.push([`${who(t)} performance goal`, t.optimizationGoal ?? 'not read', 'LANDING_PAGE_VIEWS (or a new campaign with it)'])
        if (!t.optimizationGoal || t.optimizationGoal === 'LANDING_PAGE_VIEWS') continue
        // Review A9 — only a goal and billing Nexus's own input takes go into the undo.
        if (!(OPTIMIZATION_GOALS as readonly string[]).includes(t.optimizationGoal)) { noUndo.push(`${who(t)}: its goal ${t.optimizationGoal} is not one Nexus sends, so undo cannot set it back.`); continue }
        if (t.billingEvent && !(BILLING_EVENTS as readonly string[]).includes(t.billingEvent)) { noUndo.push(`${who(t)}: its billing ${t.billingEvent} is not one Nexus sends, so undo cannot set its goal back with it.`); continue }
        undo.push({ kind: 'adset', id: t.id, optimizationGoal: t.optimizationGoal, ...(t.billingEvent ? { billingEvent: t.billingEvent } : {}) })
      }
      if (!undo.length) noUndo.push('No ad set had another goal that Nexus can set back.')
      break
    case 'ADVANTAGE_PLUS_AUDIENCE':
      for (const t of targets) lines.push([`${who(t)} Advantage+ audience`, t.advantageAudience === 1 ? 'on' : t.advantageAudience === 0 ? 'off' : 'not set', 'on'])
      break
    case 'AUTOMATIC_PLACEMENTS':
      for (const t of targets) lines.push([`${who(t)} placements`, placementsWords(t.placements), 'Advantage+ placements (Meta picks)'])
      break
    case 'PERFORMANT_CREATIVE_REELS_OPT_IN':
      for (const t of targets) lines.push([`${who(t)} placements`, placementsWords(t.placements), Object.keys(t.placements ?? {}).length ? 'the same + Facebook and Instagram Reels' : 'unchanged (Advantage+ placements already: Meta skips it)'])
      break
    case 'SHOPS_ADS_SAOFF':
      for (const t of targets) lines.push([`${who(t)} where buyers go`, t.destinationType ?? 'not read', 'website and shop'])
      break
    case 'CONVERSION_LEADS_OPTIMIZATION':
      for (const t of targets) lines.push([`${who(t)}`, 'as it is', 'stays; Meta adds a copy with the conversion-leads goal'])
      break
    default:
      for (const t of targets) lines.push([who(t), 'as it is', APPLY_BY_API[type].what])
  }

  const on = targets.filter(isOn)
  if (rule.spend === 'wider') {
    if (on.length) spendsMoney.push(`It widens where or to whom ${plural(on.length, 'object')} that ${on.length === 1 ? 'is' : 'are'} on deliver (${on.slice(0, 5).map(who).join(', ')}${on.length > 5 ? ', …' : ''}): they can spend more of their budgets from now.`)
    else warnings.push('Nothing spends more yet: none of these objects is on now (it would, once switched on).')
  } else if (rule.spend === 'copies') {
    spendsMoney.push(`Meta may make new objects from ${plural(targets.length, 'ad set')} (copies with their ads, or a campaign) and does not say whether they start running: if they do, they spend their own budgets from now (${on.length ? `${plural(on.length, 'source ad set')} ${on.length === 1 ? 'is' : 'are'} on` : 'the source ad sets are not on'}). Undo pauses the copies Nexus finds.`)
  } else if (rule.spend === 'new-ads') {
    // Review A3 — Meta adds new ads to the ad sets and does not say whether they start ACTIVE: always the person's decision.
    spendsMoney.push(`Meta adds new ads to the ad sets of ${plural(targets.length, 'ad')} and does not say whether they start running: new ads in a running ad set deliver from now (${on.length ? `${plural(on.length, 'ad')} ${on.length === 1 ? 'is' : 'are'} on with ${on.length === 1 ? 'its' : 'their'} ad set and campaign` : 'none of these ads is on with its ad set and campaign now'}). Undo pauses the new ads Nexus finds.`)
  }
  if (rule.copies) noUndo.push(`Undo pauses only the new ${rule.copies === 'adset' ? 'ad sets' : 'ads'} Nexus finds right after the apply whose source Meta names as one of these; one found only by its time is named as such and a person decides; pause any other with set-meta-status.`)
  if (!rule.copies && (rule.undo === 'none' || rule.undo === 'background')) warnings.push(`No undo in Nexus: ${noUndo.join(' ')}`)

  const { changes, more } = changeLines(lines)
  const kind = rule.level === 'adset-or-campaign' ? (targets.some((t) => t.kind === 'campaign') && !targets.some((t) => t.kind === 'adset') ? 'campaign' : 'adset') : rule.level
  const label = `Apply Meta's ${type} recommendation to ${plural(targets.length, kind === 'adset' ? 'ad set' : kind)}`
  const req: MetaChangeRequest = {
    step: 1, label, kind, objectId: `act_${live.adAccountId}`, objectKind: 'adaccount', edge: 'recommendations',
    params: { recommendation_signature: signatureParam(rec.signature), extra_data: JSON.stringify(extra) },
    check: 'none', raisesSpend: spendsMoney.length > 0, readBackInPost: false, budget: false,
    undoable: rule.undo === 'budgets' || rule.undo === 'goal' || !!rule.copies, operation: 'recommendation.apply',
  }
  const objects: ApplyObject[] = targets.map((t) => ({ kind: t.kind, id: t.id, name: t.name, fields: applyFields(type, t) }))
  // What Meta should make of each object (the run replaces it with what Meta reads back; it stands when that read fails).
  const expected: ApplyObject[] = objects.map((o) => {
    const fields = { ...o.fields }
    if (rule.undo === 'budgets') {
      const raise = (JSON.parse(extra.adsets ?? '[]') as Array<{ ad_object_id: string; additional_budget: number }>).concat(JSON.parse(extra.campaigns ?? '[]')).find((r) => r.ad_object_id === o.id)
      const field = fields.daily_budget ? 'daily_budget' : 'lifetime_budget'
      if (raise && fields[field]) fields[field] = String(Number(fields[field]) + raise.additional_budget)
    }
    if (rule.undo === 'goal') fields.optimization_goal = 'LANDING_PAGE_VIEWS'
    return { ...o, fields }
  })
  const before: ApplyRecord = { type, signature: rec.signature, currency: cur, objects, undo: undo?.length ? undo : null, noUndo }
  const after: ApplyRecord = { type, signature: rec.signature, currency: cur, objects: expected }
  return {
    summary: `Meta: ${label}.`,
    changes,
    totals: { requests: 1, objects: targets.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney,
    skipped: [],
    requests: [req],
    stands: { recommendation: { signature: rec.signature, type, objectIds: rec.objectIds }, targets },
    before,
    after,
  }
}

// ── restore: the undo of an earlier apply ─────────────────────────────────────────────────────────────────────────

export interface RestoreLive { targets: ApplyTarget[]; currency: string | null; budgetChangesLastHour: Record<string, number> }

/**
 * The undo of an apply as a draft: each object's recorded budget or goal set back, each copy paused — one request per
 * object, through the same allow-list entries as set-meta-ad-set, set-meta-campaign and set-meta-status (adset.settings,
 * campaign.settings, <kind>.status). What already reads as recorded is skipped. Raising a budget back is SPENDS MONEY.
 */
export function restoreDraft(type: string, items: RestoreItem[], live: RestoreLive): MetaChangeDraft | { refusal: string } {
  const cur = live.currency
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const requests: MetaChangeRequest[] = []
  const restored: ApplyObject[] = []
  const before: ApplyObject[] = []
  for (const item of items) {
    const t = live.targets.find((x) => x.id === item.id && x.kind === item.kind)
    if (!t) return { refusal: `${item.kind} ${item.id} could not be read now.` }
    const params: Record<string, string> = {}
    let operation = `${t.kind}.settings`
    let budget = false
    if (item.status === 'PAUSED') {
      if (t.status === 'PAUSED' || t.status === 'ARCHIVED' || t.status === 'DELETED') { skipped.push(`${who(t)} is ${t.status?.toLowerCase()} already.`); continue }
      params.status = 'PAUSED'
      operation = `${t.kind}.status`
      lines.push([`${who(t)} status`, t.status, item.foundBy === 'time' ? 'PAUSED (found by its time only)' : 'PAUSED'])
      // Review A4 — Meta named no source for it: it may be one a person made by hand at the same moment.
      if (item.foundBy === 'time') warnings.push(`${who(t)} was found by its time only: Meta names no source for it, so Nexus is not sure the apply made it (a person may have made it by hand at the same moment). Leave it out (undo-change asks for all; set-meta-status pauses one by one) if it is not a copy.`)
    }
    for (const [field, cents] of [['daily_budget', item.dailyBudgetCents], ['lifetime_budget', item.lifetimeBudgetCents]] as const) {
      if (cents === undefined) continue
      const now = field === 'daily_budget' ? t.dailyBudget : t.lifetimeBudget
      let value: string
      try { value = budgetParam(cents, cur) } catch (err) { if (err instanceof MetaUnitError) return { refusal: err.message }; throw err }
      if (now === value) { skipped.push(`${who(t)} ${field.replace('_', ' ')} is ${money(cents, cur)} already.`); continue }
      if (!now) return { refusal: `${who(t)} has no ${field.replace('_', ' ')} now (it was changed another way since): set it with ${t.kind === 'adset' ? 'set-meta-ad-set' : 'set-meta-campaign'}.` }
      params[field] = value
      budget = t.kind === 'adset'
      const nowCents = metaUnitsToMinor(now, cur)
      lines.push([`${who(t)} ${field.replace('_', ' ')}`, money(nowCents, cur), money(cents, cur)])
      // Review A6 — an undo only lowers a budget back: one that would RAISE it (moved since, or a record not Nexus's own) is
      // refused; a raise is set-meta-ad-set / set-meta-campaign's, with its own SPENDS MONEY.
      if (nowCents === null || cents > nowCents) return { refusal: `${who(t)}: putting its ${field.replace('_', ' ')} back to ${money(cents, cur)} would raise it (it is ${money(nowCents, cur)} now): an undo only lowers a budget back. Raise it with ${t.kind === 'adset' ? 'set-meta-ad-set' : 'set-meta-campaign'} if that is meant (SPENDS MONEY).` }
      if (budget) {
        const used = live.budgetChangesLastHour[t.id] ?? 0
        if (used + 1 > 4) warnings.push(`${who(t)}: its budget changed ${used} times in the last hour; Meta allows 4 an hour per ad set, so Meta may refuse this one now.`)
      }
    }
    if (item.optimizationGoal && item.optimizationGoal !== t.optimizationGoal) {
      params.optimization_goal = item.optimizationGoal
      lines.push([`${who(t)} performance goal`, t.optimizationGoal, item.optimizationGoal])
      if (item.billingEvent && item.billingEvent !== t.billingEvent) { params.billing_event = item.billingEvent; lines.push([`${who(t)} billing`, t.billingEvent, item.billingEvent]) }
      warnings.push(`${who(t)}: a goal change restarts Meta's learning and sends its ads back to review; Meta may refuse it for a running ad set (its answer decides).`)
    } else if (item.optimizationGoal) skipped.push(`${who(t)} has the goal ${item.optimizationGoal} already.`)
    if (!Object.keys(params).length) continue
    if (params.status && Object.keys(params).length > 1) return { refusal: 'A restore item either pauses a copy or puts settings back, not both.' }
    const fields = Object.keys(params)
    requests.push({
      step: requests.length + 1, label: `${params.status ? 'Pause' : 'Put back'} ${who(t)}`, kind: t.kind, objectId: t.id, params,
      // Meta documents its check on campaign updates only (Nexus uses it once LIVE-PROBE ST18-03 proves it).
      check: t.kind === 'campaign' && !params.status ? campaignSettingsCheck() : 'none', raisesSpend: false, readBackInPost: false, budget, undoable: false, operation,
      ...(params.status ? {} : { expect: { ...params }, readBackFields: ['id', ...fields].join(',') }),
    })
    before.push({ kind: t.kind, id: t.id, name: t.name, fields: Object.fromEntries(fields.map((f) => [f, f === 'status' ? t.status : f === 'daily_budget' ? t.dailyBudget : f === 'lifetime_budget' ? t.lifetimeBudget : f === 'optimization_goal' ? t.optimizationGoal : t.billingEvent])) })
    restored.push({ kind: t.kind, id: t.id, name: t.name, fields: { ...params } })
  }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Meta: undo of an applied ${type} recommendation — ${plural(requests.length, 'object')} put back.`,
    changes,
    totals: { requests: requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'Meta has no "un-apply": Nexus puts back what it recorded, object by object (Meta has no check for an ad set or a status change).'],
    spendsMoney,
    skipped,
    requests,
    stands: { targets: live.targets },
    before: { type, signature: '', currency: cur, objects: before } satisfies ApplyRecord,
    after: { type, signature: '', currency: cur, objects: restored } satisfies ApplyRecord,
  }
}
