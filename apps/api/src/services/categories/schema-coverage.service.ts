/**
 * Channel-rule coverage (attribute parity P3, D1 = A, 2026-09-27): which (channel, market, category) rule sets a
 * business USES, which of them are cached, and one loop that downloads the missing ones. The nightly job
 * (`jobs/schema-refresh.job.ts`) and the sheet's "Download rules" action (`routes/categories.routes.ts`) both call
 * this module — one implementation.
 *
 * Why it exists: the sheet reads rules CACHE-ONLY (`channel-specs/index.ts`), and the nightly job used to take its
 * targets FROM the cached rows, so a pair nobody had opened was never downloaded (measured: 28 of 66 Amazon market ×
 * type pairs cached, Amazon · BE showed 5 fixed columns).
 *
 * "In use" per channel:
 *  - AMAZON: product types are market-independent, so every in-use type pairs with every ACTIVE Amazon market. A type
 *    is in use when an Amazon listing names it (`platformAttributes.productType`), an AMAZON category mapping names
 *    it, or a live product carries it in `Product.productType` AND it is recognisably an Amazon type — named by one of
 *    the first two, cached for any market of this business, or in the bundled Amazon list. `Product.productType` is
 *    free text and also holds placeholders (`EBAY_LISTING_SHELL`); asking Amazon for those only fails.
 *  - EBAY: category ids are SITE-specific, so a category pairs only with the market it came from (that market's
 *    listings and that market's mappings). A `'*'` mapping names no site and is skipped.
 *  - ETSY: one global taxonomy — ids from listings and mappings, market `GLOBAL`.
 * A market counts only while its `Marketplace` row is active.
 *
 * Every table read here is business-scoped by row policy: the caller's business context decides what is seen.
 */
import type { PrismaClient } from '@prisma/client'
import { categorySchemaMarket } from './category-schema-coordinate.js'
import type { CategorySchemaService, EnglishCopyOutcome } from './schema-sync.service.js'
import { BUNDLED_AMAZON_PRODUCT_TYPES } from '../listing-wizard/product-types.constants.js'
import { workspaceContext } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'

export const COVERAGE_CHANNELS = ['AMAZON', 'EBAY', 'ETSY'] as const
export type CoverageChannel = (typeof COVERAGE_CHANNELS)[number]
export type CoverageStatus = 'cached' | 'stale' | 'missing'

export interface SchemaTarget {
  channel: CoverageChannel
  marketplace: string
  productType: string
  status: CoverageStatus
  fetchedAt: Date | null
  expiresAt: Date | null
}

/** Values that sit in `Product.productType` but are not Amazon product types. */
export const PLACEHOLDER_PRODUCT_TYPES: ReadonlySet<string> = new Set(['EBAY_LISTING_SHELL'])
const AMAZON_TYPE = /^[A-Z0-9_]{1,100}$/
/** eBay leaf ids and Etsy taxonomy ids — the shapes the providers' fetchers accept. */
const NUMERIC_CATEGORY = /^[1-9]\d{0,18}$/
const BUNDLED_TYPES = new Set(BUNDLED_AMAZON_PRODUCT_TYPES.map(t => t.productType))

export const isCoverageChannel = (channel: string): channel is CoverageChannel =>
  (COVERAGE_CHANNELS as readonly string[]).includes(channel)

/** The stored spelling of a category id for a channel, or null when the provider would refuse it. */
export function normaliseCategory(channel: CoverageChannel, raw: unknown): string | null {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : typeof raw === 'string' ? raw.trim() : ''
  if (channel === 'AMAZON') {
    const type = value.toUpperCase()
    return AMAZON_TYPE.test(type) && !PLACEHOLDER_PRODUCT_TYPES.has(type) ? type : null
  }
  return NUMERIC_CATEGORY.test(value) ? value : null
}

/** What the collector reads — split from the pairing so the rules are testable without a database. */
export interface CoverageSources {
  /** ACTIVE `Marketplace` rows. */
  markets: Array<{ channel: string; code: string }>
  /** Active `CategorySchema` rows, one per coordinate, with their newest stamps. */
  cached: Array<{ channel: string; marketplace: string | null; productType: string; fetchedAt: Date | null; expiresAt: Date | null }>
  /** Distinct `Product.productType` of live products. */
  productTypes: Array<string | null>
  /** Distinct category field per listing (Amazon `productType`, eBay `categoryId`, Etsy `taxonomy_id`), live products only. */
  listings: Array<{ channel: string; marketplace: string; category: string }>
  mappings: Array<{ channel: string; marketplace: string; channelCategoryId: string }>
}

