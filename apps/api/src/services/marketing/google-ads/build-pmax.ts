/**
 * Google Ads Performance Max (programme 2, G10, 2026-10-16) — build whole Performance Max campaigns in ONE atomic request
 * (temporary ids), and a live one as such a build (a copy). Every campaign is ALWAYS made PAUSED, on a budget of its own
 * (Performance Max cannot share one: performance-max/create-budget "The budget cannot be shared"), with its bidding, its
 * Merchant Center feed (retail), targeting, brand guidelines and the brand's assets, Google's automation (final URL
 * expansion and text customization OFF unless asked), URL and brand exclusions, negative keywords, and asset groups with
 * their assets, product tree (retail) and signals.
 *
 * Checked 2026-10-16 (curl of developers.google.com/google-ads/api/performance-max/… and reference/rpc/v25/…):
 *   create-campaign     advertising_channel_type PERFORMANCE_MAX, no sub type; bidding MaximizeConversions (optional
 *                       target CPA) or MaximizeConversionValue (optional target ROAS) only — no portfolio strategy;
 *                       brand_guidelines_enabled is on by default for new campaigns and "Writable only at campaign creation";
 *                       with it on, BUSINESS_NAME (exactly one) and LOGO (one to five with LANDSCAPE_LOGO) are CampaignAssets
 *                       "included in one campaign creation request"; brand_guidelines main_color + accent_color (both or
 *                       neither, #hex) and predefined_font_family from Google's list.
 *   create-budget       not shared; DAILY. retail: shopping_setting.merchant_id required, feed_label optional,
 *                       enable_local. contains_eu_political_advertising required on every new campaign (v25).
 *   create-campaign-criteria  AD_SCHEDULE, LANGUAGE, LOCATION, BRAND (negative), KEYWORD (negative), WEBPAGE (negative =
 *                       URL exclusion). structure-requests: every operation after what it points at; asset operations
 *                       before asset group asset operations, which go together (change-pmax.ts PMAX_KIND_ORDER). Google's
 *                       retail sample creates the asset group's root listing group (UNIT_INCLUDED, listing_source
 *                       SHOPPING) in the same request (examples/shopping_ads/add_performance_max_retail_campaign.py).
 *
 * A copy (`pmaxCampaignAsBuild`) reads the live campaign (live-pmax.ts) and gives it back as a build: settings, budget
 * amount, bidding, feed, criteria, Google's automation as it is, the brand's assets and every other campaign asset (the same
 * assets linked again), asset groups with their own assets (the same assets linked again, Google's own left out), their
 * product trees and signals. What it cannot copy is named (`notCopied`).
 */
import { changeLines, keywordTextProblem, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem, widthProblem } from './change-ads.js'
import { LINK_FIELD_TYPES, MAX_IMAGE_BYTES_TOTAL } from './change-assets-all.js'
import { biddingFields, biddingText, scheduleCriteria, timeOf, type Bidding, type ScheduleSlot } from './change-campaigns.js'
import { MAX_BUILD_OPERATIONS, type BuildRecord } from './change-build.js'
import {
  AUTOMATION_KEYS, AUTOMATION_TYPES, AssetMaker, automationNow, BRAND_FIELDS, BRAND_FONTS, brandCountProblems, countsOf, describePmaxTree, groupCountProblems,
  inKindOrder, MAX_ASSET_GROUPS, ownLinks, planAssets, planSignals, pmaxBiddingNow, pmaxSnapshot, pmaxSpecOfSnapshot, pmaxTreeOfLive,
  pmaxTreeOfSpec, pmaxTreeOps, signalKeyOfTheme, SHORT_DESCRIPTION, urlExclusionKey, urlExclusionOfKey, urlExclusionsOf,
  type AssetContext, type AutomationKey, type PmaxAssetsAsk, type PmaxGroupField, type PmaxSignalsAsk, type PmaxTreeNode, type PreparedImages, type UrlExclusion,
} from './change-pmax.js'
import { keywordKey, microsOfCents, type MatchType } from './live.js'
import { livePmaxCampaign, type PmaxAsset, type PmaxAudience } from './live-pmax.js'
import type { TNode } from './product-tree.js'
import type { GoogleMutateOperation } from './write-client.js'
import type { GoogleAdsTarget } from './types.js'

export interface PmaxBuildGroup {
  name: string
  finalUrls: string[]
  finalMobileUrls?: string[]
  path1?: string
  path2?: string
  status?: 'ENABLED' | 'PAUSED'
  assets?: PmaxAssetsAsk
  /** Retail: the product tree (default: "All products" included). */
  products?: PmaxTreeNode[]
  signals?: PmaxSignalsAsk
}

