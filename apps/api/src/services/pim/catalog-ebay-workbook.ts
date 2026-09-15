import ExcelJS from 'exceljs'
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'
import type { ChannelFieldSpec, ChannelSpec } from './channel-specs/types.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'

/** Verified catalog coordinates, never alias labels or SKU-stem guesses. */
export interface EbayWorkbookTarget {
  id: string; sku: string; parentSku: string; sourceParentSku: string
  isParent: boolean; itemId: string; accountId: string; marketplace: string; aliasKey: string; version: number
}
export interface EbayWorkbookTable {
  sheet: string; marketplace: string; headers: string[]
  records: { row: number; values: Record<string, string> }[]
}

const fixedFields: Record<string, string> = {
  Title: 'title', Subtitle: 'subtitle', Description: 'description', Condition: 'conditionId',
  'Category ID': 'categoryId', 'Variation Theme': 'variationTheme', 'Shared-SKU (Trading API)': 'sharedSkuListing',
  Format: 'listingFormat', Duration: 'listingDuration', 'Description Theme': 'descriptionThemeId',
  'Best Offer': 'bestOffer', 'BO Floor (EUR)': 'bestOfferFloor', 'BO Ceiling (EUR)': 'bestOfferCeiling',
  'VAT %': 'vatRate', 'Handling Days': 'handlingTime', Location: 'itemLocationCountry', 'Package Type': 'packageType',
  Weight: 'packageWeight', Length: 'packageLength', Width: 'packageWidth', Height: 'packageHeight',
  'Dim Unit': 'dimensionUnit', 'Video ID': 'videoId', 'Fulfillment Policy ID': 'fulfillmentPolicyId',
  'Payment Policy ID': 'paymentPolicyId', 'Return Policy ID': 'returnPolicyId',
}
const coordinates = new Set(['SKU', 'Parent/Child', 'Parent SKU', 'Item ID', 'Listing ID'])
const managed = new Set(['Price (€)', 'Price (£)', 'Quantity', 'Qty', 'Follow', 'Buffer', 'Listing Status', 'Status', 'Last Pushed', 'Sync Status'])
const aspectLabel = (header: string) => header.replace(/\s*[○↕⚠*]+/gu, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
const columnName = (index: number): string => index >= 26 ? columnName(Math.floor(index / 26) - 1) + columnName(index % 26) : String.fromCharCode(65 + index)

/** Recognize the old Nexus eBay export without treating arbitrary supplier sheets as it. */
export function readEbayWorkbook(book: ExcelJS.Workbook): EbayWorkbookTable | null {
  const sheets = book.worksheets.filter(s => /^ebay_(it|de|fr|es|uk)$/i.test(s.name))
  if (!sheets.length) return null
  if (book.worksheets.length !== 1) throw new Error('Import one eBay marketplace worksheet at a time')
  const sheet = sheets[0], columns = sheet.columnCount
  if (columns > 200 || sheet.rowCount > TRANSFER_MAX_ROWS + 1) throw new Error('The eBay workbook exceeds 200 columns or 50,000 rows')
  const headers = Array.from({ length: columns }, (_, i) => sheet.getCell(1, i + 1).text.trim())
  if (headers.some(h => !h) || new Set(headers).size !== headers.length || [...coordinates, 'Category ID'].some(h => !headers.includes(h))) throw new Error('Keep the eBay SKU, Parent/Child, Parent SKU, Item ID, Listing ID and Category ID headers intact and unique')
  const records: EbayWorkbookTable['records'] = []
  sheet.eachRow(row => {
    const values: Record<string, string> = {}
    for (let c = 1; c <= columns; c++) {
      const cell = row.getCell(c)
      if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw new Error(`${sheet.name}!${cell.address}: replace formulas and errors with verified values`)
      if (cell.text.length > 256_000) throw new Error(`${sheet.name}!${cell.address}: cell exceeds 256,000 characters`)
      values[headers[c - 1]] = cell.text
    }
    if (row.number > 1 && Object.values(values).some(v => v.trim())) records.push({ row: row.number, values })
  })
  if (!records.length) throw new Error('The eBay workbook contains no listing rows')
  return { sheet: sheet.name, marketplace: sheet.name.slice(5).toUpperCase(), headers, records }
}

function typedValue(field: ChannelFieldSpec, raw: string): unknown {
  if (field.kind === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(raw.trim().toLowerCase())) throw new Error('Use true, false, 1 or 0')
    return ['true', '1'].includes(raw.trim().toLowerCase())
  }
  if (field.kind === 'number') {
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value)) throw new Error('Use a finite number with a decimal point')
    return value
  }
  return raw
}

