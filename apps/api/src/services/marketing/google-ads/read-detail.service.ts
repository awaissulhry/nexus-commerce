/**
 * Google Ads step 1b — the reads below the campaign (PLAN-1B.md "API contract"): R5 ad groups, R6 keywords, R7 negative
 * keywords, R10 asset groups, R11 advertised products and R15 disapprovals. Read only: every answer comes from the
 * GoogleAds* tables the daily read fills; nothing here calls Google.
 *
 * The rules each answer keeps (as step 1a's read.service.ts):
 *   - numbers count only the days Nexus read AT THAT GRAIN (GoogleAdsReadState.readFrom…readThrough of AD_GROUP_DAYS,
 *     KEYWORD_DAYS, …). A read day with no row is a zero day; with no day of the window read, `metrics` is null
 *   - money in minor units of the account's currency, never converted; ratios Nexus's, null over a zero
 *   - an ad group, asset group or keyword seen only in the numbers (removed before Nexus first read its settings) is
 *     still listed, so the rows add up to the grain's totals; its settings are "not read" (status null)
 *   - `read.readAt` null = the structure was never read ("Not read yet"), never "none"
 *   - a campaign or ad group outside the business is "not found" (404)
 */
import prisma from '../../../db.js'
import type { CursorPosition } from '../../../lib/pagination/cursor.js'
import { ACCOUNT_LEVEL_LIST_TYPE } from './mappers.js'
import {
  CAMPAIGN_STATUSES,
  GoogleAdsReadError,
  campaignRefOf,
  detailScope,
  entityStatus,
  googleAdsScope,
  googleCampaignDirectory,
  googleReadStates,
  grainFrame,
  iso,
  keysetPage,
  labelsByEntity,
  metricsOrNull,
  microsToMinor,
  needleOf,
  oneOf,
  sumsByEntity,
  textKey,
  type GoogleAdsScope,
  type GoogleAdsMetrics,
  type GrainFrame,
  type WindowInput,
} from './read.service.js'
import type {
  Flag,
  GoogleAdGroup,
  GoogleAdGroupsPage,
  GoogleAdIssue,
  GoogleAdIssueStatus,
  GoogleAssetGroup,
  GoogleAssetGroupsPage,
  GoogleDisapprovals,
  GoogleKeyword,
  GoogleKeywordsPage,
  GoogleMatchType,
  GoogleNegative,
  GoogleNegativeList,
  GoogleNegativesPage,
  GoogleProduct,
  GoogleProductIssue,
  GoogleProductIssueText,
  GoogleProductStatus,
  GoogleProductsPage,
} from './read-types.js'

/** What every list read takes; the routes and the MCP tool pass the same. */
export interface GoogleDetailInput extends WindowInput {
  connectionId?: string | null
  /** Nexus's campaign id, or the step-1a `<customerId>~<googleCampaignId>` id. */
  campaignId?: string | null
  limit?: number | string | null
  cursor?: string | null
}

const MATCH_TYPES = ['EXACT', 'PHRASE', 'BROAD'] as const
const matchTypeOf = (value: string | null | undefined): GoogleMatchType | null =>
  value && (MATCH_TYPES as readonly string[]).includes(value) ? value as GoogleMatchType : null

const minorOrNull = (micros: bigint | null | undefined, exponent: number): number | null => (micros == null ? null : microsToMinor(micros, exponent))
const numberOrNull = (value: unknown): number | null => {
  if (value == null) return null
  const n = Number(String(value))
  return Number.isFinite(n) ? n : null
}

/** The account row (or what the chosen account says of itself when Nexus never read it). */
function customerOfScope(scope: GoogleAdsScope, customerId: string) {
  const customer = scope.context.customer
  return { customerId, structureSyncedAt: customer?.structureSyncedAt ?? null, timeZone: scope.context.timeZone }
}

/** The fields every list with a window carries. */
function listBase(scope: GoogleAdsScope, frame: GrainFrame) {
  return { window: frame.window, currency: scope.context.currency, dataAsOf: iso(scope.context.customer?.lastSuccessAt), coverage: frame.coverage }
}

/** A spend sort value (high first, so negated); no day read sorts as zero. */
const spendKey = (metrics: GoogleAdsMetrics | null): number => -(metrics?.spendCents ?? 0)

/** The id of an ad group, asset group or keyword seen only in the numbers (no settings row). */
const unseenKey = (customerId: string, ...googleIds: string[]) => [customerId, ...googleIds].join('~')

// ── R5 — ad groups ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Whether Google may match this ad group to searches beyond its keywords (AI Max's search term matching). Only a Search
 * campaign with AI Max on has it; null when Nexus has not read the campaign's AI Max setting or the ad group's.
 */
export function searchTermMatchingFlag(
  campaignType: string,
  campaign: { flagsReadAt: Date | null; aiMaxEnabled: boolean | null } | undefined,
  disabled: boolean | null,
): Flag {
  if (campaignType === 'UNKNOWN') return null
  if (campaignType !== 'SEARCH') return 'not_applicable'
  if (!campaign?.flagsReadAt) return null
  if (campaign.aiMaxEnabled !== true) return 'not_applicable'
  if (disabled == null) return null
  return disabled ? 'off' : 'on'
}

