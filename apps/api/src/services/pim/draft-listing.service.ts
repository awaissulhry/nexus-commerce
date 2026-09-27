/**
 * The ONE place a Nexus-created draft listing is decided (product-sheet create path, step 2;
 * the Owner's D1 = A and D2 = A, 2026-09-27; docs/product-sheet-create-path/RESEARCH-2026-09-27.md §5).
 *
 * A draft is born on the first channel-scope save on a coordinate (channel + market + account + alias)
 * where the product has no listing. It is INERT:
 *   - `syncPaused: true` — the stock cascade, every dispatcher (push lock), drift detection and both
 *     read-backs skip it (`sync-control-core.ts`, `packages/shared/push-lock.ts`);
 *   - `isPublished: false` — outside the EU shared-quantity guard's siblings, the Amazon read-back,
 *     automation and auto-publish;
 *   - `listingStatus: 'DRAFT'` and no external id — outside delist, content drift and the Shopify read-back;
 *   - `quantity` and `price` null — no drift alert.
 * Only Publish sends anything to a channel.
 *
 * Rules:
 *   - Account: the named account when it is an ACTIVE connection of the channel, otherwise (none named) the
 *     channel's primary active account. Never null, and a named account never falls back to another store.
 *   - Market: an active `Marketplace` row of the channel (as `workspace-destination.ts` requires).
 *   - Alias: only the primary listing (`aliasKey ''`) is created here. A non-primary alias listing must
 *     already exist (`POST /products/:id/aliases` makes those rows); it is returned, never created.
 *   - Family (`family: true`): when the family has NO row on the coordinate, the draft is born as the parent
 *     plus every live variant — a variant with no row counts as EXCLUDED (`family-projection.service.ts`,
 *     "absence IS exclusion"), so a parent-only draft would read "0 of N variants". When the family already
 *     has a row there, the parent, the variants that have a row and the requested products are ensured: an
 *     absent variant nobody asked for stays absent, so an edit never re-includes variants a listing leaves out.
 *     Either way the result is the family's whole listing on the coordinate.
 *
 * It runs on the caller's transaction client and opens none of its own, calls no channel and publishes no
 * event: no draft creator publishes `listing.created` (only the wizard and eBay publish do, for listings
 * that went live). The caller refreshes the product read cache for created rows after commit, as
 * `bulk-edit.service.ts` does for the products it saves.
 *
 * Concurrency: rows are inserted with ON CONFLICT DO NOTHING against the coordinate's unique key
 * (`ChannelListing_productId_channel_marketplace_akey_key`: workspaceId, productId, channel, marketplace,
 * channelConnectionId, aliasKey — NULLS NOT DISTINCT), so two concurrent calls create one set. Under READ
 * COMMITTED the later call waits for the first and reports its rows as `created: false`; under REPEATABLE
 * READ or SERIALIZABLE it fails with a serialization error, which `inDatabaseTransaction` retries.
 */
import type { Prisma } from '@prisma/client'
import { channelLabel } from '@nexus/shared/channel-label'
import { whereCoordinate } from '../../lib/listing-coordinate.js'
import { chooseConnection, listActiveConnections } from '../connection-resolver.service.js'
import { validateAliasWriteTargets } from './listing-alias.service.js'

export interface EnsureDraftListingsInput {
  channel: string
  market: string
  /** The scope's account. Omitted or null: the channel's primary active account. */
  accountId?: string | null
  /** '' (the default) is the primary listing — the only one created here. */
  aliasKey?: string
  productIds: string[]
  family?: boolean
}

export interface EnsuredDraftListing {
  id: string
  productId: string
  version: number
  /** True only for a row THIS call inserted. */
  created: boolean
}

export type DraftListingErrorCode =
  | 'INVALID_REQUEST'
  | 'NO_ACTIVE_ACCOUNT'
  | 'ACCOUNT_UNAVAILABLE'
  | 'MARKET_UNAVAILABLE'
  | 'PRODUCT_UNAVAILABLE'
  | 'ALIAS_LISTING_MISSING'
  | 'COORDINATE_TAKEN'

export class DraftListingError extends Error {
  constructor(readonly code: DraftListingErrorCode, message: string, readonly statusCode = 409) {
    super(message)
    this.name = 'DraftListingError'
  }
}

type Tx = Prisma.TransactionClient

