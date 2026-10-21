/**
 * Meta step 19 — create-meta-ad-set as a draft: a new ad set in a campaign of the business's chosen ad account, born PAUSED
 * (ACTIVE only when the person asks: SPENDS MONEY), with a MINIMAL targeting (countries, regions, cities, age, gender,
 * custom audiences, Advantage+ audience — full targeting edits are set-meta-targeting, step 20). Master rows AS-031,
 * AS-032 (answered), AS-063, AS-066, AS-067, AS-073, AS-080, AS-089. ONE request: POST /act_{id}/adsets, checked by Meta
 * first (validate_only + include_recommendations). Pure.
 *
 * Meta's rules it follows (checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/ad-campaign.md "Creating": name ≤ 400, campaign_id, optimization_goal, billing_event, targeting ("countries
 *     is required"), status ACTIVE | PAUSED; daily_budget (only for ad sets running longer than 24 h) or lifetime_budget
 *     (needs end_time) — only without a campaign budget; under one, daily_/lifetime_min_spend_target and _spend_cap of the
 *     campaign's type; promoted_object "required with certain campaign objectives"; destination_type; is_dynamic_creative
 *     (default false); budget_schedule_specs; dsa_payor / dsa_beneficiary (≤ 512) for ad sets that reach the EU (or that
 *     Nexus cannot place outside it) unless the account saved defaults (Meta fills them; "both or neither"; facts F1 X7).
 *   - campaign_spec (an ad set with a new campaign in one call, AS-032) takes only name, objective and buying_type: its
 *     special ad category and budget sharing would be Meta's defaults — Nexus makes the campaign first
 *     (create-meta-campaign), said in words.
 *   - bidding/overview/billing-events.md: LINK_CLICKS → LINK_CLICKS | IMPRESSIONS billing; THRUPLAY → THRUPLAY |
 *     IMPRESSIONS; the other goals → IMPRESSIONS (Nexus bills IMPRESSIONS unless named).
 *   - bidding/overview/bid-strategy.md + advantage-campaign-budget.md: under a campaign budget the strategy is the
 *     campaign's (a cap: each ad set names its bid; a ROAS goal: each ad set its floor and the VALUE goal); COST_CAP needs
 *     IMPRESSIONS billing; LOWEST_COST_WITH_MIN_ROAS takes no bid_amount (step 18's same rules, settings-units.ts units).
 *   - graph-api/reference/ad-promoted-object (AS-063): "If you use pixel_id, you must provide custom_event_type"; Sales
 *     with conversions: a pixel and its event, or a catalog's product set; Leads with instant forms (ON_AD): page_id;
 *     boosted_product_set_id "combined with product_set_id" (AS-066; Meta may limit it to some accounts). Nexus names only
 *     the account's own pixels and custom conversions, its business portfolio's catalogs (catalog-rule.ts) and the Page
 *     the business chose — the gateway checks each again. App ids, offers, events, WhatsApp numbers, place page sets and
 *     conversion goals are not sent (CREATE_AD_SET_NOT_SENT).
 *   - audiences/reference/basic-targeting.md, targeting-expansion/advantage-audience.md: see meta-create-rules.ts; people
 *     under 18 in the EU cannot be targeted (facts F1 M6); with Advantage+ audience age_min ≤ 25 and no age_max. With no
 *     placement fields Meta uses Advantage+ placements (all its placements) — named in the preview.
 *   - dynamic-creative/placement-asset-customization.md + ad-creative/asset-feed-spec/asset-customization-rules.md
 *     (RECHECK AS-080 CONFIRMED): a creative with placement asset customization runs only in an ad set with
 *     is_dynamic_creative false — said when dynamic creative is asked.
 *   - advantage-campaigns.md: an ad set with Advantage+ audience on, no placement targeting, in a Sales / Leads campaign
 *     with a campaign budget makes the campaign read as Advantage+ — said.
 *   - marketing-messages.md (OCC 2026-08-13): "With Advantage+ placements, marketing messages are added automatically for
 *     eligible campaigns" (Sales: LINK_CLICKS, OFFSITE_CONVERSIONS, VALUE; Traffic: LINK_CLICKS; Leads:
 *     OFFSITE_CONVERSIONS) of an account whose marketing_messages_settings.whatsapp_activation_status is
 *     MARKETING_MESSAGE_ONBOARDED — a silent opt-in the preview names (a read that fails is said, not refused).
 *   - adset-budget-sharing.md: under budget sharing every ad set takes the campaign's bid strategy (4834009) and a daily
 *     budget. DSA: the EU with its outermost regions (RE, GP, MQ, GF, YT, MF); no one under 18 in the EU, EEA or CH.
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { money } from './change-settings-common.js'
import { promotedMerged, promotedProblem, type MetaBidStrategy, type PromotedObjectAsk } from './change-campaign-settings.js'
import { allowedAttribution, PRESET_SPEC, type AttributionPreset } from './change-ad-set-settings.js'
import { createStatus, nothingMade, scheduleSpecs, type ScheduleAsk } from './change-create-common.js'
import type { LiveCampaign } from './live-settings.js'
import { DSA_COUNTRIES, NO_YOUTH_COUNTRIES, type DsaDefaults } from './live-create.js'
import { adSetSpendCapParam, bidAmountMeaning, bidAmountParam, budgetParam, metaUnitsToMinor, MetaUnitError, minSpendTargetParam, roasFloorParam, unixSecondsParam } from './settings-units.js'

/** A promoted object at create: step 18's keys, and what only a new ad set names. */
export interface AdSetPromotedAsk extends PromotedObjectAsk {
  /** The Page the ads promote (Leads with instant forms, Page goals): the Facebook Page this business chose. */
  pageId?: string
  /** One of the ad account's own custom conversions. */
  customConversionId?: string
  /** A product set to push harder, with the catalog's productSetId (AS-066). */
  boostedProductSetId?: string
}