/** R5 — one page of ad groups (by name) with their numbers over the window. */
export async function googleAdsAdGroups(
  input: GoogleDetailInput & { status?: string | null; search?: string | null },
  now: Date = new Date(),
): Promise<GoogleAdGroupsPage> {
  const status = oneOf(input.status, CAMPAIGN_STATUSES, 'status')
  const needle = needleOf(input.search)
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const frame = grainFrame(input, scope.context, states.range('AD_GROUP_DAYS'), now)
  const base = { ...listBase(scope, frame), read: states.read('AD_GROUPS'), numbersRead: states.read('AD_GROUP_DAYS') }
  const customerId = scope.customerId
  if (!customerId) return { ...base, items: [], nextCursor: null, total: 0 }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const [rows, sums, flags] = await Promise.all([
    prisma.googleAdsAdGroup.findMany({ where: { customerId, ...(googleCampaignId ? { campaignId: googleCampaignId } : {}) } }),
    sumsByEntity(customerId, 'AD_GROUP', frame.inWindow, { campaignId: googleCampaignId }),
    prisma.googleAdsCampaign.findMany({ where: { customerId }, select: { campaignId: true, flagsReadAt: true, aiMaxEnabled: true } }),
  ])
  const flagsOf = new Map(flags.map((f) => [f.campaignId, f]))
  const known = new Set(rows.map((row) => row.adGroupId))
  const unseen = [...sums.keys()].filter((id) => !known.has(id))
  const [labels, directory] = await Promise.all([
    labelsByEntity(customerId, 'AD_GROUP', unseen),
    googleCampaignDirectory(customerOfScope(scope, customerId), [...rows.map((r) => r.campaignId), ...unseen.map((id) => sums.get(id)!.campaignId)]),
  ])

  const all: GoogleAdGroup[] = [
    ...rows.map((row): GoogleAdGroup => {
      const campaign = directory(row.campaignId)
      return {
        ...campaignRefOf(campaign),
        adGroupId: row.id,
        externalAdGroupId: row.adGroupId,
        name: row.name,
        status: entityStatus(row.status, row.removedAt),
        primaryStatus: row.primaryStatus,
        primaryStatusReasons: row.primaryStatusReasons,
        type: row.type,
        cpcBidCents: minorOrNull(row.cpcBidMicros, frame.exponent),
        targetCpaCents: minorOrNull(row.targetCpaMicros, frame.exponent),
        targetRoas: numberOrNull(row.targetRoas),
        searchTermMatching: searchTermMatchingFlag(campaign.campaignType, flagsOf.get(row.campaignId), row.searchTermMatchingDisabled),
        settingsReadAt: iso(row.lastSeenAt),
        metrics: metricsOrNull(frame, sums.get(row.adGroupId)?.sums),
      }
    }),
    ...unseen.map((id): GoogleAdGroup => {
      const numbers = sums.get(id)!
      return {
        ...campaignRefOf(directory(numbers.campaignId)),
        adGroupId: unseenKey(customerId, id),
        externalAdGroupId: id,
        name: labels.get(id)?.trim() || `Ad group ${id}`,
        status: null,
        primaryStatus: null,
        primaryStatusReasons: [],
        type: null,
        cpcBidCents: null,
        targetCpaCents: null,
        targetRoas: null,
        searchTermMatching: null,
        settingsReadAt: null,
        metrics: metricsOrNull(frame, numbers.sums),
      }
    }),
  ]
  const items = all
    .filter((g) => !status || g.status === status)
    .filter((g) => !needle || g.name.toLowerCase().includes(needle))
  const cursorScope = detailScope('ad-groups', scope.context.account?.connectionId ?? null, {
    from: frame.window.from, to: frame.window.to, campaign: googleCampaignId, status, search: needle,
  })
  const page = keysetPage(items, (g) => ({ values: [textKey(g.name)], id: g.adGroupId }), cursorScope, input.cursor, input.limit)
  return { ...base, ...page }
}

// ── R6 — keywords ──────────────────────────────────────────────────────────────────────────────────────────────────

const UNSEEN_PAIR = /^(\d{1,20})~(\d{1,20})$/

/** An ad group of this business by Nexus's id (or `<customerId>~<googleAdGroupId>`); the Google id, else 404. */
async function adGroupFilter(asked: unknown, customerId: string): Promise<string | null> {
  const id = typeof asked === 'string' ? asked.trim() : ''
  if (!id) return null
  const pair = UNSEEN_PAIR.exec(id)
  if (pair) {
    if (pair[1] !== customerId) throw new GoogleAdsReadError(404, 'Ad group not found')
    return pair[2]
  }
  const row = id.length <= 64 ? await prisma.googleAdsAdGroup.findFirst({ where: { id }, select: { customerId: true, adGroupId: true } }) : null
  if (!row || row.customerId !== customerId) throw new GoogleAdsReadError(404, 'Ad group not found')
  return row.adGroupId
}

