/**
 * Meta step 19 — create-meta-campaign as a draft: a new campaign on the business's chosen ad account, born PAUSED (ACTIVE
 * only when the person asks: SPENDS MONEY). Master rows CMP-020–029, 031–033, 035, 040, 058, 074, 077, 087. ONE request:
 * POST /act_{id}/campaigns, checked by Meta first (validate_only, with its setup recommendations — include_recommendations).
 * Pure: the request and the live state in, the draft (or a refusal in words) out.
 *
 * Meta's rules it follows (checked 2026-10-21 on developers.facebook.com/documentation/ads-commerce/marketing-api/…):
 *   - reference/ad-campaign-group.md "Creating": name, objective, special_ad_categories (required; `[]` = none), status
 *     ACTIVE | PAUSED only, daily_budget / lifetime_budget (Advantage+ campaign budget: "All adsets under this campaign will
 *     share this budget"; never with ad set budgets), bid_strategy (Meta defaults a create WITHOUT one to a bid cap, so
 *     every ad set would need a bid: Nexus always sends one — facts F1 M3b-01), buying_type AUCTION | RESERVED (R&F: no
 *     spend cap, not with special categories), spend_cap (≈ USD 100 at least), promoted_object, budget_schedule_specs,
 *     source_campaign_id ("used if a campaign has been copied": bookkeeping), execution_options. "Objective Validation":
 *     legacy objectives are deprecated since v17 — the tool takes the six OUTCOME_ ones only (CMP-027).
 *   - bidding/guides/adset-budget-sharing.md (v24+): a campaign without a campaign budget must say
 *     is_adset_budget_sharing_enabled at create (4834011) — Nexus sends false unless asked; on, it needs a bid strategy
 *     (4834005) and ad sets of one spec (4834009), and can be switched off later but never on again (3858418).
 *   - audiences/special-ad-category.md: special_ad_category_country goes with any category; ISSUES_ELECTIONS_POLITICS is
 *     banned in the EU since 2025-10-06 (never sent); CREDIT was replaced by FINANCIAL_PRODUCTS_SERVICES.
 *   - advantage-campaigns.md (RECHECK CMP-028 / CMP-029 CONFIRMED): no Advantage+ field: OUTCOME_SALES (or _LEADS / _APP_
 *     PROMOTION) + a campaign budget with a supported bid strategy + no placement targeting on any ad set + Advantage+
 *     audience on at least one ad set → advantage_state ADVANTAGE_PLUS_SALES (read only, derived).
 *   - bidding/overview/bid-strategy.md: LOWEST_COST_WITH_MIN_ROAS is value optimisation (OUTCOME_SALES, app installs) and
 *     cannot be switched away under a campaign budget (RECHECK AS-051).
 *   - out-of-cycle-changes/occ-2026.md (2026-10-22, all versions): is_pca_unified, OUTCOME_SALES only, immutable after
 *     creation — refused before 2026-10-22T00:00Z; LIVE-PROBES CMP-087.
 *   - CMP-026 (app promotion): Nexus links no app to a business, and each ad set of such a campaign needs the app's id and
 *     store URL — refused in words (master row: "refuse unless an app is linked").
 *   - CMP-074 (marketing-message campaigns, POST /act_{id}/message_campaign): Meta's SDK only (adaccount.py
 *     create_message_campaign: bid_amount, daily_budget, end_time, lifetime_budget, name, page_id, pixel_id, start_time —
 *     NO status, so Nexus could not make it paused; no reference page: RECHECK STILL-UNVERIFIED) and it needs Meta's
 *     marketing-messages onboarding — not built, said in words (CREATE_CAMPAIGN_NOT_SENT).
 */
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { money } from './change-settings-common.js'
import { promotedMerged, promotedProblem, type MetaBidStrategy, type MetaObjective, type PromotedObjectAsk } from './change-campaign-settings.js'
import { createStatus, nothingMade, scheduleSpecs, type ScheduleAsk } from './change-create-common.js'
import type { LiveCampaign } from './live-settings.js'
import { budgetParam, campaignSpendCapParam, MetaUnitError } from './settings-units.js'
import { META_PCA_UNIFIED_FROM, type CREATE_SPECIAL_AD_CATEGORIES } from '../../gateway/meta-create-rules.js'

