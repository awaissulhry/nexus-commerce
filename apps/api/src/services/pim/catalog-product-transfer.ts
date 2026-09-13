import { normalizeLanguage } from './content-language.js'
import { PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { listActiveConnections } from '../connection-resolver.service.js'
import type { Prisma } from '@prisma/client'
import { TRANSFER_CHANNELS, type ProductTransferBoundary, ProductTransferOptions, ProductTransferSelection, TransferRow } from '@nexus/shared/catalog-transfer'
import prisma from '../../db.js'
import { marketLanguages } from './market-languages.js'
import { TransferConflict } from './catalog-transfer.service.js'

const productIdentity = { id: true, sku: true, parentId: true } as const
const listingIdentity = { id: true, productId: true, channel: true, channelConnectionId: true, marketplace: true, aliasKey: true } as const
const listingKey = (row: Pick<TransferRow, 'sku' | 'channel' | 'accountId' | 'marketplace' | 'aliasKey'>) => JSON.stringify([row.sku, row.channel, row.accountId, row.marketplace, row.aliasKey])
const indexes = new WeakMap<ProductTransferBoundary, { products: Map<string, ProductTransferBoundary['products'][number]>; listings: Map<string, ProductTransferBoundary['listings'][number]> }>()
function boundaryIndex(boundary: ProductTransferBoundary) {
  let index = indexes.get(boundary)
  if (!index) {
    const skuById = new Map(boundary.products.map(p => [p.id, p.sku]))
    index = { products: new Map(boundary.products.map(p => [p.sku, p])), listings: new Map(boundary.listings.map(l => [listingKey({ ...l, sku: skuById.get(l.productId)! }), l])) }
    indexes.set(boundary, index)
  }
  return index
}
const validLocale = (s: string) => /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(s)

export async function productTransferOptions(productId: string): Promise<ProductTransferOptions> {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: productIdentity })
  if (!product) throw new Error('This product is unavailable')
  const rootId = product.parentId ?? product.id
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: rootId }, { parentId: rootId }] }, select: productIdentity, orderBy: { sku: 'asc' }, take: 501 })
  if (!products.some(p => p.id === rootId)) throw new Error('The parent product is unavailable')
  if (products.length > 500) throw new Error('Use Catalog import & export for groups larger than 500 products')
  const [listings, accounts, markets, content, aliases, root] = await Promise.all([
    prisma.channelListing.findMany({ where: { productId: { in: products.map(p => p.id) }, channel: { in: TRANSFER_CHANNELS } }, select: listingIdentity, orderBy: { id: 'asc' }, take: 5001 }),
    Promise.all(TRANSFER_CHANNELS.map(channel => listActiveConnections(channel))).then(accounts => accounts.flat()),
    prisma.marketplace.findMany({ where: { isActive: true }, select: { channel: true, code: true, name: true, language: true, languages: true }, orderBy: { code: 'asc' } }),
    prisma.product.findMany({ where: { id: { in: products.map(p => p.id) } }, select: { translations: { select: { language: true } } } }),
    prisma.productListingAlias.findMany({ where: { productId: rootId }, select: { id: true, label: true, status: true } }),
    prisma.product.findUnique({ where: { id: rootId }, select: { familyId: true } }),
  ])
  if (listings.length > 5000) throw new Error('Use Catalog import & export for groups larger than 5,000 listings')
  const locales = [...new Set([PRIMARY_CONTENT_LOCALE, ...content.flatMap(p => p.translations.map(row => normalizeLanguage(row.language))), ...markets.flatMap(m => marketLanguages(m.channel, m.code, [m]))])].filter(validLocale).sort()
  const aliasById = new Map(aliases.map(a => [a.id, a]))
  return { productId, rootId, products, locales, familyId: root?.familyId ?? null,
    listings: listings.filter(l => !l.aliasKey || aliasById.get(l.aliasKey)?.status === 'ACTIVE').map(l => ({ id: l.id, productId: l.productId, channel: l.channel, accountId: l.channelConnectionId ?? '', marketplace: l.marketplace, aliasKey: l.aliasKey,
      aliasLabel: l.aliasKey ? aliasById.get(l.aliasKey)?.label || `Listing ${l.aliasKey.slice(-6)}` : 'Primary listing' })),
    accounts: accounts.map(a => ({ id: a.id, channelType: a.channelType, marketplace: a.marketplace, accountLabel: a.accountLabel, displayName: `${a.accountLabel || a.displayName || a.channelType} · ${a.id.slice(-6)}` })),
    markets: markets.map(m => ({ ...m, language: marketLanguages(m.channel, m.code, [m])[0] })),
  }
}

