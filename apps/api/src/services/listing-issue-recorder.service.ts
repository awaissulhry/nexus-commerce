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
  /**
   * Sheet publish parity, step 2 — the EXACT listings each sent SKU belongs to, taken from the publication's own
   * journal (the sent seller SKU → its ChannelListing ids). When given, the SKU → Product → listing join is NOT used:
   * that join matches the PRODUCT's SKU on the channel and marketplace, so it reaches another account's listing, another
   * alias, and misses an alias's own seller SKU. A SKU absent from the map is reported as unmatched.
   */
  listingIdsBySku?: ReadonlyMap<string, readonly string[]>
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

  if (args.listingIdsBySku) {
    return placeOnListings(prisma, rejected, args.listingIdsBySku, source, args.marketplace, args.occurredAt ?? null)
  }

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

/** The exact-listing half of `recordFeedReportIssues`: every rejected SKU onto the listings the caller named. */
async function placeOnListings(
  prisma: PrismaClient,
  rejected: PerSkuResult[],
  listingIdsBySku: ReadonlyMap<string, readonly string[]>,
  source: IssueSource,
  marketplace: string,
  occurredAt: Date | null,
): Promise<{ listings: number; issues: number; unmatchedSkus: string[] }> {
  const unmatchedSkus: string[] = []
  let placed = 0
  let issueCount = 0
  for (const row of rejected) {
    const ids = listingIdsBySku.get(String(row.sku)) ?? []
    if (ids.length === 0) { unmatchedSkus.push(String(row.sku)); continue }
    const issues = issuesFromPerSku(row)
    for (const listingId of ids) {
      const result = await recordListingIssues({ listingId, source, issues, occurredAt, prisma })
      if (result) { placed++; issueCount += result.open }
    }
  }
  if (unmatchedSkus.length > 0) {
    logger.warn('[listing-issues] feed report: SKUs with no listing in the publication journal', {
      marketplace, count: unmatchedSkus.length, sample: unmatchedSkus.slice(0, 5),
    })
  }
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


/* ────────────────────────────────────────────────────────────────────────── */
/*  P4.1 — every eBay Trading rejection reaches its listing                    */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The listings an eBay Trading call is about, resolved from the call itself.
 *
 * ## What was measured (2026-09-20)
 *
 * P3.2 built the whole path — `callTradingApi` accepts `ctx.listingId`, uses it,
 * and is tested — and left it to the callers to supply one. The handover recorded
 * that two callers still did not. **A derived census of the source says 14 write
 * call sites across 12 files, and NOT ONE of them passes a listingId.** (One of
 * the two the handover named, `ebay-shared-fanout.service.ts`, makes no Trading
 * call at all.) So every real eBay rejection has been reaching the ledger and
 * never the listing, on every write path, since P3.2 shipped.
 *
 * Editing fourteen call sites would fix it until the fifteenth is written. The
 * rule belongs where every eBay write already passes, so this resolves the
 * listing from what the call ALREADY carries: the `<ItemID>` in its request and
 * the account in its context.
 *
 * ## The three rules it has to get right
 *
 * 1. **A named listing wins.** If the caller says which listing this is about, we
 *    use it and never look anything up. Explicit beats inference — a caller that
 *    knows more than the ItemID must not be overruled by a query.
 *
 * 2. **Never resolve without the account.** The lookup is keyed on
 *    `externalListingId` AND `channelConnectionId`. The MAP.3 ratchet refused a
 *    push for falling back to "the only connected shop"; the same mistake here
 *    would file one seller's rejection on another seller's listing.
 *
 * 3. **A shared eBay item is MANY listings, and the rejection is about all of
 *    them.** One eBay ItemID carries every product in a shared listing, so
 *    `findFirst` would file a real rejection on an arbitrary one of them and
 *    leave the rest showing a healthy listing. Every member row gets the issue.
 *
 * And a fourth that is about honesty rather than correctness: when nothing
 * resolves, that is **returned as a count**, not swallowed. "No listing is linked
 * to this ItemID" and "we did not look" must never look alike.
 */
export async function resolveEbayListingIds(args: {
  /** The ItemID in the call, taken from its request XML (a revise) or its answer (an add). */
  itemId: string | null | undefined
  /** The eBay account the call went out on. Required — never resolve without it. */
  connectionId: string | null | undefined
  /** What the caller named, if it named one. Wins outright. */
  listingId?: string | null
  prisma?: PrismaClient
}): Promise<string[]> {
  if (args.listingId) return [args.listingId]
  if (!args.itemId || !args.connectionId) return []
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  try {
    const rows = await prisma.channelListing.findMany({
      where: { channel: 'EBAY', externalListingId: args.itemId, channelConnectionId: args.connectionId },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  } catch (err: any) {
    logger.warn('[listing-issues] could not resolve the eBay listing', {
      itemId: args.itemId, connectionId: args.connectionId, error: err?.message,
    })
    return []
  }
}

/** The `<ItemID>` a Trading request or answer names, if it names one. */
export function itemIdOfTradingXml(xml: string | null | undefined): string | null {
  const found = /<ItemID>([^<]+)<\/ItemID>/.exec(String(xml ?? ''))?.[1]?.trim()
  return found && /^\d+$/.test(found) ? found : null
}

/**
 * One rejected eBay Trading write → an issue on every listing it is about.
 *
 * Returns the number of listings written and the number of issues opened, so a
 * caller (and the guard) can tell "filed on none" from "never asked".
 */
export async function recordEbayTradingRejection(args: {
  itemId: string | null | undefined
  connectionId: string | null | undefined
  listingId?: string | null
  issues: MirrorIssueInput[]
  occurredAt?: Date | null
  prisma?: PrismaClient
}): Promise<{ listings: number; issues: number }> {
  const listingIds = await resolveEbayListingIds(args)
  if (listingIds.length === 0 || args.issues.length === 0) return { listings: 0, issues: 0 }
  let issues = 0
  let listings = 0
  for (const listingId of listingIds) {
    const result = await recordListingIssues({
      listingId,
      source: 'ebay-write',
      issues: args.issues,
      occurredAt: args.occurredAt ?? null,
      prisma: args.prisma,
    })
    if (result) {
      listings++
      issues += result.open
    }
  }
  return { listings, issues }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  P4.1b — an Amazon single-item rejection reaches its listing too            */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The Amazon listing a Listings-API write is about, resolved from the call.
 *
 * ## What was measured (2026-09-20), and how the handover was wrong
 *
 * `PROGRESS.md` §3.1 item 2 said `putListingsItem` / `patchListingsItem` are
 * "**0 occurrences in `apps/api/src`** — Amazon content goes out as
 * `JSON_LISTINGS_FEED`". Measured: **28 occurrences of `putListingsItem`.**
 *
 * The "0" is true only of the SDK **operation string** (`operation:
 * 'putListingsItem'`, which appears twice, both in tests). Beside it,
 * `AmazonSpApiClient.putListingsItem()` is a real method that sends its own
 * request, and it has a **live call site** at `routes/marketplaces.routes.ts`,
 * with P1.7's `amazonContentRefusal` preview in front of it. Four more client
 * methods write content or offers the same way: `submitListingPayload`,
 * `patchListingPrice`, `patchPurchasableOffer` and `deleteListingsItem`.
 *
 * So the real gap was never "there is no producer". Amazon's `issues` array is
 * parsed, logged, and handed back to the caller — `marketplaces.routes.ts` maps
 * it straight into its HTTP response — and **nothing writes it to
 * `ListingIssue`**. The operator sees it once, in the answer to the request that
 * caused it, and never again on the listing.
 *
 * The same shape as P4.1a: the recorder exists, the issues exist, nobody joins
 * them. And the same fix: resolve centrally from what the call already carries —
 * the seller SKU and the marketplace — so a sixth write method cannot forget.
 *
 * ## The rules, and they are P4.1a's rules in Amazon's vocabulary
 *
 * 1. **A named listing wins outright**, and nothing is looked up.
 * 2. **Never resolve without the marketplace.** A SKU is listed in several
 *    marketplaces at once; `findFirst` on the SKU alone would file Italy's
 *    rejection on the German listing. `marketplaceId` is the SP-API id
 *    (`APJ6JRA9NG5V4`), and `ChannelListing.marketplace` holds the 2-letter code,
 *    so it goes through the canonical `MARKETPLACE_ID_TO_CODE` map rather than a
 *    second copy of it — two names for one fact is the shape of every drift
 *    defect here.
 * 3. **A SKU can still resolve to several listings** (different accounts, or an
 *    alias). All of them get the issue: the rejection is about the SKU in that
 *    marketplace, whoever holds it.
 * 4. **Nothing filed comes back as a COUNT**, so "no listing carries this SKU"
 *    and "we never asked" do not look alike.
 */
export async function resolveAmazonListingIds(args: {
  /** The seller SKU the write was for. */
  sku: string | null | undefined
  /** The SP-API marketplace id, or the 2-letter code. Required. */
  marketplaceId: string | null | undefined
  /** What the caller named, if it named one. Wins outright. */
  listingId?: string | null
  prisma?: PrismaClient
}): Promise<string[]> {
  if (args.listingId) return [args.listingId]
  if (!args.sku || !args.marketplaceId) return []
  // 🔴 `normalizeMarketplaceCode` NEVER returns null: an id it does not know
  // becomes the literal string `'UNKNOWN'`. Querying for that reads as a clean
  // "no listing carries this SKU" while the truth is "we could not tell which
  // marketplace this was" — and it would match any row that really does store
  // 'UNKNOWN'. The fallback is made unmistakable and refused.
  const marketplace = normalizeMarketplaceCode(args.marketplaceId, '')
  if (!marketplace) return []
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  try {
    const rows = await prisma.channelListing.findMany({
      where: { channel: 'AMAZON', marketplace, product: { sku: args.sku } },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  } catch (err: any) {
    logger.warn('[listing-issues] could not resolve the Amazon listing', {
      sku: args.sku, marketplaceId: args.marketplaceId, error: err?.message,
    })
    return []
  }
}

/**
 * One rejected Amazon Listings-API write → an issue on every listing it is about.
 *
 * `source` is `listings-api`, which is a REPLACE source: Amazon's `issues` array
 * is the listing's complete current verdict for that call, not a partial report
 * the way a PARTIAL_UPDATE feed report is. Passing an empty array therefore
 * RESOLVES the open `listings-api` issues — which is correct, and is how a fixed
 * listing stops showing a stale rejection.
 */
export async function recordAmazonListingIssues(args: {
  sku: string | null | undefined
  marketplaceId: string | null | undefined
  listingId?: string | null
  issues: MirrorIssueInput[]
  occurredAt?: Date | null
  prisma?: PrismaClient
}): Promise<{ listings: number; issues: number }> {
  const listingIds = await resolveAmazonListingIds(args)
  if (listingIds.length === 0) return { listings: 0, issues: 0 }
  let issues = 0
  let listings = 0
  for (const listingId of listingIds) {
    const result = await recordListingIssues({
      listingId,
      source: 'listings-api',
      issues: args.issues,
      occurredAt: args.occurredAt ?? null,
      prisma: args.prisma,
    })
    if (result) {
      listings++
      issues += result.open
    }
  }
  return { listings, issues }
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  P4.2b — an eBay Inventory-API offer rejection reaches its listing          */
/* ────────────────────────────────────────────────────────────────────────── */

/**
 * The eBay listing for a SKU in one market on one account.
 *
 * P4.1a resolves an eBay listing from the `<ItemID>` in a Trading call. The
 * Inventory API has no ItemID at the point it fails — an offer create that eBay
 * refuses never produced one — so the key here is the SKU, exactly as it is for
 * Amazon in `resolveAmazonListingIds`.
 *
 * The same three rules: a named listing wins, never resolve without the account,
 * and a SKU may hold several listings (a second account's alias row is that
 * shape) so all of them are returned.
 */
export async function resolveEbayListingIdsBySku(args: {
  sku: string | null | undefined
  /** The 2-letter market this offer is for. */
  marketplace: string | null | undefined
  /** The eBay account the call went out on. Required. */
  connectionId: string | null | undefined
  listingId?: string | null
  prisma?: PrismaClient
}): Promise<string[]> {
  if (args.listingId) return [args.listingId]
  if (!args.sku || !args.marketplace || !args.connectionId) return []
  const prisma = args.prisma ?? (prismaDefault as unknown as PrismaClient)
  try {
    const rows = await prisma.channelListing.findMany({
      where: {
        channel: 'EBAY',
        marketplace: args.marketplace.toUpperCase(),
        channelConnectionId: args.connectionId,
        product: { sku: args.sku },
      },
      select: { id: true },
    })
    return rows.map((r) => r.id)
  } catch (err: any) {
    logger.warn('[listing-issues] could not resolve the eBay listing by SKU', {
      sku: args.sku, marketplace: args.marketplace, error: err?.message,
    })
    return []
  }
}

/**
 * One refused eBay Inventory-API call → an issue on every listing it is about.
 *
 * ## What was measured (2026-09-20)
 *
 * `pushVariationGroup` — the Inventory-API publisher shared by the flat-file push
 * and the image publish — has **12 `results.push` sites**, and they are two
 * different kinds of thing:
 *
 *   eBay's verdicts   `inventory_item PUT 400: …`, `offer create 400: …`,
 *                     `offer update 400: …`  → a real rejection of the listing
 *   OUR validation    "No images found for this SKU", "No DE price set",
 *                     "No existing offer — run Full Publish first"
 *
 * Only the first kind belongs on a listing. P3.2's contract is *"a rejected
 * change shows on the listing **in the channel's words**"*, and our own
 * validation is not the channel's words — it already reaches the operator as a
 * per-row result in the push response. Filing it here would dress our own
 * message up as an eBay rejection.
 *
 * So this is called from the four sites that hold an eBay HTTP answer, and
 * nowhere else.
 *
 * **A retryable answer is not filed.** `classifyChannelAnswer` marks a 5xx or
 * eBay's own retry errorIds (25604, 25001) retryable, and `recordVerdictOnListing`
 * drops those — P3.1's rule, so a thousand throttles cannot bury four real
 * rejections. The same file already marks those ids `isTransientItemErr` and
 * retries them itself, so filing them would contradict its own behaviour.
 */
export async function recordEbayOfferRejection(args: {
  sku: string | null | undefined
  marketplace: string | null | undefined
  connectionId: string | null | undefined
  /** eBay's HTTP status. */
  status: number
  /** eBay's raw answer body — classified, not pasted. */
  body: string
  listingId?: string | null
  occurredAt?: Date | null
  prisma?: PrismaClient
}): Promise<{ listings: number; issues: number }> {
  try {
    const { classifyChannelAnswer } = await import('./gateway/vocabulary.js')
    const verdict = classifyChannelAnswer('EBAY', args.status, args.body ?? '')
    // P3.1 / P3.2: our problem to retry, not a defect in the operator's listing.
    if (verdict.retryable) return { listings: 0, issues: 0 }
    const listingIds = await resolveEbayListingIdsBySku(args)
    if (listingIds.length === 0) return { listings: 0, issues: 0 }
    let listings = 0
    let issues = 0
    for (const listingId of listingIds) {
      const result = await recordVerdictOnListing({
        listingId, source: 'ebay-write', verdict,
        occurredAt: args.occurredAt ?? null, prisma: args.prisma,
      })
      if (result) {
        listings++
        issues += result.open
      }
    }
    return { listings, issues }
  } catch (err: any) {
    logger.warn('[listing-issues] could not file the eBay offer rejection', {
      sku: args.sku, marketplace: args.marketplace, error: err?.message,
    })
    return { listings: 0, issues: 0 }
  }
}
