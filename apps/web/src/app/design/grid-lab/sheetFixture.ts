/**
 * Master-sheet fixture — the Owner's own catalogue shape (xaviaracing.it: motorcycle jackets,
 * gloves, rainwear; colour × size families; CE protection levels; EN 17092 classes; EU sizes),
 * for market IT. Frozen, deterministic, no API.
 *
 * The attribute SCHEMA below stands in for the per-productType master schema the API derives from
 * the Amazon product-type definition ∪ the mapping rules' sources (MA.1). `scope: 'global'` values
 * live on the parent and are inherited by every variation unless the variation pins its own;
 * `per_variant` values belong to each child (colour, size, EAN, ASIN).
 */

export type AttrScope = 'global' | 'per_variant'
export type AttrKind = 'text' | 'longtext' | 'number' | 'select' | 'boolean'

export interface SheetAttr {
  key: string
  label: string
  group: string
  kind: AttrKind
  scope: AttrScope
  options?: readonly string[]
  /** strict = the channel accepts only the list (a typed value is flagged, never blocked). */
  mode?: 'strict' | 'open'
  /** Required by which channels for market IT. */
  requiredBy?: readonly ('amazon' | 'ebay' | 'shopify')[]
  /** The tightest length cap across the channels. */
  maxLength?: number
  width?: number
}

