import prisma from '../../db.js'
import { identityHeld, sellingRisk } from '@nexus/shared/listing-risk'
import { whereCoordinate, type ListingCoordinate } from '../../lib/listing-coordinate.js'
import { fbaPosture } from '../presence/fba-posture.js'
import type { ImpactCheck, NamedCoordinate, OperationalImpactResponse } from '../presence/types.js'

export const OPERATIONAL_IMPACT_TARGET_CAP = 200
type Row = Record<string, unknown>
type Target = { productId: string } | ListingCoordinate
type Source = { rows: Row[]; error: unknown | null }
const strings = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === 'string' && !!v.trim()))]
const rows = (value: unknown): Row[] => Array.isArray(value) ? value : []
const text = (value: unknown): string | null => typeof value === 'string' ? value : null
const isCoordinate = (target: Target): target is ListingCoordinate => 'channel' in target
const problem = (message: string) => Object.assign(new Error(message), { code: 'invalid_impact_request', statusCode: 400 })

export function parseOperationalImpact(body: unknown): { verb: string; targets: Target[] } {
  if (!body || typeof body !== 'object') throw problem('A verb and targets are required.')
  const input = body as Record<string, unknown>
  if (typeof input.verb !== 'string' || !input.verb.trim()) throw problem('verb is required.')
  if (!Array.isArray(input.targets) || !input.targets.length || input.targets.length > OPERATIONAL_IMPACT_TARGET_CAP) throw problem('Name between 1 and 200 targets.')
  if (input.offerScope !== undefined) throw problem('offerScope is unavailable until separate offer identities are supported.')
  const targets = input.targets.map((raw): Target => {
    if (!raw || typeof raw !== 'object' || typeof raw.productId !== 'string' || !raw.productId.trim()) throw problem('Every target needs productId.')
    if (raw.offerScope !== undefined) throw problem('offerScope is unavailable until separate offer identities are supported.')
    if (Object.keys(raw).length === 1) return { productId: raw.productId }
    return whereCoordinate(raw)
  })
  const keys = targets.map(target => JSON.stringify(target))
  if (new Set(keys).size !== keys.length) throw problem('Duplicate targets are not allowed.')
  return { verb: input.verb, targets }
}

async function capture(read: () => Promise<unknown[]>): Promise<Source> {
  try { return { rows: JSON.parse(JSON.stringify(await read())), error: null } }
  catch (error) { return { rows: [], error } }
}

