/**
 * Google Ads step 1b — where Google changes the account by itself (R12) and what it recommends (R13), PLAN-1B.md
 * "API contract". Read only: Nexus applies no recommendation and changes no setting (`writes.mode: 'none'`,
 * `nexusWrites: 0`). Every answer comes from the GoogleAds* tables the daily read fills.
 *
 *   - a setting Nexus has not read is null ("not read yet"), never "off"; a setting a campaign type does not have is
 *     'not_applicable'; a setting Google left out of its answer has Google's default (`finalUrlExpansionByDefault`)
 *   - the change history never carries the person who made a change (user_email is never selected)
 *   - Google Ads Editor changes are not in the change history Google's API gives (the page says so)
 */
import prisma from '../../../db.js'
import { CHANGE_SOURCE_TEXT, changeSourceOf } from './mappers.js'
import { isWatchedChange, whoOf } from './alerts.js'
import {
  GoogleAdsReadError,
  changeSummary,
  changesSpanStart,
  currencyExponent,
  entityStatus,
  googleAdsAccount,
  googleAdsScope,
  googleCampaignDirectory,
  googleReadStates,
  iso,
  microsToMinor,
  sentenceCase,
  textKey,
} from './read.service.js'
import type {
  Flag,
  GoogleActsOnItsOwn,
  GoogleAutoApply,
  GoogleCampaignAutomation,
  GoogleChangeSource,
  GoogleImpact,
  GoogleOutsideChange,
  GoogleRecommendation,
  GoogleRecommendations,
} from './read-types.js'

// ── Recommendation types in words ──────────────────────────────────────────────────────────────────────────────────

