/**
 * Amazon Best Sellers Rank — the feed that reads it and the read Claude's `sales-rank` tool answers from.
 *
 * Amazon publishes a product's Best Sellers Rank through the Catalog Items API (v2022-04-01, `searchCatalogItems`,
 * includedData=salesRanks): per marketplace, the rank in one or more browse nodes (`classificationRanks` — a sub-category
 * such as a jackets node) and in a whole department (`displayGroupRanks`). Nexus had no reader, so "get into the top 5"
 * could not be measured. This is it:
 *
 *   · which ASINs — every ACTIVE, published, not-closed Amazon listing of the business with an ASIN (children and
 *     parents), per market, deduped; the product a row names is the one its listing sells (the listing's ASIN, never
 *     Product.amazonAsin, which can be stale);
 *   · how — up to 20 ASINs per call (the API's limit), one marketplace per call, through the channel gateway like every
 *     call of AmazonSpApiClient (rate bucket, account status, ledger);
 *   · what is stored — one AmazonSalesRank row per ASIN and market when its ranks changed since the last stored read, or
 *     the last stored read is a day old (a heartbeat, so "no change for a day" is visible); an ASIN Amazon reports no rank
 *     for writes nothing. Rows older than 180 days are pruned by the same run;
 *   · failures — a batch that fails is counted and skipped; an account whose call was not sent (it needs sign-in, the
 *     gateway refused) is not asked again in this run. Nothing throws out of a run.
 *
 * Read only towards Amazon. Business-scoped like every query here (the cron visits each business).
 */
import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/** At most this many ASINs per searchCatalogItems call (Amazon's own limit for identifiers). */
export const SALES_RANK_BATCH = 20
/** Rows older than this are pruned by every run. */
export const SALES_RANK_RETENTION_DAYS = 180
/** A read whose ranks did not change is stored again once the last stored one is this old. */
export const SALES_RANK_HEARTBEAT_HOURS = 24
/** The read window of the tool: default and maximum, in days. */
export const SALES_RANK_DEFAULT_DAYS = 14
export const SALES_RANK_MAX_DAYS = 90

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

export interface ClassificationRank { id: string; title: string; rank: number }
export interface DisplayGroupRank { group: string; title: string; rank: number }
export interface AsinRanks { classification: ClassificationRank[]; displayGroup: DisplayGroupRank[] }

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const positiveInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)
const byRank = <T extends { rank: number }>(a: T, b: T) => a.rank - b.rank

/** Split a list into chunks of at most `size` (the API's 20 identifiers per call). Pure. */
export function chunk<T>(items: readonly T[], size = SALES_RANK_BATCH): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * The ranks per ASIN in one marketplace, from a searchCatalogItems body. Ranks Amazon gives for another marketplace are
 * ignored; a rank that is not a positive whole number is dropped; each list is sorted best first. An ASIN Amazon returned
 * with no rank in this marketplace maps to empty lists. Pure.
 */
