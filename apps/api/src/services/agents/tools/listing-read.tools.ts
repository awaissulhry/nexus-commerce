/**
 * MCP full control L2 — listing reads (plan section 02, step 2).
 *
 *   listing-coordinates  where each listing of a product family lives, exactly: its Nexus listing id, channel, market,
 *                        account (Nexus id and label), alias, version, status, draft and published — the destination a
 *                        publish review names.
 *   listing-matrix       stock and price per listing and market: the Matrix page's own read (`getMatrixRead`), trimmed.
 *   media-plan           the family's photos and where they go: the Media page's own read (`readMediaWorkspace`,
 *                        `isMediaSwitched`), trimmed.
 *
 * Read-only and this business's own rows: row-level security scopes every read and no argument names a business. No
 * marketplace call. No channel's own id (an ASIN, an eBay item number, a Shopify product id) is returned — `linked`
 * says whether a listing carries one — and an account is named by its label and its Nexus id only, never by a
 * credential or a seller id. A listing attributed to an account that is not this business's is shown without it.
 * Every list is capped for MCP output size and says how many more there are.
 */

import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { CHANNEL_LABELS } from '@nexus/shared/channel-label'
import { isStillDraftListing } from '@nexus/shared/push-lock'
import type { MatrixCells, MatrixCoordinate, MatrixRowRead } from '@nexus/shared/matrix-contract'
import prisma from '../../../db.js'
import { MAX_RESULT_BYTES } from '../../../lib/pagination/cursor.js'
import { connectionLabel } from '../../connection-label.js'
import { isOwnConnection } from '../../connection-resolver.service.js'
import { WorkspaceScopeError } from '../../pim/workspace-destination.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'

// The Matrix and Media page reads load lazily, as the routes load them: the registry (every tool file) stays light.
const matrixService = () => import('../../pim/matrix.service.js')
const mediaService = () => import('../../images/media-plan.service.js')

const CHANNELS = Object.keys(CHANNEL_LABELS) as [string, ...string[]]
/** Per answer: at most this many listings, rows, photos or checks; texts cut to this length. */
const LISTING_CAP = 100
const PHOTO_CAP = 100
const CHECK_CAP = 15
const TEXT_CAP = 240

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const clip = (text: string | null | undefined, cap = TEXT_CAP) => (text == null ? null : text.length > cap ? `${text.slice(0, cap - 1)}…` : text)
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? 'null')

const productArg = z.string().trim().min(1).max(64)
  .describe('Nexus product id: a family (parent), one of its variations or a single product; the whole family is read')
const channelArg = z.preprocess(upper, z.enum(CHANNELS)).optional().describe('only this channel')
const marketArg = z.string().trim().toUpperCase().min(2).max(20).optional()
  .describe('only this marketplace code, e.g. IT or DE; GLOBAL for single-store channels such as Shopify and Etsy')

/**
 * A product the page's read cannot find (deleted meanwhile) is not found; a Nexus WorkspaceScopeError (an unreadable
 * plan) is the caller's answer; anything else is a fault.
 */
function refusal(error: unknown): ToolResult {
  if ((error as { code?: unknown })?.code === 'unknown_product') return { ok: false, error: PRODUCT_NOT_FOUND }
  if (error instanceof WorkspaceScopeError) {
    return { ok: false, error: error.statusCode === 404 ? PRODUCT_NOT_FOUND : error.message }
  }
  throw error
}

/** The family a product belongs to: its root and every live member, root first. Null when the product is not here. */
async function familyOf(productId: string) {
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, parentId: true } })
  if (!product) return null
  const rootId = product.parentId ?? product.id
  const members = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: rootId }, { parentId: rootId }] },
    select: { id: true, sku: true, name: true, parentId: true },
    orderBy: { sku: 'asc' },
  })
  const root = members.find((member) => member.id === rootId)
  // A variation whose parent is deleted reads as its own family.
  if (!root) {
    const self = await prisma.product.findFirstOrThrow({ where: { id: product.id }, select: { id: true, sku: true, name: true, parentId: true } })
    return { root: self, members: [self] }
  }
  return { root, members: [root, ...members.filter((member) => member.id !== rootId)] }
}

