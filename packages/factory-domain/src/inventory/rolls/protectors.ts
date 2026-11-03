import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import type { Language } from './rolls'

/**
 * Protector lots per batch or garment (B-W2b-107; SCM-261; EN 1621-1, -2; Reg. (EU) 2016/425; design warehouse.lots "Trace
 * tree: protector and trim lots beside", floor.operation "Trace protectors and lots per garment", planning.leather "Certified
 * protectors"), pure. A GarmentProtectorLot row says which protector lot a work order (the batch: any garment of it may hold
 * the lot) or one garment serial of it holds, and where in the garment. It records what was built in, so neither the lot's
 * quality status nor its certificate refuses it: they come back as warnings in words, and the recall reads the row. The
 * certificate is the lot's supplier document PPE_CERTIFICATE (QHS-030, B-W1-34), never a copy on the row.
 */

export const PROTECTOR_LIMITS = Object.freeze({ placement: 60, reasonMin: 3, reason: 500 })

/** Where a garment holds a protector: free words ("shoulder", "elbow", "back"), the BOM's names. */
export function recordProblems(input: { readonly placement?: string | null | undefined }): Issue[] {
  const placement = (input.placement ?? '').trim()
  return placement.length > PROTECTOR_LIMITS.placement ? [{ path: 'placement', message: `At most ${PROTECTOR_LIMITS.placement} characters.` }] : []
}

export function withdrawProblems(input: { readonly reason?: string | null | undefined }): Issue[] {
  const reason = (input.reason ?? '').trim()
  if (reason.length < PROTECTOR_LIMITS.reasonMin) return [{ path: 'reason', message: 'Say why the record is wrong (at least 3 characters): the recall reads it.' }]
  if (reason.length > PROTECTOR_LIMITS.reason) return [{ path: 'reason', message: `At most ${PROTECTOR_LIMITS.reason} characters.` }]
  return []
}

// ---- the certificate of a protector lot -----------------------------------------------------------------------------------

export const CERTIFICATE_STATES = ['PRESENT', 'EXPIRED', 'MISSING', 'NOT_NEEDED'] as const
export type CertificateState = (typeof CERTIFICATE_STATES)[number]

export interface CertificateFacts {
  /** The item is a certified PPE component (its lots need the supplier's certificate, B-W1-34). */
  readonly isPpeComponent: boolean
  /** The lot's ACTIVE PPE_CERTIFICATE documents: the last day each is valid (null: no end). */
  readonly documents: readonly { readonly validTo: BusinessDate | null }[]
}

export interface CertificateVerdict {
  readonly state: CertificateState
  /** The latest day a document in force is valid (null: one without an end, or none). */
  readonly validTo: BusinessDate | null
  readonly words: { readonly it: string; readonly en: string }
}

/** The lot's certificate today: present (one in force), expired (only out-of-date ones), missing, or not needed. */
export function certificateOf(facts: CertificateFacts, today: BusinessDate): CertificateVerdict {
  const inForce = facts.documents.filter((document) => document.validTo === null || document.validTo >= today)
  if (inForce.length > 0) {
    const open = inForce.some((document) => document.validTo === null)
    const validTo = open ? null : inForce.map((document) => document.validTo!).sort().at(-1)!
    return {
      state: 'PRESENT',
      validTo,
      words: validTo ? { it: `Certificato EN 1621 del lotto valido fino al ${validTo}.`, en: `The lot's EN 1621 certificate is valid to ${validTo}.` } : { it: 'Certificato EN 1621 del lotto presente.', en: "The lot's EN 1621 certificate is on file." },
    }
  }
  if (facts.documents.length > 0) {
    const last = facts.documents.map((document) => document.validTo!).sort().at(-1)!
    return { state: 'EXPIRED', validTo: last, words: { it: `Il certificato del lotto è scaduto il ${last}.`, en: `The lot's certificate expired on ${last}.` } }
  }
  if (!facts.isPpeComponent) return { state: 'NOT_NEEDED', validTo: null, words: { it: 'Non è un componente DPI certificato.', en: 'Not a certified PPE component.' } }
  return { state: 'MISSING', validTo: null, words: { it: 'Il lotto non ha il certificato del fornitore (EN 1621).', en: "The lot has no supplier's certificate (EN 1621)." } }
}

