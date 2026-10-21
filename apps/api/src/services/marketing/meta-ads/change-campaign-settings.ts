/**
 * Meta step 18 — set-meta-campaign as a draft: a campaign's name, budget (amount, daily ⇄ lifetime, campaign budget on or
 * off), ad set budget sharing (off only), bid strategy (with each ad set's cap), spend cap, special ad category, promoted
 * object, objective (empty campaigns only), pacing and the reels-trending flag. Master rows CMP-034, 036–039, 041–046,
 * 062–064, 067, 068, 071–073, 075. ONE request: POST /{campaign_id} with the fields that change. Pure: the request and the
 * live state (live-settings.ts) in, the draft (or a refusal in words) out.
 *
 * Meta's rules it follows (checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/ad-campaign-group.md "Updating" (fields, adset_budgets "all the non-deleted child adset IDs", adset_bid_amounts
 *     "required in the process of toggling campaign from autobid to manual bid", spend_cap minimum ≈ USD 100 and the
 *     922337203685478 removal, "budget at the campaign level or at the adset level, not both"); start_time / stop_time
 *     are READ ONLY on a campaign ("You can setup start_time at the ad set level") — RECHECK CMP-064 CORRECTED.
 *   - bidding/guides/advantage-campaign-budget.md: campaigns with more than 70 ad sets cannot turn campaign budget off or
 *     change bid strategy; "For LOWEST_COST_WITH_MIN_ROAS, you cannot currently switch to other bid strategies after you
 *     create your campaign" (RECHECK AS-051 CORRECTED: no way back); pacing_type "in the campaign level" when campaign
 *     budget is on (CMP-073 CONFIRMED); only turning campaign budget OFF is documented — turning it ON for a running
 *     campaign is STILL-UNVERIFIED (CMP-039): Nexus sends it and Meta's answer decides (LIVE-PROBES).
 *   - bidding/guides/adset-budget-sharing.md: is_adset_budget_sharing_enabled can be turned off mid-flight, never on again
 *     (3858418) — no undo (CMP-041); the bid strategy cannot change mid-flight while it is on (4834006).
 *   - bidding/overview/pacing-and-scheduling.md: day_parting needs a lifetime budget; no_pacing spends faster.
 *   - audiences/special-ad-category (facts F1 X7): special_ad_category (singular, update) + special_ad_category_country;
 *     moving a campaign into a restricted category resets every ad set's customer lifecycle goal to broad;
 *     ISSUES_ELECTIONS_POLITICS is never sent (banned in the EU since 2025-10-06; PLAN.md).
 *   - marketing-api/advantage-campaigns (facts F1 M3b-05): moving budgets to the ad sets turns an Advantage+ sales
 *     campaign's advantage_state to DISABLED without a warning — the preview says so.
 *   - Rows answered in words, not sent: CMP-064 (times are the ad set's: set-meta-ad-set startTime / endTime), CMP-072
 *     (frequency caps are an ad set's, REACH / THRUPLAY goals only: set-meta-ad-set frequencyCaps), CMP-067
 *     (iterative_split_test_configs: Meta documents no shape; A/B tests are Meta studies, their own tool), CMP-068
 *     (smart_promotion_type: writing GUIDED_CREATION does not make a campaign Advantage+), CMP-075
 *     (budget_rebalance_flag: "deprecated on Marketing API v7.0"). CMP-063 (objective) only on a campaign with no ad set
 *     (Meta does not document what happens to running ad sets — STILL-UNVERIFIED, LIVE-PROBES). CMP-037 (daily ⇄ lifetime)
 *     and CMP-071 (reels trending ads) are STILL-UNVERIFIED: sent, and Meta's answer decides (LIVE-PROBES).
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { campaignSettingsCheck, isOn, money, settingsView, type SettingsRecord } from './change-settings-common.js'
import type { LiveCampaign, LiveChildAdSet } from './live-settings.js'
import { bidAmountParam, budgetParam, campaignSpendCapParam, metaUnitsToMinor, MetaUnitError } from './settings-units.js'
import { BID_STRATEGIES as BID_STRATEGY_LIST, CAMPAIGN_SETTINGS_READ_BACK, CUSTOM_EVENT_TYPES, META_NO_CAP, PROMOTED_OBJECT_KEYS, SPECIAL_AD_CATEGORIES as SPECIAL_AD_CATEGORY_LIST, type BID_STRATEGIES, type OUTCOME_OBJECTIVES, type SPECIAL_AD_CATEGORIES } from '../../gateway/meta-settings-rules.js'

export type MetaBidStrategy = typeof BID_STRATEGIES[number]
export type MetaObjective = typeof OUTCOME_OBJECTIVES[number]
export type MetaSpecialAdCategory = typeof SPECIAL_AD_CATEGORIES[number]
export type MetaPacing = 'standard' | 'no_pacing' | 'day_parting'

/** A promoted object, as a person names it (Meta's keys in camelCase). */
export interface PromotedObjectAsk {
  pixelId?: string
  /** An ad set's pixel rule (a JSON rule, as a string). */
  pixelRule?: string
  customEventType?: string
  customEventStr?: string
  productCatalogId?: string
  productSetId?: string
  valueSemanticType?: 'VALUE' | 'MARGIN' | 'LIFETIME_VALUE'
}
const PROMOTED_ARG: Readonly<Record<keyof PromotedObjectAsk, typeof PROMOTED_OBJECT_KEYS[number]>> = {
  pixelId: 'pixel_id', pixelRule: 'pixel_rule', customEventType: 'custom_event_type', customEventStr: 'custom_event_str', productCatalogId: 'product_catalog_id',
  productSetId: 'product_set_id', valueSemanticType: 'value_semantic_type',
}

