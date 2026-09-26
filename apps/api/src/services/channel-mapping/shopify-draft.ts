import { shopifyMetafieldColumn, type MappingFieldRow, type MappingTransform } from '@nexus/shared/channel-mapping'
import { SHOPIFY_CSV_COLUMNS as TABLE, type ShopifyCsvColumn } from './defaults.js'

/**
 * NCF (`docs/studies/native-channel-files.md` §2, §3) — Shopify's product CSV as mapping rows (a DRAFT), decided by the
 * shipped column table. A column is keyed by its CLASSIC name (`Body (HTML)`), so the current help page's `Description`
 * is the same column; a product metafield by its address (`metafield:product.custom.features`), whatever its label.
 * Pure: the store's metafield TYPES are not needed to key or decide a column — the reader types a value against the
 * store's saved field list when it reads the file.
 */

type Row = Omit<MappingFieldRow, 'id'>

const byHeader = new Map<string, ShopifyCsvColumn>()
for (const c of TABLE.columns) { byHeader.set(c.header, c); for (const a of c.aliases) if (!byHeader.has(a)) byHeader.set(a, c) }
const IGNORED = TABLE.ignoredPatterns.map(p => ({ ...p, re: new RegExp(p.pattern) }))

/** What one header of the file is: a table column, a metafield, an ignored pattern, or unknown. */
export type ShopifyColumnInfo =
  | { kind: 'column'; channelKey: string; column: ShopifyCsvColumn }
  | { kind: 'metafield'; channelKey: string; owner: 'product' | 'variant'; namespace: string; key: string; label: string }
  | { kind: 'pattern'; channelKey: string; level: ShopifyCsvColumn['level']; reason: string }
  | { kind: 'unknown'; channelKey: string }

export function shopifyColumnOf(header: string): ShopifyColumnInfo {
  const column = byHeader.get(header)
  if (column) return { kind: 'column', channelKey: column.header, column }
  const metafield = shopifyMetafieldColumn(header)
  if (metafield) return { kind: 'metafield', channelKey: `metafield:${metafield.owner}.${metafield.namespace}.${metafield.key}`, ...metafield }
  const pattern = IGNORED.find(p => p.re.test(header))
  if (pattern) return { kind: 'pattern', channelKey: header, level: pattern.level, reason: pattern.reason }
  return { kind: 'unknown', channelKey: header }
}

/** The stable key of one column, whatever generation of Shopify's header names the file uses. */
export const shopifyChannelKeyOf = (header: string) => shopifyColumnOf(header).channelKey

/** The target key a product metafield maps to: the Shopify information field id (`metafield:PRODUCT:<ns>.<key>`). */
export const shopifyMetafieldTarget = (namespace: string, key: string) => `metafield:PRODUCT:${namespace}.${key}`

const TRANSFORMS: Record<string, MappingTransform[]> = {
  tags: [{ op: 'list', join: ', ' }],
  taxable: [{ op: 'boolean' }],
  requiresShipping: [{ op: 'boolean' }],
}

