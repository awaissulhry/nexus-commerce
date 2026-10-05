/**
 * W3-6 (product sheet consistency, wave 3, 2026-10-05) — one name for one thing on the product sheet.
 *
 * The naming table for sheet columns, by column KEY, per scope: the Shared scope (`shared`) and each channel scope
 * (`AMAZON`, `EBAY`, `SHOPIFY`, `ETSY`). Owner decisions: the product's name is "Title" everywhere (Shared and Shopify
 * said "Name"); a price is "Base price" on Shared and "Price" on a channel; Shopify says "Vendor" for the brand; stock is
 * "Stock" on Shared and "Qty" on a channel (Shopify also "Available" / "On hand"); inside the Amazon scope its own
 * fields carry no "Amazon " prefix; sentence case, acronyms in upper case.
 *
 * 🔴 DISPLAY ONLY. Nothing may match on these names: saved views, formulas, filters, imports and exports key on column
 * ids, and a channel's own names (eBay's aspect names, Amazon's attribute names) are what is sent and what a pasted or
 * imported header is matched against. A place that matches a typed name (header paste, an agent tool that takes "ids
 * or labels") also accepts the names a column had before (`formerNamesOf`), so an old file or an old habit still lands.
 */

/** The scope a sheet column is named for: the Shared product, or one channel. */
export type SheetNameScope = 'shared' | 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'

export interface SheetNameEntry {
  /** The name on every scope this entry does not name otherwise. */
  all?: string
  /** The Shared product's name. */
  shared?: string
  /** Every channel scope this entry does not name otherwise. */
  channel?: string
  AMAZON?: string
  EBAY?: string
  SHOPIFY?: string
  ETSY?: string
  /** Names the column was shown under before (any scope). Accepted where a typed name is matched; never shown. */
  formerNames?: readonly string[]
}

/** Column key → names. A key not listed keeps the name its source gives it. */
export const SHEET_NAMES: Readonly<Record<string, SheetNameEntry>> = {
  name: { all: 'Title', formerNames: ['Name'] },
  brand: { all: 'Brand', SHOPIFY: 'Vendor', formerNames: ['Brand'] },
  basePrice: { shared: 'Base price', channel: 'Price', formerNames: ['Base Price', 'Base price'] },
  price: { all: 'Price', formerNames: ['Listing price'] },
  totalStock: { all: 'Stock' },
  quantity: { all: 'Qty', formerNames: ['Available quantity', 'Quantity'] },
  fulfillment_availability__quantity: { AMAZON: 'Qty', formerNames: ['Fulfillment availability · Quantity'] },
  availableQuantity: { all: 'Available', formerNames: ['Available quantity'] },
  onHandQuantity: { all: 'On hand', formerNames: ['On hand quantity'] },
  // eBay's "Quantità" / "Unità di misura" item specifics are the UNIT PRICE's parts (a pack of 2 · per piece), not stock.
  quantita: { EBAY: 'Unit quantity', formerNames: ['Quantity'] },
  unita_di_misura: { EBAY: 'Unit type', formerNames: ['Unit of measure'] },
  parentage_level: { shared: 'Saved Amazon parentage level', AMAZON: 'Listing role', formerNames: ['Amazon listing role', 'Parentage level'] },
  child_parent_sku_relationship__parent_sku: { shared: 'Amazon parent SKU', AMAZON: 'Parent SKU', formerNames: ['Amazon parent SKU'] },
  child_parent_sku_relationship__child_relationship_type: { shared: 'Amazon relationship type', AMAZON: 'Relationship type', formerNames: ['Amazon relationship type'] },
  productType: { shared: 'Amazon product type (default)', channel: 'Product type', formerNames: ['Product Type'] },
  // Amazon DE only: the RRP ("unverbindliche Preisempfehlung") and the eco fee under the EU battery regulation.
  uvp_list_price: { all: 'List price (UVP)', formerNames: ['Uvp list price'] },
  epr_eco_fee_eubr: { all: 'EPR eco fee (EUBR)', formerNames: ['Epr eco fee eubr'] },
  minPrice: { all: 'Min price', formerNames: ['Min Price'] },
  maxPrice: { all: 'Max price', formerNames: ['Max Price'] },
  minMargin: { all: 'Min margin %', formerNames: ['Min Margin %'] },
  lowStockThreshold: { all: 'Low stock alert', formerNames: ['Low Stock Alert'] },
  shippingTemplate: { all: 'Shipping template', formerNames: ['Shipping Template'] },
  videoId: { all: 'Video ID', formerNames: ['Video id'] },
}

