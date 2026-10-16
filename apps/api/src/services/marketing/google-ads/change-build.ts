/**
 * Google Ads changes, PR 6 (2026-10-15) — build a whole Google Ads structure in ONE atomic request: new shared budgets,
 * new negative keyword lists with their keywords, and campaigns — each ALWAYS paused — with their targeting, negatives,
 * lists, ad groups, keywords, product groups, responsive search ads and campaign assets. Everything new points at what it
 * belongs to through temporary ids (negative numbers, unique across the request, each defined before it is used), so
 * Google makes all of it or none of it. Steps of a change plan cannot do this: a later step cannot point at a campaign an
 * earlier step has not made yet when Google checks the plan.
 *
 * The operations go grouped by kind, in an order where every id is made before it is used (budgets, lists, list
 * keywords, campaigns, campaign criteria, list links, ad groups, ads, ad group criteria — each product group tree
 * parent-first —, assets, asset links): Google's mutate best practices ask for few kind switches, as each one is a
 * separate backend call and many of them can time a big request out.
 *
 * A campaign of the build can also be a COPY of a live campaign (`copyOf`): the tool reads it live (build-copy.ts) and
 * this file receives it already expanded, so the build is pure.
 *
 * G13 (2026-10-16, build/copy parity): a campaign of the build also takes everything the newer change tools set, so a
 * copy carries it all — device bid adjustments (campaign and ad group), radius targets, audience segments of every kind
 * (targeted, observed or excluded, with bid adjustments, at the campaign and its ad groups) and the audience setting,
 * demographics, labels (campaign, ad group, keyword, ad), URLs and tracking at every level (tracking template, final URL
 * suffix, custom parameters; a keyword's final URLs; an ad's mobile URL), ad rotation, an ad group's target CPA / ROAS,
 * the Shopping inventory filter and brand-exclusion setting, assets of every type at the campaign and its ad groups (new,
 * or the account's own linked again), placement / content / IP exclusions, brand lists and placement lists, and the
 * campaign's conversion goals. Each part reuses the change tools' own pieces (live-targeting audienceCriterion,
 * change-targeting proximityOf, change-shopping cleanFilter, live-exclusions exclusionInfo, change-urls urlItemProblems,
 * change-labels labelLinkOperation, change-assets-all newAssetSpecs / FIELD_LEVELS), with what each checked in Google's
 * v25 reference. Checked 2026-10-16 for the build itself (curl of developers.google.com/google-ads/api/…):
 *   docs/batch-processing/temporary-ids  a temporary id may name any new resource a later operation points at ("The
 *                     adGroupAdOperation … omits resourceName because no subsequent operation in the request references
 *                     the new ad"): a keyword or an ad gets one only when a label is put on it.
 *   CampaignConversionGoal / CampaignConversionGoalOperation  update only, resource name
 *                     customers/{c}/campaignConversionGoals/{campaign_id}~{category}~{origin}; Google's own sample
 *                     (google-ads-python examples/shopping_ads/add_performance_max_retail_campaign.py) updates them on the
 *                     campaign's TEMPORARY id in the same request as the campaign. ConversionGoalCampaignConfig
 *                     custom_conversion_goal (update only; customers/{c}/conversionGoalCampaignConfigs/{campaign_id}).
 *   AdGroup           ad_rotation_mode (AdGroupAdRotationMode OPTIMIZE / ROTATE_FOREVER), target_cpa_micros, target_roas,
 *                     tracking_url_template, final_url_suffix, url_custom_parameters, targeting_setting — settable on create.
 *   AdGroupAdLabel    customers/{c}/adGroupAdLabels/{ad_group_id}~{ad_id}~{label_id}; ad_group_ad Immutable.
 *   BrandListInfo     shared_set; "can be either targeted or excluded" (campaign); an ad group takes an inclusion.
 *   PositiveGeoTargetType SEARCH_INTEREST "can only be used with Search and standard Shopping campaigns";
 *                     NegativeGeoTargetType PRESENCE / PRESENCE_OR_INTEREST.
 *
 * Money: every campaign is made PAUSED, so the build spends nothing; enabling is set-google-status (SPENDS MONEY). The
 * preview shows each campaign as create-google-campaign does (budget, bidding, networks, Google's automation, targeting)
 * and what would spend once enabled: the daily budgets, and any product group that leaves the rest of the feed open.
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { campaignCreateNotes, campaignCreateOperations, campaignCreateProblem, type CampaignCreateRequest } from './change-campaigns.js'
import { httpsUrlProblem, rsaProblems, widthProblem, type RsaAd } from './change-ads.js'
import { ASSET_LIMITS, snippetHeader, type SitelinkRequest, type SnippetRequest } from './change-assets.js'
import { assetWord, FIELD_LEVELS, LINK_FIELD_TYPES, newAssetSpecs, type LinkFieldType, type NewAssetsRequest } from './change-assets-all.js'
import { ACTION_CATEGORIES, GOAL_ORIGINS } from './change-conversions.js'
import { labelLinkOperation } from './change-labels.js'
import { cleanFilter, filterWords, type FilterCondition } from './change-shopping.js'
import { proximityOf, type RadiusSpec } from './change-targeting.js'
import { urlItemProblems, type UrlLevel } from './change-urls.js'
import { keywordKey, microsOfCents, type CustomParameterValue, type LiveBudget, type LiveCampaign, type LiveNegativeList, type MatchType } from './live.js'
import { exclusionInfo, exclusionKey, MAX_IP_BLOCKS, normalizeExclusion, type ExclusionItem } from './live-exclusions.js'
import {
  AUDIENCE_KINDS, audienceCriterion, DEMOGRAPHIC_FIELD, DEMOGRAPHIC_VALUES, DEVICES, type AudienceKind, type DemographicDimension, type Device,
} from './live-targeting.js'
import { caseValueOf } from './product-tree.js'
import type { PreparedImage } from './asset-images.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

/** A level's URL and tracking fields (G3's set-google-urls): none given = none. */
export interface BuildUrlFields { trackingTemplate?: string; finalUrlSuffix?: string; customParameters?: CustomParameterValue[] }
/** An audience segment of any kind (G2), targeted / observed, or excluded; a bid adjustment only on a positive one. */
export interface BuildAudience { kind: AudienceKind; id: string; exclude?: boolean; bidModifier?: number }
/** One demographic criterion exactly as it is made (G2): excluded, or shown (a shown group narrows its dimension to the shown ones). */
export interface BuildDemographic { dimension: DemographicDimension; value: string; exclude?: boolean; bidModifier?: number }
/** A device's bid adjustment: 0 = never on that device (−100 %), else 0.1–10. */
export interface BuildDevice { device: Device; bidModifier: number }
export type BuildLinkStatus = 'ENABLED' | 'PAUSED'

export interface BuildKeyword extends BuildUrlFields {
  text: string; matchType: MatchType; bidCents?: number; status?: 'ENABLED' | 'PAUSED'
  /** Its own landing pages (AdGroupCriterion final_urls / final_mobile_urls). */
  finalUrl?: string
  finalMobileUrl?: string
  /** Existing labels of the account (label ids). */
  labels?: string[]
}
export interface BuildNegative { text: string; matchType: MatchType }
/**
 * A product group node: one to make again as it is (a copy), or of a tree a person gave (product-tree.ts buildNodesOfSpec
 * checks it against Google's rules first): its parent by index in the list, its case value as Google takes it, and
 * whether it is the rest of its parent's dimension ("everything else": the dimension with no value).
 */
export interface BuildProductNode { parent: number | null; kind: 'SUBDIVISION' | 'UNIT'; caseValue: Record<string, unknown> | null; excluded: boolean; bidCents: number | null; rest: boolean }
export type BuildProductGroups =
  | { itemIds: string[]; bidCents: number; itemBids?: Array<{ itemId: string; bidCents: number }>; includeEverythingElse?: { bidCents: number } }
  | { nodes: BuildProductNode[] }