/** The ad groups of the account by Google's id: Nexus's id and name. */
async function adGroupNames(customerId: string, googleAdGroupIds: Iterable<string>): Promise<Map<string, { id: string; name: string }>> {
  const ids = [...new Set(googleAdGroupIds)].filter(Boolean)
  if (!ids.length) return new Map()
  const rows = await prisma.googleAdsAdGroup.findMany({ where: { customerId, adGroupId: { in: ids } }, select: { id: true, adGroupId: true, name: true } })
  return new Map(rows.map((row) => [row.adGroupId, { id: row.id, name: row.name }]))
}

/** R6 — one page of keywords (spend, high first, by default; or by text) with their numbers over the window. */
export async function googleAdsKeywords(
  input: GoogleDetailInput & { adGroupId?: string | null; status?: string | null; matchType?: string | null; search?: string | null; sort?: string | null },
  now: Date = new Date(),
): Promise<GoogleKeywordsPage> {
  const status = oneOf(input.status, CAMPAIGN_STATUSES, 'status')
  const matchType = oneOf(input.matchType, MATCH_TYPES, 'matchType')
  const sort = oneOf(input.sort, ['spend', 'text'] as const, 'sort') ?? 'spend'
  const needle = needleOf(input.search)
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const frame = grainFrame(input, scope.context, states.range('KEYWORD_DAYS'), now)
  const base = { ...listBase(scope, frame), read: states.read('KEYWORDS'), numbersRead: states.read('KEYWORD_DAYS') }
  const customerId = scope.customerId
  if (!customerId) {
    if (input.adGroupId) throw new GoogleAdsReadError(404, 'Ad group not found')
    return { ...base, items: [], nextCursor: null, total: 0 }
  }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const googleAdGroupId = await adGroupFilter(input.adGroupId, customerId)
  const [rows, allSums] = await Promise.all([
    prisma.googleAdsKeyword.findMany({
      where: {
        customerId, level: 'AD_GROUP', negative: false, criterionType: 'KEYWORD',
        ...(googleCampaignId ? { campaignId: googleCampaignId } : {}),
        ...(googleAdGroupId ? { adGroupId: googleAdGroupId } : {}),
      },
    }),
    sumsByEntity(customerId, 'KEYWORD', frame.inWindow, { campaignId: googleCampaignId }),
  ])
  // KEYWORD numbers are keyed <adGroupId>~<criterionId>.
  const sums = googleAdGroupId ? new Map([...allSums].filter(([key]) => key.startsWith(`${googleAdGroupId}~`))) : allSums
  const keyOfRow = (row: { adGroupId: string | null; criterionId: string }) => `${row.adGroupId ?? ''}~${row.criterionId}`
  const known = new Set(rows.map(keyOfRow))
  const unseen = [...sums.keys()].filter((key) => !known.has(key))
  const [labels, groups, directory] = await Promise.all([
    labelsByEntity(customerId, 'KEYWORD', unseen),
    adGroupNames(customerId, [...rows.map((r) => r.adGroupId ?? ''), ...unseen.map((key) => key.split('~')[0])]),
    googleCampaignDirectory(customerOfScope(scope, customerId), [...rows.map((r) => r.campaignId ?? ''), ...unseen.map((key) => sums.get(key)!.campaignId)]),
  ])

  const all: GoogleKeyword[] = [
    ...rows.map((row): GoogleKeyword => {
      const group = row.adGroupId ? groups.get(row.adGroupId) : undefined
      return {
        ...campaignRefOf(directory(row.campaignId ?? '')),
        keywordId: row.id,
        externalCriterionId: row.criterionId,
        adGroupId: group?.id ?? null,
        externalAdGroupId: row.adGroupId ?? '',
        adGroupName: group?.name ?? null,
        text: row.text ?? '',
        matchType: matchTypeOf(row.matchType),
        status: entityStatus(row.status, row.removedAt),
        servingStatus: row.systemServingStatus,
        approvalStatus: row.approvalStatus,
        primaryStatus: row.primaryStatus,
        qualityScore: row.qualityScore,
        cpcBidCents: minorOrNull(row.cpcBidMicros, frame.exponent),
        effectiveCpcBidCents: minorOrNull(row.effectiveCpcBidMicros, frame.exponent),
        settingsReadAt: iso(row.lastSeenAt),
        metrics: metricsOrNull(frame, sums.get(keyOfRow(row))?.sums),
      }
    }),
    ...unseen.map((key): GoogleKeyword => {
      const numbers = sums.get(key)!
      const [googleGroup, criterionId = ''] = key.split('~')
      const group = groups.get(googleGroup)
      return {
        ...campaignRefOf(directory(numbers.campaignId)),
        keywordId: unseenKey(customerId, googleGroup, criterionId),
        externalCriterionId: criterionId,
        adGroupId: group?.id ?? null,
        externalAdGroupId: googleGroup,
        adGroupName: group?.name ?? null,
        text: labels.get(key)?.trim() || `Keyword ${criterionId}`,
        matchType: null,
        status: null,
        servingStatus: null,
        approvalStatus: null,
        primaryStatus: null,
        qualityScore: null,
        cpcBidCents: null,
        effectiveCpcBidCents: null,
        settingsReadAt: null,
        metrics: metricsOrNull(frame, numbers.sums),
      }
    }),
  ]
  const items = all
    .filter((k) => !status || k.status === status)
    .filter((k) => !matchType || k.matchType === matchType)
    .filter((k) => !needle || k.text.toLowerCase().includes(needle))
  const cursorScope = detailScope('keywords', scope.context.account?.connectionId ?? null, {
    from: frame.window.from, to: frame.window.to, campaign: googleCampaignId, adGroup: googleAdGroupId, status, matchType, search: needle, sort,
  })
  const keyOf = (k: GoogleKeyword): CursorPosition => ({
    values: sort === 'spend' ? [spendKey(k.metrics), textKey(k.text)] : [textKey(k.text)],
    id: k.keywordId,
  })
  return { ...base, ...keysetPage(items, keyOf, cursorScope, input.cursor, input.limit) }
}

