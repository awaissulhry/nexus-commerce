/**
 * MCP full control 08 S7 — Sync Control for Claude: the stock mode of many listings at once, and the policies and
 * location feeds the stock sync follows. Both run the page's own code (services/stock/sync-control-actions.service.ts)
 * after a person approves them in Nexus.
 *
 *   bulk-listing-stock  follow the stock, a fixed number (pin), zero & pin, hold / release the stock sync, a buffer — on listings; and
 *                       exclude, include, a fixed number, follow, a buffer — on shared eBay variants. At most 250 rows.
 *   set-stock-policy    a channel's or market's (or one account's) stock-sync hold and the mode a new listing starts in; or
 *                       the channels and markets one location's stock feeds.
 *
 * What a person meets on the page holds for Claude, and four rules are held here before anything is queued:
 *   - Amazon keeps ONE merchant quantity per SKU for every EU market: a quantity action (follow, pin, zero & pin, buffer)
 *     on an Amazon EU market covers every open EU market of that SKU and account — ONE "EU" cell in the preview. The page
 *     asks the same consent with its 409; the person's approval is that consent (`expandEuAligned`).
 *   - A fixed number on a SKU that sells from another business's shared stock is refused: its quantity follows that
 *     stock (the database refuses it too, nexus_stock_pool_quantity_guard).
 *   - A pin to 0 on eBay is refused unless the account's out-of-stock option is ON (eBay would END the listing) — the
 *     Matrix's own check (L8, `ebayZeroAllowedFor`, the same sentence).
 *   - Amazon FBA quantity is Amazon's: a named FBA listing is refused, and a product's FBA listings are left out.
 *   - A listing whose selling is paused (Inactive: the product sheet's Pause offer, or Amazon's market close) gets no
 *     quantity: a quantity action (follow, pin, zero & pin, buffer) refuses a named one and leaves a product's out, as
 *     for FBA; the page's own service skips it too. Hold / release of the stock sync is a Nexus flag and still applies.
 * Nothing names another business: listings, products and accounts are found in the caller's business only.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { EBAY_ZERO_REFUSAL } from '@nexus/shared/matrix-preview'
import { sellingPaused } from '@nexus/shared/push-lock'
import prisma from '../../../db.js'
import { oldClosePauses } from '../../listings/listing-action.service.js'
import { AMAZON_EU_SHARED_MARKETS } from '../../amazon-eu-quantity-guard.js'
import { isFbaCoordinate } from '../../../lib/amazon-fulfillment.js'
import { pooledNow } from '../../stock-pool/pool-guard.js'
import { KNOWN_CHANNELS, validateServesTokens } from '../../sync-control-core.js'
import type { SyncControlActionBody } from '../../stock/sync-control-actions.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'

const PREVIEW_LINES = 20
const MAX_ROWS = 250
const MAX_PRODUCTS = 50
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const listed = (lines: string[]) => (lines.length > 5 ? `${lines.slice(0, 5).join('; ')}; and ${lines.length - 5} more` : lines.join('; '))
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const actorOf = (ctx: ToolContext, tool: string) => ctx.userId ?? `agent:${tool}`
/** The Sync Control service and the stock writers load lazily, as the page's routes load them: the registry stays light. */
const syncControl = () => import('../../stock/sync-control-actions.service.js')
const followMaster = () => import('../../follow-master.service.js')

type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

// ── bulk-listing-stock ────────────────────────────────────────────────────────────────────────────────

const ACTIONS = ['PAUSE', 'RESUME', 'FOLLOW', 'PIN', 'ZERO_PIN', 'BUFFER', 'EXCLUDE', 'INCLUDE'] as const
type Action = (typeof ACTIONS)[number]
/** The actions the page applies to listings, and to shared eBay variants (routes' LISTING_LANE / SHARED_LANE). */
const LISTING_LANE = new Set<Action>(['PAUSE', 'RESUME', 'FOLLOW', 'PIN', 'ZERO_PIN', 'BUFFER'])
const SHARED_LANE = new Set<Action>(['EXCLUDE', 'INCLUDE', 'BUFFER', 'PIN', 'FOLLOW'])
/** Quantity actions: on Amazon EU they are one number for every EU market (the page's EU gate). */
const EU_ACTIONS = new Set<Action>(['FOLLOW', 'PIN', 'ZERO_PIN', 'BUFFER'])
/** The actions the page's own FBA skip uses `isFbaCoordinate` for; the others skip Amazon-managed listings. */
const COORDINATE_FBA = new Set<Action>(['PAUSE', 'RESUME', 'ZERO_PIN'])
const UNTIL_ACTIONS = new Set<Action>(['PIN', 'ZERO_PIN', 'PAUSE', 'EXCLUDE'])

const VERB: Record<Action, string> = {
  PAUSE: 'Hold the stock sync of', RESUME: 'Release the stock sync of', FOLLOW: 'Follow the stock on', PIN: 'Keep a fixed number on',
  ZERO_PIN: 'Zero & pin (stop selling)', BUFFER: 'Set the buffer on', EXCLUDE: 'Exclude from the stock', INCLUDE: 'Include in the stock',
}

const LISTING_SELECT = {
  id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, listingStatus: true, isPublished: true,
  quantity: true, quantityOverride: true, followMasterQuantity: true, syncPaused: true, stockBuffer: true, fulfillmentMethod: true,
  platformAttributes: true, offerClosedAt: true, pinnedUntil: true, pausedUntil: true,
  product: { select: { sku: true, fulfillmentMethod: true, deletedAt: true } },
} as const

interface ListingRow {
  id: string; productId: string; channel: string; marketplace: string; channelConnectionId: string | null; aliasKey: string
  listingStatus: string; isPublished: boolean; quantity: number | null; quantityOverride: number | null; followMasterQuantity: boolean | null
  syncPaused: boolean; stockBuffer: number | null; fulfillmentMethod: string | null; platformAttributes: unknown; offerClosedAt: Date | null
  pinnedUntil: Date | null; pausedUntil: Date | null; product: { sku: string; fulfillmentMethod: string | null; deletedAt: Date | null } | null
}
interface SharedRow {
  id: string; itemId: string; marketplace: string; sku: string; productId: string | null; channelConnectionId: string | null
  followPool: boolean | null; pinnedQuantity: number | null; stockBuffer: number | null; lastQtyPushed: number | null
}

