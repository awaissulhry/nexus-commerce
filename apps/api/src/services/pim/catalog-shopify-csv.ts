import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'
import { assertCsvRectangle, parseCatalogCsv } from './catalog-csv-dialect.js'
import { TRANSFER_MAX_FILE_BYTES, TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import type { ChannelFieldSpec, ChannelSpec } from './channel-specs/types.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { shopifyChannelKeyOf, shopifyColumnOf, shopifyMetafieldTarget, type ShopifyColumnInfo } from '../channel-mapping/shopify-draft.js'
import { ignoredReason, unmappedReason, type ReaderMapping } from '../channel-mapping/decisions.js'

/**
 * NCF (`docs/studies/native-channel-files.md` §2, §3) — Shopify's own product CSV (admin → Products → Export).
 *
 * One row per variant; the first row of a product carries its product fields; a product's extra pictures are rows
 * with only the handle and the picture. `Handle` ties a product's rows together. Measured on the Owner's export
 * (study §7): comma, UTF-8 without BOM, LF, decimal point, classic header names.
 *
 * What an import WRITES (study §2.3, after the preview and Apply): the mapped product fields on the Shopify listing
 * Nexus links the product to, the variant fields on each variant's Shopify listing, the price and the compare-at price
 * through the one price door (record-only), and Shopify's own identity of the product (handle, status, option names
 * and values: `shopifyCsvIdentity`) so an export can write them back unchanged.
 * What it NEVER writes, each cell with its reason: stock and inventory, status and publication, pictures, the
 * variant structure, variant metafields, and anything of a product or handle Nexus does not know.
 *
 * This module is imported by the parse WORKER: nothing at its top level may touch the database. The host half
 * (`resolveShopifyCsv…` below) imports Prisma lazily, like the eBay reader.
 */

export interface ShopifyCsvTable {
  headers: string[]
  /** Data records in file order; `row` is the record number (the header is row 1). Blank records are dropped. */
  records: { row: number; values: Record<string, string> }[]
  /** The file's own dialect, as read. */
  dialect: { delimiter: string; lineEnding: 'LF' | 'CRLF'; bom: boolean }
}

const MAX_CELL = 256_000

/** Read the file into a table. Refuses what Shopify itself would refuse (a nameless or repeated column). */
export function readShopifyCsv(buffer: Buffer): ShopifyCsvTable {
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) throw new Error('Choose a non-empty Shopify product CSV up to 10 MB')
  const { grid, delimiter } = parseCatalogCsv(buffer, TRANSFER_MAX_FILE_BYTES)
  if (!grid.length) throw new Error('Shopify’s file is empty')
  assertCsvRectangle(grid, delimiter)
  const headers = grid[0].map(h => h.replace(/^﻿/, '').trim())
  if (headers.some(h => !h)) throw new Error('A column of this Shopify file has no header. Use the file as Shopify exported it.')
  const repeated = headers.filter((h, i) => headers.indexOf(h) !== i)
  if (repeated.length) throw new Error(`Column ${repeated[0]} appears twice. Keep one of them and import again.`)
  // Two spellings of ONE Shopify column (`Handle` and `URL handle`, `Barcode` and `Variant Barcodes`): Shopify refuses
  // a file with both ("can't have both"), and Nexus would not know which to believe.
  const byKey = new Map<string, string>()
  for (const h of headers) {
    const key = shopifyChannelKeyOf(h), other = byKey.get(key)
    if (other) throw new Error(`Columns ${other} and ${h} are the same Shopify column. Keep one of them and import again.`)
    byKey.set(key, h)
  }
  if (grid.length - 1 > TRANSFER_MAX_ROWS) throw new Error(`A file can contain at most ${TRANSFER_MAX_ROWS.toLocaleString()} rows`)
  const records: ShopifyCsvTable['records'] = []
  for (const [index, line] of grid.slice(1).entries()) {
    const values: Record<string, string> = {}
    for (const [c, header] of headers.entries()) {
      const cell = line[c] ?? ''
      if (cell.length > MAX_CELL) throw new Error(`Row ${index + 2}, ${header}: the cell exceeds 256,000 characters`)
      values[header] = cell
    }
    if (Object.values(values).some(v => v.trim())) records.push({ row: index + 2, values })
  }
  if (!records.length) throw new Error('Shopify’s file contains no product rows')
  const bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  return { headers, records, dialect: { delimiter, lineEnding: buffer.includes('\r\n') ? 'CRLF' : 'LF', bom } }
}

/** How many products (handles) and variant rows a table holds: the one sentence a door says before it reads further. */
export function shopifyCsvShape(table: ShopifyCsvTable) {
  const handleHeader = table.headers.find(h => shopifyChannelKeyOf(h) === 'Handle')
  const handles = new Set(table.records.map(r => (handleHeader ? r.values[handleHeader] : '')?.trim()).filter(Boolean))
  return { products: handles.size, rows: table.records.length }
}

// ── Shopify's identity of a product, as last read from its own file ─────────────────────────────────────────────

