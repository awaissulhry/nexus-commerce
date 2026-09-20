/**
 * P3.2 (docs/channel-connections/FINAL-PLAN.md section 6, row P3.2) — every channel
 * error lands on its listing.
 *
 * Done when: *a rejected change shows on the listing within one minute, in the
 * channel's words.*
 *
 * ## What was measured first (2026-09-20)
 *
 * `ListingIssue` held **0 rows**, in a database with 1,003 ChannelListings and 469,462
 * stored outbound calls. Only two things had ever written it — the cockpit publish
 * pre-check and the preflight report — and both write source `validation-preview`.
 * Nothing carried a real channel *rejection* to a listing, on any channel.
 *
 * Meanwhile the 25 stored `AmazonFlatFileFeedJob` rows hold **140 real Amazon
 * rejections on 48 real SKUs**, in Amazon's own Italian, sitting in a JSON column that
 * nothing joins to a listing. The flat-file grid already reads open `ListingIssue` rows
 * to draw its per-row health chip (flat-file.service.ts) — so that chip has been
 * reading an empty table since it was written.
 *
 * This module is the join that was missing. It is deliberately the ONLY writer besides
 * the pre-check: one place that knows how to turn a channel's answer into a row, so a
 * sixth connector is a mapping, not another copy of the lifecycle.
 *
 * ## Three things it has to get right
 *
 * 1. **The attribute.** `ListingIssue`'s identity is `code + sorted attributeNames`.
 *    Amazon sends `attributeNames: []` on all 140 real rejections, so without the
 *    P3.2 extractor five distinct "X is required but missing" issues on one SKU share
 *    the fingerprint `90220::` — 140 real issues collapse to 60 rows and 80 vanish.
 *    `resolveIssueAttributes` is the shared accessor; see channel-issue-attributes.ts.
 *
 * 2. **Merge, not replace.** A JSON_LISTINGS_FEED is PARTIAL_UPDATE by default, so its
 *    report speaks only about the attributes that feed carried. Resolving everything
 *    else under the same source would close an issue this feed never mentioned.
 *
 * 3. **Never block the write.** An issue row is a report about a channel call, not part
 *    of it. Every entry point here swallows its own failure and logs — a listing that
 *    published fine must not fail because we could not file a note about it.
 */
import type { PrismaClient } from '@prisma/client'
import prismaDefault from '../db.js'
import { logger } from '../utils/logger.js'
import { resolveIssueAttributes } from './channel-issue-attributes.js'
import { normalizeMarketplaceCode } from '../utils/marketplace-code.js'
import { mirrorListingIssues, type MirrorIssueInput, type MirrorMode } from './listing-issues.service.js'
import type { ChannelVerdict } from './gateway/vocabulary.js'
import type { PerSkuResult } from './feed-report-types.js'

/** Who produced the issue. Scopes the resolve sweep — one source never closes another's. */
export type IssueSource =
  | 'listings-api'
  | 'validation-preview'
  | 'amazon-feed'
  | 'amazon-suppression'
  | 'amazon-notification'
  | 'ebay-write'
  | 'ebay-feed'
  | 'shopify-write'

/** Sources whose report is the listing's CURRENT full state. Everything else is partial. */
const REPLACE_SOURCES: ReadonlySet<IssueSource> = new Set<IssueSource>([
  'listings-api',
  'validation-preview',
  'amazon-suppression',
])

const modeFor = (source: IssueSource): MirrorMode =>
  REPLACE_SOURCES.has(source) ? 'replace' : 'merge'

/** Our three-level severity from whatever the channel called it. */
function severityFrom(raw: string | null | undefined): string {
  const s = String(raw ?? '').toUpperCase()
  if (s === 'WARNING' || s === 'WARN') return 'WARNING'
  if (s === 'INFO' || s === 'INFORMATIONAL') return 'INFO'
  return 'ERROR'
}

/** Amazon's messages run long; the column is text but the UI is a row. */
const MAX_MESSAGE = 2000

export interface RecordIssuesArgs {
  listingId: string
  source: IssueSource
  issues: MirrorIssueInput[]
  /** When the channel says this was true, if that differs from now. */
  occurredAt?: Date | null
  prisma?: PrismaClient
}

/**
 * Put a set of issues on one listing. Returns the counts, or `null` if it could not be
 * written — which is logged and never thrown, because this reports on a call rather
 * than being part of one.
 */
export async function recordListingIssues(
  args: RecordIssuesArgs,
): Promise<{ open: number; resolved: number } | null> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  try {
    return await mirrorListingIssues(
      prisma,
      args.listingId,
      args.issues.map((i) => ({
        code: String(i.code ?? '').trim() || 'UNKNOWN',
        message: String(i.message ?? '').slice(0, MAX_MESSAGE),
        severity: severityFrom(i.severity),
        attributeNames: resolveIssueAttributes(i.attributeNames, i.message),
        categories: i.categories ?? [],
      })),
      args.source,
      { mode: modeFor(args.source), occurredAt: args.occurredAt ?? null },
    )
  } catch (err: any) {
    logger.warn('[listing-issues] could not record', {
      listingId: args.listingId, source: args.source, error: err?.message,
    })
    return null
  }
}