/** This business's own channel accounts, by id, named the way the rest of the app names them. */
async function ownAccounts(channel?: string) {
  const rows = await prisma.channelConnection.findMany({
    where: channel ? { channelType: channel } : { channelType: { in: CHANNELS } },
    select: {
      id: true, channelType: true, accountLabel: true, ebayStoreName: true, displayName: true, ebaySignInName: true,
      externalAccountId: true, isActive: true, isPrimary: true, workspaceId: true, sortOrder: true, createdAt: true,
    },
    orderBy: [{ channelType: 'asc' }, { isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
  })
  return rows.filter(isOwnConnection).map((row) => ({
    accountId: row.id,
    channel: row.channelType,
    label: connectionLabel(row).label,
    active: row.isActive,
    primary: row.isPrimary,
  }))
}

// ── listing-coordinates ─────────────────────────────────────────────────────────────────────────────

const listingCoordinates: AgentTool = {
  name: 'listing-coordinates',
  title: 'Listing coordinates',
  input: z.object({ productId: productArg, channel: channelArg, market: marketArg }),
  requires: [F.listingsView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Where each listing of a product family lives, exactly: the Nexus listing id, channel, market, account (its Nexus '
    + 'accountId and label), alias (a second listing on the same account and market), version, status; draft = Nexus has '
    + 'never published it; published = Nexus holds it as published; linked = it carries the channel\'s own item id (never '
    + 'shown here). destinations groups the listings by channel, market, account and alias, and reviewWith gives the '
    + 'arguments publish-review takes for that destination. accounts lists this business\'s accounts per channel, for a '
    + 'market that has no listing yet.',
  async handler(args) {
    const family = await familyOf(String(args.productId))
    if (!family) return { ok: false, error: PRODUCT_NOT_FOUND }
    const channel = args.channel as string | undefined
    const market = args.market as string | undefined
    const memberIds = family.members.map((member) => member.id)
    const [listings, accounts, aliases] = await Promise.all([
      prisma.channelListing.findMany({
        where: { productId: { in: memberIds }, ...(channel ? { channel } : {}), ...(market ? { marketplace: market } : {}) },
        select: {
          id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, version: true,
          listingStatus: true, isPublished: true, externalListingId: true, syncPaused: true, offerClosedAt: true,
          lastSyncStatus: true, lastSyncedAt: true, lastSyncError: true,
        },
        orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }, { channelConnectionId: 'asc' }, { aliasKey: 'asc' }, { id: 'asc' }],
      }),
      ownAccounts(channel),
      prisma.productListingAlias.findMany({ where: { productId: family.root.id }, select: { id: true, label: true, position: true, status: true } }),
    ])
    const skuOf = new Map(family.members.map((member) => [member.id, member.sku]))
    const accountOf = new Map(accounts.map((account) => [account.accountId, account]))
    const aliasOf = new Map(aliases.map((alias) => [alias.id, alias]))
    const single = family.members.length === 1
    const rows = listings
      .map((row) => {
        // An account that is not one of this business's is not named: neither its id nor its label.
        const account = row.channelConnectionId ? accountOf.get(row.channelConnectionId) : undefined
        const alias = row.aliasKey ? aliasOf.get(row.aliasKey) : undefined
        return {
          listingId: row.id,
          productId: row.productId,
          sku: skuOf.get(row.productId) ?? null,
          role: single ? 'single' : row.productId === family.root.id ? 'parent' : 'variant',
          channel: row.channel,
          market: row.marketplace,
          accountId: account?.accountId ?? null,
          accountLabel: account?.label ?? null,
          ...(row.channelConnectionId && !account ? { accountNote: 'Its account is not one of this business\'s accounts.' } : {}),
          ...(!row.channelConnectionId ? { accountNote: 'No account is recorded for this listing.' } : {}),
          alias: alias ? { id: alias.id, label: alias.label, position: alias.position, archived: alias.status !== 'ACTIVE' } : null,
          version: row.version,
          status: row.listingStatus,
          draft: isStillDraftListing(row),
          published: row.isPublished,
          linked: !!row.externalListingId,
          syncPaused: row.syncPaused,
          offerClosed: !!row.offerClosedAt,
          lastSync: row.lastSyncStatus || row.lastSyncedAt
            ? { status: row.lastSyncStatus, at: row.lastSyncedAt?.toISOString() ?? null, error: clip(row.lastSyncError) }
            : null,
        }
      })
      .sort((a, b) => a.channel.localeCompare(b.channel) || a.market.localeCompare(b.market)
        || (a.accountLabel ?? '').localeCompare(b.accountLabel ?? '') || (a.alias?.position ?? 0) - (b.alias?.position ?? 0)
        || Number(b.role === 'parent') - Number(a.role === 'parent') || (a.sku ?? '').localeCompare(b.sku ?? '') || a.listingId.localeCompare(b.listingId))

    // One destination per channel, market, account and alias: what publish-review reviews.
    const destinations = new Map<string, { channel: string; market: string; accountId: string | null; accountLabel: string | null
      alias: { id: string; label: string; position: number; archived: boolean } | null; listings: number; drafts: number; published: number
      reviewWith: Record<string, string> | null; firstListingId: string }>()
    for (const row of rows) {
      const key = JSON.stringify([row.channel, row.market, row.accountId, row.alias?.id ?? ''])
      const entry = destinations.get(key) ?? {
        channel: row.channel, market: row.market, accountId: row.accountId, accountLabel: row.accountLabel, alias: row.alias,
        listings: 0, drafts: 0, published: 0, firstListingId: row.listingId,
        reviewWith: row.accountId ? { productId: family.root.id, channel: row.channel, market: row.market, accountId: row.accountId } : null,
      }
      entry.listings += 1
      if (row.draft) entry.drafts += 1
      if (row.published) entry.published += 1
      // An alias is named by one of its listings (the parent's when it has one: rows list the parent first).
      if (row.alias && entry.reviewWith && !entry.reviewWith.listingId) entry.reviewWith.listingId = row.listingId
      destinations.set(key, entry)
    }

    const shown = rows.slice(0, LISTING_CAP)
    return {
      ok: true,
      data: {
        product: { id: family.root.id, sku: family.root.sku, name: clip(family.root.name), variations: family.members.length - 1 },
        destinations: [...destinations.values()].map(({ firstListingId: _first, ...entry }) => entry),
        listings: shown,
        ...(rows.length > shown.length ? { moreListings: rows.length - shown.length, narrow: 'Name a channel or a market to see the rest.' } : {}),
        accounts,
      },
    }
  },
}

// ── listing-matrix ──────────────────────────────────────────────────────────────────────────────────

/** One coordinate as Claude needs it: where it is, what it serves, and where its inventory lives. */
function coordinateOf(c: MatrixCoordinate) {
  return {
    key: c.key,
    kind: c.kind,
    channel: c.channel,
    market: c.market,
    label: c.label,
    accountId: c.accountId,
    alias: c.alias,
    currency: c.currency,
    cells: c.cells,
    listed: c.listed,
    draft: c.draft,
    ...(c.sharedInventoryWith ? { sharedInventoryWith: c.sharedInventoryWith } : {}),
    ...(c.inventoryOn ? { inventoryOn: c.inventoryOn } : {}),
  }
}

/** One row's cells at one coordinate, without the page's display-only facts. No channel id: `linked` instead. */
function cellOf(cell: MatrixCells) {
  const blocked = Object.entries(cell.writeBlockedReason ?? {}).filter(([, reason]) => !!reason)
  return {
    listingId: cell.listingId,
    version: cell.version,
    listing: cell.listing ? {
      state: cell.listing.state, published: cell.listing.published, linked: !!cell.listing.externalId, ...(cell.listing.detail ? { detail: cell.listing.detail } : {}),
      // Build shape v2: the selling state the sheet's Status column shows (active · paused = Inactive · mixed = Partly
      // inactive · ended · draft …) and why. Read only here: a selling change is the Status column + Publish.
      ...(cell.listing.selling ? { selling: { state: cell.listing.selling.state, ...(cell.listing.selling.reason ? { reason: clip(cell.listing.selling.reason) } : {}) } } : {}),
    } : null,
    fulfilment: cell.fulfilment ? { method: cell.fulfilment.method, source: cell.fulfilment.source, guard: cell.fulfilment.guard, reported: cell.fulfilment.reported } : null,
    sync: cell.sync ? {
      kind: cell.sync.kind, via: cell.sync.via, mode: cell.sync.mode, intended: cell.sync.intended, held: cell.sync.held,
      buffer: cell.sync.buffer, poolAvailable: cell.sync.poolAvailable, fbaAtAmazon: cell.sync.fbaAtAmazon, oversold: cell.sync.oversold,
    } : null,
    queue: cell.queue && cell.queue.state !== 'never' ? { state: cell.queue.state, at: cell.queue.at, reason: clip(cell.queue.reason), lane: cell.queue.syncType } : null,
    price: cell.price ? { value: cell.price.value, currency: cell.price.currency, source: cell.price.source, formula: cell.price.formula, clamped: cell.price.clamped } : null,
    sale: cell.sale && cell.sale.value != null ? cell.sale : null,
    writable: Object.entries(cell.writable ?? {}).filter(([, yes]) => yes).map(([kind]) => kind),
    ...(blocked.length ? { blocked: Object.fromEntries(blocked.map(([kind, reason]) => [kind, clip(reason)])) } : {}),
  }
}

function rowOf(row: MatrixRowRead, keys: ReadonlySet<string>) {
  return {
    rowId: row.id,
    sku: row.sku,
    role: row.role,
    status: row.status,
    basePrice: row.basePrice,
    stock: {
      available: row.stock.available,
      uncounted: row.stock.uncounted,
      ...(row.stock.source ? { sharedFrom: row.stock.source.lenderName } : {}),
    },
    cells: Object.fromEntries(Object.entries(row.cells).filter(([key]) => keys.has(key)).map(([key, cell]) => [key, cellOf(cell)])),
  }
}

const listingMatrix: AgentTool = {
  name: 'listing-matrix',
  title: 'Listing stock and price matrix',
  input: z.object({
    productId: productArg,
    channel: channelArg,
    market: z.string().trim().toUpperCase().min(2).max(20).optional()
      .describe('only this marketplace code, e.g. IT; an Amazon EU market also shows AMAZON:EU, where its one EU quantity lives'),
    sku: z.string().trim().min(1).max(100).optional().describe('only rows whose SKU starts with this'),
    limit: z.coerce.number().int().min(1).max(100).optional().describe('rows per answer (default 25, max 100)'),
    offset: z.coerce.number().int().min(0).max(10_000).optional().describe('rows to skip: nextOffset from the previous answer'),
  }),
  requires: [F.listingsView, F.inventoryView, F.pricingView],
  category: 'listings',
  riskTier: 'low',
  readOnly: true,
  description:
    'Stock and price of every listing of a product family, per channel and market: the Nexus Matrix page\'s own read. '
    + 'coordinates are the listed channel and market columns (key, e.g. EBAY:IT, AMAZON:DE, EBAY:IT#<aliasId> for a second '
    + 'listing, AMAZON:EU for the ONE Amazon EU merchant quantity every EU market shares); rows are the family\'s products '
    + '(rowId, SKU, master stock and price) with their cells per coordinate key: listing (its state, and selling: the selling '
    + 'state the product sheet\'s Status column shows — active (Active), paused (Inactive), mixed (Mixed: its variations '
    + 'differ), ended (Ended: eBay or Shopify only), draft or not_listed (Not listed: never sent, or deleted by Nexus) — '
    + 'with its reason), sync (FOLLOW the master stock or PINNED, '
    + 'the quantity it would send, the one the channel holds, the buffer), price and sale, fulfilment (FBA quantities are '
    + 'Amazon\'s and never set from Nexus), what can be written there and why not. A change names rowId and coordinate key.',
  async handler(args, ctx) {
    // A deleted product is not found, as in every other tool (the Matrix read finds deleted variations' families).
    if (!(await prisma.product.count({ where: liveProduct(String(args.productId)) }))) return { ok: false, error: PRODUCT_NOT_FOUND }
    let read: Awaited<ReturnType<Awaited<ReturnType<typeof matrixService>>['getMatrixRead']>>
    try {
      const { getMatrixRead } = await matrixService()
      read = await getMatrixRead({ productId: String(args.productId), accountId: null, locale: null, canEditPrice: ctx.can(F.productsPriceEdit) })
    } catch (error) {
      return refusal(error)
    }
    const channel = args.channel as string | undefined
    const market = args.market as string | undefined
    const matches = (c: MatrixCoordinate) => (!channel || c.channel === channel)
      && (!market || c.market === market || (c.sharedInventoryWith ?? []).includes(market))
    const listed = read.coordinates.filter((c) => c.cells.length > 0 && matches(c))
    const notListed = read.coordinates.filter((c) => c.cells.length === 0 && matches(c))
    const keys = new Set(listed.map((c) => c.key))
    const prefix = typeof args.sku === 'string' ? args.sku.toUpperCase() : null
    const rows = read.rows.filter((row) => !prefix || row.sku.toUpperCase().startsWith(prefix))
    const limit = Number(args.limit) || 25
    const offset = Number(args.offset) || 0
    const head = {
      productId: read.productId,
      version: read.version,
      coordinates: listed.map(coordinateOf),
      notListed: notListed.slice(0, 40).map((c) => c.key),
      ...(notListed.length > 40 ? { moreNotListed: notListed.length - 40 } : {}),
      pausedPolicies: read.policies.filter((p) => p.pushesPaused).map(({ channel: ch, market: mk }) => ({ channel: ch, market: mk })),
      totalRows: rows.length,
    }
    // Rows up to the limit and the answer's size budget; a cut answer says where to go on.
    let budget = MAX_RESULT_BYTES - bytes(head) - 200
    const out: ReturnType<typeof rowOf>[] = []
    for (const row of rows.slice(offset, offset + limit)) {
      const item = rowOf(row, keys)
      const size = bytes(item) + 1
      if (out.length > 0 && size > budget) break
      budget -= size
      out.push(item)
    }
    const next = offset + out.length
    return { ok: true, data: { ...head, rows: out, ...(next < rows.length ? { nextOffset: next } : {}) } }
  },
}

// ── media-plan ──────────────────────────────────────────────────────────────────────────────────────

type MediaWorkspace = Awaited<ReturnType<Awaited<ReturnType<typeof mediaService>>['readMediaWorkspace']>>

/** A layout's checks, worst first, capped. */
function checksOf(layout: unknown) {
  const checks = (((layout as { checks?: unknown })?.checks ?? []) as Array<{ severity: string; code: string; message: string; assetId?: string }>)
  const rank = (severity: string) => (severity === 'error' ? 0 : severity === 'warning' ? 1 : 2)
  const sorted = [...checks].sort((a, b) => rank(a.severity) - rank(b.severity))
  return {
    errors: checks.filter((c) => c.severity === 'error').length,
    warnings: checks.filter((c) => c.severity === 'warning').length,
    list: sorted.slice(0, CHECK_CAP).map((c) => ({ severity: c.severity, code: c.code, message: clip(c.message), ...(c.assetId ? { photoId: c.assetId } : {}) })),
  }
}

/** How many different photos a destination's layout places, in its channel's own shape (media-plan-channels.ts). */
function photoCount(channel: string, layout: Record<string, any>): number {
  const ids: unknown[] = channel === 'EBAY' ? [...(layout.gallery ?? []), ...(layout.sets ?? []).flatMap((set: any) => set.items ?? [])]
    : channel === 'AMAZON' ? [layout.parent, ...(layout.items ?? [])].flatMap((item: any) => Object.values(item?.slots ?? {}))
    : channel === 'SHOPIFY' ? [...(layout.media ?? []), ...Object.values(layout.variantImages ?? {})]
    : [...(layout.images ?? []), ...(layout.videos ?? []), ...(layout.variationImages ?? []).map((v: any) => v.assetId)]
  return new Set(ids.filter((id): id is string => typeof id === 'string')).size
}

function destinationOf(workspace: MediaWorkspace, d: MediaWorkspace['destinations'][number]) {
  const layout = (workspace.layouts as Record<string, Record<string, unknown>>)[d.key]
  const checks = layout ? checksOf(layout) : null
  return {
    key: d.key,
    channel: d.channel,
    market: d.marketplace,
    markets: d.markets,
    accountId: d.accountId || null,
    accountLabel: d.accountLabel,
    alias: d.alias,
    languages: d.languages,
    ...(d.api ? { api: d.api } : {}),
    listed: d.listed,
    targetable: d.targetable,
    ...(d.refusal ? { refusal: d.refusal } : {}),
    ...(layout ? { photos: photoCount(d.channel, layout), checks: { errors: checks!.errors, warnings: checks!.warnings } } : {}),
  }
}

/** One destination's layout in full: the photo ids it places, in order, per set or slot. Strings capped, checks capped. */
function layoutOf(workspace: MediaWorkspace, key: string) {
  const layout = (workspace.layouts as Record<string, Record<string, unknown>>)[key]
  if (!layout) return null
  const { checks: _checks, ...rest } = layout
  return { ...rest, checks: checksOf(layout) }
}

const mediaPlan: AgentTool = {
  name: 'media-plan',
  title: 'Photo plan',
  input: z.object({
    productId: productArg,
    destination: z.string().trim().min(1).max(300).optional()
      .describe('a destination key from this tool\'s destinations list, to read that destination\'s full photo layout'),
  }),
  requires: [F.productsView],
  category: 'products',
  riskTier: 'low',
  readOnly: true,
  description:
    'The photos of a product family and where they go: the Nexus Media page\'s own read. onMediaPlan says whether the '
    + 'family\'s photos are managed on the Media page (then every publish sends the plan\'s layout). library lists the '
    + 'family\'s photos (id, label, size, language); destinations lists every channel, market, account and alias the '
    + 'family is listed on, with how many photos its layout places and its problems. Name a destination key to read its '
    + 'full layout (the photo ids in order, per gallery, set or slot). Amazon photos are one set per account and ASIN: '
    + 'they show in every Amazon market.',
  async handler(args) {
    let workspace: MediaWorkspace
    let switched: boolean
    try {
      const productId = String(args.productId)
      // A deleted product is not found, as in every other tool (the Media page's read finds the family root only).
      if (!(await prisma.product.count({ where: liveProduct(productId) }))) return { ok: false, error: PRODUCT_NOT_FOUND }
      const { isMediaSwitched, readMediaWorkspace } = await mediaService()
      workspace = await readMediaWorkspace(productId)
      switched = await isMediaSwitched(productId)
    } catch (error) {
      return refusal(error)
    }
    const key = args.destination as string | undefined
    if (key && !workspace.destinations.some((d) => d.key === key)) {
      return { ok: false, error: 'No destination with this key: read media-plan without one to list them.' }
    }
    const library = workspace.library as Array<{ id: string; label: string; url: string; mediaType: string; width: number | null; height: number | null
      languageTag: string | null; versionGroupId: string | null; isPrimary: boolean; productId: string }>
    const head = {
      productId: workspace.rootId,
      sku: workspace.sku,
      name: clip(workspace.name),
      onMediaPlan: switched,
      mainLanguage: workspace.mainLanguage,
      layers: workspace.layers.map((layer) => ({
        key: layer.key, layer: layer.layer, channel: layer.channel || null, market: layer.marketplace || null,
        accountId: layer.accountId || null, aliasKey: layer.aliasKey || null, revision: layer.revision, updatedAt: layer.updatedAt.toISOString(),
      })),
      destinations: workspace.destinations.map((d) => destinationOf(workspace, d)),
      ...(key ? { layout: { key, ...layoutOf(workspace, key) } } : {}),
      photoCount: library.length,
    }
    // Photos up to the cap and the answer's size budget.
    let budget = MAX_RESULT_BYTES - bytes(head) - 200
    const photos: Array<Record<string, unknown>> = []
    for (const photo of library.slice(0, PHOTO_CAP)) {
      const item = {
        id: photo.id, label: clip(photo.label, 120), type: photo.mediaType, url: photo.url,
        width: photo.width, height: photo.height, language: photo.languageTag,
        ...(photo.versionGroupId ? { versionGroup: photo.versionGroupId } : {}),
        ...(photo.productId !== workspace.rootId ? { ofVariation: photo.productId } : {}),
      }
      const size = bytes(item) + 1
      if (photos.length > 0 && size > budget) break
      budget -= size
      photos.push(item)
    }
    return { ok: true, data: { ...head, library: photos, ...(library.length > photos.length ? { morePhotos: library.length - photos.length } : {}) } }
  },
}

export const LISTING_READ_TOOLS: AgentTool[] = [listingCoordinates, listingMatrix, mediaPlan]
