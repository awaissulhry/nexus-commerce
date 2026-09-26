import { amazonChannelKey, type MappingFieldRow, type MappingTransform } from '@nexus/shared/channel-mapping'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'

/**
 * CHMAP M3 (E-1) — Nexus values → the rows of Amazon's OWN template, through a mapping version. Pure.
 *
 * The inverse of the reader: every template column asks its mapping row what it carries, the value is read from
 * what Nexus holds for that listing, and the template's own dictionary turns Amazon codes back into the labels its
 * dropdowns show (`new_new` → `Nuovo`). A column the version does not carry OUT is left blank, and says why
 * (`blankByDesign`); a mapped column Nexus holds nothing for is a `gap`. Stock is never written into a file.
 */

export interface AmazonExportRecord {
  /** Nexus product SKU (for reports). */
  sku: string
  /** The seller SKU of this listing on this market (the template's SKU column). */
  sellerSku: string
  /** Children: the parent's seller SKU on this market. */
  parentSellerSku: string | null
  isParent: boolean
  /** Amazon product type code (`COAT`). */
  productType: string
  asin: string | null
  /** `${fieldKey}\u0000${locale}` → the value as the reader stores it (lists as arrays, measures as `{ value, unit }`). */
  values: Map<string, unknown>
  price: number | null
  sale: { value: number; start: string; end: string } | null
}

export interface AmazonExportOptions {
  /** `partial_update` (default: a blank cell keeps Amazon's value), `full_update`, or `blank` (the template's own default). */
  recordAction: 'partial_update' | 'full_update' | 'blank'
  /** The market's primary content language (`it`): its text is stored without a locale. */
  primaryLanguage: string
  currency: string | null
  includePrices: boolean
}

export interface AmazonExportResult {
  rows: Record<string, string>[]
  /** Column → why the version leaves it blank. */
  blankByDesign: Map<string, string>
  /** Mapped columns Nexus holds no value for, per listing. */
  gaps: { sellerSku: string; header: string; reason: string }[]
  /** Cells left blank on purpose for ONE row: `${sellerSku}\u0000${header}` → why (the column is not an attribute of its product type). */
  blankForRow: Map<string, string>
}

const valueKey = (field: string, locale: string) => `${field}\u0000${locale}`
const languageOf = (header: string) => /\[language_tag=([a-z]{2})_[A-Z]{2}\]/.exec(header)?.[1] ?? null
const slotsOf = (header: string) => [...header.matchAll(/#(\d+)/g)].map(m => Number(m[1]))
const compareSlots = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 1) - (b[i] ?? 1); if (d) return d } return 0 }

/**
 * The template's own label for an Amazon code, as the mapping says the Owner's files write it: the code itself
 * (`write: 'code'`), the preferred label for a code named twice, else the first label that names it, else the code.
 */
export function labelFor(template: AmazonTemplateParse, header: string, code: string, transform: readonly MappingTransform[] = []): string {
  const dictionary = transform.find(t => t.op === 'dictionary') as Extract<MappingTransform, { op: 'dictionary' }> | undefined
  if (dictionary?.write === 'code') return code
  if (dictionary?.prefer?.[code]) return dictionary.prefer[code]
  const aliases = template.valueAliases?.[header]
  if (aliases) for (const [label, value] of Object.entries(aliases)) if (value === code) return label
  return code
}
/** The Amazon code behind a label in this template (the reader's first step), else the text itself. */
export function codeFor(template: AmazonTemplateParse, header: string, text: string): string {
  const aliases = template.valueAliases?.[header]
  return aliases && Object.prototype.hasOwnProperty.call(aliases, text) ? aliases[text] : text
}

const scalarText = (value: unknown): string | null => {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'string') return value
  return null
}