/** One line of the preview: a listing, ONE Amazon EU cell (every EU market of a SKU and account), or a shared variant. */
interface Cell { sku: string; channel: string; market: string; account: string | null; kind: 'listing' | 'shared variant'; from: string; to: string }

const ENDED = new Set(['ENDED', 'REMOVED'])
const INACTIVE_REASON = 'Inactive (selling is paused): Nexus sends it no quantity. Change it in the product sheet\'s Status column'
const isEu = (row: { channel: string; marketplace: string }) => row.channel === 'AMAZON' && AMAZON_EU_SHARED_MARKETS.has(row.marketplace.toUpperCase())
const euKey = (row: ListingRow) => JSON.stringify([row.productId, row.channelConnectionId, row.aliasKey])

function listingMode(row: ListingRow): string {
  const mode = row.followMasterQuantity === false ? `Fixed ${row.quantity ?? row.quantityOverride ?? '?'}` : 'Follow'
  return `${mode}${row.syncPaused ? ', sync held' : ''}${row.stockBuffer ? `, buffer ${row.stockBuffer}` : ''}`
}
function sharedMode(row: SharedRow): string {
  if (row.followPool === false) return 'Excluded'
  return `${row.pinnedQuantity == null ? 'Follow' : `Fixed ${row.pinnedQuantity}`}${row.stockBuffer ? `, buffer ${row.stockBuffer}` : ''}`
}

/** What the action makes of a listing, or null when it is already so (the page would count it unchanged). */
function listingAfter(action: Action, row: ListingRow, args: { buffer?: number; until?: Date | null }): string | null {
  const pinned = row.followMasterQuantity === false
  const endSet = args.until !== undefined
  switch (action) {
    case 'PAUSE': return row.syncPaused && !endSet ? null : `${listingMode({ ...row, syncPaused: true })}${args.until ? ` until ${args.until.toISOString()}` : ''}`
    case 'RESUME': return row.syncPaused ? listingMode({ ...row, syncPaused: false }) : null
    case 'FOLLOW': return pinned ? listingMode({ ...row, followMasterQuantity: true }) : null
    case 'PIN': return pinned && !endSet ? null : `Fixed ${row.quantity ?? row.quantityOverride ?? 'at the number it shows'}${args.until ? ` until ${args.until.toISOString()}` : ''}`
    case 'ZERO_PIN': return pinned && row.quantity === 0 && row.quantityOverride === 0 && !row.syncPaused && !endSet ? null : `Fixed 0 (stops selling)${args.until ? ` until ${args.until.toISOString()}` : ''}`
    case 'BUFFER': return (row.stockBuffer ?? 0) === args.buffer ? null : listingMode({ ...row, stockBuffer: args.buffer ?? 0 })
    default: return null
  }
}
function sharedAfter(action: Action, row: SharedRow, args: { buffer?: number; quantity?: number; until?: Date | null }): string | null {
  const endSet = args.until !== undefined
  switch (action) {
    case 'EXCLUDE': return row.followPool === false && !endSet ? null : `Excluded${args.until ? ` until ${args.until.toISOString()}` : ''}`
    case 'INCLUDE': return row.followPool === false ? sharedMode({ ...row, followPool: true }) : null
    case 'PIN': {
      const next = args.quantity ?? row.lastQtyPushed ?? 0
      return next === row.pinnedQuantity && !endSet ? null : `Fixed ${next}${args.until ? ` until ${args.until.toISOString()}` : ''}`
    }
    case 'FOLLOW': return row.pinnedQuantity == null ? null : sharedMode({ ...row, pinnedQuantity: null })
    case 'BUFFER': return (row.stockBuffer ?? 0) === args.buffer ? null : sharedMode({ ...row, stockBuffer: args.buffer ?? 0 })
    default: return null
  }
}

const bulkInput = z.object({
  action: z.preprocess(upper, z.enum(ACTIONS)).describe(
    'PAUSE (hold) or RESUME (release) a listing\'s stock sync; FOLLOW the stock; PIN a fixed number (the number it shows now; a shared eBay '
    + 'variant may take `quantity`); ZERO_PIN (fixed 0: stops selling now); BUFFER (units held back); EXCLUDE or INCLUDE a '
    + 'shared eBay variant in the stock'),
  listingIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_ROWS).optional()
    .describe('the Nexus listing ids to act on (listing-coordinates names them)'),
  productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_PRODUCTS).optional()
    .describe('Nexus product ids: every live listing of each product (a parent: its whole family) and, for EXCLUDE, INCLUDE, '
      + 'PIN, FOLLOW and BUFFER, its shared eBay variants'),
  only: z.preprocess((v) => (typeof v === 'string' ? v.trim().toLowerCase() : v), z.enum(['listings', 'shared'])).optional()
    .describe('with productIds: only their listings, or only their shared eBay variants (left out: both)'),
  channel: z.preprocess(upper, z.enum(KNOWN_CHANNELS)).optional().describe('with productIds: only this channel'),
  marketplace: z.string().trim().toUpperCase().min(2).max(20).optional().describe('with productIds: only this market, e.g. IT'),
  buffer: z.coerce.number().int().min(0).max(100_000).optional().describe('BUFFER only: the units held back from what is offered'),
  quantity: z.coerce.number().int().min(0).max(100_000).optional()
    .describe('PIN on shared eBay variants only: the fixed number (default: what eBay shows now). A listing keeps the number it shows'),
  until: z.string().trim().min(10).max(40).optional()
    .describe('PIN, ZERO_PIN, PAUSE or EXCLUDE: when it ends by itself (ISO date and time, from 1 minute to 1 year ahead)'),
})

interface BulkPlan {
  action: Action
  listings: Array<{ row: ListingRow; to: string }>
  shared: Array<{ row: SharedRow; to: string }>
  unchanged: number
  leftOut: Array<{ sku: string; channel: string; market: string; reason: string }>
  euAdded: Array<{ sku: string; markets: string[] }>
  buffer?: number
  quantity?: number
  until?: Date | null
  untilText?: string | null
  accounts: Map<string, string>
}