export interface CreateTargetingAsk {
  countries?: string[]
  /** Region keys (meta-targeting-search kind region). */
  regions?: string[]
  /** City keys, each with an optional radius in kilometres (17–80). */
  cities?: Array<{ key: string; radiusKm?: number }>
  ageMin?: number
  ageMax?: number
  gender?: 'all' | 'male' | 'female'
  customAudienceIds?: string[]
  excludedCustomAudienceIds?: string[]
  /** Advantage+ audience: Meta may reach beyond the ages, gender and audiences named. Sent 0 unless true. */
  advantageAudience?: boolean
}

export interface AdSetCreateRequest {
  campaignId: string
  name: string
  optimizationGoal: string
  billingEvent?: string
  optimizationSubEvent?: string
  destinationType?: string
  dailyBudgetCents?: number
  lifetimeBudgetCents?: number
  minSpendTargetCents?: number
  spendCapCents?: number
  bidStrategy?: MetaBidStrategy
  bidAmountCents?: number
  roasGoal?: number
  startTime?: string
  /** null: no end (daily budgets). */
  endTime?: string | null
  attribution?: AttributionPreset
  promotedObject?: AdSetPromotedAsk
  dynamicCreative?: boolean
  budgetSchedules?: ScheduleAsk[]
  targeting: CreateTargetingAsk
  dsa?: { payor: string; beneficiary: string }
  activate?: boolean
}

export interface AdSetCreateLive {
  adAccountId: string
  currency: string | null
  campaign: LiveCampaign
  pixels: Set<string> | null
  /** The catalog rule's answer for every catalog / product set named (null: they may; undefined: none named). */
  catalogProblem?: string | null
  /** The Facebook Page this business chose (null: none). */
  pageId: string | null
  /** WhatsApp marketing messages onboarding (read for an eligible campaign and goal): Meta's status, or why it was not read. */
  whatsApp?: { status: string | null } | { unread: string }
  dsaDefaults: DsaDefaults | null
  capabilities: string[] | null
}

/** Answers in words for what create-meta-ad-set does not send (AS-032, parts of AS-063). */
export const CREATE_AD_SET_NOT_SENT = [
  'An ad set with a new campaign in one call (campaign_spec): Meta gives such a campaign only a name, objective and buying type, so Nexus makes the campaign first (create-meta-campaign).',
  'Promoted apps, offers, events, WhatsApp numbers, place page sets, conversion goals and offline event sets: Nexus links none of them to a business, so it cannot confirm whose they are — not sent.',
  'Placements, interests, behaviours and the rest of targeting: set-meta-targeting and set-meta-placements after the create (with none, Meta uses Advantage+ placements).',
]

const LEGACY = new Set(['AUTOMATED_SHOPPING_ADS', 'SMART_APP_PROMOTION'])
const CAPS: ReadonlySet<string> = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'])
const BETA_DESTINATIONS = new Set(['ON_AD', 'ON_POST', 'ON_VIDEO', 'ON_PAGE', 'ON_EVENT', 'SHOP_AUTOMATIC'])
const ADVANTAGE_OBJECTIVES = new Set(['OUTCOME_SALES', 'OUTCOME_LEADS'])