export interface BuildAd extends RsaAd, BuildUrlFields {
  status?: 'ENABLED' | 'PAUSED'
  finalMobileUrl?: string
  /** A copy: every final URL the ad has (finalUrl is the first). */
  finalUrls?: string[]
  labels?: string[]
}

/** Assets of a campaign or an ad group: new ones of every type Nexus makes (G6), or the account's own linked again. */
export interface BuildAssets extends Omit<NewAssetsRequest, 'linkTo' | 'enable' | 'sitelinks' | 'callouts' | 'structuredSnippets'> {
  sitelinks?: SitelinkRequest[]
  callouts?: string[]
  structuredSnippets?: SnippetRequest[]
  /** Existing assets of the account linked here (a copy links the same assets, with their link status). */
  link?: Array<{ assetId: string; fieldType: string; status?: BuildLinkStatus }>
  /** The images of `images`, as the tool read them (asset-images.ts prepareImage), in order. */
  prepared?: Array<PreparedImage | { problem: string }>
}

export interface BuildAdGroup extends BuildUrlFields {
  name: string
  defaultBidCents?: number
  /** Smart Bidding targets of the ad group itself (AdGroup.target_cpa_micros / target_roas). */
  targetCpaCents?: number
  targetRoas?: number
  status?: 'ENABLED' | 'PAUSED'
  /** Ad rotation (AdGroupAdRotationMode). */
  adRotation?: 'OPTIMIZE' | 'ROTATE_FOREVER'
  keywords?: BuildKeyword[]
  negatives?: BuildNegative[]
  productGroups?: BuildProductGroups
  ads?: BuildAd[]
  /** SHOPPING: its product ad's status (default ENABLED; the campaign is paused) and labels (a copy keeps them). */
  productAdStatus?: 'ENABLED' | 'PAUSED'
  productAdLabels?: string[]
  devices?: BuildDevice[]
  audiences?: BuildAudience[]
  /** The ad group's own audience setting (never with the campaign's: Google keeps one of the two). */
  audienceMode?: 'OBSERVATION' | 'TARGETING'
  /** A copy: Google's targeting setting as it is (TargetRestriction list). */
  targetRestrictions?: Array<{ dimension: string | null; observationOnly: boolean }>
  demographics?: BuildDemographic[]
  /** Brand lists the ad group keeps to (an ad group takes an inclusion only). */
  brandLists?: string[]
  labels?: string[]
  assets?: BuildAssets
}

export interface BuildCampaign extends Omit<CampaignCreateRequest, 'budgetId' | 'dailyBudgetCents'> {
  /** Its budget: one this build makes (`ref`), an existing shared budget (`budgetId`), or a new one of its own. */
  budget: { ref: string } | { budgetId: string } | { dailyBudgetCents: number }
  /** Shared negative keyword lists: one this build makes (`ref`), or an existing one (`listId`). */
  negativeLists?: Array<{ ref: string } | { listId: string }>
  /** Campaign-level negative keywords. */
  negatives?: BuildNegative[]
  adGroups?: BuildAdGroup[]
  assets?: BuildAssets
  /** BROAD keywords are allowed in this campaign (a copy keeps what the source holds). */
  allowBroad?: boolean
  devices?: BuildDevice[]
  /** Radius targets (campaign level, targeted only). */
  radius?: RadiusSpec[]
  /** Audience segments of every kind at the campaign (`audiences` stays: interests observed). */
  audienceSegments?: BuildAudience[]
  /** Age, gender, parental status, household income at the campaign (Google: exclusions; a copy keeps what is there). */
  demographics?: BuildDemographic[]
  labels?: string[]
  /** SHOPPING: the inventory filter (the products it may advertise at all). */
  inventoryFilter?: FilterCondition[]
  /** Websites, YouTube channels / videos, apps, app categories, content labels, IP addresses excluded. */
  exclusions?: ExclusionItem[]
  /** Brand lists excluded, or kept to (include). */
  brandLists?: Array<{ listId: string; mode: 'exclude' | 'include' }>
  /** Placement exclusion lists (NEGATIVE_PLACEMENTS shared sets). */
  placementLists?: string[]
  /** The campaign's own conversion goals: which category / origin it bids for (it then stops following the account's goals). */
  conversionGoals?: Array<{ category: string; origin: string; biddable: boolean }>
  /** A copy: the custom conversion goal the campaign optimises for (ConversionGoalCampaignConfig). */
  customConversionGoalId?: string
}

export interface BuildSpec {
  sharedBudgets?: Array<{ ref: string; name: string; budgetCents: number }>
  negativeLists?: Array<{ ref: string; name: string; keywords: BuildNegative[] }>
  campaigns: BuildCampaign[]
  /** BROAD keywords (not negatives) are refused unless asked (or the campaign allows them). */
  allowBroad?: boolean
}

export interface BuildLive { campaigns: LiveCampaign[]; budgets: LiveBudget[]; lists: LiveNegativeList[] }

/** What a build made, by the operation that made it: after the run, Google's ids. */
export interface BuildRecord {
  campaigns: Array<{ name: string; campaignId: string | null; op: number; ownBudgetOp?: number; ownBudgetId?: string | null }>
  sharedBudgets: Array<{ name: string; budgetId: string | null; op: number }>
  negativeLists: Array<{ name: string; listId: string | null; op: number }>
}

/**
 * The most operations one build sends. A build is checked by Google (its preview) and then sent (its run): twice its
 * size on the account's change allowance (ops-budget.ts WRITE_ACCOUNT_DAILY_OPS), with room for the live reads and a
 * check-google-ads-build of the same plan (Google's acceptance is remembered for 30 minutes, so it is not paid twice).
 */
export const MAX_BUILD_OPERATIONS = 900

/** The order of the kinds in the request: every resource is made before anything points at it. */
const KIND_ORDER = [
  'campaignBudgetOperation', 'sharedSetOperation', 'sharedCriterionOperation', 'campaignOperation', 'campaignCriterionOperation',
  'campaignSharedSetOperation', 'campaignLabelOperation', 'adGroupOperation', 'adGroupBidModifierOperation', 'adGroupLabelOperation',
  'adGroupAdOperation', 'adGroupAdLabelOperation', 'adGroupCriterionOperation', 'adGroupCriterionLabelOperation', 'assetOperation',
  'campaignAssetOperation', 'adGroupAssetOperation',
  // Last, as Google's own sample sends them: the new campaign's goals (an update on its temporary id), then its goal setting.
  'campaignConversionGoalOperation', 'conversionGoalCampaignConfigOperation',
] as const

/** An operation with what the record needs to find it again after the operations are put in order. */
interface Tagged { op: GoogleMutateOperation; tag?: string }

