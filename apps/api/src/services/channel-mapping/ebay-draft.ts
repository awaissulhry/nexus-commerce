import { ebayColumnName, type MappingFieldRow, type MappingRequirement, type MappingTransform } from '@nexus/shared/channel-mapping'
import type { ChannelFieldSpec, ChannelSpec } from '../pim/channel-specs/types.js'
import { EBAY_WORKBOOK_COLUMNS as COLUMNS } from './defaults.js'

/**
 * CHMAP — our eBay workbook's columns as mapping rows (a DRAFT), decided by the shipped defaults and the eBay
 * category specs of the file. An aspect column is keyed by eBay's LOCALIZED aspect name (`aspect:Colore`), so the
 * old header `Colore (Color)` and the export's English-first `Color (Colore)` are the same column. Pure.
 */

type Row = Omit<MappingFieldRow, 'id'>
const REQUIREMENT_RANK: Record<MappingRequirement, number> = { required: 4, requiredIfRelevant: 3, bestPractice: 2, optional: 1 }
const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()
const PRICE = new RegExp(COLUMNS.pricePattern)
const IMAGE = new RegExp(COLUMNS.imagePattern)

/** The two names a marked header carries: `Colore (Color) ↕` → ['Colore', 'Color']; `Genere ⚠` → ['Genere']. */
export function headerNames(header: string): string[] {
  const bare = ebayColumnName(header)
  const m = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(bare)
  return m ? [m[1].trim(), m[2].trim()].filter(Boolean) : [bare]
}

const aspectName = (f: ChannelFieldSpec) => f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics' ? f.channelStore.path[1] : null

/** The category aspect a header names, by either of its names: exact first, then ignoring case and accents. */
export function matchAspect(header: string, spec: ChannelSpec): ChannelFieldSpec | null {
  const names = headerNames(header)
  const aspects = spec.fields.filter(f => aspectName(f))
  for (const same of [(a: string, b: string) => a === b, (a: string, b: string) => fold(a) === fold(b)]) {
    const hits = aspects.filter(f => names.some(n => same(aspectName(f)!, n) || (f.englishLabel ? same(f.englishLabel, n) : false)))
    const distinct = [...new Map(hits.map(f => [f.key, f])).values()]
    if (distinct.length === 1) return distinct[0]
    if (distinct.length > 1) return null
  }
  return null
}

/** The stable key of one workbook column, whatever the header's name order and marks. */
export function ebayChannelKeyOf(header: string, specs: ReadonlyMap<string, ChannelSpec>): { channelKey: string; aliases: string[] } {
  const bare = ebayColumnName(header)
  if (COLUMNS.fixedFields[header] || COLUMNS.coordinates.includes(header) || COLUMNS.quantityHeaders.includes(header) || COLUMNS.controlHeaders.includes(header)
    || header === 'Action' || header === COLUMNS.weightUnitHeader || PRICE.test(header) || IMAGE.test(header)) return { channelKey: header, aliases: [] }
  for (const spec of specs.values()) {
    const aspect = matchAspect(header, spec)
    if (aspect) {
      const localized = aspectName(aspect)!, english = aspect.englishLabel
      const aliases = english && fold(english) !== fold(localized) ? [`${localized} (${english})`, `${english} (${localized})`] : []
      return { channelKey: `aspect:${localized}`, aliases: aliases.filter(a => a !== bare) }
    }
  }
  if (COLUMNS.identifierHeaders.includes(header)) return { channelKey: header, aliases: [] }
  return { channelKey: `specific:${headerNames(header)[0]}`, aliases: [] }
}

