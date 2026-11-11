import type { BusinessDate } from '../core/time'

/**
 * Number series (plan A1 §2.3 NumberSeries, §3.9; PLAN §2.8; features PLT-122, PLT-123). A series hands out the
 * numbers of one kind of document for one company: `kind` + `code` (the sezionale: `MAIN`, `A`, `B`…) name the series,
 * and its counter runs per period, the calendar year for a series that resets yearly. The database keeps one row per
 * company, kind, code and period (`scopeKey`); apps/factory-api's allocateNumber takes the next number inside the
 * issuing command's transaction.
 */

/** What a series numbers. New kinds are additive (the Prisma enum NumberKind lists the same values). */
export const NUMBER_KINDS = [
  'QUOTE',
  'SALES_ORDER',
  'PURCHASE_ORDER',
  'GOODS_RECEIPT',
  'WORK_ORDER',
  'SHIPMENT',
  'DDT',
  'INVOICE',
  'DEPOSIT_INVOICE',
  'CREDIT_NOTE',
  'RETURN',
  'LOT',
  'BATCH',
  // W2b-2 wave 13/16 (factory-db numbering.prisma): cut orders (CO-…) and cut tickets (CT-…), office document kinds.
  'CUT_ORDER',
  'CUT_TICKET',
  'PPE_REGISTER',
  'BUNDLE',
  'HIDE',
  'GARMENT_SERIAL',
  'INSPECTION',
  'RELEASE',
  'REPAIR',
  'COMPLAINT',
  // W2a wave 3 (factory-db numbering.prisma): supplier claims (CLM-…) and subcontract orders (SC-…).
  'CLAIM',
  'SUBCONTRACT',
  // W2b wave 22/22 (factory-db numbering.prisma): a supplier's ship notice (ASN-…), numbered when it is sent.
  'ASN',
  // W2a wave 4 (factory-db numbering.prisma): stock counts and the year-end inventory (CNT-…).
  'COUNT',
  // W2a wave 6 (factory-db numbering.prisma): nonconformance reports (NCR-…) and maintenance jobs (MJ-…).
  'NCR',
  'MAINTENANCE_JOB',
  // W2b wave 11/16 (factory-db numbering.prisma): CAPAs and 8Ds (CAPA-…).
  'CAPA',
  // W2a wave 7 (factory-db numbering.prisma): accounting export batches (EXP-…).
  'ACCOUNTING_EXPORT',
  // W2b wave 2 (factory-db numbering.prisma): quality holds (HLD-…).
  'HOLD',
  // W2b wave 10/16 (factory-db numbering.prisma): incoming inspections (IIN-…).
  'INCOMING_INSPECTION',
  // W2b wave 16/16 (factory-db numbering.prisma): incidents, near misses and hazards (INC-…).
  'INCIDENT',
  // W2b wave 6 (factory-db numbering.prisma): payroll exports for the labour consultant (PAY-…).
  'PAYROLL_EXPORT',
  // W2b wave 21/22 (factory-db numbering.prisma): a customer's order request sent from the portal (RQ-…).
  'PORTAL_REQUEST',
  // W2b-4 wave 25/33 (factory-db numbering.prisma): a work instruction (WI-…), an office document kind.
  'WORK_INSTRUCTION',
  // W2b-4 wave 29/33 (factory-db numbering.prisma): a change request (CR-…), a change order (ECO-…), a sample round (SR-…),
  // office document kinds.
  'CHANGE_REQUEST',
  'CHANGE_ORDER',
  'SAMPLE_ROUND',
  // W2b-4 wave 31/33 (factory-db numbering.prisma): a declaration asked of a supplier (SD-…), an office document kind.
  'SUPPLIER_DECLARATION',
  // W2b-4 wave 32/33 (factory-db numbering.prisma): a technical file (TF-…) and an evidence pack (EP-…), office document kinds.
  'TECHNICAL_FILE',
  'EVIDENCE_PACK',
  // W2b-4 wave 33/33 (factory-db numbering.prisma): a recall or withdrawal (RCL-…) and an authority's request (AR-…), office
  // document kinds.
  'RECALL',
  'AUTHORITY_REQUEST',
  // W2b-5 wave 37/44 (factory-db numbering.prisma): an inquiry or RFQ (INQ-…), an office document kind.
  'INQUIRY',
  // W2b-2 wave 8 (factory-db numbering.prisma): a bundle's coupon for one operation (CP-…), a scan-id kind.
  'COUPON',
  // W2b-2 wave 12 (factory-db numbering.prisma): a fabric roll's tag (RL-…) and a remnant's tag (RM-…), scan-id kinds.
  'ROLL',
  'REMNANT',
] as const
export type NumberKind = (typeof NUMBER_KINDS)[number]