export function parseSalesRanks(body: unknown, marketplaceId: string): Map<string, AsinRanks> {
  const out = new Map<string, AsinRanks>()
  const items = (body as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return out
  for (const item of items) {
    const asin = text((item as { asin?: unknown })?.asin).toUpperCase()
    if (!asin) continue
    const ranks: AsinRanks = out.get(asin) ?? { classification: [], displayGroup: [] }
    const salesRanks = (item as { salesRanks?: unknown }).salesRanks
    for (const entry of Array.isArray(salesRanks) ? salesRanks : []) {
      const e = entry as { marketplaceId?: unknown; classificationRanks?: unknown; displayGroupRanks?: unknown }
      if (text(e.marketplaceId) && text(e.marketplaceId) !== marketplaceId) continue
      for (const c of Array.isArray(e.classificationRanks) ? e.classificationRanks : []) {
        const r = c as { classificationId?: unknown; title?: unknown; rank?: unknown }
        const rank = positiveInt(r.rank)
        const id = text(r.classificationId)
        if (rank != null && id) ranks.classification.push({ id, title: text(r.title) || id, rank })
      }
      for (const g of Array.isArray(e.displayGroupRanks) ? e.displayGroupRanks : []) {
        const r = g as { websiteDisplayGroup?: unknown; title?: unknown; rank?: unknown }
        const rank = positiveInt(r.rank)
        const group = text(r.websiteDisplayGroup)
        if (rank != null && group) ranks.displayGroup.push({ group, title: text(r.title) || group, rank })
      }
    }
    ranks.classification.sort(byRank)
    ranks.displayGroup.sort(byRank)
    out.set(asin, ranks)
  }
  return out
}

/** The best (lowest) browse-node rank, else the best department rank, else null. Pure. */
export function bestRankOf(r: AsinRanks): number | null {
  return r.classification[0]?.rank ?? r.displayGroup[0]?.rank ?? null
}

const hasRank = (r: AsinRanks) => r.classification.length > 0 || r.displayGroup.length > 0
const key = (r: AsinRanks) => JSON.stringify([
  [...r.classification].sort((a, b) => a.id.localeCompare(b.id)).map((c) => [c.id, c.rank]),
  [...r.displayGroup].sort((a, b) => a.group.localeCompare(b.group)).map((g) => [g.group, g.rank]),
])
/** Whether two reads hold the same rank in every category (titles ignored). Pure. */
export function sameRanks(a: AsinRanks, b: AsinRanks): boolean {
  return key(a) === key(b)
}

/** One ASIN of one market the feed asks for, with the account that asks and the product its listing sells. */
export interface PlannedAsin { accountId: string | null; marketplace: string; asin: string; productId: string }
/** A listing row as the planner reads it. */
export interface PlanListing { productId: string; marketplace: string; channelConnectionId: string | null; externalListingId: string | null; aliasKey: string }

/**
 * The ASINs to read, one per account × market × ASIN. The product of an ASIN is the one its main listing (no alias)
 * sells; listings arrive ordered, so the choice is stable. Pure.
 */
export function planAsins(listings: readonly PlanListing[]): PlannedAsin[] {
  const out = new Map<string, PlannedAsin>()
  const ordered = [...listings].sort((a, b) => (a.aliasKey === '' ? 0 : 1) - (b.aliasKey === '' ? 0 : 1))
  for (const l of ordered) {
    const asin = text(l.externalListingId).toUpperCase()
    const marketplace = text(l.marketplace).toUpperCase()
    if (!/^[A-Z0-9]{10}$/.test(asin) || !marketplace || marketplace === 'DEFAULT') continue
    const k = `${l.channelConnectionId ?? ''}|${marketplace}|${asin}`
    if (!out.has(k)) out.set(k, { accountId: l.channelConnectionId, marketplace, asin, productId: l.productId })
  }
  return [...out.values()]
}

/** The last stored read of an ASIN in a market. */
export interface LastRead { asin: string; marketplace: string; ranks: AsinRanks; capturedAt: Date }

/** Whether a new read is stored: it has a rank, and it changed or the last stored read is a heartbeat old. Pure. */
export function shouldStore(read: AsinRanks, last: LastRead | undefined, now: Date): 'store' | 'unchanged' | 'no-rank' {
  if (!hasRank(read)) return 'no-rank'
  if (!last) return 'store'
  if (!sameRanks(read, last.ranks)) return 'store'
  return now.getTime() - last.capturedAt.getTime() >= SALES_RANK_HEARTBEAT_HOURS * HOUR_MS ? 'store' : 'unchanged'
}

const asRanks = (classification: unknown, displayGroup: unknown): AsinRanks => ({
  classification: Array.isArray(classification) ? (classification as ClassificationRank[]) : [],
  displayGroup: Array.isArray(displayGroup) ? (displayGroup as DisplayGroupRank[]) : [],
})

/** What one call of the reader answers (AmazonSpApiClient.searchCatalogSalesRanks). */
export interface BatchAnswer { success: boolean; httpStatus: number; body?: unknown; error?: string; heldOrRefused?: boolean }
export interface SalesRankFeedDeps {
  /** One call for up to 20 ASINs of one market, as one account. */
  readBatch: (accountId: string, asins: readonly string[], marketplaceId: string) => Promise<BatchAnswer>
  /** Amazon's marketplace id for a market code (the Marketplace row), or undefined when it has none. */
  marketplaceIdOf: (code: string) => Promise<string | undefined>
  /** The account a listing without one sells on (the business's Amazon account), or null when there is none. */
  defaultAccountId: () => Promise<string | null>
  now: () => Date
}

export interface SalesRankFeedResult {
  summary: string
  asins: number
  batches: number
  written: number
  unchanged: number
  noRank: number
  failedBatches: number
  skipped: number
  pruned: number
}

async function defaultDeps(): Promise<SalesRankFeedDeps> {
  const { AmazonSpApiClient } = await import('../../clients/amazon-sp-api.client.js')
  const { getAmazonRegion, amazonAccount } = await import('../../lib/amazon-sp-client.js')
  const { configuredAmazonMarketplaceId } = await import('../categories/marketplace-ids.js')
  const clients = new Map<string, Promise<InstanceType<typeof AmazonSpApiClient>>>()
  const clientOf = (accountId: string) => {
    if (!clients.has(accountId)) clients.set(accountId, getAmazonRegion(accountId).then((region) => new AmazonSpApiClient({ id: accountId, region })))
    return clients.get(accountId)!
  }
  return {
    readBatch: async (accountId, asins, marketplaceId) => (await clientOf(accountId)).searchCatalogSalesRanks(asins, marketplaceId),
    marketplaceIdOf: (code) => configuredAmazonMarketplaceId(code),
    defaultAccountId: async () => { try { return (await amazonAccount()).id } catch { return null } },
    now: () => new Date(),
  }
}

/** One run in the business the caller is in: read every live ASIN's rank, store what changed, prune old rows. */
export async function runSalesRankFeed(deps?: SalesRankFeedDeps): Promise<SalesRankFeedResult> {
  const d = deps ?? (await defaultDeps())
  const now = d.now()
  const runId = `sales-rank-${now.toISOString()}-${randomUUID().slice(0, 8)}`
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true, offerClosedAt: null, externalListingId: { not: null } },
    select: { productId: true, marketplace: true, channelConnectionId: true, externalListingId: true, aliasKey: true },
    orderBy: { id: 'asc' },
  })
  const planned = planAsins(listings)
  const result: SalesRankFeedResult = { summary: '', asins: planned.length, batches: 0, written: 0, unchanged: 0, noRank: 0, failedBatches: 0, skipped: 0, pruned: 0 }

  const fallback = planned.some((p) => !p.accountId) ? await d.defaultAccountId() : null
  const groups = new Map<string, { accountId: string; marketplace: string; items: PlannedAsin[] }>()
  for (const p of planned) {
    const accountId = p.accountId ?? fallback
    if (!accountId) { result.skipped += 1; continue }
    const k = `${accountId}|${p.marketplace}`
    if (!groups.has(k)) groups.set(k, { accountId, marketplace: p.marketplace, items: [] })
    groups.get(k)!.items.push(p)
  }

  const stoppedAccounts = new Set<string>()
  for (const group of groups.values()) {
    const marketplaceId = await d.marketplaceIdOf(group.marketplace)
    if (!marketplaceId) { result.skipped += group.items.length; continue }
    const productOf = new Map(group.items.map((i) => [i.asin, i.productId]))
    for (const batch of chunk(group.items.map((i) => i.asin))) {
      if (stoppedAccounts.has(group.accountId)) { result.skipped += batch.length; continue }
      result.batches += 1
      let answer: BatchAnswer
      try {
        answer = await d.readBatch(group.accountId, batch, marketplaceId)
      } catch (error) {
        answer = { success: false, httpStatus: 0, error: error instanceof Error ? error.message : String(error) }
      }
      if (!answer.success) {
        result.failedBatches += 1
        if (answer.heldOrRefused || answer.httpStatus === 0) stoppedAccounts.add(group.accountId)
        logger.warn('sales-rank feed: a batch failed', { marketplace: group.marketplace, asins: batch.length, httpStatus: answer.httpStatus, error: answer.error?.slice(0, 200) })
        continue
      }
      const reads = parseSalesRanks(answer.body, marketplaceId)
      // Only the last heartbeat window counts: a read older than that is stored again anyway (shouldStore).
      const lastRows = await prisma.amazonSalesRank.findMany({
        where: { marketplace: group.marketplace, asin: { in: batch }, capturedAt: { gt: new Date(now.getTime() - SALES_RANK_HEARTBEAT_HOURS * HOUR_MS) } },
        orderBy: { capturedAt: 'desc' },
        distinct: ['asin'],
        select: { asin: true, marketplace: true, classificationRanks: true, displayGroupRanks: true, capturedAt: true },
      })
      const last = new Map(lastRows.map((r) => [r.asin, { asin: r.asin, marketplace: r.marketplace, ranks: asRanks(r.classificationRanks, r.displayGroupRanks), capturedAt: r.capturedAt }]))
      const rows: Array<{ marketplace: string; asin: string; productId: string | null; classificationRanks: ClassificationRank[]; displayGroupRanks: DisplayGroupRank[]; bestRank: number | null; runId: string; capturedAt: Date }> = []
      for (const asin of batch) {
        const read = reads.get(asin) ?? { classification: [], displayGroup: [] }
        const verdict = shouldStore(read, last.get(asin), now)
        if (verdict === 'no-rank') { result.noRank += 1; continue }
        if (verdict === 'unchanged') { result.unchanged += 1; continue }
        rows.push({ marketplace: group.marketplace, asin, productId: productOf.get(asin) ?? null, classificationRanks: read.classification, displayGroupRanks: read.displayGroup, bestRank: bestRankOf(read), runId, capturedAt: now })
      }
      if (rows.length) {
        await prisma.amazonSalesRank.createMany({ data: rows as never })
        result.written += rows.length
      }
    }
  }

  const pruned = await prisma.amazonSalesRank.deleteMany({ where: { capturedAt: { lt: new Date(now.getTime() - SALES_RANK_RETENTION_DAYS * DAY_MS) } } })
  result.pruned = pruned.count
  result.summary = `asins=${result.asins} batches=${result.batches} written=${result.written} unchanged=${result.unchanged} noRank=${result.noRank} failedBatches=${result.failedBatches} skipped=${result.skipped} pruned=${result.pruned}`
  return result
}