/** The rule decision for every column of the workbook, in column order. `categories` = the file's eBay categories. */
export function buildEbayDraftFields(headers: readonly string[], specs: ReadonlyMap<string, ChannelSpec>, marketplace: string): Row[] {
  const categories = [...specs.keys()]
  const rows: Row[] = []
  const seen = new Set<string>()
  const base = { label: null as string | null, productTypes: [] as string[], requirement: null as MappingRequirement | null, templateRequirement: null, targetKey: null as string | null,
    transform: [{ op: 'copy' }] as MappingTransform[], direction: 'both' as const, reason: null as string | null, decidedBy: 'rule' as const }
  for (const [index, header] of headers.entries()) {
    const { channelKey, aliases } = ebayChannelKeyOf(header, specs)
    if (seen.has(channelKey)) continue
    seen.add(channelKey)
    const row = (decision: Partial<Row> & Pick<Row, 'targetKind' | 'state'>): Row => ({ ...base, channelKey, columnKey: header, aliases, sortOrder: index, label: ebayColumnName(header), ...decision })
    if (header === 'SKU') { rows.push(row({ targetKind: 'identity', state: 'mapped', requirement: 'required' })); continue }
    if (['Parent/Child', 'Parent SKU'].includes(header)) { rows.push(row({ targetKind: 'relationship', state: 'managed', requirement: 'required', reason: 'Verified listing identity: the parent row and its variations; shared parentage is managed on the Products sheet.' })); continue }
    if (COLUMNS.coordinates.includes(header)) { rows.push(row({ targetKind: 'identifier', state: 'managed', reason: 'Verified listing identity: matched to the listing Nexus holds, never overwritten from a file.' })); continue }
    if (COLUMNS.quantityHeaders.includes(header)) { rows.push(row({ targetKind: 'quantity', state: 'managed', reason: 'Quantity is not imported: EU merchant quantity is one number for every EU market, and stock has its own ledger.' })); continue }
    if (COLUMNS.controlHeaders.includes(header)) { rows.push(row({ targetKind: 'none', state: 'ignored', reason: 'Listing control or sync reference: shown for information, not imported.' })); continue }
    if (header === 'Action') { rows.push(row({ targetKind: 'recordAction', state: 'mapped', reason: 'A delete word ends the listing in Nexus when confirmed; nothing is sent to eBay.' })); continue }
    if (PRICE.test(header)) { rows.push(row({ targetKind: 'price', targetKey: 'price', state: 'mapped', transform: [{ op: 'number' }], reason: 'Through the one price door, record-only on import (nothing is sent back). A multi-variation parent has no own price.' })); continue }
    if (IMAGE.test(header)) { rows.push(row({ targetKind: 'image', targetKey: 'imageUrls', state: 'mapped', transform: [{ op: 'list', slot: Number(/\d+/.exec(header)?.[0] ?? 1) }] })); continue }
    if (header === COLUMNS.weightUnitHeader) { rows.push(row({ targetKind: 'channelField', targetKey: 'packageWeight', state: 'mapped', transform: [{ op: 'measure', part: 'unit' }] })); continue }
    const fixed = COLUMNS.fixedFields[header]
    const perCategory = categories.map(category => {
      const spec = specs.get(category)!
      const field = fixed ? spec.fields.find(f => f.key === fixed) ?? null : matchAspect(header, spec)
      return { category, field }
    })
    const hits = perCategory.filter(c => c.field)
    if (hits.length) {
      const field = hits[0].field!
      const requirement = hits.map(h => h.field!.requirement).reduce<MappingRequirement | null>((a, b) => !a || REQUIREMENT_RANK[b] > REQUIREMENT_RANK[a] ? b : a, null)
      const transform: MappingTransform[] = field.shape === 'measure' ? [{ op: 'measure', part: 'value' }, { op: 'number' }]
        : field.shape === 'list' ? [{ op: 'list', join: ', ' }] : field.kind === 'number' ? [{ op: 'number' }] : field.kind === 'boolean' ? [{ op: 'boolean' }] : [{ op: 'copy' }]
      rows.push(row({ targetKind: 'channelField', targetKey: field.key, state: 'mapped', requirement, transform, label: fixed ? header : aspectName(field) ?? ebayColumnName(header),
        productTypes: hits.length === perCategory.length ? [] : hits.map(h => h.category) }))
      continue
    }
    if (fixed) { rows.push(row({ targetKind: 'none', state: 'unmapped', reason: `The eBay ${marketplace} schema of ${categories.join(', ') || 'this category'} has no field ${fixed}; map or ignore this column.` })); continue }
    if (COLUMNS.identifierHeaders.includes(header)) { rows.push(row({ targetKind: 'identifier', state: 'managed', reason: 'Product identifier: it belongs to the product record, not to an eBay listing workbook.' })); continue }
    // By the workbook's structure every other column is an item specific; one the category does not declare is the seller's own.
    rows.push(row({ targetKind: 'itemSpecific', targetKey: `itemSpecifics.${headerNames(header)[0]}`, state: 'mapped', transform: [{ op: 'copy' }],
      reason: /⚠/u.test(header) ? 'Not in eBay’s current category schema (the export marked it ⚠): kept as the seller’s own item specific.' : 'Not in eBay’s current category requirements: kept as the seller’s own item specific.' }))
  }
  return rows
}