/** Reads the sources for one business (the caller's context), optionally for one channel. */
export async function readCoverageSources(client: PrismaClient, channel?: CoverageChannel): Promise<CoverageSources> {
  const channels = channel ? [channel] : [...COVERAGE_CHANNELS]
  const [markets, cached, products, listings, mappings] = await Promise.all([
    client.marketplace.findMany({ where: { channel: { in: channels }, isActive: true }, select: { channel: true, code: true } }),
    client.categorySchema.groupBy({
      by: ['channel', 'marketplace', 'productType'],
      where: { channel: { in: channels }, isActive: true },
      _max: { fetchedAt: true, expiresAt: true },
    }),
    // Only Amazon reads Product.productType; skip the scan for the other channels.
    channels.includes('AMAZON')
      ? client.product.groupBy({ by: ['productType'], where: { deletedAt: null, productType: { not: null } } })
      : Promise.resolve([] as Array<{ productType: string | null }>),
    client.$queryRaw<Array<{ channel: string; marketplace: string; category: string }>>`
      SELECT DISTINCT channel, marketplace, category FROM (
        SELECT cl.channel, cl.marketplace,
          CASE cl.channel WHEN 'AMAZON' THEN cl."platformAttributes"->>'productType'
                          WHEN 'EBAY' THEN cl."platformAttributes"->>'categoryId'
                          ELSE cl."platformAttributes"->>'taxonomy_id' END AS category
        FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
        WHERE cl.channel = ANY(${channels}::text[]) AND p."deletedAt" IS NULL
          AND jsonb_typeof(cl."platformAttributes"::jsonb) = 'object'
      ) listed WHERE category IS NOT NULL`,
    client.categoryChannelMapping.findMany({ where: { channel: { in: channels } }, select: { channel: true, marketplace: true, channelCategoryId: true } }),
  ])
  return {
    markets,
    cached: cached.map(r => ({ channel: r.channel, marketplace: r.marketplace, productType: r.productType, fetchedAt: r._max.fetchedAt, expiresAt: r._max.expiresAt })),
    productTypes: products.map(p => p.productType),
    listings,
    mappings,
  }
}

const keyOf = (channel: string, marketplace: string, productType: string) => `${channel}|${marketplace}|${productType}`

/** The market spelling a cached row serves, as the sheet reads it (eBay: `EBAY_IT`/`GB` fold in; Amazon: exact). */
function servedMarket(channel: CoverageChannel, marketplace: string | null): string | null {
  if (channel === 'AMAZON') return marketplace ? marketplace.toUpperCase() : null
  return categorySchemaMarket(channel, marketplace)
}

function statusOf(row: { fetchedAt: Date | null; expiresAt: Date | null } | undefined, now: Date): CoverageStatus {
  if (!row) return 'missing'
  return row.expiresAt && row.expiresAt.getTime() > now.getTime() ? 'cached' : 'stale'
}

