/**
 * Google Ads changes, PR 2 (2026-10-15) — campaigns: make a Standard Shopping or a Search campaign (ALWAYS paused: Google
 * would make it ENABLED by default), and change a campaign's settings (name, Shopping priority, bidding, dates, networks,
 * the location option, AI Max, campaign broad match, text customization, final URL expansion, its own budget).
 *
 * Checked on 2026-10-15 in Google's v25 reference: Campaign.status "When a new campaign is added, the status defaults to
 * ENABLED"; contains_eu_political_advertising is required on create (DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING /
 * CONTAINS_EU_POLITICAL_ADVERTISING); start_date_time / end_date_time "yyyy-MM-dd HH:mm:ss" in the account's time zone
 * (00:00:00 / 23:59:59 for whole days; an end cleared = runs on); shopping_setting.campaign_priority 0–2 (required for
 * Shopping), merchant_id required on create and immutable, feed_label ≤ 20 of A–Z 0–9 - _; geo_target_type_setting
 * PRESENCE | PRESENCE_OR_INTEREST | SEARCH_INTEREST; keyword_match_type can no longer be SET in v25
 * (CampaignError.CANNOT_SET_CAMPAIGN_KEYWORD_MATCH_TYPE: "Cannot set a campaign level match type") — Nexus only reads it;
 * ai_max_setting.enable_ai_max is the master switch of AI Max ("if false or cleared, no AI Max features serve"; whether text
 * customization needs it depends on the campaign: AiMaxSetting.bundling_required, so Google's check decides);
 * asset_automation_settings with TEXT_ASSET_AUTOMATION (text customization) and
 * FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION ("Enabling final URL expansion also enables text asset automation"),
 * OPTED_IN | OPTED_OUT. An update mask lists snake_case paths; a path in the mask with no value in the body is cleared.
 */
import { changeLines, money, type GoogleChangeDraft } from './change-draft.js'
import { microsOfCents, type LiveBudget, type LiveCampaign, type LiveCampaignDetail } from './live.js'
import type { GoogleMutateOperation } from './write-client.js'

export type Priority = 'LOW' | 'MEDIUM' | 'HIGH'
export type LocationOption = 'PRESENCE' | 'PRESENCE_OR_INTEREST'
export type Strategy = 'MANUAL_CPC' | 'MAXIMIZE_CLICKS' | 'MAXIMIZE_CONVERSIONS' | 'MAXIMIZE_CONVERSION_VALUE' | 'PORTFOLIO'
export interface Bidding { strategy: Strategy; maxCpcCents?: number; targetCpaCents?: number; targetRoas?: number; portfolioId?: string }
/** A schedule slot; `bidModifier` is the slot's bid adjustment (1.2 = +20 %, 0.1 = −90 %), none = no adjustment. */
export interface ScheduleSlot { days: string[]; from: string; to: string; bidModifier?: number }
/** One schedule criterion: Google's AdScheduleInfo and the criterion's bid adjustment (a CampaignCriterion field). */
export interface ScheduleCriterion { adSchedule: { dayOfWeek: string; startHour: number; startMinute: string; endHour: number; endMinute: string }; bidModifier?: number }

export const PRIORITY_NUMBER: Record<Priority, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 }
export const DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
const MINUTE: Record<string, string> = { '00': 'ZERO', '15': 'FIFTEEN', '30': 'THIRTY', '45': 'FORTY_FIVE' }
const DAY = /^\d{4}-\d{2}-\d{2}$/

// ── shared parts ───────────────────────────────────────────────────────────────────────────────────────────────

/** Google's bidding message for a strategy (create, or the switch to it). */
export function biddingFields(customer: string, b: Bidding): Record<string, unknown> {
  switch (b.strategy) {
    case 'MANUAL_CPC': return { manualCpc: { enhancedCpcEnabled: false } }
    case 'MAXIMIZE_CLICKS': return { targetSpend: b.maxCpcCents ? { cpcBidCeilingMicros: microsOfCents(b.maxCpcCents) } : {} }
    case 'MAXIMIZE_CONVERSIONS': return { maximizeConversions: b.targetCpaCents ? { targetCpaMicros: microsOfCents(b.targetCpaCents) } : {} }
    case 'MAXIMIZE_CONVERSION_VALUE': return { maximizeConversionValue: b.targetRoas ? { targetRoas: b.targetRoas } : {} }
    case 'PORTFOLIO': return { biddingStrategy: `${customer}/biddingStrategies/${b.portfolioId}` }
  }
}

/** The update mask paths of a bidding message (biddingFields). */
export function biddingMask(b: Bidding): string[] {
  switch (b.strategy) {
    // Always a leaf path: a message path that has sub-fields is refused (FieldMaskError.FIELD_HAS_SUBFIELDS). The leaf with
    // no value in the body switches the strategy and clears that target.
    case 'MANUAL_CPC': return ['manual_cpc.enhanced_cpc_enabled']
    case 'MAXIMIZE_CLICKS': return ['target_spend.cpc_bid_ceiling_micros']
    case 'MAXIMIZE_CONVERSIONS': return ['maximize_conversions.target_cpa_micros']
    case 'MAXIMIZE_CONVERSION_VALUE': return ['maximize_conversion_value.target_roas']
    case 'PORTFOLIO': return ['bidding_strategy']
  }
}

