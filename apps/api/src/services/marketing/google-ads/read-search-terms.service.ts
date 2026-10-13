/**
 * Google Ads step 1b — the searches people made before they clicked an ad (R8) and the brand split (R9), PLAN-1B.md
 * "API contract". Read only, from the SEARCH_TERM rows of GoogleAdsDailyMetric (the term is the row's label).
 *
 *   - Google lists only the searches with at least one click (`scope: 'terms_with_clicks'`, PLAN-1B M7); the rest of
 *     the spend is "not in the search-term list" (R9), never spread over the terms
 *   - brand comes from the business's protected terms (brand.ts); with none, every `brand` is null, never false
 *   - a day counts only when Nexus read it: R8 the search-term days, R9 the days read by BOTH the campaign numbers and
 *     the search terms (a split of days only one side read would be made up)
 */
import prisma from '../../../db.js'
import type { CursorPosition } from '../../../lib/pagination/cursor.js'
import type { DayWindow } from './dates.js'
import { dayToDate } from './dates.js'
import { googleBrand } from './brand.js'
import {
  ZERO,
  addSums,
  coverageOf,
  currencyExponent,
  detailScope,
  googleAdsAccount,
  googleAdsScope,
  googleCampaignDirectory,
  googleReadStates,
  grainFrame,
  iso,
  keysetPage,
  metricsOf,
  needleOf,
  newestLabels,
  oneOf,
  overlap,
  readRangeOf,
  resolveWindow,
  sumsByEntity,
  textKey,
  type Sums,
  type WindowInput,
} from './read.service.js'
import type { GoogleBrandSplit, GoogleBrandSplitRow, GoogleBrandSplitType, GoogleSearchTerm, GoogleSearchTermsPage } from './read-types.js'
import type { GoogleDetailInput } from './read-detail.service.js'

/** The term of each search-term entity over the days read (the newest label it carried). */
async function termsOf(customerId: string, range: DayWindow | null, googleCampaignId: string | null): Promise<Map<string, string>> {
  if (!range) return new Map()
  const labels = await newestLabels({
    customerId, entityType: 'SEARCH_TERM', date: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
    ...(googleCampaignId ? { campaignId: googleCampaignId } : {}),
  })
  return new Map([...labels].map(([id, label]) => [id, label ?? '']))
}

// ── R8 — search terms ──────────────────────────────────────────────────────────────────────────────────────────────

const BRAND_FILTERS = ['all', 'brand', 'non_brand'] as const
const SORTS = ['spend', 'clicks', 'conversions', 'term'] as const

/** R8 — one page of search terms with at least one click (spend, high first, by default), one row per campaign and term. */
export async function googleAdsSearchTerms(
  input: GoogleDetailInput & { brand?: string | null; search?: string | null; sort?: string | null },
  now: Date = new Date(),
): Promise<GoogleSearchTermsPage> {
  const brandFilter = oneOf(input.brand, BRAND_FILTERS, 'brand')
  const sort = oneOf(input.sort, SORTS, 'sort') ?? 'spend'
  const needle = needleOf(input.search)
  const scope = await googleAdsScope(input)
  const [states, brand] = await Promise.all([googleReadStates(scope.customerId), googleBrand()])
  const frame = grainFrame(input, scope.context, states.range('SEARCH_TERM_DAYS'), now)
  const base = {
    window: frame.window, currency: scope.context.currency, dataAsOf: iso(scope.context.customer?.lastSuccessAt),
    read: states.read('SEARCH_TERM_DAYS'), coverage: frame.coverage, scope: 'terms_with_clicks' as const, brandTerms: brand.brandTerms,
  }
  const customerId = scope.customerId
  if (!customerId) return { ...base, items: [], nextCursor: null, total: 0 }

  const googleCampaignId = scope.campaign?.googleCampaignId ?? null
  const [sums, terms] = await Promise.all([
    sumsByEntity(customerId, 'SEARCH_TERM', frame.inWindow, { campaignId: googleCampaignId }),
    termsOf(customerId, frame.inWindow, googleCampaignId),
  ])
  const directory = await googleCampaignDirectory(
    { customerId, structureSyncedAt: scope.context.customer?.structureSyncedAt ?? null, timeZone: scope.context.timeZone },
    [...sums.values()].map((s) => s.campaignId),
  )
  const all = [...sums].map(([termId, numbers]): GoogleSearchTerm => {
    const campaign = directory(numbers.campaignId)
    const term = terms.get(termId) ?? ''
    return {
      campaignId: campaign.campaignId,
      externalCampaignId: campaign.externalCampaignId,
      campaignName: campaign.campaignName,
      campaignType: campaign.campaignType,
      termId,
      term,
      brand: brand.isBrand(term),
      metrics: metricsOf(numbers.sums, frame.exponent),
    }
  })
  const items = all
    .filter((t) => !brandFilter || brandFilter === 'all' || (brandFilter === 'brand' ? t.brand === true : t.brand === false))
    .filter((t) => !needle || t.term.toLowerCase().includes(needle))
  const cursorScope = detailScope('search-terms', scope.context.account?.connectionId ?? null, {
    from: frame.window.from, to: frame.window.to, campaign: googleCampaignId, brand: brandFilter, search: needle, sort,
    // Another set of protected terms gives other rows under the same filter: its cursor is not this list's.
    brandTerms: brand.brandTerms.terms.join('\n'),
  })
  const keyOf = (t: GoogleSearchTerm): CursorPosition => {
    const m = t.metrics
    const first = sort === 'spend' ? -m.spendCents : sort === 'clicks' ? -m.clicks : sort === 'conversions' ? -m.conversions : null
    return { values: first === null ? [textKey(t.term)] : [first, textKey(t.term)], id: t.termId }
  }
  return { ...base, ...keysetPage(items, keyOf, cursorScope, input.cursor, input.limit) }
}