/** The listings and shared variants a request names, in this business, with what the action makes of each. */
async function planBulk(args: Record<string, unknown>): Promise<BulkPlan | Refusal> {
  const action = args.action as Action
  const listingIds = [...new Set((args.listingIds as string[] | undefined) ?? [])]
  const productIds = [...new Set((args.productIds as string[] | undefined) ?? [])]
  if (!listingIds.length && !productIds.length) return { error: 'Name the listings (listingIds) or the products (productIds) to act on.' }
  if (action === 'BUFFER' && args.buffer === undefined) return { error: 'BUFFER needs the number of units to hold back (buffer).' }
  if (action !== 'BUFFER' && args.buffer !== undefined) return { error: 'A buffer is given with BUFFER only.' }
  if (args.quantity !== undefined && action !== 'PIN') return { error: 'A chosen fixed number is given with PIN only, for shared eBay variants.' }
  const { parseUntil } = await syncControl()
  const untilParsed = parseUntil(args.until)
  if ('error' in untilParsed) return { error: untilParsed.error }
  const until = untilParsed.until
  if (until !== undefined && !UNTIL_ACTIONS.has(action)) return { error: 'An end time can be set with PIN, ZERO_PIN, PAUSE or EXCLUDE only.' }
  if (listingIds.length && !LISTING_LANE.has(action)) return { error: `${action} acts on shared eBay variants: name their products (productIds), not listings.` }
  const only = args.only as 'listings' | 'shared' | undefined
  const channel = args.channel as string | undefined
  const market = args.marketplace as string | undefined

  const leftOut: BulkPlan['leftOut'] = []
  const problems: string[] = []
  const listingRows = new Map<string, ListingRow>()
  const explicit = new Set<string>()

  if (listingIds.length) {
    const found = await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: LISTING_SELECT }) as unknown as ListingRow[]
    if (found.length !== listingIds.length || found.some((r) => r.product?.deletedAt)) return { error: 'Listing not found' }
    for (const row of found) {
      if (ENDED.has(row.listingStatus)) { problems.push(`${row.product?.sku ?? row.id} on ${row.channel} ${row.marketplace} has ended`); continue }
      listingRows.set(row.id, row)
      explicit.add(row.id)
    }
  }

  const shared = new Map<string, SharedRow>()
  if (productIds.length) {
    const products = await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true } })
    if (products.length !== productIds.length) return { error: PRODUCT_NOT_FOUND }
    // A parent stands for its family (the page's product-first bulk); a deleted variation never.
    const family = await prisma.product.findMany({
      where: { OR: [{ id: { in: productIds } }, { parentId: { in: productIds } }], deletedAt: null },
      select: { id: true },
    })
    const ids = family.map((p) => p.id)
    if (only !== 'shared' && LISTING_LANE.has(action)) {
      const rows = await prisma.channelListing.findMany({
        where: {
          productId: { in: ids }, isPublished: true, listingStatus: { notIn: [...ENDED] },
          ...(channel ? { channel } : {}), ...(market ? { marketplace: market } : {}),
        },
        select: LISTING_SELECT,
      }) as unknown as ListingRow[]
      for (const row of rows) listingRows.set(row.id, row)
    }
    if (only !== 'listings' && SHARED_LANE.has(action) && (!channel || channel === 'EBAY')) {
      const rows = await prisma.sharedListingMembership.findMany({
        where: { productId: { in: ids }, status: 'ACTIVE', ...(market ? { marketplace: market } : {}) },
        select: { id: true, itemId: true, marketplace: true, sku: true, productId: true, channelConnectionId: true, followPool: true, pinnedQuantity: true, stockBuffer: true, lastQtyPushed: true },
      })
      for (const row of rows) shared.set(row.id, row)
    }
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}.` }

  // Amazon EU: a quantity action covers every open EU market of the SKU on that account and alias — one EU cell.
  const euAdded: BulkPlan['euAdded'] = []
  if (EU_ACTIONS.has(action)) {
    const euRows = [...listingRows.values()].filter(isEu)
    if (euRows.length) {
      const all = await prisma.channelListing.findMany({
        where: { productId: { in: [...new Set(euRows.map((r) => r.productId))] }, channel: 'AMAZON', isPublished: true, listingStatus: { notIn: [...ENDED] } },
        select: LISTING_SELECT,
      }) as unknown as ListingRow[]
      const groups = new Set(euRows.map(euKey))
      const added = new Map<string, Set<string>>()
      for (const row of all) {
        // Never into a closed market: an EU-wide quantity action must not reopen a closed offer (the page's SCT.6 rule).
        if (!isEu(row) || !groups.has(euKey(row)) || listingRows.has(row.id) || row.offerClosedAt) continue
        listingRows.set(row.id, row)
        added.set(row.product?.sku ?? row.productId, (added.get(row.product?.sku ?? row.productId) ?? new Set()).add(row.marketplace.toUpperCase()))
      }
      for (const [sku, markets] of added) euAdded.push({ sku, markets: [...markets].sort() })
    }
  }

  // Amazon FBA: the quantity is Amazon's. The page skips these rows; a named one is refused, a product's left out.
  const managed = await (await followMaster()).amazonManagedListingIds([...listingRows.keys()])
  for (const row of [...listingRows.values()]) {
    const fba = row.channel === 'AMAZON' && (managed.has(row.id) || isFbaCoordinate(row as never))
      || (COORDINATE_FBA.has(action) && isFbaCoordinate(row as never))
    if (!fba) continue
    if (explicit.has(row.id)) problems.push(`${row.product?.sku ?? row.id} on ${row.channel} ${row.marketplace} is fulfilled by Amazon (FBA): its quantity is Amazon's, and Nexus never changes it`)
    leftOut.push({ sku: row.product?.sku ?? row.productId, channel: row.channel, market: row.marketplace, reason: 'fulfilled by Amazon (FBA): Nexus leaves its quantity to Amazon' })
    listingRows.delete(row.id)
  }
  // Selling paused here (Inactive): no quantity from a quantity action. Named → refused; a product's → left out (as FBA).
  if (EU_ACTIONS.has(action)) {
    // An eBay listing an older Claude close-listing paused (pinned at 0, no hold) is Inactive too (`oldClosePauses`).
    const oldPauses = await oldClosePauses([...listingRows.values()])
    for (const row of [...listingRows.values()]) {
      if (!sellingPaused(row) && !oldPauses.has(row.id)) continue
      if (explicit.has(row.id)) problems.push(`${row.product?.sku ?? row.id} on ${row.channel} ${row.marketplace} is ${INACTIVE_REASON}`)
      leftOut.push({ sku: row.product?.sku ?? row.productId, channel: row.channel, market: row.marketplace, reason: INACTIVE_REASON })
      listingRows.delete(row.id)
    }
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}.` }

  if (listingRows.size + shared.size === 0) {
    return { error: leftOut.length ? `Nothing to act on: every row named is left out (${listed(leftOut.map((l) => `${l.sku} ${l.channel} ${l.market}: ${l.reason}`))}).` : 'Nothing to act on: those products have no live listing or shared eBay variant there.' }
  }
  if (listingRows.size + shared.size > MAX_ROWS) {
    return { error: `That is ${listingRows.size + shared.size} rows (Amazon EU counted market by market); at most ${MAX_ROWS} per request. Name fewer products or narrow it by channel or market.` }
  }
  if (args.quantity !== undefined && listingRows.size > 0) {
    return { error: 'A chosen fixed number applies to shared eBay variants only. For a listing, PIN keeps the number it shows now (only: "shared" with productIds).' }
  }

  const buffer = args.buffer as number | undefined
  const quantity = args.quantity as number | undefined
  const changedListings: BulkPlan['listings'] = []
  const changedShared: BulkPlan['shared'] = []
  let unchanged = 0
  for (const row of listingRows.values()) {
    const to = listingAfter(action, row, { buffer, until })
    if (to === null) unchanged++
    else changedListings.push({ row, to })
  }
  for (const row of shared.values()) {
    const to = sharedAfter(action, row, { buffer, quantity, until })
    if (to === null) unchanged++
    else changedShared.push({ row, to })
  }
  if (!changedListings.length && !changedShared.length) return { error: `Every row named already is as asked (${plural(unchanged, 'row')}). Nothing to change.` }

  // A fixed number on a SKU that sells from another business's shared stock: its quantity follows that stock.
  if (action === 'PIN') {
    const pooled = await pooledNow(prisma, [...new Set([...changedListings.map((c) => c.row.productId), ...changedShared.flatMap((c) => (c.row.productId ? [c.row.productId] : []))])])
    const held = [...changedListings.filter((c) => pooled.has(c.row.productId)).map((c) => c.row.product?.sku ?? c.row.productId),
      ...changedShared.filter((c) => c.row.productId && pooled.has(c.row.productId)).map((c) => c.row.sku)]
    if (held.length) {
      return { error: `Not queued: ${listed([...new Set(held)])} sell${held.length === 1 ? 's' : ''} from another business's shared stock, so the quantity follows that stock and cannot be fixed here. Change the stock in the business that lends it, or disconnect it first (Stock source).` }
    }
  }

  // eBay ends a listing pinned at 0 unless the account's out-of-stock option is ON (the Matrix's own check, L8).
  const zeroes = [
    ...changedListings.filter((c) => c.row.channel === 'EBAY' && (action === 'ZERO_PIN' || (action === 'PIN' && (c.row.quantity ?? c.row.quantityOverride ?? 1) === 0)))
      .map((c) => ({ sku: c.row.product?.sku ?? c.row.productId, accountId: c.row.channelConnectionId, market: c.row.marketplace })),
    ...changedShared.filter((c) => action === 'PIN' && (quantity ?? c.row.lastQtyPushed ?? 0) === 0)
      .map((c) => ({ sku: c.row.sku, accountId: c.row.channelConnectionId, market: c.row.marketplace })),
  ]
  if (zeroes.length) {
    const { ebayZeroAllowedFor } = await import('../../pim/matrix-write.service.js')
    const allowed = await ebayZeroAllowedFor(zeroes)
    const stopped = zeroes.filter((z) => allowed(z.accountId, z.market) !== true)
    if (stopped.length) return { error: `${listed([...new Set(stopped.map((z) => `${z.sku} on eBay ${z.market}`))])}: ${EBAY_ZERO_REFUSAL} Nothing was queued.` }
  }

  const accountIds = [...new Set(changedListings.map((c) => c.row.channelConnectionId).filter((id): id is string => !!id))]
  const accounts = new Map((accountIds.length ? await prisma.channelConnection.findMany({ where: { id: { in: accountIds } }, select: { id: true, accountLabel: true, displayName: true } }) : [])
    .map((a) => [a.id, a.accountLabel ?? a.displayName ?? a.id] as const))
  return { action, listings: changedListings, shared: changedShared, unchanged, leftOut, euAdded, buffer, quantity, until, untilText: typeof args.until === 'string' ? args.until : null, accounts }
}