export function buildDraft(customer: string, currency: string, spec: BuildSpec, live: BuildLive): GoogleChangeDraft | { refusal: string } {
  if (!spec.campaigns.length && !spec.sharedBudgets?.length && !spec.negativeLists?.length) return { refusal: 'The build holds nothing.' }
  const problems: string[] = []
  let next = -1
  const temp = () => next--
  const tagged: Tagged[] = []
  const push = (op: GoogleMutateOperation, tag?: string) => tagged.push({ op, ...(tag ? { tag } : {}) })
  const lower = (s: string) => s.trim().toLowerCase()
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const totals = { campaigns: 0, adGroups: 0, keywords: 0, negatives: 0, productGroups: 0, ads: 0, assets: 0, criteria: 0, labels: 0 }

  // Names Google keeps unique: campaigns, shared budgets, negative keyword lists (in the account and in the build).
  const unique = (what: string, names: string[], taken: Set<string>) => {
    const seen = new Set<string>()
    for (const n of names) {
      if (taken.has(lower(n))) problems.push(`A ${what} named "${n}" already exists in the account: Google refuses a second one.`)
      if (seen.has(lower(n))) problems.push(`Two ${what}s of the build are named "${n}".`)
      seen.add(lower(n))
    }
  }
  unique('campaign', spec.campaigns.map((c) => c.name), new Set(live.campaigns.map((c) => lower(c.name))))
  unique('budget', (spec.sharedBudgets ?? []).map((b) => b.name), new Set(live.budgets.map((b) => lower(b.name ?? ''))))
  unique('negative keyword list', (spec.negativeLists ?? []).map((l) => l.name), new Set(live.lists.map((l) => lower(l.name ?? ''))))

  // 1. Shared budgets.
  const budgetRefs = new Map<string, { res: string; cents: number; name: string }>()
  for (const b of spec.sharedBudgets ?? []) {
    if (budgetRefs.has(b.ref)) { problems.push(`Budget ref "${b.ref}" is used twice.`); continue }
    const res = `${customer}/campaignBudgets/${temp()}`
    push({ campaignBudgetOperation: { create: { resourceName: res, name: b.name.trim(), amountMicros: microsOfCents(b.budgetCents), explicitlyShared: true, deliveryMethod: 'STANDARD' } } }, `budget:${b.name.trim()}`)
    budgetRefs.set(b.ref, { res, cents: b.budgetCents, name: b.name.trim() })
    lines.push([`new shared budget "${b.name.trim()}"`, '(none)', `${money(b.budgetCents, currency)} a day`])
  }

  // 2. Negative keyword lists and their keywords.
  const listRefs = new Map<string, string>()
  for (const l of spec.negativeLists ?? []) {
    if (listRefs.has(l.ref)) { problems.push(`List ref "${l.ref}" is used twice.`); continue }
    const res = `${customer}/sharedSets/${temp()}`
    push({ sharedSetOperation: { create: { resourceName: res, name: l.name.trim(), type: 'NEGATIVE_KEYWORDS' } } }, `list:${l.name.trim()}`)
    listRefs.set(l.ref, res)
    const seen = new Set<string>()
    for (const k of l.keywords) {
      const p = keywordTextProblem(k.text)
      if (p) { problems.push(`List "${l.name}": negative "${k.text}" ${p}.`); continue }
      const key = keywordKey(k.text, k.matchType)
      if (seen.has(key)) continue
      seen.add(key)
      push({ sharedCriterionOperation: { create: { sharedSet: res, keyword: { text: k.text.trim(), matchType: k.matchType } } } })
    }
    totals.negatives += seen.size
    lines.push([`new negative keyword list "${l.name.trim()}"`, '(none)', plural(seen.size, 'keyword')])
  }

  // 3. Campaigns.
  let dailyIfEnabled = 0
  const countedBudgets = new Set<string>()
  spec.campaigns.forEach((c, ci) => {
    const where = `campaign ${ci + 1} "${c.name}"`
    let budgetRes: string
    let budgetCents: number | null
    let budgetText: string
    let ownBudget = false
    if ('ref' in c.budget) {
      const b = budgetRefs.get(c.budget.ref)
      if (!b) { problems.push(`${where}: budget ref "${c.budget.ref}" is not a budget of the build.`); return }
      budgetRes = b.res; budgetCents = b.cents; budgetText = `new shared "${b.name}" ${money(b.cents, currency)} a day`
    } else if ('budgetId' in c.budget) {
      const b = live.budgets.find((x) => x.budgetId === (c.budget as { budgetId: string }).budgetId)
      if (!b) { problems.push(`${where}: budget ${c.budget.budgetId} is not in the account.`); return }
      if (!b.shared) { problems.push(`${where}: budget ${c.budget.budgetId} is another campaign's own budget.`); return }
      budgetRes = `${customer}/campaignBudgets/${b.budgetId}`; budgetCents = b.amountCents; budgetText = `shared "${b.name ?? b.budgetId}" ${money(b.amountCents, currency)} a day`
    } else {
      budgetRes = `${customer}/campaignBudgets/${temp()}`; budgetCents = c.budget.dailyBudgetCents; budgetText = `its own ${money(c.budget.dailyBudgetCents, currency)} a day`
      ownBudget = true
    }
    // Audience segments the campaign targets or observes, without a setting said: OBSERVATION (they set bids, they never
    // narrow who sees the ads), as set-google-audiences adds them; a copy gives Google's setting as it is (targetRestrictions).
    const observed = !c.audienceMode && !c.targetRestrictions && !c.audiences?.length && (c.audienceSegments ?? []).some((a) => !a.exclude)
    const request: CampaignCreateRequest = { ...c, budgetId: undefined, dailyBudgetCents: undefined, ...(observed ? { audienceMode: 'OBSERVATION' as const } : {}) }
    const problem = campaignCreateProblem(request)
    if (problem) { problems.push(`${where}: ${problem}`); return }
    const campaignRes = `${customer}/campaigns/${temp()}`
    if (ownBudget) push({ campaignBudgetOperation: { create: { resourceName: budgetRes, amountMicros: microsOfCents(budgetCents!), explicitlyShared: false, deliveryMethod: 'STANDARD' } } }, `own:${c.name.trim()}`)
    const created = campaignCreateOperations(customer, request, budgetRes, campaignRes)
    if ('refusal' in created) { problems.push(`${where}: ${created.refusal}`); return }
    created.operations.forEach((op) => push(op, 'campaignOperation' in op ? `campaign:${c.name.trim()}` : undefined))
    totals.campaigns += 1
    if (budgetCents !== null && !countedBudgets.has(budgetRes)) { dailyIfEnabled += budgetCents; countedBudgets.add(budgetRes) }
    const notes = campaignCreateNotes(request, currency, budgetText)
    // The campaign's own lines, named by it ("new campaign" first), so a copy shows every setting it carries over.
    for (const [label, from, to] of notes.lines) lines.push([label === 'new campaign' ? `new campaign ${ci + 1}` : `campaign ${ci + 1} ${label}`, from, to])
    warnings.push(...notes.warnings)

    // Campaign negatives and lists.
    const negSeen = new Set<string>()
    for (const n of c.negatives ?? []) {
      const p = keywordTextProblem(n.text)
      if (p) { problems.push(`${where}: negative "${n.text}" ${p}.`); continue }
      const key = keywordKey(n.text, n.matchType)
      if (negSeen.has(key)) continue
      negSeen.add(key)
      push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, keyword: { text: n.text.trim(), matchType: n.matchType } } } })
    }
    totals.negatives += negSeen.size
    for (const l of c.negativeLists ?? []) {
      let res: string | undefined
      if ('ref' in l) res = listRefs.get(l.ref)
      else if (live.lists.some((x) => x.listId === l.listId)) res = `${customer}/sharedSets/${l.listId}`
      if (!res) { problems.push(`${where}: negative keyword list ${'ref' in l ? `ref "${l.ref}"` : l.listId} is not in the build or the account.`); continue }
      push({ campaignSharedSetOperation: { create: { campaign: campaignRes, sharedSet: res } } })
    }

    // G13: what the newer change tools set on a campaign.
    const extras = campaignExtras(customer, campaignRes, c, where)
    problems.push(...extras.problems)
    extras.ops.forEach((op) => push(op))
    totals.criteria += extras.criteria
    totals.labels += extras.labels
    for (const [label, from, to] of extras.lines) lines.push([`campaign ${ci + 1} ${label}`, from, to])
    warnings.push(...extras.warnings)
    const campaignDevice = new Map((c.devices ?? []).map((d) => [d.device, d.bidModifier]))

    // Ad groups.
    const isShopping = c.type === 'SHOPPING'
    const groupNames = new Set<string>()
    let open = 0
    for (const g of c.adGroups ?? []) {
      const gWhere = `${where}, ad group "${g.name}"`
      if (groupNames.has(lower(g.name))) { problems.push(`${gWhere}: two ad groups of the campaign have this name.`); continue }
      groupNames.add(lower(g.name))
      if (isShopping && (g.keywords?.length || g.ads?.length)) problems.push(`${gWhere}: a Shopping ad group has no keywords or text ads (its products are its ads).`)
      if (!isShopping && g.productGroups) problems.push(`${gWhere}: product groups are for Shopping ad groups.`)
      const agRes = `${customer}/adGroups/${temp()}`
      const agId = agRes.slice(agRes.lastIndexOf('/') + 1)
      problems.push(...urlProblemsOf('ad-group', g, gWhere))
      if (g.targetRoas !== undefined && !(g.targetRoas > 0 && g.targetRoas <= 1000)) problems.push(`${gWhere}: a target ROAS is a ratio above 0 (1.5 = 150 %)`)
      const campaignSetting = !!(request.audienceMode || request.targetRestrictions?.length || request.audiences?.length)
      if (g.audienceMode && campaignSetting) problems.push(`${gWhere}: Google keeps the audience setting on the campaign OR on its ad groups, not both`)
      // Positive segments of an ad group without a setting anywhere: OBSERVATION, as at the campaign (a copy says it outright).
      const groupMode = g.audienceMode ?? (!g.targetRestrictions && !campaignSetting && (g.audiences ?? []).some((a) => !a.exclude) ? 'OBSERVATION' : undefined)
      const groupRestrictions = g.targetRestrictions ?? (groupMode ? [{ dimension: 'AUDIENCE', observationOnly: groupMode === 'OBSERVATION' }] : [])
      push({ adGroupOperation: { create: {
        resourceName: agRes, campaign: campaignRes, name: g.name.trim(), status: g.status ?? 'ENABLED', type: isShopping ? 'SHOPPING_PRODUCT_ADS' : 'SEARCH_STANDARD',
        ...(g.defaultBidCents ? { cpcBidMicros: microsOfCents(g.defaultBidCents) } : {}),
        ...(g.targetCpaCents ? { targetCpaMicros: microsOfCents(g.targetCpaCents) } : {}),
        ...(g.targetRoas ? { targetRoas: g.targetRoas } : {}),
        ...(g.adRotation ? { adRotationMode: g.adRotation } : {}),
        ...urlBody(g),
        ...(groupRestrictions.some((t) => t.dimension) ? { targetingSetting: { targetRestrictions: groupRestrictions.filter((t) => t.dimension).map((t) => ({ targetingDimension: t.dimension, bidOnly: t.observationOnly })) } } : {}),
      } } })
      totals.adGroups += 1
      const groupExtras = adGroupExtras(customer, agRes, g, gWhere, campaignDevice)
      problems.push(...groupExtras.problems)
      groupExtras.ops.forEach((op) => push(op))
      totals.criteria += groupExtras.criteria
      totals.labels += groupExtras.labels
      if (isShopping) {
        const productAdRes = g.productAdLabels?.length ? `${customer}/adGroupAds/${agId}~${temp()}` : null
        push({ adGroupAdOperation: { create: { ...(productAdRes ? { resourceName: productAdRes } : {}), adGroup: agRes, status: g.productAdStatus ?? 'ENABLED', ad: { shoppingProductAd: {} } } } })
        if (productAdRes) for (const l of labelLinks(customer, 'ad', productAdRes.slice(productAdRes.lastIndexOf('/') + 1), g.productAdLabels!, `${gWhere}, product ad`, problems)) { push(l); totals.labels += 1 }
      }
      const kwSeen = new Set<string>()
      for (const k of g.keywords ?? []) {
        const p = keywordTextProblem(k.text)
        if (p) { problems.push(`${gWhere}: keyword "${k.text}" ${p}.`); continue }
        if (k.matchType === 'BROAD' && !spec.allowBroad && !c.allowBroad) { problems.push(`${gWhere}: keyword "${k.text}" is BROAD (refused unless allowBroad).`); continue }
        const key = keywordKey(k.text, k.matchType)
        if (kwSeen.has(key)) continue
        kwSeen.add(key)
        problems.push(...urlProblemsOf('keyword', k, `${gWhere}, keyword "${k.text}"`))
        // A keyword gets a temporary id only when a label is put on it (the label's link points at it).
        const kwRes = k.labels?.length ? `${customer}/adGroupCriteria/${agId}~${temp()}` : null
        push({ adGroupCriterionOperation: { create: {
          ...(kwRes ? { resourceName: kwRes } : {}),
          adGroup: agRes, status: k.status ?? 'ENABLED', keyword: { text: k.text.trim(), matchType: k.matchType }, ...(k.bidCents ? { cpcBidMicros: microsOfCents(k.bidCents) } : {}),
          ...(k.finalUrl ? { finalUrls: [k.finalUrl.trim()] } : {}),
          ...(k.finalMobileUrl ? { finalMobileUrls: [k.finalMobileUrl.trim()] } : {}),
          ...urlBody(k),
        } } })
        if (kwRes) for (const l of labelLinks(customer, 'keyword', kwRes.slice(kwRes.lastIndexOf('/') + 1), k.labels!, `${gWhere}, keyword "${k.text}"`, problems)) { push(l); totals.labels += 1 }
      }
      totals.keywords += kwSeen.size
      const agNeg = new Set<string>()
      for (const n of g.negatives ?? []) {
        const p = keywordTextProblem(n.text)
        if (p) { problems.push(`${gWhere}: negative "${n.text}" ${p}.`); continue }
        const key = keywordKey(n.text, n.matchType)
        if (agNeg.has(key)) continue
        agNeg.add(key)
        push({ adGroupCriterionOperation: { create: { adGroup: agRes, negative: true, keyword: { text: n.text.trim(), matchType: n.matchType } } } })
      }
      totals.negatives += agNeg.size
      if (g.productGroups) {
        const tree = productGroupOperations(customer, agRes, g.productGroups, temp)
        if ('refusal' in tree) problems.push(`${gWhere}: ${tree.refusal}`)
        else { tree.operations.forEach((op) => push(op)); totals.productGroups += tree.operations.length; open += tree.openRest }
      }
      ;(g.ads ?? []).forEach((ad, ai) => {
        const adProblems = rsaProblems(ad, ai + 1).map((p) => `${gWhere}, ${p}`)
        adProblems.push(...urlProblemsOf('ad', ad, `${gWhere}, ad ${ai + 1}`))
        for (const u of [...(ad.finalUrls ?? []).slice(1), ad.finalMobileUrl ?? '']) { const p = u ? httpsUrlProblem(`${gWhere}, ad ${ai + 1}`, u) : null; if (p) adProblems.push(p) }
        if (adProblems.length) { problems.push(...adProblems); return }
        // An ad gets a temporary id only when a label is put on it (docs/batch-processing/temporary-ids).
        const adRes = ad.labels?.length ? `${customer}/adGroupAds/${agId}~${temp()}` : null
        push({ adGroupAdOperation: { create: { ...(adRes ? { resourceName: adRes } : {}), adGroup: agRes, status: ad.status ?? 'ENABLED', ad: {
          finalUrls: ad.finalUrls?.length ? ad.finalUrls.map((u) => u.trim()) : [ad.finalUrl.trim()],
          ...(ad.finalMobileUrl ? { finalMobileUrls: [ad.finalMobileUrl.trim()] } : {}),
          ...urlBody(ad),
          responsiveSearchAd: {
            headlines: ad.headlines.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pinnedField: t.pin } : {}) })),
            descriptions: ad.descriptions.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pinnedField: t.pin } : {}) })),
            ...(ad.path1?.trim() ? { path1: ad.path1.trim() } : {}),
            ...(ad.path2?.trim() ? { path2: ad.path2.trim() } : {}),
          },
        } } } })
        if (adRes) for (const l of labelLinks(customer, 'ad', adRes.slice(adRes.lastIndexOf('/') + 1), ad.labels!, `${gWhere}, ad ${ai + 1}`, problems)) { push(l); totals.labels += 1 }
        totals.ads += 1
      })
      // The ad group's assets.
      const groupAssets = assetOperations(customer, { level: 'ad-group', res: agRes }, currency, g.assets, temp)
      if ('refusal' in groupAssets) problems.push(`${gWhere}: ${groupAssets.refusal}`)
      else { groupAssets.operations.forEach((op) => push(op)); totals.assets += groupAssets.count }
    }
    if (open) warnings.push(`${where}: ${plural(open, 'product group')} leave the rest of the feed OPEN (an advertised "everything else" or "All products"): once enabled it can advertise every other product of the feed.`)

    // Campaign assets.
    const assets = assetOperations(customer, { level: 'campaign', res: campaignRes }, currency, c.assets, temp)
    if ('refusal' in assets) problems.push(`${where}: ${assets.refusal}`)
    else { assets.operations.forEach((op) => push(op)); totals.assets += assets.count }
  })

  if (problems.length) return { refusal: `The build cannot be sent as it is (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}${problems.length > 25 ? ` · … ${problems.length - 25} more` : ''}` }
  if (tagged.length > MAX_BUILD_OPERATIONS) {
    return { refusal: `The build holds ${tagged.length} operations, more than the ${MAX_BUILD_OPERATIONS} one build sends (its check and its run must fit the account's daily Google Ads allowance). Split it into builds of fewer campaigns.` }
  }

  // Grouped by kind (stable: the order inside a kind is the order made, so a tree stays parent-first).
  const rank = (t: Tagged) => KIND_ORDER.indexOf(Object.keys(t.op)[0] as typeof KIND_ORDER[number])
  const ordered = tagged.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
  const at = (tag: string) => ordered.findIndex((t) => t.tag === tag)
  const record: BuildRecord = {
    campaigns: spec.campaigns.filter((c) => at(`campaign:${c.name.trim()}`) >= 0).map((c) => ({
      name: c.name.trim(), campaignId: null, op: at(`campaign:${c.name.trim()}`),
      ...(at(`own:${c.name.trim()}`) >= 0 ? { ownBudgetOp: at(`own:${c.name.trim()}`), ownBudgetId: null } : {}),
    })),
    sharedBudgets: (spec.sharedBudgets ?? []).map((b) => ({ name: b.name.trim(), budgetId: null, op: at(`budget:${b.name.trim()}`) })),
    negativeLists: (spec.negativeLists ?? []).map((l) => ({ name: l.name.trim(), listId: null, op: at(`list:${l.name.trim()}`) })),
  }
  const { changes, more } = changeLines(lines)
  // A call or a lead form linked in a new campaign brings paid interactions once the campaign is enabled (G6's rule).
  const paidLinks = spec.campaigns.some((c) => [c.assets, ...(c.adGroups ?? []).map((g) => g.assets)].some((a) => !!a && (
    !!a.calls?.length || !!a.leadForms?.length || (a.link ?? []).some((l) => l.fieldType === 'CALL' || l.fieldType === 'LEAD_FORM'))))
  if (paidLinks) warnings.unshift('Call or lead form assets are linked in the new campaigns: once a campaign is enabled, people can call or open the form from its ads, each charged like a click.')
  if (totals.campaigns) warnings.unshift(`Every campaign is made PAUSED: nothing spends until a person enables one (set-google-status, SPENDS MONEY). Once enabled, their daily budgets add up to ${money(dailyIfEnabled, currency)}.`)
  return {
    summary: `Google Ads build: ${[record.sharedBudgets.length && plural(record.sharedBudgets.length, 'shared budget'), record.negativeLists.length && plural(record.negativeLists.length, 'negative keyword list'), totals.campaigns && `${plural(totals.campaigns, 'campaign')} (PAUSED)`].filter(Boolean).join(', ')} — in one request.`,
    changes,
    totals: { operations: ordered.length, ...totals, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    operations: ordered.map((t) => t.op),
    stands: {
      // The names the build takes must still be free; nothing else of the account is changed.
      names: [...spec.campaigns.map((c) => `c:${lower(c.name)}`), ...(spec.sharedBudgets ?? []).map((b) => `b:${lower(b.name)}`), ...(spec.negativeLists ?? []).map((l) => `l:${lower(l.name)}`)].sort(),
      budgets: live.budgets.filter((b) => spec.campaigns.some((c) => 'budgetId' in c.budget && c.budget.budgetId === b.budgetId)).map((b) => `${b.budgetId}:${b.amountCents}:${b.shared}`).sort(),
      lists: live.lists.filter((l) => spec.campaigns.some((c) => (c.negativeLists ?? []).some((x) => 'listId' in x && x.listId === l.listId))).map((l) => l.listId).sort(),
    },
    before: null,
    after: record,
  }
}