export const SHEET_SCHEMA: SheetAttr[] = [
  // content @ IT
  { key: 'title', label: 'Title', group: 'Content · IT', kind: 'longtext', scope: 'global', requiredBy: ['amazon', 'ebay', 'shopify'], maxLength: 80, width: 300 },
  { key: 'bullet1', label: 'Bullet 1', group: 'Content · IT', kind: 'longtext', scope: 'global', requiredBy: ['amazon'], maxLength: 500, width: 220 },
  { key: 'bullet2', label: 'Bullet 2', group: 'Content · IT', kind: 'longtext', scope: 'global', maxLength: 500, width: 220 },
  { key: 'description', label: 'Description', group: 'Content · IT', kind: 'longtext', scope: 'global', requiredBy: ['amazon', 'ebay', 'shopify'], maxLength: 2000, width: 260 },
  { key: 'keywords', label: 'Search terms', group: 'Content · IT', kind: 'longtext', scope: 'global', maxLength: 250, width: 180 },
  // attributes (master schema for "Motorcycle jacket")
  { key: 'brand', label: 'Brand', group: 'Attributes', kind: 'text', scope: 'global', requiredBy: ['amazon', 'ebay', 'shopify'], width: 100 },
  { key: 'gender', label: 'Gender', group: 'Attributes', kind: 'select', scope: 'global', options: ['Men', 'Women', 'Unisex'], mode: 'strict', requiredBy: ['amazon', 'ebay'], width: 100 },
  { key: 'color', label: 'Colour', group: 'Attributes', kind: 'select', scope: 'per_variant', options: ['Black', 'Black/Yellow', 'Black/Brown', 'Black/Grey', 'Nero Neo', 'Crema e Vino', 'Brown'], mode: 'open', requiredBy: ['amazon', 'ebay', 'shopify'], width: 120 },
  { key: 'size', label: 'Size (EU)', group: 'Attributes', kind: 'select', scope: 'per_variant', options: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL'], mode: 'strict', requiredBy: ['amazon', 'ebay', 'shopify'], width: 90 },
  { key: 'outerMaterial', label: 'Outer material', group: 'Attributes', kind: 'select', scope: 'global', options: ['Leather', 'Textile', 'Mesh', 'Cordura'], mode: 'strict', requiredBy: ['amazon', 'ebay'], width: 120 },
  { key: 'protectionLevel', label: 'Protector level', group: 'Attributes', kind: 'select', scope: 'global', options: ['CE Level 1', 'CE Level 2'], mode: 'strict', requiredBy: ['amazon'], width: 120 },
  { key: 'garmentClass', label: 'EN 17092 class', group: 'Attributes', kind: 'select', scope: 'global', options: ['AAA', 'AA', 'A', 'B', 'C'], mode: 'strict', requiredBy: ['amazon'], width: 120 },
  { key: 'waterproof', label: 'Waterproof', group: 'Attributes', kind: 'boolean', scope: 'global', width: 100 },
  { key: 'season', label: 'Season', group: 'Attributes', kind: 'select', scope: 'global', options: ['Summer', 'Winter', 'All season', '3 seasons'], mode: 'open', width: 110 },
  { key: 'countryOfOrigin', label: 'Origin', group: 'Attributes', kind: 'select', scope: 'global', options: ['IT', 'PK', 'CN', 'VN', 'TR'], mode: 'strict', requiredBy: ['amazon'], width: 90 },
  // identifiers
  { key: 'ean', label: 'EAN', group: 'Identifiers', kind: 'text', scope: 'per_variant', requiredBy: ['amazon', 'ebay'], maxLength: 13, width: 140 },
]

export interface ChannelRef {
  amazonAsin?: string | null
  ebayItemId?: string | null
  shopifyId?: string | null
}

export interface SheetRow {
  id: string
  sku: string
  parentSku: string | null
  name: string
  status: 'ACTIVE' | 'DRAFT' | 'INACTIVE'
  /** The row's OWN attribute values; a child inherits a global attribute from its parent when absent. */
  attrs: Record<string, string | number | boolean | null>
  /** Master price in euros. */
  basePrice: number
  /** Market IT: the effective price and whether it follows master. */
  priceIT: number | null
  priceFollowsMaster: boolean
  refs: ChannelRef
  imageCount: number
  childCount: number
}

const seeded = (seed: number) => {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

interface FamilySpec {
  sku: string
  name: string
  base: number
  colours: string[]
  sizes: string[]
  attrs: Record<string, string | number | boolean | null>
  status?: SheetRow['status']
}

const FAMILIES: FamilySpec[] = [
  {
    sku: 'XAV-GALE', name: 'XAVIA GALE Giacca Da Moto Impermeabile Uomo', base: 99, colours: ['Black/Yellow', 'Black'], sizes: ['S', 'M', 'L', 'XL', '2XL'],
    attrs: { title: 'XAVIA GALE Giacca Da Moto Uomo Impermeabile con Protezioni CE Livello 2', bullet1: 'Membrana impermeabile 100% e cuciture termonastrate', bullet2: 'Protezioni CE Livello 2 su spalle e gomiti, tasca paraschiena', description: 'Giacca touring in tessuto Cordura 600D con membrana impermeabile, protezioni CE livello 2 e inserti riflettenti.', keywords: 'giacca moto impermeabile touring', brand: 'XAVIA', gender: 'Men', outerMaterial: 'Cordura', protectionLevel: 'CE Level 2', garmentClass: 'AA', waterproof: true, season: 'All season', countryOfOrigin: 'PK' },
  },
  {
    sku: 'XAV-MISANO', name: 'XAVIA MISANO Giacca In Pelle Da Moto', base: 149, colours: ['Black/Brown', 'Black'], sizes: ['M', 'L', 'XL'],
    attrs: { title: 'XAVIA MISANO Giacca In Pelle Da Moto Uomo Vintage con Protezioni', bullet1: 'Pelle bovina 1.1–1.2 mm, fodera termica removibile', bullet2: null, description: 'Giacca in pelle stile café racer, protezioni CE livello 1 incluse, tasca paraschiena.', keywords: null, brand: 'XAVIA', gender: 'Men', outerMaterial: 'Leather', protectionLevel: 'CE Level 1', garmentClass: null, waterproof: false, season: '3 seasons', countryOfOrigin: 'PK' },
  },
  {
    sku: 'XAV-AIREON', name: 'XAVIA AIREON Giacca Da Moto Da Uomo', base: 149, colours: ['Nero Neo', 'Crema e Vino'], sizes: ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL'],
    attrs: { title: 'XAVIA AIREON Giacca Da Moto Da Uomo - Giubbotto Moto Con Protezione CE Di Livello 2, Impermeabile e Con Fodera Termica Rimovibile | Per Tutte Le Stagioni', bullet1: 'Guscio impermeabile, fodera termica rimovibile', bullet2: 'Protezioni CE livello 2 spalle/gomiti', description: 'Giacca 4 stagioni con fodera termica rimovibile e membrana impermeabile.', keywords: 'giacca moto 4 stagioni', brand: 'XAVIA', gender: 'Men', outerMaterial: 'Textile', protectionLevel: 'CE Level 2', garmentClass: 'AA', waterproof: true, season: 'All season', countryOfOrigin: 'PK' },
  },
  {
    sku: 'XAV-XRI01', name: 'XAVIA XRI01 Guanti In Pelle Da Moto', base: 79, colours: ['Black', 'Brown'], sizes: ['S', 'M', 'L', 'XL'],
    attrs: { title: 'XAVIA XRI01 Guanti Moto In Pelle Touchscreen', bullet1: null, bullet2: null, description: null, keywords: 'guanti moto pelle', brand: 'XAVIA', gender: 'Unisex', outerMaterial: 'Leather', protectionLevel: 'CE Level 1', garmentClass: null, waterproof: false, season: 'Mid-season', countryOfOrigin: 'Pakistan' },
    status: 'DRAFT',
  },
]

/** `Black/Yellow` → BLYE, `Crema e Vino` → CREVI, `Black` → BL — distinct per colour, never a duplicate id. */
const colourCode = (c: string) => c.split(/[^A-Za-z]+/).filter(Boolean).map((w) => w.slice(0, 2).toUpperCase()).join('')

export function makeSheet(seed = 13): SheetRow[] {
  const rnd = seeded(seed)
  const rows: SheetRow[] = []
  for (const f of FAMILIES) {
    const kids = f.colours.length * f.sizes.length
    rows.push({
      id: f.sku, sku: f.sku, parentSku: null, name: f.name, status: f.status ?? 'ACTIVE', attrs: { ...f.attrs, color: null, size: null, ean: null },
      basePrice: f.base, priceIT: null, priceFollowsMaster: true, refs: { amazonAsin: `B0${Math.floor(rnd() * 9e7 + 1e7)}`, ebayItemId: null, shopifyId: `${Math.floor(rnd() * 9e9)}` }, imageCount: 5 + Math.floor(rnd() * 4), childCount: kids,
    })
    let i = 0
    for (const colour of f.colours) {
      for (const size of f.sizes) {
        i++
        const sku = `${f.sku}-${colourCode(colour)}-${size}`
        const listedAmazon = rnd() > 0.15
        const pinned = i % 7 === 3
        rows.push({
          id: sku, sku, parentSku: f.sku, name: `${f.name} · ${colour} · ${size}`, status: f.status ?? 'ACTIVE',
          attrs: { color: colour, size, ean: i % 9 === 4 ? null : `80${String(Math.floor(rnd() * 1e10)).padStart(10, '0')}0`, ...(i % 11 === 5 ? { waterproof: false } : {}) },
          basePrice: f.base, priceIT: pinned ? f.base - 10 : null, priceFollowsMaster: !pinned,
          refs: { amazonAsin: listedAmazon ? `B0${Math.floor(rnd() * 9e7 + 1e7)}` : null, ebayItemId: rnd() > 0.5 ? `1${Math.floor(rnd() * 9e10)}` : null, shopifyId: `${Math.floor(rnd() * 9e9)}` },
          imageCount: 0, childCount: 0,
        })
      }
    }
  }
  return rows
}

export const SHEET_ROWS = makeSheet()
export const parentOf = (row: SheetRow, rows: readonly SheetRow[]) => (row.parentSku ? rows.find((r) => r.sku === row.parentSku) ?? null : null)

/** The effective value: the row's own, else the parent's (a global attribute inherits). */
export function attrValue(row: SheetRow, key: string, rows: readonly SheetRow[]): string | number | boolean | null {
  const own = row.attrs[key]
  if (own !== undefined && own !== null && own !== '') return own
  const attr = SHEET_SCHEMA.find((a) => a.key === key)
  if (attr?.scope === 'global' && row.parentSku) return parentOf(row, rows)?.attrs[key] ?? null
  return own ?? null
}

export const isInherited = (row: SheetRow, key: string): boolean => {
  const attr = SHEET_SCHEMA.find((a) => a.key === key)
  return !!row.parentSku && attr?.scope === 'global' && (row.attrs[key] === undefined || row.attrs[key] === null || row.attrs[key] === '')
}

/** Per channel × market IT: what stops this row shipping. The page computes this from the publish validator; here from the schema. */
export function readinessOf(row: SheetRow, rows: readonly SheetRow[], channel: 'amazon' | 'ebay' | 'shopify'): { state: 'ready' | 'missing' | 'errors' | 'live' | 'unlisted'; issues: string[]; ref?: string } {
  const isParent = !row.parentSku
  const issues: string[] = []
  for (const a of SHEET_SCHEMA) {
    if (!a.requiredBy?.includes(channel)) continue
    if (isParent && a.scope === 'per_variant') continue
    const v = attrValue(row, a.key, rows)
    if (v === null || v === '' || v === undefined) issues.push(`${a.label} missing`)
    else if (a.maxLength && typeof v === 'string' && v.length > a.maxLength) issues.push(`${a.label} over ${a.maxLength}`)
    else if (a.kind === 'select' && a.mode === 'strict' && a.options && !a.options.some((o) => o.toLowerCase() === String(v).toLowerCase())) issues.push(`${a.label} "${v}" not in list`)
  }
  if (channel === 'ebay' && !isParent && row.attrs.ean && String(row.attrs.ean).length !== 13) issues.push('EAN must be 13 digits')
  const ref = channel === 'amazon' ? row.refs.amazonAsin : channel === 'ebay' ? row.refs.ebayItemId : row.refs.shopifyId
  if (issues.some((i) => /over|not in list|must be/.test(i))) return { state: 'errors', issues, ref: ref ?? undefined }
  if (issues.length) return { state: 'missing', issues, ref: ref ?? undefined }
  if (ref) return { state: 'live', issues: [], ref }
  return { state: 'ready', issues: [] }
}

export function completenessOf(row: SheetRow, rows: readonly SheetRow[]): number {
  const isParent = !row.parentSku
  const applicable = SHEET_SCHEMA.filter((a) => !(isParent && a.scope === 'per_variant'))
  const filled = applicable.filter((a) => { const v = attrValue(row, a.key, rows); return v !== null && v !== '' && v !== undefined }).length
  return applicable.length ? Math.round((filled / applicable.length) * 100) : 100
}