/** "an Amazon", "an eBay", "an Etsy"; "a Shopify", "a WooCommerce". */
const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

/**
 * Ensure a listing row exists on one coordinate for every requested product (and, with `family`, its family),
 * creating inert drafts for the missing ones. Returns every ensured row, existing rows included: without `family` in
 * the request's order; with it, per family (in the request's order) the parent first, then its variants by SKU.
 */
export async function ensureDraftListings(tx: Tx, input: EnsureDraftListingsInput): Promise<EnsuredDraftListing[]> {
  const channel = String(input.channel ?? '').trim().toUpperCase()
  const market = String(input.market ?? '').trim().toUpperCase()
  const aliasKey = input.aliasKey ?? ''
  if (!channel || !market) throw new DraftListingError('INVALID_REQUEST', 'Choose a channel and a market.', 400)
  if (typeof aliasKey !== 'string') throw new DraftListingError('INVALID_REQUEST', 'A listing alias must be text.', 400)
  if (input.accountId !== undefined && input.accountId !== null && (typeof input.accountId !== 'string' || !input.accountId.trim())) {
    throw new DraftListingError('INVALID_REQUEST', 'Name an account, or leave it out for the primary account.', 400)
  }
  if (!Array.isArray(input.productIds) || input.productIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new DraftListingError('INVALID_REQUEST', 'Every product needs an id.', 400)
  }
  const requested = [...new Set(input.productIds)]
  if (requested.length === 0) return []

  const label = channelLabel(channel)
  const marketplace = await tx.marketplace.findFirst({ where: { channel, code: market, isActive: true }, select: { id: true } })
  if (!marketplace) throw new DraftListingError('MARKET_UNAVAILABLE', `${label} · ${market} is not an active market in this business.`, 400)
  const accountId = await resolveDraftAccount(tx, channel, market, label, input.accountId ?? null)

  const ensure = await productsToEnsure(tx, requested, input.family === true, { channel, market, accountId, aliasKey })
  if (aliasKey !== '') {
    // A pasted alias id is no authority over another family's or account's listing (throws AliasScopeMismatchError).
    await validateAliasWriteTargets(ensure.order.map(productId => ({ productId, channel, marketplace: market, connectionId: accountId, aliasKey })), tx)
  }

  const missing = ensure.order.filter(productId => !ensure.existing.has(productId))
  if (missing.length > 0 && aliasKey !== '') {
    const skus = ensure.skus(missing)
    throw new DraftListingError('ALIAS_LISTING_MISSING',
      `This listing alias has no ${label} · ${market} listing for ${skus}. An edit never creates an alias listing.`)
  }

  // One insert order for every caller (by product id): two calls that name the same products in another order then
  // queue on the unique key instead of deadlocking on it.
  const inserted = missing.length === 0 ? [] : await tx.channelListing.createManyAndReturn({
    data: [...missing].sort().map(productId => draftListingData({ productId, channel, market, accountId })),
    skipDuplicates: true,
    select: { id: true, productId: true, version: true },
  })
  const createdIds = new Set(inserted.map(row => row.id))

  // A skipped insert is a row another transaction committed first (READ COMMITTED): read what is there now.
  const rows = inserted.length === missing.length
    ? [...ensure.existing.values(), ...inserted]
    : await tx.channelListing.findMany({ where: coordinateWhere(ensure.order, { channel, market, accountId, aliasKey }), select: { id: true, productId: true, version: true } })
  const byProduct = new Map(rows.map(row => [row.productId, row]))
  const absent = ensure.order.filter(productId => !byProduct.has(productId))
  if (absent.length > 0) {
    // ON CONFLICT DO NOTHING also yields to the legacy `channelMarket` key: a row of this product with the same
    // `${channel}_${market}` under another `marketplace` spelling. Refuse rather than report a row that is not there.
    throw new DraftListingError('COORDINATE_TAKEN',
      `${ensure.skus(absent)} already has ${withArticle(label)} ${market} listing recorded under another market name. Fix that listing before starting a draft here.`)
  }
  return ensure.order.map(productId => {
    const row = byProduct.get(productId)!
    return { id: row.id, productId, version: row.version, created: createdIds.has(row.id) }
  })
}