/** Google's recommendation types (v25) → a short name and one plain sentence. */
const RECOMMENDATION_WORDS: Readonly<Record<string, [string, string]>> = {
  CAMPAIGN_BUDGET: ['Raise the budget', 'Google suggests a higher daily budget, because the budget limits this campaign.'],
  FORECASTING_CAMPAIGN_BUDGET: ['Raise the budget for a busy time', 'Google expects more searches soon and suggests a higher budget.'],
  MARGINAL_ROI_CAMPAIGN_BUDGET: ['Change the budget', 'Google suggests a different budget for a better return.'],
  MOVE_UNUSED_BUDGET: ['Move unused budget', 'Google suggests moving budget this campaign does not use to one it limits.'],
  KEYWORD: ['Add keywords', 'Google suggests new keywords for this campaign.'],
  KEYWORD_MATCH_TYPE: ['Change keyword match types', 'Google suggests broader match types for some keywords.'],
  USE_BROAD_MATCH_KEYWORD: ['Use broad match', 'Google suggests broad match keywords, which match more searches.'],
  TEXT_AD: ['Add an ad', 'Google suggests another text ad.'],
  RESPONSIVE_SEARCH_AD: ['Add a responsive search ad', 'Google suggests a responsive search ad.'],
  RESPONSIVE_SEARCH_AD_ASSET: ['Add headlines or descriptions', 'Google suggests more text for a responsive search ad.'],
  RESPONSIVE_SEARCH_AD_IMPROVE_AD_STRENGTH: ['Improve ad strength', 'Google suggests changes to make a responsive search ad stronger.'],
  IMPROVE_PERFORMANCE_MAX_AD_STRENGTH: ['Improve asset group strength', 'Google suggests more assets for a Performance Max asset group.'],
  IMPROVE_DEMAND_GEN_AD_STRENGTH: ['Improve ad strength', 'Google suggests more assets for a Demand Gen ad.'],
  OPTIMIZE_AD_ROTATION: ['Let Google rotate ads', 'Google suggests showing the ads it expects to do best more often.'],
  TARGET_CPA_OPT_IN: ['Bid to a target cost per conversion', 'Google suggests bidding by a target cost per conversion.'],
  SET_TARGET_CPA: ['Set a target cost per conversion', 'Google suggests a target cost per conversion.'],
  RAISE_TARGET_CPA: ['Raise the target cost per conversion', 'Google suggests a higher target cost per conversion.'],
  RAISE_TARGET_CPA_BID_TOO_LOW: ['Raise the target cost per conversion', 'Google says the target cost per conversion is too low to get many conversions.'],
  FORECASTING_SET_TARGET_CPA: ['Set a target cost per conversion for a busy time', 'Google expects more searches soon and suggests a target cost per conversion.'],
  TARGET_ROAS_OPT_IN: ['Bid to a target return on ad spend', 'Google suggests bidding by a target return on ad spend.'],
  SET_TARGET_ROAS: ['Set a target return on ad spend', 'Google suggests a target return on ad spend.'],
  LOWER_TARGET_ROAS: ['Lower the target return on ad spend', 'Google suggests a lower target return on ad spend, to get more conversions.'],
  FORECASTING_SET_TARGET_ROAS: ['Set a target return on ad spend for a busy time', 'Google expects more searches soon and suggests a target return on ad spend.'],
  MAXIMIZE_CONVERSIONS_OPT_IN: ['Bid for the most conversions', 'Google suggests letting it bid for the most conversions within the budget.'],
  MAXIMIZE_CONVERSION_VALUE_OPT_IN: ['Bid for the most conversion value', 'Google suggests letting it bid for the most conversion value within the budget.'],
  MAXIMIZE_CLICKS_OPT_IN: ['Bid for the most clicks', 'Google suggests letting it bid for the most clicks within the budget.'],
  ENHANCED_CPC_OPT_IN: ['Let Google adjust manual bids', 'Google suggests letting it raise or lower manual bids.'],
  SEARCH_PARTNERS_OPT_IN: ['Show ads on search partners', 'Google suggests showing the ads on sites that partner with Google Search.'],
  DISPLAY_EXPANSION_OPT_IN: ['Show ads on the Display Network', 'Google suggests showing the search ads on websites too.'],
  PERFORMANCE_MAX_OPT_IN: ['Add a Performance Max campaign', 'Google suggests a Performance Max campaign.'],
  PERFORMANCE_MAX_FINAL_URL_OPT_IN: ['Let Google pick landing pages', 'Google suggests letting it send people to other pages of the site.'],
  UPGRADE_SMART_SHOPPING_CAMPAIGN_TO_PERFORMANCE_MAX: ['Upgrade to Performance Max', 'Google suggests moving this Shopping campaign to Performance Max.'],
  UPGRADE_LOCAL_CAMPAIGN_TO_PERFORMANCE_MAX: ['Upgrade to Performance Max', 'Google suggests moving this local campaign to Performance Max.'],
  SHOPPING_MIGRATE_REGULAR_SHOPPING_CAMPAIGN_OFFERS_TO_PERFORMANCE_MAX: ['Move products to Performance Max', 'Google suggests advertising these products with Performance Max.'],
  MIGRATE_DYNAMIC_SEARCH_ADS_CAMPAIGN_TO_PERFORMANCE_MAX: ['Move dynamic search ads to Performance Max', 'Google suggests replacing dynamic search ads with Performance Max.'],
  DYNAMIC_IMAGE_EXTENSION_OPT_IN: ['Add images from the site', 'Google suggests showing images from the site with the ads.'],
  CALLOUT_ASSET: ['Add callouts', 'Google suggests short callout texts for the ads.'],
  SITELINK_ASSET: ['Add sitelinks', 'Google suggests links to other pages of the site under the ads.'],
  CALL_ASSET: ['Add a phone number', 'Google suggests a phone number with the ads.'],
  LEAD_FORM_ASSET: ['Add a lead form', 'Google suggests a form people fill in from the ad.'],
  SHOPPING_ADD_AGE_GROUP: ['Add age groups to products', 'Google suggests adding an age group to products in Merchant Center.'],
  SHOPPING_ADD_COLOR: ['Add colours to products', 'Google suggests adding a colour to products in Merchant Center.'],
  SHOPPING_ADD_GENDER: ['Add genders to products', 'Google suggests adding a gender to products in Merchant Center.'],
  SHOPPING_ADD_GTIN: ['Add barcodes to products', 'Google suggests adding a GTIN to products in Merchant Center.'],
  SHOPPING_ADD_MORE_IDENTIFIERS: ['Add product identifiers', 'Google suggests more identifiers for products in Merchant Center.'],
  SHOPPING_ADD_SIZE: ['Add sizes to products', 'Google suggests adding a size to products in Merchant Center.'],
  SHOPPING_ADD_PRODUCTS_TO_CAMPAIGN: ['Add products to the campaign', 'Google suggests advertising more products.'],
  SHOPPING_FIX_DISAPPROVED_PRODUCTS: ['Fix products Google will not show', 'Google suggests fixing products it disapproved.'],
  SHOPPING_TARGET_ALL_OFFERS: ['Advertise every product', 'Google suggests advertising every product of the feed.'],
  SHOPPING_FIX_SUSPENDED_MERCHANT_CENTER_ACCOUNT: ['Fix the Merchant Center account', 'Google suspended the Merchant Center account.'],
  SHOPPING_FIX_MERCHANT_CENTER_ACCOUNT_SUSPENSION_WARNING: ['Fix the Merchant Center account', 'Google may suspend the Merchant Center account.'],
  IMPROVE_GOOGLE_TAG_COVERAGE: ['Add the Google tag to more pages', 'Google suggests the Google tag on more pages of the site.'],
  REFRESH_CUSTOMER_MATCH_LIST: ['Refresh a customer list', 'Google suggests uploading a newer customer list.'],
  CUSTOM_AUDIENCE_OPT_IN: ['Add a custom audience', 'Google suggests a custom audience.'],
}