/** PURE. Every in-use pair with its cache status, ordered by channel, market, category. */
export function inUsePairs(sources: CoverageSources, now = new Date()): SchemaTarget[] {
  const activeMarkets = new Map<CoverageChannel, Set<string>>(COVERAGE_CHANNELS.map(c => [c, new Set<string>()]))
  for (const m of sources.markets) {
    const channel = m.channel.toUpperCase()
    if (!isCoverageChannel(channel)) continue
    const code = channel === 'AMAZON' ? m.code.trim().toUpperCase() : categorySchemaMarket(channel, m.code)
    if (code) activeMarkets.get(channel)!.add(code)
  }

  const cachedBy = new Map<string, { fetchedAt: Date | null; expiresAt: Date | null }>()
  const cachedAmazonTypes = new Set<string>()
  for (const row of sources.cached) {
    const channel = row.channel.toUpperCase()
    if (!isCoverageChannel(channel)) continue
    if (channel === 'AMAZON') cachedAmazonTypes.add(row.productType.toUpperCase())
    const market = servedMarket(channel, row.marketplace)
    if (!market) continue
    const key = keyOf(channel, market, channel === 'AMAZON' ? row.productType.toUpperCase() : row.productType)
    const prev = cachedBy.get(key)
    const later = (a: Date | null, b: Date | null) => (!a ? b : !b ? a : a > b ? a : b)
    cachedBy.set(key, { fetchedAt: later(prev?.fetchedAt ?? null, row.fetchedAt), expiresAt: later(prev?.expiresAt ?? null, row.expiresAt) })
  }

  const pairs = new Set<string>()
  const add = (channel: CoverageChannel, market: string | null, raw: unknown) => {
    const category = normaliseCategory(channel, raw)
    if (market && category && activeMarkets.get(channel)!.has(market)) pairs.add(keyOf(channel, market, category))
  }

  // AMAZON — listing and mapping types are in use outright; a product's own type only when it is recognisable.
  const amazonTypes = new Set<string>()
  for (const l of sources.listings) if (l.channel === 'AMAZON') { const t = normaliseCategory('AMAZON', l.category); if (t) amazonTypes.add(t) }
  for (const m of sources.mappings) if (m.channel === 'AMAZON') { const t = normaliseCategory('AMAZON', m.channelCategoryId); if (t) amazonTypes.add(t) }
  const recognised = new Set([...amazonTypes, ...cachedAmazonTypes, ...BUNDLED_TYPES])
  for (const raw of sources.productTypes) { const t = normaliseCategory('AMAZON', raw); if (t && recognised.has(t)) amazonTypes.add(t) }
  for (const market of activeMarkets.get('AMAZON')!) for (const type of amazonTypes) add('AMAZON', market, type)

  // EBAY — the market the category came from, never another site. ETSY — one global taxonomy.
  for (const l of sources.listings) {
    if (l.channel === 'EBAY') add('EBAY', categorySchemaMarket('EBAY', l.marketplace), l.category)
    if (l.channel === 'ETSY') add('ETSY', 'GLOBAL', l.category)
  }
  for (const m of sources.mappings) {
    if (m.channel === 'EBAY' && m.marketplace !== '*') add('EBAY', categorySchemaMarket('EBAY', m.marketplace), m.channelCategoryId)
    if (m.channel === 'ETSY') add('ETSY', 'GLOBAL', m.channelCategoryId)
  }

  return [...pairs].sort().map(key => {
    const [channel, marketplace, productType] = key.split('|') as [CoverageChannel, string, string]
    const row = cachedBy.get(key)
    return { channel, marketplace, productType, status: statusOf(row, now), fetchedAt: row?.fetchedAt ?? null, expiresAt: row?.expiresAt ?? null }
  })
}

/**
 * PURE. The nightly job's targets: every in-use pair, then every other cached coordinate (refreshed as before this
 * change, so a type opened in the wizard or flat file stays fresh). A null Amazon market is IT, as it always was here.
 */
export function refreshTargets(sources: CoverageSources, now = new Date()): SchemaTarget[] {
  const targets = inUsePairs(sources, now)
  const seen = new Set(targets.map(t => keyOf(t.channel, t.marketplace, t.productType)))
  const extra: SchemaTarget[] = []
  for (const row of sources.cached) {
    const channel = row.channel.toUpperCase()
    if (!isCoverageChannel(channel)) continue
    const marketplace = categorySchemaMarket(channel, row.marketplace ?? (channel === 'AMAZON' ? 'IT' : null))
    if (!marketplace) continue
    const key = keyOf(channel, marketplace, row.productType)
    if (seen.has(key)) continue
    seen.add(key)
    extra.push({ channel, marketplace, productType: row.productType, status: statusOf(row, now), fetchedAt: row.fetchedAt, expiresAt: row.expiresAt })
  }
  extra.sort((a, b) => keyOf(a.channel, a.marketplace, a.productType).localeCompare(keyOf(b.channel, b.marketplace, b.productType)))
  return [...targets, ...extra]
}

/** In-use pairs for the caller's business, optionally narrowed to one channel and market. No provider call. */
export async function collectSchemaCoverage(client: PrismaClient, filter: { channel?: CoverageChannel; market?: string | null } = {}): Promise<SchemaTarget[]> {
  const pairs = inUsePairs(await readCoverageSources(client, filter.channel))
  const market = filter.channel && filter.market ? categorySchemaMarket(filter.channel, filter.market) : null
  return pairs.filter(p => (!filter.channel || p.channel === filter.channel) && (!market || p.marketplace === market))
}

/** The nightly job's targets for the caller's business. */
export async function collectSchemaTargets(client: PrismaClient): Promise<SchemaTarget[]> {
  return refreshTargets(await readCoverageSources(client))
}

