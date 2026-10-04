/**
 * CHMAP M5 — the golden pipeline (study §8.6), shared by the fixture builder and the golden test. No database:
 * a file is read by the real reader through the mapping version the rules make for it, the values are grouped the
 * way Nexus stores them, the file is written back into its own form, and the two are compared cell by cell.
 *
 * check 1 — nothing unmapped: the reader's ledger accounts for every filled cell.
 * check 2 — native round trip: equal cells, and every difference named.
 * check 3 — version pin: the form, the mapping counts and the round-trip counts are pinned in `manifest.json`.
 * check 4 (Amazon templates, product sheet consistency B2) — the "inherited" pass: every variation value equal to its
 * parent's follows Shared instead of being stored; the export writes the value Nexus sends, the file comes back the same
 * (`roundTripInherited` = `roundTrip`), and reading that file again keeps every one of those cells following Shared
 * (`reimport.pinned` = 0, the planner's own rule `channelFileKeepsShared`).
 */
import ExcelJS from 'exceljs'
import { gunzipSync } from 'node:zlib'
import { mappingCounts, type MappingFieldRow } from '@nexus/shared/channel-mapping'
import { transferCanonical, type TransferRow } from '@nexus/shared/catalog-transfer'
import { detectAmazonTemplate, rewriteTemplateDataRows } from '../../amazon/template-workbook.js'
import { checkLedger, mapAmazonWorkbook } from '../../pim/catalog-amazon-workbook.js'
import { checkEbayLedger, mapEbayWorkbook, readEbayWorkbook, type EbayWorkbookTarget } from '../../pim/catalog-ebay-workbook.js'
import type { ChannelFieldSpec, ChannelSpec } from '../../pim/channel-specs/types.js'
import { channelFileKeepsShared } from '../../pim/catalog-transfer-plan.js'
import type { CatalogueField } from '../../pim/mapping/field-catalogue.service.js'
import { buildAmazonDraftFields } from '../amazon-draft.js'
import { amazonExportValues, buildAmazonTemplateRows, codeFor, compareTemplateRows, type AmazonExportRecord, type AmazonValueRow } from '../amazon-export.js'
import { readerMapping } from '../decisions.js'
import { buildEbayDraftFields, ebayChannelKeyOf } from '../ebay-draft.js'
import { buildEbayWorkbookRows, compareEbayRows, type EbayExportRecord } from '../ebay-export.js'
import { amazonFormOf, ebayFormOf, shopifyFormOf } from '../form.js'
import { checkShopifyLedger, mapShopifyCsv, readShopifyCsv, SHOPIFY_CSV_IDENTITY, type ShopifyCsvIdentity, type ShopifyCsvTarget } from '../../pim/catalog-shopify-csv.js'
import { shopifyProductSpec } from '../../pim/channel-specs/store.js'
import { buildShopifyDraftFields, shopifyChannelKeyOf } from '../shopify-draft.js'
import { buildShopifyCsv, checkShopifyExport, compareShopifyCsv, type ShopifyExportProduct, type ShopifyExportVariant } from '../shopify-export.js'

export interface GoldenMarket { language: string; languages: string[]; currency: string | null }
type RoundTrip = { compared: number; equal: number; differ: number; missing: number; extra: number; blankByDesign: number; rowsRefusedOnImport: number }
export interface GoldenResult {
  form: { formKind: string; formKey: string; templateVersion: string | null; keyFingerprint: string }
  mapping: ReturnType<typeof mappingCounts>
  read: { rows: number; excluded: number; refused: number; unaccounted: number; duplicated: number; dangling: number }
  roundTrip: RoundTrip | null
  differences: { header: string; original?: string; exported?: string }[]
  /** Amazon templates (check 4): the round trip with every variation value equal to its parent's following Shared. */
  roundTripInherited?: RoundTrip
  /** The cells that followed Shared in that pass (and took the value Nexus sends). */
  inheritedCells?: number
  /** That file read again, through the planner's rule: `kept` cells keep following Shared, `pinned` would be stored. */
  reimport?: { kept: number; pinned: number }
}

