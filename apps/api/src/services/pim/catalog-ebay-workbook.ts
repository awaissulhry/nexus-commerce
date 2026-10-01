import ExcelJS from 'exceljs'
import type { TransferIssue, TransferRow } from '@nexus/shared/catalog-transfer'
import { ebayColumnName } from '@nexus/shared/channel-mapping'
import type { ChannelFieldSpec, ChannelSpec } from './channel-specs/types.js'
import type { SourceExclusion } from './catalog-source-mapping.js'
import { TRANSFER_MAX_ROWS } from './catalog-transfer-file.js'
import { EBAY_WORKBOOK_COLUMNS } from '../channel-mapping/defaults.js'
import { ebayChannelKeyOf, headerNames } from '../channel-mapping/ebay-draft.js'
import { ignoredReason, unmappedReason, type ReaderMapping } from '../channel-mapping/decisions.js'
// Pure modules only: the parse worker imports this file (`readEbayWorkbook`), and it must never load Prisma.
import { parseThemeAxes } from '../ebay-theme-axes.js'
import { attributeForAxis, valueIdentity, type AxisAttribute, type DictionaryAttribute } from './family-variations-core.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

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
  /** The business-policy IDs this listing holds: an imported policy ID counts only when this account already uses it. */
  policyIds?: string[]
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
/**
 * 2026-10-01 (the Owner: "simply import", one step) — the extra listings a file names by a SKU Nexus does not hold yet,
 * done by Apply before it saves the values: an extra listing without a SKU whose name is that SKU gets it (`names`); a
 * missing one is created as inert drafts (`creates`, with the file's rows for it, keyed `new:<sku>` until it exists).
 */
export interface EbayListingPlan {
  names: { aliasId: string; sku: string; rootId: string; rootSku: string; label: string; accountId: string; marketplace: string }[]
  /** `rootId` is '' for a family Apply creates first (`families`); Apply finds it by `rootSku`. */
  creates: { sku: string; rootId: string; rootSku: string; accountId: string; marketplace: string; rows: TransferRow[] }[]
  /** Phase 2 (the Owner, 2026-10-01: "import any files to then create new products based on the SKUs"). */
  families?: EbayFamilyPlan[]
  /** The main eBay listing of a family that has none on this market: Apply makes its drafts, then saves these rows. */
  mains?: EbayMainListingPlan[]
}
/**
 * A product family the file names and Nexus does not hold: Apply creates the products (DRAFT), or makes the open product
 * their parent (`adoptId`), then writes the axes and values through the one writer (`family-variations.service.ts`).
 */
export interface EbayFamilyPlan {
  rootSku: string
  /** The studio's open product, when it becomes this family's parent. Undo leaves it a parent; it never deletes it. */
  adoptId?: string
  /** A new root's name (the main parent row's Title). An adopted product keeps its own name. */
  name: string
  /** The root's `variationTheme`: the file's Variation Theme, else the axis labels. */
  theme: string
  /** Dictionary attribute codes, with the file's spelling ("Colore") as the label mirror. */
  axes: { code: string; label: string }[]
  /** `values`: attribute code → the file's value. */
  children: { sku: string; name: string; values: Record<string, string> }[]
  /** SKU → id: products an earlier, undone import put in the recycle bin. Apply brings them back instead of creating them. */
  restore: Record<string, string>
}
export interface EbayMainListingPlan { rootSku: string; rootId: string; accountId: string; marketplace: string; rows: TransferRow[] }
export const NEW_LISTING_KEY = 'new:'
/** Products an import creates carry this `importSource`: only these may be brought back from the recycle bin by an import. */
export const SHEET_IMPORT_SOURCE = 'SHEET_IMPORT'
/** What a new family is planned against: the open product's family root and the business's attribute dictionary. */
export interface EbayFamilyContext {
  open?: { id: string; sku: string; children: number }
  dictionary?: readonly DictionaryAttribute[]
}
export interface EbayWorkbookResult {
  rows: TransferRow[]; issues: TransferIssue[]; exclusions: SourceExclusion[]
  ledger: EbayLedgerEntry[]; links: EbayLink[]; warnings: string[]
  /** CHMAP — the mapping version the file was read with (`docs/studies/channel-mappings.md` §8). */
  mapping?: { setId: string; version: number; status: string; label: string; created: boolean }
  listingPlan?: EbayListingPlan
}
export interface EbayResolveOptions {
  /** Confirmed identity links: file parent SKU → Nexus parent SKU. */
  links?: Record<string, string>
  /** A delete-like `Action` marks the listing ended in Nexus only when confirmed: `true` = every delete row, a list = only
   *  the rows whose FILE SKU it names (never the resolved Nexus SKU — an alias shares it with its primary listing). */
  confirmDeletes?: boolean | readonly string[]
  /** The caller's Apply names and creates extra listings (`EbayListingPlan`): only the product sheet's Import. Elsewhere such a
   *  listing is refused by name, never dropped. */
  listingPlan?: boolean
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
/** The column name (the shared mark rule) without a trailing "(English name)". */
const aspectLabel = (header: string) => ebayColumnName(header).replace(/\s*\([^)]*\)\s*$/, '').trim()
const isCustomSpecificHeader = (header: string) => /⚠/u.test(header)
const columnName = (index: number): string => index >= 26 ? columnName(Math.floor(index / 26) - 1) + columnName(index % 26) : String.fromCharCode(65 + index)
const fold = (value: string) => value.normalize('NFD').replace(/\p{Diacritic}/gu, '').trim().toLowerCase()
const notInNexus = (market: string, parentSku: string, sku: string) => parentSku === sku
  ? `This business has no eBay ${market} listing with the SKU ${sku}.`
  : `The eBay ${market} listing ${parentSku} has no row for ${sku} in Nexus. Add the variation to the product, then import again.`