export type FillOutcome = 'added' | 'refreshed' | 'already' | 'failed' | 'skipped'
/** `english` — W3 PR-A: what became of the pair's Amazon English copy, when one was asked for. */
export interface FillResult { target: SchemaTarget; outcome: FillOutcome; error?: string; english?: EnglishCopyOutcome }
/**
 * `englishStored` / `englishFailed` — W3 PR-A: Amazon English copies downloaded and kept / not kept (a failed call, or
 * a reply not in English). The nightly summary prints both: the production proof that Amazon answers in English.
 */
export interface FillCounts { added: number; refreshed: number; failed: number; skipped: number; englishStored: number; englishFailed: number }

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Sequential, throttled. A missing pair is fetched through the ordinary cache path (`getSchema`, which stores it); a
 * cached or stale one is force-refreshed only when `refreshCached` is set, else reported `already`. One failure is
 * logged with its coordinate and the loop continues.
 *
 * W3 PR-A — Amazon's English copy (`refreshEnglishCopy`): fetched after every added or refreshed Amazon pair, and, for
 * an `already` Amazon pair, only when it has none and `englishIfMissing` still allows a download (each one that reaches
 * Amazon uses one). A failed English copy never fails the pair; it is counted in `englishFailed`.
 */
export async function fillSchemaTargets(
  targets: readonly SchemaTarget[],
  deps: {
    service: Pick<CategorySchemaService, 'getSchema' | 'refreshSchema'> & Partial<Pick<CategorySchemaService, 'refreshEnglishCopy'>>
    refreshCached?: boolean
    /** How many English copies an `already` Amazon pair may download in this run (default none). */
    englishIfMissing?: number
    skip?: (target: SchemaTarget) => boolean
    throttleMs?: number
    label?: string
  },
): Promise<{ results: FillResult[]; counts: Partial<Record<CoverageChannel, FillCounts>> }> {
  const results: FillResult[] = []
  const counts: Partial<Record<CoverageChannel, FillCounts>> = {}
  const throttleMs = deps.throttleMs ?? 300
  let englishBudget = deps.englishIfMissing ?? 0
  const english = async (query: { channel: CoverageChannel; marketplace: string; productType: string }, count: FillCounts, onlyIfMissing: boolean) => {
    if (query.channel !== 'AMAZON' || !deps.service.refreshEnglishCopy) return undefined
    const outcome = await deps.service.refreshEnglishCopy(query, { onlyIfMissing })
    if (outcome === 'stored') count.englishStored++
    if (outcome === 'failed') count.englishFailed++
    return outcome
  }
  for (const target of targets) {
    const count = (counts[target.channel] ??= { added: 0, refreshed: 0, failed: 0, skipped: 0, englishStored: 0, englishFailed: 0 })
    if (deps.skip?.(target)) { count.skipped++; results.push({ target, outcome: 'skipped' }); continue }
    const adding = target.status === 'missing'
    const query = { channel: target.channel, marketplace: target.marketplace, productType: target.productType }
    if (!adding && !deps.refreshCached) {
      const outcome = englishBudget > 0 ? await english(query, count, true) : undefined
      results.push({ target, outcome: 'already', ...(outcome ? { english: outcome } : {}) })
      // Only a copy that reached Amazon uses the budget and the throttle.
      if (outcome === 'stored' || outcome === 'failed') { englishBudget--; if (throttleMs > 0) await sleep(throttleMs) }
      continue
    }
    try {
      if (adding) await deps.service.getSchema(query)
      else await deps.service.refreshSchema(query, { englishCopy: false })
      if (adding) count.added++; else count.refreshed++
      if (target.channel === 'AMAZON' && deps.service.refreshEnglishCopy && throttleMs > 0) await sleep(throttleMs)
      const outcome = await english(query, count, false)
      results.push({ target, outcome: adding ? 'added' : 'refreshed', ...(outcome ? { english: outcome } : {}) })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      count.failed++
      results.push({ target, outcome: 'failed', error })
      logger.warn(`${deps.label ?? 'schema-coverage'}: ${adding ? 'download' : 'refresh'} failed`, {
        ...query, workspaceId: workspaceContext()?.workspaceId ?? null, error,
      })
    }
    if (throttleMs > 0) await sleep(throttleMs) // the providers' definition APIs are rate-limited
  }
  return { results, counts }
}

/** At most this many downloads per sheet request, so one click cannot hold a request open indefinitely. */
export const MAX_DOWNLOADS_PER_REQUEST = 25