/** Invalid identities block their whole row. Resolved rows account for every populated cell. */
export function mapEbayWorkbook(table: EbayWorkbookTable, targets: EbayWorkbookTarget[], specs: Map<string, ChannelSpec>) {
  const rows: TransferRow[] = [], issues: TransferIssue[] = [], exclusions: SourceExclusion[] = []
  const parentCounts = new Map<string, number>(), parentCategories = new Map<string, string>(), targetIndex = new Map<string, EbayWorkbookTarget[]>()
  for (const { values: r } of table.records) if (r['Parent/Child'].trim() === 'parent') {
    const key = JSON.stringify([r.SKU.trim(), r['Item ID'].trim()])
    parentCounts.set(key, (parentCounts.get(key) ?? 0) + 1)
    parentCategories.set(key, r['Category ID'].trim())
  }
  const targetKey = (marketplace: string, itemId: string, parentSku: string, isParent: boolean, sku: string) => JSON.stringify([marketplace, itemId, parentSku, isParent, isParent ? '' : sku])
  for (const t of targets) {
    const key = targetKey(t.marketplace, t.itemId, t.sourceParentSku, t.isParent, t.sku)
    targetIndex.set(key, [...(targetIndex.get(key) ?? []), t])
  }
  const seen = new Set<string>()
  for (const record of table.records) {
    const r = record.values, sku = r.SKU.trim(), itemId = r['Item ID'].trim(), parentage = r['Parent/Child'].trim()
    const parentSku = parentage === 'parent' ? sku : r['Parent SKU'].trim()
    const source = (header: string) => ({ sheet: table.sheet, column: columnName(table.headers.indexOf(header)) })
    const issue = (field: string, message: string) => issues.push({ row: record.row, sku, field, message, source: source(field) })
    if (!sku || !/^\d{9,15}$/.test(itemId) || !['parent', 'child'].includes(parentage) || !parentSku || parentage === 'parent' && r['Parent SKU'].trim()) {
      issue('Parent SKU', 'Supply an exact SKU, numeric Item ID and valid parent/child relationship'); continue
    }
    if (parentCounts.get(JSON.stringify([parentSku, itemId])) !== 1) { issue('Parent SKU', 'Each row needs exactly one parent row with the same Parent SKU and Item ID'); continue }
    if (r['Category ID'].trim() !== parentCategories.get(JSON.stringify([parentSku, itemId]))) { issue('Category ID', 'Every variant of an eBay Item ID must use its parent listing category'); continue }
    const candidates = (targetIndex.get(targetKey(table.marketplace, itemId, parentSku, parentage === 'parent', sku)) ?? []).filter(t => !r['Listing ID'].trim() || r['Listing ID'].trim() === t.id)
    if (candidates.length !== 1) {
      issue('Item ID', 'This Item ID, parent and SKU do not identify exactly one existing listing in this product group. Reconcile legacy listing shells as aliases first; no primary-listing fallback is used.'); continue
    }
    const t = candidates[0], identity = { row: record.row, sku: t.sku, entity: 'Overrides' as const, channel: 'EBAY', accountId: t.accountId, marketplace: t.marketplace, aliasKey: t.aliasKey, locale: '', action: 'SET' as const, version: t.version }
    if (!t.accountId || !Number.isSafeInteger(t.version) || t.version < 0) { issue('Item ID', 'The listing needs a verified account and record version'); continue }
    if (seen.has(t.id)) { issue('SKU', 'Duplicate row for the same listing and SKU'); continue }
    seen.add(t.id)
    const category = r['Category ID']?.trim(), spec = specs.get(category)
    if (!spec || spec.absent || spec.marketplace !== table.marketplace) { issue('Category ID', 'Refresh this marketplace and category schema before importing'); continue }
    const exclude = (header: string, message: string) => exclusions.push({ row: record.row, sku: t.sku, field: header, message, source: source(header) })
    for (const header of table.headers) {
      const raw = r[header]
      if (!raw?.trim()) continue
      if (coordinates.has(header)) { exclude(header, 'Verified listing identity; shared product parentage and remote links are preserved'); continue }
      if (managed.has(header)) { exclude(header, 'Historical price, inventory, control or sync reference; use its dedicated workflow'); continue }
      if (header === 'Action') { issue(header, 'Lifecycle actions cannot run through a product data import; remove the action to review populated attributes'); continue }
      if (header === 'Wt Unit') {
        if (!r.Weight?.trim()) issue(header, 'A weight unit needs a populated Weight cell')
        else exclude(header, 'Imported with Weight as one typed measurement')
        continue
      }
      if (/^Image [1-6]$/.test(header)) {
        const first = table.headers.find(h => /^Image [1-6]$/.test(h) && r[h]?.trim())
        if (header !== first) { exclude(header, 'Imported in the ordered image URL list'); continue }
        const value = Array.from({ length: 6 }, (_, i) => r[`Image ${i + 1}`]).filter(v => v?.trim())
        rows.push({ ...identity, field: 'imageUrls', value, source: source(header) }); continue
      }
      const fields = fixedFields[header] ? spec.fields.filter(f => f.key === fixedFields[header]) : spec.fields.filter(f => f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics' && f.channelStore.path[1] === aspectLabel(header))
      if (fields.length !== 1) { issue(header, 'This populated column has no unambiguous field in the current eBay schema; map or remove it explicitly'); continue }
      const field = fields[0]
      try {
        let value: unknown
        if (field.shape === 'measure') {
          const unit = r['Wt Unit']?.trim()
          if (!unit || !field.unitOptions?.includes(unit)) throw new Error('Supply a supported weight unit')
          value = { value: typedValue(field, raw), unit }
        } else if (field.shape === 'list') value = raw.split(',').map(v => typedValue(field, v.trim()))
        else value = typedValue(field, raw)
        const values = Array.isArray(value) ? value : [value]
        if (field.mode === 'strict' && values.some(v => !field.options?.includes(String(v)))) throw new Error(`Use an exact eBay choice for ${field.label}: ${field.options?.join(', ')}`)
        if (field.maxLength && values.some(v => typeof v === 'string' && v.length > field.maxLength!)) throw new Error(`Use at most ${field.maxLength} characters`)
        rows.push({ ...identity, entity: field.key === 'categoryId' ? 'Listings' : 'Overrides', field: field.key, value, source: source(header) })
      } catch (error) { issue(header, error instanceof Error ? error.message : String(error)) }
    }
    if (rows.length + issues.length + exclusions.length > TRANSFER_MAX_ROWS) throw new Error('The eBay workbook exceeds 50,000 attribute outcomes')
  }
  return { rows, issues, exclusions }
}

export async function readProductEbayWorkbook(book: ExcelJS.Workbook, productId: string) {
  const table = readEbayWorkbook(book)
  if (!table) return null
  const [{ productTransferOptions }, { default: prisma }, { loadEbaySpec }] = await Promise.all([
    import('./catalog-product-transfer.js'), import('../../db.js'), import('./channel-specs/index.js'),
  ])
  const options = await productTransferOptions(productId), productById = new Map(options.products.map(p => [p.id, p]))
  const selected = options.listings.filter(l => l.channel === 'EBAY' && l.marketplace === table.marketplace)
  const [listings, aliases] = await Promise.all([
    prisma.channelListing.findMany({ where: { id: { in: selected.map(l => l.id) } }, select: { id: true, productId: true, externalListingId: true, version: true } }),
    prisma.productListingAlias.findMany({ where: { id: { in: selected.map(l => l.aliasKey).filter(Boolean) } }, select: { id: true, adoptedFromProductId: true } }),
  ])
  const shells = await prisma.product.findMany({ where: { id: { in: aliases.map(a => a.adoptedFromProductId).filter((id): id is string => !!id) } }, select: { id: true, sku: true } })
  const rootSku = productById.get(options.rootId)!.sku
  const targets: EbayWorkbookTarget[] = listings.flatMap(l => {
    const coordinate = selected.find(s => s.id === l.id)!, product = productById.get(l.productId)!
    const alias = aliases.find(a => a.id === coordinate.aliasKey)
    const sourceParentSku = alias?.adoptedFromProductId ? shells.find(s => s.id === alias.adoptedFromProductId)?.sku : rootSku
    if (!sourceParentSku || !l.externalListingId) return []
    return [{ ...coordinate, sku: product.sku, parentSku: rootSku, sourceParentSku, isParent: product.id === options.rootId, itemId: l.externalListingId, version: l.version }]
  })
  const specs = new Map<string, ChannelSpec>()
  for (const category of new Set(table.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))) specs.set(category, await loadEbaySpec(table.marketplace, [category]))
  return { ...mapEbayWorkbook(table, targets, specs), warnings: ['Historical eBay export: populated attributes are reviewed against current Nexus versions. Blank cells preserve data. Prices, quantities, controls and sync fields are reference only.'] }
}