/** A person's words for a bidding setting. */
export function biddingText(b: Bidding, currency: string): string {
  switch (b.strategy) {
    case 'MANUAL_CPC': return 'Manual CPC'
    case 'MAXIMIZE_CLICKS': return `Maximize clicks${b.maxCpcCents ? `, max CPC ${money(b.maxCpcCents, currency)}` : ''}`
    case 'MAXIMIZE_CONVERSIONS': return `Maximize conversions${b.targetCpaCents ? `, target CPA ${money(b.targetCpaCents, currency)}` : ''}`
    case 'MAXIMIZE_CONVERSION_VALUE': return `Maximize conversion value${b.targetRoas ? `, target ROAS ${Math.round(b.targetRoas * 100)} %` : ''}`
    case 'PORTFOLIO': return `portfolio strategy ${b.portfolioId}`
  }
}

/** The bidding a campaign has now, from its settings. */
/** The bidding a campaign has now, from its settings; null when Nexus cannot name it (TARGET_ROAS, TARGET_CPA, …). */
export function biddingNow(c: LiveCampaignDetail['campaign']): Bidding | null {
  // A portfolio strategy first, whatever its type.
  if (c.biddingStrategyId) return { strategy: 'PORTFOLIO', portfolioId: c.biddingStrategyId }
  switch (c.bidding) {
    case 'MANUAL_CPC': return { strategy: 'MANUAL_CPC' }
    case 'TARGET_SPEND': return { strategy: 'MAXIMIZE_CLICKS', ...(c.maxCpcCeilingCents ? { maxCpcCents: c.maxCpcCeilingCents } : {}) }
    case 'MAXIMIZE_CONVERSIONS': return { strategy: 'MAXIMIZE_CONVERSIONS', ...(c.targetCpaCents ? { targetCpaCents: c.targetCpaCents } : {}) }
    case 'MAXIMIZE_CONVERSION_VALUE': return { strategy: 'MAXIMIZE_CONVERSION_VALUE', ...(c.targetRoas ? { targetRoas: c.targetRoas } : {}) }
    default: return null
  }
}

/** A bidding with only the fields its strategy uses (an extra field would read as a change forever). */
export function biddingClean(b: Bidding): Bidding {
  switch (b.strategy) {
    case 'MANUAL_CPC': return { strategy: 'MANUAL_CPC' }
    case 'MAXIMIZE_CLICKS': return { strategy: b.strategy, ...(b.maxCpcCents ? { maxCpcCents: b.maxCpcCents } : {}) }
    case 'MAXIMIZE_CONVERSIONS': return { strategy: b.strategy, ...(b.targetCpaCents ? { targetCpaCents: b.targetCpaCents } : {}) }
    case 'MAXIMIZE_CONVERSION_VALUE': return { strategy: b.strategy, ...(b.targetRoas ? { targetRoas: b.targetRoas } : {}) }
    case 'PORTFOLIO': return { strategy: b.strategy, portfolioId: b.portfolioId }
  }
}

/** "08:00" → [8, 'ZERO']; "24:00" only as an end. Null when Google cannot take it (minutes 00/15/30/45). */
export function timeOf(value: string, isEnd: boolean): [number, string] | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m || !(m[2] in MINUTE)) return null
  const hour = Number(m[1])
  if (hour > 24 || (hour === 24 && (!isEnd || m[2] !== '00'))) return null
  return [hour, MINUTE[m[2]]]
}

/** Ad schedule slots → one criterion per day and slot, or why not. Days: MONDAY … SUNDAY, or ALL. */
export function scheduleCriteria(slots: ScheduleSlot[]): ScheduleCriterion[] | { refusal: string } {
  const out: ScheduleCriterion[] = []
  for (const slot of slots) {
    const from = timeOf(slot.from, false)
    const to = timeOf(slot.to, true)
    if (!from || !to) return { refusal: `The schedule time ${slot.from}–${slot.to} is not one Google takes (HH:MM, minutes 00, 15, 30 or 45; 24:00 only as an end).` }
    if (from[0] * 60 + Number(Object.keys(MINUTE).find((k) => MINUTE[k] === from[1])) >= to[0] * 60 + Number(Object.keys(MINUTE).find((k) => MINUTE[k] === to[1]))) {
      return { refusal: `The schedule time ${slot.from}–${slot.to} ends before it starts.` }
    }
    const days = slot.days.map((d) => d.toUpperCase())
    const list = days.includes('ALL') ? [...DAYS] : days
    for (const day of list) {
      if (!(DAYS as readonly string[]).includes(day)) return { refusal: `"${day}" is not a day (MONDAY … SUNDAY, or ALL).` }
      if (slot.bidModifier !== undefined && !(slot.bidModifier >= 0.1 && slot.bidModifier <= 10)) return { refusal: `A schedule bid adjustment of ${slot.bidModifier} is outside what Google takes (0.1 – 10).` }
      out.push({ adSchedule: { dayOfWeek: day, startHour: from[0], startMinute: from[1], endHour: to[0], endMinute: to[1] }, ...(slot.bidModifier !== undefined && slot.bidModifier !== 1 ? { bidModifier: slot.bidModifier } : {}) })
    }
  }
  if (out.length > 6 * 7) return { refusal: 'Google allows at most 6 schedule slots a day.' }
  return out
}

