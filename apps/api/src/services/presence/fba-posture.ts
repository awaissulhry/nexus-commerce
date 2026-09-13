import { isFbaCoordinate } from '../../lib/amazon-fulfillment.js'
import type { ImpactCheck, ListingCoordinate, NamedCoordinate } from './types.js'

type Row = Record<string, unknown>
export interface FbaPostureInput {
  product: Row | undefined
  listings: Row[]
  inventory: Row[]
  stock: Row[]
  markets: Row[]
  target: { productId: string } | ListingCoordinate
  namedCoordinates: NamedCoordinate[]
  error: unknown | null
}
const strings = (values: unknown[]) => [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim() !== ''))]
const offersOf = (row: Row): Row[] => Array.isArray(row.offers) ? row.offers : []
const stringOrNull = (value: unknown) => typeof value === 'string' ? value : null

/** One projection for impact and Amazon posture. Local snapshots never claim a fresh observation. */
export function fbaPosture(input: FbaPostureInput): ImpactCheck {
  const { product, listings, stock, markets, target } = input
  const coordinate = 'channel' in target ? target : null
  const amazonListings = listings.filter(row => row.channel === 'AMAZON')
  const skus = strings([product?.sku, ...amazonListings.flatMap(row => offersOf(row).map(offer => offer.sku))])
  const asins = strings(amazonListings.map(row => row.externalListingId))
  const market = coordinate ? markets.find(row => row.code === coordinate.marketplace) : null
  const pooledMarkets = markets.filter(row => row.fbaProgram === 'PAN_EU')
  const pooled = coordinate ? market?.fbaProgram === 'PAN_EU' : amazonListings.some(row => pooledMarkets.some(m => m.code === row.marketplace))
  const detail: Row[] = input.inventory.filter(row => row.productId === target.productId || skus.includes(String(row.sku)) || asins.includes(String(row.asin)))
    .filter(row => !coordinate || pooled || row.marketplaceId === market?.marketplaceId)
    .map(row => ({ ...row, matchedBy: row.productId === target.productId ? 'productId' : skus.includes(String(row.sku)) ? 'sku' : 'asin' }))
  const fbaStock = stock.filter(row => (row.location as Row | null)?.code === 'AMAZON-EU-FBA')
  const stockUnits = fbaStock.reduce((total, row) => total + Number(row.quantity ?? 0), 0)
  const hasActiveFbaOffer = amazonListings.some(row => offersOf(row).some(offer => offer.isActive === true && offer.fulfillmentMethod === 'FBA'))
  const productEvidence = { fulfillmentMethod: stringOrNull(product?.fulfillmentMethod) }
  const evidence = { fbaStockQty: stockUnits, hasActiveFbaOffer }
  const localFba = isFbaCoordinate(null, productEvidence, evidence) || amazonListings.some(row => isFbaCoordinate({ fulfillmentMethod: stringOrNull(row.fulfillmentMethod), platformAttributes: row.platformAttributes }, productEvidence, evidence))
  const fulfillmentDeclared = isFbaCoordinate(null, productEvidence) || amazonListings.some(row => isFbaCoordinate({ fulfillmentMethod: stringOrNull(row.fulfillmentMethod), platformAttributes: row.platformAttributes }, productEvidence))
  const isFba = localFba || detail.some(row => Number(row.quantity) > 0)

  // PAN_EU snapshots can repeat the same fulfilment centre in several markets.
  // A repeated centre cannot establish whether the market snapshots describe the same physical lot.
  const pool = new Map<string, Row>()
  let ambiguousPool = false
  for (const row of detail) {
    const key = JSON.stringify([row.sku, row.fulfillmentCenterId, row.condition])
    const previous = pool.get(key)
    if (pooled && previous) ambiguousPool = true
    else pool.set(key, row)
  }
  const inventory = pooled ? [...pool.values()] : detail
  const measurable = !input.error && detail.length > 0 && !ambiguousPool
  const units = measurable ? inventory.reduce((total, row) => total + Number(row.quantity), 0) : null
  const sellable = measurable ? inventory.filter(row => row.condition === 'SELLABLE').reduce((total, row) => total + Number(row.quantity), 0) : null
  // Oldest contributing snapshot prevents the freshest row from disguising stale stock.
  const asOf = strings(detail.map(row => row.lastSyncedAt)).sort()[0] ?? null
  let refusal: string | null = input.error ? 'Could not read all FBA posture sources; quantity and absence are unknown.' : null
  if (coordinate && coordinate.channel !== 'AMAZON') refusal = 'FBA posture is an Amazon check; this coordinate is not Amazon.'
  else if (coordinate && !market) refusal = 'The Amazon marketplace could not be identified; inventory coverage is unknown.'
  else if (ambiguousPool) refusal = 'FBA snapshots overlap across markets; a shared quantity cannot be established from these records.'
  else if (isFba && !detail.length) refusal = 'Amazon-managed fulfilment is recorded, but inventory detail is unavailable; units are not zero.'
  const check: ImpactCheck = {
    status: refusal ? 'unavailable' : 'ok', scope: coordinate ? 'coordinate' : 'product',
    dimensions: ['productId', 'sku', 'asin', 'marketplaceId'],
    provenance: ['Product.fulfillmentMethod', 'ChannelListing.fulfillmentMethod', 'Offer', 'StockLevel', 'FbaInventoryDetail', 'Marketplace'],
    asOf, blocking: false, refusal,
    rows: coordinate && coordinate.channel !== 'AMAZON' ? [] : [{
      productId: target.productId, isFba: input.error && !isFba ? null : isFba,
      via: [...(fulfillmentDeclared ? ['fulfillmentMethod'] : []), ...(stockUnits > 0 ? ['stockLevel'] : []), ...(detail.length ? ['inventoryDetail'] : []), ...(hasActiveFbaOffer ? ['Offer'] : [])],
      units, sellable, notSellable: units != null && sellable != null ? units - sellable : null,
      pooled: input.error ? null : pooled,
      pooledAcross: pooled ? input.namedCoordinates.filter(named => named.coordinate.channel === 'AMAZON' && pooledMarkets.some(row => row.code === named.coordinate.marketplace)) : [],
      quantityScope: pooled ? 'eu-pooled' : 'market-snapshot', accountAttribution: 'account-unattributed',
      detail, asOf,
    }],
  }
  return check
}