// ── The read (the sales-rank tool) ────────────────────────────────────────────────────────────────────────────────

/** A stored read as the summariser takes it. */
export interface StoredRead { asin: string; marketplace: string; productId: string | null; ranks: AsinRanks; capturedAt: Date }

interface CategoryRank { kind: 'subcategory' | 'department'; categoryId: string; title: string; rank: number }
const categoriesOf = (r: AsinRanks): CategoryRank[] => [
  ...r.classification.map((c) => ({ kind: 'subcategory' as const, categoryId: c.id, title: c.title, rank: c.rank })),
  ...r.displayGroup.map((g) => ({ kind: 'department' as const, categoryId: g.group, title: g.title, rank: g.rank })),
]
const catKey = (c: { kind: string; categoryId: string }) => `${c.kind}:${c.categoryId}`
const dayOf = (d: Date) => d.toISOString().slice(0, 10)

/** The rank of a category in the newest read at or before `at` (reads sorted newest first), or null. */
function rankAt(reads: readonly StoredRead[], category: string, at: number): { rank: number; capturedAt: string } | null {
  for (const r of reads) {
    if (r.capturedAt.getTime() > at) continue
    const hit = categoriesOf(r.ranks).find((c) => catKey(c) === category)
    return hit ? { rank: hit.rank, capturedAt: r.capturedAt.toISOString() } : null
  }
  return null
}