/** A recommendation (or auto-apply) type in words; a type Nexus does not know yet is named as Google writes it. */
export function recommendationWords(type: string): { typeText: string; explanation: string } {
  const known = RECOMMENDATION_WORDS[type]
  return known
    ? { typeText: known[0], explanation: known[1] }
    : { typeText: sentenceCase(type), explanation: 'Google suggests a change of this kind.' }
}

// ── R12 — where Google acts on its own ─────────────────────────────────────────────────────────────────────────────

/** The most changes R12 lists (newest first); `bySource` counts every change of the span. */
export const MAX_OUTSIDE_CHANGES = 200

const FINAL_URL_EXPANSION = 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION'
const TEXT_CUSTOMIZATION = 'TEXT_ASSET_AUTOMATION'

/** asset_automation_settings as stored: [{ assetAutomationType, assetAutomationStatus }] → type → opted in. */
function assetAutomationOf(stored: unknown): Map<string, boolean> {
  const out = new Map<string, boolean>()
  if (!Array.isArray(stored)) return out
  for (const raw of stored) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const type = entry.assetAutomationType ?? entry.asset_automation_type
    const status = entry.assetAutomationStatus ?? entry.asset_automation_status
    if (typeof type !== 'string') continue
    if (status === 'OPTED_IN') out.set(type, true)
    else if (status === 'OPTED_OUT') out.set(type, false)
  }
  return out
}

export interface CampaignFlagsRow {
  id: string
  campaignId: string
  name: string
  status: string
  removedAt: Date | null
  channelType: string
  flagsReadAt: Date | null
  aiMaxEnabled: boolean | null
  keywordMatchType: string | null
  broadMatchMigratedAt: Date | null
  targetSearchNetwork: boolean | null
  targetContentNetwork: boolean | null
  assetAutomation: unknown
  dsaDomain: string | null
}

const onOff = (value: boolean): Flag => (value ? 'on' : 'off')

/**
 * One campaign's settings by which Google acts on its own (pure). Not read → null. Google leaves a setting at its
 * default out of its answer, so once read, a missing value is the default: off, except Final URL expansion and text
 * customization, which Performance Max (and AI Max, for text) have on unless opted out.
 */