/**
 * Why a bidding change can make the campaign spend more, or null: Google taking over the bids (any automated strategy
 * instead of another one), a higher max CPC ceiling (or none), a higher target CPA, a lower target ROAS.
 */
export function biddingSpends(from: Bidding | null, to: Bidding, currency: string): string | null {
  if (to.strategy === 'MANUAL_CPC') return from && from.strategy !== 'MANUAL_CPC' ? 'Manual CPC from now: the keyword and ad group bids stored in the campaign set the cost per click' : null
  if (!from || from.strategy !== to.strategy) return `Google sets the bids from now (${biddingText(to, currency)}): cost per click can rise`
  if (to.strategy === 'MAXIMIZE_CLICKS' && from.maxCpcCents !== undefined && (to.maxCpcCents === undefined || to.maxCpcCents > from.maxCpcCents)) {
    return `Raises the max CPC ceiling ${money(from.maxCpcCents, currency)} → ${to.maxCpcCents ? money(to.maxCpcCents, currency) : 'no ceiling'}`
  }
  if (to.strategy === 'MAXIMIZE_CONVERSIONS' && from.targetCpaCents !== undefined && (to.targetCpaCents === undefined || to.targetCpaCents > from.targetCpaCents)) {
    return `Raises the target CPA ${money(from.targetCpaCents, currency)} → ${to.targetCpaCents ? money(to.targetCpaCents, currency) : 'none'}`
  }
  if (to.strategy === 'MAXIMIZE_CONVERSION_VALUE' && from.targetRoas !== undefined && (to.targetRoas === undefined || to.targetRoas < from.targetRoas)) {
    return `Lowers the target ROAS ${Math.round(from.targetRoas * 100)} % → ${to.targetRoas ? `${Math.round(to.targetRoas * 100)} %` : 'none'}`
  }
  if (to.strategy === 'PORTFOLIO' && from.portfolioId !== to.portfolioId) return `Moves to portfolio strategy ${to.portfolioId}: its targets decide the bids`
  return null
}

const pausedNote = (status: string | null) => (status === 'ENABLED' ? '' : ' (the campaign is paused: nothing spends until it is enabled)')

// ── create ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CampaignCreateRequest {
  type: 'SHOPPING' | 'SEARCH'
  name: string
  /** An existing budget (shared), or a new budget of its own. */
  budgetId?: string
  dailyBudgetCents?: number
  bidding: Bidding
  startDate?: string
  endDate?: string
  searchPartners?: boolean
  display?: boolean
  shopping?: { merchantId: string; feedLabel?: string; priority?: Priority; localInventory?: boolean }
  search?: { aiMax?: boolean; textCustomization?: boolean; finalUrlExpansion?: boolean }
  /** `bidModifier`: a targeted location's bid adjustment (a copy keeps it). */
  locations?: Array<{ id: string; exclude?: boolean; bidModifier?: number }>
  locationOption?: LocationOption
  languages?: string[]
  schedule?: ScheduleSlot[]
  audiences?: string[]
  /** Audiences the ads never show to (a copy keeps them). */
  excludedAudiences?: string[]
  /** true = the audiences TARGET (only they see the ads); default false = observation (a copy keeps the source's mode). */
  audienceTargeting?: boolean
  /** The campaign's tracking template and final URL suffix (a copy keeps them: sales tracking may rest on them). */
  trackingTemplate?: string
  finalUrlSuffix?: string
  euPoliticalAds?: boolean
}

export interface CampaignCreateRecord { campaignId: string | null; name: string; ownBudgetId?: string | null }

const BUDGET_TEMP = -1
const CAMPAIGN_TEMP = -2

/**
 * What makes a create request one Google cannot take, apart from the account (names, budgets): settings that do not go
 * together, days, the feed label, the schedule. Null when none. Shared with the build (change-build.ts).
 */
export function campaignCreateProblem(r: CampaignCreateRequest): string | null {
  if (r.type === 'SHOPPING' && !r.shopping) return 'A Shopping campaign needs shopping.merchantId (the Merchant Center account).'
  if (r.type === 'SEARCH' && r.shopping) return 'shopping settings are for a Shopping campaign only.'
  if (r.type === 'SHOPPING' && (r.search || r.languages?.length || r.display)) return 'A Standard Shopping campaign takes no search settings, languages or Display Network (its products come from the feed).'
  if (r.bidding.strategy === 'PORTFOLIO' && !r.bidding.portfolioId) return 'A portfolio strategy needs bidding.portfolioId.'
  if (r.search?.finalUrlExpansion && r.search.textCustomization === false) return 'Google turns text customization on with final URL expansion: ask for both, or neither.'
  for (const d of [r.startDate, r.endDate]) if (d !== undefined && !DAY.test(d)) return `"${d}" is not a day (YYYY-MM-DD).`
  if (r.startDate && r.endDate && r.endDate < r.startDate) return 'The end date is before the start date.'
  if (r.shopping?.feedLabel && !/^[A-Z0-9_-]{1,20}$/.test(r.shopping.feedLabel)) return `The feed label "${r.shopping.feedLabel}" is not one Google takes (up to 20 of A–Z, 0–9, - and _).`
  for (const l of r.locations ?? []) {
    if (l.bidModifier !== undefined && (l.exclude || !(l.bidModifier >= 0.1 && l.bidModifier <= 10))) return `Location ${l.id}: a bid adjustment is for a targeted location, between 0.1 and 10.`
  }
  const schedule = r.schedule?.length ? scheduleCriteria(r.schedule) : []
  if ('refusal' in schedule) return schedule.refusal
  return null
}