/** Five legacy checks stay batched. Added sources have their own failure arms. */
async function loadSources(ids: string[], legacy: boolean) {
  const products = capture(() => prisma.product.findMany({ where: { id: { in: ids } }, select: { id: true, sku: true, fulfillmentMethod: true } }))
  const listings = capture(() => prisma.channelListing.findMany({
    where: { productId: { in: ids }, ...(legacy ? { listingStatus: { in: ['ACTIVE', 'INACTIVE'] }, externalListingId: { not: null } } : {}) },
    select: { id: true, productId: true, channel: true, marketplace: true, region: true, externalListingId: true,
      channelConnectionId: true, aliasKey: true, fulfillmentMethod: true, platformAttributes: true,
      offers: { select: { sku: true, fulfillmentMethod: true, isActive: true } },
      product: { select: { sku: true } }, channelConnection: { select: { displayName: true } }, alias: { select: { label: true } } },
  }))
  const orders = capture(() => prisma.orderItem.findMany({
    where: { productId: { in: ids }, order: { status: { notIn: ['DELIVERED', 'CANCELLED', 'REFUNDED', 'RETURNED'] }, deletedAt: null } },
    select: { productId: true, order: { select: { id: true, channelOrderId: true, channel: true, status: true, marketplace: true, channelConnectionId: true } } },
  }))
  const masters = capture(() => prisma.bundle.findMany({ where: { productId: { in: ids }, isActive: true }, select: { id: true, productId: true, name: true } }))
  const components = capture(() => prisma.bundleComponent.findMany({ where: { productId: { in: ids }, bundle: { isActive: true } }, select: { productId: true, bundleId: true, bundle: { select: { productId: true, name: true } } } }))
  const bundleListings = capture(async () => {
    const [m, c] = await Promise.all([masters, components])
    const masterIds = strings([...m.rows.map(row => row.productId), ...c.rows.map(row => (row.bundle as Row | null)?.productId)])
    const additionalIds = masterIds.filter(id => !ids.includes(id))
    if (!additionalIds.length || legacy) return []
    return prisma.channelListing.findMany({ where: { productId: { in: additionalIds }, externalListingId: { not: null } },
      select: { productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, externalListingId: true,
        product: { select: { sku: true } }, channelConnection: { select: { displayName: true } }, alias: { select: { label: true } } } })
  })
  const inventory = capture(async () => {
    const [p, l] = await Promise.all([products, listings])
    const skus = strings([...p.rows.map(row => row.sku), ...l.rows.flatMap(row => rows(row.offers).map(offer => offer.sku))])
    const asins = strings(l.rows.filter(row => row.channel === 'AMAZON').map(row => row.externalListingId))
    return prisma.fbaInventoryDetail.findMany({
      where: legacy ? { productId: { in: ids }, quantity: { gt: 0 } } : {
        OR: [{ productId: { in: ids } }, ...(skus.length ? [{ sku: { in: skus } }] : []), ...(asins.length ? [{ asin: { in: asins } }] : [])],
      },
      select: { id: true, productId: true, sku: true, asin: true, marketplaceId: true, fulfillmentCenterId: true, quantity: true, condition: true, lastSyncedAt: true },
    })
  })
  const stock = capture(() => prisma.stockLevel.findMany({ where: { productId: { in: ids } },
    select: { id: true, productId: true, variationId: true, quantity: true, available: true, reserved: true, lastSyncedAt: true,
      location: { select: { code: true } }, reservations: { where: { kind: 'HARD', releasedAt: null, consumedAt: null, orderId: { not: null } },
        select: { id: true, quantity: true, orderId: true, kind: true, expiresAt: true } } },
  }))
  const ads = capture(async () => {
    const l = await listings
    const asins = strings(l.rows.filter(row => row.channel === 'AMAZON').map(row => row.externalListingId))
    return prisma.adProductAd.findMany({ where: { status: 'ENABLED', OR: [{ productId: { in: ids } }, ...(asins.length ? [{ asin: { in: asins } }] : [])] },
      select: { id: true, productId: true, adGroupId: true, adGroup: { select: { campaignId: true } }, asin: true, sku: true, spendCents: true, lastSyncedAt: true } })
  })
  const markets = capture(() => prisma.marketplace.findMany({ where: { channel: 'AMAZON' }, select: { code: true, marketplaceId: true, fbaProgram: true } }))
  const result = await Promise.all([products, listings, orders, masters, components, inventory, stock, ads, markets, bundleListings])
  return Object.fromEntries(['products', 'listings', 'orders', 'masters', 'components', 'inventory', 'stock', 'ads', 'markets', 'bundleListings'].map((name, i) => [name, result[i]])) as Record<'products' | 'listings' | 'orders' | 'masters' | 'components' | 'inventory' | 'stock' | 'ads' | 'markets' | 'bundleListings', Source>
}

function namedListing(row: Row): NamedCoordinate {
  const coordinate = whereCoordinate(row as unknown as ListingCoordinate)
  const sku = text((row.product as Row | null)?.sku)
  const accountLabel = text((row.channelConnection as Row | null)?.displayName)
  const aliasLabel = text((row.alias as Row | null)?.label)
  return { coordinate, sku, sellerSku: null, sellerSkuSource: null, accountLabel, aliasLabel,
    label: `${sku ?? coordinate.productId} · ${coordinate.channel} · ${coordinate.marketplace} · ${accountLabel ?? coordinate.channelConnectionId ?? 'unattributed account'} · ${aliasLabel ?? (coordinate.aliasKey || 'primary alias')}` }
}