// ── R7 — negative keywords ─────────────────────────────────────────────────────────────────────────────────────────

const LEVELS = ['ad_group', 'campaign', 'list'] as const
type NegativeLevel = (typeof LEVELS)[number]
const LEVEL_OF: Readonly<Record<string, NegativeLevel>> = { AD_GROUP: 'ad_group', CAMPAIGN: 'campaign', LIST: 'list' }
const LEVEL_RANK: Readonly<Record<NegativeLevel, number>> = { ad_group: 0, campaign: 1, list: 2 }

const negativeStatus = (status: string | null): GoogleNegative['status'] => (status === 'ENABLED' || status === 'REMOVED' ? status : null)

/**
 * The campaign types Google applies the account-level negative keyword list to: "all search and shopping inventory in
 * Search, Performance Max, App, Shopping, Smart, and Local campaigns" (Google Ads Help, "About account-level negative
 * keywords", https://support.google.com/google-ads/answer/11396330). App campaigns are MULTI_CHANNEL in the API.
 */
export const ACCOUNT_LIST_CAMPAIGN_TYPES: ReadonlySet<string> = new Set(['SEARCH', 'PERFORMANCE_MAX', 'MULTI_CHANNEL', 'SHOPPING', 'SMART', 'LOCAL'])

/** The account-level kind of list (true), one for campaigns (false), or not read (null); a list in force for the account is one. */
const accountLevel = (row: { listType: string | null; appliesToAccount: boolean | null }): boolean | null =>
  (row.appliesToAccount === true ? true : row.listType === null ? null : row.listType === ACCOUNT_LEVEL_LIST_TYPE)

/**
 * R7 — one page of negative keywords (by level, then text). With `campaignId`: that campaign's ad groups' negatives, its
 * own negatives (brand exclusion lists among them) and the keywords of the negative keyword lists attached to it
 * (PLAN-1B M8) — and, for a campaign of a type Google applies it to, the account-level list: in force
 * (`appliesToAccount` true), not in use (false: shown as such) or not read (null); `lists` are then those lists.
 * Negatives Google no longer returns are left out.
 */
export async function googleAdsNegatives(input: {
  connectionId?: string | null
  campaignId?: string | null
  level?: string | null
  search?: string | null
  limit?: number | string | null
  cursor?: string | null
}): Promise<GoogleNegativesPage> {
  const level = oneOf(input.level, LEVELS, 'level')
  const needle = needleOf(input.search)
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const read = { adGroup: states.read('KEYWORDS'), campaign: states.read('CAMPAIGN_NEGATIVES'), lists: states.read('NEGATIVE_LISTS') }
  const customerId = scope.customerId
  if (!customerId) return { read, items: [], lists: [], nextCursor: null, total: 0 }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  // The account-level list goes with this campaign when its type is one Google applies it to (a type not read: no).
  const accountList = googleCampaignId
    ? ACCOUNT_LIST_CAMPAIGN_TYPES.has((await prisma.googleAdsCampaign.findFirst({
      where: { customerId, campaignId: googleCampaignId }, select: { channelType: true },
    }))?.channelType ?? '')
    : false
  const listRows = await prisma.googleAdsNegativeList.findMany({
    where: {
      customerId, removedAt: null,
      ...(googleCampaignId
        ? { OR: [{ campaignIds: { has: googleCampaignId } }, ...(accountList ? [{ listType: ACCOUNT_LEVEL_LIST_TYPE }, { appliesToAccount: true }] : [])] }
        : {}),
    },
  })
  const listIds = listRows.map((row) => row.sharedSetId)
  const own = googleCampaignId ? { campaignId: googleCampaignId } : {}
  const wanted = [
    ...(!level || level === 'ad_group' ? [{ level: 'AD_GROUP', negative: true, ...own }] : []),
    ...(!level || level === 'campaign' ? [{ level: 'CAMPAIGN', negative: true, ...own }] : []),
    ...(!level || level === 'list' ? [{ level: 'LIST', ...(googleCampaignId ? { sharedSetId: { in: listIds } } : {}) }] : []),
  ]
  const rows = await prisma.googleAdsKeyword.findMany({ where: { customerId, removedAt: null, OR: wanted } })
  const [groups, directory] = await Promise.all([
    adGroupNames(customerId, rows.map((r) => r.adGroupId ?? '')),
    googleCampaignDirectory(customerOfScope(scope, customerId), [...rows.map((r) => r.campaignId ?? ''), ...listRows.flatMap((l) => l.campaignIds)]),
  ])
  const lists = new Map(listRows.map((row) => [row.sharedSetId, row]))
  // A list keyword of a list no longer attached (or no longer returned) has no list row: it still names its list id.
  const items = rows
    .map((row): GoogleNegative => {
      const campaign = row.campaignId ? directory(row.campaignId) : null
      const group = row.adGroupId ? groups.get(row.adGroupId) : undefined
      const list = row.sharedSetId ? lists.get(row.sharedSetId) : undefined
      return {
        negativeId: row.id,
        level: LEVEL_OF[row.level] ?? 'campaign',
        kind: row.criterionType === 'BRAND_LIST' ? 'brand_list' : 'keyword',
        text: row.text,
        matchType: matchTypeOf(row.matchType),
        campaignId: campaign?.campaignId ?? null,
        externalCampaignId: row.campaignId,
        campaignName: campaign?.campaignName ?? null,
        adGroupId: group?.id ?? null,
        adGroupName: group?.name ?? null,
        listId: list?.id ?? null,
        listName: list?.name ?? null,
        status: negativeStatus(row.status),
        seenAt: row.lastSeenAt.toISOString(),
      }
    })
    .filter((n) => !needle || (n.text ?? '').toLowerCase().includes(needle) || (n.listName ?? '').toLowerCase().includes(needle))
  const cursorScope = detailScope('negatives', scope.context.account?.connectionId ?? null, { campaign: googleCampaignId, level, search: needle })
  const page = keysetPage(items, (n) => ({ values: [LEVEL_RANK[n.level], textKey(n.text)], id: n.negativeId }), cursorScope, input.cursor, input.limit)
  const listsOut = listRows
    .map((row): GoogleNegativeList => ({
      listId: row.id,
      externalListId: row.sharedSetId,
      name: row.name,
      status: row.status,
      memberCount: row.memberCount,
      accountLevel: accountLevel(row),
      appliesToAccount: row.appliesToAccount,
      campaigns: row.campaignIds.map((id) => {
        const campaign = directory(id)
        return { campaignId: campaign.campaignId, externalCampaignId: id, name: campaign.campaignName }
      }),
      seenAt: row.lastSeenAt.toISOString(),
    }))
    .sort((a, b) => (textKey(a.name) < textKey(b.name) ? -1 : textKey(a.name) > textKey(b.name) ? 1 : a.listId < b.listId ? -1 : 1))
  return { read, items: page.items, lists: listsOut, nextCursor: page.nextCursor, total: page.total }
}

