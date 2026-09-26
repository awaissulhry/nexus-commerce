import ExcelJS from 'exceljs'
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'
import type { ChannelFieldSpec, ChannelSpec } from './channel-specs/types.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import { EBAY_WORKBOOK_COLUMNS } from '../channel-mapping/defaults.js'
import { ebayChannelKeyOf, headerNames } from '../channel-mapping/ebay-draft.js'
import { ignoredReason, unmappedReason, type ReaderMapping } from '../channel-mapping/decisions.js'

/**
 * CFI-5 (R-CFI-1) — our eBay listing workbooks, every family and both shapes the Owner holds:
 *   - the eBay flat-file page's export: one `ebay_<mk>` sheet, 79 columns, several listings per family;
 *   - the root `XAVIA-eBay-<MK>-<FAMILY>.xlsx`: one sheet named by the family, 66 columns, `Price (EUR)`,
 *     the Category ID only on the parent row, no Item IDs.
 * Recognised by the identity HEADERS, never by the sheet name or a family. Every populated cell ends in the
 * ledger as a row, an exclusion or a refusal, written at the branch that decides it (`checkEbayLedger`).
 */

/** Verified catalog coordinates, never alias labels or SKU-stem guesses. */
export interface EbayWorkbookTarget {
  id: string; sku: string; parentSku: string; sourceParentSku: string
  isParent: boolean; itemId: string; accountId: string; marketplace: string; aliasKey: string; version: number
  /** Item-specific names this listing already stores (`platformAttributes.itemSpecifics`) — a custom specific keeps their spelling. */
  specificNames?: string[]
}
export interface EbayWorkbookTable {
  sheet: string; marketplace: string; headers: string[]
  /** Where the marketplace came from: the `ebay_<mk>` sheet name, `-eBay-<MK>-` in the file name, or the caller's choice. */
  marketplaceFrom?: 'sheet' | 'filename' | 'hint'
  records: { row: number; values: Record<string, string>; fileSku?: string; fileParentSku?: string }[]
}
export interface EbayLedgerEntry {
  row: number; sku: string; header: string
  outcome: 'row' | 'excluded' | 'refused' | 'skipped-row'
  field?: string; reason?: string
}
/** CFI-4 — an identity PROPOSAL the Owner confirms (`links` on the next preview request). */
export interface EbayLink { fileSku: string; proposedSku: string; reason: string }
export interface EbayWorkbookResult {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions: SourceExclusion[]
  ledger: EbayLedgerEntry[]; links: EbayLink[]; warnings: string[]
  /** CHMAP — the mapping version the file was read with (`docs/studies/channel-mappings.md` §8). */
  mapping?: { setId: string; version: number; status: string; label: string; created: boolean }
}
export interface EbayResolveOptions {
  /** Confirmed identity links: file parent SKU → Nexus parent SKU. */
  links?: Record<string, string>
  /** A delete-like `Action` marks the listing ended in Nexus only when confirmed: `true` = every delete row, a list = only
   *  the rows whose FILE SKU it names (never the resolved Nexus SKU — an alias shares it with its primary listing). */
  confirmDeletes?: boolean | readonly string[]
}

// CHMAP — the column lists are data, shared with the mapping draft builder and the export (`channel-mapping/defaults.ts`).
const fixedFields: Readonly<Record<string, string>> = EBAY_WORKBOOK_COLUMNS.fixedFields
const IDENTITY_HEADERS = EBAY_WORKBOOK_COLUMNS.identityHeaders
const coordinates = new Set(EBAY_WORKBOOK_COLUMNS.coordinates)
const quantityHeaders = new Set(EBAY_WORKBOOK_COLUMNS.quantityHeaders)
const controlHeaders = new Set(EBAY_WORKBOOK_COLUMNS.controlHeaders)
/** Product identifiers the workbook carries beside the specifics; a category aspect of the same name still maps first. */
const identifierHeaders = new Set(EBAY_WORKBOOK_COLUMNS.identifierHeaders)
const PRICE_HEADER = new RegExp(EBAY_WORKBOOK_COLUMNS.pricePattern)
const IMAGE_HEADER = new RegExp(EBAY_WORKBOOK_COLUMNS.imagePattern)
const isPriceHeader = (header: string) => PRICE_HEADER.test(header)
const isImageHeader = (header: string) => IMAGE_HEADER.test(header)
/** Delete-like eBay lifecycle words, keyed by the languages our workbooks use. Data, not market code paths. */
const DELETE_ACTIONS = new RegExp(EBAY_WORKBOOK_COLUMNS.deleteActionPattern, 'i')
const aspectLabel = (header: string) => header.replace(/\s*[○↕⚠*]+/gu, '').replace(/\s*\([^)]*\)\s*$/, '').trim()
const isCustomSpecificHeader = (header: string) => /⚠/u.test(header)
const columnName = (index: number): string => index >= 26 ? columnName(Math.floor(index / 26) - 1) + columnName(index % 26) : String.fromCharCode(65 + index)
const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()
const NOT_IN_NEXUS = 'This eBay listing is not in Nexus for this product. If it is a legacy listing shell, adopt it as a listing alias first (PES.5 shell adoption: apps/api/scripts/pes5-adopt-shells.mts), then import again.'