type Sources = Awaited<ReturnType<typeof loadSources>>
const forProduct = (source: Source, target: Target) => source.rows.filter(row => row.productId === target.productId)
const accountMatches = (value: unknown, target: ListingCoordinate) => value === null || value === target.channelConnectionId
const latest = (data: Row[], field: string) => strings(data.map(row => row[field])).sort().at(-1) ?? null
function check(source: Source, scope: ImpactCheck['scope'], dimensions: string[], provenance: string[], data: Row[], blocking: boolean): ImpactCheck {
  return { status: source.error ? 'unavailable' : 'ok', scope, dimensions, provenance, asOf: null, blocking,
    refusal: source.error ? `Could not read ${provenance.join(' and ')}.` : null, rows: data }
}
function unavailable(value: ImpactCheck, sentence: string) { return { ...value, status: 'unavailable' as const, refusal: sentence } }

function checksFor(s: Sources, target: Target, verb: string): OperationalImpactResponse['targets'][number]['checks'] {
  const coordinate = isCoordinate(target) ? target : null
  const destructive = ['hard-delete', 'delete-product', 'delete-variant'].includes(verb)
  const localListings = forProduct(s.listings, target)
  const listingRows = localListings.filter(row => identityHeld(row) && (!coordinate || (
    row.channel === coordinate.channel && (row.marketplace ?? row.region) === coordinate.marketplace &&
    row.channelConnectionId === coordinate.channelConnectionId && row.aliasKey === coordinate.aliasKey)))
  const channelListings = check(s.listings, 'coordinate', ['productId', 'channel', 'marketplace', 'channelConnectionId', 'aliasKey'], ['ChannelListing'], listingRows, destructive)
  const orderChannels: Record<string, string> = { AMAZON: 'AMAZON', EBAY: 'EBAY', SHOPIFY: 'SHOPIFY', WOOCOMMERCE: 'WOOCOMMERCE', ETSY: 'ETSY', MANUAL: 'MANUAL' }
  const orderRows = forProduct(s.orders, target).flatMap(row => {
    const order = row.order as Row | null
    if (!order || coordinate && (order.channel !== orderChannels[coordinate.channel] ||
      order.marketplace != null && order.marketplace !== coordinate.marketplace || !accountMatches(order.channelConnectionId, coordinate))) return []
    return [{ productId: row.productId, orderId: order.id, channelOrderId: order.channelOrderId, channel: order.channel, status: order.status,
      marketplace: order.marketplace, marketplaceUnknown: order.marketplace == null, channelConnectionId: order.channelConnectionId, aliasScoped: false }]
  })
  let openOrders = check(s.orders, coordinate ? 'coordinate' : 'product', ['productId', 'channel', 'marketplace', 'channelConnectionId'], ['OrderItem', 'Order'], orderRows, destructive)
  if (coordinate && !Object.prototype.hasOwnProperty.call(orderChannels, coordinate.channel)) openOrders = unavailable(openOrders, `Open orders do not have a channel mapping for ${coordinate.channel}.`)
  const bundleRows: Row[] = [
    ...forProduct(s.masters, target).map(row => ({ productId: row.productId, bundleId: row.id, bundleName: row.name, masterProductId: row.productId, role: 'master' })),
    ...forProduct(s.components, target).map(row => ({ productId: row.productId, bundleId: row.bundleId, bundleName: (row.bundle as Row | null)?.name, masterProductId: (row.bundle as Row | null)?.productId, role: 'component' })),
  ]
  for (const row of bundleRows) row.masterCoordinates = [...s.listings.rows, ...s.bundleListings.rows].filter(listing => listing.productId === row.masterProductId && identityHeld(listing)).map(namedListing)
  const activeBundles = check({ rows: [], error: s.masters.error ?? s.components.error ?? s.bundleListings.error ?? s.listings.error }, 'product', ['productId'], ['Bundle', 'BundleComponent', 'ChannelListing'], bundleRows, destructive)
  const product = s.products.rows.find(row => row.id === target.productId)
  const asins = strings(localListings.filter(row => row.channel === 'AMAZON').map(row => row.externalListingId))
  const stockRows = forProduct(s.stock, target)
  const fba = fbaPosture({ product, listings: localListings, inventory: s.inventory.rows, stock: stockRows, markets: s.markets.rows, target,
    namedCoordinates: localListings.map(namedListing), error: s.products.error ?? s.listings.error ?? s.inventory.error ?? s.stock.error ?? s.markets.error })
  const stockHolds = check(s.stock, 'product', ['productId', 'variationId'], ['StockLevel', 'StockReservation'], coordinate || !destructive ? [] : stockRows, false)
  stockHolds.asOf = latest(stockRows, 'lastSyncedAt')
  if (coordinate || !destructive) { stockHolds.status = 'unavailable'; stockHolds.refusal = 'Stock-ledger holds apply to product deletion, not this coordinate action.' }
  const advertisingRows = s.ads.rows.filter(row => row.productId === target.productId || asins.includes(String(row.asin)))
    .filter(row => !coordinate || coordinate.channel === 'AMAZON' && listingRows.some(listing => listing.externalListingId === row.asin))
    .map(row => ({ ...row, campaignId: (row.adGroup as Row | null)?.campaignId, spendSentence: 'Cumulative recorded spend, as of lastSyncedAt.', nextStep: 'suppressCampaignBids' }))
  const advertising = check({ rows: [], error: s.ads.error ?? s.listings.error }, coordinate ? 'coordinate' : 'product', ['productId', 'asin'], ['AdProductAd'], advertisingRows, false)
  advertising.asOf = latest(advertisingRows, 'lastSyncedAt')
  if (coordinate && coordinate.channel !== 'AMAZON') { advertising.status = 'unavailable'; advertising.refusal = 'This check reads Amazon product ads; advertising on this channel was not checked.' }
  return { channelListings, openOrders, activeBundles, fbaPosture: fba, stockHolds, advertising }
}