/** The Listings fact a Shopify product CSV records on the product's listing (`platformAttributes.shopifyCsvIdentity`). */
export const SHOPIFY_CSV_IDENTITY = 'shopifyCsvIdentity'
export interface ShopifyCsvIdentity {
  handle: string
  /** Shopify's product status as the file said it (`active`, `draft`, `archived`), or `null` when the file had none. */
  status: string | null
  /** Option1..3 names in order (Shopify's default variant is `Title` / `Default Title`). */
  options: string[]
  /** Option1..3 "Linked To" (a metafield-linked option), when the file carried any. */
  linkedTo?: string[]
  /** Every variant row of the product, in file order: its SKU (`null` = none) and its option values. */
  variants: { sku: string | null; values: string[] }[]
}
export function shopifyCsvIdentityError(value: unknown): string | null {
  const v = value as Partial<ShopifyCsvIdentity> | null
  const texts = (a: unknown) => Array.isArray(a) && a.every(x => typeof x === 'string')
  if (!v || typeof v !== 'object' || typeof v.handle !== 'string' || !v.handle.trim() || !(v.status === null || typeof v.status === 'string') || !texts(v.options) || !v.options!.length
    || (v.linkedTo !== undefined && (!texts(v.linkedTo) || v.linkedTo.length !== v.options!.length)) || !Array.isArray(v.variants) || !v.variants.length
    || v.variants.some(x => !x || !(x.sku === null || typeof x.sku === 'string') || !texts(x.values) || x.values.length !== v.options!.length)) return 'The Shopify product identity is malformed; import Shopify’s file again.'
  return null
}
export function readShopifyCsvIdentity(platformAttributes: unknown): ShopifyCsvIdentity | null {
  const bag = platformAttributes && typeof platformAttributes === 'object' ? (platformAttributes as Record<string, unknown>)[SHOPIFY_CSV_IDENTITY] : null
  return bag && !shopifyCsvIdentityError(bag) ? bag as ShopifyCsvIdentity : null
}

// ── The mapping: table → transfer rows, every filled cell accounted for ──────────────────────────────────────────

/** One Shopify listing of the chosen store, as a verified coordinate. */
export interface ShopifyCsvTarget {
  id: string
  /** The Nexus product SKU. */
  sku: string
  /** The Nexus parent's SKU; `null` for a root or standalone product. */
  parentSku: string | null
  accountId: string
  aliasKey: string
  version: number
  /** The handles Nexus knows this listing by (its recorded Shopify identity, its handle field, a linked product). */
  handles: string[]
  /** The SKU Shopify sells the variant as, when Nexus holds one that differs from the product SKU. */
  listingSku?: string | null
}
export interface ShopifyCsvOptions {
  accountId: string
  /** The Shopify spec for this store: native fields always, the store's metafields when its field list is loaded. */
  spec: ChannelSpec
  /** Whether `spec` carries the store's own fields (its saved field list). `false` = metafield cells are refused. */
  storeFields: boolean
  /** Confirmed links: the file's handle → the Nexus product SKU whose Shopify listing it is. */
  links?: Record<string, string>
  /** Nexus products the file's SKUs and links name: for a proposal, and for a refusal that says why. */
  products?: ReadonlyMap<string, { sku: string; parentSku: string | null }>
  mapping?: ReaderMapping
  /** The product sheet: rows of another product group are skipped, not refused. */
  onlyRootSku?: string
}
export interface ShopifyLedgerEntry { row: number; sku: string; header: string; outcome: 'row' | 'excluded' | 'refused' | 'skipped-row'; field?: string; reason?: string }
export interface ShopifyCsvResult {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions: SourceExclusion[]; ledger: ShopifyLedgerEntry[]
  /** CFI-4 — a link the Owner confirms: `fileSku` is the Shopify handle, `proposedSku` the Nexus product. */
  links: { fileSku: string; proposedSku: string; reason: string }[]
  warnings: string[]
  mapping?: { setId: string; version: number; status: string; label: string; created: boolean }
}

type Record_ = ShopifyCsvTable['records'][number]
type Level = 'product' | 'variant' | 'image' | 'any'
const levelOf = (info: ShopifyColumnInfo): Level => info.kind === 'column' ? info.column.level : info.kind === 'metafield' ? (info.owner === 'variant' ? 'variant' : 'product') : info.kind === 'pattern' ? info.level : 'any'
const PRICE = /^\d+(?:\.\d+)?$/
const round2 = (n: number) => Math.round(n * 100) / 100
/** Metafield types whose CSV text is their value (Shopify writes references by handle, and structured types as JSON). */
const CSV_METAFIELD_TYPES = new Set(['single_line_text_field', 'multi_line_text_field', 'number_integer', 'number_decimal', 'boolean', 'url', 'color', 'date', 'date_time'])
const csvMetafieldType = (type: string) => CSV_METAFIELD_TYPES.has(type.replace(/^list\./, '')) && type !== 'list.multi_line_text_field'