export function campaignAutomation(
  row: CampaignFlagsRow,
  counts: { brandExclusions: number | null; adGroupsWithoutSearchTermMatching: number | null },
): GoogleCampaignAutomation {
  const read = !!row.flagsReadAt
  const type = row.channelType
  const search = type === 'SEARCH'
  const pmax = type === 'PERFORMANCE_MAX'
  const flag = (applies: boolean, value: () => boolean): Flag => (!read ? null : applies ? onOff(value()) : 'not_applicable')
  // The read stores asset_automation_settings as a list ([] = Google listed none: the defaults), or null when Google
  // refused the field and the settings were read without it: then those two are not read, never Google's default.
  const automationRead = read && Array.isArray(row.assetAutomation)
  const automationFlag = (applies: boolean, value: () => boolean): Flag => (read && applies && !automationRead ? null : flag(applies, value))
  const automation = assetAutomationOf(row.assetAutomation)
  const aiMax = search && row.aiMaxEnabled === true
  const urlExpansionSet = automation.get(FINAL_URL_EXPANSION)
  const textSet = automation.get(TEXT_CUSTOMIZATION)
  return {
    campaignId: row.id,
    externalCampaignId: row.campaignId,
    name: row.name,
    type,
    status: entityStatus(row.status, row.removedAt),
    aiMax: flag(search, () => row.aiMaxEnabled === true),
    campaignBroadMatch: flag(search, () => row.keywordMatchType === 'BROAD'),
    searchPartners: flag(search || type === 'SHOPPING', () => row.targetSearchNetwork === true),
    displayExpansion: flag(search, () => row.targetContentNetwork === true),
    finalUrlExpansion: automationFlag(search || pmax, () => urlExpansionSet ?? pmax),
    finalUrlExpansionByDefault: automationRead && (search || pmax) && urlExpansionSet === undefined,
    textCustomization: automationFlag(search || pmax, () => textSet ?? (pmax || aiMax)),
    dynamicSearchAds: flag(search, () => !!row.dsaDomain),
    brandExclusions: counts.brandExclusions,
    adGroupsWithoutSearchTermMatching: counts.adGroupsWithoutSearchTermMatching,
    movedToAiMaxAt: iso(row.broadMatchMigratedAt),
    flagsReadAt: iso(row.flagsReadAt),
  }
}

const SOURCE_ORDER: readonly GoogleChangeSource[] = ['google_automatic', 'google_ads_web', 'google_ads_editor', 'api', 'other']

