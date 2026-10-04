import { amazonChannelKey, type MappingFieldRow, type MappingTransform } from '@nexus/shared/channel-mapping'
import type { AmazonTemplateParse } from '../amazon/template-workbook.js'
import { dayOf, isAmazonDate, rootOfLeaf, type AmazonOfferLeaf } from '../amazon/offer-fields.js'
import { OFFER_DRAFT_LABEL, offerDraftLeafOfColumn, ownSelectors } from '../pim/catalog-amazon-workbook.js'

/**
 * CHMAP M3 (E-1) — Nexus values → the rows of Amazon's OWN template, through a mapping version. Pure.
 *
 * The inverse of the reader: every template column asks its mapping row what it carries, the value is read from
 * what Nexus holds for that listing, and the template's own dictionary turns Amazon codes back into the labels its
 * dropdowns show (`new_new` → `Nuovo`). A column the version does not carry OUT is left blank, and says why
 * (`blankByDesign`); a mapped column Nexus holds nothing for is a `gap`. Stock is never written into a file.
 *
 * Product sheet consistency (2026-10-05) — the file holds what the sheet shows: a cell that follows Shared carries the
 * value Nexus sends (`amazonExportValues`, B2); the offer settings carry their LIVE values, and a saved change waiting
 * for Publish is named (B3); a list longer than the template's columns is reported (B4); a document goes into the
 * column of its own type (B5); a product ID keeps its own type, never a guessed one (B7).
 */

export interface AmazonExportRecord {
  /** Nexus product SKU (for reports). */
  sku: string
  /** The seller SKU of this listing on this market (the template's SKU column). */
  sellerSku: string
  /** Children: the parent's seller SKU on this market. */
  parentSellerSku: string | null
  /** A variation parent: no price of its own. False for a child and for a single product. */
  isParent: boolean
  /** The listing role written into the file. A single product (no family) writes none. Absent = parent or child by `isParent`. */
  role?: 'parent' | 'child' | 'single'
  /** Amazon product type code (`COAT`). */
  productType: string
  asin: string | null
  /** `${fieldKey}\u0000${locale}` → the value as the reader stores it (lists as arrays, measures as `{ value, unit }`). */
  values: Map<string, unknown>
  price: number | null
  sale: { value: number; start: string; end: string } | null
  /** B2 — `${fieldKey}\u0000${locale}` cleared on this listing: the cell stays blank, and the report says it was cleared. */
  cleared?: ReadonlySet<string>
  /** B3 — the listing's offer settings. Absent = not read: the offer columns stay blank with the version's reason. */
  offers?: ReadonlyMap<AmazonOfferLeaf, AmazonOfferExportCell>
}

/** B3 — one Amazon offer setting of a listing as the export writes it (read by the sheet's own loader, `amazon-offer-cells.ts`). */
export interface AmazonOfferExportCell {
  leaf: AmazonOfferLeaf
  /** The LIVE value: what Amazon keeps until Publish. The file holds it (the Owner's decision 5). */
  live: unknown
  /** Why this row leaves the column blank: a variation parent, or an FBA listing for a setting that applies only to FBM. */
  hold: string | null
  /** A saved change waiting for Publish, in words; `sent: false` = it is not sent (a restock date that has passed). */
  waiting: { saved: string; live: string; sent: boolean } | null
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
  /** Mapped columns Nexus holds no value for, per listing (`required` = the channel requires the column). */
  gaps: { sellerSku: string; header: string; reason: string; required: boolean }[]
  /** Cells left blank on purpose for ONE row: `${sellerSku}\u0000${header}` → why (the column is not an attribute of its product type). */
  blankForRow: Map<string, string>
  /**
   * B4 — a list Nexus holds with more items than the template has columns for (10 bullet points, 5 columns): the items
   * past the last column are not in the file, and uploading it leaves Amazon with `columns` items.
   */
  truncated: { sellerSku: string; sku: string; field: string; label: string; held: number; columns: number }[]
  /** What a person should know before uploading: a saved offer change waiting for Publish (B3), where a document went (B5). */
  notes: { sellerSkus: string[]; header: string; note: string }[]
}