// ── R10 — asset groups ─────────────────────────────────────────────────────────────────────────────────────────────

/** R10 — one page of asset groups (Performance Max; by name) with their numbers over the window. */
export async function googleAdsAssetGroups(input: GoogleDetailInput & { status?: string | null }, now: Date = new Date()): Promise<GoogleAssetGroupsPage> {
  const status = oneOf(input.status, CAMPAIGN_STATUSES, 'status')
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const frame = grainFrame(input, scope.context, states.range('ASSET_GROUP_DAYS'), now)
  const base = { ...listBase(scope, frame), read: states.read('ASSET_GROUPS'), numbersRead: states.read('ASSET_GROUP_DAYS') }
  const customerId = scope.customerId
  if (!customerId) return { ...base, items: [], nextCursor: null, total: 0 }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const [rows, sums] = await Promise.all([
    prisma.googleAdsAssetGroup.findMany({ where: { customerId, ...(googleCampaignId ? { campaignId: googleCampaignId } : {}) } }),
    sumsByEntity(customerId, 'ASSET_GROUP', frame.inWindow, { campaignId: googleCampaignId }),
  ])
  const known = new Set(rows.map((row) => row.assetGroupId))
  const unseen = [...sums.keys()].filter((id) => !known.has(id))
  const [labels, directory] = await Promise.all([
    labelsByEntity(customerId, 'ASSET_GROUP', unseen),
    googleCampaignDirectory(customerOfScope(scope, customerId), [...rows.map((r) => r.campaignId), ...unseen.map((id) => sums.get(id)!.campaignId)]),
  ])
  const all: GoogleAssetGroup[] = [
    ...rows.map((row): GoogleAssetGroup => ({
      ...campaignRefOf(directory(row.campaignId)),
      assetGroupId: row.id,
      externalAssetGroupId: row.assetGroupId,
      name: row.name,
      status: entityStatus(row.status, row.removedAt),
      primaryStatus: row.primaryStatus,
      primaryStatusReasons: row.primaryStatusReasons,
      adStrength: row.adStrength,
      finalUrls: row.finalUrls,
      settingsReadAt: iso(row.lastSeenAt),
      metrics: metricsOrNull(frame, sums.get(row.assetGroupId)?.sums),
    })),
    ...unseen.map((id): GoogleAssetGroup => {
      const numbers = sums.get(id)!
      return {
        ...campaignRefOf(directory(numbers.campaignId)),
        assetGroupId: unseenKey(customerId, id),
        externalAssetGroupId: id,
        name: labels.get(id)?.trim() || `Asset group ${id}`,
        status: null,
        primaryStatus: null,
        primaryStatusReasons: [],
        adStrength: null,
        finalUrls: [],
        settingsReadAt: null,
        metrics: metricsOrNull(frame, numbers.sums),
      }
    }),
  ]
  const items = all.filter((g) => !status || g.status === status)
  const cursorScope = detailScope('asset-groups', scope.context.account?.connectionId ?? null, {
    from: frame.window.from, to: frame.window.to, campaign: googleCampaignId, status,
  })
  return { ...base, ...keysetPage(items, (g) => ({ values: [textKey(g.name)], id: g.assetGroupId }), cursorScope, input.cursor, input.limit) }
}