/** The rule decision for every column of the file, in column order. */
export function buildShopifyDraftFields(headers: readonly string[]): Row[] {
  const rows: Row[] = []
  const seen = new Set<string>()
  const base = { label: null as string | null, productTypes: [] as string[], requirement: null as Row['requirement'], templateRequirement: null, targetKey: null as string | null,
    transform: [{ op: 'copy' }] as MappingTransform[], direction: 'both' as const, reason: null as string | null, decidedBy: 'rule' as const }
  for (const [index, header] of headers.entries()) {
    const info = shopifyColumnOf(header)
    if (seen.has(info.channelKey)) continue
    seen.add(info.channelKey)
    const aliases = info.kind === 'column' ? [info.column.header, ...info.column.aliases].filter(a => a !== info.channelKey) : []
    const row = (decision: Partial<Row> & Pick<Row, 'targetKind' | 'state'>): Row => ({ ...base, channelKey: info.channelKey, columnKey: header, aliases, sortOrder: index, label: header, ...decision })
    if (info.kind === 'metafield') {
      if (info.owner === 'variant') { rows.push(row({ targetKind: 'none', state: 'ignored', label: info.label, reason: 'Shopify’s product CSV does not carry variant metafields; edit them in the Shopify tab.' })); continue }
      rows.push(row({ targetKind: 'channelField', targetKey: shopifyMetafieldTarget(info.namespace, info.key), state: 'mapped', label: info.label,
        transform: [{ op: 'list', join: TABLE.listSeparator }], reason: 'A product metafield of this store: typed by the store’s saved field list when a file is read.' }))
      continue
    }
    if (info.kind === 'pattern') { rows.push(row({ targetKind: 'none', state: 'ignored', reason: info.reason })); continue }
    if (info.kind === 'unknown') { rows.push(row({ targetKind: 'none', state: 'unmapped', reason: 'Not a column of Shopify’s product file that Nexus knows; map or ignore it.' })); continue }
    const c = info.column
    switch (c.role) {
      case 'handle': rows.push(row({ targetKind: 'identity', targetKey: 'handle', state: 'mapped', requirement: 'required', reason: 'The Shopify product the row belongs to: matched to the product Nexus links in this store, never changed from a file.' })); break
      case 'sku': rows.push(row({ targetKind: 'identity', targetKey: 'sku', state: 'mapped', requirement: 'required', reason: 'The variant: matched to the Nexus product with this SKU, never renamed from a file.' })); break
      case 'price': rows.push(row({ targetKind: 'price', targetKey: 'price', state: 'mapped', transform: [{ op: 'number' }], reason: 'Through the one price door, record-only on import (nothing is sent to Shopify).' })); break
      case 'compareAt': rows.push(row({ targetKind: 'compareAt', targetKey: 'compareAtPrice', state: 'mapped', transform: [{ op: 'number' }], reason: 'Shopify’s struck-through price: through the one price door, record-only on import.' })); break
      case 'option': rows.push(row({ targetKind: 'relationship', state: 'managed', reason: 'Variant structure: never imported. The export writes Shopify’s own option names and values back unchanged (a changed or missing option deletes variants in Shopify).' })); break
      case 'lifecycle': rows.push(row({ targetKind: 'lifecycle', state: 'managed', reason: c.header === 'Status'
        ? 'Listing lifecycle: never imported. The export writes the status Nexus last read (a file without Status can make a product active).'
        : 'Publication: never imported and left out of the export, so Shopify keeps it.' })); break
      case 'stock': rows.push(row({ targetKind: 'quantity', state: 'managed', reason: 'Stock is never imported from a file and never written into one: the stock ledger owns it.' })); break
      case 'media': rows.push(row({ targetKind: 'image', state: 'managed', reason: 'Pictures: Shopify keeps its media; Nexus manages pictures in the media workspace. Not imported, not exported.' })); break
      case 'cost': rows.push(row({ targetKind: 'none', state: 'managed', reason: 'Product cost belongs to Nexus pricing: reference only, not exported.' })); break
      case 'ignored': rows.push(row({ targetKind: 'none', state: 'ignored', reason: c.reason ?? 'Not carried by Nexus.' })); break
      case 'field': {
        const field = c.field!
        const transform: MappingTransform[] = field === 'weight' ? (c.header === 'Variant Weight Unit' ? [{ op: 'measure', part: 'unit' }] : [{ op: 'measure', part: 'value' }, { op: 'number' }]) : TRANSFORMS[field] ?? [{ op: 'copy' }]
        rows.push(row({ targetKind: 'channelField', targetKey: field, state: 'mapped', transform, requirement: field === 'title' ? 'required' : null,
          ...(field === 'weight' ? { reason: c.header === 'Variant Weight Unit' ? 'The unit Shopify shows the weight in.' : '`Variant Grams` is always grams; Nexus keeps the weight in the unit Shopify shows.' } : {}) }))
        break
      }
    }
  }
  return rows
}