/** The ids Google gave what the build made, by the operation that made each. */
export function buildRecordAfterRun(after: BuildRecord, responses: GoogleMutateResponse[]): BuildRecord {
  const idAt = (op: number, kind: string) => {
    const name = responses[op]?.[kind]?.resourceName
    return name ? name.slice(name.lastIndexOf('/') + 1) : null
  }
  return {
    campaigns: after.campaigns.map((c) => ({
      ...c, campaignId: idAt(c.op, 'campaignResult'),
      ...(c.ownBudgetOp !== undefined ? { ownBudgetId: idAt(c.ownBudgetOp, 'campaignBudgetResult') } : {}),
    })),
    sharedBudgets: after.sharedBudgets.map((b) => ({ ...b, budgetId: idAt(b.op, 'campaignBudgetResult') })),
    negativeLists: after.negativeLists.map((l) => ({ ...l, listId: idAt(l.op, 'sharedSetResult') })),
  }
}

// ── product groups ──────────────────────────────────────────────────────────────────────────────────────────────

function productGroupOperations(
  customer: string,
  adGroupRes: string,
  pg: BuildProductGroups,
  temp: () => number,
): { operations: GoogleMutateOperation[]; openRest: number } | { refusal: string } {
  const adGroupId = adGroupRes.slice(adGroupRes.lastIndexOf('/') + 1)
  const res = () => `${customer}/adGroupCriteria/${adGroupId}~${temp()}`
  const ops: GoogleMutateOperation[] = []
  if ('nodes' in pg) {
    // A copy: every node again, parent first. Open = an advertised unit that is the rest of its dimension, or "All
    // products" itself as one advertised unit.
    const made: string[] = []
    let open = 0
    for (const [i, n] of pg.nodes.entries()) {
      if (n.parent !== null && (n.parent >= i || !made[n.parent])) return { refusal: 'the product group tree to copy lists a child before its parent.' }
      const name = res()
      made[i] = name
      if (n.kind === 'UNIT' && !n.excluded && (n.rest || n.parent === null)) open += 1
      ops.push({ adGroupCriterionOperation: { create: {
        resourceName: name, status: 'ENABLED',
        ...(n.kind === 'UNIT' && n.excluded ? { negative: true } : {}),
        ...(n.kind === 'UNIT' && !n.excluded && n.bidCents ? { cpcBidMicros: microsOfCents(n.bidCents) } : {}),
        listingGroup: { type: n.kind, ...(n.parent !== null ? { parentAdGroupCriterion: made[n.parent] } : {}), ...(n.caseValue ? { caseValue: n.caseValue } : {}) },
      } } })
    }
    return { operations: ops, openRest: open }
  }
  // Item ids once, compared without case (Merchant Center may read ids differing only by case as one); the first spelling.
  const byKey = new Map<string, string>()
  for (const id of pg.itemIds) if (id.trim() && !byKey.has(id.trim().toLowerCase())) byKey.set(id.trim().toLowerCase(), id.trim())
  const ids = [...byKey.values()]
  if (!ids.length) return { refusal: 'product groups need at least one item id.' }
  if (ids.some((id) => id.length > 50 || id.includes('==') || id.includes('&+'))) return { refusal: 'an item id is longer than 50 characters or holds "==" or "&+".' }
  const root = res()
  ops.push({ adGroupCriterionOperation: { create: { resourceName: root, status: 'ENABLED', listingGroup: { type: 'SUBDIVISION' } } } })
  const rest = pg.includeEverythingElse
  ops.push({ adGroupCriterionOperation: { create: {
    resourceName: res(), status: 'ENABLED', ...(rest ? { cpcBidMicros: microsOfCents(rest.bidCents) } : { negative: true }),
    listingGroup: { type: 'UNIT', parentAdGroupCriterion: root, caseValue: { productItemId: {} } },
  } } })
  const bidOf = new Map((pg.itemBids ?? []).map((b) => [b.itemId.trim().toLowerCase(), b.bidCents]))
  for (const id of ids) {
    ops.push({ adGroupCriterionOperation: { create: {
      resourceName: res(), status: 'ENABLED', cpcBidMicros: microsOfCents(bidOf.get(id.toLowerCase()) ?? pg.bidCents),
      listingGroup: { type: 'UNIT', parentAdGroupCriterion: root, caseValue: { productItemId: { value: id } } },
    } } })
  }
  return { operations: ops, openRest: rest ? 1 : 0 }
}