// ── Product issues (R11, R15) ──────────────────────────────────────────────────────────────────────────────────────

const PRODUCT_STATUS: Readonly<Record<string, 'not_eligible' | 'limited'>> = { NOT_ELIGIBLE: 'not_eligible', ELIGIBLE_LIMITED: 'limited' }
const PRODUCT_RANK: Readonly<Record<GoogleProductStatus, number>> = { no_issue: 0, limited: 1, not_eligible: 2 }

const textOf = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const httpUrl = (value: unknown): string | null => {
  const text = textOf(value)
  return text && /^https?:\/\//i.test(text) ? text : null
}

/** Google's issues of one product as stored ([{ errorCode, adsSeverity, description, detail, documentation, affectedRegions }]). */
export function productIssueTexts(stored: unknown): GoogleProductIssueText[] {
  if (!Array.isArray(stored)) return []
  return stored.flatMap((raw): GoogleProductIssueText[] => {
    if (!raw || typeof raw !== 'object') return []
    const issue = raw as Record<string, unknown>
    const code = textOf(issue.errorCode ?? issue.error_code) ?? 'UNKNOWN'
    const regions = issue.affectedRegions ?? issue.affected_regions
    return [{
      code,
      severity: textOf(issue.adsSeverity ?? issue.ads_severity) ?? 'UNKNOWN',
      text: textOf(issue.description) ?? 'Google gave no description of this issue.',
      explanation: textOf(issue.detail),
      helpUrl: httpUrl(issue.documentation),
      regions: Array.isArray(regions) ? regions.filter((r): r is string => typeof r === 'string') : [],
    }]
  })
}

interface ProductIssueRow {
  itemId: string | null
  entityKey: string
  campaignId: string | null
  label: string | null
  status: string
  issues: unknown
  firstSeenAt: Date
}

/** One item's open issues, merged over its feeds and countries (its numbers name no feed): the worst status, every issue once. */
interface ItemIssues {
  title: string | null
  status: 'not_eligible' | 'limited'
  issues: GoogleProductIssueText[]
}

/** The item id of a product issue: its column, or the last part of `<merchant>~<channel>~<lang>~<feedLabel>~<itemId>`. */
const itemIdOf = (row: ProductIssueRow): string => row.itemId ?? row.entityKey.split('~').at(-1) ?? row.entityKey

function itemIssues(rows: ProductIssueRow[]): Map<string, ItemIssues> {
  const out = new Map<string, ItemIssues>()
  for (const row of rows) {
    const status = PRODUCT_STATUS[row.status]
    if (!status) continue
    const key = itemIdOf(row).toLowerCase()
    const issues = productIssueTexts(row.issues)
    const had = out.get(key)
    if (!had) {
      out.set(key, { title: row.label, status, issues })
      continue
    }
    if (PRODUCT_RANK[status] > PRODUCT_RANK[had.status]) had.status = status
    if (!had.title && row.label) had.title = row.label
    const seen = new Set(had.issues.map((i) => `${i.code}|${i.text}`))
    for (const issue of issues) if (!seen.has(`${issue.code}|${issue.text}`)) had.issues.push(issue)
  }
  return out
}

/** The item ids (lower case) a campaign ever advertised, from its product numbers (`<campaignId>~<itemId>`). */
async function itemsOfCampaign(customerId: string, googleCampaignId: string): Promise<Set<string>> {
  // Grouped in the database: one row per item, never one per day (Prisma's `distinct` drops repeats in memory).
  const rows = await prisma.googleAdsDailyMetric.groupBy({ by: ['entityId'], where: { customerId, entityType: 'PRODUCT', campaignId: googleCampaignId } })
  return new Set(rows.map((row) => row.entityId.slice(row.entityId.indexOf('~') + 1).toLowerCase()))
}

/**
 * Whether a product issue belongs to a campaign: it names that campaign, or — Google's product status names none — the
 * campaign advertised the item (R11 and R15 keep the same rule).
 */
const issueOfCampaign = (row: { campaignId: string | null }, itemId: string, googleCampaignId: string, advertised: Set<string>): boolean =>
  row.campaignId === googleCampaignId || (row.campaignId == null && advertised.has(itemId.toLowerCase()))

const openProductIssues = (customerId: string): Promise<ProductIssueRow[]> =>
  prisma.googleAdsPolicyIssue.findMany({
    where: { customerId, kind: 'PRODUCT', resolvedAt: null, status: { in: Object.keys(PRODUCT_STATUS) } },
    select: { itemId: true, entityKey: true, campaignId: true, label: true, status: true, issues: true, firstSeenAt: true },
    orderBy: [{ firstSeenAt: 'asc' }, { id: 'asc' }],
  })