/** One stored or effective channel value of a listing, as `catalogRows` gives it. */
export interface AmazonValueRow { field: string; locale?: string | null; action: string; value?: unknown }
export interface AmazonExportValues {
  /** `${fieldKey}\u0000${locale}` → the value the file carries. */
  values: Map<string, unknown>
  /** Cells that follow Shared and took the value Nexus sends. */
  inherited: number
  /** Cells cleared on the listing (blank in the file). */
  cleared: Set<string>
  offers: Map<AmazonOfferLeaf, AmazonOfferExportCell>
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
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)
/** A selector leaf a schema makes a list (`['ean']`) holds one value. */
const oneOf = (v: unknown) => scalarText(Array.isArray(v) ? v[0] : v)
const humanize = (key: string) => { const text = key.replace(/__/g, ' · ').replace(/_/g, ' '); return text.charAt(0).toUpperCase() + text.slice(1) }
const selectorWords = (selectors: { name: string; value: string }[]) => selectors.map(s => `${s.name.replace(/_/g, ' ')} ${s.value}`).join(', ')

/**
 * B2 (pure) — the values ONE listing's row of the file carries: a value stored on the listing wins; a cell that follows
 * Shared takes the value Nexus sends (`effective`, the sheet's own `resolveBatch` read); a cleared cell stays blank. A
 * field without a language (`''`) reads the effective value of the market's primary language. `offerCells` (B3) pass
 * through as the record's offer settings.
 */
export function amazonExportValues(stored: readonly AmazonValueRow[], effective: readonly AmazonValueRow[], offerCells: readonly AmazonOfferExportCell[] = [], primaryLanguage = ''): AmazonExportValues {
  const sent = new Map<string, unknown>()
  const firstSent = new Map<string, unknown>()
  for (const r of effective) {
    if (r.action !== 'SET' || isEmpty(r.value)) continue
    sent.set(valueKey(r.field, r.locale ?? ''), r.value)
    if (!firstSent.has(r.field)) firstSent.set(r.field, r.value)
  }
  const out: AmazonExportValues = { values: new Map(), inherited: 0, cleared: new Set(), offers: new Map(offerCells.map(c => [c.leaf, c])) }
  for (const r of stored) {
    const locale = r.locale ?? '', key = valueKey(r.field, locale)
    if (r.action === 'SET') { if (r.value !== undefined) out.values.set(key, r.value); continue }
    if (r.action === 'CLEAR') { out.cleared.add(key); continue }
    if (r.action !== 'INHERIT') continue
    const value = sent.has(key) ? sent.get(key) : locale === '' ? sent.get(valueKey(r.field, primaryLanguage)) ?? firstSent.get(r.field) : undefined
    if (isEmpty(value)) continue
    out.values.set(key, value)
    out.inherited++
  }
  return out
}

/** B3 — an offer setting in the file's own words: a date as its day, a code as the template's label (`true` → `Abilitato`). */
function offerText(template: AmazonTemplateParse, header: string, leaf: AmazonOfferLeaf, value: unknown, transform: readonly MappingTransform[]): string | null {
  if (leaf === 'restock_date' || leaf === 'offer_start_at' || leaf === 'offer_end_at') return isAmazonDate(value) ? dayOf(value) : scalarText(value)
  const plain = scalarText(value)
  return plain === null ? null : labelFor(template, header, plain, transform)
}