export interface PmaxBuildCampaign {
  name: string
  dailyBudgetCents: number
  bidding: Bidding
  startDate?: string
  endDate?: string
  retail?: { merchantId: string; feedLabel?: string; localInventory?: boolean }
  locations?: Array<{ id: string; exclude?: boolean }>
  locationOption?: 'PRESENCE' | 'PRESENCE_OR_INTEREST'
  languages?: string[]
  schedule?: ScheduleSlot[]
  euPoliticalAds?: boolean
  /** Default true (Google's default for a new Performance Max campaign). */
  brandGuidelines?: boolean
  brandStyle?: { mainColor?: string; accentColor?: string; font?: string }
  /** With brand guidelines: the business name and logos, linked to the campaign. */
  brandAssets?: PmaxAssetsAsk
  /** Existing assets linked to the campaign as they are (sitelinks, callouts, …; a copy links the source's again). */
  campaignAssets?: Array<{ assetId: string; fieldType: string; status?: 'ENABLED' | 'PAUSED' }>
  automation?: Partial<Record<AutomationKey, boolean>>
  urlExclusions?: UrlExclusion[]
  brandExclusions?: string[]
  negativeKeywords?: Array<{ text: string; matchType: MatchType }>
  trackingTemplate?: string
  finalUrlSuffix?: string
  assetGroups: PmaxBuildGroup[]
}

export interface PmaxBuildLive {
  campaignNames: string[]
  assets: PmaxAsset[]
  audiences: PmaxAudience[]
  brandLists: Array<{ listId: string; name: string | null }>
  images: PreparedImages
  /** Assets a copy links again as the source holds them (not judged again: Google took them there). */
  trusted?: string[]
}

const HEX = /^#[0-9A-Fa-f]{6}$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
const CAMPAIGN_FIELD_TYPES: readonly string[] = [...LINK_FIELD_TYPES]

/** The scope of an image of a build (asset-images are fetched first, by slot). */
export const buildImageScope = (campaign: number, group: number | 'brand') => `c${campaign}:${group === 'brand' ? 'brand' : `g${group}`}`