/** The preview's lines: one per listing, ONE per Amazon EU group (every EU market of a SKU and account), one per variant. */
function cellsOf(plan: BulkPlan): Cell[] {
  const cells: Cell[] = []
  const eu = new Map<string, Array<{ row: ListingRow; to: string }>>()
  for (const item of plan.listings) {
    if (EU_ACTIONS.has(plan.action) && isEu(item.row)) eu.set(euKey(item.row), [...(eu.get(euKey(item.row)) ?? []), item])
    else {
      cells.push({ sku: item.row.product?.sku ?? item.row.productId, channel: item.row.channel, market: item.row.marketplace, account: item.row.channelConnectionId ? plan.accounts.get(item.row.channelConnectionId) ?? null : null, kind: 'listing', from: listingMode(item.row), to: item.to })
    }
  }
  for (const items of eu.values()) {
    const first = items[0].row
    const markets = items.map((i) => i.row.marketplace.toUpperCase()).sort()
    const froms = [...new Set(items.map((i) => listingMode(i.row)))]
    cells.push({
      sku: first.product?.sku ?? first.productId, channel: 'AMAZON', market: `EU (${markets.join(', ')})`,
      account: first.channelConnectionId ? plan.accounts.get(first.channelConnectionId) ?? null : null, kind: 'listing',
      from: froms.length === 1 ? froms[0] : froms.join(' / '), to: items[0].to,
    })
  }
  for (const item of plan.shared) cells.push({ sku: item.row.sku, channel: 'EBAY', market: item.row.marketplace, account: null, kind: 'shared variant', from: sharedMode(item.row), to: item.to })
  return cells
}