/** Nexus products whose SKU is exactly the item id, case aside (the same case wins when two differ only by case). */
export async function nexusProductsBySku(itemIds: string[]): Promise<Map<string, { productId: string; sku: string; name: string } | null>> {
  const unique = [...new Set(itemIds.filter(Boolean))]
  const out = new Map<string, { productId: string; sku: string; name: string } | null>()
  if (!unique.length) return out
  const rows = await prisma.product.findMany({
    where: { deletedAt: null, OR: unique.map((sku) => ({ sku: { equals: sku, mode: 'insensitive' as const } })) },
    select: { id: true, sku: true, name: true },
  })
  for (const itemId of unique) {
    const same = rows.filter((row) => row.sku.toLowerCase() === itemId.toLowerCase())
    const hit = same.find((row) => row.sku === itemId) ?? (same.length === 1 ? same[0] : undefined)
    out.set(itemId, hit ? { productId: hit.id, sku: hit.sku, name: hit.name } : null)
  }
  return out
}

// ── R11 — advertised products ──────────────────────────────────────────────────────────────────────────────────────

const ISSUE_FILTERS = ['any', 'not_eligible', 'limited'] as const

/**
 * R11 — one page of the products Google Ads advertised in the window (one row per campaign and item), and the products
 * Google will not show or shows limited (their own row when they have no numbers in the window). `status` is null while
 * Nexus never read the product statuses; `nexusProduct` is the Nexus product with exactly this SKU, case aside.
 */
export async function googleAdsProducts(
  input: GoogleDetailInput & { issue?: string | null; search?: string | null; sort?: string | null },
  now: Date = new Date(),
): Promise<GoogleProductsPage> {
  const issue = oneOf(input.issue, ISSUE_FILTERS, 'issue')
  const sort = oneOf(input.sort, ['spend', 'title'] as const, 'sort') ?? 'spend'
  const needle = needleOf(input.search)
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const frame = grainFrame(input, scope.context, states.range('PRODUCT_DAYS'), now)
  const statusRead = states.read('PRODUCT_STATUS')
  const base = { ...listBase(scope, frame), numbersRead: states.read('PRODUCT_DAYS'), statusRead }
  const customerId = scope.customerId
  if (!customerId) return { ...base, items: [], nextCursor: null, total: 0 }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const [sums, issueRows, advertisedBy] = await Promise.all([
    sumsByEntity(customerId, 'PRODUCT', frame.inWindow, { campaignId: googleCampaignId }),
    statusRead.readAt ? openProductIssues(customerId) : Promise.resolve([] as ProductIssueRow[]),
    statusRead.readAt && googleCampaignId ? itemsOfCampaign(customerId, googleCampaignId) : Promise.resolve(new Set<string>()),
  ])
  const issuesOf = itemIssues(issueRows)
  const [titles, directory] = await Promise.all([
    labelsByEntity(customerId, 'PRODUCT', [...sums.keys()]),
    googleCampaignDirectory(customerOfScope(scope, customerId), [
      ...[...sums.values()].map((s) => s.campaignId), ...issueRows.map((r) => r.campaignId ?? ''), googleCampaignId ?? '',
    ]),
  ])
  const statusOf = (itemId: string): GoogleProduct['status'] => (statusRead.readAt ? issuesOf.get(itemId.toLowerCase())?.status ?? 'no_issue' : null)

  // PRODUCT numbers are keyed <campaignId>~<itemId>.
  const advertised = new Set<string>()
  const rows: Omit<GoogleProduct, 'nexusProduct'>[] = [...sums].map(([key, numbers]) => {
    const cut = key.indexOf('~')
    const itemId = cut >= 0 ? key.slice(cut + 1) : key
    advertised.add(itemId.toLowerCase())
    const campaign = directory(numbers.campaignId)
    const issues = issuesOf.get(itemId.toLowerCase())
    return {
      productKey: key,
      itemId,
      title: titles.get(key)?.trim() || issues?.title || null,
      campaignId: campaign.campaignId,
      externalCampaignId: numbers.campaignId,
      campaignName: campaign.campaignName,
      campaignType: campaign.campaignType,
      status: statusOf(itemId),
      issues: issues?.issues ?? [],
      metrics: metricsOrNull(frame, numbers.sums),
    }
  })
  // A product with an open issue and no numbers in the window (Google does not show it, so it has none): a row of its
  // own for each feed entry (one item id can be in several feeds or countries), keyed as R15 keys it. With a campaign:
  // only the campaign's own (issueOfCampaign), under that campaign.
  for (const row of issueRows) {
    const status = PRODUCT_STATUS[row.status]
    const itemId = itemIdOf(row)
    if (!status || advertised.has(itemId.toLowerCase())) continue
    if (googleCampaignId && !issueOfCampaign(row, itemId, googleCampaignId, advertisedBy)) continue
    const googleCampaign = row.campaignId ?? googleCampaignId
    const campaign = googleCampaign ? directory(googleCampaign) : null
    rows.push({
      productKey: row.entityKey,
      itemId,
      title: row.label,
      campaignId: campaign?.campaignId ?? null,
      externalCampaignId: googleCampaign,
      campaignName: campaign?.campaignName ?? null,
      campaignType: campaign?.campaignType ?? null,
      status,
      issues: productIssueTexts(row.issues),
      // Read days with no row are zero days (the numbers read keeps every product with an impression).
      metrics: metricsOrNull(frame, undefined),
    })
  }

  const items = rows
    .filter((p) => !issue || (issue === 'any' ? p.status === 'limited' || p.status === 'not_eligible' : p.status === issue))
    .filter((p) => !needle || p.itemId.toLowerCase().includes(needle) || (p.title ?? '').toLowerCase().includes(needle))
  const cursorScope = detailScope('products', scope.context.account?.connectionId ?? null, {
    from: frame.window.from, to: frame.window.to, campaign: googleCampaignId, issue, search: needle, sort,
  })
  const keyOf = (p: Omit<GoogleProduct, 'nexusProduct'>): CursorPosition => ({
    values: sort === 'spend' ? [spendKey(p.metrics), textKey(p.title ?? p.itemId)] : [textKey(p.title ?? p.itemId)],
    id: p.productKey,
  })
  const page = keysetPage(items, keyOf, cursorScope, input.cursor, input.limit)
  const products = await nexusProductsBySku(page.items.map((p) => p.itemId))
  return { ...base, ...page, items: page.items.map((p) => ({ ...p, nexusProduct: products.get(p.itemId) ?? null })) }
}