export type CreateSpecialCategory = typeof CREATE_SPECIAL_AD_CATEGORIES[number]

export interface CampaignCreateRequest {
  name: string
  objective: MetaObjective
  /** None: `[]` is sent (Meta requires the field on every create). */
  specialAdCategories?: CreateSpecialCategory[]
  specialAdCategoryCountries?: string[]
  dailyBudgetCents?: number
  lifetimeBudgetCents?: number
  bidStrategy?: MetaBidStrategy
  /** Ad set budget sharing (no campaign budget only): sent false unless true is asked. */
  budgetSharing?: boolean
  spendCapCents?: number
  buyingType?: 'AUCTION' | 'RESERVED'
  promotedObject?: PromotedObjectAsk
  budgetSchedules?: ScheduleAsk[]
  sourceCampaignId?: string
  /** Check the Advantage+ levers Nexus can set on the campaign (Meta derives Advantage+; it sends nothing of its own). */
  advantagePlus?: boolean
  pcaUnified?: boolean
  activate?: boolean
}

export interface CampaignCreateLive {
  adAccountId: string
  currency: string | null
  /** The account's own pixels (read when a pixel is named). */
  pixels: Set<string> | null
  /** The catalog rule's answer (null: it may; undefined: none named). */
  catalogProblem?: string | null
  /** The account's capabilities (read for scheduled increases; null: Meta did not say). */
  capabilities: string[] | null
  /** The campaign a sourceCampaignId names (read live: of the chosen account). */
  source: LiveCampaign | null
}

/** Answers in words for what create-meta-campaign does not make (CMP-026, CMP-074, AS-032's inline campaign). */
export const CREATE_CAMPAIGN_NOT_SENT = [
  'App promotion campaigns: Nexus links no app to a business, and each ad set would need the app\'s id and store URL — make them in Ads Manager.',
  'Marketing-message campaigns (Meta\'s message_campaign): only in Meta\'s SDK, with no status (so never paused) and Meta\'s marketing-messages onboarding — set them up in Ads Manager.',
  'Legacy objectives (CONVERSIONS, LINK_CLICKS, …): Meta deprecated them in v17 — the six OUTCOME_ objectives only.',
]

const CAPS: ReadonlySet<string> = new Set(['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'])
const VALUE_OBJECTIVES: ReadonlySet<string> = new Set(['OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'])
const STRATEGY_WORDS: Readonly<Record<string, string>> = {
  LOWEST_COST_WITHOUT_CAP: 'highest volume (no cap)', LOWEST_COST_WITH_BID_CAP: 'bid cap', COST_CAP: 'cost per result goal', LOWEST_COST_WITH_MIN_ROAS: 'ROAS goal',
}

export function campaignCreateDraft(request: CampaignCreateRequest, live: CampaignCreateLive, now: Date = new Date()): MetaChangeDraft | { refusal: string } {
  try {
    return draft(request, live, now)
  } catch (err) {
    if (err instanceof MetaUnitError) return { refusal: err.message }
    throw err
  }
}