const MEDIA = 'Pictures are not imported: Shopify keeps its media, and Nexus manages pictures in the media workspace.'
const NO_SKU = 'This Shopify variant has no SKU. Nexus matches variants by SKU: give it its SKU in Shopify, export the file again, then import.'
const COLD_STORE = 'This store’s field list (its metafield definitions) is not loaded in Nexus, so its metafield columns cannot be read. Open a product’s Shopify tab once to load it, then import again.'

export function mapShopifyCsv(table: ShopifyCsvTable, targets: readonly ShopifyCsvTarget[], options: ShopifyCsvOptions): ShopifyCsvResult {
  const out: ShopifyCsvResult = { rows: [], issues: [], exclusions: [], ledger: [], links: [], warnings: [] }
  const info = new Map(table.headers.map(h => [h, shopifyColumnOf(h)]))
  const byKey = new Map(table.headers.map(h => [info.get(h)!.channelKey, h]))
  const H = (key: string) => byKey.get(key)
  const handleH = H('Handle'), skuH = H('Variant SKU')
  if (!handleH) throw new Error('Keep Shopify’s Handle column: it ties the rows of a product together.')
  const v = (rec: Record_, header?: string) => header ? (rec.values[header] ?? '').trim() : ''
  const variantHeaders = table.headers.filter(h => levelOf(info.get(h)!) === 'variant')
  const isVariantRow = (rec: Record_) => variantHeaders.some(h => v(rec, h))
  const filled = (rec: Record_) => table.headers.filter(h => v(rec, h))
  const source = (header: string) => ({ sheet: 'CSV', column: header })
  const acc = options.accountId
  const skuOfListing = (t: ShopifyCsvTarget) => t.sku

  /** Refuse (or skip) every filled cell of a record with one reason, and one issue for the record. */
  const decideRecord = (rec: Record_, outcome: 'refused' | 'skipped-row', field: string, message: string, sku: string) => {
    if (outcome === 'refused') out.issues.push({ row: rec.row, sku, field, message, source: source(field), channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: acc } as TransferIssue)
    else out.exclusions.push({ row: rec.row, sku, field, message, source: source(field) })
    for (const header of filled(rec)) out.ledger.push({ row: rec.row, sku, header, outcome, reason: message })
  }

  // Group the rows by handle, in file order.
  const groups = new Map<string, Record_[]>()
  for (const rec of table.records) {
    const handle = v(rec, handleH)
    if (!handle) { decideRecord(rec, 'refused', handleH, 'Every row of Shopify’s product file needs its Handle.', v(rec, skuH)); continue }
    groups.set(handle, [...groups.get(handle) ?? [], rec])
  }

  // Pass 1 — which Nexus listing each Shopify product is. Nothing unknown is created or guessed.
  const store = targets.filter(t => t.accountId === acc)
  const productOf = new Map<string, ShopifyCsvTarget | string>()
  for (const [handle, recs] of groups) {
    const known = store.filter(t => t.handles.includes(handle))
    if (known.length > 1) { productOf.set(handle, `Several Nexus listings are linked to Shopify product ${handle} in this store (${known.map(skuOfListing).join(', ')}). Keep one link, then import again.`); continue }
    if (known.length === 1) { productOf.set(handle, known[0]); continue }
    const linked = options.links?.[handle]
    if (linked) {
      const listing = store.find(t => t.sku === linked && t.aliasKey === '')
      if (!listing) productOf.set(handle, options.products?.has(linked) ? `Nexus product ${linked} has no Shopify listing in this store. Publish it to Shopify from Nexus first: an import never creates listings.` : `${linked} is not a Nexus product.`)
      else if (listing.handles.length) productOf.set(handle, `Nexus product ${linked} is already linked to Shopify product ${listing.handles[0]}, not ${handle}.`)
      else productOf.set(handle, listing)
      continue
    }
    const skus = [...new Set(recs.map(r => v(r, skuH)).filter(Boolean))]
    const found = skus.map(s => options.products?.get(s)).filter((p): p is { sku: string; parentSku: string | null } => !!p)
    const roots = [...new Set(found.map(p => p.parentSku ?? p.sku))]
    if (roots.length === 1) {
      const root = roots[0], listing = store.find(t => t.sku === root && t.aliasKey === '')
      if (listing && !listing.handles.length) {
        out.links.push({ fileSku: handle, proposedSku: root, reason: `${found.length} of ${skus.length} variant SKUs of Shopify product ${handle} belong to Nexus product ${root}` })
        productOf.set(handle, `Link Shopify product ${handle} to Nexus product ${root}? Confirm the link to import it.`)
      } else productOf.set(handle, listing ? `Nexus product ${root} is linked to Shopify product ${listing.handles[0]}, not ${handle}.`
        : `Nexus product ${root} has no Shopify listing in this store. Publish it to Shopify from Nexus first: an import never creates listings.`)
      continue
    }
    productOf.set(handle, `Nexus does not link a Shopify product with the handle ${handle} in this store${roots.length > 1 ? ', and its variant SKUs belong to several Nexus products' : ''}. Publish or link the product first: an import never creates products.`)
  }
  // Two Shopify products on one Nexus listing: neither can be applied as "the" product.
  const byListing = new Map<string, string[]>()
  for (const [handle, p] of productOf) if (typeof p !== 'string') byListing.set(p.id, [...byListing.get(p.id) ?? [], handle])
  for (const [, handles] of byListing) if (handles.length > 1) for (const h of handles) productOf.set(h, `Shopify products ${handles.join(', ')} are all linked to one Nexus listing (${(productOf.get(h) as ShopifyCsvTarget).sku}). Keep one link, then import again.`)

  // Pass 2 — which Nexus listing each variant row is.
  const variantOf = new Map<Record_, ShopifyCsvTarget | string>()
  for (const [handle, recs] of groups) {
    const product = productOf.get(handle)
    if (typeof product !== 'object') continue
    for (const rec of recs.filter(isVariantRow)) {
      const sku = v(rec, skuH)
      if (!sku) { variantOf.set(rec, NO_SKU); continue }
      const candidates = store.filter(t => t.aliasKey === product.aliasKey && (t.sku === sku || t.listingSku === sku) && (t.id === product.id || t.parentSku === product.sku))
      if (candidates.length === 1) { variantOf.set(rec, candidates[0]); continue }
      if (candidates.length > 1) { variantOf.set(rec, `Several Nexus listings match ${sku} in this store; resolve the duplicate first.`); continue }
      const p = options.products?.get(sku)
      variantOf.set(rec, !p ? `${sku} is not a Nexus product. Create it first, then import this file again.`
        : p.sku !== product.sku && p.parentSku !== product.sku ? `${sku} belongs to Nexus product ${p.parentSku ?? p.sku}, not to ${product.sku}, which Shopify product ${handle} is linked to.`
        : `Nexus holds no Shopify listing of ${sku} in this store. Publish it to Shopify from Nexus first: an import never creates listings.`)
    }
  }
  const rowsByListing = new Map<string, number[]>()
  for (const [rec, t] of variantOf) if (typeof t !== 'string') rowsByListing.set(t.id, [...rowsByListing.get(t.id) ?? [], rec.row])
  for (const [rec, t] of variantOf) if (typeof t !== 'string' && rowsByListing.get(t.id)!.length > 1) variantOf.set(rec, `Rows ${rowsByListing.get(t.id)!.join(', ')} name the same Nexus listing of ${t.sku}; keep one row per variant.`)

  const warnedCold = { done: false }
  // Pass 3 — every filled cell: a row, an exclusion or a refusal, decided where it is decided.
  for (const [handle, recs] of groups) {
    const product = productOf.get(handle)!
    if (typeof product === 'string') { for (const rec of recs) decideRecord(rec, 'refused', handleH, product, v(rec, skuH) || handle); continue }
    if (options.onlyRootSku && (product.parentSku ?? product.sku) !== options.onlyRootSku) { for (const rec of recs) decideRecord(rec, 'skipped-row', handleH, 'Outside this product; use Catalog import', v(rec, skuH) || handle); continue }
    const first = recs[0]
    const variantRecs = recs.filter(isVariantRow)
    const identity = identityOf(handle, first, variantRecs)
    const noted = identity ? ' It is noted with the product’s Shopify identity, so an export writes it back unchanged.' : ''
    for (const rec of recs) {
      const variant = variantOf.get(rec)
      const isFirst = rec === first
      const coordinate = (t: ShopifyCsvTarget, fileSku?: string) => ({ row: rec.row, sku: t.sku, channel: 'SHOPIFY', accountId: t.accountId, marketplace: 'GLOBAL', aliasKey: t.aliasKey, locale: '', action: 'SET' as const,
        version: t.version, origin: 'channel-file' as const, ...(fileSku && fileSku !== t.sku ? { fileSku } : {}) })
      const emit = (t: ShopifyCsvTarget, header: string, field: string, value: unknown, entity: TransferRow['entity'] = 'Overrides', fileSku?: string) => {
        out.rows.push({ ...coordinate(t, fileSku), entity, field, value, source: source(header) })
        out.ledger.push({ row: rec.row, sku: t.sku, header, outcome: 'row', field })
      }
      const exclude = (sku: string, header: string, message: string) => {
        out.exclusions.push({ row: rec.row, sku, field: header, message, source: source(header) })
        out.ledger.push({ row: rec.row, sku, header, outcome: 'excluded', reason: message })
      }
      const refuse = (sku: string, header: string, message: string) => {
        out.issues.push({ row: rec.row, sku, field: header, message, source: source(header), channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: acc } as TransferIssue)
        out.ledger.push({ row: rec.row, sku, header, outcome: 'refused', reason: message })
      }
      for (const header of table.headers) {
        const raw = rec.values[header] ?? ''
        if (!raw.trim()) continue
        const column = info.get(header)!, level = levelOf(column)
        const fileSku = v(rec, skuH)
        const owner = level === 'variant' ? (typeof variant === 'object' ? variant : null) : product
        const who = owner?.sku ?? (fileSku || handle)
        // The handle: the product's identity on its first row, the grouping key on every other row.
        if (column.kind === 'column' && column.column.role === 'handle') {
          if (!isFirst) { exclude(product.sku, header, `Groups this row with Shopify product ${handle}.`); continue }
          if (identity) emit(product, header, SHOPIFY_CSV_IDENTITY, identity, 'Listings')
          else exclude(product.sku, header, `Identifies Shopify product ${handle}. This file has no option columns, so Shopify’s variants are not recorded and the product cannot be exported.`)
          continue
        }
        if (level === 'image') { exclude(product.sku, header, MEDIA); continue }
        if (level === 'product' && !isFirst) { refuse(product.sku, header, 'Shopify reads product fields from the first row of each product; this row repeats one. Remove it and import again.'); continue }
        if (level === 'variant' && typeof variant !== 'object') { refuse(who, header, typeof variant === 'string' ? variant : NO_SKU); continue }
        const target = owner!
        // The mapping version decides first: an Owner's decision wins over the rules below.
        let ownerField: string | null = null
        if (options.mapping) {
          const decision = options.mapping.byKey.get(column.channelKey)
          if (!decision) { refuse(who, header, unmappedReason(options.mapping, header, 'the column is not in this version')); continue }
          if (decision.state === 'unmapped') { refuse(who, header, unmappedReason(options.mapping, header, decision.reason)); continue }
          if (decision.decidedBy === 'owner' && (decision.state === 'ignored' || decision.state === 'managed')) { exclude(who, header, ignoredReason(options.mapping, decision.reason)); continue }
          if (decision.decidedBy === 'owner' && decision.targetKind === 'channelField' && decision.targetKey) ownerField = decision.targetKey
        }
        if (ownerField) {
          const field = specField(options, ownerField)
          const typed = field ? typedValue(field, raw) : { error: `${options.mapping!.label} maps this column to ${ownerField}, which this store's Shopify fields do not declare.` }
          if ('error' in typed) refuse(who, header, typed.error); else emit(target, header, field!.key, typed.value, field!.key === 'category' ? 'Listings' : 'Overrides', fileSku)
          continue
        }
        if (column.kind === 'pattern') { exclude(who, header, column.reason); continue }
        if (column.kind === 'unknown') { refuse(who, header, 'Not a column of Shopify’s product file that Nexus knows. Map or ignore it on the File mappings page, then import again.'); continue }
        if (column.kind === 'metafield') {
          if (column.owner === 'variant') { exclude(who, header, 'Shopify’s product CSV does not carry variant metafields; edit them in the Shopify tab.'); continue }
          if (!options.storeFields) {
            if (!warnedCold.done) { warnedCold.done = true; out.warnings.push(`Shopify metafields: ${COLD_STORE}`) }
            refuse(who, header, COLD_STORE); continue
          }
          const field = options.spec.fields.find(f => f.shopifyField?.definition && f.shopifyField.owner === 'PRODUCT' && f.shopifyField.definition.namespace === column.namespace && f.shopifyField.definition.key === column.key)
          if (!field) { refuse(who, header, `This store has no product metafield ${column.namespace}.${column.key}. Refresh the store’s fields in its Shopify tab, or ignore the column on the File mappings page.`); continue }
          const typed = metafieldValue(field, raw)
          if ('error' in typed) refuse(who, header, typed.error); else emit(target, header, field.key, typed.value, 'Overrides')
          continue
        }
        const c = column.column
        switch (c.role) {
          case 'sku': exclude(target.sku, header, `The variant’s identity: matched to Nexus product ${target.sku}${raw.trim() !== target.sku ? ` (Shopify sells it as ${raw.trim()})` : ''}.`); break
          case 'option': exclude(who, header, `Variant structure is not imported.${noted}`); break
          case 'lifecycle': exclude(who, header, c.header === 'Status' ? `Listing lifecycle is not imported (Status "${raw.trim()}").${noted}` : `Publication is not imported (Published "${raw.trim()}"); Shopify keeps it.`); break
          case 'stock': exclude(who, header, `Stock is never imported from a file: the stock ledger owns it. File value: ${raw.trim()}`); break
          case 'media': exclude(who, header, MEDIA); break
          case 'cost': exclude(who, header, `Product cost belongs to Nexus pricing; not imported from a channel file. File value: ${raw.trim()}`); break
          case 'ignored': exclude(who, header, c.reason ?? 'Not carried by Nexus.'); break
          case 'price': case 'compareAt': {
            const text = raw.trim()
            if (!PRICE.test(text)) { refuse(who, header, `Use a number with a decimal point for the ${c.role === 'price' ? 'price' : 'compare-at price'} (${text}).`); break }
            emit(target, header, c.role === 'price' ? 'price' : 'compareAt', round2(Number(text)), 'Overrides', fileSku)
            break
          }
          case 'field': {
            const field = specField(options, c.field!)
            const typed = field ? typedValue(field, raw) : { error: `This store’s Shopify fields have no ${c.field}.` }
            if ('error' in typed) refuse(who, header, typed.error)
            else emit(target, header, field!.key, typed.value, field!.key === 'category' ? 'Listings' : 'Overrides', level === 'variant' ? fileSku : undefined)
            break
          }
          default: refuse(who, header, 'Not a column Nexus reads.')
        }
      }
    }
  }
  if (out.rows.length + out.issues.length + out.exclusions.length > TRANSFER_MAX_ROWS) throw new Error('Shopify’s file exceeds 50,000 attribute outcomes')
  return out

  function identityOf(handle: string, first: Record_, variantRecs: Record_[]): ShopifyCsvIdentity | null {
    const names = [1, 2, 3].map(n => v(first, H(`Option${n} Name`)))
    let count = names.length
    while (count && !names[count - 1]) count--
    if (!count || !variantRecs.length) return null
    const linked = [1, 2, 3].slice(0, count).map(n => v(first, H(`Option${n} Linked To`)))
    return { handle, status: v(first, H('Status')) || null, options: names.slice(0, count), ...(linked.some(Boolean) ? { linkedTo: linked } : {}),
      variants: variantRecs.map(r => ({ sku: v(r, skuH) || null, values: [1, 2, 3].slice(0, count).map(n => v(r, H(`Option${n} Value`))) })) }
  }
}