function bulkPreview(plan: BulkPlan) {
  const cells = cellsOf(plan)
  const rows = plan.listings.length + plan.shared.length
  return {
    action: 'bulk-listing-stock',
    verb: plan.action,
    summary: `${VERB[plan.action]} ${plural(rows, 'row')} (${plural(plan.listings.length, 'listing')}, ${plural(plan.shared.length, 'shared eBay variant')})`
      + `${plan.unchanged ? `; ${plan.unchanged} already as asked` : ''}.`,
    cells: cells.slice(0, PREVIEW_LINES),
    ...(cells.length > PREVIEW_LINES ? { moreCells: cells.length - PREVIEW_LINES } : {}),
    ...(plan.euAdded.length ? { euMarketsAdded: plan.euAdded.slice(0, PREVIEW_LINES) } : {}),
    ...(plan.leftOut.length ? { leftOut: plan.leftOut.slice(0, PREVIEW_LINES) } : {}),
    ...(plan.buffer !== undefined ? { buffer: plan.buffer } : {}),
    ...(plan.quantity !== undefined ? { quantity: plan.quantity } : {}),
    ...(plan.untilText ? { until: plan.until?.toISOString() ?? null } : {}),
    totals: { listings: plan.listings.length, sharedVariants: plan.shared.length, unchanged: plan.unchanged, leftOut: plan.leftOut.length },
    basis: basisOf({
      listings: plan.listings.map((c) => [c.row.id, c.row.followMasterQuantity, c.row.quantity, c.row.quantityOverride, c.row.syncPaused, c.row.stockBuffer]),
      shared: plan.shared.map((c) => [c.row.id, c.row.followPool, c.row.pinnedQuantity, c.row.stockBuffer, c.row.lastQtyPushed]),
    }),
    ...(plan.euAdded.length ? { warning: 'Amazon keeps ONE quantity per SKU for every EU market: this covers each SKU\'s other open EU markets too.' } : {}),
    note: `${NOT_YET} It runs as the Sync Control page runs it, as the person who approves it; a row whose stock mode moved since then stops the run. `
      + 'Listings that follow the stock are recomputed and queued to their channels. Amazon FBA quantity is never changed.',
  }
}

/** The fields an action writes, per listing and per shared variant — what undo compares and puts back. */
function writtenListingFields(action: Action, row: { syncPaused: boolean; followMasterQuantity: boolean | null; quantityOverride: number | null; stockBuffer: number | null }) {
  if (action === 'PAUSE' || action === 'RESUME') return { syncPaused: row.syncPaused }
  if (action === 'FOLLOW' || action === 'PIN') return { followMasterQuantity: row.followMasterQuantity !== false }
  if (action === 'ZERO_PIN') return { followMasterQuantity: row.followMasterQuantity !== false, quantityOverride: row.quantityOverride }
  return { stockBuffer: row.stockBuffer ?? 0 }
}
function writtenSharedFields(action: Action, row: { followPool: boolean | null; pinnedQuantity: number | null; stockBuffer: number | null }) {
  if (action === 'EXCLUDE' || action === 'INCLUDE') return { followPool: row.followPool !== false }
  if (action === 'PIN' || action === 'FOLLOW') return { pinnedQuantity: row.pinnedQuantity }
  return { stockBuffer: row.stockBuffer ?? 0 }
}

/** What is stored now for the rows a change wrote, in the shape of its `after`. */
async function storedState(action: Action, listingIds: string[], sharedIds: string[]) {
  type StoredListing = { id: string; syncPaused: boolean; followMasterQuantity: boolean | null; quantityOverride: number | null; stockBuffer: number | null }
  type StoredShared = { id: string; followPool: boolean | null; pinnedQuantity: number | null; stockBuffer: number | null }
  const listings: StoredListing[] = listingIds.length
    ? await prisma.channelListing.findMany({ where: { id: { in: listingIds } }, select: { id: true, syncPaused: true, followMasterQuantity: true, quantityOverride: true, stockBuffer: true } })
    : []
  const shared: StoredShared[] = sharedIds.length
    ? await prisma.sharedListingMembership.findMany({ where: { id: { in: sharedIds } }, select: { id: true, followPool: true, pinnedQuantity: true, stockBuffer: true } })
    : []
  const listingById = new Map(listings.map((r) => [r.id, r]))
  const sharedById = new Map(shared.map((r) => [r.id, r]))
  return {
    action,
    listings: listingIds.map((id) => { const r = listingById.get(id); return { listingId: id, ...(r ? writtenListingFields(action, r) : { missing: true }) } }),
    shared: sharedIds.map((id) => { const r = sharedById.get(id); return { sharedVariantId: id, ...(r ? writtenSharedFields(action, r) : { missing: true }) } }),
  }
}

type BulkBefore = {
  action?: Action
  listings?: Array<{ listingId: string; sku: string; syncPaused: boolean; follows: boolean; quantity: number | null; stockBuffer: number }>
  shared?: Array<{ sharedVariantId: string; productId: string | null; sku: string; marketplace: string; followPool: boolean; pinnedQuantity: number | null; stockBuffer: number }>
}

/**
 * C2 — undo asks for the inverse action on the rows this change wrote: pause ↔ resume, exclude ↔ include, a pin or a
 * zero back to follow, a buffer back to the one it replaced. Partial: a fixed number it replaced cannot be typed back
 * through Sync Control (PIN keeps the number a listing shows) — set-listing-stock does that, per listing.
 */