const POLICY_FIELDS = new Set(['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'])

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
export function mapEbayWorkbook(table: EbayWorkbookTable, targets: EbayWorkbookTarget[], specs: Map<string, ChannelSpec>, options: EbayResolveOptions & { notInNexus?: string; knownSkus?: ReadonlySet<string>; mapping?: ReaderMapping; mappingSpecs?: ReadonlyMap<string, ChannelSpec>; accountPolicyIds?: readonly string[] } = {}): EbayWorkbookResult {
  const out = emptyResult()
  const warned = new Set<string>()
  const value = (r: Record<string, string>, header: string) => (r[header] ?? '').trim()
  // Owner 2026-10-01 — each business is its own store: an Item ID counts only when a listing of THIS business holds it.
  // Another account's Item ID (a file exported from another business) is ignored, and the row is matched by its SKU.
  const ownItems = new Set(targets.filter(t => t.marketplace === table.marketplace && t.itemId).map(t => t.itemId))
  const foreignItems = new Set<number>()
  const items = new Map(table.records.map(({ row, values: r }) => {
    const id = value(r, 'Item ID')
    if (id && !ownItems.has(id)) foreignItems.add(row)
    return [row, id && ownItems.has(id) ? id : ''] as const
  }))
  const ownPolicies = new Set([...(options.accountPolicyIds ?? []), ...targets.flatMap(t => t.policyIds ?? [])])
  // Parent rows by SKU. A variation finds its parent by Parent SKU, and by Item ID when both rows carry one.
  const parents = new Map<string, { row: number; itemId: string; category: string; children: number }[]>()
  for (const { row, values: r } of table.records) if (value(r, 'Parent/Child').toLowerCase() === 'parent') {
    const list = parents.get(value(r, 'SKU')) ?? []
    list.push({ row, itemId: items.get(row) ?? '', category: value(r, 'Category ID'), children: 0 })
    parents.set(value(r, 'SKU'), list)
  }
  const parentFor = (parentSku: string, itemId: string) => (parents.get(parentSku) ?? []).filter(p => !itemId || !p.itemId || p.itemId === itemId)
  for (const { row, values: r } of table.records) if (value(r, 'Parent/Child').toLowerCase() === 'child') {
    const found = parentFor(value(r, 'Parent SKU'), items.get(row) ?? '')
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
    const r = record.values, sku = value(r, 'SKU'), parentage = value(r, 'Parent/Child').toLowerCase(), ownItem = items.get(record.row) ?? ''
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
    if (!candidates.length) { refuseRow('SKU', options.notInNexus ?? notInNexus(table.marketplace, parentSku, sku)); continue }
    if (candidates.length > 1) { refuseRow('Item ID', 'Several Nexus listings match this row. Add the eBay Item ID or Listing ID so it names exactly one listing.'); continue }
    const t = candidates[0]
    if (!t.accountId || !Number.isSafeInteger(t.version) || t.version < 0) { refuseRow('Item ID', 'The listing needs a verified account and record version'); continue }
    matched.push({ record, t, category, parentage, parentRow })
  }
  if (foreignItems.size) out.warnings.push(`${foreignItems.size} ${foreignItems.size === 1 ? 'row holds an eBay Item ID' : 'rows hold eBay Item IDs'} that no listing of this business has (another eBay account's listings). Nexus ignored ${foreignItems.size === 1 ? 'it' : 'them'} and matched by SKU.`)
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
      if (coordinates.has(header)) { exclude(header, header === 'Item ID' && foreignItems.has(record.row) ? 'Another eBay account\'s Item ID: ignored. This row is matched by its SKU in this business.' : 'Verified listing identity; shared product parentage and remote links are preserved'); continue }
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
      // Like an Item ID, a business policy belongs to one eBay account: another account's policy ID is never imported.
      if (POLICY_FIELDS.has(field.key) && !ownPolicies.has(raw.trim())) { exclude(header, `This policy is not one this eBay account uses (the file may come from another business). The listing keeps its own policy. File value: ${raw.trim()}`); continue }
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
    // P7 (audit 2026-10-01) — a file states the category on the parent row only, and publish reads it on every row. A listing
    // this import creates takes the parent's category on each variation row. Not ledgered: the file's cell is blank.
    const categoryField = fixedFields['Category ID']
    if (t.id.startsWith(NEW_LISTING_KEY) && parentage === 'child' && !value(r, 'Category ID') && spec.fields.some(f => f.key === categoryField))
      out.rows.push({ ...identity, entity: 'Listings', field: categoryField, value: category, source: source('Category ID') })
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
interface GroupPlan {
  rootId: string; rootSku: string; records: EbayWorkbookTable['records']; knownSkus: ReadonlySet<string>
  /** Phase 2: the family Apply creates (or makes the open product the parent of) before it saves these rows. */
  family?: EbayFamilyPlan
}
/** An extra listing the file names by a SKU Nexus does not hold: `aliasId` (no SKU yet) gets it, or one is created. */
interface ListingProposal { rootId: string; rootSku: string; aliasId?: string; label?: string }

const cell = (r: Record<string, string>, h: string) => (r[h] ?? '').trim()
const isChildRow = (r: Record<string, string>) => cell(r, 'Parent/Child').toLowerCase() === 'child'
/** The listing a row belongs to, by the file's own SKUs: a parent row's SKU, a variation row's Parent SKU. */
const fileParentOf = (r: Record<string, string>) => cell(r, 'Parent/Child').toLowerCase() === 'parent' ? cell(r, 'SKU') : cell(r, 'Parent SKU')
const outsideProduct = (fileParent: string, rootSku: string) => fileParent === rootSku
  ? `${rootSku} is another product in this business. Import this file from ${rootSku}.`
  : `${fileParent} is a listing of ${rootSku}, another product in this business. Import this file from ${rootSku}.`

/** Phase 2 — file parents that share variation SKUs are listings of ONE family. Clusters and their parents keep file order. */
export function clusterFileParents(parents: readonly string[], childrenOf: (parent: string) => readonly string[]): string[][] {
  let clusters: { parents: string[]; children: Set<string> }[] = []
  for (const parent of parents) {
    const kids = childrenOf(parent)
    const hits = clusters.filter(c => kids.some(k => c.children.has(k)))
    clusters = [...clusters.filter(c => !hits.includes(c)), { parents: [...hits.flatMap(c => c.parents), parent], children: new Set([...hits.flatMap(c => [...c.children]), ...kids]) }]
  }
  const order = (sku: string) => parents.indexOf(sku)
  return clusters.map(c => [...c.parents].sort((a, b) => order(a) - order(b))).sort((a, b) => order(a[0]) - order(b[0]))
}

/**
 * Phase 2 — the axes of a file without a Variation Theme: the item-specific columns whose values differ between one listing's
 * variations. A column that splits them exactly as another does ("Colore", "Colore specifico", "Colore esatto") is the same
 * axis written twice; the column the export marks ↕ wins, else the first. Returned in the file's column order.
 */
export function varyingColumns(headers: readonly string[], rows: readonly Record<string, string>[]): string[] {
  const specific = (h: string) => !fixedFields[h] && !coordinates.has(h) && !quantityHeaders.has(h) && !controlHeaders.has(h) && !identifierHeaders.has(h)
    && !isPriceHeader(h) && !isImageHeader(h) && h !== 'Action' && h !== EBAY_WORKBOOK_COLUMNS.weightUnitHeader
  const varying = headers.filter(specific).flatMap(h => {
    const values = rows.map(r => fold(cell(r, h)))
    if (new Set(values.filter(Boolean)).size < 2) return []
    const index = new Map<string, number>()
    return [{ h, shape: JSON.stringify(values.map(x => { if (!index.has(x)) index.set(x, index.size); return index.get(x) })) }]
  })
  const kept = new Map<string, string>()
  for (const c of [...varying.filter(c => /↕/u.test(c.h)), ...varying.filter(c => !/↕/u.test(c.h))]) if (!kept.has(c.shape)) kept.set(c.shape, c.h)
  const chosen = new Set(kept.values())
  return headers.filter(h => chosen.has(h))
}

/** The column that holds an axis the Variation Theme names: by either of its names, then as the same dimension (Color ≡ Colore). */
function axisColumn(headers: readonly string[], label: string): string | undefined {
  const find = (same: (name: string) => boolean) => headers.find(h => !fixedFields[h] && !coordinates.has(h) && headerNames(h).some(same))
  return find(name => fold(name) === fold(label)) ?? find(name => canonicalVariantAxis(name) === canonicalVariantAxis(label))
}

/** The dictionary attribute of an axis by the first of its names that finds one (the theme's word, then the column's two names). */
function axisAttribute(names: readonly string[], dictionary: readonly DictionaryAttribute[]): AxisAttribute & { name?: string } {
  let ambiguous: AxisAttribute | null = null
  for (const name of names) {
    const found = attributeForAxis(name, dictionary)
    if (found.attribute) return { ...found, name }
    if ('candidates' in found) ambiguous ??= found
  }
  return ambiguous ?? { attribute: null, reason: 'no-attribute' }
}

/**
 * Decide which Nexus product group each file listing belongs to (D4): the file parent SKU as a Nexus root → an
 * ADOPTED legacy shell's alias → a confirmed link → otherwise a PROPOSAL from its children (never applied unasked).
 * `onlyRootId` (the drawer) skips rows of other product groups instead of refusing them; the product page's Import
 * (`listingPlan`) refuses them by name, so no row is dropped.
 *
 * Phase 2 (the Owner, 2026-10-01): with `listingPlan`, a file listing whose SKUs Nexus does not hold becomes a NEW product
 * family instead of a refusal. Parents that share variation SKUs are one family; its first parent row is the product (the
 * open product instead, when it is one of them and has no variations yet), the other parents become its extra listings.
 */
export async function planEbayGroups(prisma: Pick<Db, 'product' | 'productListingAlias'>, table: EbayWorkbookTable, out: EbayWorkbookResult, options: EbayResolveOptions, onlyRootId?: string,
  listingProposals?: Map<string, ListingProposal>, context: EbayFamilyContext = {}): Promise<GroupPlan[]> {
  const v = cell
  const parentSkus = [...new Set(table.records.map(rec => fileParentOf(rec.values)).filter(Boolean))]
  const childSkus = [...new Set(table.records.filter(rec => isChildRow(rec.values)).map(rec => v(rec.values, 'SKU')).filter(Boolean))]
  const childrenOf = (parent: string) => [...new Set(table.records.filter(rec => isChildRow(rec.values) && v(rec.values, 'Parent SKU') === parent).map(rec => v(rec.values, 'SKU')).filter(Boolean))]
  const linkTargets = Object.values(options.links ?? {})
  const products = await prisma.product.findMany({ where: { sku: { in: [...new Set([...parentSkus, ...childSkus, ...linkTargets])] } }, select: { id: true, sku: true, parentId: true, productType: true, deletedAt: true, importSource: true } })
  const live = new Map(products.filter(p => !p.deletedAt).map(p => [p.sku, p]))
  // An adopted listing shell is found by its alias whatever the shell product looks like now (adoption soft-deletes it).
  const shells = products.filter(p => p.productType === 'EBAY_LISTING_SHELL')
  const aliases = products.length ? await prisma.productListingAlias.findMany({ where: { adoptedFromProductId: { in: products.map(p => p.id) }, status: 'ACTIVE' }, select: { productId: true, adoptedFromProductId: true } }) : []
  // 2026-10-01 — an extra listing named by its own SKU (ProductListingAlias.sku), unique in this business.
  const named = parentSkus.length ? await prisma.productListingAlias.findMany({ where: { sku: { in: parentSkus }, status: 'ACTIVE' }, select: { productId: true, sku: true, channel: true, marketplace: true } }) : []
  const roots = await prisma.product.findMany({ where: { id: { in: [...new Set([...products.map(p => p.parentId), ...aliases.map(a => a.productId), ...named.map(a => a.productId)].filter((id): id is string => !!id))] }, deletedAt: null }, select: { id: true, sku: true } })
  // The eBay listings of this market of every product the file's variations belong to: an extra listing without a SKU is
  // found by its label, once, so the Owner can give it the file's SKU.
  const familyAliases = roots.length ? await prisma.productListingAlias.findMany({ where: { productId: { in: roots.map(r => r.id) }, channel: 'EBAY', marketplace: table.marketplace, status: 'ACTIVE' },
    select: { id: true, productId: true, sku: true, label: true, adoptedFromProductId: true } }) : []
  const rootById = new Map(roots.map(r => [r.id, r.sku]))
  const decision = new Map<string, { rootId: string; rootSku: string } | { refuse: string } | { skip: string }>()
  /** Phase 2: file parents Nexus does not hold (or the open product without variations), planned as new families below. */
  const fresh: string[] = []
  const outside = (fileParent: string, rootSku: string) => options.listingPlan ? { refuse: outsideProduct(fileParent, rootSku) } : { skip: 'Outside this product; use Catalog import' }
  for (const fileParent of parentSkus) {
    const own = live.get(fileParent)
    // A LIVE shell not adopted yet; a deleted one that no alias adopted is gone, and the file SKU is free for a listing.
    const shell = shells.find(s => s.sku === fileParent && !s.deletedAt)
    const linked = options.links?.[fileParent] ? live.get(options.links[fileParent]) : undefined
    // 0. An extra listing whose own SKU this is (2026-10-01).
    const ownSku = named.find(a => a.sku === fileParent && rootById.has(a.productId))
    if (ownSku && (ownSku.channel !== 'EBAY' || ownSku.marketplace !== table.marketplace)) { decision.set(fileParent, { refuse: `${fileParent} is the SKU of a listing on ${ownSku.channel === 'EBAY' ? 'eBay' : ownSku.channel} ${ownSku.marketplace}, not on eBay ${table.marketplace}.` }); continue }
    // 1. An ADOPTED shell: its SKU names its alias directly (production GALE since 09-15). Never a proposal.
    const adopted = aliases.find(a => products.some(p => p.id === a.adoptedFromProductId && p.sku === fileParent) && rootById.has(a.productId))
    let root: { rootId: string; rootSku: string } | null = null
    if (ownSku) root = { rootId: ownSku.productId, rootSku: rootById.get(ownSku.productId)! }
    else if (adopted) root = { rootId: adopted.productId, rootSku: rootById.get(adopted.productId)! }
    else if (own && own.productType !== 'EBAY_LISTING_SHELL' && !own.parentId) root = { rootId: own.id, rootSku: own.sku }
    else if (shell) { decision.set(fileParent, { refuse: `${fileParent} is an old eBay listing record that is not attached to its product yet, so Nexus cannot tell which listing it is. Nothing is imported for it.` }); continue }
    else if (linked && !linked.parentId && linked.productType !== 'EBAY_LISTING_SHELL') root = { rootId: linked.id, rootSku: linked.sku }
    if (!root) {
      const children = table.records.filter(rec => isChildRow(rec.values) && v(rec.values, 'Parent SKU') === fileParent).map(rec => v(rec.values, 'SKU'))
      const known = children.map(sku => live.get(sku)).filter((p): p is NonNullable<typeof p> => !!p && !!p.parentId)
      const parentIds = [...new Set(known.map(p => p.parentId!))]
      if (parentIds.length === 1 && rootById.has(parentIds[0])) {
        const proposedSku = rootById.get(parentIds[0])!
        // 2026-10-01 — another listing of that product: the file also holds its main listing, or one of its extra listings
        // without a SKU carries this name. The Owner confirms; Nexus then names that listing, or creates it, with this SKU.
        const unnamed = familyAliases.find(a => a.productId === parentIds[0] && !a.sku && !a.adoptedFromProductId && a.label.trim() === fileParent)
        if (unnamed || parentSkus.includes(proposedSku)) {
          // The file decides (the Owner, 2026-10-01): Apply names that listing, or creates it, then saves its values.
          if (onlyRootId && onlyRootId !== parentIds[0]) { decision.set(fileParent, outside(fileParent, proposedSku)); continue }
          if (!options.listingPlan) { decision.set(fileParent, { refuse: `This business has no eBay ${table.marketplace} listing with the SKU ${fileParent} yet. Import this file with the Import button of product ${proposedSku}: it names or creates the listing.` }); continue }
          listingProposals?.set(fileParent, { rootId: parentIds[0], rootSku: proposedSku, aliasId: unnamed?.id, label: unnamed?.label })
          decision.set(fileParent, { rootId: parentIds[0], rootSku: proposedSku })
          continue
        }
        // Phase 2 — on the product page, a listing that shares a few variation SKUs with another product is a new family (those
        // SKUs are named problems), never a link to a product this page cannot import into.
        if (options.listingPlan && onlyRootId && onlyRootId !== parentIds[0]) { fresh.push(fileParent); continue }
        out.links.push({ fileSku: fileParent, proposedSku, reason: `${known.length} of ${new Set(children).size} variation SKUs under eBay parent ${fileParent} belong to Nexus product ${proposedSku}` })
        decision.set(fileParent, { refuse: `Link eBay parent ${fileParent} to Nexus product ${proposedSku}? Confirm the link to import this listing.` })
      } else if (options.listingPlan && !parentIds.length) fresh.push(fileParent)
      else decision.set(fileParent, { refuse: parentIds.length > 1 ? `The variations under eBay parent ${fileParent} belong to several Nexus products; this listing cannot be placed.` : `eBay parent ${fileParent} is not a Nexus product, and none of its variation SKUs is. Create the product first, or link the parent.` })
      continue
    }
    // Phase 2 — the open product without variations becomes the parent of the family its file listing describes.
    if (options.listingPlan && root.rootSku === fileParent && root.rootId === context.open?.id && !context.open.children && childrenOf(fileParent).length) { fresh.push(fileParent); continue }
    if (onlyRootId && root.rootId !== onlyRootId) { decision.set(fileParent, outside(fileParent, root.rootSku)); continue }
    decision.set(fileParent, root)
  }

  // ── Phase 2: new families ─────────────────────────────────────────────────────────────────────
  const decided = new Set<number>()
  const refuseRows = (records: EbayWorkbookTable['records'], field: string, message: string) => {
    for (const record of records) if (!decided.has(record.row)) { decided.add(record.row); decideRecord(out, table, record, 'refused', field, message) }
  }
  const familyOf = new Map<string, { key: string; rootId: string; rootSku: string; family: EbayFamilyPlan }>()
  const dictionary = context.dictionary ?? []
  for (const cluster of fresh.length ? clusterFileParents(parentSkus, childrenOf) : []) {
    const parents = cluster.filter(p => fresh.includes(p))
    if (!parents.length) continue
    const records = table.records.filter(rec => parents.includes(fileParentOf(rec.values)))
    // A listing that shares its variations with one Nexus already places (or refuses) belongs with it, never in a new family.
    const placed = cluster.find(p => !fresh.includes(p))
    if (placed) {
      const d = decision.get(placed)
      refuseRows(records, 'Parent SKU', d && 'rootId' in d
        ? `${parents.join(', ')} ${parents.length === 1 ? 'lists' : 'list'} variations that ${d.rootSku} does not have in Nexus. Add the variations to ${d.rootSku}, then import again.`
        : `${parents.join(', ')} ${parents.length === 1 ? 'lists' : 'list'} the same variations as ${placed}, which this import cannot place (see the rows of ${placed}).`)
      continue
    }
    const adopt = context.open && parents.some(p => live.get(p)?.id === context.open!.id) ? context.open : undefined
    const rootSku = adopt?.sku ?? parents[0]
    const rootRecords = records.filter(rec => fileParentOf(rec.values) === rootSku)
    const rootName = cell(rootRecords.find(rec => !isChildRow(rec.values))?.values ?? {}, 'Title') || rootSku
    const restore: Record<string, string> = {}
    /** A SKU held by a product in the recycle bin: one an earlier import made comes back; any other is the Owner's to decide. */
    const binned = (sku: string) => {
      const gone = live.has(sku) ? undefined : products.find(p => p.sku === sku && p.deletedAt)
      if (!gone) return ''
      if (gone.importSource === SHEET_IMPORT_SOURCE) { restore[sku] = gone.id; return '' }
      return `${sku} is in the recycle bin. Restore it, or delete it for good, then import again.`
    }
    const own = live.get(rootSku)
    // A SKU the file also lists as a variation would be made twice.
    const twice = (sku: string) => childSkus.includes(sku) ? `${sku} is both a listing and a variation in this file. Keep one of them, then import again.` : ''
    const rootProblem = adopt ? twice(rootSku) : own ? `${rootSku} is a variation of ${rootById.get(own.parentId ?? '') ?? 'another product'} in this business. A new product family cannot take its SKU.` : twice(rootSku) || binned(rootSku)
    if (rootProblem) { refuseRows(records, 'SKU', rootProblem); continue }
    // Its other listings get their own SKUs: never a product's SKU, never another listing's.
    const listings = parents.filter(p => p !== rootSku).filter(p => {
      const problem = live.has(p) ? `${p} is a product SKU in this business, so it cannot name a listing of ${rootSku}. Change the SKU in the file, then import again.`
        : named.some(a => a.sku === p) ? `${p} is already the SKU of another listing in this business. Change the SKU in the file, then import again.` : twice(p)
      if (problem) refuseRows(records.filter(rec => fileParentOf(rec.values) === p), 'SKU', problem)
      return !problem
    })
    // The variations: every child SKU of the family's listings, once, in file order.
    const kids = [...new Set(parents.flatMap(childrenOf))]
    const childRows = (sku: string) => records.filter(rec => isChildRow(rec.values) && v(rec.values, 'SKU') === sku)
    const rowOf = (sku: string) => (childRows(sku).find(rec => fileParentOf(rec.values) === rootSku) ?? childRows(sku)[0]).values
    // The axes: the file's Variation Theme, else the columns whose values differ between the main listing's variations.
    const theme = records.map(rec => v(rec.values, 'Variation Theme')).find(Boolean) ?? ''
    const sample = rootRecords.filter(rec => isChildRow(rec.values)).map(rec => rec.values)
    const wanted = !kids.length ? [] : theme ? parseThemeAxes(theme).map(label => ({ label, column: axisColumn(table.headers, label) }))
      : varyingColumns(table.headers, sample.length ? sample : kids.map(rowOf)).map(column => ({ label: aspectLabel(column), column }))
    const axes: { code: string; label: string; column: string; attribute: DictionaryAttribute }[] = []
    let familyProblem = kids.length && !wanted.length ? `The file does not say how the variations of ${rootSku} differ. Add a Variation Theme column (for example "Colore,Taglia"), then import again.` : ''
    for (const axis of familyProblem ? [] : wanted) {
      if (!axis.column) { familyProblem = `The Variation Theme names ${axis.label}, but the file has no ${axis.label} column. Add the column, then import again.`; break }
      const found = axisAttribute([axis.label, ...headerNames(axis.column)], dictionary)
      if (!found.attribute) {
        familyProblem = 'candidates' in found ? `The axis ${axis.label} matches several attributes (${found.candidates.join(', ')}). Keep one of them in Settings › Attributes, then import again.`
          : `Nexus has no attribute for the axis ${axis.label}. Add it in Settings › Attributes, then import again.`
        break
      }
      const twin = axes.find(a => a.code === found.attribute!.code)
      if (twin) { familyProblem = `${twin.label} and ${axis.label} are the same attribute (${twin.attribute.label}). Keep one of them in the Variation Theme, then import again.`; break }
      // The label names the attribute (the writer checks that), so it is the name that found it.
      axes.push({ code: found.attribute.code, label: found.name ?? axis.label, column: axis.column, attribute: found.attribute })
    }
    if (familyProblem) { refuseRows(records, 'Variation Theme', familyProblem); continue }
    const children: EbayFamilyPlan['children'] = []
    const childProblems = new Map<string, string>()
    /** The other families whose variations the file lists. */
    const elsewhere = new Set<string>()
    for (const sku of kids) {
      const existing = live.get(sku)
      if (existing?.parentId) elsewhere.add(rootById.get(existing.parentId) ?? 'another product')
      const problem = parentSkus.includes(sku) ? `${sku} is both a listing and a variation in this file. Keep one of them, then import again.`
        : existing?.parentId ? `${sku} is already a variation of ${rootById.get(existing.parentId) ?? 'another product'}. Nexus never moves a product to another family; nothing is imported for it.`
        : existing ? `${sku} is already a product in this business. Nexus does not make it a variation of ${rootSku}; nothing is imported for it.`
        : binned(sku)
      if (problem) { childProblems.set(sku, problem); continue }
      const row = rowOf(sku)
      const values = Object.fromEntries(axes.map(a => [a.code, v(row, a.column)]))
      const missing = axes.filter(a => !values[a.code])
      if (missing.length) { childProblems.set(sku, `${sku} has no ${missing.map(a => a.label).join(' or ')} in the file. Every variation needs a value for each axis.`); continue }
      children.push({ sku, name: v(row, 'Title') || `${rootName} (${axes.map(a => values[a.code]).join(', ')})`, values })
    }
    // Two variations with the same values cannot both be sold: each is refused, by name.
    const combos = new Map<string, string[]>()
    for (const c of children) { const key = JSON.stringify(axes.map(a => valueIdentity(c.values[a.code], a.attribute))); combos.set(key, [...(combos.get(key) ?? []), c.sku]) }
    for (const skus of combos.values()) if (skus.length > 1) for (const sku of skus) childProblems.set(sku, `${skus.join(' and ')} have the same ${axes.map(a => a.label).join(' and ')}. Give each variation its own values, then import again.`)
    const kept = children.filter(c => !childProblems.has(c.sku))
    // A listing of another product's variations belongs to that product: one sentence on every row says where to import it.
    const [other] = elsewhere
    if (kids.length && elsewhere.size === 1 && kids.every(sku => live.get(sku)?.parentId)) {
      refuseRows(records, 'Parent SKU', `${parents.join(', ')} ${parents.length === 1 ? 'lists' : 'list'} the variations of ${other}, another product in this business. Import this file from ${other}.`)
      continue
    }
    for (const [sku, problem] of childProblems) refuseRows(childRows(sku), 'SKU', problem)
    if (kids.length && !kept.length) { refuseRows(records, 'Parent SKU', `None of the variations of ${rootSku} can be created; their rows say why.`); continue }
    const family: EbayFamilyPlan = { rootSku, ...(adopt ? { adoptId: adopt.id } : {}), name: rootName, theme: kept.length ? theme || axes.map(a => a.label).join(',') : '',
      axes: axes.map(({ code, label }) => ({ code, label })), children: kept, restore: Object.fromEntries(Object.entries(restore).filter(([sku]) => sku === rootSku || kept.some(c => c.sku === sku))) }
    const placement = { key: adopt?.id ?? `${NEW_LISTING_KEY}${rootSku}`, rootId: adopt?.id ?? '', rootSku, family }
    for (const p of [rootSku, ...listings]) familyOf.set(p, placement)
    for (const p of listings) listingProposals?.set(p, { rootId: placement.rootId, rootSku })
  }

  const groups = new Map<string, GroupPlan>()
  for (const record of table.records) {
    if (decided.has(record.row)) continue
    const fileParent = fileParentOf(record.values)
    const placed = familyOf.get(fileParent)
    const d = placed ?? (fileParent ? decision.get(fileParent) : { refuse: 'A variation row needs its Parent SKU' })
    if (!d) { decideRecord(out, table, record, 'refused', 'Parent SKU', 'A variation row needs its Parent SKU'); continue }
    if ('refuse' in d) { decideRecord(out, table, record, 'refused', 'Parent SKU', d.refuse); continue }
    if ('skip' in d) { decideRecord(out, table, record, 'skipped-row', 'Parent SKU', d.skip); continue }
    const key = placed?.key ?? d.rootId
    const group = groups.get(key) ?? { rootId: d.rootId, rootSku: d.rootSku, records: [], knownSkus: new Set(live.keys()), ...(placed ? { family: placed.family } : {}) }
    // A linked parent is matched under its Nexus SKU; the file's own SKU travels with the row.
    const isParent = v(record.values, 'Parent/Child').toLowerCase() === 'parent'
    group.records.push(fileParent === d.rootSku || !options.links?.[fileParent] ? record : {
      ...record, fileSku: v(record.values, 'SKU'), fileParentSku: fileParent,
      values: { ...record.values, ...(isParent ? { SKU: d.rootSku } : { 'Parent SKU': d.rootSku }) },
    })
    groups.set(key, group)
  }
  return [...groups.values()]
}

/** Every eBay listing of one product group as a verified target (primary and adopted aliases). CHMAP: the export reads it too. */
export async function groupTargets(prisma: Db, table: EbayWorkbookTable, rootId: string, options: { unnamedByLabel?: boolean; pendingNames?: ReadonlyMap<string, string> } = {}) {
  const { productTransferOptions } = await import('./catalog-product-transfer.js')
  const transfer = await productTransferOptions(rootId), productById = new Map(transfer.products.map(p => [p.id, p]))
  const selected = transfer.listings.filter(l => l.channel === 'EBAY' && l.marketplace === table.marketplace)
  const [listings, aliases] = await Promise.all([
    prisma.channelListing.findMany({ where: { id: { in: selected.map(l => l.id) } }, select: { id: true, productId: true, externalListingId: true, version: true, platformAttributes: true } }),
    prisma.productListingAlias.findMany({ where: { id: { in: selected.map(l => l.aliasKey).filter(Boolean) } }, select: { id: true, adoptedFromProductId: true, sku: true, label: true } }),
  ])
  const shells = await prisma.product.findMany({ where: { id: { in: aliases.map(a => a.adoptedFromProductId).filter((id): id is string => !!id) } }, select: { id: true, sku: true } })
  const rootSku = productById.get(transfer.rootId)!.sku
  return listings.flatMap((l): EbayWorkbookTarget[] => {
    const coordinate = selected.find(s => s.id === l.id)!, product = productById.get(l.productId)!
    const alias = aliases.find(a => a.id === coordinate.aliasKey)
    // A file names a listing by SKU: the main listing by the product's, an extra listing by its own (2026-10-01), else by its
    // adopted shell's. An extra listing with neither has no name in a file — the export may write its label, which the
    // import then offers to make its SKU.
    const sourceParentSku = !coordinate.aliasKey ? rootSku
      : alias?.sku || options.pendingNames?.get(alias?.id ?? '') || (alias?.adoptedFromProductId ? shells.find(s => s.id === alias.adoptedFromProductId)?.sku : undefined)
        || (options.unnamedByLabel ? alias?.label.trim() : undefined)
    if (!sourceParentSku) return []
    const attributes = (l.platformAttributes ?? {}) as { itemSpecifics?: Record<string, unknown> } & Record<string, unknown>
    const specifics = attributes.itemSpecifics
    const policyIds = ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId'].map(key => attributes[key]).filter((id): id is string => typeof id === 'string' && !!id.trim())
    return [{ ...coordinate, sku: product.sku, parentSku: rootSku, sourceParentSku, isParent: product.id === transfer.rootId, itemId: l.externalListingId ?? '', version: l.version, specificNames: specifics && typeof specifics === 'object' ? Object.keys(specifics) : [], policyIds }]
  })
}

/**
 * The eBay account a new listing of this family goes on: the account of the family's own eBay listing (the main one
 * first), else the business's PRIMARY active eBay account. With several accounts and no primary, nothing is guessed:
 * the review names the problem.
 */
export async function ebayAccountFor(prisma: Pick<Db, 'channelListing'>, rootId: string): Promise<{ id: string } | { problem: string }> {
  const { AmbiguousConnectionError, chooseConnection, listActiveConnections } = await import('../connection-resolver.service.js')
  const active = await listActiveConnections('EBAY')
  if (rootId && active.length) {
    const listings = await prisma.channelListing.findMany({ where: { productId: rootId, channel: 'EBAY', channelConnectionId: { in: active.map(a => a.id) } }, select: { channelConnectionId: true, aliasKey: true }, orderBy: { createdAt: 'asc' } })
    const own = listings.find(l => !l.aliasKey) ?? listings[0]
    if (own?.channelConnectionId) return { id: own.channelConnectionId }
  }
  try { return { id: chooseConnection(active, { channel: 'EBAY', wantPrimary: true }).id } } catch (error) {
    return { problem: error instanceof AmbiguousConnectionError
      ? 'Several eBay accounts are connected and none is the primary one. Make one primary in Settings › Channels, then import again.'
      : 'Connect an eBay account in Settings › Channels, then import again: Nexus creates the listings of this file on it.' }
  }
}

/** The policy IDs this business's eBay accounts use by default (`connectionMetadata.ebayPolicies`). */
async function accountPolicyIds(prisma: Db, targets: EbayWorkbookTarget[]): Promise<string[]> {
  const accounts = [...new Set(targets.map(t => t.accountId).filter(Boolean))]
  if (!accounts.length) return []
  const connections = await prisma.channelConnection.findMany({ where: { id: { in: accounts } }, select: { connectionMetadata: true } })
  return connections.flatMap(c => Object.values(((c.connectionMetadata ?? {}) as { ebayPolicies?: Record<string, unknown> }).ebayPolicies ?? {}))
    .filter((id): id is string => typeof id === 'string' && !!id.trim())
}

async function resolveGroups(table: EbayWorkbookTable, options: EbayResolveOptions, onlyRootId?: string, context: EbayFamilyContext = {}): Promise<EbayWorkbookResult> {
  const [{ default: prisma }, { loadEbaySpec }] = await Promise.all([import('../../db.js'), import('./channel-specs/index.js')])
  const out = emptyResult()
  const plan: EbayListingPlan = { names: [], creates: [], families: [], mains: [] }
  const proposals = new Map<string, ListingProposal>()
  // CHMAP M2 — one mapping version for the whole file: its columns against every category it names.
  const fileSpecs = new Map<string, ChannelSpec>()
  for (const category of new Set(table.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))) fileSpecs.set(category, await loadEbaySpec(table.marketplace, [category]))
  const { ebayImportMapping } = await import('../channel-mapping/ebay-import.js')
  let chmap: Awaited<ReturnType<typeof ebayImportMapping>> | null = null, mappingProblem = ''
  try { chmap = await ebayImportMapping(table, fileSpecs) } catch (error) { mappingProblem = error instanceof Error ? error.message : String(error) }
  for (const group of await planEbayGroups(prisma, table, out, options, onlyRootId, proposals, context)) {
    const sub: EbayWorkbookTable = { ...table, records: group.records }
    const family = group.family
    const mine = [...proposals].filter(([, p]) => p.rootId === group.rootId && p.rootSku === group.rootSku)
    const pendingNames = new Map(mine.filter(([, p]) => p.aliasId).map(([sku, p]) => [p.aliasId!, sku]))
    // A family Apply creates has no listing yet; an adopted product may have its own.
    const named = group.rootId ? await groupTargets(prisma, sub, group.rootId, { pendingNames }) : []
    // A listing to create is matched against what it will be: one draft row per live product of the family.
    const creating = mine.filter(([, p]) => !p.aliasId)
    // Phase 2 — the main listing, when the file holds it and this market has none (only the product page's Import makes it).
    const mainMissing = !!options.listingPlan && sub.records.some(r => fileParentOf(r.values) === group.rootSku) && (!!family || !named.some(t => !t.aliasKey))
    const known = named.find(t => !t.aliasKey)?.accountId || named[0]?.accountId
    const choice = creating.length || mainMissing ? known ? { id: known } : await ebayAccountFor(prisma, group.rootId) : null
    // A new family is created for its eBay listings: without an account to put them on, nothing of it is created.
    if (family && choice && 'problem' in choice) { for (const record of sub.records) decideRecord(out, table, record, 'refused', 'Parent SKU', choice.problem); continue }
    const account = choice && 'id' in choice ? choice.id : ''
    const members = !account ? [] : family ? [{ sku: family.rootSku, isParent: true }, ...family.children.map(c => ({ sku: c.sku, isParent: false }))]
      : (await prisma.product.findMany({ where: { OR: [{ id: group.rootId }, { parentId: group.rootId }], deletedAt: null }, select: { id: true, sku: true } })).map(p => ({ sku: p.sku, isParent: p.id === group.rootId }))
    const virtualTarget = (id: string, product: { sku: string; isParent: boolean }, sourceParentSku: string, aliasKey: string): EbayWorkbookTarget => ({ id, sku: product.sku, parentSku: group.rootSku, sourceParentSku,
      isParent: product.isParent, itemId: '', accountId: account, marketplace: table.marketplace, aliasKey, version: 0, specificNames: [], policyIds: [] })
    const virtual = creating.flatMap(([sku]) => members.map(p => virtualTarget(`${NEW_LISTING_KEY}${sku}:${p.sku}`, p, sku, `${NEW_LISTING_KEY}${sku}`)))
    // The main listing's drafts: every product without a main row on this market (an adopted product keeps its own).
    const mainSkus = new Set(mainMissing ? members.filter(p => !named.some(t => !t.aliasKey && t.sku === p.sku)).map(p => p.sku) : [])
    const mains = members.filter(p => mainSkus.has(p.sku)).map(p => virtualTarget(`${NEW_LISTING_KEY}main:${p.sku}`, p, group.rootSku, ''))
    const targets = [...named, ...virtual, ...mains]
    const specs = new Map<string, ChannelSpec>()
    const categories = new Set(sub.records.map(r => r.values['Category ID']?.trim()).filter(Boolean))
    for (const category of categories) specs.set(category, fileSpecs.get(category) ?? await loadEbaySpec(table.marketplace, [category]))
    const mapped = mapEbayWorkbook(sub, targets, specs, { ...options, knownSkus: group.knownSkus, accountPolicyIds: await accountPolicyIds(prisma, targets), ...(chmap?.mapping ? { mapping: chmap.mapping, mappingSpecs: fileSpecs } : {}) })
    const problem = choice && 'problem' in choice ? choice.problem : ''
    for (const [sku, p] of mine) {
      if (p.aliasId) { const t = named.find(n => n.aliasKey === p.aliasId); if (t) plan.names.push({ aliasId: p.aliasId, sku, rootId: p.rootId, rootSku: p.rootSku, label: p.label ?? sku, accountId: t.accountId, marketplace: t.marketplace }); continue }
      if (!account) { out.issues.push({ row: 0, sku, field: 'Parent SKU', message: `The eBay ${table.marketplace} listing ${sku} cannot be created. ${problem}` }); continue }
      const rows = mapped.rows.filter(r => r.aliasKey === `${NEW_LISTING_KEY}${sku}`)
      if (rows.length) plan.creates.push({ sku, rootId: p.rootId, rootSku: p.rootSku, accountId: account, marketplace: table.marketplace, rows })
    }
    if (mainMissing && !account) out.issues.push({ row: 0, sku: group.rootSku, field: 'Parent SKU', message: `The eBay ${table.marketplace} listing ${group.rootSku} cannot be created. ${problem}` })
    if (mains.length) plan.mains!.push({ rootSku: group.rootSku, rootId: group.rootId, accountId: account, marketplace: table.marketplace, rows: mapped.rows.filter(r => !r.aliasKey && mainSkus.has(r.sku)) })
    if (family) plan.families!.push(family)
    mapped.rows = mapped.rows.filter(r => !r.aliasKey.startsWith(NEW_LISTING_KEY) && !(!r.aliasKey && mainSkus.has(r.sku)))
    out.rows.push(...mapped.rows); out.issues.push(...mapped.issues); out.exclusions.push(...mapped.exclusions)
    out.ledger.push(...mapped.ledger); out.warnings.push(...mapped.warnings)
  }
  if (chmap?.info) {
    out.mapping = chmap.info
    const { recordUse } = await import('../channel-mapping/store.js')
    await recordUse(chmap.info.setId, 'IMPORT', table.sheet, { rows: out.rows.length, excluded: out.exclusions.length, refused: out.issues.length })
  }
  out.warnings.unshift(...(chmap?.info ? [`Read with the mapping ${chmap.info.label}.`] : []), ...(chmap?.warnings ?? []), ...(mappingProblem ? [`The mapping versions could not be read (${mappingProblem}); this file was read with the built-in rules only, and no Owner decision was applied.`] : []))
  if (plan.names.length || plan.creates.length || plan.families!.length || plan.mains!.length) out.listingPlan = plan
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
  const rootId = product.parentId ?? product.id
  // Phase 2 — the product page's Import may create families: it needs the open family's root and the attribute dictionary.
  const context: EbayFamilyContext = {}
  if (options.listingPlan) {
    const [root, children, { variationDictionary }] = await Promise.all([prisma.product.findFirst({ where: { id: rootId, deletedAt: null }, select: { id: true, sku: true } }),
      prisma.product.count({ where: { parentId: rootId, deletedAt: null } }), import('./family-variations.service.js')])
    if (root) context.open = { ...root, children }
    context.dictionary = await variationDictionary()
  }
  return resolveGroups(table, options, rootId, context)
}

/** The catalog page: every product group the file names, in one review. */
export async function resolveEbayCatalogWorkbook(table: EbayWorkbookTable, options: EbayResolveOptions & { market?: string } = {}) {
  if (options.market && options.market.toUpperCase() !== table.marketplace) throw new Error(`This workbook belongs to eBay ${table.marketplace}, not ${options.market.toUpperCase()}`)
  return resolveGroups(table, options)
}