const specField = (options: ShopifyCsvOptions, key: string): ChannelFieldSpec | undefined =>
  options.spec.fields.find(f => f.key === key) ?? (key.startsWith('metafield:PRODUCT:') ? options.spec.fields.find(f => f.shopifyField?.id === key) : undefined)

/** A native Shopify field's value from its CSV text, in the shape the transfer planner stores. */
function typedValue(field: ChannelFieldSpec, raw: string): { value: unknown } | { error: string } {
  if (field.shopifyField?.definition) return metafieldValue(field, raw)
  const text = raw.trim()
  switch (field.key) {
    case 'descriptionHtml': return { value: raw }
    case 'tags': return { value: [...new Set(text.split(',').map(t => t.trim()).filter(Boolean))] }
    case 'category': {
      if (/^gid:\/\/shopify\/TaxonomyCategory\/[a-zA-Z0-9-]+$/.test(text)) return { value: text }
      if (/^[a-z]{2}(?:-\d+)*$/.test(text)) return { value: `gid://shopify/TaxonomyCategory/${text}` }
      return { error: `Shopify’s file names the category by its path ("${text.length > 60 ? `${text.slice(0, 57)}…` : text}"); Nexus keeps Shopify’s category id. Choose the category in the Shopify tab.` }
    }
    case 'inventoryPolicy': {
      const policy = text.toUpperCase()
      if (!['DENY', 'CONTINUE'].includes(policy)) return { error: `Use deny or continue (${text}).` }
      return { value: policy }
    }
  }
  if (field.kind === 'boolean') {
    if (!['true', 'false'].includes(text.toLowerCase())) return { error: `Use true or false (${text}).` }
    return { value: text.toLowerCase() === 'true' }
  }
  if (field.kind === 'number') return /^-?\d+(?:\.\d+)?$/.test(text) ? { value: Number(text) } : { error: `Use a number with a decimal point (${text}).` }
  if (field.shape === 'list') return { value: text.split(',').map(t => t.trim()).filter(Boolean) }
  if (field.shape === 'measure') return { error: 'Nexus does not read a measurement from one CSV column; map this column to a text or number field.' }
  return { value: raw }
}