export function buildAmazonTemplateRows(template: AmazonTemplateParse, fields: readonly MappingFieldRow[], records: readonly AmazonExportRecord[], options: AmazonExportOptions): AmazonExportResult {
  const byKey = new Map(fields.map(f => [f.channelKey, f]))
  const blankByDesign = new Map<string, string>()
  const gaps: AmazonExportResult['gaps'] = []
  const blankForRow = new Map<string, string>()
  // A list field spread over several columns (`bullet_point#1…#5`): each column's position in the list, as the reader built it.
  const listPosition = new Map<string, number>()
  const listColumns = new Map<string, string[]>()
  for (const header of template.headers) {
    const f = byKey.get(amazonChannelKey(header))
    if (f?.state === 'mapped' && f.targetKind === 'channelField' && f.targetKey && f.transform.some(t => t.op === 'list')) {
      const key = `${f.targetKey}\u0000${languageOf(header) ?? ''}`
      listColumns.set(key, [...(listColumns.get(key) ?? []), header])
    }
  }
  for (const headers of listColumns.values()) headers.sort((a, b) => compareSlots(slotsOf(a), slotsOf(b))).forEach((h, i) => listPosition.set(h, i))

  const valueFor = (record: AmazonExportRecord, header: string, field: string): unknown => {
    const lang = languageOf(header)
    const tries = lang && lang !== options.primaryLanguage ? [lang] : ['', options.primaryLanguage]
    for (const locale of tries) { const v = record.values.get(valueKey(field, locale)); if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) return v }
    return undefined
  }

  const rows = records.map(record => {
    const out: Record<string, string> = {}
    for (const header of template.headers) {
      const decision = byKey.get(amazonChannelKey(header))
      const blank = (reason: string) => { if (!blankByDesign.has(header)) blankByDesign.set(header, reason) }
      if (!decision) { blank('Not in the mapping version.'); continue }
      if (decision.direction === 'in') { blank('Read on import only (direction "in").'); continue }
      const path = header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.')
      // Parentage is Nexus's own fact (the Products sheet), so it is written even though the import leaves it managed.
      if (decision.targetKind === 'relationship') {
        if (path[0] === 'parentage_level') out[header] = labelFor(template, header, record.isParent ? 'parent' : 'child', decision.transform)
        else if (path.at(-1) === 'parent_sku') { if (!record.isParent && record.parentSellerSku) out[header] = record.parentSellerSku }
        else blank(decision.reason ?? 'Relationship detail not held in Nexus.')
        continue
      }
      if (decision.state !== 'mapped') { blank(decision.reason ?? `Column is ${decision.state}.`); continue }
      // A column decided for some product types only (`bottoms_size` → PANTS) stays blank on the others' rows.
      if (decision.productTypes.length && !decision.productTypes.includes(record.productType)) { blankForRow.set(`${record.sellerSku}\u0000${header}`, `Not an attribute of Amazon ${record.productType}`); continue }
      let text: string | null = null
      switch (decision.targetKind) {
        case 'identity': text = record.sellerSku; break
        case 'productType': text = labelFor(template, header, record.productType, decision.transform); break
        case 'recordAction': text = options.recordAction === 'blank' ? null : labelFor(template, header, options.recordAction, decision.transform); if (text === null) blank('The template’s own default action applies.'); break
        case 'identifier': {
          // What the listing DECLARED wins (the file's own ASIN or EAN, or its GTIN exemption); the live ASIN only fills in.
          const declaredAsin = scalarText(record.values.get(valueKey('merchant_suggested_asin', '')))
          const declaredCode = scalarText(record.values.get(valueKey('externally_assigned_product_identifier', '')))
          const exempt = record.values.get(valueKey('supplier_declared_has_product_identifier_exemption', '')) === true
          const [type, value] = declaredAsin ? ['asin', declaredAsin] : declaredCode ? ['ean', declaredCode] : exempt ? ['exempt', null] : record.asin ? ['asin', record.asin] : [null, null]
          text = decision.targetKey === 'product_id_type' ? (type ? labelFor(template, header, type, decision.transform) : null) : value
          if (text === null && decision.targetKey === 'product_id_value' && type === 'exempt') continue
          break
        }
        case 'price': if (!options.includePrices) { blank('Prices were not requested for this file.'); continue }
          if (record.isParent) { blankForRow.set(`${record.sellerSku}\u0000${header}`, 'A variation parent has no price of its own'); continue }
          text = record.price === null ? null : String(record.price); break
        case 'sale': if (!options.includePrices) { blank('Prices were not requested for this file.'); continue }
          if (record.isParent) { blankForRow.set(`${record.sellerSku}\u0000${header}`, 'A variation parent has no price of its own'); continue }
          text = !record.sale ? null : decision.targetKey === 'start' ? record.sale.start : decision.targetKey === 'end' ? record.sale.end : String(record.sale.value); break
        case 'currency': if (!options.includePrices) { blank('Prices were not requested for this file.'); continue } text = options.currency; break
        case 'selector': {
          // Written only on a row that carries the attribute (a size system beside a size), never on its own.
          const root = path[0]
          if (![...record.values.keys()].some(k => { const f = k.split('\u0000')[0]; return f === root || f.startsWith(`${root}__`) })) continue
          // The template names the one selector value this market takes (`IT` → `as6`); several choices cannot be decided here.
          const labels = Object.keys(template.valueAliases?.[header] ?? {})
          if (labels.length === 1) text = labels[0]
          else { blank('The channel writer supplies this selector; the template offers more than one choice.'); continue }
          break
        }
        case 'channelField': {
          const value = valueFor(record, header, decision.targetKey!)
          const measure = decision.transform.find(t => t.op === 'measure') as { op: 'measure'; part: 'value' | 'unit' } | undefined
          if (measure) {
            const m = value && typeof value === 'object' && !Array.isArray(value) ? value as { value?: unknown; unit?: unknown } : null
            text = measure.part === 'unit' ? (typeof m?.unit === 'string' ? labelFor(template, header, m.unit, decision.transform) : null) : scalarText(m?.value)
          } else if (Array.isArray(value)) {
            const at = listPosition.get(header) ?? 0
            const item = scalarText(value[at])
            text = item === null ? null : labelFor(template, header, item, decision.transform)
          } else {
            const plain = scalarText(value)
            text = plain === null ? null : labelFor(template, header, plain, decision.transform)
          }
          break
        }
        default: blank(decision.reason ?? `Column carries ${decision.targetKind}; not written into a file.`); continue
      }
      if (text === null || text === '') {
        if (decision.targetKind !== 'recordAction') gaps.push({ sellerSku: record.sellerSku, header, reason: 'Nexus holds no value for this mapped column' })
        continue
      }
      out[header] = text
    }
    return out
  })
  return { rows, blankByDesign, gaps, blankForRow }
}