export interface CampaignSettingsRequest {
  campaignId: string
  name?: string
  dailyBudgetCents?: number
  lifetimeBudgetCents?: number
  adSetBudgets?: Array<{ adSetId: string; dailyBudgetCents?: number; lifetimeBudgetCents?: number }>
  budgetSharing?: false
  bidStrategy?: MetaBidStrategy
  adSetBidAmounts?: Array<{ adSetId: string; bidAmountCents: number }>
  /** null removes the spend cap. */
  spendCapCents?: number | null
  specialAdCategory?: MetaSpecialAdCategory
  specialAdCategoryCountries?: string[]
  promotedObject?: PromotedObjectAsk
  objective?: MetaObjective
  pacing?: MetaPacing
  reelsTrendingAds?: boolean
}

export interface CampaignSettingsLive {
  campaign: LiveCampaign
  currency: string | null
  /** Every non-deleted ad set (read when the request needs them). */
  adSets: LiveChildAdSet[] | null
  adSetsMore: boolean
  /** The account's own pixels (read when a pixel is named). */
  pixels: Set<string> | null
  /** The catalogs of the account's business portfolio (read when a catalog or product set is named; null: not answered). */
  catalogs: Set<string> | null
  /** The catalog of the named product set. */
  productSetCatalog: string | null
}

/** Which live reads a request needs, beyond the campaign itself (the promoted object as it will be: current + asked). */
export function campaignReadsNeeded(request: CampaignSettingsRequest, campaign: LiveCampaign): { adSets: boolean; pixels: boolean; catalogs: boolean; productSetId: string | null } {
  const merged = request.promotedObject ? promotedMerged(campaign.promotedObject, request.promotedObject) : {}
  return {
    adSets: !!(request.adSetBudgets || request.bidStrategy || request.adSetBidAmounts || request.objective || request.dailyBudgetCents !== undefined || request.lifetimeBudgetCents !== undefined),
    pixels: !!merged.pixel_id,
    catalogs: !!(merged.product_catalog_id || merged.product_set_id),
    productSetId: merged.product_set_id ?? null,
  }
}

/** The promoted object as it will be: what Meta holds now, with the asked keys written over (Meta replaces the whole object). */
export function promotedMerged(current: Record<string, unknown> | null, ask: PromotedObjectAsk): Record<string, string> {
  const merged: Record<string, string> = Object.fromEntries(Object.entries(current ?? {}).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]))
  for (const [arg, key] of Object.entries(PROMOTED_ARG) as Array<[keyof PromotedObjectAsk, string]>) {
    const value = ask[arg]
    if (value !== undefined) merged[key] = value
  }
  return merged
}

const LEGACY = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'])
const CAPS: ReadonlySet<string> = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'])
const MAX_CHILDREN = 70
const STRATEGY_WORDS: Readonly<Record<string, string>> = {
  LOWEST_COST_WITHOUT_CAP: 'highest volume (no cap)', LOWEST_COST_WITH_BID_CAP: 'bid cap', COST_CAP: 'cost per result goal', LOWEST_COST_WITH_MIN_ROAS: 'ROAS goal',
}

/** Answers in words for what set-meta-campaign does not send (rows CMP-064, CMP-067, CMP-068, CMP-072, CMP-075). */
export const CAMPAIGN_NOT_SENT = [
  'Start and stop times: Meta reads a campaign\'s times from its ad sets and takes them only there — set-meta-ad-set startTime / endTime.',
  'Frequency caps: Meta takes them only on an ad set whose goal is REACH or THRUPLAY — set-meta-ad-set frequencyCaps.',
  'Iterative split tests: Meta documents the field but not its shape; A/B tests are Meta studies (their own tool).',
  'smart_promotion_type: writing it does not make a campaign Advantage+ (Meta derives that) — Nexus never sends it.',
  'budget_rebalance_flag: deprecated by Meta since Marketing API v7.0 — never sent.',
]

const named = (c: LiveCampaign) => `campaign "${c.name ?? 'no name'}" (${c.id})`
const cents = (v: string | null, currency: string | null) => metaUnitsToMinor(v, currency)