/** A product metafield's value: Shopify's own text form (a list as a JSON list), typed by the store's definition. */
function metafieldValue(field: ChannelFieldSpec, raw: string): { value: unknown } | { error: string } {
  const type = field.shopifyField!.type
  if (!csvMetafieldType(type)) return { error: `Nexus does not read ${type} metafields from Shopify’s CSV (Shopify writes them as handles or structured text). Edit this field in the Shopify tab.` }
  const text = raw.trim()
  if (!type.startsWith('list.')) return { value: type === 'multi_line_text_field' ? raw : text }
  return { value: JSON.stringify(text.split(/;\s*/).map(t => t.trim()).filter(Boolean)) }
}

/**
 * CFI-9 — the zero-loss check, computed INDEPENDENTLY of the mapper (the eBay reader's `checkEbayLedger`): the table's
 * filled cells against the ledger. `unaccounted` · `duplicated` · `danglingRows` (a 'row' entry with no emitted row) ·
 * `phantom` (an entry for a blank cell).
 */
export function checkShopifyLedger(table: ShopifyCsvTable, result: Pick<ShopifyCsvResult, 'rows' | 'ledger'>) {
  const cells = new Set<string>()
  for (const record of table.records) for (const header of table.headers) if (record.values[header]?.trim()) cells.add(JSON.stringify([record.row, header]))
  const counts = new Map<string, number>()
  for (const entry of result.ledger) { const key = JSON.stringify([entry.row, entry.header]); counts.set(key, (counts.get(key) ?? 0) + 1) }
  const emitted = new Set(result.rows.map(r => JSON.stringify([r.row, r.sku, r.field])))
  return {
    unaccounted: [...cells].filter(key => !counts.has(key)),
    duplicated: [...counts].filter(([, n]) => n > 1).map(([key]) => key),
    danglingRows: result.ledger.filter(e => e.outcome === 'row' && !emitted.has(JSON.stringify([e.row, e.sku, e.field]))),
    phantom: [...counts.keys()].filter(key => !cells.has(key)),
  }
}