// ── R9 — the brand split ───────────────────────────────────────────────────────────────────────────────────────────

const SPLIT_TYPES: readonly GoogleBrandSplitType[] = ['ALL', 'SEARCH', 'SHOPPING', 'PERFORMANCE_MAX']

/** a − b, field by field, never below zero (the campaign numbers and the terms are re-read on different days). */
function lessOf(a: Sums, b: Sums): Sums {
  const big = (x: bigint, y: bigint) => (x > y ? x - y : 0n)
  return {
    impressions: Math.max(0, a.impressions - b.impressions),
    clicks: Math.max(0, a.clicks - b.clicks),
    costMicros: big(a.costMicros, b.costMicros),
    conversions4: big(a.conversions4, b.conversions4),
    valueMicros: big(a.valueMicros, b.valueMicros),
  }
}

function intersect(a: DayWindow | null, b: DayWindow | null): DayWindow | null {
  if (!a || !b) return null
  return overlap(a, b)
}

/**
 * R9 — per campaign type (and all together): the campaigns' total, what brand and other search terms add up to, and the
 * rest (spend on searches Google does not list). Over the days read by both the campaign numbers and the search terms.
 */
export async function googleAdsBrandSplit(input: { connectionId?: string | null } & WindowInput, now: Date = new Date()): Promise<GoogleBrandSplit> {
  const context = await googleAdsAccount(input.connectionId)
  const [states, brand] = await Promise.all([googleReadStates(context.customerId), googleBrand()])
  const window = resolveWindow(input, context.timeZone, !!context.customerId, now)
  const both = intersect(readRangeOf(context.customer), states.range('SEARCH_TERM_DAYS'))
  const inWindow = overlap(window, both)
  const coverage = coverageOf(window, both)
  const exponent = currencyExponent(context.currency)
  const base = {
    window, currency: context.currency, dataAsOf: iso(context.customer?.lastSuccessAt),
    read: states.read('SEARCH_TERM_DAYS'), coverage, brandTerms: brand.brandTerms,
  }
  const customerId = context.customerId
  const unread = (campaignType: GoogleBrandSplitType): GoogleBrandSplitRow => ({ campaignType, total: null, brand: null, nonBrand: null, notInSearchTerms: null })
  if (!customerId || !inWindow || coverage.daysRead === 0) return { ...base, rows: SPLIT_TYPES.map(unread) }

  const [campaignSums, termSums, terms] = await Promise.all([
    sumsByEntity(customerId, 'CAMPAIGN', inWindow),
    sumsByEntity(customerId, 'SEARCH_TERM', inWindow),
    termsOf(customerId, inWindow, null),
  ])
  const directory = await googleCampaignDirectory(
    { customerId, structureSyncedAt: context.customer?.structureSyncedAt ?? null, timeZone: context.timeZone },
    [...campaignSums.keys(), ...[...termSums.values()].map((s) => s.campaignId)],
  )
  const matches = (type: GoogleBrandSplitType, googleCampaignId: string) => type === 'ALL' || directory(googleCampaignId).campaignType === type
  const hasBrand = brand.brandTerms.terms.length > 0

  const rows = SPLIT_TYPES.map((campaignType): GoogleBrandSplitRow => {
    let all = ZERO
    let inTerms = ZERO
    let brandSums = ZERO
    let otherSums = ZERO
    for (const [googleCampaignId, numbers] of campaignSums) if (matches(campaignType, googleCampaignId)) all = addSums(all, numbers.sums)
    for (const [termId, numbers] of termSums) {
      if (!matches(campaignType, numbers.campaignId)) continue
      inTerms = addSums(inTerms, numbers.sums)
      if (brand.isBrand(terms.get(termId) ?? '')) brandSums = addSums(brandSums, numbers.sums)
      else otherSums = addSums(otherSums, numbers.sums)
    }
    return {
      campaignType,
      total: metricsOf(all, exponent),
      brand: hasBrand ? metricsOf(brandSums, exponent) : null,
      nonBrand: hasBrand ? metricsOf(otherSums, exponent) : null,
      notInSearchTerms: metricsOf(lessOf(all, inTerms), exponent),
    }
  })
  return { ...base, rows }
}