export async function readOperationalImpact(input: ReturnType<typeof parseOperationalImpact>): Promise<OperationalImpactResponse> {
  const sources = await loadSources(strings(input.targets.map(target => target.productId)), false)
  return { readAt: new Date().toISOString(), targets: input.targets.map(target => ({ target, checks: checksFor(sources, target, input.verb) })) }
}

/** Preserve every legacy response key, condition/role and the exact attempt predicate. */
export async function readHardDeletePreflight(ids: string[]) {
  const s = await loadSources(ids, true)
  for (const name of ['listings', 'orders', 'masters', 'components', 'inventory'] as const) if (s[name].error) throw s[name].error
  const only = ids.length === 1 ? s.products.rows.find(row => row.id === ids[0]) : null
  const confirmPhrase = text(only?.sku)
  return {
    channelListings: s.listings.rows.filter(row => sellingRisk(row)).map(l => ({ productId: l.productId, channel: l.channel, marketplace: l.marketplace ?? l.region, externalListingId: l.externalListingId })),
    openOrders: s.orders.rows.filter(oi => !!oi.productId && !!oi.order).map(oi => { const order = oi.order as Row; return { productId: oi.productId, orderId: order.id, channelOrderId: order.channelOrderId, channel: order.channel, status: order.status } }),
    activeBundles: [...s.masters.rows.map(b => ({ productId: b.productId, bundleId: b.id, role: 'master' as const })), ...s.components.rows.map(c => ({ productId: c.productId, bundleId: c.bundleId, role: 'component' as const }))],
    fbaInventory: s.inventory.rows.map(f => ({ productId: f.productId, marketplaceId: f.marketplaceId, fulfillmentCenterId: f.fulfillmentCenterId, quantity: f.quantity, condition: f.condition })),
    confirmPhrase,
    refusal: confirmPhrase ? null : ids.length > 1 ? 'Confirm permanent deletion one product at a time using its SKU.' : 'The product SKU could not be read. Reload before confirming permanent deletion.',
    checks: ids.map(productId => { const checks = checksFor(s, { productId }, 'hard-delete'); return { productId, stockHolds: checks.stockHolds, advertising: checks.advertising } }),
  }
}