// ── G13: the parts the newer change tools set ───────────────────────────────────────────────────────────────────

const POSITIVE_ONLY_AUDIENCES: ReadonlySet<string> = new Set(['CUSTOM_AUDIENCE', 'COMBINED_AUDIENCE'])
const DEVICE_WORDS: Record<string, string> = { MOBILE: 'mobile phones', DESKTOP: 'computers', TABLET: 'tablets', CONNECTED_TV: 'TV screens' }
const factorText = (f: number) => (f === 0 ? '−100 % (never)' : f === 1 ? 'none' : `${f > 1 ? '+' : '−'}${Math.abs(Math.round((f - 1) * 1000) / 10)} %`)

/** A level's URL fields as Google's JSON takes them (none given = none). */
function urlBody(x: BuildUrlFields): Record<string, unknown> {
  return {
    ...(x.trackingTemplate?.trim() ? { trackingUrlTemplate: x.trackingTemplate.trim() } : {}),
    ...(x.finalUrlSuffix?.trim() ? { finalUrlSuffix: x.finalUrlSuffix.trim() } : {}),
    ...(x.customParameters?.length ? { urlCustomParameters: x.customParameters.map((p) => ({ key: p.key.trim(), value: p.value.trim() })) } : {}),
  }
}

/** Google's URL rules on a level's fields (change-urls.ts urlItemProblems, set-google-urls' own check). */
function urlProblemsOf(level: UrlLevel, x: BuildUrlFields & { finalUrl?: string; finalMobileUrl?: string }, where: string): string[] {
  return urlItemProblems({
    level, id: '0',
    ...(x.trackingTemplate !== undefined ? { trackingTemplate: x.trackingTemplate } : {}),
    ...(x.finalUrlSuffix !== undefined ? { finalUrlSuffix: x.finalUrlSuffix } : {}),
    ...(x.customParameters !== undefined ? { customParameters: x.customParameters } : {}),
    // An ad's final URLs are checked with the ad (rsaProblems); a keyword's here.
    ...(level === 'keyword' && x.finalUrl !== undefined ? { finalUrl: x.finalUrl } : {}),
    ...(level === 'keyword' && x.finalMobileUrl !== undefined ? { finalMobileUrl: x.finalMobileUrl } : {}),
  }, where)
}