function headerRow(sheet: ExcelJS.Worksheet): string[] {
  return Array.from({ length: sheet.columnCount }, (_, i) => sheet.getCell(1, i + 1).text.trim())
}
const ebayShaped = (sheet: ExcelJS.Worksheet) => { const headers = new Set(headerRow(sheet)); return IDENTITY_HEADERS.every(h => headers.has(h)) }

/** Recognise our eBay workbook by its identity headers, whatever the sheet is called. */
export function readEbayWorkbook(book: ExcelJS.Workbook, hint: { filename?: string; market?: string } = {}): EbayWorkbookTable | null {
  const sheets = book.worksheets.filter(s => /^ebay_(it|de|fr|es|uk)$/i.test(s.name) || ebayShaped(s))
  if (!sheets.length) return null
  if (book.worksheets.length !== 1) throw new Error('Import one eBay marketplace worksheet at a time')
  const sheet = sheets[0], columns = sheet.columnCount
  if (columns > 200 || sheet.rowCount > TRANSFER_MAX_ROWS + 1) throw new Error('The eBay workbook exceeds 200 columns or 50,000 rows')
  const headers = headerRow(sheet)
  if (headers.some(h => !h) || new Set(headers).size !== headers.length || IDENTITY_HEADERS.some(h => !headers.includes(h))) throw new Error('Keep the eBay SKU, Parent/Child, Parent SKU and Category ID headers intact, and every header unique')
  const fromSheet = /^ebay_([a-z]{2})$/i.exec(sheet.name)?.[1]
  const fromFile = /(?:^|[^a-z])ebay[-_ ]([a-z]{2})(?=[-_. ])/i.exec(hint.filename ?? '')?.[1]
  const market = (fromSheet ?? fromFile ?? hint.market ?? '').toUpperCase()
  if (!/^(IT|DE|FR|ES|UK)$/.test(market)) throw new Error('Choose the eBay marketplace for this workbook: neither the sheet name nor the file name states it')
  const records: EbayWorkbookTable['records'] = []
  sheet.eachRow(row => {
    const values: Record<string, string> = {}
    for (let c = 1; c <= columns; c++) {
      const cell = row.getCell(c)
      if (cell.type === ExcelJS.ValueType.Formula || cell.type === ExcelJS.ValueType.Error) throw new Error(`${sheet.name}!${cell.address}: replace formulas and errors with verified values`)
      if (cell.text.length > 256_000) throw new Error(`${sheet.name}!${cell.address}: cell exceeds 256,000 characters`)
      values[headers[c - 1]] = cell.text
    }
    if (row.number > 1 && Object.values(values).some(v => v.trim())) records.push({ row: row.number, values })
  })
  if (!records.length) throw new Error('The eBay workbook contains no listing rows')
  return { sheet: sheet.name, marketplace: market, marketplaceFrom: fromSheet ? 'sheet' : fromFile ? 'filename' : 'hint', headers, records }
}

function typedValue(field: ChannelFieldSpec, raw: string): unknown {
  if (field.kind === 'boolean') {
    if (!['true', 'false', '1', '0'].includes(raw.trim().toLowerCase())) throw new Error('Use true, false, 1 or 0')
    return ['true', '1'].includes(raw.trim().toLowerCase())
  }
  if (field.kind === 'number') {
    const value = Number(raw)
    if (!raw.trim() || !Number.isFinite(value)) throw new Error('Use a finite number with a decimal point')
    return value
  }
  return raw
}

const emptyResult = (): EbayWorkbookResult => ({ rows: [], issues: [], exclusions: [], ledger: [], links: [], warnings: [] })
const populatedHeaders = (table: EbayWorkbookTable, record: EbayWorkbookTable['records'][number]) => table.headers.filter(h => record.values[h]?.trim())
const fileSkuOf = (record: EbayWorkbookTable['records'][number]) => record.fileSku ?? record.values.SKU?.trim() ?? ''

/** Refuse or skip a whole record: one issue (or exclusion), and every populated cell in the ledger with the same reason. */
function decideRecord(out: EbayWorkbookResult, table: EbayWorkbookTable, record: EbayWorkbookTable['records'][number], outcome: 'refused' | 'skipped-row', field: string, message: string,
  listing?: { sku: string; accountId: string; marketplace: string; aliasKey: string }) {
  const sku = listing?.sku ?? fileSkuOf(record), source = { sheet: table.sheet, column: columnName(Math.max(0, table.headers.indexOf(field))) }
  // A known listing travels with the issue, so the review names it (channel · market · account · alias) and keys stay unique.
  const coordinate = listing ? { fileSku: fileSkuOf(record), channel: 'EBAY', marketplace: listing.marketplace, accountId: listing.accountId, aliasKey: listing.aliasKey } : {}
  if (outcome === 'refused') out.issues.push({ row: record.row, sku, field, message, source, ...coordinate } as TransferIssue)
  else out.exclusions.push({ row: record.row, sku, field, message, source })
  for (const header of populatedHeaders(table, record)) out.ledger.push({ row: record.row, sku, header, outcome, reason: message })
}