export const loadSpec = (gz: Buffer): ChannelSpec => JSON.parse(gunzipSync(gz).toString('utf8'))
const withIds = (rows: Omit<MappingFieldRow, 'id'>[]): MappingFieldRow[] => rows.map((r, i) => ({ ...r, id: `f${i}` }))
const norm = (lang: string) => lang.toLowerCase().split(/[-_]/)[0]
/** The planner's view of a cached-schema field, as `field-catalogue.service.ts` builds it. */
const catalogueFieldOf = (f: ChannelFieldSpec) => ({ fieldKey: f.key, sheetKey: f.managedBy ?? f.masterKey ?? f.key, shape: f.shape, kind: f.kind, cardinality: f.cardinality,
  unitOptions: f.unitOptions, validation: f.validation, label: f.label, options: f.options ?? null, optionLabels: f.optionLabels ?? null, selectionOnly: f.mode === 'strict',
  deprecatedOptions: f.deprecatedOptions ?? null }) as unknown as CatalogueField
const roundTripOf = (cmp: ReturnType<typeof compareTemplateRows>, refused: number): RoundTrip =>
  ({ compared: cmp.compared, equal: cmp.equal, differ: cmp.differ.length, missing: cmp.missing.length, extra: cmp.extra.length, blankByDesign: cmp.blankByDesign.reduce((n, b) => n + b.cells, 0), rowsRefusedOnImport: refused })