// ── R15 — disapprovals ─────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_DISAPPROVALS = 500
const AD_ISSUE_STATUSES: readonly GoogleAdIssueStatus[] = ['DISAPPROVED', 'APPROVED_LIMITED', 'AREA_OF_INTEREST_ONLY']

/**
 * R15 — the ads Google disapproved or limits, and the products it will not show or shows limited, as the last reads
 * found them (each list at most 500; disapproved and not eligible first; `truncated` when a list was cut).
 */
export async function googleAdsDisapprovals(input: { connectionId?: string | null; campaignId?: string | null; kind?: string | null }): Promise<GoogleDisapprovals> {
  const kind = oneOf(input.kind, ['ad', 'product'] as const, 'kind')
  const scope = await googleAdsScope(input)
  const states = await googleReadStates(scope.customerId)
  const read = { ads: states.read('AD_POLICY'), products: states.read('PRODUCT_STATUS') }
  const customerId = scope.customerId
  if (!customerId) return { read, ads: [], products: [], truncated: false }
  const googleCampaignId = scope.campaign?.googleCampaignId ?? null

  const [adRows, productRows, campaignItems] = await Promise.all([
    kind === 'product'
      ? Promise.resolve([])
      : prisma.googleAdsPolicyIssue.findMany({
          where: { customerId, kind: 'AD', resolvedAt: null, status: { in: [...AD_ISSUE_STATUSES] }, ...(googleCampaignId ? { campaignId: googleCampaignId } : {}) },
          orderBy: [{ status: 'desc' }, { firstSeenAt: 'desc' }, { id: 'asc' }],
          take: MAX_DISAPPROVALS + 1,
        }),
    kind === 'ad' ? Promise.resolve([] as ProductIssueRow[]) : openProductIssues(customerId),
    // A product issue names no campaign when Google gave none: it belongs to a campaign that advertised the item.
    kind !== 'ad' && googleCampaignId ? itemsOfCampaign(customerId, googleCampaignId) : Promise.resolve(new Set<string>()),
  ])
  const [groups, directory] = await Promise.all([
    adGroupNames(customerId, adRows.map((r) => r.adGroupId ?? '')),
    googleCampaignDirectory(customerOfScope(scope, customerId), adRows.map((r) => r.campaignId ?? '')),
  ])

  const ads = adRows.slice(0, MAX_DISAPPROVALS).map((row): GoogleAdIssue => {
    const campaign = row.campaignId ? directory(row.campaignId) : null
    const group = row.adGroupId ? groups.get(row.adGroupId) : undefined
    return {
      adId: row.id,
      externalAdId: row.adId ?? row.entityKey.split('~').at(-1) ?? row.entityKey,
      adType: row.adType,
      campaignId: campaign?.campaignId ?? null,
      campaignName: campaign?.campaignName ?? null,
      adGroupId: group?.id ?? null,
      adGroupName: group?.name ?? null,
      status: row.status as GoogleAdIssueStatus,
      reviewStatus: row.reviewStatus,
      reasons: row.reasons,
      since: row.firstSeenAt.toISOString(),
    }
  })
  const entries = productRows
    .map((row): GoogleProductIssue => ({
      productKey: row.entityKey,
      itemId: itemIdOf(row),
      title: row.label,
      status: PRODUCT_STATUS[row.status],
      issues: productIssueTexts(row.issues),
      since: row.firstSeenAt.toISOString(),
    }))
    .filter((p, i) => !googleCampaignId || issueOfCampaign(productRows[i], p.itemId, googleCampaignId, campaignItems))
    .sort((a, b) => PRODUCT_RANK[b.status] - PRODUCT_RANK[a.status] || (a.since < b.since ? 1 : a.since > b.since ? -1 : 0) || (a.productKey < b.productKey ? -1 : 1))
  const products = entries.slice(0, MAX_DISAPPROVALS)
  return { read, ads, products, truncated: adRows.length > MAX_DISAPPROVALS || entries.length > MAX_DISAPPROVALS }
}