/**
 * The scan-id kinds: what a floor tablet numbers, offline too, as scannable ids (`BN-…`, `HD-…`, `SN-…`, `CP-…`, `RL-…`, `RM-…`; numbering/scan-id).
 * They are NOT document series: no company, sezionale, pattern or period, and a gap is fine (a ticket printed and
 * thrown away). The rule is that a reference is handed out once per tenant: the scan id carries only the tenant's tag,
 * so ONE tenant-wide counter per kind, kept as the tenant's ledger of number blocks (numbering/blocks; factory-db
 * NumberBlock). allocateNumber refuses them; apps/factory-api's allocateScanIds hands them out.
 */
export const SCAN_ID_KINDS = ['BUNDLE', 'HIDE', 'GARMENT_SERIAL', 'COUPON', 'ROLL', 'REMNANT'] as const satisfies readonly NumberKind[]
export type ScanIdKind = (typeof SCAN_ID_KINDS)[number]

/** The document kinds: a company's series with a pattern and a period (allocateNumber; factory-db NumberSeries). */
export const DOCUMENT_KINDS = NUMBER_KINDS.filter((kind): kind is DocumentKind => !(SCAN_ID_KINDS as readonly string[]).includes(kind)) as readonly DocumentKind[] as readonly [DocumentKind, ...DocumentKind[]]
export type DocumentKind = Exclude<NumberKind, ScanIdKind>

export function isScanIdKind(value: unknown): value is ScanIdKind {
  return typeof value === 'string' && (SCAN_ID_KINDS as readonly string[]).includes(value)
}

export function isDocumentKind(value: unknown): value is DocumentKind {
  return isNumberKind(value) && !isScanIdKind(value)
}

/**
 * The fiscal documents: progressive numbering with no gap and never the same number twice (DPR 633/1972 art. 21 c.2
 * for invoices, credit notes and deposit invoices; DPR 472/1996 for the DDT). A fiscal series also refuses a document
 * dated before its last number's date, and keeps every number within FatturaPA's 20 characters.
 */
export const FISCAL_KINDS: readonly NumberKind[] = ['DDT', 'INVOICE', 'DEPOSIT_INVOICE', 'CREDIT_NOTE']

export function isNumberKind(value: unknown): value is NumberKind {
  return typeof value === 'string' && (NUMBER_KINDS as readonly string[]).includes(value)
}

export function isFiscalKind(kind: NumberKind): boolean {
  return FISCAL_KINDS.includes(kind)
}

/**
 * The document kinds a floor tablet may number from its own command, online (goods received at the dock, their lots, a
 * final inspection opened at the bench and its release; W2b: a hold placed, an NCR raised and an incoming inspection opened
 * at the bench, an incident reported from a tablet): the company's series of its site, the same gapless series the office numbers from. Never a fiscal kind: invoices, credit notes, deposit invoices and DDTs stay with the office. The
 * database holds the same list (factory-db ownership/numbering.json: the floor's policies see and write only the series
 * and numbers of these kinds; the …_numbering_floor_documents_guards triggers refuse a fiscal series to the floor).
 */
export const FLOOR_DOCUMENT_KINDS = ['GOODS_RECEIPT', 'LOT', 'INSPECTION', 'RELEASE', 'HOLD', 'NCR', 'INCOMING_INSPECTION', 'INCIDENT'] as const satisfies readonly DocumentKind[]
export type FloorDocumentKind = (typeof FLOOR_DOCUMENT_KINDS)[number]

export function isFloorDocumentKind(value: unknown): value is FloorDocumentKind {
  return typeof value === 'string' && (FLOOR_DOCUMENT_KINDS as readonly string[]).includes(value)
}

/** The kind in words, for messages: `invoice`, `DDT`, `purchase order`, `PPE register`. */
export function kindLabel(kind: NumberKind): string {
  if (kind === 'DDT') return 'DDT'
  if (kind === 'PPE_REGISTER') return 'PPE register'
  return kind.toLowerCase().replace(/_/g, ' ')
}

/** When the counter starts again: every calendar year, or never. */
export const NUMBER_RESETS = ['YEARLY', 'NEVER'] as const
export type NumberReset = (typeof NUMBER_RESETS)[number]

/** The period key of a series that never resets. */
export const NO_RESET_SCOPE = 'ALL'