export async function amazonGolden(bytes: Buffer, specs: Map<string, ChannelSpec>, market: GoldenMarket): Promise<GoldenResult> {
  const parsed = (await detectAmazonTemplate(bytes, { strict: true }))!
  const marketplace = parsed.meta.marketplace!
  const form = amazonFormOf(parsed, marketplace)
  const primaryLanguage = norm(market.language)
  const marketLanguages = [...new Set([primaryLanguage, ...market.languages.map(norm)])]
  const fields = withIds(buildAmazonDraftFields(parsed, specs, { marketplace, primaryLanguage, marketLanguages, productTypes: form.formKey.split('+') }))
  const destination = { accountId: 'fixture', marketplace, language: market.language, languages: market.languages, currency: market.currency ?? undefined, mapping: readerMapping({ id: 'golden', version: 1, status: 'DRAFT' }, 'golden', fields) }
  const read = mapAmazonWorkbook(parsed, specs, destination)
  const ledger = checkLedger(parsed, read)
  const result: GoldenResult = {
    form: { formKind: form.formKind, formKey: form.formKey, templateVersion: form.templateVersion, keyFingerprint: form.keyFingerprint },
    mapping: mappingCounts(fields),
    read: { rows: read.rows.length, excluded: read.exclusions.length, refused: read.issues.length, unaccounted: ledger.unaccounted.length, duplicated: ledger.duplicated.length, dangling: ledger.danglingRows.length },
    roundTrip: null, differences: [],
  }
  if (form.formKind !== 'AMAZON_TEMPLATE') return result // old flat files are read, never written back
  const skuHeader = parsed.headers.find(h => h.startsWith('contribution_sku'))!
  const parentHeader = parsed.headers.find(h => h.startsWith('child_parent_sku_relationship') && h.endsWith('parent_sku'))
  const parentageHeader = parsed.headers.find(h => h.startsWith('parentage_level'))
  const refused = new Set(read.issues.map(i => (i as { fileSku?: string }).fileSku ?? i.sku))
  // Nexus's store, simulated: one record per file SKU, holding exactly what the reader emitted for it.
  const bySku = new Map<string, AmazonExportRecord>()
  for (const row of parsed.rows) {
    const sku = (row[skuHeader] ?? '').trim()
    if (!sku) continue
    const parentage = parentageHeader ? codeFor(parsed, parentageHeader, (row[parentageHeader] ?? '').trim()) : ''
    bySku.set(sku, { sku, sellerSku: sku, parentSellerSku: parentHeader ? (row[parentHeader] ?? '').trim() || null : null, isParent: parentage === 'parent' || (!parentage && !(parentHeader && row[parentHeader])),
      productType: form.formKey.split('+')[0], asin: null, values: new Map(), price: null, sale: null })
  }
  for (const r of read.rows as TransferRow[]) {
    const rec = bySku.get((r as { fileSku?: string }).fileSku ?? r.sku)
    if (!rec || r.action !== 'SET') continue
    if (r.field === 'productType') rec.productType = String(r.value)
    else if (r.field === 'price') rec.price = Number(r.value)
    else if (r.field === 'sale') rec.sale = r.value as AmazonExportRecord['sale']
    else if (r.entity === 'Overrides') rec.values.set(`${r.field}\u0000${r.locale ?? ''}`, r.value)
  }
  const actionHeader = parsed.headers.find(h => h === '::record_action')
  const actions = actionHeader ? parsed.rows.map(r => (r[actionHeader] ?? '').trim()) : []
  const recordAction = actions.every(a => !a) ? 'blank' as const : parsed.meta.actions.partial > parsed.meta.actions.replace ? 'partial_update' as const : 'full_update' as const
  const options = { recordAction, primaryLanguage, currency: market.currency, includePrices: true }
  const out = buildAmazonTemplateRows(parsed, fields, [...bySku.values()], options)
  const back = (await detectAmazonTemplate((await rewriteTemplateDataRows(bytes, out.rows)).bytes, { strict: true }))!
  const compared = parsed.rows.filter(r => !refused.has((r[skuHeader] ?? '').trim()))
  const cmp = compareTemplateRows(parsed, compared, back.rows, skuHeader, out.blankByDesign, out.blankForRow)
  result.roundTrip = roundTripOf(cmp, parsed.rows.length - compared.length)
  result.differences = [...cmp.differ.map(d => ({ header: d.header, original: d.original, exported: d.exported })), ...cmp.missing.map(d => ({ header: d.header, original: d.original })), ...cmp.extra.map(d => ({ header: d.header, exported: d.exported }))]

  // check 4 — the "inherited" pass. A variation value equal to its parent's follows Shared (INHERIT); Shared sends the
  // parent's value (the effective rows). Everything else stays stored (SET), its effective value its own.
  const followsShared = new Map<string, unknown>()
  let inheritedCells = 0
  const followed = [...bySku.values()].map(rec => {
    const parent = rec.parentSellerSku && rec.parentSellerSku !== rec.sku ? bySku.get(rec.parentSellerSku) : undefined
    const stored: AmazonValueRow[] = [], effective: AmazonValueRow[] = []
    for (const [key, value] of rec.values) {
      const [field, locale] = key.split('\u0000')
      const shared = parent?.values.get(key)
      if (parent?.values.has(key) && transferCanonical(shared) === transferCanonical(value)) {
        stored.push({ field, locale, action: 'INHERIT' })
        effective.push({ field, locale, action: 'SET', value: shared })
        followsShared.set(`${rec.sku}\u0000${key}`, shared)
      } else {
        stored.push({ field, locale, action: 'SET', value })
        effective.push({ field, locale, action: 'SET', value })
      }
    }
    const v = amazonExportValues(stored, effective, [], primaryLanguage)
    inheritedCells += v.inherited
    return { ...rec, values: v.values }
  })
  const outInherited = buildAmazonTemplateRows(parsed, fields, followed, options)
  const fileInherited = (await rewriteTemplateDataRows(bytes, outInherited.rows)).bytes
  const backInherited = (await detectAmazonTemplate(fileInherited, { strict: true }))!
  result.roundTripInherited = roundTripOf(compareTemplateRows(parsed, compared, backInherited.rows, skuHeader, outInherited.blankByDesign, outInherited.blankForRow), parsed.rows.length - compared.length)
  result.inheritedCells = inheritedCells
  // That file read again: each inherited cell's file value goes through the planner's own rule against what Shared sends.
  const reimport = { kept: 0, pinned: 0 }
  for (const r of mapAmazonWorkbook(backInherited, specs, destination).rows as TransferRow[]) {
    const sku = (r as { fileSku?: string }).fileSku ?? r.sku
    const key = `${sku}\u0000${r.field}\u0000${r.locale ?? ''}`
    if (r.entity !== 'Overrides' || r.action !== 'SET' || !followsShared.has(key)) continue
    const field = specs.get(bySku.get(sku)?.productType ?? '')?.fields.find(f => f.key === r.field)
    if (field && channelFileKeepsShared(catalogueFieldOf(field), r.value, followsShared.get(key))) reimport.kept++
    else reimport.pinned++
  }
  result.reimport = reimport
  return result
}