/** Label links of a new item (change-labels.ts labelLinkOperation): `id` its id as the link names it (a temporary one too). */
function labelLinks(customer: string, kind: 'campaign' | 'ad-group' | 'ad' | 'keyword', id: string, labels: string[], where: string, problems: string[]): GoogleMutateOperation[] {
  const ops: GoogleMutateOperation[] = []
  for (const labelId of [...new Set(labels)]) {
    if (!/^\d{1,20}$/.test(labelId)) { problems.push(`${where}: label "${labelId}" is not a label id (google-ads-live view labels)`); continue }
    const link = labelLinkOperation(customer, kind, id, `${customer}/labels/${labelId}`)
    ops.push({ [link.op]: { create: { [link.field]: link.item, label: `${customer}/labels/${labelId}` } } })
  }
  if (labels.length > 50) problems.push(`${where}: at most 50 labels on one item (Google's limit)`)
  return ops
}

function deviceProblems(devices: BuildDevice[], where: string): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const d of devices) {
    if (!(DEVICES as readonly string[]).includes(d.device)) problems.push(`${where}: "${d.device}" is not a device Google adjusts (${DEVICES.join(', ')})`)
    if (seen.has(d.device)) problems.push(`${where}: ${DEVICE_WORDS[d.device] ?? d.device} named twice in devices`)
    seen.add(d.device)
    if (!(d.bidModifier === 0 || (d.bidModifier >= 0.1 && d.bidModifier <= 10))) problems.push(`${where}: a device bid adjustment is 0 (never on ${DEVICE_WORDS[d.device] ?? d.device}) or between 0.1 and 10`)
  }
  return problems
}

/** An audience segment's criterion body (live-targeting.ts audienceCriterion) with Google's rules checked (change-audiences.ts). */
function audienceBodies(customer: string, list: BuildAudience[], where: string, problems: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const a of list) {
    const w = `${where}: audience ${a.kind} ${a.id}`
    if (!(AUDIENCE_KINDS as readonly string[]).includes(a.kind)) { problems.push(`${w} is not a kind Nexus knows (${AUDIENCE_KINDS.join(', ')})`); continue }
    if (!/^\d{1,20}$/.test(a.id)) { problems.push(`${w}: the id is digits only`); continue }
    if (seen.has(`${a.kind}|${a.id}`)) { problems.push(`${w} is named twice`); continue }
    seen.add(`${a.kind}|${a.id}`)
    if (a.exclude && POSITIVE_ONLY_AUDIENCES.has(a.kind)) { problems.push(`${w}: Google cannot exclude a custom or combined segment`); continue }
    if (a.exclude && a.bidModifier !== undefined) { problems.push(`${w}: an excluded audience has no bid adjustment`); continue }
    if (a.bidModifier !== undefined && !(a.bidModifier >= 0.1 && a.bidModifier <= 10)) { problems.push(`${w}: a bid adjustment is between 0.1 and 10`); continue }
    out.push({ ...(a.exclude ? { negative: true } : {}), ...(a.bidModifier !== undefined && a.bidModifier !== 1 ? { bidModifier: a.bidModifier } : {}), ...audienceCriterion(customer, a.kind, a.id) })
  }
  return out
}

/** Demographic criteria exactly as given (change-demographics.ts: AgeRangeInfo / GenderInfo / ParentalStatusInfo / IncomeRangeInfo `type`). */
function demographicBodies(list: BuildDemographic[], where: string, problems: string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const seen = new Set<string>()
  for (const d of list) {
    const w = `${where}: ${d.dimension} ${d.value}`
    const values = (DEMOGRAPHIC_VALUES as Record<string, readonly string[]>)[d.dimension]
    if (!values) { problems.push(`${w}: "${d.dimension}" is not AGE_RANGE, GENDER, PARENTAL_STATUS or INCOME_RANGE`); continue }
    if (!values.includes(d.value)) { problems.push(`${w}: Google's values are ${values.join(', ')}`); continue }
    if (seen.has(`${d.dimension}|${d.value}`)) { problems.push(`${w} is named twice`); continue }
    seen.add(`${d.dimension}|${d.value}`)
    if (d.exclude && d.bidModifier !== undefined) { problems.push(`${w}: an excluded group has no bid adjustment`); continue }
    if (d.bidModifier !== undefined && !(d.bidModifier >= 0.1 && d.bidModifier <= 10)) { problems.push(`${w}: a bid adjustment is between 0.1 and 10`); continue }
    out.push({ ...(d.exclude ? { negative: true } : {}), ...(d.bidModifier !== undefined && d.bidModifier !== 1 ? { bidModifier: d.bidModifier } : {}), [DEMOGRAPHIC_FIELD[d.dimension]]: { type: d.value } })
  }
  // CriterionError.CANNOT_EXCLUDE_ALL_TARGETS (change-demographics.ts): every group of a dimension excluded.
  for (const [dimension, values] of Object.entries(DEMOGRAPHIC_VALUES)) {
    if (values.every((v) => list.some((d) => d.dimension === dimension && d.value === v && d.exclude))) problems.push(`${where}: every ${dimension} group is excluded (Google refuses it: its ads could show to no one)`)
  }
  return out
}