/**
 * The answer of the sales-rank tool from the stored reads of one scope (one market or several): per ASIN its newest
 * ranks with their trend (now against ~24 hours and ~7 days ago: lower is better) and a per-day history (the best rank
 * of each day); per market and category, the best ASIN now. Pure.
 */
export function summariseSalesRank(reads: readonly StoredRead[], now: Date) {
  const sorted = [...reads].sort((a, b) => b.capturedAt.getTime() - a.capturedAt.getTime())
  const byAsin = new Map<string, StoredRead[]>()
  for (const r of sorted) {
    const k = `${r.marketplace}|${r.asin}`
    if (!byAsin.has(k)) byAsin.set(k, [])
    byAsin.get(k)!.push(r)
  }
  const asins = [...byAsin.values()].map((list) => {
    const latest = list[0]
    const categories = categoriesOf(latest.ranks).map((c) => {
      const k = catKey(c)
      const day = rankAt(list, k, now.getTime() - DAY_MS)
      const week = rankAt(list, k, now.getTime() - 7 * DAY_MS)
      const history = new Map<string, number>()
      for (const r of list) {
        const hit = categoriesOf(r.ranks).find((x) => catKey(x) === k)
        if (!hit) continue
        const dkey = dayOf(r.capturedAt)
        history.set(dkey, Math.min(history.get(dkey) ?? Number.POSITIVE_INFINITY, hit.rank))
      }
      return {
        kind: c.kind, categoryId: c.categoryId, title: c.title, rank: c.rank,
        rank24hAgo: day?.rank ?? null, change24h: day ? day.rank - c.rank : null,
        rank7dAgo: week?.rank ?? null, change7d: week ? week.rank - c.rank : null,
        history: [...history.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, best]) => ({ date, best })),
      }
    })
    return { asin: latest.asin, marketplace: latest.marketplace, productId: latest.productId, capturedAt: latest.capturedAt.toISOString(), reads: list.length, categories }
  })
  const best = new Map<string, { marketplace: string; kind: string; categoryId: string; title: string; rank: number; asin: string; productId: string | null; capturedAt: string; change24h: number | null; change7d: number | null }>()
  for (const a of asins) {
    for (const c of a.categories) {
      const k = `${a.marketplace}|${catKey(c)}`
      const cur = best.get(k)
      if (!cur || c.rank < cur.rank) best.set(k, { marketplace: a.marketplace, kind: c.kind, categoryId: c.categoryId, title: c.title, rank: c.rank, asin: a.asin, productId: a.productId, capturedAt: a.capturedAt, change24h: c.change24h, change7d: c.change7d })
    }
  }
  return {
    bestPerCategory: [...best.values()].sort((a, b) => a.marketplace.localeCompare(b.marketplace) || (a.kind === b.kind ? a.rank - b.rank : a.kind === 'subcategory' ? -1 : 1)),
    asins: asins.sort((a, b) => a.marketplace.localeCompare(b.marketplace) || ((a.categories[0]?.rank ?? Infinity) - (b.categories[0]?.rank ?? Infinity))),
  }
}

