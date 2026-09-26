import prisma from '../../db.js'
import { buildShopifyCsv, checkShopifyExport, shopifyCsvText, type ShopifyExportProduct } from './shopify-export.js'
import { formLabel } from './form.js'
import { fieldRowOf, MappingError, recordUse } from './store.js'

/**
 * NCF N7 — write Shopify's own product CSV from what Nexus holds, through ONE mapping version of the store
 * (`shopify-export.ts` decides every column and row). Only products Nexus already links to Shopify are written
 * (D1 A): the ones whose Shopify identity Nexus read from Shopify's own product file. UTF-8 without BOM, comma, LF,
 * the version's own header names. Every export records its version. Nothing is sent to Shopify.
 */
export async function exportShopifyCsv(request: { setId: string; skus: string[]; includePrices?: boolean }) {
  const set = await prisma.channelMappingSet.findUnique({ where: { id: request.setId }, include: { fields: true } })
  if (!set) throw new MappingError('This mapping version does not exist', 404)
  if (set.channel !== 'SHOPIFY' || set.formKind !== 'SHOPIFY_PRODUCT_CSV') throw new MappingError(`Mapping v${set.version} is not a Shopify product CSV version`)
  const accountId = set.formKey
  const label = formLabel(set as never, set.version, set.status)
  const fields = set.fields.map(fieldRowOf).sort((a, b) => a.sortOrder - b.sortOrder)
  const requested = [...new Set(request.skus.map(s => s.trim()).filter(Boolean))]
  if (!requested.length) throw new MappingError('Choose the products to export')
  const seeds = await prisma.product.findMany({ where: { sku: { in: requested }, deletedAt: null }, select: { id: true, parentId: true } })
  if (seeds.length !== requested.length) throw new MappingError('Some requested SKUs are missing or archived; correct the selection before exporting')
  const roots = [...new Set(seeds.map(p => p.parentId ?? p.id))]
  const [{ catalogRows, productInclude }, { transferContracts }, { marketLanguages }, { normalizeLanguage }, { readShopifyCsvIdentity, shopifyStoreSpec }, { storedCompareAt }] = await Promise.all([
    import('../pim/catalog-transfer-export.js'), import('../pim/catalog-transfer-plan.js'), import('../pim/market-languages.js'), import('../pim/content-language.js'),
    import('../pim/catalog-shopify-csv.js'), import('../pim/compare-at-price.js'),
  ])
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, include: productInclude, orderBy: { sku: 'asc' } })
  const market = await prisma.marketplace.findFirst({ where: { channel: 'SHOPIFY', code: 'GLOBAL' }, select: { language: true, languages: true } })
  if (!market) throw new MappingError('The Shopify marketplace (GLOBAL) is not configured')
  const languages = new Map([[JSON.stringify(['SHOPIFY', 'GLOBAL']), marketLanguages('SHOPIFY', 'GLOBAL', [{ channel: 'SHOPIFY', code: 'GLOBAL', language: market.language, languages: market.languages ?? [] }])]])
  const primary = normalizeLanguage(market.language)
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true } })
  // The values Nexus stores on each Shopify listing, read exactly as the transfer export reads them (what an import wrote).
  const rows = await catalogRows(products, { market: 'GLOBAL', marketplaces: ['GLOBAL'] }, transferContracts('GLOBAL', { allowIncompleteSchema: true }), families, undefined, languages) as
    { sku: string; aliasKey: string; channel: string; accountId: string; field: string; locale: string; action: string; value?: unknown }[]
  const valuesOf = (sku: string) => {
    const values = new Map<string, unknown>()
    for (const r of rows) {
      if (r.channel !== 'SHOPIFY' || r.accountId !== accountId || r.aliasKey !== '' || r.sku !== sku || r.action !== 'SET' || r.value === undefined) continue
      if (r.locale && normalizeLanguage(r.locale) !== primary) continue
      values.set(r.field, r.value)
    }
    return values
  }
  const listings = await prisma.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId, aliasKey: '', productId: { in: products.map(p => p.id) } },
    select: { id: true, productId: true, price: true, priceOverride: true, followMasterPrice: true, platformAttributes: true } })
  const productById = new Map(products.map(p => [p.id, p]))
  const num = (v: unknown) => v == null ? null : typeof v === 'object' && 'toNumber' in (v as object) ? (v as { toNumber(): number }).toNumber() : Number(v)
  const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}

  const exportProducts: ShopifyExportProduct[] = []
  const notLinked: { sku: string; reason: string }[] = []
  for (const rootId of roots) {
    const family = listings.filter(l => { const p = productById.get(l.productId); return p && (p.id === rootId || p.parentId === rootId) })
    const holders = family.filter(l => readShopifyCsvIdentity(l.platformAttributes))
    if (!holders.length) { notLinked.push({ sku: productById.get(rootId)?.sku ?? rootId, reason: 'Nexus does not link this product to a Shopify product in this store: it has not been read from Shopify’s own product file. Import that file once (confirming the link), then export again.' }); continue }
    // The SKU Shopify sells each variant as: the listing's own SKU when Nexus holds one, else the product SKU.
    const sold = (l: typeof family[number]) => [record(l.platformAttributes).sku, record(l.platformAttributes).sellerSku].find((x): x is string => typeof x === 'string' && !!x.trim()) ?? productById.get(l.productId)!.sku
    for (const holder of holders) {
      const variants = new Map(family.map(l => {
        const p = productById.get(l.productId)!
        const price = l.followMasterPrice === false ? num(l.priceOverride) ?? num(l.price) ?? num(p.basePrice) : num(p.basePrice)
        return [sold(l), { sku: p.sku, values: valuesOf(p.sku), price: price === null || !Number.isFinite(price) ? null : price, compareAt: storedCompareAt(l.platformAttributes) }] as const
      }))
      const own = productById.get(holder.productId)!
      exportProducts.push({ sku: own.sku, identity: readShopifyCsvIdentity(holder.platformAttributes), values: valuesOf(own.sku), variants })
    }
  }
  const { spec, storeFields } = await shopifyStoreSpec(accountId)
  const built = buildShopifyCsv(fields, exportProducts, { spec, storeFields, includePrices: request.includePrices ?? true })
  built.refused.unshift(...notLinked)
  // Defense in depth: a file that would erase or delete in Shopify never leaves Nexus.
  const problems = checkShopifyExport(fields, built)
  if (problems.length) throw new MappingError(`The file failed its upload-safety check and was not written: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ' …' : ''}`, 500)
  if (!built.rows.length) throw new MappingError(`Nothing can be exported with ${label}: ${built.refused.map(r => `${r.sku}: ${r.reason}`).slice(0, 2).join(' ')}`, 409)
  const bytes = Buffer.from(shopifyCsvText(built.headers, built.rows), 'utf8')
  const filename = `Shopify product CSV v${set.version}.csv`
  await recordUse(set.id, 'EXPORT', filename, { products: built.products, rows: built.rows.length, omittedColumns: built.omitted.length, refusedProducts: built.refused.length })
  return { filename, bytes, set: { id: set.id, version: set.version, status: set.status, label }, ...built }
}