const own = (key: string): SheetNameEntry | undefined =>
  Object.prototype.hasOwnProperty.call(SHEET_NAMES, key) ? SHEET_NAMES[key] : undefined

/**
 * The name a column with this key carries on this scope, or undefined when the table does not name it there (the
 * caller keeps its own). Without a scope: the column's general name (any scope's, Shared first).
 */
export function sheetName(key: string, scope?: SheetNameScope): string | undefined {
  const entry = own(key)
  if (!entry) return undefined
  if (!scope) return entry.all ?? entry.shared ?? entry.channel ?? entry.AMAZON ?? entry.EBAY ?? entry.SHOPIFY ?? entry.ETSY
  if (scope === 'shared') return entry.shared ?? entry.all
  return entry[scope] ?? entry.channel ?? entry.all
}

/** The names a column with this key was shown under before, for the places that match a typed name. */
export function formerNamesOf(key: string): readonly string[] {
  return own(key)?.formerNames ?? []
}

/** Words written in capitals wherever they appear in a name built from a key. */
const ACRONYMS: Readonly<Record<string, string>> = {
  id: 'ID', ids: 'IDs', sku: 'SKU', skus: 'SKUs', url: 'URL', urls: 'URLs', ean: 'EAN', upc: 'UPC', gtin: 'GTIN',
  asin: 'ASIN', mpn: 'MPN', isbn: 'ISBN', hs: 'HS', vat: 'VAT', seo: 'SEO', gpsr: 'GPSR', ce: 'CE', epr: 'EPR',
  eubr: 'EUBR', uvp: 'UVP', ghs: 'GHS', eu: 'EU', uk: 'UK', rrp: 'RRP', html: 'HTML', b2b: 'B2B',
}
/** Brand names keep their own spelling. */
const PROPER: Readonly<Record<string, string>> = { ebay: 'eBay', amazon: 'Amazon', shopify: 'Shopify', etsy: 'Etsy' }

/** `ebayItemId` → "eBay item ID", `fabric_type` → "Fabric type": sentence case, acronyms in capitals. */
function keyWords(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[_\-\s]+/).filter(Boolean).map((w) => w.toLowerCase())
  if (words.length === 0) return key
  return words.map((w, i) => ACRONYMS[w] ?? PROPER[w] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
}

/**
 * A readable English name for a column key, for the places that have only a key (a readiness issue about a field with
 * no column here, a schema field with no English title): the table's name, else the key in words. A compound Amazon key
 * (`parent__leaf`) reads "Parent · Leaf".
 */
export function fieldNameFromKey(key: string, scope?: SheetNameScope): string {
  const raw = String(key ?? '').replace(/^attr_/, '')
  const named = sheetName(raw, scope)
  if (named) return named
  const [root, ...leaves] = raw.split('__')
  if (leaves.length > 0 && root) return [fieldNameFromKey(root, scope), ...leaves.map(keyWords)].join(' · ')
  return keyWords(raw)
}

/**
 * W3-2 (Owner decision 12) — a channel's own English title in sentence case, so Amazon's "Outer Material Type" reads
 * "Outer material type" like every other name on the sheet. The first word starts with a capital; an acronym or brand
 * from this module's tables keeps its spelling, and so does a word written in capitals ("UNSPSC") or with a capital
 * inside it ("iPhone"); every other word is lower case. Display only, like the rest of this module.
 */
export function sentenceCase(title: string): string {
  let index = 0
  return String(title ?? '').trim().replace(/\p{L}[\p{L}\p{N}'’]*/gu, (word) => {
    const first = index++ === 0
    const lower = word.toLowerCase()
    if (ACRONYMS[lower]) return ACRONYMS[lower]
    if (PROPER[lower]) return PROPER[lower]
    if (word.length > 1 && word === word.toUpperCase()) return word
    if (/\p{Lu}/u.test(word.slice(1))) return word
    return first ? lower[0].toUpperCase() + lower.slice(1) : lower
  })
}
