import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import type { ShopifyCsvIdentity } from '../pim/catalog-shopify-csv.js'
import { shopifyColumnOf } from './shopify-draft.js'

/**
 * NCF N7 (`docs/studies/native-channel-files.md` §2.4) — Nexus values → Shopify's own product CSV, through ONE mapping
 * version. Pure; the inverse of the product-CSV reader. Built around Shopify's two traps (S1):
 *   - a BLANK cell ERASES Shopify's value, while an omitted column keeps it. So a column is written only when Nexus holds
 *     a value for every row that carries it (the first row of a product for product fields, every variant row for
 *     variant fields); otherwise it is left out of the whole file and the summary names it.
 *   - missing option columns DELETE variants, and a changed option value replaces the variant. So Option1..3 Name/Value
 *     are always written, exactly as Shopify's own file last gave them (`shopifyCsvIdentity`), for every variant row;
 *     a product with a variant Nexus does not link is not written at all.
 * Handle, Title, Variant SKU and Status are always written (a file without Status can make a product active).
 * Never written: stock and inventory, publication, pictures, cost — Shopify keeps them. D1 A: only products Nexus
 * already links to Shopify (it holds their Shopify identity); nothing is created.
 */

export interface ShopifyExportVariant {
  /** The Nexus product SKU of this variant's listing. */
  sku: string
  /** Stored values of the variant's listing (spec key → value), as the transfer export reads them. */
  values: Map<string, unknown>
  /** The listing price Nexus would publish; `null` = none. */
  price: number | null
  /** The compare-at price the price door recorded (`compare-at-price.ts`). */
  compareAt: { state: 'stored' | 'inherited'; value: number | null }
}
export interface ShopifyExportProduct {
  /** The Nexus SKU of the listing that holds the product's Shopify identity. */
  sku: string
  identity: ShopifyCsvIdentity | null
  /** Stored values of the product's listing (spec key → value). */
  values: Map<string, unknown>
  /** The product's variant listings, by the SKU Shopify sells each variant as. */
  variants: Map<string, ShopifyExportVariant>
}
export interface ShopifyExportResult {
  headers: string[]
  rows: string[][]
  /** Columns left out of the file on purpose, with the reason (Shopify keeps its values there). */
  omitted: { header: string; reason: string }[]
  /** Products not written, with the reason. */
  refused: { sku: string; reason: string }[]
  products: number
  variants: number
}

type Column =
  | { kind: 'handle' | 'sku' | 'status' | 'title' | 'price' | 'compareAt'; header: string }
  | { kind: 'optionName' | 'optionValue' | 'optionLinked'; header: string; n: number }
  | { kind: 'product' | 'variant'; header: string; key: string; label: string }

const text = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') return value
  return null
}
const money = (n: number | null) => n === null ? null : n.toFixed(2)