/** Invalid identities block their whole row. Resolved rows account for every populated cell. */
export function mapEbayWorkbook(table: EbayWorkbookTable, targets: EbayWorkbookTarget[], specs: Map<string, ChannelSpec>, options: EbayResolveOptions & { notInNexus?: string; knownSkus?: ReadonlySet<string>; mapping?: ReaderMapping; mappingSpecs?: ReadonlyMap<string, ChannelSpec> } = {}): EbayWorkbookResult {
  const out = emptyResult()
  const warned = new Set<string>()
  const value = (r: Record<string, string>, header: string) => (r[header] ?? '').trim()
  // Parent rows by SKU. A variation finds its parent by Parent SKU, and by Item ID when both rows carry one.
  const parents = new Map<string, { row: number; itemId: string; category: string; children: number }[]>()
  for (const { row, values: r } of table.records) if (value(r, 'Parent/Child').toLowerCase() === 'parent') {
    const list = parents.get(value(r, 'SKU')) ?? []
    list.push({ row, itemId: value(r, 'Item ID'), category: value(r, 'Category ID'), children: 0 })
    parents.set(value(r, 'SKU'), list)
  }
  const parentFor = (parentSku: string, itemId: string) => (parents.get(parentSku) ?? []).filter(p => !itemId || !p.itemId || p.itemId === itemId)
  for (const { values: r } of table.records) if (value(r, 'Parent/Child').toLowerCase() === 'child') {
    const found = parentFor(value(r, 'Parent SKU'), value(r, 'Item ID'))
    if (found.length === 1) found[0].children++
  }
  const looseKey = (parentSku: string, isParent: boolean, sku: string) => JSON.stringify([parentSku, isParent, isParent ? '' : sku])
  const byLoose = new Map<string, EbayWorkbookTarget[]>()
  for (const t of targets) if (t.marketplace === table.marketplace) {
    const key = looseKey(t.sourceParentSku, t.isParent, t.sku)
    byLoose.set(key, [...(byLoose.get(key) ?? []), t])
  }
  // Pass 1 — identify each row's listing. Every refusal here is decided for the whole row.
  const matched: { record: EbayWorkbookTable['records'][number]; t: EbayWorkbookTarget; category: string; parentage: string; parentRow: { children: number } }[] = []
  for (const record of table.records) {
    const r = record.values, sku = value(r, 'SKU'), parentage = value(r, 'Parent/Child').toLowerCase(), ownItem = value(r, 'Item ID')
    const refuseRow = (field: string, message: string) => decideRecord(out, table, record, 'refused', field, message)
    if (!sku || !['parent', 'child'].includes(parentage)) { refuseRow('Parent/Child', 'Supply an exact SKU and Parent/Child = parent or child'); continue }
    if (parentage === 'parent' && value(r, 'Parent SKU')) { refuseRow('Parent SKU', 'A parent row cannot name a parent SKU'); continue }
    if (ownItem && !/^\d{9,15}$/.test(ownItem)) { refuseRow('Item ID', 'The Item ID must be eBay’s numeric item number'); continue }
    const parentSku = parentage === 'parent' ? sku : value(r, 'Parent SKU')
    if (!parentSku) { refuseRow('Parent SKU', 'A variation row needs its Parent SKU'); continue }
    const parentRows = parentFor(parentSku, ownItem)
    if (parentRows.length !== 1) { refuseRow('Parent SKU', 'Each row needs exactly one parent row with the same Parent SKU (and Item ID when both rows carry one)'); continue }
    const parentRow = parentRows[0]
    const itemId = ownItem || parentRow.itemId
    const ownCategory = value(r, 'Category ID')
    if (parentage === 'child' && ownCategory && parentRow.category && ownCategory !== parentRow.category) { refuseRow('Category ID', 'Every variant of an eBay listing must use its parent listing category'); continue }
    const category = ownCategory || parentRow.category
    if (!category) { refuseRow('Category ID', 'The parent row needs the eBay Category ID'); continue }
    const listingId = value(r, 'Listing ID')
    const loose = (byLoose.get(looseKey(parentSku, parentage === 'parent', sku)) ?? []).filter(t => !listingId || listingId === t.id)
    let candidates = itemId ? loose.filter(t => t.itemId === itemId) : loose
    if (itemId && !candidates.length && loose.length === 1 && loose[0].itemId) {
      refuseRow('Item ID', `The file's Item ID ${itemId} differs from the Item ID Nexus holds for this listing (${loose[0].itemId}). The file may be older than eBay; correct the file or the listing identity before importing.`); continue
    }
    if (!candidates.length && options.knownSkus && !options.knownSkus.has(sku)) { refuseRow('SKU', `${sku} is not a Nexus product. Create it first (Catalog import, Create or update), then import this listing again.`); continue }
    if (!candidates.length) { refuseRow('Item ID', options.notInNexus ?? NOT_IN_NEXUS); continue }
    if (candidates.length > 1) { refuseRow('Item ID', 'Several Nexus listings match this row. Add the eBay Item ID or Listing ID so it names exactly one listing.'); continue }
    const t = candidates[0]
    if (!t.accountId || !Number.isSafeInteger(t.version) || t.version < 0) { refuseRow('Item ID', 'The listing needs a verified account and record version'); continue }
    matched.push({ record, t, category, parentage, parentRow })
  }
  // A listing named by more than one row is refused on EVERY such row: no row may be applied as "the" value.
  const rowsByListing = new Map<string, number[]>()
  for (const m of matched) rowsByListing.set(m.t.id, [...(rowsByListing.get(m.t.id) ?? []), m.record.row])
  // Pass 2 — the values of each uniquely identified listing.
  for (const { record, t, category, parentage, parentRow } of matched) {
    const r = record.values
    const refuseRow = (field: string, message: string) => decideRecord(out, table, record, 'refused', field, message)
    const sameListing = rowsByListing.get(t.id)!
    if (sameListing.length > 1) { refuseRow('SKU', `Duplicate rows ${sameListing.join(', ')} name the same eBay listing for ${t.sku}; keep one row per listing and import again`); continue }
    const spec = specs.get(category)
    if (!spec || spec.absent || spec.marketplace !== table.marketplace) { refuseRow('Category ID', 'Refresh this marketplace and category schema before importing'); continue }
    // Action: a delete-like lifecycle word ends the listing in Nexus (nothing is sent), only when confirmed.
    const action = value(r, 'Action')
    const fileSkuHere = fileSkuOf(record)
    // A confirmation names the FILE's SKU only: ticking a primary listing must never confirm its adopted aliases.
    const deleteConfirmed = options.confirmDeletes === true || Array.isArray(options.confirmDeletes) && options.confirmDeletes.includes(fileSkuHere)
    if (action && DELETE_ACTIONS.test(action) && !deleteConfirmed) {
      decideRecord(out, table, record, 'refused', 'presence', `The file ends this eBay listing (Action "${action}"). Confirm deletes to mark it ended in Nexus; nothing is sent to eBay.`, t); continue
    }
    const fileSku = fileSkuHere
    const identity = { row: record.row, sku: t.sku, entity: 'Overrides' as const, channel: 'EBAY', accountId: t.accountId, marketplace: t.marketplace, aliasKey: t.aliasKey, locale: '', action: 'SET' as const, version: t.version, origin: 'channel-file' as const, ...(fileSku && fileSku !== t.sku ? { fileSku } : {}) }
    const source = (header: string) => ({ sheet: table.sheet, column: columnName(table.headers.indexOf(header)) })
    const emit = (header: string, field: string, fieldValue: unknown, entity: TransferRow['entity'] = 'Overrides') => {
      out.rows.push({ ...identity, entity, field, value: fieldValue, source: source(header) })
      out.ledger.push({ row: record.row, sku: t.sku, header, outcome: 'row', field })
    }
    const also = (header: string, field: string) => out.ledger.push({ row: record.row, sku: t.sku, header, outcome: 'row', field })
    const exclude = (header: string, message: string) => {
      out.exclusions.push({ row: record.row, sku: t.sku, field: header, message, source: source(header) })
      out.ledger.push({ row: record.row, sku: t.sku, header, outcome: 'excluded', reason: message })
    }
    const refuse = (header: string, message: string) => {
      out.issues.push({ row: record.row, sku: t.sku, field: header, message, source: source(header) })
      out.ledger.push({ row: record.row, sku: t.sku, header, outcome: 'refused', reason: message })
    }
    if (action && DELETE_ACTIONS.test(action)) {
      // Confirmed: the listing is gone on eBay. Its other values describe a listing that no longer exists.
      emit('Action', 'presence', 'ENDED', 'Listings')
      for (const header of populatedHeaders(table, record)) if (header !== 'Action') exclude(header, 'This row ends the listing; its other values are not imported')
      continue
    }
    // A confirmed link or another channel identity: remember the channel's own SKU on the listing.
    if (fileSku && fileSku !== t.sku) emit('SKU', 'sellerSku', fileSku, 'Listings')
    const prices = table.headers.filter(h => isPriceHeader(h) && value(r, h))
    let pricesDone = false, imagesDone = false
    for (const header of table.headers) {
      const raw = r[header]
      if (!raw?.trim()) continue
      if (header === 'SKU' && fileSku && fileSku !== t.sku) continue // ledgered above as sellerSku
      if (coordinates.has(header)) { exclude(header, 'Verified listing identity; shared product parentage and remote links are preserved'); continue }
      if (quantityHeaders.has(header)) { exclude(header, `Quantity is not imported: EU merchant quantity is one number for every EU market, and stock has its own ledger. File value: ${raw.trim()}`); continue }
      if (controlHeaders.has(header)) { exclude(header, `Listing control or sync reference; not imported. File value: ${raw.trim()}`); continue }
      if (header === 'Action') { exclude(header, `Listing lifecycle is not imported (Action "${raw.trim()}")`); continue }
      if (isPriceHeader(header)) {
        if (pricesDone) continue
        pricesDone = true
        if (parentage === 'parent' && parentRow.children > 0) { for (const h of prices) exclude(h, `A multi-variation parent has no own price on eBay; each variation carries its price. File value: ${value(r, h)}`); continue }
        const parsed = prices.map(h => ({ h, n: /^\d+(?:\.\d+)?$/.test(value(r, h)) ? Number(value(r, h)) : NaN }))
        const bad = parsed.filter(p => !Number.isFinite(p.n))
        if (bad.length) { for (const p of parsed) refuse(p.h, `Use a number with a decimal point for the price (${prices.map(h => `${h} ${value(r, h)}`).join(', ')})`); continue }
        if (new Set(parsed.map(p => p.n)).size > 1) { for (const p of parsed) refuse(p.h, `The price columns disagree (${prices.map(h => `${h} ${value(r, h)}`).join(', ')}); keep one price`); continue }
        if (parsed[0].n === 0) { for (const p of parsed) exclude(p.h, 'A price of 0 is not a selling price; nothing is imported for it'); continue }
        emit(parsed[0].h, 'price', parsed[0].n)
        for (const p of parsed.slice(1)) also(p.h, 'price')
        continue
      }
      if (header === 'Wt Unit') continue // decided with Weight below
      if (isImageHeader(header)) {
        if (imagesDone) continue
        imagesDone = true
        const images = table.headers.filter(h => isImageHeader(h) && value(r, h))
        emit(images[0], 'imageUrls', images.map(h => value(r, h)))
        for (const h of images.slice(1)) also(h, 'imageUrls')
        continue
      }
      const label = aspectLabel(header)
      // CHMAP — the mapping version decides; the Owner's decision wins over the rules below.
      let ownerField: string | null = null
      if (options.mapping) {
        const decision = options.mapping.byKey.get(ebayChannelKeyOf(header, options.mappingSpecs ?? specs).channelKey)
        if (!decision) { refuse(header, unmappedReason(options.mapping, header, 'the column is not in this version')); continue }
        if (decision.state === 'unmapped') { refuse(header, unmappedReason(options.mapping, header, decision.reason)); continue }
        if (decision.decidedBy === 'owner' && (decision.state === 'ignored' || decision.state === 'managed')) { exclude(header, ignoredReason(options.mapping, decision.reason)); continue }
        if (decision.decidedBy === 'owner' && decision.targetKind === 'itemSpecific' && decision.targetKey) { emit(header, decision.targetKey, raw); continue }
        if (decision.decidedBy === 'owner' && decision.targetKind === 'channelField' && decision.targetKey) ownerField = decision.targetKey
      }
      // An aspect column matches by EITHER of its names: `Colore (Color)` and the export's English-first `Color (Colore)`.
      const names = headerNames(header)
      const isAspect = (f: ChannelFieldSpec) => f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics'
      let fields = ownerField ? spec.fields.filter(f => f.key === ownerField)
        : fixedFields[header] ? spec.fields.filter(f => f.key === fixedFields[header]) : spec.fields.filter(f => isAspect(f) && names.includes((f.channelStore as { path: string[] }).path[1]))
      if (!fields.length && !fixedFields[header] && !ownerField) fields = spec.fields.filter(f => isAspect(f) && names.some(n => fold((f.channelStore as { path: string[] }).path[1]) === fold(n)))
      if (ownerField && fields.length !== 1) { refuse(header, `${options.mapping!.label} maps this column to ${ownerField}, which eBay ${table.marketplace} category ${category} does not declare`); continue }
      if (fields.length !== 1) {
        if (fields.length > 1 || fixedFields[header]) { refuse(header, 'This populated column has no unambiguous field in the current eBay schema; map or remove it explicitly'); continue }
        if (identifierHeaders.has(header)) { exclude(header, `Product identifier: not imported from an eBay listing workbook; it belongs to the product record. File value: ${raw.trim()}`); continue }
        // By the workbook's own structure every other column is an item specific: one eBay's current category does not
        // declare is the seller's own specific (the export marks some ⚠). Kept under the name the listing already stores.
        const stored = t.specificNames?.find(n => fold(n) === fold(label))
        if (!isCustomSpecificHeader(header) && !warned.has(`custom:${label}`)) { warned.add(`custom:${label}`); out.warnings.push(`${label}: not in eBay's current category requirements; kept as the seller's own specific.`) }
        emit(header, `itemSpecifics.${stored ?? label}`, raw)
        continue
      }
      const field = fields[0]
      try {
        let typed: unknown
        if (field.shape === 'measure') {
          const unit = value(r, 'Wt Unit')
          if (!unit || !field.unitOptions?.includes(unit)) throw new Error('Supply a supported weight unit')
          typed = { value: typedValue(field, raw), unit }
        } else if (field.shape === 'list') typed = raw.split(',').map(v => typedValue(field, v.trim()))
        else typed = typedValue(field, raw)
        let values = Array.isArray(typed) ? typed : [typed]
        if (field.mode === 'strict' && field.options?.length) {
          // A spelling eBay would accept (case, accents) becomes eBay's own choice. Anything else is kept as the
          // file holds it and flagged: the file is the channel's record, the review shows the change.
          const normalised = values.map(v => typeof v === 'string' && !field.options!.includes(v) ? field.options!.find(o => fold(o) === fold(v)) ?? v : v)
          if (JSON.stringify(normalised) !== JSON.stringify(values)) { values = normalised; typed = Array.isArray(typed) ? normalised : normalised[0] }
          const outside = values.filter(v => !field.options!.includes(String(v)))
          const key = JSON.stringify([field.key, outside])
          if (outside.length && !warned.has(key)) { warned.add(key); out.warnings.push(`${field.label}: ${outside.map(v => `"${String(v)}"`).join(', ')} is not one of eBay's choices (${field.options.join(', ')}). Imported as the file holds it; the review shows the change.`) }
        }
        if (field.maxLength && values.some(v => typeof v === 'string' && v.length > field.maxLength!)) throw new Error(`Use at most ${field.maxLength} characters`)
        emit(header, field.key, typed, field.key === 'categoryId' ? 'Listings' : 'Overrides')
        if (field.shape === 'measure' && value(r, 'Wt Unit')) also('Wt Unit', field.key)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        refuse(header, message)
        if (field.shape === 'measure' && value(r, 'Wt Unit')) refuse('Wt Unit', message)
      }
    }
    if (value(r, 'Wt Unit') && !value(r, 'Weight')) refuse('Wt Unit', 'A weight unit needs a populated Weight cell')
    if (out.rows.length + out.issues.length + out.exclusions.length > TRANSFER_MAX_ROWS) throw new Error('The eBay workbook exceeds 50,000 attribute outcomes')
  }
  return out
}