/**
 * The campaign's create operation (ALWAYS paused) and its criteria (locations, languages, schedule, audiences), on a
 * budget resource and a campaign resource name the caller chose (a temporary id). Shared with the build.
 */
export function campaignCreateOperations(customer: string, r: CampaignCreateRequest, budgetRes: string, campaignRes: string): { operations: GoogleMutateOperation[] } | { refusal: string } {
  const schedule = r.schedule?.length ? scheduleCriteria(r.schedule) : []
  if ('refusal' in schedule) return schedule
  const ops: GoogleMutateOperation[] = []
  const optionInclude = r.locationOption ?? 'PRESENCE'
  const campaign: Record<string, unknown> = {
    resourceName: campaignRes,
    name: r.name.trim(),
    // Never ENABLED by Nexus: Google's default is ENABLED, so it is said every time.
    status: 'PAUSED',
    advertisingChannelType: r.type,
    campaignBudget: budgetRes,
    ...biddingFields(customer, r.bidding),
    networkSettings: {
      targetGoogleSearch: true,
      targetSearchNetwork: r.searchPartners === true,
      targetContentNetwork: r.type === 'SEARCH' && r.display === true,
      targetPartnerSearchNetwork: false,
    },
    geoTargetTypeSetting: { positiveGeoTargetType: optionInclude, negativeGeoTargetType: 'PRESENCE' },
    containsEuPoliticalAdvertising: r.euPoliticalAds ? 'CONTAINS_EU_POLITICAL_ADVERTISING' : 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
    ...(r.startDate ? { startDateTime: `${r.startDate} 00:00:00` } : {}),
    ...(r.endDate ? { endDateTime: `${r.endDate} 23:59:59` } : {}),
  }
  if (r.type === 'SHOPPING') {
    campaign.shoppingSetting = {
      merchantId: r.shopping!.merchantId,
      ...(r.shopping!.feedLabel ? { feedLabel: r.shopping!.feedLabel } : {}),
      campaignPriority: PRIORITY_NUMBER[r.shopping!.priority ?? 'LOW'],
      enableLocal: r.shopping!.localInventory === true,
    }
  } else {
    const s = r.search ?? {}
    campaign.aiMaxSetting = { enableAiMax: s.aiMax === true }
    campaign.assetAutomationSettings = [
      { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: s.textCustomization || s.finalUrlExpansion ? 'OPTED_IN' : 'OPTED_OUT' },
      { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: s.finalUrlExpansion ? 'OPTED_IN' : 'OPTED_OUT' },
    ]
  }
  if (r.audiences?.length) campaign.targetingSetting = { targetRestrictions: [{ targetingDimension: 'AUDIENCE', bidOnly: r.audienceTargeting !== true }] }
  if (r.trackingTemplate) campaign.trackingUrlTemplate = r.trackingTemplate
  if (r.finalUrlSuffix) campaign.finalUrlSuffix = r.finalUrlSuffix
  ops.push({ campaignOperation: { create: campaign } })
  for (const l of r.locations ?? []) {
    ops.push({ campaignCriterionOperation: { create: {
      campaign: campaignRes, ...(l.exclude ? { negative: true } : {}), location: { geoTargetConstant: `geoTargetConstants/${l.id}` },
      ...(!l.exclude && l.bidModifier !== undefined && l.bidModifier !== 1 ? { bidModifier: l.bidModifier } : {}),
    } } })
  }
  for (const id of r.languages ?? []) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, language: { languageConstant: `languageConstants/${id}` } } } })
  for (const s of schedule) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, ...s } } })
  for (const id of r.audiences ?? []) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, userInterest: { userInterestCategory: `${customer}/userInterests/${id}` } } } })
  for (const id of r.excludedAudiences ?? []) ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, userInterest: { userInterestCategory: `${customer}/userInterests/${id}` } } } })
  return { operations: ops }
}

/**
 * What a person reads about a new campaign (its from → to lines) and what it does that they should know (warnings):
 * shared by create-google-campaign and the build, so a copy shows every setting it carries over.
 */