/**
 * One rejected channel call → one issue on its listing, in the channel's own words.
 *
 * This is the gateway-verdict path: eBay's bulk/feed/Trading answers and Shopify's
 * `userErrors` both arrive as a `ChannelVerdict` from P3.1's classifier, which already
 * carries the channel's code, the channel's message, the attribute and the severity.
 *
 * `retryable` verdicts are NOT filed. A 429 or a socket reset is our problem to retry,
 * not a defect in the operator's listing, and filing them would bury the four real
 * rejections under a thousand throttles.
 */
export async function recordVerdictOnListing(args: {
  listingId: string
  source: IssueSource
  verdict: ChannelVerdict
  occurredAt?: Date | null
  prisma?: PrismaClient
}): Promise<{ open: number; resolved: number } | null> {
  const { verdict } = args
  if (verdict.retryable) return null
  return recordListingIssues({
    listingId: args.listingId,
    source: args.source,
    occurredAt: args.occurredAt ?? null,
    prisma: args.prisma,
    issues: [{
      code: verdict.channelCode != null ? String(verdict.channelCode) : verdict.errorClass,
      message: verdict.channelMessage ?? verdict.errorClass,
      severity: verdict.severity === 'warning' ? 'WARNING' : 'ERROR',
      attributeNames: verdict.attribute ? [verdict.attribute] : [],
      categories: [verdict.errorClass],
    }],
  })
}

/** A per-SKU feed result mapped onto the mirror's shape. */
function issuesFromPerSku(row: PerSkuResult): MirrorIssueInput[] {
  return (row.issues ?? []).map((i) => ({
    code: i.code,
    message: i.message,
    severity: i.severity,
    attributeNames: resolveIssueAttributes(i.attributeNames, i.message),
    categories: i.category ? [i.category] : [],
  }))
}

export interface RecordFeedIssuesArgs {
  /** The per-SKU breakdown the feed-report parser produced. */
  perSku: PerSkuResult[]
  /** Which Amazon marketplace this feed went to — 'IT', 'DE', … */
  marketplace: string
  /** The feed's own completion time; the as-of an operator judges their fix against. */
  occurredAt?: Date | null
  source?: IssueSource
  channel?: string
  prisma?: PrismaClient
}

/**
 * A finished feed report → issues on each rejected SKU's listing.
 *
 * The join is SKU → Product → the ChannelListing for this channel+marketplace. It is
 * done in ONE query for the whole feed rather than per SKU: the P1.3 follow-up was
 * exactly this defect on the claim check, caught by the profiles-ON gate, and a feed
 * can carry hundreds of SKUs.
 *
 * Returns what happened, including the SKUs it could not place — a SKU with no listing
 * on this marketplace is a real answer worth logging, not a silent skip.
 */
export async function recordFeedReportIssues(
  args: RecordFeedIssuesArgs,
): Promise<{ listings: number; issues: number; unmatchedSkus: string[] }> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  const source = args.source ?? 'amazon-feed'
  const channel = args.channel ?? 'AMAZON'
  const rejected = (args.perSku ?? []).filter((r) => (r.issues ?? []).length > 0 && r.sku)
  if (rejected.length === 0) return { listings: 0, issues: 0, unmatchedSkus: [] }

  const skus = [...new Set(rejected.map((r) => String(r.sku)))]

  // One query for the whole feed. The model API (never $queryRawUnsafe) so the scoping
  // client applies the business profile — raw SQL is invisible to it and would read
  // zero rows while the listing sat right there.
  let listings: Array<{ id: string; product: { sku: string } }> = []
  try {
    listings = await prisma.channelListing.findMany({
      where: { channel, marketplace: args.marketplace, product: { sku: { in: skus } } },
      select: { id: true, product: { select: { sku: true } } },
    }) as Array<{ id: string; product: { sku: string } }>
  } catch (err: any) {
    logger.warn('[listing-issues] feed report: could not resolve listings', {
      marketplace: args.marketplace, skus: skus.length, error: err?.message,
    })
    return { listings: 0, issues: 0, unmatchedSkus: skus }
  }

  // A SKU can hold MORE THAN ONE listing on the same channel and marketplace — a second
  // account's alias row is exactly that shape (see the P1.3 fixture). Keying a Map by
  // SKU would keep the last one and drop the rest, so the rejection lands on every
  // listing that carries the SKU.
  const listingsBySku = new Map<string, string[]>()
  for (const l of listings) {
    const arr = listingsBySku.get(l.product.sku) ?? []
    arr.push(l.id)
    listingsBySku.set(l.product.sku, arr)
  }

  const unmatchedSkus: string[] = []
  let placed = 0
  let issueCount = 0

  for (const row of rejected) {
    const ids = listingsBySku.get(String(row.sku)) ?? []
    if (ids.length === 0) { unmatchedSkus.push(String(row.sku)); continue }
    const issues = issuesFromPerSku(row)
    for (const listingId of ids) {
      const result = await recordListingIssues({
        listingId, source, issues, occurredAt: args.occurredAt ?? null, prisma,
      })
      if (result) { placed++; issueCount += result.open }
    }
  }

  if (unmatchedSkus.length > 0) {
    logger.warn('[listing-issues] feed report: SKUs with no listing on this marketplace', {
      marketplace: args.marketplace, count: unmatchedSkus.length, sample: unmatchedSkus.slice(0, 5),
    })
  }
  logger.info('[listing-issues] feed report recorded', {
    marketplace: args.marketplace, listings: placed, issues: issueCount, unmatched: unmatchedSkus.length,
  })
  return { listings: placed, issues: issueCount, unmatchedSkus }
}

