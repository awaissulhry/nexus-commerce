import ExcelJS from 'exceljs'
import prisma from '../../db.js'
import { buildEbayWorkbookRows, type EbayExportRecord } from './ebay-export.js'
import { formLabel } from './form.js'
import { fieldRowOf, MappingError, recordUse } from './store.js'
import type { ChannelSpec } from '../pim/channel-specs/types.js'

/**
 * CHMAP M3 (E-1) — write our eBay listing workbook from what Nexus holds, through ONE mapping version: the version's
 * own columns, in its order, one row per eBay listing of each product group (primary and adopted listings).
 */
export async function exportEbayWorkbook(request: { marketplace: string; setId: string; skus: string[] }) {
  const marketplace = request.marketplace.toUpperCase()
  const set = await prisma.channelMappingSet.findUnique({ where: { id: request.setId }, include: { fields: true } })
  if (!set) throw new MappingError('This mapping version does not exist', 404)
  if (set.channel !== 'EBAY' || set.marketplace !== marketplace) throw new MappingError(`Mapping v${set.version} is for ${set.channel} ${set.marketplace}, not eBay ${marketplace}`)
  const label = formLabel(set as never, set.version, set.status)
  const fields = set.fields.map(fieldRowOf).sort((a, b) => a.sortOrder - b.sortOrder)
  const headers = fields.map(f => f.columnKey ?? f.channelKey)
  const { loadEbaySpec } = await import('../pim/channel-specs/index.js')
  const specs = new Map<string, ChannelSpec>()
  for (const category of set.formKey.split('+').filter(c => c && c !== 'UNKNOWN')) specs.set(category, await loadEbaySpec(marketplace, [category]))

  const requested = [...new Set(request.skus.map(s => s.trim()).filter(Boolean))]
  if (!requested.length) throw new MappingError('Choose the products to export')
  const seeds = await prisma.product.findMany({ where: { sku: { in: requested }, deletedAt: null }, select: { id: true, parentId: true } })
  if (seeds.length !== requested.length) throw new MappingError('Some requested SKUs are missing or archived; correct the selection before exporting')
  const roots = [...new Set(seeds.map(p => p.parentId ?? p.id))]
  const [{ groupTargets }, { catalogRows, productInclude }, { transferContracts }, { marketLanguages }, { normalizeLanguage }] = await Promise.all([
    import('../pim/catalog-ebay-workbook.js'), import('../pim/catalog-transfer-export.js'), import('../pim/catalog-transfer-plan.js'), import('../pim/market-languages.js'), import('../pim/content-language.js'),
  ])
  const products = await prisma.product.findMany({ where: { deletedAt: null, OR: [{ id: { in: roots } }, { parentId: { in: roots } }] }, include: productInclude, orderBy: { sku: 'asc' } })
  const market = await prisma.marketplace.findFirst({ where: { channel: 'EBAY', code: marketplace }, select: { language: true, languages: true } })
  if (!market) throw new MappingError(`eBay ${marketplace} is not a configured market`)
  const languages = new Map([[JSON.stringify(['EBAY', marketplace]), marketLanguages('EBAY', marketplace, [{ channel: 'EBAY', code: marketplace, language: market.language, languages: market.languages ?? [] }])]])
  const primary = normalizeLanguage(market.language)
  const families = await prisma.productFamily.findMany({ select: { id: true, code: true } })
  const rows = await catalogRows(products, { market: marketplace, marketplaces: [marketplace] }, transferContracts(marketplace, { allowIncompleteSchema: true }), families, undefined, languages) as { sku: string; aliasKey: string; channel: string; marketplace: string; field: string; locale: string; action: string; value?: unknown; entity: string }[]
  const listings = await prisma.channelListing.findMany({ where: { channel: 'EBAY', marketplace, productId: { in: products.map(p => p.id) } }, select: { id: true, price: true, priceOverride: true, platformAttributes: true } })
  const listingById = new Map(listings.map(l => [l.id, l]))
  const num = (v: unknown) => v == null ? null : typeof v === 'object' && 'toNumber' in (v as object) ? (v as { toNumber(): number }).toNumber() : Number(v)

  const records: EbayExportRecord[] = []
  for (const rootId of roots) {
    // An extra listing is written under its own SKU; one without a SKU yet under its label, which the import offers to make its SKU.
    const targets = await groupTargets(prisma, { marketplace } as never, rootId, { unnamedByLabel: true })
    for (const t of targets) {
      const values = new Map<string, unknown>()
      for (const r of rows) {
        if (r.channel !== 'EBAY' || r.marketplace !== marketplace || r.sku !== t.sku || r.aliasKey !== t.aliasKey || r.action !== 'SET' || r.value === undefined) continue
        if (r.locale && normalizeLanguage(r.locale) !== primary) continue
        values.set(r.field, r.value)
      }
      const platform = (listingById.get(t.id)?.platformAttributes ?? {}) as { itemSpecifics?: Record<string, unknown> }
      for (const [name, value] of Object.entries(platform.itemSpecifics ?? {})) if (!values.has(`itemSpecifics.${name}`)) values.set(`itemSpecifics.${name}`, value)
      const l = listingById.get(t.id)
      records.push({ sku: t.isParent ? t.sourceParentSku : t.sku, isParent: t.isParent, parentSku: t.sourceParentSku, itemId: t.itemId || null, values, price: l ? num(l.priceOverride ?? l.price) : null })
    }
  }
  records.sort((a, b) => a.parentSku.localeCompare(b.parentSku) || (a.isParent === b.isParent ? a.sku.localeCompare(b.sku) : a.isParent ? -1 : 1))
  const built = buildEbayWorkbookRows(headers, fields, specs, records)
  const book = new ExcelJS.Workbook(), sheet = book.addWorksheet(`ebay_${marketplace.toLowerCase()}`)
  sheet.addRow(headers)
  for (const row of built.rows) sheet.addRow(headers.map(h => row[h] ?? ''))
  const bytes = Buffer.from(await book.xlsx.writeBuffer())
  const filename = `eBay ${marketplace} ${set.formKey} v${set.version}.xlsx`
  await recordUse(set.id, 'EXPORT', filename, { rows: built.rows.length, gaps: built.gaps.length, blankColumns: built.blankByDesign.size })
  return { filename, bytes, set: { id: set.id, version: set.version, status: set.status, label }, headers, rows: built.rows, gaps: built.gaps, blankByDesign: built.blankByDesign, blankForRow: built.blankForRow }
}