export const BULK_LISTING_STOCK_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { action?: Action; listings?: Array<{ listingId: string }>; shared?: Array<{ sharedVariantId: string }> }
    return storedState(after.action as Action, (after.listings ?? []).map((r) => r.listingId), (after.shared ?? []).map((r) => r.sharedVariantId))
  },
  request(change) {
    const before = (change.before ?? {}) as BulkBefore
    const listings = before.listings ?? []
    const shared = before.shared ?? []
    if (!before.action || (!listings.length && !shared.length)) return { refusal: 'This change does not name the rows it wrote.' }
    let inverse: Action
    let buffer: number | undefined
    let quantity: number | undefined
    switch (before.action) {
      case 'PAUSE': inverse = 'RESUME'; break
      case 'RESUME': inverse = 'PAUSE'; break
      case 'EXCLUDE': inverse = 'INCLUDE'; break
      case 'INCLUDE': inverse = 'EXCLUDE'; break
      case 'PIN': case 'ZERO_PIN': {
        const fixedBefore = [...listings.filter((r) => !r.follows).map((r) => `${r.sku} (${r.quantity ?? '?'})`), ...shared.filter((r) => r.pinnedQuantity != null).map((r) => `${r.sku} (${r.pinnedQuantity})`)]
        if (fixedBefore.length) return { refusal: `Before this change ${listed(fixedBefore)} already had a fixed number, which Sync Control cannot type back: set it per listing with set-listing-stock.` }
        inverse = 'FOLLOW'
        break
      }
      case 'FOLLOW': {
        if (listings.length) return { refusal: `The fixed numbers it replaced (${listed(listings.map((r) => `${r.sku}: ${r.quantity ?? '?'}`))}) cannot be typed back through Sync Control: set them per listing with set-listing-stock.` }
        const numbers = [...new Set(shared.map((r) => r.pinnedQuantity))]
        if (numbers.length !== 1 || numbers[0] == null) return { refusal: `The shared variants had different fixed numbers before (${listed(shared.map((r) => `${r.sku}: ${r.pinnedQuantity ?? 'follow'}`))}): put them back one number at a time.` }
        inverse = 'PIN'
        quantity = numbers[0]
        break
      }
      case 'BUFFER': {
        const buffers = [...new Set([...listings.map((r) => r.stockBuffer), ...shared.map((r) => r.stockBuffer)])]
        if (buffers.length !== 1) return { refusal: `The rows had different buffers before (${listed([...listings.map((r) => `${r.sku}: ${r.stockBuffer}`), ...shared.map((r) => `${r.sku}: ${r.stockBuffer}`)])}): put them back one buffer at a time.` }
        inverse = 'BUFFER'
        buffer = buffers[0]
        break
      }
      default: return { refusal: 'This change cannot be put back.' }
    }
    const markets = [...new Set(shared.map((r) => r.marketplace))]
    const productIds = [...new Set(shared.map((r) => r.productId).filter((id): id is string => !!id))]
    if (shared.length && (markets.length !== 1 || productIds.length !== new Set(shared.map((r) => r.productId)).size)) {
      return { refusal: 'Its shared eBay variants are in several markets: put them back market by market.' }
    }
    return {
      tool: 'bulk-listing-stock',
      args: {
        action: inverse,
        ...(listings.length ? { listingIds: listings.map((r) => r.listingId) } : {}),
        ...(shared.length ? { productIds, only: 'shared', channel: 'EBAY', marketplace: markets[0] } : {}),
        ...(buffer !== undefined ? { buffer } : {}),
        ...(quantity !== undefined ? { quantity } : {}),
      },
    }
  },
}