/** marketing-messages.md: the objectives and goals whose ad sets Meta gives WhatsApp marketing messages. */
const WHATSAPP_GOALS: Readonly<Record<string, readonly string[]>> = {
  OUTCOME_SALES: ['LINK_CLICKS', 'OFFSITE_CONVERSIONS', 'VALUE'], OUTCOME_TRAFFIC: ['LINK_CLICKS'], OUTCOME_LEADS: ['OFFSITE_CONVERSIONS'],
}
/** Would Advantage+ placements add WhatsApp marketing messages to an ad set of this objective and goal (onboarded account)? */
export const whatsAppEligible = (objective: string | null, goal: string): boolean => !!objective && (WHATSAPP_GOALS[objective] ?? []).includes(goal)

/** The billing events Meta pairs with a goal (billing-events.md). */
export const billingFor = (goal: string): string[] => (goal === 'LINK_CLICKS' ? ['IMPRESSIONS', 'LINK_CLICKS'] : goal === 'THRUPLAY' ? ['IMPRESSIONS', 'THRUPLAY'] : ['IMPRESSIONS'])

/**
 * The targeting JSON a create sends (one spelling: the gateway's judge reads it back the same), and whether it may reach
 * the EU: an EU country, or a region or city key (Nexus cannot tell a key's country, so it treats it as the EU).
 */
export function createTargeting(t: CreateTargetingAsk): { value: string; eu: boolean; euWhy: string | null; words: string[] } {
  const countries = [...new Set((t.countries ?? []).map((c) => c.toUpperCase()))]
  const regions = [...new Set(t.regions ?? [])]
  const cities = t.cities ?? []
  if (!countries.length && !regions.length && !cities.length) throw new MetaUnitError('Name where the ads run: countries, regions or cities (Meta requires a location).')
  if (new Set(cities.map((c) => c.key)).size !== cities.length) throw new MetaUnitError('Name each city once.')
  const geo: Record<string, unknown> = {}
  if (countries.length) geo.countries = countries
  if (regions.length) geo.regions = regions.map((key) => ({ key }))
  if (cities.length) {
    geo.cities = cities.map((c) => {
      if (c.radiusKm === undefined) return { key: c.key }
      if (!Number.isInteger(c.radiusKm) || c.radiusKm < 17 || c.radiusKm > 80) throw new MetaUnitError('A city radius is a whole number of kilometres from 17 to 80 (Meta).')
      return { key: c.key, radius: c.radiusKm, distance_unit: 'kilometer' }
    })
  }
  // Review A6 / B6 — the EU's outermost regions count for the DSA; the under-18 rule covers the EU, the EEA and CH.
  const euCountries = countries.filter((c) => DSA_COUNTRIES.has(c))
  const keysOnly = regions.length > 0 || cities.length > 0
  const eu = euCountries.length > 0 || keysOnly
  const euWhy = euCountries.length ? `it reaches ${euCountries.join(', ')}` : eu ? 'Nexus cannot tell which country a region or city key is in, so it counts them as the EU' : null
  const youthCountries = countries.filter((c) => NO_YOUTH_COUNTRIES.has(c))
  const adv = t.advantageAudience === true
  if (t.ageMin !== undefined && (t.ageMin < 13 || t.ageMin > 65)) throw new MetaUnitError('The minimum age is 13 to 65.')
  if (t.ageMax !== undefined && (t.ageMax < 13 || t.ageMax > 65)) throw new MetaUnitError('The maximum age is 13 to 65.')
  if (t.ageMin !== undefined && t.ageMax !== undefined && t.ageMax < t.ageMin) throw new MetaUnitError('The maximum age is at least the minimum age.')
  if ((youthCountries.length || keysOnly) && (t.ageMin ?? 18) < 18) {
    throw new MetaUnitError(`Meta does not let ads reach people under 18 in the EU, the EEA or Switzerland, and ${youthCountries.length ? `it reaches ${youthCountries.join(', ')}` : 'Nexus cannot tell which country a region or city key is in'}: the minimum age is 18 at least.`)
  }
  if (adv && t.ageMax !== undefined) throw new MetaUnitError('With Advantage+ audience Meta sets the maximum age itself (65): leave ageMax out.')
  // Step 20 (review B6) — the same rule as an edit: with Advantage+ audience the minimum age is 18 to 25.
  if (adv && t.ageMin !== undefined && (t.ageMin > 25 || t.ageMin < 18)) throw new MetaUnitError('With Advantage+ audience Meta takes a minimum age of 25 at most, 18 at least (the rest are suggestions).')
  const spec: Record<string, unknown> = { geo_locations: geo }
  if (t.ageMin !== undefined) spec.age_min = t.ageMin
  if (t.ageMax !== undefined) spec.age_max = t.ageMax
  if (t.gender === 'male') spec.genders = [1]
  if (t.gender === 'female') spec.genders = [2]
  const audiences = [...new Set(t.customAudienceIds ?? [])]
  const excluded = [...new Set(t.excludedCustomAudienceIds ?? [])]
  if (audiences.some((a) => excluded.includes(a))) throw new MetaUnitError('An audience is either included or excluded, not both.')
  if (audiences.length) spec.custom_audiences = audiences.map((id) => ({ id }))
  if (excluded.length) spec.excluded_custom_audiences = excluded.map((id) => ({ id }))
  spec.targeting_automation = { advantage_audience: adv ? 1 : 0 }
  const words = [
    [countries.length ? `countries ${countries.join(', ')}` : '', regions.length ? `${regions.length} region(s)` : '', cities.length ? `${cities.length} cit${cities.length === 1 ? 'y' : 'ies'}` : ''].filter(Boolean).join(', '),
    `age ${t.ageMin ?? 18}–${adv ? '65 (Meta\'s)' : t.ageMax ?? 65}`,
    t.gender && t.gender !== 'all' ? (t.gender === 'male' ? 'men' : 'women') : 'all genders',
    audiences.length ? `${audiences.length} custom audience(s)` : '',
    excluded.length ? `${excluded.length} excluded audience(s)` : '',
  ].filter(Boolean)
  return { value: JSON.stringify(spec), eu, euWhy, words }
}