export function buildAmazonTemplateRows(template: AmazonTemplateParse, fields: readonly MappingFieldRow[], records: readonly AmazonExportRecord[], options: AmazonExportOptions): AmazonExportResult {
  const byKey = new Map(fields.map(f => [f.channelKey, f]))
  const blankByDesign = new Map<string, string>()
  const gaps: AmazonExportResult['gaps'] = []
  const blankForRow = new Map<string, string>()
  const truncated: AmazonExportResult['truncated'] = []
  const notes: AmazonExportResult['notes'] = []
  // A list field spread over several columns (`bullet_point#1…#5`): each column's position in the list, as the reader built it.
  const listPosition = new Map<string, number>()
  const listColumns = new Map<string, { field: string; language: string | null; headers: string[] }>()
  for (const header of template.headers) {
    const f = byKey.get(amazonChannelKey(header))
    if (f?.state === 'mapped' && f.targetKind === 'channelField' && f.targetKey && f.transform.some(t => t.op === 'list')) {
      const key = `${f.targetKey}\u0000${languageOf(header) ?? ''}`
      const group = listColumns.get(key) ?? { field: f.targetKey, language: languageOf(header), headers: [] }
      group.headers.push(header)
      listColumns.set(key, group)
    }
  }
  for (const { headers } of listColumns.values()) headers.sort((a, b) => compareSlots(slotsOf(a), slotsOf(b))).forEach((h, i) => listPosition.set(h, i))
  // B5 — ONE value, several columns that differ by the attribute's own selectors (`compliance_media`: a column per content
  // type): the value goes into the column whose selectors match what Nexus keeps beside it (`compliance_media__content_type`).
  type SelectorGroup = { field: string; headers: string[]; primary: string | null }
  const selectorGroupOf = new Map<string, SelectorGroup>()
  const selectorGroups = new Map<string, SelectorGroup>()
  for (const header of template.headers) {
    const f = byKey.get(amazonChannelKey(header))
    if (f?.state !== 'mapped' || f.targetKind !== 'channelField' || !f.targetKey || f.transform.some(t => t.op === 'list' || t.op === 'measure') || !ownSelectors(header).length) continue
    const key = `${f.targetKey}\u0000${languageOf(header) ?? ''}`
    const group = selectorGroups.get(key) ?? { field: f.targetKey, headers: [], primary: null }
    group.headers.push(header)
    if (f.direction !== 'in') group.primary ??= header
    selectorGroups.set(key, group)
    selectorGroupOf.set(header, group)
  }

  const localesOf = (header: string) => { const lang = languageOf(header); return lang && lang !== options.primaryLanguage ? [lang] : ['', options.primaryLanguage] }
  const valueFor = (record: AmazonExportRecord, header: string, field: string): unknown => {
    for (const locale of localesOf(header)) { const v = record.values.get(valueKey(field, locale)); if (v !== undefined && v !== null && !(Array.isArray(v) && !v.length)) return v }
    return undefined
  }
  const fallbacks = new Map<SelectorGroup, string[]>()
  const leafValue = (record: AmazonExportRecord, field: string) => oneOf(record.values.get(valueKey(field, '')) ?? record.values.get(valueKey(field, options.primaryLanguage)))

  const rows = records.map(record => {
    const out: Record<string, string> = {}
    const noted = new Set<string>()
    const note = (key: string, header: string, text: string) => { if (!noted.has(key)) { noted.add(key); notes.push({ sellerSkus: [record.sellerSku], header, note: text }) } }
    // B3 — a saved offer change waiting for Publish: the file holds the live value, and the report says so (once per setting).
    const waiting = (leaf: AmazonOfferLeaf, header: string) => {
      const w = record.offers?.get(leaf)?.waiting
      if (w) note(`offer\u0000${leaf}`, header, `${OFFER_DRAFT_LABEL[leaf]} on ${record.sellerSku}: saved ${w.saved}, waiting for Publish${w.sent ? '' : ' (not sent: the date has passed)'}; the file holds the live ${w.live}.`)
    }
    // B5 — the column this row's value goes into, per group (`null` = the template has no column for the type Nexus keeps).
    const chosen = new Map<SelectorGroup, string | null>()
    const columnOf = (group: SelectorGroup): string | null => {
      if (chosen.has(group)) return chosen.get(group)!
      const anchor = group.primary ?? group.headers[0]
      let pick: string | null = group.primary
      if (valueFor(record, anchor, group.field) !== undefined) {
        const names = [...new Set(group.headers.flatMap(h => ownSelectors(h).map(s => s.name)))]
        const kept = new Map(names.map(name => [name, leafValue(record, `${group.field}__${name}`)] as const).filter((e): e is [string, string] => !!e[1]))
        const label = humanize(group.field)
        if (!kept.size) {
          // No type kept (a schema cached before the selector leaves, or a value typed on the sheet): the version's column,
          // as before. Said once per column, with every row it concerns.
          if (group.primary) fallbacks.set(group, [...(fallbacks.get(group) ?? []), record.sellerSku])
        } else {
          pick = group.headers.find(h => ownSelectors(h).every(s => !kept.has(s.name) || kept.get(s.name) === s.value)) ?? null
          if (!pick) note(`selector\u0000${group.field}`, anchor, `${label} on ${record.sellerSku}: the template has no column for ${selectorWords([...kept].map(([name, value]) => ({ name, value })))}, so the file leaves it blank.`)
        }
      }
      chosen.set(group, pick)
      return pick
    }

    for (const header of template.headers) {
      const decision = byKey.get(amazonChannelKey(header))
      const blank = (reason: string) => { if (!blankByDesign.has(header)) blankByDesign.set(header, reason) }
      if (!decision) { blank('Not in the mapping version.'); continue }
      const group = selectorGroupOf.get(header)
      const target = group ? columnOf(group) : undefined
      if (decision.direction === 'in' && target !== header) { blank('Read on import only (direction "in").'); continue }
      if (group && target !== header && valueFor(record, header, group.field) !== undefined) {
        blankForRow.set(`${record.sellerSku}\u0000${header}`, target ? `Written into the column of its own ${selectorWords(ownSelectors(target))}` : 'The template has no column for the type Nexus keeps')
        continue
      }
      const path = header.replace(/\[[^\]]*\]/g, '').replace(/#\d+/g, '').split('.')
      // Parentage is Nexus's own fact (the Products sheet), so it is written even though the import leaves it managed.
      if (decision.targetKind === 'relationship') {
        if (path[0] === 'parentage_level') {
          const role = record.role ?? (record.isParent ? 'parent' : 'child')
          if (role !== 'single') out[header] = labelFor(template, header, role, decision.transform)
        }
        else if (path.at(-1) === 'parent_sku') { if (!record.isParent && record.parentSellerSku) out[header] = record.parentSellerSku }
        else blank(decision.reason ?? 'Relationship detail not held in Nexus.')
        continue
      }
      // B3 — an offer setting (handling time, restock date, always available, the seller price bounds, MAP, the offer dates,
      // the Automate Pricing rule) is not read from a file, but the file carries its LIVE value. Quantity and the fulfilment
      // method are never offer settings here: they stay blank below.
      const offerLeaf = decision.state === 'managed' && record.offers ? offerDraftLeafOfColumn(header) : undefined
      if (offerLeaf) {
        if (rootOfLeaf(offerLeaf) === 'purchasable_offer' && !options.includePrices) { blank('Prices were not requested for this file.'); continue }
        const cell = record.offers!.get(offerLeaf)
        if (cell?.hold) { blankForRow.set(`${record.sellerSku}\u0000${header}`, cell.hold); continue }
        if (!cell) continue
        waiting(offerLeaf, header)
        const text = offerText(template, header, offerLeaf, cell.live, decision.transform)
        if (text !== null && text !== '') out[header] = text
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
          // What the listing DECLARED wins (the file's own ASIN or product ID, or its GTIN exemption); the live ASIN only fills in.
          const declaredAsin = scalarText(record.values.get(valueKey('merchant_suggested_asin', '')))
          const declaredCode = scalarText(record.values.get(valueKey('externally_assigned_product_identifier', '')))
          // B7 — the product ID's own type (stored or followed from Shared), never a guess: a code without one leaves the type blank.
          const declaredType = oneOf(record.values.get(valueKey('externally_assigned_product_identifier__type', '')))?.toLowerCase() ?? null
          const exempt = record.values.get(valueKey('supplier_declared_has_product_identifier_exemption', '')) === true
          // A code WITHOUT a type ranks below the live ASIN: a live listing whose code only follows Shared keeps its ASIN
          // (what the file held before), and only a listing with no ASIN gets the code with a blank type and a gap.
          const [type, value] = declaredAsin ? ['asin', declaredAsin] : declaredCode && declaredType ? [declaredType, declaredCode] : exempt ? ['exempt', null]
            : record.asin ? ['asin', record.asin] : declaredCode ? [null, declaredCode] : [null, null]
          if (decision.targetKey === 'product_id_type' && !type && declaredCode) {
            gaps.push({ sellerSku: record.sellerSku, header, reason: `Product ID ${declaredCode} has no product ID type in Nexus; Nexus never guesses one. Set the type in the sheet's Amazon columns.`, required: true })
            continue
          }
          text = decision.targetKey === 'product_id_type' ? (type ? labelFor(template, header, type, decision.transform) : null) : value
          if (text === null && decision.targetKey === 'product_id_value' && type === 'exempt') continue
          break
        }
        case 'price': if (!options.includePrices) { blank('Prices were not requested for this file.'); continue }
          if (record.isParent) { blankForRow.set(`${record.sellerSku}\u0000${header}`, 'A variation parent has no price of its own'); continue }
          waiting('our_price', header)
          text = record.price === null ? null : String(record.price); break
        case 'sale': if (!options.includePrices) { blank('Prices were not requested for this file.'); continue }
          if (record.isParent) { blankForRow.set(`${record.sellerSku}\u0000${header}`, 'A variation parent has no price of its own'); continue }
          waiting('sale', header)
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
        // B2 — a value cleared on the listing says so; "no value" is said only when neither the listing nor Shared holds one.
        const cleared = decision.targetKind === 'channelField' && localesOf(header).some(l => record.cleared?.has(valueKey(decision.targetKey!, l)))
        if (decision.targetKind !== 'recordAction') gaps.push({ sellerSku: record.sellerSku, header, reason: cleared ? 'Cleared on this listing in Nexus, so the cell is blank' : 'Nexus holds no value for this mapped column', required: decision.requirement === 'required' })
        continue
      }
      out[header] = text
    }
    // B4 — a list longer than the template's columns: the items past the last column are not in the file.
    for (const { field, language, headers } of listColumns.values()) {
      const written = headers.filter(h => { const d = byKey.get(amazonChannelKey(h))!; return d.direction !== 'in' && (!d.productTypes.length || d.productTypes.includes(record.productType)) })
      if (!written.length) continue
      const value = valueFor(record, written[0], field)
      const held = Array.isArray(value) ? value.filter(v => scalarText(v) !== null).length : 0
      if (held > written.length) truncated.push({ sellerSku: record.sellerSku, sku: record.sku, field, label: `${humanize(field)}${language && language !== options.primaryLanguage ? ` (${language})` : ''}`, held, columns: written.length })
    }
    return out
  })
  for (const [group, skus] of fallbacks) {
    const names = [...new Set(group.headers.flatMap(h => ownSelectors(h).map(s => s.name.replace(/_/g, ' '))))].join(' or ')
    notes.push({ sellerSkus: skus, header: group.primary!, note: `${humanize(group.field)}: Nexus keeps no ${names} beside it on ${skus.length === 1 ? skus[0] : `${skus.length} rows`}, so it is written into the version's column (${selectorWords(ownSelectors(group.primary!))}).` })
  }
  return { rows, blankByDesign, gaps, blankForRow, truncated, notes }
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