/** Every field of a Nexus-created draft is decided here, and only here. */
function draftListingData(c: { productId: string; channel: string; market: string; accountId: string }): Prisma.ChannelListingCreateManyInput {
  return {
    productId: c.productId,
    channel: c.channel,
    marketplace: c.market,
    channelMarket: `${c.channel}_${c.market}`,
    region: c.market,
    channelConnectionId: c.accountId,
    aliasKey: '',
    aliasId: null,
    listingStatus: 'DRAFT',
    isPublished: false,
    syncPaused: true,
    externalListingId: null,
    quantity: null,
    price: null,
  }
}

async function resolveDraftAccount(tx: Tx, channel: string, market: string, label: string, accountId: string | null): Promise<string> {
  const active = await listActiveConnections(channel, tx)
  if (active.length === 0) throw new DraftListingError('NO_ACTIVE_ACCOUNT', `Connect ${withArticle(label)} account before listing on ${market}.`)
  if (accountId !== null) {
    const named = active.find(connection => connection.id === accountId)
    if (!named) {
      throw new DraftListingError('ACCOUNT_UNAVAILABLE',
        `The selected ${label} account is not connected. Reconnect it or choose another account before listing on ${market}.`)
    }
    return named.id
  }
  // Several active accounts and none primary → AmbiguousConnectionError (409): the caller must name one.
  return chooseConnection(active, { channel, wantPrimary: true }).id
}

type Coordinate = { channel: string; market: string; accountId: string; aliasKey: string }

/** The same predicate for every product, validated level by level (`whereCoordinate`). */
function coordinateWhere(productIds: string[], c: Coordinate): Prisma.ChannelListingWhereInput {
  if (productIds.length === 0) throw new Error('coordinateWhere needs at least one product.')
  const levels = productIds.map(productId => whereCoordinate({ productId, channel: c.channel, marketplace: c.market, channelConnectionId: c.accountId, aliasKey: c.aliasKey }))
  return { ...levels[0], productId: { in: productIds } }
}

type Member = { id: string; parentId: string | null; sku: string }
type ExistingRow = { id: string; productId: string; version: number }

async function productsToEnsure(tx: Tx, requested: string[], family: boolean, c: Coordinate) {
  const select = { id: true, parentId: true, sku: true } as const
  const products: Member[] = await tx.product.findMany({ where: { id: { in: requested }, deletedAt: null }, select })
  if (products.length !== requested.length) {
    throw new DraftListingError('PRODUCT_UNAVAILABLE', 'A product in this save is no longer available. Reload and try again.', 404)
  }
  const sku = new Map(products.map(p => [p.id, p.sku]))
  const skus = (ids: string[]) => ids.map(id => sku.get(id) ?? id).join(', ')
  const readExisting = async (ids: string[]) => {
    const rows: ExistingRow[] = await tx.channelListing.findMany({ where: coordinateWhere(ids, c), select: { id: true, productId: true, version: true } })
    return new Map(rows.map(row => [row.productId, row]))
  }
  if (!family) return { order: requested, existing: await readExisting(requested), skus }

  // The family rule every studio read uses (`resolveFamilyRoot`): the root is the parent, or the product itself.
  const byId = new Map(products.map(p => [p.id, p]))
  const rootIds = [...new Set(requested.map(id => byId.get(id)!.parentId ?? id))]
  const [roots, children] = await Promise.all([
    tx.product.findMany({ where: { id: { in: rootIds }, deletedAt: null }, select }),
    tx.product.findMany({ where: { parentId: { in: rootIds }, deletedAt: null }, select, orderBy: { sku: 'asc' } }),
  ])
  if (roots.length !== rootIds.length || roots.some(root => root.parentId)) {
    throw new DraftListingError('PRODUCT_UNAVAILABLE', 'The family changed. Reload the product.')
  }
  for (const row of [...roots, ...children]) sku.set(row.id, row.sku)
  const families = rootIds.map(rootId => [rootId, ...children.filter(child => child.parentId === rootId).map(child => child.id)])
  const existing = await readExisting(families.flat())
  const wanted = new Set(requested)
  // Born whole when the family has no row here. Otherwise: the parent, the variants the listing has, and the ones
  // asked for — an absent variant nobody asked for stays absent (excluded).
  const order = families.flatMap(([rootId, ...variants]) => {
    const born = ![rootId, ...variants].some(member => existing.has(member))
    return [rootId, ...variants.filter(variant => born || existing.has(variant) || wanted.has(variant))]
  })
  return { order, existing, skus }
}