/** R12 — the auto-apply settings, each campaign's settings by which Google acts alone, and the changes made outside Nexus. */
export async function googleAdsActsOnItsOwn(input: { connectionId?: string | null }, now: Date = new Date()): Promise<GoogleActsOnItsOwn> {
  const context = await googleAdsAccount(input.connectionId)
  const states = await googleReadStates(context.customerId)
  const read = {
    autoApply: states.read('AUTO_APPLY'), settings: states.read('CAMPAIGN_SETTINGS'),
    adGroups: states.read('AD_GROUPS'), campaignNegatives: states.read('CAMPAIGN_NEGATIVES'),
  }
  const customerId = context.customerId
  const nothing = { nexusWrites: 0 as const, coveredFrom: null, coveredThrough: null, bySource: [], items: [] }
  if (!customerId) return { read, autoApply: null, campaigns: [], outsideChanges: nothing }

  const since = changesSpanStart(context.timeZone, now)
  const [autoApplyRows, campaignRows, withoutMatching, brandLists, changes, sources] = await Promise.all([
    prisma.googleAdsAutoApply.findMany({ where: { customerId, removedAt: null }, orderBy: [{ type: 'asc' }] }),
    prisma.googleAdsCampaign.findMany({
      where: { customerId, removedAt: null, status: { not: 'REMOVED' } },
      select: {
        id: true, campaignId: true, name: true, status: true, removedAt: true, channelType: true, flagsReadAt: true, aiMaxEnabled: true,
        keywordMatchType: true, broadMatchMigratedAt: true, targetSearchNetwork: true, targetContentNetwork: true, assetAutomation: true, dsaDomain: true,
      },
    }),
    prisma.googleAdsAdGroup.groupBy({
      by: ['campaignId'], where: { customerId, removedAt: null, status: { not: 'REMOVED' }, searchTermMatchingDisabled: true }, _count: { _all: true },
    }),
    prisma.googleAdsKeyword.groupBy({
      by: ['campaignId'], where: { customerId, level: 'CAMPAIGN', criterionType: 'BRAND_LIST', negative: true, removedAt: null }, _count: { _all: true },
    }),
    prisma.googleAdsChangeEvent.findMany({
      where: { customerId, changedAt: { gte: since } },
      // userEmail is deliberately not selected: it is stored for the table only.
      select: { changedAt: true, resourceType: true, operation: true, changedFields: true, clientType: true, campaignId: true },
      orderBy: [{ changedAt: 'desc' }, { resourceName: 'desc' }],
      take: MAX_OUTSIDE_CHANGES,
    }),
    prisma.googleAdsChangeEvent.groupBy({ by: ['clientType'], where: { customerId, changedAt: { gte: since } }, _count: { _all: true } }),
  ])

  const autoApply = states.readAt('AUTO_APPLY')
    ? (() => {
        const rows = autoApplyRows.map((row) => ({ status: row.status, item: {
          type: row.type, typeText: recommendationWords(row.type).typeText, since: iso(row.createdAtGoogle), changedAt: iso(row.modifiedAtGoogle),
        } satisfies GoogleAutoApply }))
        return { enabled: rows.filter((r) => r.status === 'ENABLED').map((r) => r.item), paused: rows.filter((r) => r.status !== 'ENABLED').map((r) => r.item) }
      })()
    : null

  const countOf = (rows: { campaignId: string | null; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.campaignId ?? '', r._count._all]))
  const matching = countOf(withoutMatching)
  const brands = countOf(brandLists)
  const adGroupsRead = !!states.readAt('AD_GROUPS')
  const negativesRead = !!states.readAt('CAMPAIGN_NEGATIVES')
  const campaigns = campaignRows
    .map((row) => campaignAutomation(row, {
      brandExclusions: negativesRead ? brands.get(row.campaignId) ?? 0 : null,
      adGroupsWithoutSearchTermMatching: adGroupsRead ? matching.get(row.campaignId) ?? 0 : null,
    }))
    .sort((a, b) => (textKey(a.name) < textKey(b.name) ? -1 : textKey(a.name) > textKey(b.name) ? 1 : a.campaignId < b.campaignId ? -1 : 1))

  const directory = await googleCampaignDirectory(
    { customerId, structureSyncedAt: context.customer?.structureSyncedAt ?? null, timeZone: context.timeZone },
    changes.map((c) => c.campaignId ?? ''),
  )
  const items = changes.map((row): GoogleOutsideChange => {
    const { source, sourceText, sentence } = changeSourceOf(row.clientType)
    const campaign = row.campaignId ? directory(row.campaignId) : null
    return {
      changedAt: row.changedAt.toISOString(),
      campaignId: campaign?.campaignId ?? null,
      externalCampaignId: row.campaignId,
      campaignName: campaign?.campaignName ?? null,
      resourceType: row.resourceType,
      operation: row.operation,
      changedFields: row.changedFields,
      source,
      sourceText,
      who: whoOf(row.clientType),
      watched: isWatchedChange(row.resourceType, row.changedFields),
      summary: changeSummary(row.resourceType, row.operation, row.changedFields, sentence),
    }
  })
  const counts = new Map<GoogleChangeSource, number>()
  for (const row of sources) {
    const { source } = changeSourceOf(row.clientType)
    counts.set(source, (counts.get(source) ?? 0) + row._count._all)
  }
  const bySource = [...counts]
    .map(([source, count]) => ({ source, sourceText: CHANGE_SOURCE_TEXT[source], count }))
    .sort((a, b) => b.count - a.count || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source))

  // As R4: the span read in full is from the oldest instant Google answers for to where reading stopped.
  const readThrough = context.customer?.changesSyncedThrough ?? null
  return {
    read,
    autoApply,
    campaigns,
    outsideChanges: {
      nexusWrites: 0,
      coveredFrom: readThrough && readThrough > since ? since.toISOString() : null,
      coveredThrough: iso(readThrough),
      bySource,
      items,
    },
  }
}

// ── R13 — Google's recommendations ─────────────────────────────────────────────────────────────────────────────────

const TYPE_RE = /^[A-Z][A-Z0-9_]{0,99}$/

const finite = (value: unknown): number | null => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(n) ? n : null
}

/** One side of Google's estimate. Google leaves a zero out; an absent side is not an estimate (all null). */
function impactSide(raw: unknown, exponent: number): GoogleImpact {
  if (!raw || typeof raw !== 'object') return { impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null }
  const m = raw as Record<string, unknown>
  const micros = (value: unknown): number => {
    const n = finite(value)
    return n == null ? 0 : microsToMinor(BigInt(Math.round(n)), exponent)
  }
  const valueMicros = m.conversionsValueMicros ?? m.conversions_value_micros
  const valueUnits = finite(m.conversionsValue ?? m.conversions_value)
  return {
    impressions: finite(m.impressions) ?? 0,
    clicks: finite(m.clicks) ?? 0,
    spendCents: micros(m.costMicros ?? m.cost_micros),
    conversions: finite(m.conversions) ?? 0,
    conversionValueCents: valueMicros != null ? micros(valueMicros) : valueUnits != null ? microsToMinor(BigInt(Math.round(valueUnits * 1_000_000)), exponent) : 0,
  }
}