// ---- refusals and warnings ------------------------------------------------------------------------------------------------

export const PROTECTOR_REFUSALS = ['NOT_A_PROTECTOR', 'NOTHING_BUILT', 'SERIAL_NOT_OF_ORDER', 'SERIAL_VOID', 'LOT_NOT_AT_SITE', 'ALREADY_RECORDED', 'WITHDRAWN_ALREADY'] as const
export type ProtectorRefusalCode = (typeof PROTECTOR_REFUSALS)[number]

export interface ProtectorRefusal {
  readonly code: ProtectorRefusalCode
  readonly message: string
}

export interface RecordFacts {
  readonly workOrder: { readonly number: string; readonly status: string; readonly siteId: string }
  readonly serial: { readonly serial: string; readonly workOrderId: string; readonly status: string } | null
  readonly workOrderId: string
  readonly lot: { readonly code: string; readonly siteId: string } | null
  readonly item: { readonly code: string; readonly kind: string; readonly isPpeComponent: boolean } | null
  /** A live row of the same batch or garment, lot and placement. */
  readonly duplicate: boolean
}

/** Why a protector lot cannot be recorded for the batch or garment, in words (the database's guard, said first). */
export function recordRefusal(facts: RecordFacts): ProtectorRefusal | null {
  if (facts.workOrder.status === 'DRAFT' || facts.workOrder.status === 'CANCELLED') {
    return { code: 'NOTHING_BUILT', message: `Work order ${facts.workOrder.number} is ${facts.workOrder.status}: nothing was built in it.` }
  }
  if (facts.serial && facts.serial.workOrderId !== facts.workOrderId) return { code: 'SERIAL_NOT_OF_ORDER', message: `Garment ${facts.serial.serial} is not of work order ${facts.workOrder.number}.` }
  if (facts.serial && facts.serial.status === 'VOID') return { code: 'SERIAL_VOID', message: `Garment ${facts.serial.serial} was voided: record its replacement instead.` }
  if (!facts.lot || facts.lot.siteId !== facts.workOrder.siteId) return { code: 'LOT_NOT_AT_SITE', message: `This lot is not a lot of work order ${facts.workOrder.number}'s site.` }
  if (!facts.item || (facts.item.kind !== 'PROTECTOR' && !facts.item.isPpeComponent)) {
    return { code: 'NOT_A_PROTECTOR', message: `Lot ${facts.lot.code} is of ${facts.item?.code ?? 'a material'}, which is no protector (kind PROTECTOR, or a certified PPE component).` }
  }
  if (facts.duplicate) {
    return { code: 'ALREADY_RECORDED', message: `Lot ${facts.lot.code} is already recorded for ${facts.serial ? `garment ${facts.serial.serial}` : `batch ${facts.workOrder.number}`} at that place.` }
  }
  return null
}

export const PROTECTOR_WARNINGS = ['CERTIFICATE_MISSING', 'CERTIFICATE_EXPIRED', 'LOT_NOT_RELEASED', 'NOT_ISSUED_TO_ORDER'] as const
export type ProtectorWarningCode = (typeof PROTECTOR_WARNINGS)[number]

export interface ProtectorWarning {
  readonly code: ProtectorWarningCode
  readonly words: { readonly it: string; readonly en: string }
}

/**
 * What the record says that someone should look at, without refusing it (it is what was built in): the lot has no valid
 * certificate, the lot is not released, the lot was never issued to this work order.
 */