const bulkListingStock: AgentTool = {
  name: 'bulk-listing-stock',
  title: 'Change stock sync of many listings',
  input: bulkInput,
  requires: [F.inventoryAdjust, F.listingsEdit],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: BULK_LISTING_STOCK_UNDO,
  description:
    `Change how up to ${MAX_ROWS} listings and shared eBay variants take their stock, as the Sync Control page does: hold or `
    + 'release the stock sync, follow the stock, keep a fixed number, zero & pin (stops selling now), set a buffer, exclude or '
    + 'include a shared eBay variant. Name listings, or products (each with all its listings and shared variants, narrowed '
    + 'by channel or market). Amazon keeps one quantity per SKU for every EU market, so a quantity change on an Amazon EU '
    + 'market covers every EU market of that SKU (one EU line in the preview). Refused: a fixed number on a SKU that sells '
    + 'from another business\'s shared stock; a pin to 0 on eBay while the account\'s out-of-stock option is off (eBay '
    + 'would end the listing); an Amazon FBA listing (its quantity is Amazon\'s); a quantity change on a listing whose selling is '
    + 'paused (Inactive — resume it in the product sheet\'s Status column). Always waits for a person to approve it '
    + 'in Nexus; a row that changed since stops the run.',
  async handler(args): Promise<ToolResult> {
    const plan = await planBulk(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: bulkPreview(plan) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planBulk(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const approved = ctx.approvedPreview as { basis?: unknown } | undefined
    if (typeof approved?.basis !== 'string') return { ok: false, error: 'A Sync Control change runs only after a person approved its preview. Nothing changed.' }
    if (approved.basis !== bulkPreview(plan).basis) return { ok: false, error: 'A row\'s stock mode changed since this was approved. Nothing changed; ask Claude again.' }
    const body: SyncControlActionBody = {
      action: plan.action,
      listings: plan.listings.map(({ row }) => ({ productId: row.productId, channel: row.channel, marketplace: row.marketplace, channelConnectionId: row.channelConnectionId, aliasKey: row.aliasKey })),
      memberships: plan.shared.map(({ row }) => ({ itemId: row.itemId, marketplace: row.marketplace, sku: row.sku })),
      ...(plan.buffer !== undefined ? { buffer: plan.buffer } : {}),
      ...(plan.quantity !== undefined ? { quantity: plan.quantity } : {}),
      ...(plan.untilText ? { until: plan.untilText } : {}),
      // The person approved every EU market of these SKUs (the preview's one EU cell): the page's consent.
      expandEuAligned: true,
    }
    const out = await (await syncControl()).runSyncControlAction(body, actorOf(ctx, 'bulk-listing-stock'))
    const result = out.body as { updated?: number; skippedFba?: number; skippedInactive?: number; unchanged?: number; recascadeQueued?: number; partial?: boolean; error?: string }
    if (out.status !== 200) return { ok: false, error: `${result.error ?? 'Sync Control refused it.'} Nothing changed.` }
    if (!result.updated) return { ok: false, error: `Nothing changed${result.error ? `: ${result.error}` : ': every row already was as asked.'}` }
    const after = await storedState(plan.action, plan.listings.map((c) => c.row.id), plan.shared.map((c) => c.row.id))
    return {
      ok: true,
      data: { updated: result.updated, unchanged: result.unchanged ?? 0, skippedFba: result.skippedFba ?? 0, recascadeQueued: result.recascadeQueued ?? 0, ...(result.skippedInactive ? { skippedInactive: result.skippedInactive } : {}), ...(result.partial ? { partial: true, error: result.error } : {}) },
      change: {
        before: {
          action: plan.action,
          listings: plan.listings.map(({ row }) => ({ listingId: row.id, sku: row.product?.sku ?? row.productId, syncPaused: row.syncPaused, follows: row.followMasterQuantity !== false, quantity: row.quantity, stockBuffer: row.stockBuffer ?? 0 })),
          shared: plan.shared.map(({ row }) => ({ sharedVariantId: row.id, productId: row.productId, sku: row.sku, marketplace: row.marketplace, followPool: row.followPool !== false, pinnedQuantity: row.pinnedQuantity, stockBuffer: row.stockBuffer ?? 0 })),
        },
        after,
      },
    }
  },
}

// ── set-stock-policy ──────────────────────────────────────────────────────────────────────────────────

const policyInput = z.object({
  channel: z.preprocess(upper, z.enum(KNOWN_CHANNELS)).optional().describe('a policy: the channel it is for'),
  marketplace: z.string().trim().toUpperCase().regex(/^(\*|[A-Z]{2,4})$/).optional()
    .describe('a policy: the market code (IT, DE …), or * for every market of the channel'),
  accountId: z.string().trim().min(1).max(64).optional()
    .describe('a policy: one account of the channel (listing-coordinates names accounts); left out = every account'),
  pushesPaused: flag.optional()
    .describe('a policy: true holds the stock sync there — no stock push (its listings show "Sync held (policy)"); false releases it and re-sends'),
  newListingDefaultMode: z.preprocess(upper, z.enum(['FOLLOW', 'PAUSED'])).optional()
    .describe('a policy: how a new listing there starts — FOLLOW the stock, or PAUSED (stock sync held) until a person releases it'),
  locationCode: z.string().trim().min(1).max(30).optional()
    .describe('a location\'s feeds: the location code (stock-locations), instead of a policy'),
  feeds: z.array(z.string().trim().min(1).max(40)).max(50).optional()
    .describe('a location\'s feeds: what its stock serves — CHANNEL:MARKET (EBAY:IT), a channel (SHOPIFY) or a market (DE); empty = nothing'),
})

type PolicyPlan =
  | { kind: 'policy'; channel: string; marketplace: string; accountId: string | null; accountLabel: string | null
      before: { pushesPaused: boolean; newListingDefaultMode: string }; after: { pushesPaused: boolean; newListingDefaultMode: string }; listings: number }
  | { kind: 'feeds'; locationId: string; code: string; name: string; before: string[]; after: string[]; products: number }

async function planPolicy(args: Record<string, unknown>): Promise<PolicyPlan | Refusal> {
  const location = args.locationCode as string | undefined
  const policyNamed = args.channel !== undefined || args.marketplace !== undefined || args.accountId !== undefined || args.pushesPaused !== undefined || args.newListingDefaultMode !== undefined
  if (location && policyNamed) return { error: 'Name either a policy (channel, marketplace …) or a location\'s feeds (locationCode, feeds), one per request.' }
  if (location) {
    if (!Array.isArray(args.feeds)) return { error: 'Name what the location\'s stock feeds (feeds): an empty list feeds nothing.' }
    const feeds = [...new Set((args.feeds as string[]).map((t) => t.trim().toUpperCase()).filter(Boolean))]
    const problems = validateServesTokens(feeds)
    if (problems.length) return { error: `Not queued: ${listed(problems.map((p) => `${p.token}: ${p.problem}`))}.` }
    const loc = await prisma.stockLocation.findFirst({ where: { code: { in: [location, location.toUpperCase()] } }, select: { id: true, code: true, name: true, type: true, syncRoutes: true } })
    if (!loc) return { error: 'Location not found: see stock-locations for this business\'s location codes' }
    if (loc.type === 'AMAZON_FBA') return { error: `${loc.code} is Amazon FBA stock: what it feeds is set by a person in Nexus, never from here.` }
    const before = [...(loc.syncRoutes ?? [])]
    if (JSON.stringify([...before].sort()) === JSON.stringify([...feeds].sort())) return { error: `${loc.code} already feeds exactly that. Nothing to change.` }
    const products = (await prisma.stockLevel.findMany({ where: { locationId: loc.id }, select: { productId: true }, distinct: ['productId'] })).length
    return { kind: 'feeds', locationId: loc.id, code: loc.code, name: loc.name, before, after: feeds, products }
  }
  if (args.feeds !== undefined) return { error: 'Feeds belong to a location: name it (locationCode).' }
  if (!args.channel || !args.marketplace) return { error: 'Name the policy\'s channel and market (marketplace, or * for every market), or a location (locationCode).' }
  if (args.pushesPaused === undefined && args.newListingDefaultMode === undefined) return { error: 'Name what to change: pushesPaused and/or newListingDefaultMode.' }
  const channel = String(args.channel)
  const marketplace = String(args.marketplace)
  let accountId: string | null = null
  let accountLabel: string | null = null
  if (args.accountId) {
    const account = await prisma.channelConnection.findFirst({ where: { id: String(args.accountId) }, select: { id: true, channelType: true, accountLabel: true, displayName: true } })
    if (!account) return { error: 'Account not found: listing-coordinates names this business\'s accounts' }
    if (account.channelType !== channel) return { error: `That account is not a ${channel} account.` }
    accountId = account.id
    accountLabel = account.accountLabel ?? account.displayName ?? null
  }
  const same = await prisma.syncChannelPolicy.findMany({ where: { channel, marketplace, channelConnectionId: accountId }, select: { pushesPaused: true, newListingDefaultMode: true } })
  const before = { pushesPaused: same.some((r) => r.pushesPaused), newListingDefaultMode: same.some((r) => r.newListingDefaultMode === 'PAUSED') ? 'PAUSED' : 'FOLLOW' }
  const after = { pushesPaused: (args.pushesPaused as boolean | undefined) ?? before.pushesPaused, newListingDefaultMode: (args.newListingDefaultMode as string | undefined) ?? before.newListingDefaultMode }
  if (after.pushesPaused === before.pushesPaused && after.newListingDefaultMode === before.newListingDefaultMode) {
    return { error: `The ${channel} ${marketplace === '*' ? 'every-market' : marketplace} policy${accountLabel ? ` of ${accountLabel}` : ''} already is so. Nothing to change.` }
  }
  const listings = await prisma.channelListing.count({
    where: { channel, listingStatus: { not: 'ENDED' }, ...(marketplace === '*' ? {} : { marketplace }), ...(accountId ? { channelConnectionId: accountId } : {}) },
  })
  return { kind: 'policy', channel, marketplace, accountId, accountLabel, before, after, listings }
}

function policyPreview(plan: PolicyPlan) {
  if (plan.kind === 'feeds') {
    return {
      action: 'set-stock-policy',
      location: { code: plan.code, name: plan.name },
      summary: `${plan.code} feeds ${plan.after.length ? plan.after.join(', ') : 'nothing'} (was ${plan.before.length ? plan.before.join(', ') : 'nothing'}).`,
      changes: { feeds: { from: plan.before, to: plan.after } },
      totals: { productsRecomputed: plan.products },
      note: `${NOT_YET} Every product with stock there is recomputed and its listings that follow the stock are queued to their channels.`,
    }
  }
  const where = `${plan.channel} ${plan.marketplace === '*' ? '(every market)' : plan.marketplace}${plan.accountLabel ? ` on ${plan.accountLabel}` : plan.accountId ? '' : ' (every account)'}`
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  if (plan.before.pushesPaused !== plan.after.pushesPaused) changes['stock pushes'] = { from: plan.before.pushesPaused ? 'held' : 'on', to: plan.after.pushesPaused ? 'held' : 'on' }
  if (plan.before.newListingDefaultMode !== plan.after.newListingDefaultMode) changes['a new listing starts'] = { from: plan.before.newListingDefaultMode, to: plan.after.newListingDefaultMode }
  return {
    action: 'set-stock-policy',
    policy: { channel: plan.channel, marketplace: plan.marketplace, accountId: plan.accountId, account: plan.accountLabel },
    summary: `Stock policy for ${where}: ${Object.entries(changes).map(([k, v]) => `${k} ${v.from} → ${v.to}`).join('; ')}.`,
    changes,
    totals: { listingsInScope: plan.listings },
    ...(plan.after.pushesPaused && !plan.before.pushesPaused ? { warning: `No stock number is sent to ${where} while its stock sync is held: its ${plural(plan.listings, 'listing')} keep what the channel shows now, and can oversell.` } : {}),
    note: `${NOT_YET} ${!plan.after.pushesPaused && plan.before.pushesPaused ? 'Releasing the stock sync recomputes every product there and queues its listings. ' : ''}`
      + `${plan.after.newListingDefaultMode === 'PAUSED' && plan.before.newListingDefaultMode !== 'PAUSED' ? 'New listings there start with the stock sync held, and listings still new are held now. ' : ''}`.trim(),
  }
}

const STOCK_POLICY_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as Record<string, unknown>
    if (after.kind === 'feeds') {
      const loc = await prisma.stockLocation.findFirst({ where: { id: String(after.locationId) }, select: { syncRoutes: true } })
      return { ...after, feeds: [...(loc?.syncRoutes ?? [])].sort() }
    }
    const same = await prisma.syncChannelPolicy.findMany({ where: { channel: String(after.channel), marketplace: String(after.marketplace), channelConnectionId: (after.accountId as string | null) ?? null }, select: { pushesPaused: true, newListingDefaultMode: true } })
    return { ...after, pushesPaused: same.some((r) => r.pushesPaused), newListingDefaultMode: same.some((r) => r.newListingDefaultMode === 'PAUSED') ? 'PAUSED' : 'FOLLOW' }
  },
  request(change) {
    const before = (change.before ?? {}) as Record<string, unknown>
    if (before.kind === 'feeds') {
      if (typeof before.code !== 'string' || !Array.isArray(before.feeds)) return { refusal: 'This change does not name the location and what it fed.' }
      return { tool: 'set-stock-policy', args: { locationCode: before.code, feeds: before.feeds } }
    }
    if (typeof before.channel !== 'string' || typeof before.marketplace !== 'string') return { refusal: 'This change does not name its policy.' }
    return {
      tool: 'set-stock-policy',
      args: { channel: before.channel, marketplace: before.marketplace, ...(before.accountId ? { accountId: before.accountId } : {}), pushesPaused: before.pushesPaused, newListingDefaultMode: before.newListingDefaultMode },
    }
  },
}