/** Google's estimate as stored ({ baseMetrics, potentialMetrics }); null when it gave none. */
export function impactOf(stored: unknown, exponent: number): GoogleRecommendation['impact'] {
  if (!stored || typeof stored !== 'object') return null
  const json = stored as Record<string, unknown>
  const base = json.baseMetrics ?? json.base_metrics ?? json.base
  const potential = json.potentialMetrics ?? json.potential_metrics ?? json.potential
  if (!base && !potential) return null
  return { base: impactSide(base, exponent), potential: impactSide(potential, exponent) }
}

/** R13 — Google's open recommendations as the last read found them. Nexus applies none of them. */
export async function googleAdsRecommendations(input: { connectionId?: string | null; campaignId?: string | null; type?: string | null }): Promise<GoogleRecommendations> {
  const askedType = typeof input.type === 'string' && input.type.trim() ? input.type.trim().toUpperCase() : null
  if (askedType && !TYPE_RE.test(askedType)) throw new GoogleAdsReadError(400, 'type must be a Google recommendation type, such as KEYWORD.')
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const base = { read: states.read('RECOMMENDATIONS'), currency: scope.context.currency, writes: { mode: 'none' as const } }
  const customerId = scope.customerId
  if (!customerId) return { ...base, items: [], byType: [] }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const exponent = currencyExponent(scope.context.currency)
  const [rows, autoApplied] = await Promise.all([
    prisma.googleAdsRecommendation.findMany({ where: { customerId, dismissed: false, ...(googleCampaignId ? { campaignId: googleCampaignId } : {}) } }),
    prisma.googleAdsAutoApply.findMany({ where: { customerId, removedAt: null, status: 'ENABLED' }, select: { type: true } }),
  ])
  const autoTypes = new Set(autoApplied.map((a) => a.type))
  const adGroupIds = [...new Set(rows.map((r) => r.adGroupId).filter((id): id is string => !!id))]
  const [groups, directory] = await Promise.all([
    adGroupIds.length
      ? prisma.googleAdsAdGroup.findMany({ where: { customerId, adGroupId: { in: adGroupIds } }, select: { adGroupId: true, name: true } })
      : Promise.resolve([]),
    googleCampaignDirectory(
      { customerId, structureSyncedAt: scope.context.customer?.structureSyncedAt ?? null, timeZone: scope.context.timeZone },
      rows.map((r) => r.campaignId ?? ''),
    ),
  ])
  const groupName = new Map(groups.map((g) => [g.adGroupId, g.name]))
  const all = rows
    .map((row): GoogleRecommendation => {
      const words = recommendationWords(row.type)
      const campaign = row.campaignId ? directory(row.campaignId) : null
      return {
        recommendationId: row.resourceName.split('/').pop() || row.id,
        type: row.type,
        typeText: words.typeText,
        explanation: words.explanation,
        campaignId: campaign?.campaignId ?? null,
        externalCampaignId: row.campaignId,
        campaignName: campaign?.campaignName ?? null,
        adGroupName: row.adGroupId ? groupName.get(row.adGroupId) ?? null : null,
        autoApplied: autoTypes.has(row.type),
        impact: impactOf(row.impact, exponent),
      }
    })
    .sort((a, b) =>
      (textKey(a.typeText) < textKey(b.typeText) ? -1 : textKey(a.typeText) > textKey(b.typeText) ? 1 : 0)
      || (textKey(a.campaignName) < textKey(b.campaignName) ? -1 : textKey(a.campaignName) > textKey(b.campaignName) ? 1 : 0)
      || (a.recommendationId < b.recommendationId ? -1 : 1))
  const counts = new Map<string, number>()
  for (const item of all) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  const byType = [...counts]
    .map(([type, count]) => ({ type, typeText: recommendationWords(type).typeText, count }))
    .sort((a, b) => b.count - a.count || (a.type < b.type ? -1 : 1))
  return { ...base, items: askedType ? all.filter((r) => r.type === askedType) : all, byType }
}
