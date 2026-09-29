/**
 * MCP.9 — cross-channel read tools: what is wrong with each listing, what each channel is priced and stocked at, and
 * which listings are out of sync with their channel.
 *
 * Read-only and low risk: they read this business's own database — no marketplace call, no gateway, no queue. The
 * business is the one call-tool.ts bound; no argument names one. Each tool pages through listings in one order
 * (SKU, channel, market, id) with a keyset cursor (lib/pagination/cursor.ts) and returns `{ items, nextCursor, total? }`.
 * Nested lists and texts are capped, a page is held under a size limit, and a page that is not the last says how to
 * narrow the list.
 */

import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS, channelLabel } from '@nexus/shared/channel-label'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { isFbaCoordinate } from '../../../lib/amazon-fulfillment.js'
import {
  DEFAULT_PAGE_SIZE,
  InvalidCursorError,
  MAX_CURSOR_LENGTH,
  MAX_PAGE_SIZE,
  cursorScope,
  decodeCursor,
  encodeCursor,
  fitPage,
  pageOf,
  pageSize,
  type CursorPosition,
} from '../../../lib/pagination/cursor.js'
import type { DriftEntry, SourceClock } from '../../channel-drift.service.js'
import { AMAZON_CONTENT_SOURCE } from '../../channel-drift/amazon-content-compare.js'
import { EBAY_CONTENT_SOURCE } from '../../channel-drift/ebay-content-compare.js'
import { resolveIntendedQuantity, type IntendedResolution } from '../../sync-control-core.js'
import { loadChannelPolicies, policyFor, type PolicyMap } from '../../sync-control-policy.service.js'
import { ledgerInputs, loadSyncLedgers, type ProductLedger } from '../../stock-pool/sync-ledgers.js'
import { loadPoolSources, type PoolSource } from '../../stock-pool/pool-sources.js'
import type { AgentTool, ToolResult } from '../tool-types.js'

const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
const SEVERITIES = ['error', 'warning', 'info'] as const
type Severity = (typeof SEVERITIES)[number]
const OUT_OF_SYNC = ['channel-differs', 'push-failed', 'quantity-behind'] as const
type OutOfSync = (typeof OUT_OF_SYNC)[number]

/** Per listing: at most this many issues or channel differences, and texts cut to this length. */
const NESTED_CAP = 10
const TEXT_CAP = 300
const VALUE_CAP = 160

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const clip = (text: string, cap = TEXT_CAP) => (text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)
const money = (value: Prisma.Decimal | null | undefined) => (value == null ? null : Number(value))
/** A SKU prefix as a LIKE pattern's start: `_`, `%` and `\` stand for themselves (Prisma's startsWith does not escape). */
const likeEscaped = (text: string) => text.replace(/[\\%_]/g, '\\$&')

// ── Arguments every list shares ─────────────────────────────────────────────────────────────────────