const setStockPolicy: AgentTool = {
  name: 'set-stock-policy',
  title: 'Set a stock sync policy',
  input: policyInput,
  requires: [F.inventoryAdjust, F.listingsEdit],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: STOCK_POLICY_UNDO,
  description:
    'Set what the stock sync does for a channel, a market or one account: hold it — no stock push there (its listings keep '
    + 'what the channel shows and can oversell) — or release it (every product there is recomputed and sent), and whether a '
    + 'new listing there starts following the stock or with the sync held. Or set which channels and markets one location\'s stock '
    + 'feeds (an Amazon FBA location is refused). As the Sync Control page does it. Always waits for a person to approve '
    + 'it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planPolicy(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return { ok: true, preview: policyPreview(plan) }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planPolicy(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const actor = actorOf(ctx, 'set-stock-policy')
    if (plan.kind === 'feeds') {
      const out = await (await syncControl()).setLocationRoutes({ code: plan.code, syncRoutes: plan.after }, actor)
      const body = out.body as { error?: string; recascadeQueued?: number }
      if (out.status !== 200) return { ok: false, error: `${body.error ?? 'Sync Control refused it.'} Nothing changed.` }
      return {
        ok: true,
        data: { location: plan.code, feeds: plan.after, recascadeQueued: body.recascadeQueued ?? 0 },
        change: {
          before: { kind: 'feeds', locationId: plan.locationId, code: plan.code, feeds: [...plan.before].sort() },
          after: { kind: 'feeds', locationId: plan.locationId, code: plan.code, feeds: [...plan.after].sort() },
        },
      }
    }
    const out = await (await syncControl()).setSyncPolicy({ channel: plan.channel, marketplace: plan.marketplace, channelConnectionId: plan.accountId, pushesPaused: plan.after.pushesPaused, newListingDefaultMode: plan.after.newListingDefaultMode as 'FOLLOW' | 'PAUSED' }, actor)
    const body = out.body as { error?: string; recascadeQueued?: number }
    if (out.status !== 200) return { ok: false, error: `${body.error ?? 'Sync Control refused it.'} Nothing changed.` }
    const key = { kind: 'policy', channel: plan.channel, marketplace: plan.marketplace, accountId: plan.accountId }
    return {
      ok: true,
      data: { policy: { ...key, ...plan.after }, recascadeQueued: body.recascadeQueued ?? 0 },
      change: { before: { ...key, ...plan.before }, after: { ...key, ...plan.after } },
    }
  },
}

export const STOCK_SYNC_TOOLS: AgentTool[] = [bulkListingStock, setStockPolicy]