/** The mapping target a product metafield column is keyed to (re-exported for the export). */
export { shopifyMetafieldTarget }

// ── The host half: the store, its listings, the products the file names, the store's fields, the mapping version ──

type Db = typeof import('../../db.js')['default']
const numericId = (id: unknown) => typeof id === 'string' ? id.split('/').at(-1) ?? null : null
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : {}

/** The store a Shopify file belongs to: the one named (when it is a Shopify store), else the only one connected. */
async function chooseStore(prisma: Db, requested: string | undefined, productId: string | undefined): Promise<{ id: string; label: string }> {
  const stores = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true, accountLabel: true }, orderBy: { id: 'asc' } })
  const label = (s: typeof stores[number]) => s.displayName ?? s.accountLabel ?? 'Shopify store'
  const named = requested ? stores.find(s => s.id === requested) : undefined
  if (named) return { id: named.id, label: label(named) }
  if (productId) {
    // The product sheet has no store chooser: the product group's own Shopify store, when it has exactly one.
    const { productTransferOptions } = await import('./catalog-product-transfer.js')
    const own = [...new Set((await productTransferOptions(productId)).listings.filter(l => l.channel === 'SHOPIFY').map(l => l.accountId))]
    if (own.length === 1) { const s = stores.find(x => x.id === own[0]); if (s) return { id: s.id, label: label(s) } }
    if (!own.length) throw new Error('This product has no Shopify listing. Nexus imports Shopify’s file onto the listings it already links to Shopify.')
    throw new Error('This product is listed in several Shopify stores. Import the file on the Catalog page and choose its store there.')
  }
  if (stores.length === 1) return { id: stores[0].id, label: label(stores[0]) }
  throw new Error(stores.length ? 'Choose the Shopify store this file belongs to: Shopify’s file does not name its store.' : 'No Shopify store is connected. Connect the store first.')
}