export function adSetCreateDraft(request: AdSetCreateRequest, live: AdSetCreateLive, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live, now)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function draft(r: AdSetCreateRequest, live: AdSetCreateLive, now: Date): MetaChangeDraft | { refusal: string } {
  const c = live.campaign
  const cur = live.currency
  const nowSec = Math.floor(now.getTime() / 1000)
  if (!r.name?.trim()) return { refusal: 'Name the new ad set (name).' }
  if (!r.optimizationGoal) return { refusal: 'Name its performance goal (optimizationGoal).' }
  if (!r.targeting) return { refusal: 'Name where its ads run (targeting: countries, regions or cities).' }
  const camp = `campaign "${c.name ?? 'no name'}" (${c.id})`
  if (c.status === 'DELETED' || c.status === 'ARCHIVED') return { refusal: `${camp} is ${c.status === 'DELETED' ? 'deleted' : 'archived'}: Meta takes no new ad set there.` }
  if (c.smartPromotionType && LEGACY.has(c.smartPromotionType)) return { refusal: `${camp} is a legacy Advantage+ shopping or app campaign: Meta refuses changes to these through its API since v25.` }
  if (c.objective === 'OUTCOME_APP_PROMOTION' || c.objective === 'APP_INSTALLS') return { refusal: `${camp} promotes an app: Nexus links no app to a business, so it makes no ad set that names one — make it in Ads Manager.` }
  const who = `ad set "${r.name}"`
  const params: Record<string, string> = { name: r.name, campaign_id: c.id, optimization_goal: r.optimizationGoal }
  const lines: Array<[string, unknown, unknown]> = [['Ad set', 'none', `"${r.name}" in ${camp}`], ['Performance goal', null, r.optimizationGoal]]
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const cbo = !!(c.dailyBudget || c.lifetimeBudget)
  const cboType: 'daily' | 'lifetime' | null = c.dailyBudget ? 'daily' : c.lifetimeBudget ? 'lifetime' : null

  // ── goal, billing (sent explicitly), sub-event, destination (AS-067) ──
  const billing = r.billingEvent ?? 'IMPRESSIONS'
  params.billing_event = billing
  lines.push(['Pays for (billing event)', null, billing])
  if (!billingFor(r.optimizationGoal).includes(billing)) return { refusal: `Meta's billing guide pairs the ${r.optimizationGoal} goal with ${billingFor(r.optimizationGoal).join(' or ')} billing, not ${billing}.` }
  if (r.optimizationSubEvent) { params.optimization_sub_event = r.optimizationSubEvent; lines.push(['Optimisation sub-event', null, r.optimizationSubEvent]) }
  if (r.destinationType) {
    params.destination_type = r.destinationType
    lines.push(['Where people convert (destination)', null, r.destinationType])
    if (BETA_DESTINATIONS.has(r.destinationType)) warnings.push(`Meta calls the ${r.destinationType} destination a limited or closed beta: its check says whether this account may use it.`)
  }
  if (c.budgetSharing === true) warnings.push(`${camp} shares budget between its ad sets: Meta needs every ad set of it to have one spec (same goal, billing and bid strategy) — 4834009.`)

  // ── budget (no campaign budget) or minimum / cap (under one) ──
  if (r.dailyBudgetCents !== undefined && r.lifetimeBudgetCents !== undefined) return { refusal: 'Name a daily or a lifetime budget, not both.' }
  const startSec = r.startTime !== undefined ? Number(unixSecondsParam(r.startTime)) : null
  let endSec: number | null | undefined
  if (r.endTime !== undefined) {
    endSec = r.endTime === null ? null : Number(unixSecondsParam(r.endTime))
    if (endSec !== null && endSec <= nowSec) return { refusal: `The end time ${r.endTime} has passed: Meta refuses an end in the past (1487033).` }
    if (endSec !== null && startSec !== null && endSec <= startSec) return { refusal: 'The end time comes after the start time.' }
  }
  if (cbo) {
    if (r.dailyBudgetCents !== undefined || r.lifetimeBudgetCents !== undefined) return { refusal: `${camp} has a campaign budget: its ad sets take none of their own (a minimum spend or a spend cap instead: minSpendTargetCents, spendCapCents).` }
    if (r.budgetSchedules?.length) return { refusal: `${camp} has a campaign budget: schedule increases on the campaign (set-meta-budget-schedule), not on its ad sets.` }
    lines.push(['Budget', null, `the campaign's ${cboType} budget (${money(metaUnitsToMinor(c.dailyBudget ?? c.lifetimeBudget, cur), cur)})`])
    if (cboType === 'lifetime' && !endSec) return { refusal: `${camp} has a lifetime budget: each of its ad sets needs an end time (endTime).` }
    if (r.minSpendTargetCents !== undefined) {
      params[`${cboType}_min_spend_target`] = minSpendTargetParam(r.minSpendTargetCents, cur)
      lines.push([`Minimum spend (${cboType}, Meta's best effort)`, null, money(r.minSpendTargetCents, cur)])
    }
    if (r.spendCapCents !== undefined) {
      params[`${cboType}_spend_cap`] = adSetSpendCapParam(r.spendCapCents, cur)
      lines.push([`Spend cap (${cboType})`, null, money(r.spendCapCents, cur)])
    }
  } else {
    if (r.minSpendTargetCents !== undefined || r.spendCapCents !== undefined) return { refusal: 'A minimum spend or a spend cap is for an ad set under a campaign budget; this campaign has none — name the ad set\'s own budget.' }
    if (r.dailyBudgetCents === undefined && r.lifetimeBudgetCents === undefined) return { refusal: `${camp} has no campaign budget: name this ad set's own budget (dailyBudgetCents or lifetimeBudgetCents). Meta needs a budget at one of the two.` }
    const type = r.dailyBudgetCents !== undefined ? 'daily' : 'lifetime'
    const cents = (type === 'daily' ? r.dailyBudgetCents : r.lifetimeBudgetCents)!
    // Review B7 — ad set budget sharing shares DAILY budgets (bidding/guides/adset-budget-sharing.md).
    if (type === 'lifetime' && c.budgetSharing === true) return { refusal: `${camp} shares budget between its ad sets: Meta shares daily budgets only — name a daily budget (dailyBudgetCents).` }
    if (type === 'lifetime' && !endSec) return { refusal: 'A lifetime budget needs an end time (endTime).' }
    if (type === 'daily' && endSec) {
      const start = startSec ?? nowSec
      if (endSec - start <= 86_400) return { refusal: 'A daily budget is for an ad set that runs longer than 24 hours (Meta): give a later end time, or a lifetime budget.' }
    }
    params[`${type}_budget`] = budgetParam(cents, cur)
    lines.push([`Budget (${type})`, null, money(cents, cur)])
    warnings.push('Meta may spend up to 75% more than a daily budget on a day (never more than 7 daily budgets in a week); Meta\'s check says whether the budget meets its minimum.')
  }

  // ── bid strategy, bid, ROAS goal ──
  // Review B2 — under ad set budget sharing every ad set takes the campaign's strategy (one spec, 4834009), read live.
  const sharing = !cbo && c.budgetSharing === true
  if (sharing && !c.bidStrategy) return { refusal: `${camp} shares budget between its ad sets, and Nexus could not read its bid strategy, which every ad set of it takes (4834009).` }
  const strategy = cbo || sharing ? c.bidStrategy : (r.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP')
  if (cbo && r.bidStrategy && r.bidStrategy !== c.bidStrategy) return { refusal: `${camp} has a campaign budget: its bid strategy (${c.bidStrategy ?? 'unknown'}) is every ad set's — change it with set-meta-campaign.` }
  if (sharing && r.bidStrategy && r.bidStrategy !== c.bidStrategy) return { refusal: `${camp} shares budget between its ad sets: every ad set takes its bid strategy (${c.bidStrategy}) — Meta refuses another (4834009).` }
  if (!cbo) { params.bid_strategy = strategy!; lines.push([sharing ? 'Bid strategy (the campaign\'s: budget sharing)' : 'Bid strategy (sent explicitly)', null, strategy]) }
  if (strategy && CAPS.has(strategy)) {
    if (r.bidAmountCents === undefined) return { refusal: `A ${strategy === 'COST_CAP' ? 'cost cap' : 'bid cap'} strategy needs this ad set's cap (bidAmountCents, ${bidAmountMeaning(billing)}).` }
    if (strategy === 'COST_CAP' && billing !== 'IMPRESSIONS') return { refusal: 'A cost cap needs billing on impressions (Meta\'s bid strategy guide).' }
    params.bid_amount = bidAmountParam(r.bidAmountCents, cur)
    lines.push([`Bid (${bidAmountMeaning(billing)})`, null, money(r.bidAmountCents, cur)])
  } else if (r.bidAmountCents !== undefined) {
    return { refusal: `A bid amount goes with a bid cap or cost cap strategy; ${strategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'a ROAS goal takes none (Meta)' : `this ad set bids automatically (${strategy ?? 'no cap'})`}.` }
  }
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    if (r.optimizationGoal !== 'VALUE') return { refusal: 'A ROAS goal needs the VALUE performance goal (Meta\'s bid strategy guide).' }
    if (r.roasGoal === undefined) return { refusal: 'A ROAS goal strategy needs this ad set\'s minimum ROAS (roasGoal).' }
  }
  if (r.roasGoal !== undefined) {
    if (strategy !== 'LOWEST_COST_WITH_MIN_ROAS') return { refusal: `A minimum ROAS goes with the LOWEST_COST_WITH_MIN_ROAS strategy${cbo ? ' (the campaign\'s, under a campaign budget)' : ' (bidStrategy)'}.` }
    params.bid_constraints = JSON.stringify({ roas_average_floor: roasFloorParam(r.roasGoal) })
    lines.push(['Minimum ROAS', null, r.roasGoal])
  }

  // ── start, end (daily: null = no end) ──
  if (startSec !== null) { params.start_time = String(startSec); lines.push(['Starts', null, new Date(startSec * 1000).toISOString()]) }
  if (endSec !== undefined) { params.end_time = endSec === null ? '0' : String(endSec); lines.push(['Ends', null, endSec === null ? 'no end (runs on)' : new Date(endSec * 1000).toISOString()]) }
  if (endSec === null && (params.lifetime_budget || cboType === 'lifetime')) return { refusal: 'A lifetime budget needs an end time.' }

  // ── attribution (step 18's presets and Meta's table) ──
  if (r.attribution) {
    const allowed = allowedAttribution(c.objective, r.optimizationGoal)
    if (!allowed.includes(r.attribution)) return { refusal: `Meta allows ${allowed.join(', ')} for a ${c.objective ?? 'campaign'} with the ${r.optimizationGoal} goal (its attribution_spec table).` }
    params.attribution_spec = PRESET_SPEC[r.attribution]
    lines.push(['Attribution for optimisation', null, r.attribution])
  }

  // ── promoted object (AS-063, AS-066) ──
  const asked: AdSetPromotedAsk = r.promotedObject ?? {}
  const merged: Record<string, string> = promotedMerged(null, asked)
  if (asked.pageId) {
    if (!live.pageId || asked.pageId !== live.pageId) return { refusal: `Page ${asked.pageId} is not the Facebook Page this business chose in Nexus (Settings › Channels › Meta): a new ad set promotes only that Page.` }
    merged.page_id = asked.pageId
  }
  if (asked.customConversionId) merged.custom_conversion_id = asked.customConversionId
  if (asked.boostedProductSetId) {
    if (!merged.product_set_id) return { refusal: 'A product set to push harder (boostedProductSetId) goes with the catalog\'s product set (productSetId).' }
    merged.boosted_product_set_id = asked.boostedProductSetId
    warnings.push('Pushing one product set harder inside a catalog ad set is a feature Meta gives some accounts only: its check says whether this one may.')
  }
  const problem = promotedProblem(merged, live)
  if (problem) return { refusal: problem }
  if (merged.pixel_id && !merged.custom_event_type) return { refusal: 'A pixel goes with its conversion event (customEventType): Meta requires one with a pixel.' }
  const salesGoal = c.objective === 'OUTCOME_SALES' && (r.optimizationGoal === 'OFFSITE_CONVERSIONS' || r.optimizationGoal === 'VALUE')
  if (salesGoal && !(merged.pixel_id || merged.product_set_id || merged.custom_conversion_id)) {
    return { refusal: `A Sales ad set optimised for ${r.optimizationGoal} needs what it counts: a pixel and its event (promotedObject.pixelId + customEventType), a custom conversion or a catalog's product set.` }
  }
  if (c.objective === 'OUTCOME_LEADS' && r.destinationType === 'ON_AD' && !merged.page_id) return { refusal: 'A Leads ad set with instant forms (ON_AD) names its Page (promotedObject.pageId: the Page this business chose).' }
  if (Object.keys(merged).length) {
    params.promoted_object = JSON.stringify(merged)
    lines.push(['Promoted object', null, params.promoted_object])
  }

  // ── dynamic creative (AS-073) and placement asset customization (AS-080) ──
  if (r.dynamicCreative) {
    params.is_dynamic_creative = 'true'
    lines.push(['Dynamic creative', null, 'on — for this ad set\'s life (Meta: create only)'])
    warnings.push('A dynamic creative ad set takes one creative with an asset feed (create-meta-creative); its ads cannot be deleted one by one (delete the ad set), Meta shows no learning information for it, and a creative with placement asset customization cannot run in it (Meta: such a creative needs is_dynamic_creative false).')
  }

  // ── scheduled budget increases (AS-089) ──
  if (r.budgetSchedules?.length) {
    if (r.dailyBudgetCents === undefined) return { refusal: 'Scheduled budget increases are for an ad set daily budget (dailyBudgetCents): Meta schedules daily budgets only.' }
    if (live.capabilities && !live.capabilities.includes('CAN_USE_BUDGET_SCHEDULING_API')) return { refusal: 'This ad account does not have Meta\'s budget scheduling (CAN_USE_BUDGET_SCHEDULING_API is not among its capabilities): Meta grants it.' }
    if (!live.capabilities) warnings.push('Meta did not say whether this account may schedule budgets (CAN_USE_BUDGET_SCHEDULING_API): its check decides.')
    const specs = scheduleSpecs(r.budgetSchedules, r.dailyBudgetCents, cur, now)
    params.budget_schedule_specs = specs.value
    lines.push(['Scheduled budget increases', null, specs.words.join('; ')])
    warnings.push('Once the ad set is on, Meta raises its daily budget during those periods (one-time; Meta documents no way to change or remove one — deleting the ad set removes them).')
  }

  // ── targeting (minimal; Advantage+ audience sent explicitly) and the EU payer / beneficiary ──
  const t = createTargeting(r.targeting)
  params.targeting = t.value
  lines.push(['Who sees it', null, t.words.join('; ')])
  lines.push(['Advantage+ audience (sent explicitly)', null, r.targeting.advantageAudience ? 'on (1): Meta may reach beyond the ages, gender and audiences named' : 'off (0)'])
  lines.push(['Placements', null, 'Advantage+ placements (Meta\'s default: all its placements; set-meta-placements narrows them)'])
  // Review B3 — WhatsApp marketing messages: with Advantage+ placements Meta adds them for eligible campaigns of an
  // onboarded account (marketing-api/marketing-messages.md; OCC 2026-08-13) — a silent opt-in, named here.
  const whatsApp = whatsAppEligible(c.objective, r.optimizationGoal) ? live.whatsApp : undefined
  let whatsAppOn = false
  if (whatsApp && 'unread' in whatsApp) {
    warnings.push(`Nexus could not read whether this ad account is onboarded to WhatsApp marketing messages (${whatsApp.unread.replace(/\.$/, '')}): if it is, Meta adds them to this ad set's Advantage+ placements (set-meta-placements leaves them out).`)
  } else if (whatsApp && 'status' in whatsApp && whatsApp.status === 'MARKETING_MESSAGE_ONBOARDED') {
    whatsAppOn = true
    lines.push(['WhatsApp marketing messages', null, 'Meta adds WhatsApp marketing messages to this ad set\'s placements (Advantage+ placements; the account is onboarded)'])
    warnings.push('Meta adds WhatsApp marketing messages to this ad set\'s placements: with Advantage+ placements an onboarded account\'s eligible ad sets also message its WhatsApp messaging customer base (set-meta-placements leaves them out).')
  }
  if (r.targeting.advantageAudience) warnings.push('Advantage+ audience treats the ages, gender and audiences named as suggestions: Meta may show the ads to people outside them (never outside the locations, the minimum age or excluded audiences).')
  if ((c.specialAdCategories ?? []).some((x) => x !== 'NONE')) warnings.push(`${camp} is in a special ad category: Meta refuses age, gender and narrow-radius limits there; its check says so before anything is made.`)
  if (t.eu) {
    if (r.dsa) {
      params.dsa_payor = r.dsa.payor
      params.dsa_beneficiary = r.dsa.beneficiary
      lines.push(['EU payer / beneficiary (shown to people in the EU)', null, `${r.dsa.payor} / ${r.dsa.beneficiary}`])
    } else if (live.dsaDefaults) {
      lines.push(['EU payer / beneficiary (shown to people in the EU)', null, `the ad account's saved defaults: ${live.dsaDefaults.payor} / ${live.dsaDefaults.beneficiary} (Meta fills them in)`])
    } else {
      return { refusal: `This ad set may reach people in the EU (${t.euWhy}): Meta needs who pays for its ads and who benefits from them (EU Digital Services Act), and the ad account has no saved default. Name both: dsa { payor, beneficiary }.` }
    }
  } else if (r.dsa) warnings.push('This ad set does not reach the EU: Meta keeps no payer and beneficiary for it, so they are not sent.')

  // ── Advantage+ (CMP-028): what this ad set does for its campaign ──
  if (cbo && c.objective && ADVANTAGE_OBJECTIVES.has(c.objective) && r.targeting.advantageAudience) {
    warnings.push(`With this ad set (Advantage+ audience on, no placement targeting) ${camp} meets Meta's Advantage+ levers with its campaign budget: Meta reads it as ${c.objective === 'OUTCOME_SALES' ? 'ADVANTAGE_PLUS_SALES' : 'ADVANTAGE_PLUS_LEADS'} (meta-campaigns shows advantage_state).`)
  }

  // ── status: born PAUSED ──
  params.status = createStatus(r.activate)
  lines.push(['Status', null, r.activate ? 'ACTIVE (your decision)' : 'PAUSED (switch it on with set-meta-status: your decision)'])
  if (r.activate) {
    const where = whatsAppOn ? ' (in its placements and in WhatsApp marketing messages)' : ''
    spendsMoney.push(c.status === 'ACTIVE'
      ? `Made ACTIVE in an active campaign: ${who} spends${where} once an ad under it is on and approved — none exists yet.`
      : `Made ACTIVE, but nothing spends until ${camp} is on too (it is ${c.status ?? 'not on'}) and an ad under the ad set is on${whatsAppOn ? '; then it spends in its placements and in WhatsApp marketing messages' : ''}.`)
  }

  const { changes, more } = changeLines(lines)
  const request: MetaChangeRequest = {
    step: 1,
    label: `Make ${who} in ${camp} (${params.status})`,
    kind: 'adset',
    objectKind: 'adaccount',
    objectId: `act_${live.adAccountId}`,
    edge: 'adsets',
    params,
    check: 'meta',
    recommendations: true,
    recordEvenIfNotAsAsked: true,
    raisesSpend: r.activate === true,
    readBackInPost: false,
    budget: false,
    undoable: false,
    operation: 'adset.create',
    // What Meta must read back as sent (not the name: Meta may store a typed name in its own normal form).
    expect: Object.fromEntries(Object.entries(params).filter(([k]) => ['status', 'optimization_goal', 'billing_event', 'daily_budget', 'lifetime_budget', 'bid_amount', 'campaign_id'].includes(k))),
    readBackFields: 'id,name,status,effective_status,campaign_id,optimization_goal,billing_event,daily_budget,lifetime_budget,bid_strategy,bid_amount',
  }
  return {
    summary: `Meta: ${request.label}.`,
    changes,
    totals: { requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'A new ad set has no ads: create-meta-ad makes them. Its undo deletes the ad set while nothing else hangs under it and it has spent nothing (read live first).'],
    spendsMoney,
    skipped: [],
    requests: [request],
    stands: {
      campaign: { ...c, effectiveStatus: undefined }, currency: cur, pixels: live.pixels ? [...live.pixels].sort() : null, catalogProblem: live.catalogProblem ?? null,
      pageId: live.pageId, dsaDefaults: live.dsaDefaults, capabilities: live.capabilities ? [...live.capabilities].sort() : null,
    },
    before: nothingMade('create'),
    after: nothingMade('create'),
  }
}