/** A campaign's parts beyond create-google-campaign's: criteria, labels, lists, goals, and how they read. */
function campaignExtras(customer: string, campaignRes: string, c: BuildCampaign, where: string): {
  ops: GoogleMutateOperation[]; problems: string[]; lines: Array<[string, unknown, unknown]>; warnings: string[]; criteria: number; labels: number
} {
  const ops: GoogleMutateOperation[] = []
  const problems: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const criterion = (body: Record<string, unknown>) => ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, ...body } } })
  let criteria = 0
  const campaignId = campaignRes.slice(campaignRes.lastIndexOf('/') + 1)

  problems.push(...urlProblemsOf('campaign', c, where))
  if (c.devices?.length) {
    problems.push(...deviceProblems(c.devices, where))
    if (['DESKTOP', 'MOBILE', 'TABLET'].every((d) => c.devices!.some((x) => x.device === d && x.bidModifier === 0))) problems.push(`${where}: opted out of computers, mobile phones and tablets — its ads could show nowhere`)
    for (const d of c.devices) criterion({ device: { type: d.device }, bidModifier: d.bidModifier })
    criteria += c.devices.length
    lines.push(['devices', '(none)', c.devices.map((d) => `${DEVICE_WORDS[d.device] ?? d.device} ${factorText(d.bidModifier)}`).join(', ')])
  }
  for (const [i, r] of (c.radius ?? []).entries()) {
    if (!(r.radius > 0)) { problems.push(`${where}: radius ${i + 1} needs a radius above 0`); continue }
    if (r.bidModifier !== undefined && !(r.bidModifier >= 0.1 && r.bidModifier <= 10)) { problems.push(`${where}: radius ${i + 1}: a bid adjustment is between 0.1 and 10`); continue }
    const p = proximityOf(r)
    if ('refusal' in p) { problems.push(`${where}: radius ${i + 1}: ${p.refusal}`); continue }
    criterion({ ...p, ...(r.bidModifier !== undefined && r.bidModifier !== 1 ? { bidModifier: r.bidModifier } : {}) })
    criteria += 1
  }
  if (c.radius?.length) lines.push(['radius targets', '(none)', plural(c.radius.length, 'radius', 'radii')])
  const audiences = audienceBodies(customer, c.audienceSegments ?? [], where, problems)
  for (const body of audiences) criterion(body)
  criteria += audiences.length
  if (c.audienceSegments?.length) {
    const excluded = c.audienceSegments.filter((a) => a.exclude).length
    lines.push(['audience segments', '(none)', `${c.audienceSegments.length - excluded} on, ${excluded} excluded`])
  }
  const demographics = demographicBodies(c.demographics ?? [], where, problems)
  for (const body of demographics) criterion(body)
  criteria += demographics.length
  if (c.demographics?.length) lines.push(['demographics', '(none)', `${c.demographics.filter((d) => d.exclude).length} excluded, ${c.demographics.filter((d) => !d.exclude).length} shown`])

  if (c.inventoryFilter?.length) {
    if (c.type !== 'SHOPPING') problems.push(`${where}: an inventory filter is for a Shopping campaign`)
    const filter = cleanFilter(c.inventoryFilter)
    if (!Array.isArray(filter)) problems.push(`${where}: inventory filter: ${filter.refusal}`)
    else {
      criterion({ listingScope: { dimensions: filter.map((x) => caseValueOf(x.dimension, x.value)) } })
      criteria += 1
      lines.push(['inventory filter', '(none)', filterWords(filter)])
      warnings.push(`${where}: only products with ${filterWords(filter)} can be advertised (its product groups set the bids among them).`)
    }
  }
  const excluded = new Set<string>()
  let ips = 0
  for (const raw of c.exclusions ?? []) {
    const item = normalizeExclusion(raw)
    if ('problem' in item) { problems.push(`${where}: ${item.problem}`); continue }
    const key = exclusionKey(item)
    if (excluded.has(key)) continue
    excluded.add(key)
    if (item.kind === 'ip-block') ips += 1
    criterion({ negative: true, ...exclusionInfo(item) })
    criteria += 1
  }
  if (ips > MAX_IP_BLOCKS) problems.push(`${where}: ${ips} IP addresses excluded (Google allows ${MAX_IP_BLOCKS} per campaign)`)
  if (excluded.size) lines.push(['exclusions', '(none)', `${excluded.size} (websites, channels, apps, content labels or IP addresses)`])
  const brandSeen = new Set<string>()
  for (const b of c.brandLists ?? []) {
    if (!/^\d{1,20}$/.test(b.listId)) { problems.push(`${where}: brand list "${b.listId}" is not a list id`); continue }
    if (brandSeen.has(b.listId)) continue
    brandSeen.add(b.listId)
    criterion({ ...(b.mode === 'exclude' ? { negative: true } : {}), brandList: { sharedSet: `${customer}/sharedSets/${b.listId}` } })
    criteria += 1
  }
  if (brandSeen.size) lines.push(['brand lists', '(none)', (c.brandLists ?? []).map((b) => `${b.listId} ${b.mode === 'exclude' ? 'excluded' : 'kept to'}`).join(', ')])
  for (const id of [...new Set(c.placementLists ?? [])]) {
    if (!/^\d{1,20}$/.test(id)) { problems.push(`${where}: placement list "${id}" is not a list id`); continue }
    ops.push({ campaignSharedSetOperation: { create: { campaign: campaignRes, sharedSet: `${customer}/sharedSets/${id}` } } })
  }
  if (c.placementLists?.length) lines.push(['placement exclusion lists', '(none)', c.placementLists.join(', ')])
  const labels = labelLinks(customer, 'campaign', campaignId, c.labels ?? [], where, problems)
  ops.push(...labels)
  if (c.labels?.length) lines.push(['labels', '(none)', c.labels.join(', ')])

  const goalSeen = new Set<string>()
  for (const g of c.conversionGoals ?? []) {
    if (!(ACTION_CATEGORIES as readonly string[]).includes(g.category) || !(GOAL_ORIGINS as readonly string[]).includes(g.origin)) {
      problems.push(`${where}: conversion goal ${g.category}/${g.origin} is not a goal Google names (google-ads-live view conversions lists them)`); continue
    }
    if (goalSeen.has(`${g.category}~${g.origin}`)) { problems.push(`${where}: conversion goal ${g.category}/${g.origin} is named twice`); continue }
    goalSeen.add(`${g.category}~${g.origin}`)
    ops.push({ campaignConversionGoalOperation: { update: { resourceName: `${customer}/campaignConversionGoals/${campaignId}~${g.category}~${g.origin}`, biddable: g.biddable }, updateMask: 'biddable' } })
  }
  if (goalSeen.size) {
    lines.push(['conversion goals', 'the account\'s', (c.conversionGoals ?? []).map((g) => `${g.category}/${g.origin} ${g.biddable ? 'biddable' : 'not biddable'}`).join(', ')])
    warnings.push(`${where}: it gets conversion goals of its own — changes to the account's goals do not reach it (set-google-conversion-goals useAccountGoals puts it back).`)
  }
  if (c.customConversionGoalId) {
    if (!/^\d{1,20}$/.test(c.customConversionGoalId)) problems.push(`${where}: custom conversion goal "${c.customConversionGoalId}" is not an id`)
    else {
      ops.push({ conversionGoalCampaignConfigOperation: { update: { resourceName: `${customer}/conversionGoalCampaignConfigs/${campaignId}`, customConversionGoal: `${customer}/customConversionGoals/${c.customConversionGoalId}` }, updateMask: 'custom_conversion_goal' } })
      lines.push(['custom conversion goal', '(none)', c.customConversionGoalId])
    }
  }
  return { ops, problems, lines, warnings, criteria, labels: labels.length }
}