/** Every Shopify listing of the store, with the handles Nexus knows it by. */
export async function shopifyStoreTargets(prisma: Db, accountId: string): Promise<ShopifyCsvTarget[]> {
  const listings = await prisma.channelListing.findMany({ where: { channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: accountId },
    select: { id: true, aliasKey: true, version: true, externalListingId: true, platformAttributes: true, product: { select: { sku: true, deletedAt: true, parent: { select: { sku: true } } } } } })
  const live = listings.filter(l => l.product && !l.product.deletedAt)
  // A linked-products workspace names the Shopify products (and their handles) a family is linked to.
  const memberHandles = new Map<string, string>()
  for (const l of live) for (const m of record(record(l.platformAttributes)._nexusLinkedProducts).members ?? []) if (typeof m?.id === 'string' && typeof m.handle === 'string' && m.handle) memberHandles.set(numericId(m.id)!, m.handle)
  return live.map(l => {
    const pa = record(l.platformAttributes)
    const handles = [readShopifyCsvIdentity(pa)?.handle, typeof pa.handle === 'string' ? pa.handle : null, memberHandles.get(numericId(l.externalListingId) ?? '')]
      .filter((h): h is string => !!h && !!h.trim())
    const listingSku = [pa.sku, pa.sellerSku].find((x): x is string => typeof x === 'string' && !!x.trim() && x !== l.product!.sku) ?? null
    return { id: l.id, sku: l.product!.sku, parentSku: l.product!.parent?.sku ?? null, accountId, aliasKey: l.aliasKey, version: l.version, handles: [...new Set(handles)], listingSku }
  })
}

/** The store's Shopify spec from the SAVED field list only (never a live Shopify read); the native fields when none is saved. */
export async function shopifyStoreSpec(accountId: string): Promise<{ spec: ChannelSpec; storeFields: boolean }> {
  const [{ withCachedSchemas }, { loadShopifyProductSpec }, { shopifyProductSpec }] = await Promise.all([import('./cached-schema-context.js'), import('./channel-specs/shopify.js'), import('./channel-specs/store.js')])
  try { return { spec: await withCachedSchemas(() => loadShopifyProductSpec(accountId)), storeFields: true } }
  catch { return { spec: shopifyProductSpec(null, accountId), storeFields: false } }
}

/**
 * Read Shopify's product CSV against what Nexus holds (preview input; nothing is written here). `productId` = the
 * product sheet: its product group only, in its own store. `accountId` = the store chosen on the Catalog page.
 */
