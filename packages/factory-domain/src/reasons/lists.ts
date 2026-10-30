import { DEFECT_KINDS } from '../production/scans/reasons'

/**
 * The reason lists (B-W2a-18; PLT-116; design production.settings "Reason codes", floor.reasons "Pick the reason",
 * sales.settings return reasons): why a worker paused, why a machine stopped, why stock was written off, why goods came
 * back. One code per reason, shown in each reader's language, with an icon and a colour for the floor's tiles (icons
 * first, words second: MES-125, QHS-007).
 *
 * Two tables keep them and ONE editor edits both:
 *   - REASON_CODE (factory-db reasons.prisma ReasonCode): the eleven lists of REASON_CODE_LISTS, with words in Italian,
 *     English and the other floor languages, an icon, a colour and "needs a note";
 *   - SCRAP_REASON (factory-db production.prisma ScrapReason, W1): the operation screen's SCRAP and REWORK reasons, which
 *     the scans reference (OperationScanDefect); they keep Italian and English words only (no icon, colour, other
 *     language or "needs a note" column yet: a schema need of a later wave).
 * The defect library (DefectCode, quality wave 6/7) is a third source whose API is quality's (B-W2a-26).
 *
 * Records of other modules keep the code they chose (text plus their list), never a reference; a code never changes; a
 * reason is set inactive, never deleted (both tables' guards refuse a DELETE).
 */

/** The lists of ReasonCode, in the order of factory-db's ReasonList enum (an API test compares them). */
export const REASON_CODE_LISTS = ['PAUSE', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL', 'WRITE_OFF', 'RETURN', 'DISCREPANCY', 'CLAIM', 'DOWNGRADE'] as const
export type ReasonCodeList = (typeof REASON_CODE_LISTS)[number]

/** The operation screen's lists: ScrapReason's kinds (production/scans DEFECT_KINDS). */
export const SCAN_REASON_LISTS = DEFECT_KINDS
export type ScanReasonList = (typeof SCAN_REASON_LISTS)[number]

/** Every list the editor keeps. */
export const REASON_LISTS = [...REASON_CODE_LISTS, ...SCAN_REASON_LISTS] as const
export type ReasonList = (typeof REASON_LISTS)[number]

export const REASON_SOURCES = ['REASON_CODE', 'SCRAP_REASON'] as const
export type ReasonSource = (typeof REASON_SOURCES)[number]

export const isReasonList = (value: unknown): value is ReasonList => typeof value === 'string' && (REASON_LISTS as readonly string[]).includes(value)
export const isScanReasonList = (list: ReasonList): list is ScanReasonList => (SCAN_REASON_LISTS as readonly string[]).includes(list)

/** What a source keeps besides the code and the Italian and English words. */
export interface ReasonFields {
  /** An icon of the design system's tag set. */
  readonly icon: boolean
  /** A swatch of the design system's palette. */
  readonly colour: boolean
  /** Words in the other floor languages of the tenant's sites. */
  readonly languages: boolean
  /** "Other": the person adds a note (office) or a photo (floor). */
  readonly needsDetail: boolean
}

const ALL_FIELDS: ReasonFields = Object.freeze({ icon: true, colour: true, languages: true, needsDetail: true })
const WORDS_ONLY: ReasonFields = Object.freeze({ icon: false, colour: false, languages: false, needsDetail: false })

export const sourceOf = (list: ReasonList): ReasonSource => (isScanReasonList(list) ? 'SCRAP_REASON' : 'REASON_CODE')
export const fieldsOf = (list: ReasonList): ReasonFields => (sourceOf(list) === 'SCRAP_REASON' ? WORDS_ONLY : ALL_FIELDS)

/**
 * The lists each settings page shows (the hosts of the one editor): Production › Floor rules & codes (design fr-reasons:
 * pause, scrap, rework, downtime, help call, adjustment, hold, cancel), the warehouse's (write-offs, adjustments), sales
 * settings (returns, cancellations), purchasing (delivery discrepancies, supplier claims) and quality (holds, downgrades).
 */
export const REASON_LIST_GROUPS = Object.freeze({
  floorRules: Object.freeze(['PAUSE', 'SCRAP', 'REWORK', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL'] as const satisfies readonly ReasonList[]),
  warehouse: Object.freeze(['WRITE_OFF', 'ADJUSTMENT'] as const satisfies readonly ReasonList[]),
  sales: Object.freeze(['RETURN', 'CANCEL'] as const satisfies readonly ReasonList[]),
  purchasing: Object.freeze(['DISCREPANCY', 'CLAIM'] as const satisfies readonly ReasonList[]),
  quality: Object.freeze(['HOLD', 'DOWNGRADE'] as const satisfies readonly ReasonList[]),
})
