import type { MappingFieldRow } from '@nexus/shared/channel-mapping'
import type { ChannelSpec } from '../pim/channel-specs/types.js'
import { ebayChannelKeyOf } from './ebay-draft.js'

/**
 * CHMAP M3 (E-1) — Nexus values → our eBay listing workbook, through its mapping version. Pure; the inverse of the
 * eBay reader. Identity columns come from the listing (SKU, parent, Item ID); every other column asks its mapping
 * row. Stock, listing controls and sync references are never written into a file.
 */
export interface EbayExportRecord {
  sku: string
  isParent: boolean
  /** The file's parent SKU for this listing (an adopted listing keeps its own parent SKU, e.g. `GALE-JACKET-ALT1`). */
  parentSku: string
  itemId: string | null
  /**
   * fieldKey → the value as the reader stores it (`title`, `packageWeight` = { value, unit }, `itemSpecifics.<name>`).
   * `imageUrls` = the photos Publish sends, the sheet's Product media list (`catalogRows`, Owner 2026-10-05), never only the
   * listing's old Image URLs store, which a save in Product media removes.
   */
  values: Map<string, unknown>
  price: number | null
}

export interface EbayExportResult {
  rows: Record<string, string>[]
  blankByDesign: Map<string, string>
  gaps: { sku: string; header: string; reason: string; required: boolean }[]
  /** Cells left blank on purpose for ONE row: `${parentSku}\u0000${sku}\u0000${header}` → why. */
  blankForRow: Map<string, string>
}

const text = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return value ? 'True' : 'False'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) { const parts = value.map(text).filter((v): v is string => v !== null); return parts.length ? parts.join(', ') : null }
  return null
}

const fold = (v: string) => v.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()

export function buildEbayWorkbookRows(headers: readonly string[], fields: readonly MappingFieldRow[], specs: ReadonlyMap<string, ChannelSpec>, records: readonly EbayExportRecord[]): EbayExportResult {
  const byKey = new Map<string, MappingFieldRow>()
  for (const f of fields) { byKey.set(f.channelKey, f); for (const a of f.aliases) if (!byKey.has(a)) byKey.set(a, f) }
  const blankByDesign = new Map<string, string>()
  const gaps: EbayExportResult['gaps'] = []
  const blankForRow = new Map<string, string>()
  const rows = records.map(record => {
    const out: Record<string, string> = {}
    for (const header of headers) {
      const decision = byKey.get(ebayChannelKeyOf(header, specs).channelKey)
      const blank = (reason: string) => { if (!blankByDesign.has(header)) blankByDesign.set(header, reason) }
      if (!decision) { blank('Not in the mapping version.'); continue }
      let value: string | null = null
      switch (decision.targetKind) {
        case 'identity': value = record.sku; break
        case 'relationship': value = header === 'Parent/Child' ? (record.isParent ? 'parent' : 'child') : record.isParent ? null : record.parentSku; if (value === null) continue; break
        case 'identifier': if (header === 'Item ID') { value = record.itemId; break } blank(decision.reason ?? 'Listing identity kept in Nexus, not written into a file.'); continue
        case 'quantity': blank('Stock is never written into a file.'); continue
        case 'recordAction': blank('Listing lifecycle is not written; the file keeps the listing.'); continue
        case 'price':
          if (record.isParent && records.some(r => !r.isParent && r.parentSku === record.sku)) { blankForRow.set(`${record.parentSku}\u0000${record.sku}\u0000${header}`, 'A multi-variation parent has no price of its own'); continue }
          value = text(record.price); break
        case 'image': {
          const slot = (decision.transform.find(t => t.op === 'list') as { slot?: number } | undefined)?.slot ?? 1
          const images = record.values.get('imageUrls')
          value = Array.isArray(images) ? text(images[slot - 1]) : null
          if (value === null) continue
          break
        }
        case 'channelField': case 'itemSpecific': {
          if (decision.state !== 'mapped' || decision.direction === 'in') { blank(decision.reason ?? `Column is ${decision.state}.`); continue }
          // A seller's own specific is stored under the spelling the listing already had (`Athlete` for the column `athlete`).
          const key = decision.targetKey ?? ''
          const stored = record.values.has(key) || decision.targetKind !== 'itemSpecific' ? record.values.get(key)
            : [...record.values].find(([k]) => k.startsWith('itemSpecifics.') && fold(k.slice(14)) === fold(key.slice(14)))?.[1]
          const measure = decision.transform.find(t => t.op === 'measure') as { part: 'value' | 'unit' } | undefined
          if (measure) {
            const m = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored as { value?: unknown; unit?: unknown } : null
            value = measure.part === 'unit' ? text(m?.unit) : text(m?.value ?? (typeof stored === 'number' ? stored : null))
          } else value = text(stored)
          break
        }
        default: blank(decision.reason ?? `Column is ${decision.state}.`); continue
      }
      if (decision.state !== 'mapped' && !['identity', 'relationship', 'identifier'].includes(decision.targetKind)) { blank(decision.reason ?? `Column is ${decision.state}.`); continue }
      if (value === null || value === '') { gaps.push({ sku: record.sku, header, reason: 'Nexus holds no value for this mapped column', required: decision.requirement === 'required' }); continue }
      out[header] = value
    }
    return out
  })
  return { rows, blankByDesign, gaps, blankForRow }
}