export function recordWarnings(facts: { readonly lotCode: string; readonly workOrderNumber: string; readonly certificate: CertificateState; readonly qualityStatus: string; readonly issuedToOrder: boolean }): ProtectorWarning[] {
  const warnings: ProtectorWarning[] = []
  if (facts.certificate === 'MISSING') warnings.push({ code: 'CERTIFICATE_MISSING', words: { it: `Il lotto ${facts.lotCode} non ha il certificato EN 1621.`, en: `Lot ${facts.lotCode} has no EN 1621 certificate.` } })
  if (facts.certificate === 'EXPIRED') warnings.push({ code: 'CERTIFICATE_EXPIRED', words: { it: `Il certificato del lotto ${facts.lotCode} è scaduto.`, en: `The certificate of lot ${facts.lotCode} has expired.` } })
  if (facts.qualityStatus !== 'RELEASED') warnings.push({ code: 'LOT_NOT_RELEASED', words: { it: `Il lotto ${facts.lotCode} è ${facts.qualityStatus}, non rilasciato.`, en: `Lot ${facts.lotCode} is ${facts.qualityStatus}, not released.` } })
  if (!facts.issuedToOrder) warnings.push({ code: 'NOT_ISSUED_TO_ORDER', words: { it: `Il lotto ${facts.lotCode} non è mai stato prelevato per ${facts.workOrderNumber}.`, en: `Lot ${facts.lotCode} was never issued to ${facts.workOrderNumber}.` } })
  return warnings
}

// ---- a batch's protectors -------------------------------------------------------------------------------------------------

export interface CoverageLine {
  readonly itemId: string
  readonly code: string
}

export interface CoverageRow {
  readonly itemId: string
  readonly lotId: string
  readonly garmentSerialId: string | null
  readonly voided: boolean
}

export interface CoverageVerdict {
  readonly itemId: string
  readonly code: string
  /** Lots recorded for the whole batch. */
  readonly batchLotIds: readonly string[]
  /** Garments with a lot of their own recorded. */
  readonly garments: number
  /** No live record names the protector: the recall would not find the batch's garments by its lot. */
  readonly missing: boolean
}

/**
 * Each protector the batch plans (its BOM's protector lines), against the live records: lots for the whole batch, garments
 * with their own, or none (missing). A protector recorded that the batch does not plan comes too (planned: false).
 */
export function coverageOf(lines: readonly CoverageLine[], rows: readonly CoverageRow[]): (CoverageVerdict & { readonly planned: boolean })[] {
  const live = rows.filter((row) => !row.voided)
  const planned = new Map(lines.map((line) => [line.itemId, line.code]))
  const extra = [...new Set(live.map((row) => row.itemId))].filter((itemId) => !planned.has(itemId))
  const entries: [string, string, boolean][] = [...[...planned].map(([itemId, code]): [string, string, boolean] => [itemId, code, true]), ...extra.map((itemId): [string, string, boolean] => [itemId, '', false])]
  return entries.map(([itemId, code, isPlanned]) => {
    const own = live.filter((row) => row.itemId === itemId)
    const batchLotIds = [...new Set(own.filter((row) => row.garmentSerialId === null).map((row) => row.lotId))]
    const garments = new Set(own.flatMap((row) => (row.garmentSerialId ? [row.garmentSerialId] : []))).size
    return { itemId, code, batchLotIds, garments, missing: own.length === 0, planned: isPlanned }
  })
}

/** The recall in words: "Lot PL-07 is in 1 batch and 1 garment: WO-0001 (whole batch), SN-…". */
export function recallWords(lotCode: string, batches: readonly string[], garments: readonly string[], issuedWithoutRecord: readonly string[], language: Language): string {
  const en = language === 'en'
  const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
  if (batches.length === 0 && garments.length === 0 && issuedWithoutRecord.length === 0) return en ? `Lot ${lotCode} is in no garment on record.` : `Il lotto ${lotCode} non risulta in nessun capo.`
  const head = en
    ? `Lot ${lotCode} is in ${plural(batches.length, 'batch', 'batches')} and ${plural(garments.length, 'garment', 'garments')} on record`
    : `Il lotto ${lotCode} è in ${plural(batches.length, 'lotto di produzione', 'lotti di produzione')} e ${plural(garments.length, 'capo', 'capi')} registrati`
  const named = [...batches.map((number) => (en ? `${number} (whole batch)` : `${number} (tutto il lotto)`)), ...garments]
  const tail = issuedWithoutRecord.length > 0 ? (en ? `; issued without a record to ${issuedWithoutRecord.join(', ')}` : `; prelevato senza registrazione per ${issuedWithoutRecord.join(', ')}`) : ''
  return `${head}${named.length > 0 ? `: ${named.join(', ')}` : ''}${tail}.`
}