/** A stored Shopify value as its cell in Shopify's own product CSV. `null` = Nexus holds no value. */
export function shopifyCellOf(key: string, value: unknown, type?: string): string | null {
  if (value === null || value === undefined || value === '') return null
  if (key === 'tags') return Array.isArray(value) && value.length ? value.map(String).join(', ') : typeof value === 'string' && value.trim() ? value : null
  if (key === 'category') return typeof value === 'string' ? value.replace(/^gid:\/\/shopify\/TaxonomyCategory\//, '') || null : null
  if (key === 'inventoryPolicy') return typeof value === 'string' ? value.toLowerCase() : null
  if (type?.startsWith('list.')) {
    let list: unknown = value
    if (typeof value === 'string') { try { list = JSON.parse(value) } catch { return null } }
    return Array.isArray(list) && list.length ? list.map(String).join('; ') : null
  }
  const out = text(value)
  return out === null || out === '' ? null : out
}

export function buildShopifyCsv(fields: readonly MappingFieldRow[], products: readonly ShopifyExportProduct[], options: { spec: ChannelSpec; storeFields: boolean; includePrices: boolean }): ShopifyExportResult {
  const omitted: ShopifyExportResult['omitted'] = []
  const omit = (header: string, reason: string) => { if (!omitted.some(o => o.header === header)) omitted.push({ header, reason }) }
  const columns: Column[] = []
  for (const f of [...fields].sort((a, b) => a.sortOrder - b.sortOrder)) {
    const header = f.columnKey ?? f.channelKey
    const option = /^Option([123]) (Name|Value|Linked To)$/.exec(f.channelKey)
    if (f.targetKind === 'identity') { columns.push({ kind: f.targetKey === 'sku' ? 'sku' : 'handle', header }); continue }
    if (option) { columns.push({ kind: option[2] === 'Name' ? 'optionName' : option[2] === 'Value' ? 'optionValue' : 'optionLinked', header, n: Number(option[1]) }); continue }
    if (f.channelKey === 'Status') { columns.push({ kind: 'status', header }); continue }
    const sends = f.state === 'mapped' && f.direction !== 'in'
    if (f.targetKind === 'price' || f.targetKind === 'compareAt') {
      if (!options.includePrices) omit(header, 'Prices were not included in this export; Shopify keeps its prices.')
      else if (!sends) omit(header, f.reason ?? `Column is ${f.state}.`)
      else columns.push({ kind: f.targetKind, header })
      continue
    }
    if (f.targetKind === 'channelField' && f.targetKey === 'title') { columns.push({ kind: 'title', header }); continue }
    if (f.targetKind !== 'channelField' || !sends || !f.targetKey) { omit(header, f.reason ?? `Column is ${f.state}; Shopify keeps its values.`); continue }
    const metafield = /^metafield:PRODUCT:(.+)$/.exec(f.targetKey)
    if (metafield && !options.storeFields) { omit(header, 'This store’s field list is not loaded in Nexus, so its metafields are left out; Shopify keeps them.'); continue }
    const spec = metafield ? options.spec.fields.find(s => s.shopifyField?.id === f.targetKey) : options.spec.fields.find(s => s.key === f.targetKey)
    if (!spec) { omit(header, `This store has no Shopify field ${f.targetKey}; left out.`); continue }
    columns.push({ kind: spec.shopifyField?.owner === 'PRODUCTVARIANT' ? 'variant' : 'product', header, key: spec.key, label: f.label ?? header })
  }
  if (!columns.some(c => c.kind === 'handle')) throw new Error('This mapping version has no Handle column; Shopify cannot match a product without it.')
  if (!columns.some(c => c.kind === 'sku')) throw new Error('This mapping version has no Variant SKU column; Nexus cannot name the variants without it.')
  for (const n of [1, 2]) if (!columns.some(c => c.kind === 'optionName' && c.n === n) || !columns.some(c => c.kind === 'optionValue' && c.n === n)) {
    // Shopify deletes variants when option columns are missing: a version without them cannot write a safe file.
    if (n === 1) throw new Error('This mapping version has no Option1 Name / Option1 Value columns. Shopify deletes variants when they are missing; export from a version made from Shopify’s full product export.')
  }
  if (!columns.some(c => c.kind === 'status')) throw new Error('This mapping version has no Status column. A file without Status can make a draft product active; export from a version made from Shopify’s full product export.')
  const typeOf = new Map(options.spec.fields.map(s => [s.key, s.shopifyField?.type]))

  // Which products can be written at all.
  const refused: ShopifyExportResult['refused'] = []
  const written: ShopifyExportProduct[] = []
  for (const p of products) {
    const id = p.identity
    if (!id) { refused.push({ sku: p.sku, reason: 'Nexus has not read this product from Shopify’s own product file yet, so it does not know its handle, options and variants. Import Shopify’s product export once, then export again.' }); continue }
    if (!id.status) { refused.push({ sku: p.sku, reason: 'Nexus does not know this product’s Shopify status; a file without it can make the product active.' }); continue }
    const unlinked = id.variants.filter(v => !v.sku || !p.variants.has(v.sku))
    if (unlinked.length) { refused.push({ sku: p.sku, reason: `Shopify holds ${id.variants.length} variants of this product; Nexus links ${id.variants.length - unlinked.length}. A file without the others could erase or delete them in Shopify.` }); continue }
    if (!shopifyCellOf('title', p.values.get('title'))) { refused.push({ sku: p.sku, reason: 'Shopify needs a Title to update a product, and Nexus holds none for it.' }); continue }
    written.push(p)
  }
  const variantsOf = (p: ShopifyExportProduct) => p.identity!.variants.map(v => ({ id: v, listing: p.variants.get(v.sku!)! }))

  // A column is written only when every row that carries it has a value (a blank cell erases Shopify's value).
  const linkedTo = written.some(p => p.identity!.linkedTo?.some(Boolean))
  const kept = columns.filter(c => {
    if (c.kind === 'optionLinked' && !linkedTo) { omit(c.header, 'No product carries an option link; Shopify keeps its own.'); return false }
    if (c.kind === 'product') {
      const missing = written.filter(p => shopifyCellOf(c.key, p.values.get(c.key), typeOf.get(c.key)) === null).length
      if (missing) { omit(c.header, `Nexus holds no ${c.label} for ${missing} of ${written.length} products; left out so Shopify keeps its values.`); return false }
    }
    if (c.kind === 'variant' || c.kind === 'price' || c.kind === 'compareAt') {
      const rows = written.flatMap(variantsOf)
      const kind = c.kind, key = c.kind === 'variant' ? c.key : ''
      const has = ({ listing }: (typeof rows)[number]) => kind === 'price' ? listing.price !== null : kind === 'compareAt' ? listing.compareAt.value !== null
        : shopifyCellOf(key, listing.values.get(key), typeOf.get(key)) !== null
      const missing = rows.filter(r => !has(r)).length
      if (missing) { omit(c.header, `Nexus holds no ${c.kind === 'variant' ? c.label : c.kind === 'price' ? 'price' : 'compare-at price'} for ${missing} of ${rows.length} variants; left out so Shopify keeps its values.`); return false }
    }
    return true
  })

  const rows: string[][] = []
  for (const p of written) {
    const id = p.identity!
    for (const [index, { id: v, listing }] of variantsOf(p).entries()) {
      const first = index === 0
      rows.push(kept.map(c => {
        switch (c.kind) {
          case 'handle': return id.handle
          case 'sku': return v.sku!
          case 'title': return first ? shopifyCellOf('title', p.values.get('title'))! : ''
          case 'status': return first ? id.status! : ''
          case 'optionName': return first ? id.options[c.n - 1] ?? '' : ''
          case 'optionLinked': return first ? id.linkedTo?.[c.n - 1] ?? '' : ''
          case 'optionValue': return v.values[c.n - 1] ?? ''
          case 'price': return money(listing.price) ?? ''
          case 'compareAt': return money(listing.compareAt.value) ?? ''
          case 'product': return first ? shopifyCellOf(c.key, p.values.get(c.key), typeOf.get(c.key)) ?? '' : ''
          case 'variant': return shopifyCellOf(c.key, listing.values.get(c.key), typeOf.get(c.key)) ?? ''
        }
      }))
    }
  }
  return { headers: kept.map(c => c.header), rows, omitted, refused, products: written.length, variants: rows.length }
}

/** Shopify wants UTF-8 with LF line feeds (S1). A cell is quoted only when it must be. */
export function shopifyCsvText(headers: readonly string[], rows: readonly string[][]): string {
  const cell = (v: string) => /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
  return [headers, ...rows].map(line => line.map(cell).join(',')).join('\n') + '\n'
}

/**
 * The upload-safety checks (study §4.1 check 4), run on every file before it leaves Nexus: no stock, picture or
 * publication column, Handle and Status present, Option1 Name/Value present whenever a SKU is, and no blank cell in a
 * written column on a row that carries it (the first row of a product for product columns, every row for variant
 * columns; option columns are exempt — Shopify's own file leaves an unused option blank). Empty = safe to upload.
 */
export function checkShopifyExport(fields: readonly MappingFieldRow[], result: Pick<ShopifyExportResult, 'headers' | 'rows'>): string[] {
  const problems: string[] = []
  const byHeader = new Map(fields.map(f => [f.columnKey ?? f.channelKey, f]))
  const cols = result.headers.map(h => ({ header: h, field: byHeader.get(h), info: shopifyColumnOf(h) }))
  for (const c of cols) {
    if (!c.field) problems.push(`${c.header} is not a column of the mapping version`)
    else if (['quantity', 'image'].includes(c.field.targetKind) || c.info.channelKey === 'Published' || c.info.kind === 'column' && ['stock', 'media', 'cost'].includes(c.info.column.role)) problems.push(`${c.header} must never be written`)
  }
  const at = (key: string) => cols.findIndex(c => c.info.channelKey === key)
  const handle = at('Handle')
  if (handle < 0) problems.push('Handle is missing')
  if (at('Status') < 0) problems.push('Status is missing')
  if (at('Variant SKU') >= 0 && (at('Option1 Name') < 0 || at('Option1 Value') < 0)) problems.push('Option1 Name / Option1 Value are missing while Variant SKU is written')
  if (handle < 0) return problems
  for (const [r, row] of result.rows.entries()) {
    const first = r === 0 || result.rows[r - 1][handle] !== row[handle]
    for (const [i, c] of cols.entries()) {
      if (c.info.kind === 'column' && c.info.column.role === 'option') continue
      const level = c.info.kind === 'column' ? c.info.column.level : c.info.kind === 'metafield' ? 'product' : 'product'
      const carries = level === 'variant' || c.info.channelKey === 'Handle' || first
      if (carries && !row[i]?.trim()) problems.push(`Row ${r + 2}, ${c.header}: a blank cell would erase Shopify’s value`)
    }
  }
  return problems
}

/**
 * The round trip (golden files, real-file runs): Shopify's own file against the file Nexus writes back, cell by cell,
 * for the columns the export wrote and the variants it wrote. A column the export left out is counted, never compared.
 */
export function compareShopifyCsv(original: { headers: string[]; records: { values: Record<string, string> }[] }, exported: { headers: string[]; rows: string[][] }, keyOf: (header: string) => string) {
  const origH = new Map(original.headers.map(h => [keyOf(h), h]))
  const outH = new Map(exported.headers.map((h, i) => [keyOf(h), i]))
  const handleKey = 'Handle', skuKey = 'Variant SKU'
  const out = { compared: 0, equal: 0, differ: [] as { header: string; original: string; exported: string }[], missing: [] as { header: string; original: string }[], extra: [] as { header: string; exported: string }[],
    columnsLeftOut: [...origH.keys()].filter(k => !outH.has(k)).length, rowsWritten: exported.rows.length, rowsNotWritten: 0 }
  const rowKey = (handle: string, sku: string) => `${handle}\u0000${sku}`
  const written = new Map(exported.rows.map(r => [rowKey(r[outH.get(handleKey)!] ?? '', r[outH.get(skuKey)!] ?? ''), r]))
  const v = (rec: { values: Record<string, string> }, key: string) => (origH.has(key) ? rec.values[origH.get(key)!] ?? '' : '').trim()
  const same = (key: string, a: string, b: string) => a === b || (/^-?\d+(\.\d+)?$/.test(a) && /^-?\d+(\.\d+)?$/.test(b) && Number(a) === Number(b))
    || key === 'Tags' && a.split(',').map(s => s.trim()).filter(Boolean).join('|') === b.split(',').map(s => s.trim()).filter(Boolean).join('|')
  for (const rec of original.records) {
    const sku = v(rec, skuKey)
    if (!sku) continue // picture rows and SKU-less variants are never written
    const row = written.get(rowKey(v(rec, handleKey), sku))
    if (!row) { out.rowsNotWritten++; continue }
    for (const [key, i] of outH) {
      const a = v(rec, key), b = (row[i] ?? '').trim()
      if (!a && !b) continue
      out.compared++
      if (a && b && same(key, a, b)) { out.equal++; continue }
      if (a && !b) out.missing.push({ header: key, original: a })
      else if (!a && b) out.extra.push({ header: key, exported: b })
      else out.differ.push({ header: key, original: a, exported: b })
    }
  }
  return out
}