export function pmaxBuildDraft(customer: string, currency: string, campaigns: PmaxBuildCampaign[], live: PmaxBuildLive, notCopied: string[] = []): GoogleChangeDraft | { refusal: string } {
  if (!campaigns.length) return { refusal: 'The build holds no campaign.' }
  const problems: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  let next = -1
  const temp = () => next--
  const ops: GoogleMutateOperation[] = []
  const tags: Array<{ op: GoogleMutateOperation; tag: string }> = []
  const lines: Array<[string, unknown, unknown]> = []
  const maker = new AssetMaker(customer, temp)
  const ctx: AssetContext = { customer, maker, assets: new Map(live.assets.map((a) => [a.assetId, a])), images: live.images, problems, warnings, skipped, trusted: new Set(live.trusted ?? []) }
  const audienceCtx = { customer, temp, problems, skipped, audiences: live.audiences, takenAudienceNames: new Set(live.audiences.map((a) => (a.name ?? '').trim().toLowerCase())) }
  const taken = new Set(live.campaignNames.map((n) => n.trim().toLowerCase()))
  let daily = 0
  const totals = { campaigns: 0, assetGroups: 0, groupAssets: 0, productGroups: 0, signals: 0 }

  campaigns.forEach((c, ci) => {
    const where = `campaign ${ci + 1} "${c.name.trim()}"`
    const name = c.name.trim()
    if (!name || name.length > 255) problems.push(`${where}: the name is 1 to 255 characters`)
    if (taken.has(name.toLowerCase())) problems.push(`${where}: a campaign with this name already exists (Google refuses a second one)`)
    taken.add(name.toLowerCase())
    if (!Number.isInteger(c.dailyBudgetCents) || c.dailyBudgetCents < 1) problems.push(`${where}: the daily budget is whole cents of at least 1`)
    if (c.bidding.strategy !== 'MAXIMIZE_CONVERSIONS' && c.bidding.strategy !== 'MAXIMIZE_CONVERSION_VALUE') {
      problems.push(`${where}: Performance Max bids with MAXIMIZE_CONVERSIONS (optional target CPA) or MAXIMIZE_CONVERSION_VALUE (optional target ROAS) only`)
      return
    }
    for (const d of [c.startDate, c.endDate]) if (d !== undefined && !DAY.test(d)) problems.push(`${where}: "${d}" is not a day (YYYY-MM-DD)`)
    if (c.startDate && c.endDate && c.endDate < c.startDate) problems.push(`${where}: the end is before the start`)
    if (c.retail?.feedLabel && !/^[A-Z0-9_-]{1,20}$/.test(c.retail.feedLabel)) problems.push(`${where}: the feed label "${c.retail.feedLabel}" is not one Google takes (up to 20 of A–Z, 0–9, - and _)`)
    const brandGuidelines = c.brandGuidelines !== false
    const style = c.brandStyle
    if (style && (!!style.mainColor !== !!style.accentColor)) problems.push(`${where}: give the main and the accent color together (Google's rule)`)
    for (const col of [style?.mainColor, style?.accentColor]) if (col && !HEX.test(col)) problems.push(`${where}: "${col}" is not a color as #rrggbb`)
    if (style?.font && !(BRAND_FONTS as readonly string[]).includes(style.font)) problems.push(`${where}: "${style.font}" is not a font Google takes (${BRAND_FONTS.join(', ')})`)
    if (style && !brandGuidelines) problems.push(`${where}: colors and a font are brand guidelines: they need brandGuidelines on`)
    if (c.brandAssets && !brandGuidelines) problems.push(`${where}: with brand guidelines off the business name and logos go in each asset group (assetGroups[].assets), not on the campaign`)
    const auto: Record<AutomationKey, boolean | undefined> = { finalUrlExpansion: false, textCustomization: false, imageEnhancement: undefined, videoEnhancement: undefined, ...c.automation }
    if (auto.finalUrlExpansion && auto.textCustomization === false) problems.push(`${where}: Google turns text customization on with final URL expansion: ask for both, or neither`)

    // Budget and campaign.
    const budgetRes = `${customer}/campaignBudgets/${temp()}`
    const campaignRes = `${customer}/campaigns/${temp()}`
    const budgetOp = { campaignBudgetOperation: { create: { resourceName: budgetRes, amountMicros: microsOfCents(c.dailyBudgetCents), explicitlyShared: false, deliveryMethod: 'STANDARD' } } }
    ops.push(budgetOp); tags.push({ op: budgetOp, tag: `own:${name}` })
    daily += c.dailyBudgetCents
    const automation = AUTOMATION_KEYS.filter((k) => auto[k] !== undefined).map((k) => ({ assetAutomationType: AUTOMATION_TYPES[k], assetAutomationStatus: auto[k] ? 'OPTED_IN' : 'OPTED_OUT' }))
    const campaign: Record<string, unknown> = {
      resourceName: campaignRes,
      name,
      // Never ENABLED by Nexus: Google's default is ENABLED, so it is said every time.
      status: 'PAUSED',
      advertisingChannelType: 'PERFORMANCE_MAX',
      campaignBudget: budgetRes,
      ...biddingFields(customer, c.bidding),
      containsEuPoliticalAdvertising: c.euPoliticalAds ? 'CONTAINS_EU_POLITICAL_ADVERTISING' : 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
      brandGuidelinesEnabled: brandGuidelines,
      ...(style?.mainColor || style?.font ? { brandGuidelines: { ...(style.mainColor ? { mainColor: style.mainColor, accentColor: style.accentColor } : {}), ...(style.font ? { predefinedFontFamily: style.font } : {}) } } : {}),
      geoTargetTypeSetting: { positiveGeoTargetType: c.locationOption ?? 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
      ...(c.retail ? { shoppingSetting: { merchantId: c.retail.merchantId, ...(c.retail.feedLabel ? { feedLabel: c.retail.feedLabel } : {}), enableLocal: c.retail.localInventory === true } } : {}),
      ...(automation.length ? { assetAutomationSettings: automation } : {}),
      ...(c.startDate ? { startDateTime: `${c.startDate} 00:00:00` } : {}),
      ...(c.endDate ? { endDateTime: `${c.endDate} 23:59:59` } : {}),
      ...(c.trackingTemplate ? { trackingUrlTemplate: c.trackingTemplate } : {}),
      ...(c.finalUrlSuffix ? { finalUrlSuffix: c.finalUrlSuffix } : {}),
    }
    const campaignOp = { campaignOperation: { create: campaign } }
    ops.push(campaignOp); tags.push({ op: campaignOp, tag: `campaign:${name}` })
    totals.campaigns += 1
    lines.push([`new campaign ${ci + 1}`, '(none)', `"${name}" · Performance Max${c.retail ? ' (retail)' : ''} · PAUSED`])
    lines.push([`campaign ${ci + 1} budget`, '(none)', `its own ${money(c.dailyBudgetCents, currency)} a day`])
    lines.push([`campaign ${ci + 1} bidding`, '(none)', biddingText(c.bidding, currency)])
    if (c.retail) lines.push([`campaign ${ci + 1} feed`, '(none)', `Merchant Center ${c.retail.merchantId}${c.retail.feedLabel ? `, feed label ${c.retail.feedLabel}` : ''}${c.retail.localInventory ? ', local products' : ''}`])
    lines.push([`campaign ${ci + 1} Google on its own`, '(none)', AUTOMATION_KEYS.filter((k) => auto[k] !== undefined).map((k) => `${k} ${auto[k] ? 'on' : 'off'}`).join(', ') || "Google's defaults"])
    if (auto.finalUrlExpansion) warnings.push(`${where}: final URL expansion is on — once enabled, Google may send people to other pages of the site.`)
    if (auto.textCustomization) warnings.push(`${where}: text customization is on — Google writes text from the site and the assets on its own.`)

    // Criteria.
    const criterion = (body: Record<string, unknown>) => ops.push({ campaignCriterionOperation: { create: { campaign: campaignRes, ...body } } })
    for (const l of c.locations ?? []) criterion({ ...(l.exclude ? { negative: true } : {}), location: { geoTargetConstant: `geoTargetConstants/${l.id}` } })
    for (const id of c.languages ?? []) criterion({ language: { languageConstant: `languageConstants/${id}` } })
    const schedule = c.schedule?.length ? scheduleCriteria(c.schedule) : []
    if ('refusal' in schedule) problems.push(`${where}: ${schedule.refusal}`)
    else for (const s of schedule) criterion({ ...s })
    if (!(c.locations ?? []).some((l) => !l.exclude)) warnings.push(`${where} targets no location: once enabled it can show in every country.`)
    lines.push([`campaign ${ci + 1} targeting`, '(none)', `${(c.locations ?? []).filter((l) => !l.exclude).length} locations, ${(c.locations ?? []).filter((l) => l.exclude).length} excluded, ${(c.languages ?? []).length || 'all'} languages, ${'refusal' in schedule ? 0 : schedule.length || 'no'} schedule slots`])
    for (const key of [...new Set((c.urlExclusions ?? []).map(urlExclusionKey))].sort()) {
      const u = urlExclusionOfKey(key)
      const arg = (u.contains ?? u.equals ?? '').trim()
      if (!arg) { problems.push(`${where}: a URL exclusion is empty`); continue }
      criterion({ negative: true, webpage: { criterionName: `Exclude ${key}`.slice(0, 255), conditions: [{ operand: 'URL', operator: u.equals !== undefined ? 'EQUALS' : 'CONTAINS', argument: arg }] } })
    }
    for (const id of [...new Set(c.brandExclusions ?? [])]) {
      if (!live.brandLists.some((l) => l.listId === id)) { problems.push(`${where}: brand list ${id} is not a brand list of this account`); continue }
      criterion({ negative: true, brandList: { sharedSet: `${customer}/sharedSets/${id}` } })
    }
    const negSeen = new Set<string>()
    for (const n of c.negativeKeywords ?? []) {
      const p = keywordTextProblem(n.text)
      if (p) { problems.push(`${where}: negative "${n.text}" ${p}`); continue }
      if (negSeen.has(keywordKey(n.text, n.matchType))) continue
      negSeen.add(keywordKey(n.text, n.matchType))
      criterion({ negative: true, keyword: { text: n.text.trim(), matchType: n.matchType } })
    }
    if ((c.urlExclusions ?? []).length || (c.brandExclusions ?? []).length || negSeen.size) {
      lines.push([`campaign ${ci + 1} exclusions`, '(none)', `${(c.urlExclusions ?? []).length} URLs, ${(c.brandExclusions ?? []).length} brand lists, ${negSeen.size} negative keywords`])
    }

    // The brand's assets and the other campaign assets.
    const brand = brandGuidelines ? planAssets(ctx, `${where} brand assets`, c.brandAssets, buildImageScope(ci, 'brand'), [], (f) => (BRAND_FIELDS.includes(f) ? null : 'only the business name, logos and landscape logos go on the campaign')) : []
    for (const b of brand) ops.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: b.assetRes, fieldType: b.fieldType } } })
    const brandFields: Array<{ fieldType: string }> = brand.map((b) => ({ fieldType: b.fieldType }))
    const seenLinks = new Set<string>()
    for (const a of c.campaignAssets ?? []) {
      if (!/^\d{1,20}$/.test(a.assetId) || !CAMPAIGN_FIELD_TYPES.includes(a.fieldType)) { problems.push(`${where}: campaign asset ${a.assetId} as ${a.fieldType} is not an asset link Nexus makes`); continue }
      if (BRAND_FIELDS.includes(a.fieldType) && !brandGuidelines) { problems.push(`${where}: ${a.fieldType} goes in the asset groups with brand guidelines off`); continue }
      if (seenLinks.has(`${a.assetId}~${a.fieldType}`)) continue
      seenLinks.add(`${a.assetId}~${a.fieldType}`)
      ops.push({ campaignAssetOperation: { create: { campaign: campaignRes, asset: `${customer}/assets/${a.assetId}`, fieldType: a.fieldType, ...(a.status === 'PAUSED' ? { status: 'PAUSED' } : {}) } } })
      if (BRAND_FIELDS.includes(a.fieldType)) brandFields.push({ fieldType: a.fieldType })
    }
    if (brand.length || (c.campaignAssets ?? []).length) lines.push([`campaign ${ci + 1} campaign assets`, '(none)', `${brandFields.length} brand (${brand.map((b) => b.label).join(', ') || 'existing'}), ${(c.campaignAssets ?? []).length - (brandFields.length - brand.length)} other`])

    // Asset groups.
    if (!c.assetGroups.length) warnings.push(`${where} has no asset group: it cannot serve until one is added (set-google-pmax).`)
    if (c.assetGroups.length > MAX_ASSET_GROUPS) problems.push(`${where}: ${c.assetGroups.length} asset groups (Google allows ${MAX_ASSET_GROUPS})`)
    const groupNames = new Set<string>()
    let groupsWithAssets = 0
    c.assetGroups.forEach((g, gi) => {
      const gWhere = `${where}, asset group "${g.name.trim()}"`
      const gName = g.name.trim()
      if (!gName || gName.length > 128) problems.push(`${gWhere}: the name is 1 to 128 characters`)
      if (groupNames.has(gName.toLowerCase())) problems.push(`${gWhere}: two asset groups of the campaign have this name`)
      groupNames.add(gName.toLowerCase())
      if (!g.finalUrls.length) problems.push(`${gWhere}: an asset group needs at least one final URL`)
      g.finalUrls.forEach((u, i) => { const p = httpsUrlProblem(`${gWhere}, final URL ${i + 1}`, u); if (p) problems.push(p) })
      ;(g.finalMobileUrls ?? []).forEach((u, i) => { const p = httpsUrlProblem(`${gWhere}, mobile final URL ${i + 1}`, u); if (p) problems.push(p) })
      for (const [k, v] of [['path 1', g.path1], ['path 2', g.path2]] as const) if (v?.trim()) { const p = widthProblem(`${gWhere}, ${k}`, v, 15); if (p) problems.push(p) }
      if (g.path2?.trim() && !g.path1?.trim()) problems.push(`${gWhere}: path 2 needs path 1 (Google's rule)`)
      const groupRes = `${customer}/assetGroups/${temp()}`
      ops.push({ assetGroupOperation: { create: {
        resourceName: groupRes, campaign: campaignRes, name: gName, finalUrls: g.finalUrls.map((u) => u.trim()),
        ...(g.finalMobileUrls?.length ? { finalMobileUrls: g.finalMobileUrls.map((u) => u.trim()) } : {}),
        ...(g.path1?.trim() ? { path1: g.path1.trim() } : {}), ...(g.path2?.trim() ? { path2: g.path2.trim() } : {}),
        status: g.status ?? 'ENABLED',
      } } })
      totals.assetGroups += 1
      const brandInGroup = !brandGuidelines
      const planned = planAssets(ctx, gWhere, g.assets, buildImageScope(ci, gi), [], (f) => (BRAND_FIELDS.includes(f) && !brandInGroup
        ? `${f === 'BUSINESS_NAME' ? 'the business name' : 'a logo'} is linked to the campaign with brand guidelines on (brandAssets), not to an asset group`
        : null))
      for (const p of planned) ops.push({ assetGroupAssetOperation: { create: { assetGroup: groupRes, asset: p.assetRes, fieldType: p.fieldType } } })
      totals.groupAssets += planned.length
      if (planned.length) groupsWithAssets += 1
      const descriptions = planned.filter((p) => p.fieldType === 'DESCRIPTION').map((p) => p.label)
      problems.push(...groupCountProblems(gWhere, {
        before: null, after: countsOf(planned), retail: !!c.retail, brandInGroup, shortBefore: false,
        shortAfter: descriptions.some((d) => d.length <= SHORT_DESCRIPTION),
      }))
      if (c.retail && !planned.length) warnings.push(`${gWhere} holds no asset: Google makes its ads from the Merchant Center feed (more assets reach more places).`)
      let treeWords = ''
      if (g.products?.length && !c.retail) problems.push(`${gWhere}: a product tree is for a retail campaign (give retail.merchantId)`)
      else if (c.retail) {
        const tree = g.products?.length ? pmaxTreeOfSpec(g.products, `${gWhere} products`) : { root: { dim: null, value: null, kind: 'UNIT' as const, split: null, excluded: false, bidCents: null, children: [] } as TNode }
        if ('refusal' in tree) problems.push(tree.refusal)
        else {
          const made = pmaxTreeOps(customer, groupRes, null, tree.root, temp)
          ops.push(...made.creates)
          totals.productGroups += made.creates.length
          treeWords = `, products: ${describePmaxTree(tree.root)}`
        }
      }
      const signals = planSignals(audienceCtx, gWhere, groupRes, null, g.signals, [])
      ops.push(...signals.audienceOps, ...signals.ops)
      totals.signals += signals.ops.length
      lines.push([`campaign ${ci + 1} asset group "${gName}"`, '(none)', `${g.status ?? 'ENABLED'}, ${plural(planned.length, 'asset')}${treeWords}${signals.lines.length ? `, signals: ${signals.lines.slice(0, 4).join(', ')}` : ''}`])
    })
    if (brandGuidelines && (!c.retail || groupsWithAssets > 0)) problems.push(...brandCountProblems(`${where} (brand guidelines on)`, countsOf(brandFields), null))
  })

  if (maker.bytes > MAX_IMAGE_BYTES_TOTAL) problems.push(`the images are ${(maker.bytes / 1024 / 1024).toFixed(1)} MB together: one request carries at most ${MAX_IMAGE_BYTES_TOTAL / 1024 / 1024} MB of images (build in two)`)
  if (problems.length) return { refusal: `The build cannot be sent as it is (${plural(problems.length, 'problem')}): ${problems.slice(0, 25).join(' · ')}${problems.length > 25 ? ` · … ${problems.length - 25} more` : ''}` }
  const ordered = inKindOrder([...maker.ops, ...ops])
  if (ordered.length > MAX_BUILD_OPERATIONS) {
    return { refusal: `The build holds ${ordered.length} operations, more than the ${MAX_BUILD_OPERATIONS} one build sends (its check and its run must fit the account's daily Google Ads allowance). Build fewer campaigns at once.` }
  }
  const at = (tag: string) => { const t = tags.find((x) => x.tag === tag); return t ? ordered.indexOf(t.op) : -1 }
  const record: BuildRecord = {
    campaigns: campaigns.map((c) => ({ name: c.name.trim(), campaignId: null, op: at(`campaign:${c.name.trim()}`), ownBudgetOp: at(`own:${c.name.trim()}`), ownBudgetId: null })),
    sharedBudgets: [],
    negativeLists: [],
  }
  if (notCopied.length) warnings.push(`Not copied (${notCopied.length}): ${notCopied.slice(0, 12).join('; ')}${notCopied.length > 12 ? ' …' : ''}.`)
  warnings.unshift(`Every campaign is made PAUSED: nothing spends until a person enables one (set-google-status, SPENDS MONEY). Once enabled, their daily budgets add up to ${money(daily, currency)}.`)
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads Performance Max build: ${plural(totals.campaigns, 'campaign')} (PAUSED), ${plural(totals.assetGroups, 'asset group')}, ${plural(maker.made.length, 'new asset')} — in one request.`,
    changes,
    totals: { operations: ordered.length, ...totals, newAssets: maker.made.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped,
    operations: ordered,
    stands: {
      // The names the build takes must still be free, and what it points at still there.
      names: campaigns.map((c) => c.name.trim().toLowerCase()).sort(),
      assets: live.assets.map((a) => `${a.assetId}:${a.type}`).sort(),
      audiences: live.audiences.map((a) => `${a.audienceId}:${a.scope}`).sort(),
      brandLists: live.brandLists.map((l) => l.listId).sort(),
    },
    before: null,
    after: record,
  }
}

// ── a live Performance Max campaign as a build (a copy) ────────────────────────────────────────────────────────

export interface PmaxCopyOverrides { name: string; dailyBudgetCents?: number; startDate?: string; endDate?: string }

const byNumber = (a: string, b: string) => { const x = a.split('~').map(Number); const y = b.split('~').map(Number); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0); return 0 }
const MINUTES: Record<string, string> = { ZERO: '00', FIFTEEN: '15', THIRTY: '30', FORTY_FIVE: '45' }

/** One live Performance Max campaign as a build campaign under a new name, with the assets it links; or why not. */
export async function pmaxCampaignAsBuild(
  target: GoogleAdsTarget,
  campaignId: string,
  overrides: PmaxCopyOverrides,
  audiences: PmaxAudience[] = [],
): Promise<{ campaign: PmaxBuildCampaign; assets: PmaxAsset[]; notCopied: string[] } | { refusal: string }> {
  const c = await livePmaxCampaign(target, campaignId)
  if (!c) return { refusal: `Campaign ${campaignId} is not in this account (or it is removed).` }
  if (c.type !== 'PERFORMANCE_MAX') return { refusal: `"${c.name}" is a ${c.type ?? 'campaign'} campaign: copy-google-pmax copies Performance Max campaigns (copy-google-campaign copies Search and Standard Shopping).` }
  if (c.notRead.length) return { refusal: `Parts of "${c.name}" could not be read (${c.notRead.map((n) => n.part).join(', ')}): a copy would miss them.` }
  const bidding = pmaxBiddingNow(c)
  if (!bidding) return { refusal: `"${c.name}" bids with ${c.biddingType ?? 'a strategy'} Nexus does not copy.` }
  const budget = overrides.dailyBudgetCents ?? c.budget?.amountCents ?? 0
  if (!(budget > 0)) return { refusal: `"${c.name}" has no budget amount Nexus can read: give the copy dailyBudgetCents.` }
  const notCopied: string[] = ['the campaign\'s conversion goals (the copy uses the account\'s goals)', 'customer acquisition (set-google-customer-acquisition)']
  const assets = new Map<string, PmaxAsset>()
  const keep = (a: PmaxAsset) => assets.set(a.assetId, a)
  const today = new Date().toISOString().slice(0, 10)
  const day = (d: string | null) => (d ? d.slice(0, 10) : null)
  const start = day(c.start)
  const end = day(c.end) && !day(c.end)!.startsWith('2037-12-30') ? day(c.end) : null
  if (end && end < today && !overrides.endDate) notCopied.push(`the end date ${end} (in the past)`)
  if (c.locationOption === 'SEARCH_INTEREST') notCopied.push('location option "search interest" (the copy uses presence or interest)')

  const sortedCriteria = [...c.criteria].sort((x, y) => byNumber(x.criterionId, y.criterionId))
  const locations: NonNullable<PmaxBuildCampaign['locations']> = []
  const languages: string[] = []
  const schedule: ScheduleSlot[] = []
  const brandExclusions: string[] = []
  const negativeKeywords: NonNullable<PmaxBuildCampaign['negativeKeywords']> = []
  const urlExclusionKeys = new Set(urlExclusionsOf(c).map((u) => u.key))
  for (const k of sortedCriteria) {
    if (k.type === 'LOCATION' && k.location) { locations.push({ id: k.location, ...(k.negative ? { exclude: true } : {}) }); if (k.bidModifier !== null && k.bidModifier !== 1) notCopied.push(`the bid adjustment of location ${k.location}`); continue }
    if (k.type === 'LANGUAGE' && k.language) { languages.push(k.language); continue }
    if (k.type === 'AD_SCHEDULE' && k.schedule) {
      const from = `${String(k.schedule.startHour).padStart(2, '0')}:${MINUTES[k.schedule.startMinute ?? 'ZERO'] ?? '00'}`
      const to = `${String(k.schedule.endHour).padStart(2, '0')}:${MINUTES[k.schedule.endMinute ?? 'ZERO'] ?? '00'}`
      if (timeOf(from, false) && timeOf(to, true)) schedule.push({ days: [k.schedule.day ?? ''], from, to, ...(k.bidModifier !== null && k.bidModifier !== 1 ? { bidModifier: k.bidModifier } : {}) })
      else notCopied.push(`schedule slot ${k.criterionId}`)
      continue
    }
    if (k.type === 'BRAND_LIST' && k.brandListId && k.negative) { brandExclusions.push(k.brandListId); continue }
    if (k.type === 'KEYWORD' && k.keyword && k.negative) { negativeKeywords.push({ text: k.keyword.text, matchType: (k.keyword.matchType ?? 'BROAD') as MatchType }); continue }
    if (k.type === 'WEBPAGE' && k.negative && k.webpage?.conditions.length === 1 && k.webpage.conditions[0].operand === 'URL') continue
    notCopied.push(`campaign criterion ${k.criterionId} (${k.type ?? 'criterion'}${k.negative ? ', excluded' : ''})`)
  }

  const campaignAssets: NonNullable<PmaxBuildCampaign['campaignAssets']> = []
  for (const l of ownLinks(c.campaignAssets).sort((x, y) => byNumber(x.assetId, y.assetId) || x.fieldType.localeCompare(y.fieldType))) {
    if (!CAMPAIGN_FIELD_TYPES.includes(l.fieldType)) { notCopied.push(`campaign asset ${l.assetId} (${l.fieldType})`); continue }
    campaignAssets.push({ assetId: l.assetId, fieldType: l.fieldType, ...(l.status === 'PAUSED' ? { status: 'PAUSED' as const } : {}) })
    keep(l)
  }

  // Every switch Nexus changes as the source has it — one Google left out of its answer is at its Performance Max
  // default, on (automationNow). GENERATE_IMAGE_EXTRACTION follows the account ("can only be configured in the Google
  // Ads web interface", docs/assets/asset-automation-settings): nothing to copy. Automated video crawl needs settings Nexus
  // does not read.
  const automation: Partial<Record<AutomationKey, boolean>> = Object.fromEntries(AUTOMATION_KEYS.map((k) => [k, automationNow(c, k) === 'OPTED_IN']))
  if (c.automation.AUTOMATED_VIDEO_CRAWL === 'OPTED_IN') notCopied.push('automated video crawl (its settings are not read)')

  const assetGroups: PmaxBuildGroup[] = []
  for (const g of [...c.assetGroups].sort((x, y) => byNumber(x.assetGroupId, y.assetGroupId))) {
    const link: NonNullable<PmaxAssetsAsk['link']> = []
    for (const l of ownLinks(g.assets).sort((x, y) => byNumber(x.assetId, y.assetId) || x.fieldType.localeCompare(y.fieldType))) {
      if (!(['HEADLINE', 'LONG_HEADLINE', 'DESCRIPTION', 'BUSINESS_NAME', 'MARKETING_IMAGE', 'SQUARE_MARKETING_IMAGE', 'PORTRAIT_MARKETING_IMAGE', 'LOGO', 'LANDSCAPE_LOGO', 'YOUTUBE_VIDEO', 'CALL_TO_ACTION_SELECTION'] as string[]).includes(l.fieldType)) {
        notCopied.push(`asset ${l.assetId} (${l.fieldType}) of asset group "${g.name}"`)
        continue
      }
      if (c.brandGuidelines && BRAND_FIELDS.includes(l.fieldType)) { notCopied.push(`the ${l.fieldType} asset ${l.assetId} of asset group "${g.name}" (with brand guidelines on the brand's assets are the campaign's)`); continue }
      if (l.status === 'PAUSED') notCopied.push(`the paused state of asset ${l.assetId} in "${g.name}" (linked enabled)`)
      link.push({ assetId: l.assetId, fieldType: l.fieldType as PmaxGroupField })
      keep(l)
    }
    let products: PmaxTreeNode[] | undefined
    if (c.retail) {
      const tree = pmaxTreeOfLive(g.tree)
      if ('refusal' in tree) return { refusal: `Asset group "${g.name}": ${tree.refusal}.` }
      const snap = pmaxSnapshot(tree.root)
      if (snap) {
        const spec = pmaxSpecOfSnapshot(snap)
        if ('refusal' in spec) return { refusal: `Asset group "${g.name}": ${spec.refusal}.` }
        products = spec
      } else notCopied.push(`asset group "${g.name}" has no product tree (the copy gets "All products")`)
    }
    const groupAudiences: string[] = []
    const searchThemes: string[] = []
    const seenThemes = new Set<string>()
    for (const s of [...g.signals].sort((x, y) => byNumber(x.signalId, y.signalId))) {
      const scoped = s.audienceId ? audiences.find((a) => a.audienceId === s.audienceId) : undefined
      if (s.audienceId && scoped?.scope === 'ASSET_GROUP') notCopied.push(`audience ${scoped.name ?? s.audienceId} of "${g.name}" (it belongs to that asset group alone)`)
      else if (s.audienceId) groupAudiences.push(s.audienceId)
      else if (s.searchTheme && !seenThemes.has(signalKeyOfTheme(s.searchTheme))) { seenThemes.add(signalKeyOfTheme(s.searchTheme)); searchThemes.push(s.searchTheme) }
      else if (!s.searchTheme) notCopied.push(`signal ${s.signalId} of "${g.name}"`)
    }
    assetGroups.push({
      name: g.name,
      finalUrls: g.finalUrls,
      ...(g.finalMobileUrls.length ? { finalMobileUrls: g.finalMobileUrls } : {}),
      ...(g.path1 ? { path1: g.path1 } : {}),
      ...(g.path2 ? { path2: g.path2 } : {}),
      status: g.status === 'PAUSED' ? 'PAUSED' : 'ENABLED',
      ...(link.length ? { assets: { link } } : {}),
      ...(products ? { products } : {}),
      ...(groupAudiences.length || searchThemes.length ? { signals: { ...(groupAudiences.length ? { audiences: groupAudiences } : {}), ...(searchThemes.length ? { searchThemes } : {}) } } : {}),
    })
  }

  const campaign: PmaxBuildCampaign = {
    name: overrides.name,
    dailyBudgetCents: budget,
    bidding,
    ...(overrides.startDate ? { startDate: overrides.startDate } : start && start > today ? { startDate: start } : {}),
    ...(overrides.endDate ? { endDate: overrides.endDate } : end && end >= today ? { endDate: end } : {}),
    ...(c.retail ? { retail: { merchantId: c.retail.merchantId, ...(c.retail.feedLabel ? { feedLabel: c.retail.feedLabel } : {}), localInventory: c.retail.localInventory } } : {}),
    locations,
    locationOption: c.locationOption === 'PRESENCE_OR_INTEREST' ? 'PRESENCE_OR_INTEREST' : 'PRESENCE',
    languages,
    schedule,
    euPoliticalAds: c.euPoliticalAds === 'CONTAINS_EU_POLITICAL_ADVERTISING',
    brandGuidelines: c.brandGuidelines,
    ...(c.brandGuidelines && c.brandStyle && (c.brandStyle.mainColor || c.brandStyle.font)
      ? { brandStyle: { ...(c.brandStyle.mainColor ? { mainColor: c.brandStyle.mainColor, accentColor: c.brandStyle.accentColor ?? undefined } : {}), ...(c.brandStyle.font ? { font: c.brandStyle.font } : {}) } }
      : {}),
    campaignAssets,
    automation,
    urlExclusions: [...urlExclusionKeys].sort().map(urlExclusionOfKey),
    brandExclusions,
    negativeKeywords,
    ...(c.trackingTemplate ? { trackingTemplate: c.trackingTemplate } : {}),
    ...(c.finalUrlSuffix ? { finalUrlSuffix: c.finalUrlSuffix } : {}),
    assetGroups,
  }
  return { campaign, assets: [...assets.values()], notCopied }
}