export async function resolveShopifyCsv(table: ShopifyCsvTable, options: { accountId?: string; productId?: string; links?: Record<string, string> } = {}): Promise<ShopifyCsvResult & { accountId: string; storeLabel: string }> {
  const { default: prisma } = await import('../../db.js')
  const store = await chooseStore(prisma, options.accountId, options.productId)
  const skuHeader = table.headers.find(h => shopifyChannelKeyOf(h) === 'Variant SKU')
  const fileSkus = [...new Set([...table.records.map(r => (skuHeader ? r.values[skuHeader] : '')?.trim()), ...Object.values(options.links ?? {})].filter((s): s is string => !!s))]
  const [targets, products, fields, root] = await Promise.all([
    shopifyStoreTargets(prisma, store.id),
    fileSkus.length ? prisma.product.findMany({ where: { sku: { in: fileSkus }, deletedAt: null }, select: { sku: true, parent: { select: { sku: true } } } }) : Promise.resolve([]),
    shopifyStoreSpec(store.id),
    options.productId ? prisma.product.findFirst({ where: { id: options.productId, deletedAt: null }, select: { sku: true, parent: { select: { sku: true } } } }) : Promise.resolve(null),
  ])
  if (options.productId && !root) throw new Error('This product is unavailable')
  const { shopifyImportMapping } = await import('../channel-mapping/shopify-import.js')
  let chmap: Awaited<ReturnType<typeof shopifyImportMapping>> | null = null, mappingProblem = ''
  try { chmap = await shopifyImportMapping(table, store.id) } catch (error) { mappingProblem = error instanceof Error ? error.message : String(error) }
  const result = mapShopifyCsv(table, targets, {
    accountId: store.id, spec: fields.spec, storeFields: fields.storeFields, links: options.links,
    products: new Map(products.map(p => [p.sku, { sku: p.sku, parentSku: p.parent?.sku ?? null }])),
    ...(chmap ? { mapping: chmap.mapping } : {}), ...(root ? { onlyRootSku: root.parent?.sku ?? root.sku } : {}),
  })
  if (chmap) {
    result.mapping = chmap.info
    const { recordUse } = await import('../channel-mapping/store.js')
    await recordUse(chmap.info.setId, 'IMPORT', 'Shopify product CSV', { rows: result.rows.length, excluded: result.exclusions.length, refused: result.issues.length })
  }
  result.warnings.unshift(
    `Shopify product CSV (${store.label}): populated values are reviewed against current Nexus values. Blank cells keep Nexus’s values. Prices and compare-at prices are recorded without sending them to Shopify; stock, status, publication and pictures are reference only.`,
    ...(chmap ? [`Read with the mapping ${chmap.info.label}.`, ...chmap.warnings] : []),
    ...(mappingProblem ? [`The mapping versions could not be read (${mappingProblem}); this file was read with the built-in rules only, and no Owner decision was applied.`] : []),
  )
  return { ...result, accountId: store.id, storeLabel: store.label }
}

// ── The File mappings page: a Shopify file read for its preview only ─────────────────────────────────────────────

export interface ShopifyFilePreview {
  setId: string; version: number; status: string; label: string; created: boolean
  store: { id: string; label: string }
  /** Filled cells of the file, and what an import would do with each (the reader's ledger). */
  counts: { rows: number; products: number; cells: number; written: number; excluded: number; refused: number; linkProposals: number }
  /** The most common reasons, with how many cells each covers. */
  refused: { reason: string; cells: number }[]
  excluded: { reason: string; cells: number }[]
  warnings: string[]
}

/** Pure: the preview the File mappings page shows for a read file (no write happened; the version was found or made). */
export function shopifyFilePreview(table: ShopifyCsvTable, result: ShopifyCsvResult, store: { id: string; label: string }, top = 8): Omit<ShopifyFilePreview, 'setId' | 'version' | 'status' | 'label' | 'created'> {
  const group = (outcomes: ShopifyLedgerEntry['outcome'][]) => [...result.ledger.filter(e => outcomes.includes(e.outcome)).reduce((acc, e) => acc.set(e.reason ?? '', (acc.get(e.reason ?? '') ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1]).slice(0, top).map(([reason, cells]) => ({ reason, cells }))
  const count = (outcomes: ShopifyLedgerEntry['outcome'][]) => result.ledger.filter(e => outcomes.includes(e.outcome)).length
  return {
    store,
    counts: { rows: table.records.length, products: shopifyCsvShape(table).products, cells: result.ledger.length, written: count(['row']), excluded: count(['excluded', 'skipped-row']), refused: count(['refused']), linkProposals: result.links.length },
    refused: group(['refused']), excluded: group(['excluded', 'skipped-row']), warnings: result.warnings,
  }
}

/** The active Shopify stores, for the File mappings page's store choice. */
export async function shopifyStores(): Promise<{ id: string; label: string }[]> {
  const { default: prisma } = await import('../../db.js')
  const stores = await prisma.channelConnection.findMany({ where: { channelType: 'SHOPIFY', isActive: true }, select: { id: true, displayName: true, accountLabel: true }, orderBy: { id: 'asc' } })
  return stores.map(s => ({ id: s.id, label: s.displayName ?? s.accountLabel ?? 'Shopify store' }))
}