/**
 * Amazon suppression rows → issues on their listings.
 *
 * Suppression is a *state* Amazon reports for the whole listing, not a partial edit, so
 * this source is 'replace': a listing that is no longer suppressed has its suppression
 * issue resolved on the next run. That is what makes the scheduled job the plan row
 * asks for meaningful — without the resolve half it would only ever accumulate.
 */
export async function recordSuppressionIssues(args: {
  listingIds: string[]
  prisma?: PrismaClient
}): Promise<{ listings: number; issues: number; resolved: number }> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  const ids = [...new Set(args.listingIds.filter(Boolean))]
  if (ids.length === 0) return { listings: 0, issues: 0, resolved: 0 }

  let rows: Array<{ listingId: string; reasonCode: string | null; reasonText: string; severity: string; suppressedAt: Date | null }> = []
  try {
    rows = await prisma.amazonSuppression.findMany({
      where: { listingId: { in: ids }, resolvedAt: null },
      select: { listingId: true, reasonCode: true, reasonText: true, severity: true, suppressedAt: true },
    }) as any
  } catch (err: any) {
    logger.warn('[listing-issues] suppression: could not read', { error: err?.message })
    return { listings: 0, issues: 0, resolved: 0 }
  }

  const byListing = new Map<string, MirrorIssueInput[]>()
  const suppressedAt = new Map<string, Date | null>()
  for (const r of rows) {
    const arr = byListing.get(r.listingId) ?? []
    arr.push({
      code: r.reasonCode ?? 'SUPPRESSED',
      message: r.reasonText,
      severity: r.severity,
      attributeNames: resolveIssueAttributes([], r.reasonText),
      categories: ['suppression'],
    })
    byListing.set(r.listingId, arr)
    suppressedAt.set(r.listingId, r.suppressedAt ?? null)
  }

  let listings = 0, issues = 0, resolved = 0
  // Every listing in scope, not only the suppressed ones: a listing that came OFF
  // suppression needs its issue resolved, and it has no row to drive that from.
  for (const listingId of ids) {
    const result = await recordListingIssues({
      listingId,
      source: 'amazon-suppression',
      issues: byListing.get(listingId) ?? [],
      occurredAt: suppressedAt.get(listingId) ?? null,
      prisma,
    })
    if (!result) continue
    if (result.open > 0) listings++
    issues += result.open
    resolved += result.resolved
  }
  logger.info('[listing-issues] suppression recorded', { listings, issues, resolved })
  return { listings, issues, resolved }
}

/**
 * An Amazon `LISTINGS_ITEM_ISSUES_CHANGE` notification → issues on the listing it names.
 *
 * Amazon sends the issues it currently holds for that SKU, but only for the SKU in the
 * notification, so this is 'merge' like the feed. The notification carries its own
 * `EventTime`, which is the as-of.
 */
export async function recordNotificationIssues(args: {
  sellerSku: string
  marketplaceId: string
  issues: Array<{ code?: unknown; message?: unknown; severity?: unknown; attributeNames?: unknown }>
  occurredAt?: Date | null
  prisma?: PrismaClient
}): Promise<{ listings: number; issues: number } | null> {
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  // The canonical map — src/utils/marketplace-code.ts, normalised through by 38 call
  // sites. A second copy here is how AMEN7PMS3EDWL was Ireland in one file and
  // Belgium in four others for months; there is exactly one map.
  const marketplace = normalizeMarketplaceCode(args.marketplaceId, '')
  if (!marketplace) {
    logger.warn('[listing-issues] notification: unknown marketplaceId', { marketplaceId: args.marketplaceId })
    return null
  }
  let listing: { id: string } | null = null
  try {
    listing = await prisma.channelListing.findFirst({
      where: { channel: 'AMAZON', marketplace, product: { sku: args.sellerSku } },
      select: { id: true },
    })
  } catch (err: any) {
    logger.warn('[listing-issues] notification: lookup failed', { sku: args.sellerSku, error: err?.message })
    return null
  }
  if (!listing) return { listings: 0, issues: 0 }

  const result = await recordListingIssues({
    listingId: listing.id,
    source: 'amazon-notification',
    occurredAt: args.occurredAt ?? null,
    prisma,
    issues: (args.issues ?? []).map((i) => ({
      code: String(i.code ?? 'UNKNOWN'),
      message: String(i.message ?? ''),
      severity: String(i.severity ?? 'ERROR'),
      attributeNames: resolveIssueAttributes(i.attributeNames, String(i.message ?? '')),
      categories: [],
    })),
  })
  return result ? { listings: 1, issues: result.open } : null
}