/** The code of a company's first series of a kind. */
export const DEFAULT_SERIES_CODE = 'MAIN'

/** A series code: 1 to 16 capital letters, digits or hyphens, starting with a letter or digit (`MAIN`, `A`, `B-2`). */
export const SERIES_CODE = /^[A-Z0-9][A-Z0-9-]{0,15}$/

export function isSeriesCode(value: unknown): value is string {
  return typeof value === 'string' && SERIES_CODE.test(value)
}

/** The largest number a series hands out: the Int column's limit. */
export const MAX_NUMBER = 2_147_483_647

export function isNumberValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_NUMBER
}

/** The calendar years a yearly series may run in. */
export const MIN_YEAR = 2000
export const MAX_YEAR = 2999

/**
 * The period a document dated `date` (a business date, Europe/Rome) is numbered in: its calendar year for a yearly
 * series (`2026`), `ALL` for one that never resets. The fiscal year start of a company does not move it: Italian
 * numbering follows the calendar year of the document's date.
 */
export function scopeKeyFor(reset: NumberReset, date: BusinessDate): string {
  if (reset === 'NEVER') return NO_RESET_SCOPE
  const year = Number.parseInt(date.slice(0, 4), 10)
  if (!/^\d{4}-/.test(date) || year < MIN_YEAR || year > MAX_YEAR) throw new RangeError(`not a business date in ${MIN_YEAR}-${MAX_YEAR}: ${date}`)
  return String(year)
}

/** The calendar year of a yearly series' period, or null for `ALL`. */
export function yearOfScope(scopeKey: string): number | null {
  if (scopeKey === NO_RESET_SCOPE) return null
  if (!/^\d{4}$/.test(scopeKey)) throw new RangeError(`not a period key: ${scopeKey}`)
  return Number.parseInt(scopeKey, 10)
}

/** A period key as stored: `ALL` or a year from MIN_YEAR to MAX_YEAR. */
export function isScopeKey(value: unknown): value is string {
  if (value === NO_RESET_SCOPE) return true
  if (typeof value !== 'string' || !/^\d{4}$/.test(value)) return false
  const year = Number.parseInt(value, 10)
  return year >= MIN_YEAR && year <= MAX_YEAR
}

/** The prefix a new series of a kind starts with in its default pattern (the admin may type any pattern). */
const DEFAULT_PREFIX: Readonly<Record<DocumentKind, string>> = {
  QUOTE: 'QT',
  SALES_ORDER: 'SO',
  PURCHASE_ORDER: 'PO',
  GOODS_RECEIPT: 'GR',
  WORK_ORDER: 'WO',
  SHIPMENT: 'SH',
  DDT: 'DDT',
  INVOICE: 'FT',
  DEPOSIT_INVOICE: 'FA',
  CREDIT_NOTE: 'NC',
  RETURN: 'RMA',
  LOT: 'LOT',
  BATCH: 'BT',
  CUT_ORDER: 'CO',
  CUT_TICKET: 'CT',
  PPE_REGISTER: 'REG',
  INSPECTION: 'INS',
  RELEASE: 'REL',
  REPAIR: 'REP',
  COMPLAINT: 'CMP',
  CLAIM: 'CLM',
  SUBCONTRACT: 'SC',
  ASN: 'ASN',
  COUNT: 'CNT',
  NCR: 'NCR',
  MAINTENANCE_JOB: 'MJ',
  CAPA: 'CAPA',
  ACCOUNTING_EXPORT: 'EXP',
  HOLD: 'HLD',
  INCOMING_INSPECTION: 'IIN',
  INCIDENT: 'INC',
  PAYROLL_EXPORT: 'PAY',
  PORTAL_REQUEST: 'RQ',
  WORK_INSTRUCTION: 'WI',
  CHANGE_REQUEST: 'CR',
  CHANGE_ORDER: 'ECO',
  SAMPLE_ROUND: 'SR',
  SUPPLIER_DECLARATION: 'SD',
  TECHNICAL_FILE: 'TF',
  EVIDENCE_PACK: 'EP',
  RECALL: 'RCL',
  AUTHORITY_REQUEST: 'AR',
  INQUIRY: 'INQ',
}

/** The pattern a new series gets when the admin types none: `FT-{YYYY}-{N:5}` (yearly) or `LOT-{N:6}` (never resets). */
export function defaultPattern(kind: DocumentKind, reset: NumberReset): string {
  const prefix = DEFAULT_PREFIX[kind]
  return reset === 'YEARLY' ? `${prefix}-{YYYY}-{N:5}` : `${prefix}-{N:6}`
}