export async function ebayGolden(bytes: Buffer, filename: string, specs: Map<string, ChannelSpec>): Promise<GoldenResult> {
  const book = new ExcelJS.Workbook()
  await book.xlsx.load(bytes)
  const table = readEbayWorkbook(book, { filename })!
  const form = ebayFormOf({ marketplace: table.marketplace, sheet: table.sheet, categories: [...specs.keys()], channelKeys: table.headers.map(h => ebayChannelKeyOf(h, specs).channelKey) })
  const fields = withIds(buildEbayDraftFields(table.headers, specs, table.marketplace))
  // Every listing of the file is a Nexus listing: one target per row, the file's own parent as the listing's parent.
  const v = (r: Record<string, string>, h: string) => (r[h] ?? '').trim()
  const targets: EbayWorkbookTarget[] = table.records.map(({ values: r }) => {
    const isParent = v(r, 'Parent/Child').toLowerCase() === 'parent', parent = isParent ? v(r, 'SKU') : v(r, 'Parent SKU')
    return { id: `${v(r, 'Item ID')}|${v(r, 'SKU')}|${isParent}`, sku: v(r, 'SKU'), parentSku: parent, sourceParentSku: parent, isParent, itemId: v(r, 'Item ID'), accountId: 'fixture', marketplace: table.marketplace, aliasKey: parent, version: 1,
      // The file is this business's own: its listings already use these policies (an imported policy ID must be the account's own).
      policyIds: ['Fulfillment Policy ID', 'Payment Policy ID', 'Return Policy ID'].map(h => v(r, h)).filter(Boolean) }
  })
  const read = mapEbayWorkbook(table, targets, specs, { mapping: readerMapping({ id: 'golden', version: 1, status: 'DRAFT' }, 'golden', fields), mappingSpecs: specs })
  const ledger = checkEbayLedger(table, read)
  const refusedRows = new Set(read.issues.map(i => i.row))
  const records = new Map<string, EbayExportRecord>()
  for (const t of targets) records.set(`${t.aliasKey}|${t.sku}`, { sku: t.sku, isParent: t.isParent, parentSku: t.sourceParentSku, itemId: t.itemId || null, values: new Map(), price: null })
  for (const r of read.rows as TransferRow[]) {
    const rec = records.get(`${r.aliasKey}|${r.sku}`)
    if (!rec || r.action !== 'SET') continue
    if (r.field === 'price') rec.price = Number(r.value)
    else rec.values.set(r.field, r.value)
  }
  const out = buildEbayWorkbookRows(table.headers, fields, specs, [...records.values()])
  const compared = table.records.filter(r => !refusedRows.has(r.row)).map(r => r.values)
  const cmp = compareEbayRows(table.headers, compared, out.rows, out.blankByDesign, out.blankForRow)
  return {
    form: { formKind: form.formKind, formKey: form.formKey, templateVersion: null, keyFingerprint: form.keyFingerprint },
    mapping: mappingCounts(fields),
    read: { rows: read.rows.length, excluded: read.exclusions.length, refused: read.issues.length, unaccounted: ledger.unaccounted.length, duplicated: ledger.duplicated.length, dangling: ledger.danglingRows.length },
    roundTrip: { compared: cmp.compared, equal: cmp.equal, differ: cmp.differ.length, missing: cmp.missing.length, extra: cmp.extra.length, blankByDesign: [...cmp.blankByDesign.values()].reduce((a, b) => a + b, 0), rowsRefusedOnImport: table.records.length - compared.length },
    differences: [...cmp.differ.map(d => ({ header: d.header, original: d.original, exported: d.exported })), ...cmp.missing.map(d => ({ header: d.header, original: d.original })), ...cmp.extra.map(d => ({ header: d.header, exported: d.exported }))],
  }
}

/**
 * NCF N8 — Shopify's own product CSV. Every product of the file is a Nexus Shopify listing linked to it (its handle
 * known), and every variant with a SKU a listing under it; a variant without a SKU has no Nexus listing (as in the
 * Owner's store). The store's field list is NOT loaded (the cold-schema trap is pinned: metafield cells are refused).
 * The file is read, the values are stored the way the transfer plan stores them, the file is written back through
 * the version, checked for upload safety, and compared cell by cell.
 */