export function campaignCreateNotes(r: CampaignCreateRequest, currency: string, budgetText: string): { lines: Array<[string, unknown, unknown]>; warnings: string[] } {
  const optionInclude = r.locationOption ?? 'PRESENCE'
  const schedule = r.schedule?.length ? scheduleCriteria(r.schedule) : []
  const slots = 'refusal' in schedule ? 0 : schedule.length
  const warnings: string[] = []
  if (!(r.locations ?? []).some((l) => !l.exclude)) warnings.push(`"${r.name.trim()}" targets no location: when enabled it can show in every country.`)
  if (r.searchPartners) warnings.push(`"${r.name.trim()}": search partners are on — ads can also show on Google's search partner sites.`)
  if (r.type === 'SEARCH' && r.display) warnings.push(`"${r.name.trim()}": the Display Network is on — ads can also show on websites and apps.`)
  if (r.type === 'SEARCH' && (r.search?.aiMax || r.search?.textCustomization || r.search?.finalUrlExpansion)) {
    warnings.push(`"${r.name.trim()}": Google acts on its own — ${[r.search?.aiMax && 'AI Max', (r.search?.textCustomization || r.search?.finalUrlExpansion) && 'text customization', r.search?.finalUrlExpansion && 'final URL expansion'].filter(Boolean).join(', ')}.`)
  }
  if (optionInclude === 'PRESENCE_OR_INTEREST') warnings.push(`"${r.name.trim()}": location option "presence or interest" — people outside the locations who show interest in them can see the ads.`)
  if (r.audienceTargeting) warnings.push(`"${r.name.trim()}": its audiences TARGET (only those people see the ads).`)
  const lines: Array<[string, unknown, unknown]> = [
    ['new campaign', '(none)', `"${r.name.trim()}" · ${r.type === 'SHOPPING' ? 'Standard Shopping' : 'Search'} · PAUSED`],
    ['budget', '(none)', budgetText],
    ['bidding', '(none)', biddingText(r.bidding, currency)],
    ['networks', '(none)', ['Google Search', r.searchPartners && 'search partners', r.type === 'SEARCH' && r.display && 'Display'].filter(Boolean).join(', ')],
  ]
  if (r.type === 'SHOPPING') lines.push(['Shopping', '(none)', `Merchant Center ${r.shopping!.merchantId}${r.shopping!.feedLabel ? `, feed label ${r.shopping!.feedLabel}` : ''}, priority ${r.shopping!.priority ?? 'LOW'}${r.shopping!.localInventory ? ', local products' : ''}`])
  else lines.push(['Google on its own', '(none)', `AI Max ${r.search?.aiMax ? 'on' : 'off'}, text customization ${r.search?.textCustomization || r.search?.finalUrlExpansion ? 'on' : 'off'}, final URL expansion ${r.search?.finalUrlExpansion ? 'on' : 'off'}`])
  lines.push(['locations', '(none)', `${(r.locations ?? []).filter((l) => !l.exclude).length} targeted, ${(r.locations ?? []).filter((l) => l.exclude).length} excluded · ${optionInclude === 'PRESENCE' ? 'presence only' : 'presence or interest'}`])
  if (r.type === 'SEARCH') lines.push(['languages', '(none)', (r.languages ?? []).length ? (r.languages ?? []).join(', ') : 'all'])
  lines.push(['schedule', '(none)', slots ? `${slots} slot${slots === 1 ? '' : 's'}` : 'all day, every day'])
  if (r.audiences?.length || r.excludedAudiences?.length) lines.push(['audiences', '(none)', `${(r.audiences ?? []).length} ${r.audienceTargeting ? 'targeting' : 'in observation'}, ${(r.excludedAudiences ?? []).length} excluded`])
  lines.push(['dates', '(none)', `${r.startDate ?? 'starts when enabled'} → ${r.endDate ?? 'no end'}`])
  if (r.trackingTemplate || r.finalUrlSuffix) lines.push(['tracking', '(none)', [r.trackingTemplate && 'tracking template', r.finalUrlSuffix && `final URL suffix ${r.finalUrlSuffix}`].filter(Boolean).join(', ')])
  return { lines, warnings }
}

export function campaignCreateDraft(
  customer: string,
  currency: string,
  r: CampaignCreateRequest,
  live: { campaigns: LiveCampaign[]; budgets: LiveBudget[] },
): GoogleChangeDraft | { refusal: string } {
  const name = r.name.trim()
  if (live.campaigns.some((c) => c.name.trim().toLowerCase() === name.toLowerCase())) {
    return { refusal: `A campaign named "${name}" already exists in this account: Google refuses a second one. Choose another name.` }
  }
  if (!!r.budgetId === !!r.dailyBudgetCents) return { refusal: 'Give budgetId (an existing shared budget) or dailyBudgetCents (a budget of its own), one of them.' }
  const problem = campaignCreateProblem(r)
  if (problem) return { refusal: problem }
  const schedule = r.schedule?.length ? scheduleCriteria(r.schedule) : []
  if ('refusal' in schedule) return schedule
  let budgetRes: string
  let budgetText: string
  const ops: GoogleMutateOperation[] = []
  if (r.budgetId) {
    const b = live.budgets.find((x) => x.budgetId === r.budgetId)
    if (!b) return { refusal: `Budget ${r.budgetId} is not in this account (or it is removed).` }
    if (!b.shared) return { refusal: `Budget ${r.budgetId} is another campaign's own budget: use a shared budget, or dailyBudgetCents.` }
    budgetRes = `${customer}/campaignBudgets/${b.budgetId}`
    budgetText = `shared "${b.name ?? b.budgetId}" ${money(b.amountCents, currency)} a day`
  } else {
    budgetRes = `${customer}/campaignBudgets/${BUDGET_TEMP}`
    budgetText = `its own ${money(r.dailyBudgetCents!, currency)} a day`
    ops.push({ campaignBudgetOperation: { create: { resourceName: budgetRes, amountMicros: microsOfCents(r.dailyBudgetCents!), explicitlyShared: false, deliveryMethod: 'STANDARD' } } })
  }
  const created = campaignCreateOperations(customer, r, budgetRes, `${customer}/campaigns/${CAMPAIGN_TEMP}`)
  if ('refusal' in created) return created
  ops.push(...created.operations)

  const notes = campaignCreateNotes(r, currency, budgetText)
  const warnings: string[] = ['It is made PAUSED: nothing spends until a person enables it (set-google-status, marked SPENDS MONEY).', ...notes.warnings]
  const lines = notes.lines
  const { changes } = changeLines(lines)
  return {
    summary: `Google Ads: make the ${r.type === 'SHOPPING' ? 'Standard Shopping' : 'Search'} campaign "${name}", PAUSED, with its targeting.`,
    changes,
    totals: { operations: ops.length, locations: (r.locations ?? []).length, languages: (r.languages ?? []).length, scheduleSlots: schedule.length, audiences: (r.audiences ?? []).length },
    warnings,
    spendsMoney: [],
    skipped: [],
    operations: ops,
    stands: { names: live.campaigns.map((c) => c.name.trim().toLowerCase()).sort(), budget: r.budgetId ? live.budgets.find((b) => b.budgetId === r.budgetId) : null },
    before: null,
    after: { campaignId: null, name, ...(r.dailyBudgetCents ? { ownBudgetId: null } : {}) } satisfies CampaignCreateRecord,
  }
}