/**
 * PURE. The sheet's download plan for one channel + market. Listed categories must be in use there (never an
 * arbitrary value from the client); without a list, every in-use pair. Missing pairs beyond the cap are left for the
 * next click or the nightly job.
 */
export function planSchemaDownload(channel: CoverageChannel, pairs: readonly SchemaTarget[], requested?: readonly string[]) {
  const wanted = requested ? [...new Set(requested.map(v => normaliseCategory(channel, v) ?? String(v).trim()))] : null
  const inUse = new Set(pairs.map(p => p.productType))
  const notInUse = wanted ? wanted.filter(v => !inUse.has(v)) : []
  const chosen = wanted ? pairs.filter(p => wanted.includes(p.productType)) : [...pairs]
  const deferred = new Set(chosen.filter(p => p.status === 'missing').slice(MAX_DOWNLOADS_PER_REQUEST))
  return { notInUse, targets: chosen.filter(p => !deferred.has(p)), remaining: deferred.size }
}

/** A request the caller can correct; the route answers 400 with the message and details. */
export class CoverageRequestError extends Error {
  constructor(message: string, readonly details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'CoverageRequestError'
  }
}

function requestScope(input: { channel?: unknown; market?: unknown }) {
  const channel = typeof input.channel === 'string' ? input.channel.trim().toUpperCase() : ''
  if (!isCoverageChannel(channel)) throw new CoverageRequestError(`unsupported channel: ${String(input.channel ?? '')}`)
  const market = typeof input.market === 'string' && input.market.trim() ? categorySchemaMarket(channel, input.market) : null
  return { channel, market }
}

/** GET /categories/schema/coverage — the in-use pairs of one channel (optionally one market). Cache rows only. */
export async function schemaCoverageReport(client: PrismaClient, input: { channel?: unknown; market?: unknown }) {
  const { channel, market } = requestScope(input)
  const pairs = await collectSchemaCoverage(client, { channel, market })
  const counts: Record<CoverageStatus, number> = { cached: 0, stale: 0, missing: 0 }
  for (const p of pairs) counts[p.status]++
  return {
    channel, market, counts,
    pairs: pairs.map(p => ({ marketplace: p.marketplace, productType: p.productType, status: p.status, fetchedAt: p.fetchedAt, expiresAt: p.expiresAt })),
  }
}

/**
 * POST /categories/schema/download — the sheet's urgent-case "Download rules" for one channel + ACTIVE market: the
 * missing in-use pairs (or the listed ones, each of which must be in use there), fetched one at a time.
 */
export async function downloadMissingSchemas(
  client: PrismaClient,
  service: Pick<CategorySchemaService, 'getSchema' | 'refreshSchema'> & Partial<Pick<CategorySchemaService, 'refreshEnglishCopy'>>,
  input: { channel?: unknown; market?: unknown; productTypes?: unknown },
) {
  const { channel, market } = requestScope(input)
  if (!market) throw new CoverageRequestError('market is required')
  const listed = input.productTypes
  if (listed !== undefined && (!Array.isArray(listed) || listed.length === 0 || listed.length > 200
    || listed.some(v => typeof v !== 'string' || !/^[A-Z0-9_]{1,100}$/i.test(v.trim())))) {
    throw new CoverageRequestError('productTypes must be a non-empty list of up to 200 category ids')
  }
  const active = await client.marketplace.findFirst({ where: { channel, code: market, isActive: true }, select: { code: true } })
  if (!active) throw new CoverageRequestError('Unknown or inactive marketplace')

  const plan = planSchemaDownload(channel, await collectSchemaCoverage(client, { channel, market }), listed as string[] | undefined)
  if (plan.notInUse.length) throw new CoverageRequestError('Only rule sets in use in this market can be downloaded', { notInUse: plan.notInUse })
  // W3 PR-A — an `already` Amazon pair without its English copy downloads it, within what the cap leaves.
  const englishIfMissing = Math.max(0, MAX_DOWNLOADS_PER_REQUEST - plan.targets.filter(t => t.status === 'missing').length)
  const { results } = await fillSchemaTargets(plan.targets, { service, englishIfMissing, label: 'categories/schema/download' })
  return {
    channel, market, remaining: plan.remaining,
    results: results.map(r => ({ productType: r.target.productType, outcome: r.outcome, ...(r.error ? { error: r.error } : {}) })),
  }
}