const listFilters = {
  channel: z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only this channel'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional()
    .describe('only this marketplace code, e.g. IT or DE; GLOBAL for single-store channels such as Shopify and Etsy'),
  sku: z.string().trim().min(1).max(100).optional()
    .describe('a SKU, or the start of one: a parent SKU also matches its variants'),
  productId: z.string().trim().min(1).max(64).optional().describe('only this Nexus product id'),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
    .describe(`listings per page (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  cursor: z.string().min(1).max(MAX_CURSOR_LENGTH).optional()
    .describe('nextCursor from the previous page, with the same filters; omit it for the first page'),
}

interface ListArgs {
  channel?: string
  market?: string
  sku?: string
  productId?: string
  limit?: number
  cursor?: string
}

/** The listings a filter names: products not deleted, in this business (row-level security scopes the rest). */
function listingWhere(args: ListArgs): Prisma.ChannelListingWhereInput {
  return {
    product: { deletedAt: null, ...(args.sku ? { sku: { startsWith: likeEscaped(args.sku), mode: 'insensitive' } } : {}) },
    ...(args.productId ? { productId: args.productId } : {}),
    ...(args.channel ? { channel: args.channel } : {}),
    ...(args.market ? { marketplace: args.market } : {}),
  }
}

/**
 * The one order every list here uses (listing-issues writes the same order in SQL: afterSql). The id breaks ties, so
 * every listing has one place.
 */
const ORDER: Prisma.ChannelListingOrderByWithRelationInput[] = [
  { product: { sku: 'asc' } },
  { channel: 'asc' },
  { marketplace: 'asc' },
  { id: 'asc' },
]

const positionOf = (row: { id: string; channel: string; marketplace: string; product: { sku: string } }): CursorPosition =>
  ({ values: [row.product.sku, row.channel, row.marketplace], id: row.id })

/** A cursor's SKU, channel and market. */
function keyOf(position: CursorPosition): [string, string, string] {
  const [sku, channel, marketplace] = position.values
  if (typeof sku !== 'string' || typeof channel !== 'string' || typeof marketplace !== 'string') throw new InvalidCursorError()
  return [sku, channel, marketplace]
}

/** The listings strictly after a cursor's listing, in ORDER. */
function after(position: CursorPosition | null): Prisma.ChannelListingWhereInput {
  if (!position) return {}
  const [sku, channel, marketplace] = keyOf(position)
  return {
    OR: [
      { product: { sku: { gt: sku } } },
      { product: { sku }, channel: { gt: channel } },
      { product: { sku }, channel, marketplace: { gt: marketplace } },
      { product: { sku }, channel, marketplace, id: { gt: position.id } },
    ],
  }
}

/** A cursor belongs to one tool, one business and one set of filters (the page size may change between pages). */
function scopeOf(tool: string, args: Record<string, unknown>): string {
  const { limit: _limit, cursor: _cursor, ...filters } = args
  return cursorScope(tool, { business: workspaceIdForQuery(), ...filters })
}

/** The cursor position of a returned item: the same values as positionOf, read back from the output. */
const itemPosition = (item: { listingId: string; sku: string; channel: string; market: string }): CursorPosition =>
  ({ values: [item.sku, item.channel, item.market], id: item.listingId })

/** Said in every list tool's description. */
const PAGING = ' A page can hold fewer listings than limit to stay within a size limit: follow nextCursor for the rest.'

/** A page that is not the last says how to narrow the list, or how to go on; a page cut to the size limit says so. */
function moreHint(shown: number, total: number | null, cut: number, narrowBy: string): string {
  const count = total == null ? 'More listings may match' : `${total} listings match`
  const trimmed = cut ? ` (cut from ${shown + cut} to stay within the size limit)` : ''
  return `${count}; this page has ${shown}${trimmed}. To narrow, add ${narrowBy}; to go on, call again with cursor set to nextCursor.`
}

/** A bad cursor is a wrongly made call, said the way call-tool.ts says one; anything else is a real failure. */
async function listTool(name: string, work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof InvalidCursorError) return { ok: false, error: `${name} was called wrongly — cursor: ${error.message}` }
    throw error
  }
}

// ── Quantity: what Nexus would send, by the one core the cascade and the Sync Control view use ─────────

type QuantityMode = 'follow' | 'pinned' | 'paused' | 'paused-by-policy' | 'fba' | 'closed' | 'uncounted'

const MODE: Record<IntendedResolution['kind'], (r: IntendedResolution) => QuantityMode> = {
  FOLLOW: () => 'follow',
  PINNED: () => 'pinned',
  PAUSED: (r) => ((r as { via?: string }).via === 'POLICY' ? 'paused-by-policy' : 'paused'),
  FBA_EXCLUDED: () => 'fba',
  CLOSED: () => 'closed',
  UNCOUNTED: () => 'uncounted',
}

const QUANTITY_SELECT = {
  id: true,
  productId: true,
  channel: true,
  marketplace: true,
  listingStatus: true,
  quantity: true,
  stockBuffer: true,
  followMasterQuantity: true,
  syncPaused: true,
  offerClosedAt: true,
  fulfillmentMethod: true,
  sourceLocationCodes: true,
  channelConnectionId: true,
  product: { select: { sku: true, fulfillmentMethod: true } },
} satisfies Prisma.ChannelListingSelect

type QuantityRow = Prisma.ChannelListingGetPayload<{ select: typeof QUANTITY_SELECT }>

/**
 * The quantity this listing should advertise now (sync-control-core.ts), from the ledger it follows — its own
 * warehouses or a shared pool (sync-ledgers.ts). FBA as the cascade decides it: an Amazon listing with any FBA sign
 * (its own method, the product's, or FBA units on hand) is Amazon's to count; other channels never are.
 */
function intendedFor(row: QuantityRow, ledger: ProductLedger | undefined, policies: PolicyMap): { mode: QuantityMode; intended: number | null } {
  const isFba = row.channel === 'AMAZON' && isFbaCoordinate(row, row.product, { fbaStockQty: ledger?.fbaBucket ?? 0 })
  const r = resolveIntendedQuantity({
    channel: row.channel,
    marketplace: row.marketplace,
    isFba,
    offerClosed: !!row.offerClosedAt,
    followMasterQuantity: row.followMasterQuantity,
    syncPaused: row.syncPaused,
    pinnedQuantity: row.quantity,
    stockBuffer: row.stockBuffer ?? 0,
    channelPolicy: policyFor(policies, row.channel, row.marketplace, row.channelConnectionId),
    ...ledgerInputs(ledger, row.sourceLocationCodes ?? []),
  })
  const intended = r.kind === 'FOLLOW' || r.kind === 'PINNED' ? r.quantity : null
  return { mode: MODE[r.kind](r), intended }
}

// ── listing-issues ───────────────────────────────────────────────────────────────────────────────────

/** Readiness states that are issues, by severity (readiness-model.ts: blocked = errors, warn = warnings). */
const READINESS_STATE: Partial<Record<Severity, string>> = { error: 'blocked', warning: 'warn' }
const SEVERITY_RANK: Record<string, number> = { error: 0, warning: 1, info: 2 }
const ISSUE_FETCH = 50

interface Issue {
  from: 'status' | 'sync' | 'channel' | 'suppression' | 'validation' | 'readiness'
  severity: string
  message: string
  code?: string
  attributes?: string[]
  missing?: string[]
  since?: string | null
  pending?: string
}

const ISSUE_SELECT = {
  id: true,
  productId: true,
  channel: true,
  marketplace: true,
  channelConnectionId: true,
  aliasKey: true,
  listingStatus: true,
  externalListingId: true,
  syncStatus: true,
  lastSyncStatus: true,
  lastSyncError: true,
  lastSyncedAt: true,
  validationErrors: true,
  product: { select: { sku: true } },
} satisfies Prisma.ChannelListingSelect

/** listing-issues' filter, in SQL: the listings listingWhere names that have an issue of a wanted severity. */
function issueWhere(a: ListArgs, wanted: readonly Severity[], readinessStates: string[]): Prisma.Sql {
  const stored = wanted.map((s) => s.toUpperCase())
  const filters = [
    Prisma.sql`cl."workspaceId" = ${workspaceIdForQuery()}`,
    Prisma.sql`p."deletedAt" IS NULL`,
    ...(a.sku ? [Prisma.sql`p.sku ILIKE ${`${likeEscaped(a.sku)}%`}`] : []),
    ...(a.productId ? [Prisma.sql`cl."productId" = ${a.productId}`] : []),
    ...(a.channel ? [Prisma.sql`cl.channel = ${a.channel}`] : []),
    ...(a.market ? [Prisma.sql`cl.marketplace = ${a.market}`] : []),
  ]
  // The severities of each source, as the listing health panel reads them (listings/health.service.ts): an error or
  // suppressed status and a failed push are errors, a validation message is a warning.
  const sources = [
    Prisma.sql`EXISTS (SELECT 1 FROM "ListingIssue" i WHERE i."listingId" = cl.id AND i."resolvedAt" IS NULL AND i.severity = ANY(${stored}::text[]))`,
    Prisma.sql`EXISTS (SELECT 1 FROM "AmazonSuppression" s WHERE s."listingId" = cl.id AND s."resolvedAt" IS NULL AND s.severity = ANY(${stored}::text[]))`,
    ...(wanted.includes('error')
      ? [Prisma.sql`cl."listingStatus" IN ('ERROR', 'SUPPRESSED')`, Prisma.sql`cl."syncStatus" = 'FAILED'`, Prisma.sql`cl."lastSyncStatus" = 'FAILED'`]
      : []),
    ...(wanted.includes('warning') ? [Prisma.sql`cardinality(cl."validationErrors") > 0`] : []),
    ...(readinessStates.length
      ? [Prisma.sql`EXISTS (SELECT 1 FROM "ReadinessIndex" r WHERE r."productId" = cl."productId" AND r.channel = cl.channel
          AND r.market = cl.marketplace AND r."accountId" IS NOT DISTINCT FROM cl."channelConnectionId"
          AND r."aliasId" IS NOT DISTINCT FROM NULLIF(cl."aliasKey", '') AND r.state = ANY(${readinessStates}::text[]))`]
      : []),
  ]
  return Prisma.sql`${Prisma.join(filters, ' AND ')} AND (${Prisma.join(sources, ' OR ')})`
}

/** `after`, in SQL: the same order, compared as one row. */
function afterSql(position: CursorPosition | null): Prisma.Sql {
  if (!position) return Prisma.empty
  const [sku, channel, marketplace] = keyOf(position)
  return Prisma.sql`AND (p.sku, cl.channel, cl.marketplace, cl.id) > (${sku}, ${channel}, ${marketplace}, ${position.id})`
}

const listingIssues: AgentTool = {
  name: 'listing-issues',
  input: z.object({
    ...listFilters,
    severity: z.preprocess(lower, z.enum(SEVERITIES)).optional().describe('only issues of this severity'),
  }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Listings that have a problem, across every channel, with what is wrong. Sources: issues the channel reported '
    + '(Amazon listing issues, eBay and Shopify write errors), open Amazon suppressions, the listing\'s error or '
    + 'suppressed status, a failed last push, Nexus validation warnings, and publishing readiness (blocked = '
    + 'required values missing or invalid). Filter by channel, market, sku, productId or severity '
    + '(error | warning | info). Returns { items, nextCursor, total }: one item per listing, at most '
    + `${NESTED_CAP} issues each (errors first). Reads Nexus's saved state only; nothing is fetched from a channel.${PAGING}`,
  handler: (args) => listTool('listing-issues', async () => {
    const a = args as ListArgs & { severity?: Severity }
    const size = pageSize(a.limit)
    const scope = scopeOf('listing-issues', args)
    const start = decodeCursor(scope, a.cursor)
    const wanted: readonly Severity[] = a.severity ? [a.severity] : SEVERITIES
    const stored = wanted.map((s) => s.toUpperCase())
    const readinessStates = wanted.map((s) => READINESS_STATE[s]).filter((s): s is string => Boolean(s))

    // One query picks the page, and the database does all the matching — readiness included: it lives per coordinate
    // (product, channel, market, account, alias), and EXISTS ties each listing to its own coordinate's rows however many
    // coordinates the business lists on. The page's details are then read by id.
    const where = issueWhere(a, wanted, readinessStates)
    const [[counted], picked] = await Promise.all([
      prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId" WHERE ${where}`,
      prisma.$queryRaw<Array<{ id: string; sku: string; channel: string; marketplace: string }>>`
        SELECT cl.id, p.sku, cl.channel, cl.marketplace FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
        WHERE ${where} ${afterSql(start)} ORDER BY p.sku, cl.channel, cl.marketplace, cl.id LIMIT ${size + 1}`,
    ])
    const total = Number(counted?.n ?? 0)
    const page = pageOf(picked.map((row) => ({ ...row, product: { sku: row.sku } })), size, scope, positionOf)
    const openIssue = { resolvedAt: null, severity: { in: stored } }
    const rows = page.items.length === 0 ? [] : await prisma.channelListing.findMany({
      where: { id: { in: page.items.map((row) => row.id) } },
      select: {
        ...ISSUE_SELECT,
        listingIssues: {
          where: openIssue,
          orderBy: [{ lastSeenAt: 'desc' }, { id: 'asc' }],
          take: ISSUE_FETCH,
          select: { code: true, severity: true, message: true, attributeNames: true, firstSeenAt: true },
        },
        amazonSuppressions: {
          where: openIssue,
          orderBy: [{ suppressedAt: 'desc' }, { id: 'asc' }],
          take: ISSUE_FETCH,
          select: { reasonCode: true, reasonText: true, severity: true, suppressedAt: true },
        },
        _count: { select: { listingIssues: { where: openIssue }, amazonSuppressions: { where: openIssue } } },
      },
    })
    const byId = new Map(rows.map((row) => [row.id, row]))
    const listings = page.items.map((row) => byId.get(row.id)).filter((row): row is (typeof rows)[number] => row !== undefined)

    const readiness = listings.length === 0 || readinessStates.length === 0 ? [] : await prisma.readinessIndex.findMany({
      where: {
        state: { in: readinessStates },
        OR: listings.map((l) => ({
          productId: l.productId, channel: l.channel, market: l.marketplace, accountId: l.channelConnectionId, aliasId: l.aliasKey || null,
        })),
      },
      orderBy: [{ language: 'asc' }, { id: 'asc' }],
      select: {
        productId: true, channel: true, market: true, accountId: true, aliasId: true, language: true, label: true,
        state: true, requiredFilled: true, requiredTotal: true, missing: true, pendingSince: true,
      },
    })

    const items = listings.map((l) => {
      const issues: Issue[] = []
      const failed = l.syncStatus === 'FAILED' || l.lastSyncStatus === 'FAILED'
      if (wanted.includes('error')) {
        if (l.listingStatus === 'ERROR') issues.push({ from: 'status', severity: 'error', message: 'The listing is in an error state on the channel.' })
        if (l.listingStatus === 'SUPPRESSED' && l._count.amazonSuppressions === 0) {
          issues.push({ from: 'status', severity: 'error', message: 'The channel has suppressed this listing: buyers cannot see it.' })
        }
        if (failed) {
          issues.push({ from: 'sync', severity: 'error', message: clip(l.lastSyncError ?? 'The last push failed; no reason was recorded.'), since: iso(l.lastSyncedAt) })
        }
      }
      for (const i of l.listingIssues) {
        issues.push({
          from: 'channel', severity: i.severity.toLowerCase(), code: i.code, message: clip(i.message),
          ...(i.attributeNames.length ? { attributes: i.attributeNames.slice(0, 5) } : {}), since: iso(i.firstSeenAt),
        })
      }
      for (const s of l.amazonSuppressions) {
        issues.push({ from: 'suppression', severity: s.severity.toLowerCase(), ...(s.reasonCode ? { code: s.reasonCode } : {}), message: clip(s.reasonText), since: iso(s.suppressedAt) })
      }
      if (wanted.includes('warning')) {
        for (const e of l.validationErrors) issues.push({ from: 'validation', severity: 'warning', message: clip(e) })
      }
      const own = readiness.filter((r) => r.productId === l.productId && r.channel === l.channel && r.market === l.marketplace
        && r.accountId === l.channelConnectionId && r.aliasId === (l.aliasKey || null))
      for (const r of own) {
        const missing = Array.isArray(r.missing) ? (r.missing as Array<{ field?: string; label?: string }>) : []
        issues.push({
          from: 'readiness',
          severity: r.state === 'blocked' ? 'error' : 'warning',
          message: `${r.state === 'blocked' ? 'Blocked' : 'Warnings'} for ${r.label} (${r.language}): ${r.requiredFilled} of ${r.requiredTotal} required values filled.`,
          ...(missing.length ? { missing: missing.slice(0, 8).map((m) => String(m.label ?? m.field ?? '?')) } : {}),
          ...(r.pendingSince ? { pending: 'being rebuilt after an edit: this is the previous answer' } : {}),
        })
      }
      issues.sort((x, y) => (SEVERITY_RANK[x.severity] ?? 3) - (SEVERITY_RANK[y.severity] ?? 3))
      const count = issues.length
        + Math.max(0, l._count.listingIssues - l.listingIssues.length)
        + Math.max(0, l._count.amazonSuppressions - l.amazonSuppressions.length)
      return {
        listingId: l.id,
        productId: l.productId,
        sku: l.product.sku,
        channel: l.channel,
        market: l.marketplace,
        status: l.listingStatus,
        published: !!l.externalListingId,
        issues: issues.slice(0, NESTED_CAP),
        ...(count > NESTED_CAP ? { moreIssues: count - NESTED_CAP } : {}),
      }
    })
    const fitted = fitPage({ items, nextCursor: page.nextCursor }, scope, itemPosition)
    return {
      ok: true,
      data: {
        items: fitted.items,
        nextCursor: fitted.nextCursor,
        total,
        ...(fitted.nextCursor ? { more: moreHint(fitted.items.length, total, fitted.cut, 'channel, market, sku or severity') } : {}),
      },
    }
  }),
}

// ── channel-price-stock ──────────────────────────────────────────────────────────────────────────────

const PRICE_STOCK_SELECT = {
  ...QUANTITY_SELECT,
  price: true,
  salePrice: true,
  priceOverride: true,
  followMasterPrice: true,
  pricingRule: true,
  priceAdjustmentPercent: true,
  product: { select: { sku: true, fulfillmentMethod: true, basePrice: true } },
} satisfies Prisma.ChannelListingSelect

/**
 * What a product's listings sell from. A product that sells from another business's pool has no stock of its own
 * here — its own shelves read 0 — so the pool's units are shown, named as the pool's (pool-sources.ts, the reader the
 * stock pages use). Amazon FBA units are always the business's own: they are never pooled.
 */
function stockOf(productId: string, ledger: ProductLedger | undefined, pools: Map<string, PoolSource>) {
  const pool = pools.get(productId)
  const fbaOnHand = ledger?.fbaBucket ?? 0
  if (pool || ledger?.source.kind === 'pool') {
    const lender = pool?.lenderName ?? 'another business'
    const onHand = pool?.quantity ?? ledger?.quantity ?? 0
    const available = pool?.available ?? ledger?.available ?? 0
    return {
      sellsFrom: 'pool' as const,
      lender,
      onHand,
      reserved: pool?.reserved ?? onHand - available,
      available,
      fbaOnHand,
      note: `Pooled: sells from ${lender}'s shared stock, so these are the pool's units. Its own stock in this business is 0 and is not what its listings sell.`,
    }
  }
  const onHand = ledger?.quantity ?? 0
  const available = ledger?.available ?? 0
  return {
    sellsFrom: 'own' as const,
    onHand,
    reserved: onHand - available,
    available,
    fbaOnHand,
    ...(ledger?.uncountedIsZero && ledger.ledger.length === 0
      ? { note: 'Left a shared pool and has no counted stock of its own: its listings follow 0.' }
      : {}),
  }
}

const channelPriceStock: AgentTool = {
  name: 'channel-price-stock',
  input: z.object(listFilters),
  requires: [F.listingsView, F.pricingView, F.inventoryView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Price and stock of each channel listing as Nexus holds them. Per listing: price (listed, sale, the product\'s '
    + 'master price, the override, whether it follows master, the pricing rule) and quantity (listed = what Nexus '
    + 'holds for the channel; intended = what it would send now; mode = follow | pinned | paused | paused-by-policy | '
    + 'fba | closed | uncounted), plus the product\'s stock (warehouse units on hand / reserved / available, Amazon FBA '
    + 'units). A pooled product sells from another business\'s shared stock: stock.sellsFrom = "pool" and the numbers '
    + 'are the pool\'s. Filter by channel, market, sku or productId. Returns { items, nextCursor, total }. Reads '
    + 'Nexus\'s saved state only: what the channel itself shows is in out-of-sync-listings.' + PAGING,
  handler: (args) => listTool('channel-price-stock', async () => {
    const a = args as ListArgs
    const size = pageSize(a.limit)
    const scope = scopeOf('channel-price-stock', args)
    const start = decodeCursor(scope, a.cursor)
    const base = listingWhere(a)
    const [total, rows] = await Promise.all([
      prisma.channelListing.count({ where: base }),
      prisma.channelListing.findMany({ where: { AND: [base, after(start)] }, orderBy: ORDER, take: size + 1, select: PRICE_STOCK_SELECT }),
    ])
    const page = pageOf(rows, size, scope, positionOf)
    const productIds = [...new Set(page.items.map((l) => l.productId))]
    const [ledgers, pools, policies] = await Promise.all([
      loadSyncLedgers(prisma, productIds),
      loadPoolSources(prisma, productIds),
      loadChannelPolicies(),
    ])
    const items = page.items.map((l) => {
      const ledger = ledgers.get(l.productId)
      const { mode, intended } = intendedFor(l, ledger, policies)
      return {
        listingId: l.id,
        productId: l.productId,
        sku: l.product.sku,
        channel: l.channel,
        market: l.marketplace,
        status: l.listingStatus,
        price: {
          listed: money(l.price),
          sale: money(l.salePrice),
          master: money(l.product.basePrice),
          followsMaster: l.followMasterPrice,
          override: money(l.priceOverride),
          rule: l.pricingRule,
          ...(l.pricingRule === 'PERCENT_OF_MASTER' ? { adjustPercent: money(l.priceAdjustmentPercent) } : {}),
        },
        quantity: { listed: l.quantity, intended, mode, followsStock: l.followMasterQuantity, buffer: l.stockBuffer ?? 0 },
        stock: stockOf(l.productId, ledger, pools),
      }
    })
    const fitted = fitPage({ items, nextCursor: page.nextCursor }, scope, itemPosition)
    return {
      ok: true,
      data: {
        items: fitted.items,
        nextCursor: fitted.nextCursor,
        total,
        ...(fitted.nextCursor ? { more: moreHint(fitted.items.length, total, fitted.cut, 'channel, market or sku') } : {}),
      },
    }
  }),
}

// ── out-of-sync-listings ─────────────────────────────────────────────────────────────────────────────

type Aspect = 'quantity' | 'price' | 'content'
const ASPECTS: readonly Aspect[] = ['quantity', 'price', 'content']

/**
 * Every read-back that records what a channel holds into ChannelDrift (the callers of `recordChannelReadback`), and
 * what each compares. channel.tools.vitest.test.ts fails when a writer's source is missing here. An aspect no source of
 * a channel covers is never checked on that channel: the tool says "not checked", never "in sync".
 */
export const READ_BACKS: Readonly<Record<string, { channel: string; covers: readonly Aspect[]; label: string; skipsQuantity?: readonly QuantityMode[] }>> = {
  'amazon-merchant-listings-report': { channel: 'AMAZON', covers: ['quantity', 'price'], label: "Amazon's merchant listings report" },
  [AMAZON_CONTENT_SOURCE]: { channel: 'AMAZON', covers: ['content'], label: 'Amazon listing content' },
  'ebay-trading-getitem': { channel: 'EBAY', covers: ['quantity'], label: 'eBay GetItem' },
  [EBAY_CONTENT_SOURCE]: { channel: 'EBAY', covers: ['content'], label: 'eBay item content' },
  // Its quantity arm skips a pinned listing too, not only the modes that send no quantity (shopify/quantity-readback.service.ts).
  'shopify-inventory-level': { channel: 'SHOPIFY', covers: ['quantity', 'price'], label: 'Shopify inventory level', skipsQuantity: ['pinned'] },
}

/** Why an aspect is never checked on a channel, where a plain "not read back" would not say enough. */
const GAP_REASON: Readonly<Record<string, string>> = {
  'EBAY:price': 'not checked: eBay prices are compared only into a product-level health log, never per listing',
}

function gapReason(channel: string, aspect: Aspect): string {
  return GAP_REASON[`${channel}:${aspect}`] ?? `not checked: ${channelLabel(channel)} ${aspect} is not read back into Nexus`
}

/** The aspects each channel's read-backs cover. */
export function coveredAspects(channel: string): Aspect[] {
  return ASPECTS.filter((aspect) => Object.values(READ_BACKS).some((r) => r.channel === channel && r.covers.includes(aspect)))
}

/** The fixed gaps, per channel in scope: what this tool can never report as differing there. */
function neverChecked(channels: readonly string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (const channel of channels) {
    const gaps = ASPECTS.filter((aspect) => !coveredAspects(channel).includes(aspect))
    if (gaps.length) out[channel] = Object.fromEntries(gaps.map((aspect) => [aspect, gapReason(channel, aspect)]))
  }
  return out
}

/** A differing value, short: long text and objects (content, attributes) are cut. */
function shortValue(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value ?? null
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return clip(text, VALUE_CAP)
}

const aspectOf = (source: string, field: string): Aspect | null => {
  const covers = READ_BACKS[source]?.covers ?? []
  if (covers.length === 1) return covers[0]
  if (field === 'price') return 'price'
  if (field === 'quantity' || field.startsWith('quantity:')) return 'quantity'
  return null
}

const SYNC_SELECT = {
  ...QUANTITY_SELECT,
  externalListingId: true,
  syncStatus: true,
  lastSyncStatus: true,
  lastSyncError: true,
  lastSyncedAt: true,
  channelDrifts: {
    take: 1,
    select: { driftCount: true, driftedFields: true, lastCheckedAt: true, checkedBySource: true },
  },
} satisfies Prisma.ChannelListingSelect

type SyncRow = Prisma.ChannelListingGetPayload<{ select: typeof SYNC_SELECT }>

/** One listing's sync picture: why it is out of sync (empty = nothing found), and what was and was not checked. */
function syncView(row: SyncRow, ledger: ProductLedger | undefined, policies: PolicyMap) {
  const { mode, intended } = intendedFor(row, ledger, policies)
  const drift = row.channelDrifts[0] ?? null
  const entries = (Array.isArray(drift?.driftedFields) ? drift!.driftedFields : []) as unknown as DriftEntry[]
  const clocks = (drift?.checkedBySource && typeof drift.checkedBySource === 'object' && !Array.isArray(drift.checkedBySource)
    ? drift.checkedBySource : {}) as Record<string, Partial<SourceClock> | undefined>

  const reasons: OutOfSync[] = []
  if ((drift?.driftCount ?? 0) > 0) reasons.push('channel-differs')
  if (row.syncStatus === 'FAILED' || row.lastSyncStatus === 'FAILED') reasons.push('push-failed')
  if (mode === 'follow' && intended !== row.quantity) reasons.push('quantity-behind')

  // Every source that looked at this listing: its own clock, or (a row written before clocks) its entries.
  const sources = new Set([...Object.keys(clocks), ...entries.map((e) => e?.source).filter((s): s is string => typeof s === 'string')])
  const readBack = [...sources].sort().map((source) => {
    const clock = clocks[source]
    const at = clock?.at ?? entries.filter((e) => e.source === source).map((e) => e.checkedAt).sort().at(-1) ?? null
    const outcome = clock?.outcome === 'not_compared' ? 'could not compare' : 'compared'
    return {
      by: READ_BACKS[source]?.label ?? source,
      covers: READ_BACKS[source]?.covers ?? [],
      at,
      outcome,
      ...(clock?.outcome === 'not_compared' && clock.reason ? { reason: clip(clock.reason, VALUE_CAP) } : {}),
    }
  })

  const notChecked: Partial<Record<Aspect, string>> = {}
  for (const aspect of ASPECTS) {
    if (!coveredAspects(row.channel).includes(aspect)) { notChecked[aspect] = gapReason(row.channel, aspect); continue }
    if (aspect === 'quantity' && mode !== 'follow' && mode !== 'pinned') {
      notChecked.quantity = mode === 'fba'
        ? 'not checked: Amazon holds FBA stock, so its quantity is never compared'
        : `not checked: Nexus sends no quantity while the listing is ${mode}, so none is compared`
      continue
    }
    const covering = [...sources].filter((s) => READ_BACKS[s]?.covers.includes(aspect))
    const skipping = aspect === 'quantity' ? covering.filter((s) => READ_BACKS[s]?.skipsQuantity?.includes(mode)) : []
    const looked = covering.filter((s) => !skipping.includes(s))
    if (looked.length === 0) {
      notChecked[aspect] = skipping.length
        ? `not checked: ${READ_BACKS[skipping[0]].label} skips a ${mode} quantity`
        : 'not checked yet: no read-back has looked at this listing'
      continue
    }
    if (looked.every((s) => clocks[s]?.outcome === 'not_compared')) {
      notChecked[aspect] = `not checked: the last read could not compare (${clip(clocks[looked[0]]?.reason ?? 'no reason recorded', VALUE_CAP)})`
    }
  }

  const differs = entries.slice(0, NESTED_CAP).map((e) => ({
    field: e.field,
    aspect: aspectOf(e.source, e.field),
    nexus: shortValue(e.ours),
    channel: shortValue(e.theirs),
    found: e.checkedAt ?? null,
  }))
  return { reasons, mode, intended, drift, differs, readBack, notChecked }
}

/** Listings on a channel now: published, not ended, and not a draft that was never sent. */
const LIVE: Prisma.ChannelListingWhereInput = {
  isPublished: true,
  listingStatus: { notIn: ['ENDED', 'REMOVED'] },
  NOT: { listingStatus: 'DRAFT', externalListingId: null },
}

/** Listings read per batch, and at most this many per call before the tool hands back a cursor to go on. */
const SYNC_SCAN_BATCH = 250
export const SYNC_SCAN_BUDGET = 1000

const outOfSyncListings: AgentTool = {
  name: 'out-of-sync-listings',
  input: z.object({
    ...listFilters,
    reason: z.preprocess(lower, z.enum(OUT_OF_SYNC)).optional()
      .describe('only listings out of sync for this reason: channel-differs | push-failed | quantity-behind'),
  }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Live listings that are out of sync, and why: channel-differs (a read-back found the channel holding a different '
    + 'quantity, price or content than Nexus), push-failed (the last push to the channel failed), quantity-behind '
    + '(the listing still holds a quantity other than the one Nexus would send now). What is read back: Amazon '
    + 'quantity (never FBA stock) and price from the merchant listings report, Amazon content; eBay quantity and '
    + 'content; Shopify quantity and price. NOT read back, so never reported as differing: eBay price per listing, '
    + 'Shopify content, anything on Etsy or WooCommerce. Each item lists readBack (what looked, when) and notChecked '
    + '(what nobody compared, and why): a listing absent from this list is not proven in sync. Filter by channel, '
    + 'market, sku, productId or reason. Returns { items, nextCursor }; a call checks at most '
    + `${SYNC_SCAN_BUDGET} listings, so a short page with a nextCursor means "keep going".${PAGING}`,
  handler: (args) => listTool('out-of-sync-listings', async () => {
    const a = args as ListArgs & { reason?: OutOfSync }
    const size = pageSize(a.limit)
    const scope = scopeOf('out-of-sync-listings', args)
    let position = decodeCursor(scope, a.cursor)
    // Two of the three reasons are columns: when asked for one of them, only its listings are read.
    const byReason: Prisma.ChannelListingWhereInput = a.reason === 'channel-differs'
      ? { channelDrifts: { some: { driftCount: { gt: 0 } } } }
      : a.reason === 'push-failed' ? { OR: [{ syncStatus: 'FAILED' }, { lastSyncStatus: 'FAILED' }] } : {}
    const base: Prisma.ChannelListingWhereInput = { AND: [listingWhere(a), LIVE, byReason] }
    const policies = await loadChannelPolicies()

    // Whether a listing's quantity is behind is known only after working out its intended quantity, so listings are
    // read in order, batch by batch, until one listing more than a page is found, the list ends, or the budget is spent.
    const found: Array<{ row: SyncRow; view: ReturnType<typeof syncView> }> = []
    let scanned = 0
    let ended = false
    while (found.length <= size && scanned < SYNC_SCAN_BUDGET) {
      const take = Math.min(SYNC_SCAN_BATCH, SYNC_SCAN_BUDGET - scanned)
      const batch = await prisma.channelListing.findMany({ where: { AND: [base, after(position)] }, orderBy: ORDER, take, select: SYNC_SELECT })
      const ledgers = batch.length ? await loadSyncLedgers(prisma, batch.map((r) => r.productId)) : new Map<string, ProductLedger>()
      for (const row of batch) {
        scanned++
        position = positionOf(row)
        const view = syncView(row, ledgers.get(row.productId), policies)
        if (view.reasons.length && (!a.reason || view.reasons.includes(a.reason))) found.push({ row, view })
        if (found.length > size) break
      }
      if (found.length > size) break
      if (batch.length < take) {
        ended = true
        break
      }
    }

    const page = found.slice(0, size)
    const full = found.length > size
    const nextCursor = full
      ? encodeCursor(scope, positionOf(page.at(-1)!.row))
      : ended || !position ? null : encodeCursor(scope, position)
    const items = page.map(({ row, view }) => ({
      listingId: row.id,
      productId: row.productId,
      sku: row.product.sku,
      channel: row.channel,
      market: row.marketplace,
      status: row.listingStatus,
      reasons: view.reasons,
      quantity: { listed: row.quantity, intended: view.intended, mode: view.mode },
      push: view.reasons.includes('push-failed')
        ? { status: 'FAILED', error: clip(row.lastSyncError ?? 'no reason was recorded'), at: iso(row.lastSyncedAt) }
        : { status: row.lastSyncStatus ?? row.syncStatus, at: iso(row.lastSyncedAt) },
      differs: view.differs,
      ...((view.drift?.driftCount ?? 0) > view.differs.length ? { moreDiffers: view.drift!.driftCount - view.differs.length } : {}),
      readBack: view.readBack,
      notChecked: view.notChecked,
    }))
    const fitted = fitPage({ items, nextCursor }, scope, itemPosition)
    const channels = a.channel ? [a.channel] : CHANNELS
    return {
      ok: true,
      data: {
        items: fitted.items,
        nextCursor: fitted.nextCursor,
        ...(fitted.nextCursor
          ? { more: full || fitted.cut ? moreHint(fitted.items.length, null, fitted.cut, 'channel, market, sku or reason')
            : `Checked ${scanned} listings from where this call started; more remain. Call again with cursor set to nextCursor to keep looking.` }
          : {}),
        neverChecked: neverChecked(channels),
        caveat: 'A read-back compares a field only when both Nexus and the channel hold a value, and records when it '
          + 'last looked. No difference listed is what the last read found, never a guarantee about the channel now.',
      },
    }
  }),
}

export const CHANNEL_TOOLS: AgentTool[] = [listingIssues, channelPriceStock, outOfSyncListings]