/** The record of a create, with the ids Google gave (the campaign and, when made, its own budget). */
export function campaignCreateRecordAfterRun(after: CampaignCreateRecord, responses: Array<Record<string, { resourceName?: string } | undefined>>): CampaignCreateRecord {
  const id = (name?: string) => (name ? name.slice(name.lastIndexOf('/') + 1) : null)
  const campaign = responses.find((r) => r?.campaignResult)?.campaignResult?.resourceName
  const budget = 'ownBudgetId' in after ? responses[0]?.campaignBudgetResult?.resourceName : undefined
  return { ...after, campaignId: id(campaign), ...('ownBudgetId' in after ? { ownBudgetId: id(budget) } : {}) }
}

// ── settings ────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CampaignSettingsRequest {
  name?: string
  priority?: Priority
  bidding?: Bidding
  startDate?: string
  /** A day, or 'none' (runs on). */
  endDate?: string
  searchPartners?: boolean
  display?: boolean
  aiMax?: boolean
  textCustomization?: boolean
  finalUrlExpansion?: boolean
  locationOption?: LocationOption
  /** The new amount of the campaign's OWN budget (a shared budget: set-google-budget). */
  dailyBudgetCents?: number
}

/** The settings a change of this tool reads and writes, as a person reads them (also the undo's record). */
export interface CampaignSettingsRecord {
  campaignId: string
  settings: CampaignSettingsRequest
}

const automationOn = (c: LiveCampaignDetail['campaign'], type: string) => c.assetAutomation.some((a) => a.type === type && a.status === 'OPTED_IN')
const dayOf = (dateTime: string | null) => (dateTime ? dateTime.slice(0, 10) : null)