/** An ad group's parts beyond its own fields: device adjustments, audiences, demographics, brand lists, labels. */
function adGroupExtras(customer: string, agRes: string, g: BuildAdGroup, where: string, campaignDevice: Map<string, number>): {
  ops: GoogleMutateOperation[]; problems: string[]; criteria: number; labels: number
} {
  const ops: GoogleMutateOperation[] = []
  const problems: string[] = []
  const criterion = (body: Record<string, unknown>) => ops.push({ adGroupCriterionOperation: { create: { adGroup: agRes, ...body } } })
  let criteria = 0
  if (g.devices?.length) {
    problems.push(...deviceProblems(g.devices, where))
    for (const d of g.devices) {
      // CANNOT_BID_MODIFY_CRITERION_CAMPAIGN_OPTED_OUT (change-targeting.ts): not while the campaign opts out of the device.
      if (campaignDevice.get(d.device) === 0 && d.bidModifier !== 0) problems.push(`${where}: the campaign opts out of ${DEVICE_WORDS[d.device] ?? d.device}: Google does not use an ad group's adjustment for it`)
      ops.push({ adGroupBidModifierOperation: { create: { adGroup: agRes, device: { type: d.device }, bidModifier: d.bidModifier } } })
    }
    criteria += g.devices.length
  }
  const audiences = audienceBodies(customer, g.audiences ?? [], where, problems)
  for (const body of audiences) criterion(body)
  const demographics = demographicBodies(g.demographics ?? [], where, problems)
  for (const body of demographics) criterion(body)
  criteria += audiences.length + demographics.length
  for (const id of [...new Set(g.brandLists ?? [])]) {
    if (!/^\d{1,20}$/.test(id)) { problems.push(`${where}: brand list "${id}" is not a list id`); continue }
    criterion({ brandList: { sharedSet: `${customer}/sharedSets/${id}` } })
    criteria += 1
  }
  const labels = labelLinks(customer, 'ad-group', agRes.slice(agRes.lastIndexOf('/') + 1), g.labels ?? [], where, problems)
  ops.push(...labels)
  return { ops, problems, criteria, labels: labels.length }
}

// ── assets of a campaign or an ad group ─────────────────────────────────────────────────────────────────────────

/**
 * New assets (each linked where it is made) and the account's own assets linked again, at a new campaign or ad group.
 * Sitelinks, callouts and snippets as PR 6 checks them; every other type through G6's newAssetSpecs (the same checks as
 * add-google-assets); where each field type may be linked is G6's FIELD_LEVELS (docs/assets/overview). A link of a
 * field type Nexus does not make (a copy) is linked as it is: Google's check judges it.
 */
function assetOperations(
  customer: string,
  place: { level: 'campaign' | 'ad-group'; res: string },
  currency: string,
  assets: BuildAssets | undefined,
  temp: () => number,
): { operations: GoogleMutateOperation[]; count: number } | { refusal: string } {
  if (!assets) return { operations: [], count: 0 }
  const problems: string[] = []
  const ops: GoogleMutateOperation[] = []
  const links: GoogleMutateOperation[] = []
  const L = ASSET_LIMITS
  const linkOp = (asset: string, fieldType: string, status?: BuildLinkStatus): GoogleMutateOperation => (place.level === 'campaign'
    ? { campaignAssetOperation: { create: { campaign: place.res, asset, fieldType, ...(status === 'PAUSED' ? { status: 'PAUSED' } : {}) } } }
    : { adGroupAssetOperation: { create: { adGroup: place.res, asset, fieldType, ...(status === 'PAUSED' ? { status: 'PAUSED' } : {}) } } })
  const levelProblem = (fieldType: string, what: string) => {
    const levels = (FIELD_LEVELS as Record<string, readonly string[]>)[fieldType]
    return levels && !levels.includes(place.level) ? `${what}: Google links a ${assetWord(fieldType)} at ${levels.join(' or ')} level, not to ${place.level === 'campaign' ? 'a campaign' : 'an ad group'}` : null
  }
  const add = (fieldType: string, body: Record<string, unknown>) => {
    const res = `${customer}/assets/${temp()}`
    ops.push({ assetOperation: { create: { resourceName: res, ...body } } })
    links.push(linkOp(res, fieldType))
  }
  for (const [i, s] of (assets.sitelinks ?? []).entries()) {
    const where = `sitelink ${i + 1}`
    const d1 = s.description1?.trim() ?? ''
    const d2 = s.description2?.trim() ?? ''
    for (const p of [widthProblem(`${where} text`, s.linkText, L.linkText), d1 ? widthProblem(`${where} description 1`, d1, L.sitelinkDescription) : null, d2 ? widthProblem(`${where} description 2`, d2, L.sitelinkDescription) : null, httpsUrlProblem(where, s.finalUrl)]) if (p) problems.push(p)
    if (!!d1 !== !!d2) problems.push(`${where}: give both descriptions or neither`)
    add('SITELINK', { finalUrls: [s.finalUrl.trim()], sitelinkAsset: { linkText: s.linkText.trim(), ...(d1 && d2 ? { description1: d1, description2: d2 } : {}) } })
  }
  for (const [i, c] of (assets.callouts ?? []).entries()) {
    const p = widthProblem(`callout ${i + 1}`, c, L.callout)
    if (p) problems.push(p)
    add('CALLOUT', { calloutAsset: { calloutText: c.trim() } })
  }
  for (const [i, s] of (assets.structuredSnippets ?? []).entries()) {
    const header = snippetHeader(s.header, s.language ?? 'en')
    if ('problem' in header) { problems.push(`structured snippet ${i + 1}: ${header.problem}`); continue }
    const values = s.values.map((v) => v.trim()).filter(Boolean)
    if (values.length < L.minSnippetValues || values.length > L.maxSnippetValues) problems.push(`structured snippet ${i + 1}: ${values.length} values (Google takes ${L.minSnippetValues}–${L.maxSnippetValues})`)
    for (const v of values) { const p = widthProblem(`structured snippet ${i + 1} value "${v}"`, v, L.snippetValue); if (p) problems.push(p) }
    add('STRUCTURED_SNIPPET', { structuredSnippetAsset: { header: header.header, values } })
  }
  // Every other type Nexus makes (G6): images, business name, call, price, promotion, lead form, app link.
  const more: NewAssetsRequest = {
    images: assets.images, businessNames: assets.businessNames, calls: assets.calls, prices: assets.prices,
    promotions: assets.promotions, leadForms: assets.leadForms, mobileApps: assets.mobileApps,
  }
  if (Object.values(more).some((v) => Array.isArray(v) && v.length)) {
    const made = newAssetSpecs(customer, currency, more, assets.prepared ?? [])
    problems.push(...made.problems)
    for (const spec of made.specs) {
      if (spec.uploadOnly) { problems.push(`${assetWord(spec.fieldType)} "${spec.text}": it is for Performance Max asset groups and display ads, not a Search or Shopping ${place.level === 'campaign' ? 'campaign' : 'ad group'}`); continue }
      const p = levelProblem(spec.fieldType, `${assetWord(spec.fieldType)} "${spec.text}"`)
      if (p) { problems.push(p); continue }
      add(spec.fieldType, spec.body)
    }
  }
  const linked = new Set<string>()
  for (const l of assets.link ?? []) {
    if (!/^\d{1,20}$/.test(l.assetId)) { problems.push(`asset "${l.assetId}" is not an asset id`); continue }
    if (linked.has(`${l.assetId}~${l.fieldType}`)) continue
    linked.add(`${l.assetId}~${l.fieldType}`)
    const p = (LINK_FIELD_TYPES as readonly string[]).includes(l.fieldType) ? levelProblem(l.fieldType, `asset ${l.assetId}`) : null
    if (p) { problems.push(p); continue }
    links.push(linkOp(`${customer}/assets/${l.assetId}`, l.fieldType, l.status))
  }
  if (problems.length) return { refusal: problems.join(' · ') }
  return { operations: [...ops, ...links], count: links.length }
}