/** Cell-by-cell comparison of an original file and an export of the same listings, in the same template. */
export interface TemplateComparison {
  compared: number; equal: number
  differ: { sellerSku: string; header: string; original: string; exported: string }[]
  /** The original holds a value the export left blank ON PURPOSE (the header is in `blankByDesign`). */
  blankByDesign: { header: string; reason: string; cells: number }[]
  /** The original holds a value the export could not produce. */
  missing: { sellerSku: string; header: string; original: string }[]
  /** The export holds a value the original left blank (Nexus holds more than the file). */
  extra: { sellerSku: string; header: string; exported: string }[]
}

export function compareTemplateRows(template: AmazonTemplateParse, original: Record<string, string>[], exported: Record<string, string>[], skuHeader: string, blankByDesign: Map<string, string>, blankForRow: Map<string, string> = new Map()): TemplateComparison {
  const out: TemplateComparison = { compared: 0, equal: 0, differ: [], blankByDesign: [], missing: [], extra: [] }
  const byDesign = new Map<string, number>()
  const exportedBySku = new Map(exported.map(r => [r[skuHeader], r]))
  // Strict: the exported file must carry Amazon's own label, as the original does. Only a number may be spelled
  // differently (`99` = `99.0`, `1,6` = `1.6`).
  const same = (_header: string, a: string, b: string) => {
    if (a === b) return true
    const na = Number(a.replace(/^(\d+),(\d+)$/, '$1.$2')), nb = Number(b)
    return a.trim() !== '' && b.trim() !== '' && Number.isFinite(na) && Number.isFinite(nb) && na === nb
  }
  for (const row of original) {
    const sku = (row[skuHeader] ?? '').trim()
    if (!sku) continue
    const mine = exportedBySku.get(sku) ?? {}
    for (const header of template.headers) {
      const a = (row[header] ?? '').trim(), b = (mine[header] ?? '').trim()
      if (!a && !b) continue
      if (a && !b && (blankByDesign.has(header) || blankForRow.has(`${sku}\u0000${header}`))) { byDesign.set(header, (byDesign.get(header) ?? 0) + 1); continue }
      out.compared++
      if (a && b && same(header, a, b)) { out.equal++; continue }
      if (a && !b) out.missing.push({ sellerSku: sku, header, original: a })
      else if (!a && b) out.extra.push({ sellerSku: sku, header, exported: b })
      else out.differ.push({ sellerSku: sku, header, original: a, exported: b })
    }
  }
  out.blankByDesign = [...byDesign].map(([header, cells]) => ({ header, reason: blankByDesign.get(header) ?? 'Not an attribute of the row\u2019s product type', cells }))
  return out
}