/**
 * The stored reads of a scope over the last `days`: product ids (a family's), one ASIN, or — neither — every ASIN of the
 * business; optionally one market. A read of a deleted product is left out (MCP.12: a deleted product is not found).
 */
export async function loadSalesRankReads(scope: { productIds?: readonly string[]; asin?: string; market?: string; days: number; now: Date }): Promise<StoredRead[]> {
  const since = new Date(scope.now.getTime() - scope.days * DAY_MS)
  const rows = await prisma.amazonSalesRank.findMany({
    where: {
      capturedAt: { gte: since },
      ...(scope.market ? { marketplace: scope.market } : {}),
      ...(scope.asin ? { asin: scope.asin } : scope.productIds ? { productId: { in: [...scope.productIds] } } : {}),
    },
    orderBy: { capturedAt: 'desc' },
    take: 20_000,
    select: { asin: true, marketplace: true, productId: true, classificationRanks: true, displayGroupRanks: true, capturedAt: true },
  })
  const productIds = [...new Set(rows.map((r) => r.productId).filter((id): id is string => !!id))]
  const deleted = productIds.length
    ? new Set((await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: { not: null } }, select: { id: true } })).map((p) => p.id))
    : new Set<string>()
  return rows
    .filter((r) => !r.productId || !deleted.has(r.productId))
    .map((r) => ({ asin: r.asin, marketplace: r.marketplace, productId: r.productId, ranks: asRanks(r.classificationRanks, r.displayGroupRanks), capturedAt: r.capturedAt }))
}

/** The newest read the business holds at all (any ASIN), to say when the feed last ran when a scope has none. */
export async function newestSalesRankRead(): Promise<Date | null> {
  const row = await prisma.amazonSalesRank.findFirst({ orderBy: { capturedAt: 'desc' }, select: { capturedAt: true } })
  return row?.capturedAt ?? null
}