/**
 * CFI-9 — the zero-loss check, computed INDEPENDENTLY of the mapper: the table's populated cells against the ledger.
 * `unaccounted`: a populated cell with no ledger entry · `duplicated`: a cell decided twice · `danglingRows`: a
 * 'row' entry with no emitted row for that row, SKU and field · `phantom`: an entry for a cell that is blank.
 */
export function checkEbayLedger(table: EbayWorkbookTable, result: Pick<EbayWorkbookResult, 'rows' | 'ledger'>) {
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

type Db = typeof import('../../db.js')['default']
interface GroupPlan { rootId: string; rootSku: string; records: EbayWorkbookTable['records']; knownSkus: ReadonlySet<string> }

/**
 * Decide which Nexus product group each file listing belongs to (D4): the file parent SKU as a Nexus root → an
 * ADOPTED legacy shell's alias → a confirmed link → otherwise a PROPOSAL from its children (never applied unasked).
 * `onlyRootId` (the drawer) skips rows of other product groups instead of refusing them.
 */
export async function planEbayGroups(prisma: Pick<Db, 'product' | 'productListingAlias'>, table: EbayWorkbookTable, out: EbayWorkbookResult, options: EbayResolveOptions, onlyRootId?: string): Promise<GroupPlan[]> {
  const v = (r: Record<string, string>, h: string) => (r[h] ?? '').trim()
  const fileParentOf = (r: Record<string, string>) => v(r, 'Parent/Child').toLowerCase() === 'parent' ? v(r, 'SKU') : v(r, 'Parent SKU')
  const parentSkus = [...new Set(table.records.map(rec => fileParentOf(rec.values)).filter(Boolean))]
  const childSkus = [...new Set(table.records.filter(rec => v(rec.values, 'Parent/Child').toLowerCase() === 'child').map(rec => v(rec.values, 'SKU')).filter(Boolean))]
  const linkTargets = Object.values(options.links ?? {})
  const products = await prisma.product.findMany({ where: { sku: { in: [...new Set([...parentSkus, ...childSkus, ...linkTargets])] } }, select: { id: true, sku: true, parentId: true, productType: true, deletedAt: true } })
  const live = new Map(products.filter(p => !p.deletedAt).map(p => [p.sku, p]))
  // An adopted listing shell is found by its alias whatever the shell product looks like now (adoption soft-deletes it).
  const shells = products.filter(p => p.productType === 'EBAY_LISTING_SHELL')
  const aliases = products.length ? await prisma.productListingAlias.findMany({ where: { adoptedFromProductId: { in: products.map(p => p.id) }, status: 'ACTIVE' }, select: { productId: true, adoptedFromProductId: true } }) : []
  const roots = await prisma.product.findMany({ where: { id: { in: [...new Set([...products.map(p => p.parentId), ...aliases.map(a => a.productId)].filter((id): id is string => !!id))] }, deletedAt: null }, select: { id: true, sku: true } })
  const rootById = new Map(roots.map(r => [r.id, r.sku]))
  const decision = new Map<string, { rootId: string; rootSku: string } | { refuse: string } | { skip: string }>()
  for (const fileParent of parentSkus) {
    const own = live.get(fileParent)
    const shell = shells.find(s => s.sku === fileParent)
    const linked = options.links?.[fileParent] ? live.get(options.links[fileParent]) : undefined
    // 1. An ADOPTED shell: its SKU names its alias directly (production GALE since 09-15). Never a proposal.
    const adopted = aliases.find(a => products.some(p => p.id === a.adoptedFromProductId && p.sku === fileParent) && rootById.has(a.productId))
    let root: { rootId: string; rootSku: string } | null = null
    if (adopted) root = { rootId: adopted.productId, rootSku: rootById.get(adopted.productId)! }
    else if (own && own.productType !== 'EBAY_LISTING_SHELL' && !own.parentId) root = { rootId: own.id, rootSku: own.sku }
    else if (shell) { decision.set(fileParent, { refuse: `${fileParent} is a legacy eBay listing shell, not yet a listing of its product. Adopt it as a listing alias first (PES.5 shell adoption: apps/api/scripts/pes5-adopt-shells.mts), then import again.` }); continue }
    else if (linked && !linked.parentId && linked.productType !== 'EBAY_LISTING_SHELL') root = { rootId: linked.id, rootSku: linked.sku }
    if (!root) {
      const children = table.records.filter(rec => v(rec.values, 'Parent/Child').toLowerCase() === 'child' && v(rec.values, 'Parent SKU') === fileParent).map(rec => v(rec.values, 'SKU'))
      const known = children.map(sku => live.get(sku)).filter((p): p is NonNullable<typeof p> => !!p && !!p.parentId)
      const parentIds = [...new Set(known.map(p => p.parentId!))]
      if (parentIds.length === 1 && rootById.has(parentIds[0])) {
        const proposedSku = rootById.get(parentIds[0])!
        out.links.push({ fileSku: fileParent, proposedSku, reason: `${known.length} of ${new Set(children).size} variation SKUs under eBay parent ${fileParent} belong to Nexus product ${proposedSku}` })
        decision.set(fileParent, { refuse: `Link eBay parent ${fileParent} to Nexus product ${proposedSku}? Confirm the link to import this listing.` })
      } else decision.set(fileParent, { refuse: parentIds.length > 1 ? `The variations under eBay parent ${fileParent} belong to several Nexus products; this listing cannot be placed.` : `eBay parent ${fileParent} is not a Nexus product, and none of its variation SKUs is. Create the product first, or link the parent.` })
      continue
    }
    if (onlyRootId && root.rootId !== onlyRootId) { decision.set(fileParent, { skip: 'Outside this product; use Catalog import' }); continue }
    decision.set(fileParent, root)
  }
  const groups = new Map<string, GroupPlan>()
  for (const record of table.records) {
    const fileParent = fileParentOf(record.values)
    const d = fileParent ? decision.get(fileParent) : { refuse: 'A variation row needs its Parent SKU' }
    if (!d) { decideRecord(out, table, record, 'refused', 'Parent SKU', 'A variation row needs its Parent SKU'); continue }
    if ('refuse' in d) { decideRecord(out, table, record, 'refused', 'Parent SKU', d.refuse); continue }
    if ('skip' in d) { decideRecord(out, table, record, 'skipped-row', 'Parent SKU', d.skip); continue }
    const group = groups.get(d.rootId) ?? { rootId: d.rootId, rootSku: d.rootSku, records: [], knownSkus: new Set(live.keys()) }
    // A linked parent is matched under its Nexus SKU; the file's own SKU travels with the row.
    const isParent = v(record.values, 'Parent/Child').toLowerCase() === 'parent'
    group.records.push(fileParent === d.rootSku || !options.links?.[fileParent] ? record : {
      ...record, fileSku: v(record.values, 'SKU'), fileParentSku: fileParent,
      values: { ...record.values, ...(isParent ? { SKU: d.rootSku } : { 'Parent SKU': d.rootSku }) },
    })
    groups.set(d.rootId, group)
  }
  return [...groups.values()]
}

/** Every eBay listing of one product group as a verified target (primary and adopted aliases). CHMAP: the export reads it too. */
export async function groupTargets(prisma: Db, table: EbayWorkbookTable, rootId: string) {
  const { productTransferOptions } = await import('./catalog-product-transfer.js')
  const options = await productTransferOptions(rootId), productById = new Map(options.products.map(p => [p.id, p]))
  const selected = options.listings.filter(l => l.channel === 'EBAY' && l.marketplace === table.marketplace)
  const [listings, aliases] = await Promise.all([
    prisma.channelListing.findMany({ where: { id: { in: selected.map(l => l.id) } }, select: { id: true, productId: true, externalListingId: true, version: true, platformAttributes: true } }),
    prisma.productListingAlias.findMany({ where: { id: { in: selected.map(l => l.aliasKey).filter(Boolean) } }, select: { id: true, adoptedFromProductId: true } }),
  ])
  const shells = await prisma.product.findMany({ where: { id: { in: aliases.map(a => a.adoptedFromProductId).filter((id): id is string => !!id) } }, select: { id: true, sku: true } })
  const rootSku = productById.get(options.rootId)!.sku
  return listings.flatMap((l): EbayWorkbookTarget[] => {
    const coordinate = selected.find(s => s.id === l.id)!, product = productById.get(l.productId)!
    const alias = aliases.find(a => a.id === coordinate.aliasKey)
    const sourceParentSku = alias?.adoptedFromProductId ? shells.find(s => s.id === alias.adoptedFromProductId)?.sku : rootSku
    if (!sourceParentSku) return []
    const specifics = (l.platformAttributes as { itemSpecifics?: Record<string, unknown> } | null)?.itemSpecifics
    return [{ ...coordinate, sku: product.sku, parentSku: rootSku, sourceParentSku, isParent: product.id === options.rootId, itemId: l.externalListingId ?? '', version: l.version, specificNames: specifics && typeof specifics === 'object' ? Object.keys(specifics) : [] }]
  })
}

async function resolveGroups(table: EbayWorkbookTable, options: EbayResolveOptions, onlyRootId?: string): Promise<EbayWorkbookResult> {
  const [{ default: prisma }, { loadEbaySpec }] = await Promise.all([import('../../db.js'), import('./channel-specs/index.js')])
  const out = emptyResult()
  // CHMAP M2 — one mapping version for the whole file: its columns against every category it names.
  const fileSpecs = new Map<string, ChannelSpec>()
  for (const category of new Set(table.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))) fileSpecs.set(category, await loadEbaySpec(table.marketplace, [category]))
  const { ebayImportMapping } = await import('../channel-mapping/ebay-import.js')
  let chmap: Awaited<ReturnType<typeof ebayImportMapping>> | null = null, mappingProblem = ''
  try { chmap = await ebayImportMapping(table, fileSpecs) } catch (error) { mappingProblem = error instanceof Error ? error.message : String(error) }
  for (const group of await planEbayGroups(prisma, table, out, options, onlyRootId)) {
    const sub: EbayWorkbookTable = { ...table, records: group.records }
    const targets = await groupTargets(prisma, sub, group.rootId)
    const specs = new Map<string, ChannelSpec>()
    const categories = new Set(sub.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))
    for (const category of categories) specs.set(category, fileSpecs.get(category) ?? await loadEbaySpec(table.marketplace, [category]))
    const mapped = mapEbayWorkbook(sub, targets, specs, { ...options, knownSkus: group.knownSkus, ...(chmap?.mapping ? { mapping: chmap.mapping, mappingSpecs: fileSpecs } : {}) })
    out.rows.push(...mapped.rows); out.issues.push(...mapped.issues); out.exclusions.push(...mapped.exclusions)
    out.ledger.push(...mapped.ledger); out.warnings.push(...mapped.warnings)
  }
  if (chmap?.info) {
    out.mapping = chmap.info
    const { recordUse } = await import('../channel-mapping/store.js')
    await recordUse(chmap.info.setId, 'IMPORT', table.sheet, { rows: out.rows.length, excluded: out.exclusions.length, refused: out.issues.length })
  }
  out.warnings.unshift(...(chmap?.info ? [`Read with the mapping ${chmap.info.label}.`] : []), ...(chmap?.warnings ?? []), ...(mappingProblem ? [`The mapping versions could not be read (${mappingProblem}); this file was read with the built-in rules only, and no Owner decision was applied.`] : []))
  out.warnings.unshift(`eBay listing workbook (${table.marketplace}${table.marketplaceFrom === 'filename' ? ', market from the file name' : table.marketplaceFrom === 'hint' ? ', market chosen for the import' : ''}): populated values are reviewed against current Nexus values. Blank cells preserve data. Prices are recorded without sending them to eBay; quantities, controls and sync fields are reference only.`)
  return out
}