function ids(value: unknown, name: string, max: number) {
  if (!Array.isArray(value) || value.length > max || value.some(v => typeof v !== 'string' || !v.trim()) || new Set(value).size !== value.length) throw new Error(`Select valid ${name}`)
  return value as string[]
}

export async function resolveProductTransferBoundary(productId: string, input: ProductTransferSelection): Promise<ProductTransferBoundary> {
  if (!input || typeof input.includeShared !== 'boolean') throw new Error('Select shared details or existing listings')
  const productIds = ids(input.productIds, 'products', 500), listingIds = ids(input.listingIds, 'listings', 5000), locales = [...new Set(ids(input.locales, 'languages', 100).map(normalizeLanguage))]
  if (!productIds.length || !input.includeShared && !listingIds.length) throw new Error('Select at least one product and a data destination')
  if (!input.includeShared && locales.length) throw new Error('Shared languages require shared product details')
  const options = await productTransferOptions(productId)
  const products = options.products.filter(p => productIds.includes(p.id))
  if (products.length !== productIds.length) throw new Error('Every selected SKU must belong to this product and its variants')
  const listings = options.listings.filter(l => listingIds.includes(l.id) && productIds.includes(l.productId))
  if (listings.length !== listingIds.length) throw new Error('Every selected listing must belong to a selected SKU')
  for (const listing of listings) {
    const account = options.accounts.find(a => a.id === listing.accountId && a.channelType === listing.channel)
    if (!account || account.marketplace && !['GLOBAL', listing.marketplace].includes(account.marketplace)) throw new Error('A selected listing needs an active, matching seller account')
    if (!options.markets.some(m => m.channel === listing.channel && m.code === listing.marketplace)) throw new Error('A selected listing marketplace is unavailable')
  }
  if (locales.some(l => !options.locales.includes(l))) throw new Error('Select an available content language')
  return { productId, rootId: options.rootId, products, listings, locales, includeShared: input.includeShared }
}

/** Check every action, including unchanged cells. Uploads never expand the saved selection. */
export function assertProductTransferRows(boundary: ProductTransferBoundary, rows: TransferRow[]) {
  const { products, listings } = boundaryIndex(boundary)
  for (const row of rows) {
    if (!products.has(row.sku)) throw new TransferConflict(`${row.sku}: this SKU is outside the selected products`)
    if (row.entity === 'Products') {
      if (!boundary.includeShared || row.channel || row.accountId || row.marketplace || row.aliasKey || row.locale && !boundary.locales.includes(row.locale)) throw new TransferConflict(`${row.sku}: shared details or this language are outside the selected scope`)
    } else if (!listings.has(listingKey(row))) throw new TransferConflict(`${row.sku}: this account, marketplace or listing is outside the selected scope`)
  }
}

/** Called again inside each serializable write transaction, including recovered/retried jobs. */
export async function checkProductTransferBoundary(boundary: ProductTransferBoundary, rows?: TransferRow[], db: Prisma.TransactionClient = prisma) {
  if (rows) assertProductTransferRows(boundary, rows)
  const anchor = await db.product.findFirst({ where: { id: boundary.productId, deletedAt: null }, select: productIdentity })
  if (!anchor || (anchor.parentId ?? anchor.id) !== boundary.rootId) throw new TransferConflict('The product group changed. Open a new product import review.')
  if (anchor.parentId && !await db.product.findFirst({ where: { id: boundary.rootId, deletedAt: null, parentId: null }, select: { id: true } })) throw new TransferConflict('The parent product is unavailable. Open a new product import review.')
  const index = boundaryIndex(boundary)
  const expected = rows ? [...new Set(rows.map(r => r.sku))].flatMap(sku => index.products.get(sku) ?? []) : boundary.products
  const products = await db.product.findMany({ where: { id: { in: expected.map(p => p.id) }, deletedAt: null }, select: productIdentity })
  if (expected.some(p => !products.some(c => c.id === p.id && c.sku === p.sku && c.parentId === p.parentId))) throw new TransferConflict('A selected SKU or its parent changed. Export and review the selection again.')
  const selected = rows ? [...new Set(rows.filter(r => r.entity !== 'Products').map(listingKey))].flatMap(key => index.listings.get(key) ?? []) : boundary.listings
  if (!selected.length) return
  const listings = await db.channelListing.findMany({ where: { id: { in: selected.map(l => l.id) } }, select: listingIdentity })
  if (selected.some(l => !listings.some(c => c.id === l.id && c.productId === l.productId && c.channel === l.channel && c.channelConnectionId === l.accountId && c.marketplace === l.marketplace && c.aliasKey === l.aliasKey))) throw new TransferConflict('A selected listing moved or was replaced. Export and review the selection again.')
}