export function campaignSettingsDraft(request: CampaignSettingsRequest, live: CampaignSettingsLive): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function draft(request: CampaignSettingsRequest, live: CampaignSettingsLive): MetaChangeDraft | { refusal: string } {
  const c = live.campaign
  const cur = live.currency
  const who = named(c)
  const params: Record<string, string> = {}
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const noUndo: string[] = []
  const undo: Record<string, unknown> = {}
  const on = isOn(c.status)
  const spendWord = on ? 'the campaign is on, so it can spend more from now' : 'nothing spends yet: the campaign is not on (it spends once switched on)'

  const asked = Object.entries(request).filter(([k, v]) => k !== 'campaignId' && v !== undefined)
  if (!asked.length) return { refusal: `Name at least one setting to change for campaign ${request.campaignId}. ${CAMPAIGN_NOT_SENT.join(' ')}` }
  if (c.status === 'DELETED' || c.status === 'ARCHIVED') {
    if (asked.some(([k]) => k !== 'name')) return { refusal: `${who} is ${c.status === 'DELETED' ? 'deleted' : 'archived'}: Meta lets only its name change.` }
  }
  if (c.smartPromotionType && LEGACY.has(c.smartPromotionType)) {
    return { refusal: `${who} is a legacy Advantage+ shopping or app campaign: Meta refuses every edit of these through its API since v25 (all versions since 2026-05-19). Only Ads Manager can migrate it.` }
  }

  // ── name (CMP-046) ──
  if (request.name !== undefined) {
    if (request.name === c.name) skipped.push(`${who} is already named "${c.name}".`)
    else { params.name = request.name; lines.push(['Name', c.name, request.name]); if (c.name) undo.name = c.name; else noUndo.push('The campaign had no name to put back.') }
  }

  // ── budget (CMP-036 amount, CMP-037 daily ⇄ lifetime, CMP-039 campaign budget on) ──
  const children = live.adSets
  const hasCbo = !!(c.dailyBudget || c.lifetimeBudget)
  const asksBudget = request.dailyBudgetCents !== undefined || request.lifetimeBudgetCents !== undefined
  if (request.dailyBudgetCents !== undefined && request.lifetimeBudgetCents !== undefined) return { refusal: 'Name a daily or a lifetime campaign budget, not both: Meta takes one.' }
  if (asksBudget && request.adSetBudgets) return { refusal: 'A campaign budget and ad set budgets go in two changes: one sets the campaign\'s budget, the other moves the budgets to the ad sets.' }
  if (asksBudget) {
    const type = request.dailyBudgetCents !== undefined ? 'daily' : 'lifetime'
    const newCents = (type === 'daily' ? request.dailyBudgetCents : request.lifetimeBudgetCents)!
    const field = type === 'daily' ? 'daily_budget' : 'lifetime_budget'
    const oldDaily = cents(c.dailyBudget, cur)
    const oldLifetime = cents(c.lifetimeBudget, cur)
    if (hasCbo) {
      const oldType = oldDaily !== null ? 'daily' : 'lifetime'
      const oldCents = oldType === 'daily' ? oldDaily! : oldLifetime!
      if (oldType === type && oldCents === newCents) skipped.push(`${who}'s ${type} budget is already ${money(newCents, cur)}.`)
      else {
        params[field] = budgetParam(newCents, cur)
        lines.push([`Campaign budget (${type})`, `${money(oldCents, cur)} ${oldType}`, `${money(newCents, cur)} ${type}`])
        undo[oldType === 'daily' ? 'dailyBudgetCents' : 'lifetimeBudgetCents'] = oldCents
        if (oldType === type) {
          if (newCents > oldCents) spendsMoney.push(`Raising ${who}'s ${type} budget from ${money(oldCents, cur)} to ${money(newCents, cur)}: ${spendWord}.`)
          warnings.push('Every budget change starts Meta\'s learning again for the campaign\'s ad sets. Meta may spend up to 75% more than a daily budget on a day (never more than 7 daily budgets in a week).')
        } else {
          // CMP-037 — STILL-UNVERIFIED: no Meta page shows switching a campaign's budget type (LIVE-PROBES CMP-037).
          warnings.push(`Switching ${who} from a ${oldType} to a ${type} budget: Meta documents no such switch for a campaign; Nexus sends the ${type} budget alone and Meta's answer decides (it may refuse it, and then nothing changes).`)
          if (type === 'lifetime' && children?.some((a) => a.status !== 'ARCHIVED' && !a.endTime)) {
            return { refusal: `A lifetime budget needs every ad set to have an end time, and ${children.filter((a) => a.status !== 'ARCHIVED' && !a.endTime).map((a) => a.id).join(', ')} has none: give them one first (set-meta-ad-set endTime).` }
          }
          spendsMoney.push(`Switching ${who} to a ${type} budget of ${money(newCents, cur)} (from ${money(oldCents, cur)} ${oldType}) changes how much it may spend each day: ${spendWord}.`)
        }
      }
    } else {
      // CMP-039 — STILL-UNVERIFIED: Meta's guide documents only turning campaign budget off (LIVE-PROBES CMP-039).
      if (!children) return { refusal: `Nexus could not read ${who}'s ad sets, which moving their budgets to the campaign needs.` }
      if (live.adSetsMore) return { refusal: `${who} has more ad sets than Nexus reads at once: change its budgets in Ads Manager.` }
      params[field] = budgetParam(newCents, cur)
      lines.push(['Budget', 'on each ad set (ad set budgets)', `campaign ${type} budget ${money(newCents, cur)} (Advantage+ campaign budget)`])
      warnings.push('Turning on a campaign budget for a running campaign: Meta documents only turning it off; Nexus sends the campaign budget and Meta\'s answer decides (it may refuse it, and then nothing changes). Meta then shares the budget across the ad sets as it sees fit.')
      spendsMoney.push(`A campaign ${type} budget of ${money(newCents, cur)} replaces the ad sets' own budgets (now ${children.map((a) => money(cents(type === 'daily' ? a.dailyBudget : a.lifetimeBudget, cur), cur)).join(' + ') || 'none'}): ${spendWord}.`)
      const back = children.map((a) => ({ adSetId: a.id, ...(a.dailyBudget ? { dailyBudgetCents: cents(a.dailyBudget, cur)! } : a.lifetimeBudget ? { lifetimeBudgetCents: cents(a.lifetimeBudget, cur)! } : {}) }))
      if (back.length && back.every((b) => 'dailyBudgetCents' in b || 'lifetimeBudgetCents' in b) && new Set(back.map((b) => ('dailyBudgetCents' in b ? 'd' : 'l'))).size === 1) undo.adSetBudgets = back
      else { noUndo.push('Moving the budgets back to the ad sets needs each ad set\'s own budget, and not every ad set had one.') }
    }
  }

  // ── campaign budget off: budgets to the ad sets (CMP-038) ──
  if (request.adSetBudgets) {
    if (!hasCbo) return { refusal: `${who} has no campaign budget: its budgets are on its ad sets already (set-meta-ad-set dailyBudgetCents).` }
    if (!children) return { refusal: `Nexus could not read ${who}'s ad sets, which Meta needs listed all together.` }
    if (live.adSetsMore || children.length > MAX_CHILDREN) return { refusal: `${who} has more than ${MAX_CHILDREN} ad sets: Meta does not let such a campaign turn its campaign budget off.` }
    const byId = new Map(request.adSetBudgets.map((b) => [b.adSetId, b]))
    if (byId.size !== request.adSetBudgets.length) return { refusal: 'Name each ad set once.' }
    const missing = children.filter((a) => !byId.has(a.id)).map((a) => a.id)
    const extra = request.adSetBudgets.filter((b) => !children.some((a) => a.id === b.adSetId)).map((b) => b.adSetId)
    if (missing.length || extra.length) {
      return { refusal: `Meta needs EVERY ad set of ${who} that is not deleted, each with its own budget${missing.length ? `; missing: ${missing.join(', ')}` : ''}${extra.length ? `; not of this campaign: ${extra.join(', ')}` : ''}.` }
    }
    const types = new Set(request.adSetBudgets.map((b) => (b.dailyBudgetCents !== undefined ? 'daily' : b.lifetimeBudgetCents !== undefined ? 'lifetime' : 'none')))
    if (types.has('none') || types.size !== 1 || request.adSetBudgets.some((b) => b.dailyBudgetCents !== undefined && b.lifetimeBudgetCents !== undefined)) {
      return { refusal: 'Give every ad set one budget of the same kind: all daily or all lifetime.' }
    }
    const type = [...types][0] as 'daily' | 'lifetime'
    if (type === 'lifetime') {
      const open = children.filter((a) => !a.endTime).map((a) => a.id)
      if (open.length) return { refusal: `A lifetime budget needs an end time, and ad set ${open.join(', ')} has none: give it one first (set-meta-ad-set endTime).` }
    }
    const list = request.adSetBudgets.map((b) => ({ adset_id: b.adSetId, [type === 'daily' ? 'daily_budget' : 'lifetime_budget']: Number(budgetParam((type === 'daily' ? b.dailyBudgetCents : b.lifetimeBudgetCents)!, cur)) }))
    params.adset_budgets = JSON.stringify(list)
    const sum = request.adSetBudgets.reduce((n, b) => n + ((type === 'daily' ? b.dailyBudgetCents : b.lifetimeBudgetCents) ?? 0), 0)
    const oldDaily = cents(c.dailyBudget, cur)
    const oldLifetime = cents(c.lifetimeBudget, cur)
    const oldCents = oldDaily ?? oldLifetime ?? 0
    const oldType = oldDaily !== null ? 'daily' : 'lifetime'
    lines.push(['Budget', `campaign ${oldType} budget ${money(oldCents, cur)}`, `on each ad set: ${request.adSetBudgets.length} ${type} budgets, ${money(sum, cur)} together`])
    for (const b of request.adSetBudgets.slice(0, 10)) lines.push([`Ad set ${b.adSetId} ${type} budget`, children.find((a) => a.id === b.adSetId)?.name ?? null, money((type === 'daily' ? b.dailyBudgetCents : b.lifetimeBudgetCents)!, cur)])
    if (oldType !== type || sum > oldCents) spendsMoney.push(`The ad sets' ${type} budgets add up to ${money(sum, cur)}, against the campaign's ${oldType} ${money(oldCents, cur)}: ${spendWord}.`)
    if (c.advantageState && c.advantageState !== 'DISABLED') warnings.push(`${who} is ${c.advantageState}: moving the budgets to the ad sets turns Advantage+ off for it (Meta does it without a warning).`)
    warnings.push('Every budget change starts Meta\'s learning again. Whether each ad set\'s new budget counts toward Meta\'s 4 budget changes an hour per ad set is not documented.')
    undo[oldType === 'daily' ? 'dailyBudgetCents' : 'lifetimeBudgetCents'] = oldCents
    warnings.push('Its undo turns the campaign budget on again — Meta documents only turning it off, so the undo is Meta\'s to accept.')
  }

  // ── ad set budget sharing off (CMP-041): for good ──
  if (request.budgetSharing === false) {
    if (c.budgetSharing === false) skipped.push(`${who} does not share budget between its ad sets already.`)
    else {
      params.is_adset_budget_sharing_enabled = 'false'
      lines.push(['Ad set budget sharing', c.budgetSharing === null ? 'unknown' : 'on', 'off'])
      noUndo.push('Ad set budget sharing stays off: Meta cannot switch it on again for a running campaign (3858418).')
      warnings.push(`Turning ad set budget sharing off for ${who} is for good: Meta refuses to switch it on again for a running campaign (3858418) — it would need a new campaign. This part cannot be undone.`)
    }
  }

  // ── bid strategy (CMP-042) and each ad set's cap (CMP-043) ──
  if (request.adSetBidAmounts && !request.bidStrategy) return { refusal: 'Each ad set\'s cap (adSetBidAmounts) goes with a move to a bid cap or cost cap strategy; to change one ad set\'s bid, use set-meta-ad-set bidAmountCents.' }
  if (request.bidStrategy) {
    const to = request.bidStrategy
    const from = c.bidStrategy
    if (to === from) skipped.push(`${who}'s bid strategy is already ${STRATEGY_WORDS[to]}.`)
    else {
      if (!hasCbo) return { refusal: `${who} has no campaign budget: its bid strategy is on each ad set (set-meta-ad-set bidStrategy).` }
      if (from === 'LOWEST_COST_WITH_MIN_ROAS') return { refusal: `${who} has a ROAS goal under a campaign budget: Meta says "you cannot currently switch to other bid strategies after you create your campaign" (Advantage campaign budget guide). Copy it into a new campaign instead.` }
      if (c.budgetSharing === true) return { refusal: `${who} shares budget between its ad sets: Meta refuses a bid strategy change mid-flight then (4834006).` }
      if (!children) return { refusal: `Nexus could not read ${who}'s ad sets, which Meta's limit on bid strategy changes needs.` }
      if (live.adSetsMore || children.length > MAX_CHILDREN) return { refusal: `${who} has more than ${MAX_CHILDREN} ad sets: Meta does not let such a campaign change its bid strategy.` }
      params.bid_strategy = to
      lines.push(['Bid strategy', from ? STRATEGY_WORDS[from] ?? from : 'none', STRATEGY_WORDS[to]])
      if (CAPS.has(to)) {
        const bids = new Map((request.adSetBidAmounts ?? []).map((b) => [b.adSetId, b.bidAmountCents]))
        const active = children.filter((a) => a.status !== 'ARCHIVED')
        const missing = active.filter((a) => !bids.has(a.id)).map((a) => a.id)
        const extra = [...bids.keys()].filter((id) => !children.some((a) => a.id === id))
        if (!CAPS.has(from ?? '') && (missing.length || extra.length)) {
          return { refusal: `Moving ${who} from automatic bidding to a cap needs each ad set's cap (adSetBidAmounts, Meta's adset_bid_amounts)${missing.length ? `; missing: ${missing.join(', ')}` : ''}${extra.length ? `; not of this campaign: ${extra.join(', ')}` : ''}.` }
        }
        if (bids.size) {
          if (extra.length) return { refusal: `Not of ${who}: ad set ${extra.join(', ')}.` }
          params.adset_bid_amounts = JSON.stringify(Object.fromEntries([...bids].map(([id, v]) => [id, Number(bidAmountParam(v, cur))])))
          for (const [id, v] of [...bids].slice(0, 10)) lines.push([`Ad set ${id} cap`, money(cents(children.find((a) => a.id === id)?.bidAmount ?? null, cur), cur), money(v, cur)])
        }
        warnings.push('A cap limits what Meta pays per result: delivery may slow. Meta reads each cap per 1,000 impressions for ad sets billed on impressions.')
      } else if (request.adSetBidAmounts) {
        return { refusal: 'adSetBidAmounts goes only with a move to a bid cap or cost cap strategy.' }
      }
      if (to === 'LOWEST_COST_WITHOUT_CAP' && from && from !== 'LOWEST_COST_WITHOUT_CAP') spendsMoney.push(`Removing ${who}'s ${STRATEGY_WORDS[from] ?? from}: without a cap Meta may pay more per result — ${spendWord}.`)
      if (to === 'LOWEST_COST_WITH_MIN_ROAS') {
        noUndo.push('A ROAS goal under a campaign budget cannot be switched to another bid strategy afterwards (Meta).')
        warnings.push(`A ROAS goal under a campaign budget is for good: Meta does not let ${who} switch to another bid strategy afterwards (only a copy into a new campaign can). Each ad set then needs its minimum ROAS (set-meta-ad-set roasGoal) and a VALUE goal; Meta needs the account to be allowed ROAS goals.`)
      } else if (from && (BID_STRATEGY_LIST as readonly string[]).includes(from)) {
        undo.bidStrategy = from
        if (CAPS.has(from)) {
          const back = children.filter((a) => a.status !== 'ARCHIVED').map((a) => ({ adSetId: a.id, bidAmountCents: cents(a.bidAmount, cur) }))
          if (back.length && back.every((b) => b.bidAmountCents !== null && b.bidAmountCents > 0)) undo.adSetBidAmounts = back
          else { delete undo.bidStrategy; noUndo.push('Going back to a cap needs each ad set\'s cap, and not every ad set had one.') }
        }
      } else noUndo.push('The bid strategy was not readable before.')
      warnings.push('A bid strategy change starts Meta\'s learning again.')
    }
  }

  // ── spend cap (CMP-044, CMP-045) ──
  if (request.spendCapCents !== undefined) {
    if (c.canUseSpendCap === false) return { refusal: `Meta says ${who} cannot have a spend cap (reach and frequency or Premium Self Serve campaigns).` }
    const oldCap = c.spendCap && c.spendCap !== META_NO_CAP && c.spendCap !== '0' ? cents(c.spendCap, cur) : null
    const newCap = request.spendCapCents
    if (oldCap === newCap) skipped.push(newCap === null ? `${who} has no spend cap already.` : `${who}'s spend cap is already ${money(newCap, cur)}.`)
    else {
      params.spend_cap = campaignSpendCapParam(newCap, cur)
      lines.push(['Spend cap', oldCap === null ? 'none' : money(oldCap, cur), newCap === null ? 'none (removed)' : money(newCap, cur)])
      undo.spendCapCents = oldCap
      if (newCap === null) spendsMoney.push(`Removing ${who}'s spend cap of ${money(oldCap, cur)}: it then has no ceiling over its whole run — ${spendWord}.`)
      else if (oldCap !== null && newCap > oldCap) spendsMoney.push(`Raising ${who}'s spend cap from ${money(oldCap, cur)} to ${money(newCap, cur)}: ${spendWord}.`)
      else warnings.push('Meta asks a campaign spend cap of about USD 100 (or the same in the account currency) at least; a lower one is refused (2446307).')
    }
  }

  // ── special ad category (CMP-034) ──
  if (request.specialAdCategory !== undefined) {
    const from = c.specialAdCategory ?? c.specialAdCategories?.[0] ?? 'NONE'
    const to = request.specialAdCategory
    const countries = request.specialAdCategoryCountries ?? null
    if (to !== 'NONE' && !countries?.length) return { refusal: `A special ad category needs the countries it applies to (specialAdCategoryCountries): Meta requires them with any category but NONE.` }
    if (to === from && JSON.stringify(countries ?? []) === JSON.stringify(c.specialAdCategoryCountry ?? [])) skipped.push(`${who}'s special ad category is already ${to}.`)
    else {
      params.special_ad_category = to
      if (countries) params.special_ad_category_country = JSON.stringify(countries)
      lines.push(['Special ad category', `${from}${c.specialAdCategoryCountry?.length ? ` (${c.specialAdCategoryCountry.join(', ')})` : ''}`, `${to}${countries?.length ? ` (${countries.join(', ')})` : ''}`])
      if (to !== 'NONE') warnings.push(`Moving ${who} into ${to}: its targeting must already meet the category's rules (Meta refuses it otherwise; meta-targeting-check), Meta strips targeting options the category forbids, and every ad set's customer lifecycle goal goes back to broad.`)
      if ((SPECIAL_AD_CATEGORY_LIST as readonly string[]).includes(from)) undo.specialAdCategory = from
      else noUndo.push(`The previous category (${from}) is not one Nexus sends.`)
      if (c.specialAdCategoryCountry?.length) undo.specialAdCategoryCountries = c.specialAdCategoryCountry
      else if (from !== 'NONE') { noUndo.push('The previous category\'s countries were not readable.') }
      warnings.push('Its undo puts the category back, not the targeting options Meta stripped.')
    }
  }

  // ── promoted object (CMP-062) ──
  if (request.promotedObject) {
    const current = c.promotedObject ?? {}
    const foreign = Object.keys(current).filter((k) => !(PROMOTED_OBJECT_KEYS as readonly string[]).includes(k))
    if (foreign.length) return { refusal: `${who}'s promoted object holds ${foreign.join(', ')}, which Nexus does not send: change it in Ads Manager.` }
    const merged = promotedMerged(current, request.promotedObject)
    const problem = promotedProblem(merged, live)
    if (problem) return { refusal: problem }
    const next = JSON.stringify(merged)
    if (settingsView('promoted_object', next) === settingsView('promoted_object', c.promotedObject)) skipped.push(`${who}'s promoted object is already so.`)
    else {
      params.promoted_object = next
      lines.push(['Promoted object', c.promotedObject ? settingsView('promoted_object', c.promotedObject) : 'none', settingsView('promoted_object', next)])
      const back = promotedBack(c.promotedObject)
      if (back) undo.promotedObject = back
      else { noUndo.push('The campaign had no promoted object before: Meta documents no way to take one away.') }
      warnings.push('A promoted object is what every ad of the campaign is optimised for: a new pixel event starts learning again.')
    }
  }

  // ── objective (CMP-063): only a campaign with no ad set ──
  if (request.objective !== undefined) {
    if (request.objective === c.objective) skipped.push(`${who}'s objective is already ${c.objective}.`)
    else {
      if (!children) return { refusal: `Nexus could not read ${who}'s ad sets.` }
      if (children.length || live.adSetsMore) return { refusal: `${who} has ad sets: Meta does not document what an objective change does to running ad sets (their goals may no longer fit), so Nexus changes the objective only of a campaign with no ad set. Copy it into a new campaign with the objective you want.` }
      params.objective = request.objective
      lines.push(['Objective', c.objective, request.objective])
      if (c.objective && /^OUTCOME_/.test(c.objective)) undo.objective = c.objective
      else { noUndo.push(`The previous objective (${c.objective ?? 'none'}) is a legacy one Nexus does not send.`) }
    }
  }

  // ── pacing (CMP-073): on the campaign when campaign budget is on ──
  if (request.pacing !== undefined) {
    if (!hasCbo) return { refusal: `${who} has no campaign budget: pacing is set on each ad set then (set-meta-ad-set pacing).` }
    if (request.pacing === 'day_parting' && !c.lifetimeBudget) return { refusal: 'Ad scheduling (day_parting) needs a lifetime budget: Meta schedules only lifetime budgets.' }
    const from = c.pacingType?.length === 1 ? c.pacingType[0] : c.pacingType ? JSON.stringify(c.pacingType) : 'standard'
    if (from === request.pacing) skipped.push(`${who}'s pacing is already ${from}.`)
    else {
      params.pacing_type = JSON.stringify([request.pacing])
      lines.push(['Pacing', from, request.pacing])
      if (request.pacing === 'no_pacing') spendsMoney.push(`Accelerated delivery (no_pacing) for ${who}: Meta spends its budget as fast as it can — ${spendWord}.`)
      else if (from === 'day_parting') spendsMoney.push(`Without ad scheduling ${who} delivers at every hour, not only its scheduled ones: ${spendWord}.`)
      if (request.pacing === 'day_parting') warnings.push('With ad scheduling the hours come from each ad set\'s own schedule (set-meta-ad-set dayparting).')
      if (['standard', 'no_pacing', 'day_parting'].includes(from)) undo.pacing = from
      else { noUndo.push(`The previous pacing (${from}) is not one Nexus sends.`) }
    }
  }

  // ── reels trending ads (CMP-071): STILL-UNVERIFIED ──
  if (request.reelsTrendingAds !== undefined) {
    if (request.reelsTrendingAds === c.reelsTrendingAds) skipped.push(`${who}'s reels trending ads flag is already ${String(c.reelsTrendingAds)}.`)
    else {
      params.is_reels_trending_ads_enabled = String(request.reelsTrendingAds)
      lines.push(['Reels trending ads', c.reelsTrendingAds === null ? 'unknown' : String(c.reelsTrendingAds), String(request.reelsTrendingAds)])
      warnings.push('Meta documents this flag only as an "indicator for \'reels trending ads\' campaign" (a reservation product); Nexus sends it and Meta\'s answer decides.')
      if (request.reelsTrendingAds) spendsMoney.push(`Reels trending ads on for ${who}: Meta does not say what it changes in delivery; it may spend in more places — ${spendWord}.`)
      if (c.reelsTrendingAds !== null) undo.reelsTrendingAds = c.reelsTrendingAds
      else { noUndo.push('The flag was not readable before.') }
    }
  }

  if (!Object.keys(params).length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  // What Meta must read back as sent (plain values only: JSON and the no-cap value are read back in Meta's own form).
  const EXPECTED = ['name', 'daily_budget', 'lifetime_budget', 'bid_strategy', 'objective', 'is_adset_budget_sharing_enabled', 'is_reels_trending_ads_enabled']
  const expect: Record<string, string> = Object.fromEntries(Object.entries(params).filter(([k]) => EXPECTED.includes(k)))
  if (params.spend_cap && params.spend_cap !== META_NO_CAP) expect.spend_cap = params.spend_cap
  const readFields = campaignReadFields(Object.keys(params))
  const what = Object.keys(params).filter((k) => k !== 'special_ad_category_country').map((k) => k.replace(/_/g, ' ')).join(', ')
  const request1: MetaChangeRequest = {
    step: 1,
    label: `Change ${who}: ${what}`,
    kind: 'campaign',
    objectId: c.id,
    params,
    check: campaignSettingsCheck(),
    raisesSpend: spendsMoney.length > 0,
    readBackInPost: true,
    budget: false,
    undoable: Object.keys(undo).length > 0,
    operation: 'campaign.settings',
    expect,
    readBackFields: ['id', ...readFields].join(','),
  }
  const { changes, more } = changeLines(lines)
  const before: SettingsRecord = {
    kind: 'campaign', id: c.id,
    fields: Object.fromEntries(readFields.map((f) => [f, settingsView(f, campaignFieldOf(c, f))])),
    undo: Object.keys(undo).length ? undo : null,
    noUndo,
  }
  const after: SettingsRecord = { kind: 'campaign', id: c.id, fields: Object.fromEntries(readFields.map((f) => [f, settingsView(f, params[f] ?? null)])) }
  return {
    summary: `Meta: ${request1.label}.`,
    changes,
    totals: { fields: Object.keys(params).length, requests: 1, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, ...(noUndo.length ? [`No undo for: ${noUndo.join(' ')}`] : [])],
    spendsMoney,
    skipped,
    requests: [request1],
    stands: {
      campaign: { ...c, effectiveStatus: undefined },
      adSets: children?.map((a) => ({ id: a.id, status: a.status, dailyBudget: a.dailyBudget, lifetimeBudget: a.lifetimeBudget, bidAmount: a.bidAmount, endTime: a.endTime })) ?? null,
      adSetsMore: live.adSetsMore,
    },
    before,
    after,
  }
}

/** The fields a campaign change reads back for what it writes (adset_budgets / adset_bid_amounts are not readable: their effect is). */
export function campaignReadFields(params: string[]): string[] {
  const out = new Set<string>()
  for (const p of params) {
    if (p === 'adset_budgets') { out.add('daily_budget'); out.add('lifetime_budget') } else if (p === 'adset_bid_amounts') out.add('bid_strategy')
    else if (CAMPAIGN_SETTINGS_READ_BACK.has(p)) out.add(p)
  }
  return [...out]
}

/** A campaign field as Meta sent it (for the record's view). */
function campaignFieldOf(c: LiveCampaign, field: string): unknown {
  const map: Record<string, unknown> = {
    name: c.name, daily_budget: c.dailyBudget, lifetime_budget: c.lifetimeBudget, bid_strategy: c.bidStrategy, spend_cap: c.spendCap, objective: c.objective,
    special_ad_category: c.specialAdCategory, special_ad_category_country: c.specialAdCategoryCountry, pacing_type: c.pacingType, promoted_object: c.promotedObject,
    is_adset_budget_sharing_enabled: c.budgetSharing, is_reels_trending_ads_enabled: c.reelsTrendingAds, is_budget_schedule_enabled: c.budgetScheduling,
  }
  return map[field] ?? null
}

/** Why a promoted object cannot be sent: a pixel not the account's, a catalog not the portfolio's, a product set of another catalog. */
export function promotedProblem(merged: Record<string, string>, live: { pixels: Set<string> | null; catalogs: Set<string> | null; productSetCatalog: string | null }): string | null {
  if (merged.pixel_id && !live.pixels?.has(merged.pixel_id)) return `Pixel ${merged.pixel_id} is not one of the chosen ad account's own pixels (meta-ads-graph-read act_<id>/adspixels lists them).`
  if (merged.product_catalog_id || merged.product_set_id) {
    if (!live.catalogs) return 'Nexus could not read which catalogs the ad account\'s business portfolio has, so no catalog is sent.'
    if (merged.product_catalog_id && !live.catalogs.has(merged.product_catalog_id)) return `Catalog ${merged.product_catalog_id} is not one the ad account's business portfolio owns or was given.`
    if (merged.product_set_id && (!live.productSetCatalog || !live.catalogs.has(live.productSetCatalog))) return `Product set ${merged.product_set_id} is not in a catalog of the ad account's business portfolio.`
    if (merged.product_set_id && merged.product_catalog_id && live.productSetCatalog !== merged.product_catalog_id) return `Product set ${merged.product_set_id} is not in catalog ${merged.product_catalog_id}.`
  }
  if (merged.custom_event_type === 'OTHER' && !merged.custom_event_str) return 'A custom event type OTHER names its event (customEventStr).'
  return null
}

/** The promoted object as set-meta-* arguments (for undo), or null when it holds nothing Nexus can send back. */
export function promotedBack(object: Record<string, unknown> | null): PromotedObjectAsk | null {
  if (!object || !Object.keys(object).length) return null
  const out: Record<string, string> = {}
  for (const [arg, key] of Object.entries(PROMOTED_ARG)) {
    const v = object[key]
    if (v === undefined || v === null) continue
    if (typeof v !== 'string' && typeof v !== 'number') return null
    if (key === 'custom_event_type' && !(CUSTOM_EVENT_TYPES as readonly string[]).includes(String(v))) return null
    if (key === 'value_semantic_type' && !['VALUE', 'MARGIN', 'LIFETIME_VALUE'].includes(String(v))) return null
    out[arg] = String(v)
  }
  return Object.keys(out).length === Object.keys(object).length ? out as PromotedObjectAsk : null
}