/** What the campaign has now, in the request's own terms (the "from" side, and what undo puts back). */
export function campaignSettingsNow(c: LiveCampaignDetail['campaign'], budget: LiveBudget | null): CampaignSettingsRequest {
  const now: CampaignSettingsRequest = {
    name: c.name,
    ...(c.shopping ? { priority: c.shopping.priority ?? 'LOW' } : {}),
    ...(biddingNow(c) ? { bidding: biddingNow(c)! } : {}),
    ...(dayOf(c.start) ? { startDate: dayOf(c.start)! } : {}),
    endDate: dayOf(c.end) && !dayOf(c.end)!.startsWith('2037-12-30') ? dayOf(c.end)! : 'none',
    searchPartners: c.networks.searchPartners,
    locationOption: (c.locationOption.include === 'PRESENCE_OR_INTEREST' ? 'PRESENCE_OR_INTEREST' : 'PRESENCE'),
  }
  // AI Max: Search and Shopping (AiMaxSetting "Supported in Search and Shopping campaigns").
  now.aiMax = c.aiMax
  if (c.type === 'SEARCH') {
    now.display = c.networks.display
    now.textCustomization = automationOn(c, 'TEXT_ASSET_AUTOMATION')
    now.finalUrlExpansion = automationOn(c, 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION')
  }
  if (budget && !budget.shared && budget.amountCents !== null) now.dailyBudgetCents = budget.amountCents
  return now
}

export function campaignSettingsDraft(
  customer: string,
  currency: string,
  campaignId: string,
  asked: CampaignSettingsRequest,
  live: { campaign: LiveCampaignDetail['campaign'] | null; budget: LiveBudget | null; campaigns: LiveCampaign[] },
): GoogleChangeDraft | { refusal: string } {
  const c = live.campaign
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  const now = campaignSettingsNow(c, live.budget)
  let ask: CampaignSettingsRequest = { ...asked }
  const isSearch = c.type === 'SEARCH'
  const isShopping = c.type === 'SHOPPING'
  if (!isSearch && !isShopping) return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: Nexus changes the settings of Search and Standard Shopping campaigns.` }
  if (ask.priority && !isShopping) return { refusal: 'priority is for a Shopping campaign.' }
  if (!isSearch && (ask.display !== undefined || ask.textCustomization !== undefined || ask.finalUrlExpansion !== undefined)) {
    return { refusal: 'display, textCustomization and finalUrlExpansion are Search campaign settings.' }
  }
  if (ask.bidding && !now.bidding) return { refusal: `"${c.name}" bids with ${c.bidding ?? 'a strategy'} that Nexus cannot name: change its bidding in Google Ads.` }
  if (ask.bidding) ask = { ...ask, bidding: biddingClean(ask.bidding) }
  if (ask.dailyBudgetCents !== undefined && (!live.budget || live.budget.shared)) {
    return { refusal: `"${c.name}" uses a shared budget: change its amount with set-google-budget (every campaign on it changes), or give the campaign its own budget there.` }
  }
  if (ask.bidding?.strategy === 'PORTFOLIO' && !ask.bidding.portfolioId) return { refusal: 'A portfolio strategy needs bidding.portfolioId.' }
  for (const d of [ask.startDate, ask.endDate]) if (d !== undefined && d !== 'none' && !DAY.test(d)) return { refusal: `"${d}" is not a day (YYYY-MM-DD).` }
  if (ask.name !== undefined) {
    const name = ask.name.trim()
    if (name.toLowerCase() !== c.name.trim().toLowerCase() && live.campaigns.some((x) => x.campaignId !== c.campaignId && x.name.trim().toLowerCase() === name.toLowerCase())) {
      return { refusal: `Another campaign is named "${name}": Google refuses two campaigns with one name.` }
    }
  }
  // AI Max off turns its features off with it (they cannot serve without it); final URL expansion turns text
  // customization on (Google: "Enabling final URL expansion also enables text asset automation").
  const aiMaxOff = ask.aiMax === false && now.aiMax === true
  if (aiMaxOff && isSearch) {
    if (ask.textCustomization === true || ask.finalUrlExpansion === true) return { refusal: 'AI Max off with text customization or final URL expansion on cannot serve: turn them off too, or keep AI Max on.' }
    if (now.textCustomization) ask = { ...ask, textCustomization: false }
    if (now.finalUrlExpansion) ask = { ...ask, finalUrlExpansion: false }
  }
  if (ask.finalUrlExpansion === true && ask.textCustomization === undefined && !now.textCustomization) ask = { ...ask, textCustomization: true }
  const textOn = ask.textCustomization ?? now.textCustomization
  const urlOn = ask.finalUrlExpansion ?? now.finalUrlExpansion
  if (urlOn && textOn === false) return { refusal: 'Google keeps text customization on while final URL expansion is on: turn both off, or keep text customization on.' }

  const fields: Record<string, unknown> = {}
  const mask: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const before: CampaignSettingsRequest = {}
  const after: CampaignSettingsRequest = {}
  const note = pausedNote(c.status)
  const changed = <K extends keyof CampaignSettingsRequest>(key: K) => ask[key] !== undefined && JSON.stringify(ask[key]) !== JSON.stringify(now[key])
  const record = <K extends keyof CampaignSettingsRequest>(key: K) => { before[key] = now[key]; after[key] = ask[key] }

  if (changed('name')) { record('name'); fields.name = ask.name!.trim(); mask.push('name'); lines.push(['name', now.name, ask.name!.trim()]) }
  if (changed('priority')) {
    record('priority')
    fields.shoppingSetting = { campaignPriority: PRIORITY_NUMBER[ask.priority!] }
    mask.push('shopping_setting.campaign_priority')
    lines.push(['Shopping priority', now.priority, ask.priority])
    warnings.push('A Shopping priority decides which campaign serves a product that several campaigns hold: the other campaigns of these products may serve less or more.')
  }
  if (changed('bidding')) {
    record('bidding')
    Object.assign(fields, biddingFields(customer, ask.bidding!))
    mask.push(...biddingMask(ask.bidding!))
    lines.push(['bidding', now.bidding ? biddingText(now.bidding, currency) : c.bidding ?? '(unknown)', biddingText(ask.bidding!, currency)])
    const why = biddingSpends(now.bidding ?? null, ask.bidding!, currency)
    if (why) spends.push(`${why}${note}.`)
  }
  if (changed('startDate')) {
    record('startDate')
    fields.startDateTime = `${ask.startDate} 00:00:00`
    mask.push('start_date_time')
    lines.push(['start', now.startDate ?? '(when enabled)', ask.startDate])
    if (now.startDate && ask.startDate! < now.startDate) spends.push(`Starts earlier (${ask.startDate} instead of ${now.startDate})${note}.`)
  }
  if (changed('endDate')) {
    record('endDate')
    if (ask.endDate === 'none') mask.push('end_date_time')
    else { fields.endDateTime = `${ask.endDate} 23:59:59`; mask.push('end_date_time') }
    lines.push(['end', now.endDate === 'none' ? 'no end' : now.endDate, ask.endDate === 'none' ? 'no end' : ask.endDate])
    if (ask.endDate === 'none' || (now.endDate !== 'none' && ask.endDate! > now.endDate!)) spends.push(`Runs longer (end ${ask.endDate === 'none' ? 'removed' : `moved to ${ask.endDate}`})${note}.`)
  }
  const network = (key: 'searchPartners' | 'display', path: string, prop: string, label: string) => {
    if (!changed(key)) return
    record(key)
    fields.networkSettings = { ...(fields.networkSettings as object ?? {}), [prop]: ask[key] }
    mask.push(`network_settings.${path}`)
    lines.push([label, now[key] ? 'on' : 'off', ask[key] ? 'on' : 'off'])
    if (ask[key]) spends.push(`Turns on ${label}: ads can show in more places${note}.`)
  }
  network('searchPartners', 'target_search_network', 'targetSearchNetwork', 'search partners')
  network('display', 'target_content_network', 'targetContentNetwork', 'the Display Network')
  if (changed('aiMax')) {
    record('aiMax')
    fields.aiMaxSetting = { enableAiMax: ask.aiMax }
    mask.push('ai_max_setting.enable_ai_max')
    lines.push(['AI Max', now.aiMax ? 'on' : 'off', ask.aiMax ? 'on' : 'off'])
    if (ask.aiMax) spends.push(`Turns on AI Max: Google matches more searches on its own${note}.`)
    if (aiMaxOff && (now.textCustomization || now.finalUrlExpansion)) warnings.push('AI Max off also turns off text customization and final URL expansion: they serve only with AI Max.')
  }
  if (changed('textCustomization') || changed('finalUrlExpansion')) {
    if (changed('textCustomization')) record('textCustomization')
    if (changed('finalUrlExpansion')) record('finalUrlExpansion')
    fields.assetAutomationSettings = [
      { assetAutomationType: 'TEXT_ASSET_AUTOMATION', assetAutomationStatus: textOn || urlOn ? 'OPTED_IN' : 'OPTED_OUT' },
      { assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION', assetAutomationStatus: urlOn ? 'OPTED_IN' : 'OPTED_OUT' },
    ]
    mask.push('asset_automation_settings')
    lines.push(['text customization / final URL expansion', `${now.textCustomization ? 'on' : 'off'} / ${now.finalUrlExpansion ? 'on' : 'off'}`, `${textOn || urlOn ? 'on' : 'off'} / ${urlOn ? 'on' : 'off'}`])
    if (urlOn && !now.finalUrlExpansion) spends.push(`Turns on final URL expansion: Google picks landing pages and writes text on its own${note}.`)
    if ((textOn || urlOn) && !(ask.aiMax ?? now.aiMax)) warnings.push('Text customization and final URL expansion are AI Max features: Google may need AI Max on for this campaign (its check says).')
  }
  if (changed('locationOption')) {
    record('locationOption')
    fields.geoTargetTypeSetting = { positiveGeoTargetType: ask.locationOption, negativeGeoTargetType: 'PRESENCE' }
    mask.push('geo_target_type_setting.positive_geo_target_type', 'geo_target_type_setting.negative_geo_target_type')
    lines.push(['location option', now.locationOption === 'PRESENCE' ? 'presence only' : 'presence or interest', ask.locationOption === 'PRESENCE' ? 'presence only' : 'presence or interest'])
    if (ask.locationOption === 'PRESENCE_OR_INTEREST') spends.push(`Reaches people outside the locations who show interest in them${note}.`)
  }
  const ops: GoogleMutateOperation[] = []
  if (mask.length) ops.push({ campaignOperation: { update: { resourceName: `${customer}/campaigns/${c.campaignId}`, ...fields }, updateMask: mask.join(',') } })
  if (changed('dailyBudgetCents')) {
    record('dailyBudgetCents')
    ops.push({ campaignBudgetOperation: { update: { resourceName: `${customer}/campaignBudgets/${live.budget!.budgetId}`, amountMicros: microsOfCents(ask.dailyBudgetCents!) }, updateMask: 'amount_micros' } })
    lines.push(['daily budget (its own)', money(now.dailyBudgetCents ?? null, currency), money(ask.dailyBudgetCents!, currency)])
    if (now.dailyBudgetCents === undefined || ask.dailyBudgetCents! > now.dailyBudgetCents) spends.push(`Raises the daily budget ${money(now.dailyBudgetCents ?? null, currency)} → ${money(ask.dailyBudgetCents!, currency)}${note}.`)
  }
  if (!ops.length) return { refusal: `Nothing to change: "${c.name}" already has these settings.` }
  const { changes } = changeLines(lines)
  return {
    summary: `Google Ads campaign "${c.name}": change ${lines.map((l) => l[0]).join(', ')}.`,
    changes,
    totals: { operations: ops.length, settings: lines.length },
    warnings,
    spendsMoney: spends,
    skipped: [],
    operations: ops,
    stands: { campaignId: c.campaignId, now, status: c.status, budgetId: live.budget?.budgetId ?? null, names: ask.name ? live.campaigns.map((x) => x.name.trim().toLowerCase()).sort() : undefined },
    before: { campaignId: c.campaignId, settings: before } satisfies CampaignSettingsRecord,
    after: { campaignId: c.campaignId, settings: after } satisfies CampaignSettingsRecord,
  }
}