function draft(r: CampaignCreateRequest, live: CampaignCreateLive, now: Date): MetaChangeDraft | { refusal: string } {
  const cur = live.currency
  if (!r.name?.trim()) return { refusal: 'Name the new campaign (name).' }
  if (!r.objective) return { refusal: 'Name its objective: OUTCOME_SALES, OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT, OUTCOME_LEADS or OUTCOME_AWARENESS.' }
  if (r.objective === 'OUTCOME_APP_PROMOTION') return { refusal: CREATE_CAMPAIGN_NOT_SENT[0] }
  const who = `campaign "${r.name}"`
  const params: Record<string, string> = { name: r.name, objective: r.objective }
  const lines: Array<[string, unknown, unknown]> = [['Campaign', 'none', `"${r.name}"`], ['Objective', null, r.objective]]
  const warnings: string[] = []
  const spendsMoney: string[] = []

  // ── special ad categories (CMP-033): always sent, [] when none ──
  const categories = [...new Set(r.specialAdCategories ?? [])]
  params.special_ad_categories = JSON.stringify(categories)
  if (categories.length) {
    const countries = [...new Set(r.specialAdCategoryCountries ?? [])]
    if (!countries.length) return { refusal: 'A special ad category needs the countries it applies to (specialAdCategoryCountries): Meta requires them with any category.' }
    params.special_ad_category_country = JSON.stringify(countries)
    lines.push(['Special ad category (sent explicitly)', null, `${categories.join(', ')} (${countries.join(', ')})`])
    warnings.push(`A special ad category (${categories.join(', ')}) limits the targeting Meta allows in every ad set (age, gender, place, some audiences): Meta refuses ad sets that break it.`)
  } else {
    if (r.specialAdCategoryCountries?.length) return { refusal: 'Countries go with a special ad category: name the category (specialAdCategories) or leave the countries out.' }
    lines.push(['Special ad category (sent explicitly)', null, 'none ([])'])
  }

  // ── budget (CMP-035) and ad set budget sharing (CMP-040) ──
  if (r.dailyBudgetCents !== undefined && r.lifetimeBudgetCents !== undefined) return { refusal: 'Name a daily or a lifetime campaign budget, not both.' }
  const cbo = r.dailyBudgetCents !== undefined || r.lifetimeBudgetCents !== undefined
  if (cbo) {
    const type = r.dailyBudgetCents !== undefined ? 'daily' : 'lifetime'
    const cents = (type === 'daily' ? r.dailyBudgetCents : r.lifetimeBudgetCents)!
    params[`${type}_budget`] = budgetParam(cents, cur)
    lines.push([`Campaign budget (${type}, Advantage+ campaign budget)`, null, money(cents, cur)])
    if (r.budgetSharing) return { refusal: 'Ad set budget sharing is for a campaign WITHOUT a campaign budget (its ad sets keep their own budgets and share up to 20%).' }
    warnings.push(`Its ad sets share the campaign's ${type} budget: they take no budget of their own${type === 'lifetime' ? ', and each needs an end time' : ''}. Meta may spend up to 75% more than a daily budget on a day (never more than 7 daily budgets in a week).`)
  } else {
    params.is_adset_budget_sharing_enabled = String(r.budgetSharing === true)
    lines.push(['Ad set budget sharing (sent explicitly: Meta requires the choice since v24)', null, r.budgetSharing ? 'on (ad sets may share up to 20% of their budgets)' : 'off'])
    if (r.budgetSharing) warnings.push('With ad set budget sharing on, Meta needs every ad set to have one spec (same goal, billing and bid strategy) and lets it go off later but never on again for a running campaign.')
    lines.push(['Budget', null, 'on each ad set (create-meta-ad-set names it)'])
  }

  // ── bid strategy: always sent (Meta defaults a create without one to a bid cap) ──
  const strategy = r.bidStrategy ?? 'LOWEST_COST_WITHOUT_CAP'
  params.bid_strategy = strategy
  lines.push(['Bid strategy (sent explicitly)', null, STRATEGY_WORDS[strategy]])
  if (strategy === 'LOWEST_COST_WITH_MIN_ROAS') {
    if (!VALUE_OBJECTIVES.has(r.objective)) return { refusal: 'A ROAS goal is value optimisation: Meta allows it for Sales (OUTCOME_SALES) campaigns.' }
    if (cbo) warnings.push('A ROAS goal under a campaign budget is for good: Meta never switches it to another bid strategy afterwards (only a copy into a new campaign can). Each ad set then needs the VALUE goal and its minimum ROAS (create-meta-ad-set roasGoal).')
  }
  if (CAPS.has(strategy)) warnings.push(`With a ${STRATEGY_WORDS[strategy]} every ad set needs its cap (create-meta-ad-set bidAmountCents).`)

  // ── spend cap, buying type (CMP-032) ──
  if (r.spendCapCents !== undefined) {
    params.spend_cap = campaignSpendCapParam(r.spendCapCents, cur)
    lines.push(['Spend cap (the most it spends over its whole run)', null, money(r.spendCapCents, cur)])
    warnings.push('Meta asks a campaign spend cap of about USD 100 (or the same in the account currency) at least; Meta\'s check says so before anything is made.')
  }
  if (r.buyingType === 'RESERVED') {
    if (r.spendCapCents !== undefined) return { refusal: 'Reach and frequency (RESERVED) campaigns take no spend cap (Meta).' }
    if (categories.length) return { refusal: 'Meta does not offer reach and frequency (RESERVED) with a special ad category.' }
    params.buying_type = 'RESERVED'
    lines.push(['Buying', null, 'reach and frequency (RESERVED)'])
    warnings.push('Reach and frequency buying needs a reservation per ad set (a reach and frequency prediction: create-meta-reach-frequency) and Meta\'s eligibility for this account; every ad set must match the campaign\'s buying type, and some ad set fields cannot change once reserved.')
  } else if (r.buyingType === 'AUCTION') params.buying_type = 'AUCTION'

  // ── promoted object (campaign level) ──
  if (r.promotedObject) {
    if (r.promotedObject.pixelRule !== undefined) return { refusal: 'A pixel rule is an ad set\'s (create-meta-ad-set promotedObject.pixelRule): Meta\'s campaign promoted object does not take one.' }
    const merged = promotedMerged(null, r.promotedObject)
    const problem = promotedProblem(merged, live)
    if (problem) return { refusal: problem }
    if (merged.pixel_id && !merged.custom_event_type) return { refusal: 'A pixel goes with its conversion event (customEventType): Meta requires one with a pixel.' }
    params.promoted_object = JSON.stringify(merged)
    lines.push(['Promoted object', null, params.promoted_object])
  }

  // ── scheduled budget increases at create (CMP-058) ──
  if (r.budgetSchedules?.length) {
    if (r.dailyBudgetCents === undefined) return { refusal: 'Scheduled budget increases are for a campaign daily budget (dailyBudgetCents): Meta schedules daily budgets only.' }
    if (live.capabilities && !live.capabilities.includes('CAN_USE_BUDGET_SCHEDULING_API')) return { refusal: 'This ad account does not have Meta\'s budget scheduling (CAN_USE_BUDGET_SCHEDULING_API is not among its capabilities): Meta grants it.' }
    if (!live.capabilities) warnings.push('Meta did not say whether this account may schedule budgets (CAN_USE_BUDGET_SCHEDULING_API): its check decides.')
    const specs = scheduleSpecs(r.budgetSchedules, r.dailyBudgetCents, cur, now)
    params.budget_schedule_specs = specs.value
    lines.push(['Scheduled budget increases', null, specs.words.join('; ')])
    warnings.push(`Once the campaign is on, Meta raises its daily budget during ${specs.words.length === 1 ? 'that period' : 'those periods'} (one-time; Meta documents no way to change or remove one later — deleting the campaign removes them).`)
    if (specs.words.some((w) => w.includes('whole'))) warnings.push(`Meta does not document the unit of an increase by an amount: Nexus sends whole ${cur ?? 'currency units'} (read as cents it would be 100 times smaller, never larger).`)
  }

  // ── where it was copied from (CMP-077): bookkeeping ──
  if (r.sourceCampaignId) {
    if (!live.source) return { refusal: `Nexus could not read campaign ${r.sourceCampaignId} of this ad account.` }
    params.source_campaign_id = live.source.id
    lines.push(['Copied from (bookkeeping)', null, `campaign "${live.source.name ?? 'no name'}" (${live.source.id})`])
    warnings.push('source_campaign_id is bookkeeping only (Meta fills it on its own copies): it copies nothing — copy-meta-ads copies a campaign.')
  }

  // ── Advantage+ (CMP-028 / CMP-029): Meta derives it; Nexus checks the campaign's levers ──
  if (r.advantagePlus) {
    if (r.objective !== 'OUTCOME_SALES' && r.objective !== 'OUTCOME_LEADS') return { refusal: 'Advantage+ is a Sales or Leads campaign (app campaigns are not made here): Meta derives it from OUTCOME_SALES / OUTCOME_LEADS with a campaign budget.' }
    if (!cbo) return { refusal: 'An Advantage+ campaign has a campaign budget (dailyBudgetCents or lifetimeBudgetCents): Meta counts it only with Advantage+ campaign budget on.' }
    if (categories.length) warnings.push('In a special ad category Meta restricts Advantage+ audience: whether the campaign reads as Advantage+ is Meta\'s.')
    lines.push(['Advantage+', null, `${r.objective === 'OUTCOME_SALES' ? 'Advantage+ sales' : 'Advantage+ leads'} once its ad sets allow it`])
    warnings.push(`Meta has no Advantage+ switch: it reads the campaign as ${r.objective === 'OUTCOME_SALES' ? 'ADVANTAGE_PLUS_SALES' : 'ADVANTAGE_PLUS_LEADS'} (advantage_state, read only) once at least one ad set has Advantage+ audience on (create-meta-ad-set advantageAudience: true) and no ad set has placement targeting or exclusions (Nexus's ad sets have none at create). Any later edit that breaks a lever turns it off without a warning; meta-campaigns shows the state.`)
  }

  // ── unified PCA flow (CMP-087): from 2026-10-22 only ──
  if (r.pcaUnified) {
    if (now.getTime() < META_PCA_UNIFIED_FROM) return { refusal: 'Meta makes is_pca_unified available on 2026-10-22 (an out-of-cycle change): ask again from then.' }
    if (r.objective !== 'OUTCOME_SALES') return { refusal: 'The unified PCA flow (is_pca_unified) is for Sales (OUTCOME_SALES) campaigns only.' }
    params.is_pca_unified = 'true'
    lines.push(['Unified PCA flow (is_pca_unified)', null, 'on — for good (Meta: immutable after creation)'])
    warnings.push('is_pca_unified cannot be changed after the campaign is made (Meta). It is not on Meta\'s campaign reference yet: Meta\'s check and answer decide (LIVE-PROBES CMP-087).')
  }

  // ── status: born PAUSED ──
  params.status = createStatus(r.activate)
  lines.push(['Status', null, r.activate ? 'ACTIVE (your decision)' : 'PAUSED (switch it on with set-meta-status: your decision)'])
  if (r.activate) spendsMoney.push(`Made ACTIVE: ${who} spends once an ad set and an ad under it are on too — none exists yet, so nothing spends until they are made and switched on.`)

  const { changes, more } = changeLines(lines)
  const request: MetaChangeRequest = {
    step: 1,
    label: `Make ${who} (${r.objective}, ${params.status})`,
    kind: 'campaign',
    objectKind: 'adaccount',
    objectId: `act_${live.adAccountId}`,
    edge: 'campaigns',
    params,
    // Meta documents validate_only (and include_recommendations) on creates: a create checked by Meta makes nothing.
    check: 'meta',
    recommendations: true,
    raisesSpend: r.activate === true,
    readBackInPost: false,
    budget: false,
    undoable: false,
    operation: 'campaign.create',
    // What Meta must read back as sent (not the name: Meta may store a typed name in its own normal form).
    expect: Object.fromEntries(Object.entries(params).filter(([k]) => ['objective', 'status', 'bid_strategy', 'daily_budget', 'lifetime_budget'].includes(k))),
    readBackFields: 'id,name,status,effective_status,objective,bid_strategy,daily_budget,lifetime_budget',
  }
  return {
    summary: `Meta: ${request.label}.`,
    changes,
    totals: { requests: 1, ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'Its undo deletes the campaign while nothing else hangs under it and it has spent nothing (read live first).'],
    spendsMoney,
    skipped: [],
    requests: [request],
    stands: {
      adAccountId: live.adAccountId, currency: cur, pixels: live.pixels ? [...live.pixels].sort() : null, catalogProblem: live.catalogProblem ?? null,
      capabilities: live.capabilities ? [...live.capabilities].sort() : null, source: live.source ? { id: live.source.id, status: live.source.status } : null,
    },
    before: nothingMade('create'),
    after: nothingMade('create'),
  }
}