/** Cell-by-cell comparison of our eBay workbook and its export, row by (Item ID, SKU). */
export function compareEbayRows(headers: readonly string[], original: Record<string, string>[], exported: Record<string, string>[], blankByDesign: Map<string, string>, blankForRow: Map<string, string> = new Map()) {
  // A row is one listing's row: its parent SKU (the listing), its SKU and its role. Item IDs are not required
  // (the legacy workbook carries them on the parent only).
  const key = (r: Record<string, string>) => {
    const role = (r['Parent/Child'] ?? '').trim().toLowerCase(), sku = (r.SKU ?? '').trim()
    return `${role === 'parent' ? sku : (r['Parent SKU'] ?? '').trim()}\u0000${sku}\u0000${role}`
  }
  const byKey = new Map(exported.map(r => [key(r), r]))
  // In our workbook a blank variation cell means "the parent row's value" (VAT, location, Item ID, shared specifics).
  const parentOf = new Map(original.filter(r => (r['Parent/Child'] ?? '').trim().toLowerCase() === 'parent').map(r => [(r.SKU ?? '').trim(), r]))
  const out = { inherited: 0, compared: 0, equal: 0, differ: [] as { sku: string; header: string; original: string; exported: string }[], missing: [] as { sku: string; header: string; original: string }[], extra: [] as { sku: string; header: string; exported: string }[], blankByDesign: new Map<string, number>() }
  const same = (a: string, b: string) => a === b || fold(a) === fold(b) || (Number.isFinite(Number(a)) && Number.isFinite(Number(b)) && a.trim() !== '' && Number(a) === Number(b))
    || fold(a).split(/\s*,\s*/).join(',') === fold(b).split(/\s*,\s*/).join(',')
  for (const row of original) {
    const mine = byKey.get(key(row)) ?? {}
    for (const header of headers) {
      const a = (row[header] ?? '').trim(), b = (mine[header] ?? '').trim()
      if (!a && !b) continue
      const listing = key(row).split('\u0000')
      if (a && !b && (blankByDesign.has(header) || blankForRow.has(`${listing[0]}\u0000${listing[1]}\u0000${header}`))) { out.blankByDesign.set(header, (out.blankByDesign.get(header) ?? 0) + 1); continue }
      const parent = (row['Parent/Child'] ?? '').trim().toLowerCase() === 'child' ? parentOf.get((row['Parent SKU'] ?? '').trim()) : undefined
      if (!a && b && parent && (parent[header] ?? '').trim() && same((parent[header] ?? '').trim(), b)) { out.inherited++; continue }
      out.compared++
      if (a && b && same(a, b)) { out.equal++; continue }
      const sku = row.SKU ?? ''
      if (a && !b) out.missing.push({ sku, header, original: a })
      else if (!a && b) out.extra.push({ sku, header, exported: b })
      else out.differ.push({ sku, header, original: a, exported: b })
    }
  }
  return out
}