export async function readProductEbayWorkbook(book: ExcelJS.Workbook, productId: string, options: EbayResolveOptions = {}) {
  const table = readEbayWorkbook(book)
  return table && resolveEbayWorkbook(table, productId, options)
}

/**
 * The drawer: the rows of ONE product group, given a table the parse worker already extracted.
 *
 * Split from `readProductEbayWorkbook` so the ExcelJS workbook stays inside the parse
 * worker and only this compact table crosses back: the coordinates and specs below need
 * Prisma, which the worker is not allowed to touch
 * (`docs/2026-09-16-studio-import-wedged-production.md`).
 */
export async function resolveEbayWorkbook(table: EbayWorkbookTable, productId: string, options: EbayResolveOptions = {}) {
  const { default: prisma } = await import('../../db.js')
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) throw new Error('This product is unavailable')
  return resolveGroups(table, options, product.parentId ?? product.id)
}

/** The catalog page: every product group the file names, in one review. */
export async function resolveEbayCatalogWorkbook(table: EbayWorkbookTable, options: EbayResolveOptions & { market?: string } = {}) {
  if (options.market && options.market.toUpperCase() !== table.marketplace) throw new Error(`This workbook belongs to eBay ${table.marketplace}, not ${options.market.toUpperCase()}`)
  return resolveGroups(table, options)
}