export function shopifyGolden(bytes: Buffer): GoldenResult & { export: { products: number; variants: number; columnsWritten: number; columnsLeftOut: string[]; productsRefused: number; safety: string[] } } {
  const table = readShopifyCsv(bytes)
  const accountId = 'fixture-store'
  const form = shopifyFormOf({ accountId, channelKeys: table.headers.map(shopifyChannelKeyOf) })
  const fields = withIds(buildShopifyDraftFields(table.headers))
  const spec = shopifyProductSpec(null, accountId)
  const handleH = table.headers.find(h => shopifyChannelKeyOf(h) === 'Handle')!, skuH = table.headers.find(h => shopifyChannelKeyOf(h) === 'Variant SKU')!
  const targets: ShopifyCsvTarget[] = []
  for (const handle of new Set(table.records.map(r => r.values[handleH].trim()).filter(Boolean))) {
    const product = `PRODUCT:${handle}`
    targets.push({ id: product, sku: product, parentSku: null, accountId, aliasKey: '', version: 1, handles: [handle] })
    for (const sku of new Set(table.records.filter(r => r.values[handleH].trim() === handle).map(r => r.values[skuH].trim()).filter(Boolean)))
      targets.push({ id: `${product}|${sku}`, sku, parentSku: product, accountId, aliasKey: '', version: 1, handles: [] })
  }
  const read = mapShopifyCsv(table, targets, { accountId, spec, storeFields: false, mapping: readerMapping({ id: 'golden', version: 1, status: 'DRAFT' }, 'golden', fields) })
  const ledger = checkShopifyLedger(table, read)
  // Nexus's store, simulated: each listing holds exactly what the reader emitted for it.
  const held = new Map(targets.map(t => [t.id, { values: new Map<string, unknown>(), price: null as number | null, compareAt: null as number | null, identity: null as ShopifyCsvIdentity | null }]))
  const handleOfRow = new Map(table.records.map(r => [r.row, r.values[handleH].trim()]))
  const idOf = (r: TransferRow) => r.sku.startsWith('PRODUCT:') ? r.sku : `PRODUCT:${handleOfRow.get(r.row)}|${r.sku}`
  for (const r of read.rows as TransferRow[]) {
    if (r.action !== 'SET') continue
    const h = held.get(idOf(r))!
    if (r.field === 'price') h.price = Number(r.value)
    else if (r.field === 'compareAt') h.compareAt = Number(r.value)
    else if (r.field === SHOPIFY_CSV_IDENTITY) h.identity = r.value as ShopifyCsvIdentity
    else h.values.set(r.field, r.value)
  }
  const products: ShopifyExportProduct[] = targets.filter(t => !t.parentSku).map(t => ({ sku: t.sku, identity: held.get(t.id)!.identity, values: held.get(t.id)!.values,
    variants: new Map(targets.filter(v => v.parentSku === t.sku).map(v => { const h = held.get(v.id)!; return [v.sku, { sku: v.sku, values: h.values, price: h.price, compareAt: { state: h.compareAt === null ? 'inherited' : 'stored', value: h.compareAt } } as ShopifyExportVariant] })) }))
  const out = buildShopifyCsv(fields, products, { spec, storeFields: false, includePrices: true })
  const cmp = compareShopifyCsv(table, out, shopifyChannelKeyOf)
  return {
    form: { formKind: form.formKind, formKey: form.formKey, templateVersion: form.templateVersion, keyFingerprint: form.keyFingerprint },
    mapping: mappingCounts(fields),
    read: { rows: read.rows.length, excluded: read.exclusions.length, refused: read.issues.length, unaccounted: ledger.unaccounted.length, duplicated: ledger.duplicated.length, dangling: ledger.danglingRows.length },
    roundTrip: { compared: cmp.compared, equal: cmp.equal, differ: cmp.differ.length, missing: cmp.missing.length, extra: cmp.extra.length, blankByDesign: cmp.columnsLeftOut, rowsRefusedOnImport: cmp.rowsNotWritten },
    differences: [...cmp.differ.map(d => ({ header: d.header, original: d.original, exported: d.exported })), ...cmp.missing.map(d => ({ header: d.header, original: d.original })), ...cmp.extra.map(d => ({ header: d.header, exported: d.exported }))],
    export: { products: out.products, variants: out.variants, columnsWritten: out.headers.length, columnsLeftOut: out.omitted.map(o => o.header), productsRefused: out.refused.length, safety: checkShopifyExport(fields, out) },
  }
}
