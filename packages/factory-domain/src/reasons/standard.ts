import { W1_SCAN_REASONS } from '../production/scans/reasons'
import type { ReasonCodeList, ReasonList } from './lists'

/**
 * The standard reasons (B-W2a-18; moved here from factory-db's seed/reasons.ts so the API gives them to a tenant at
 * run time): a base list for every ReasonCode list in Italian and English, with an icon of the design system's tag set
 * and one of its swatches, and an "Other" that asks for a note (office) or a photo (floor) where a list needs one; the
 * operation screen's scrap and rework reasons are W1's (production/scans W1_SCAN_REASONS). Made-up wording a factory
 * edits. A tenant gets them when a list of it has no reason at all (the API's daily job and at the worker's start), or
 * when a person asks for the missing ones ("Add the standard reasons"); a code a tenant already has is never touched.
 */

export interface StandardReason {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly icon: string | null
  readonly colour: string | null
  readonly needsDetail: boolean
}

type Row = readonly [code: string, labelIt: string, labelEn: string, icon: string | null, colour: string | null, needsDetail?: boolean]

// The design system's swatches (packages/ui tokens/colors.ts tagSwatches); rules.ts REASON_COLOURS lists them all.
const BLUE = '#1f6fde'
const AMBER = '#b87503'
const RED = '#e5484d'
const ORANGE = '#ea580c'
const EMERALD = '#059669'
const VIOLET = '#8b5cf6'
const INDIGO = '#6366f1'
const PINK = '#be185d'

const OTHER = (icon: string | null = null): Row => ['OTHER', 'Altro', 'Other', icon, null, true]

const ROWS: Readonly<Record<ReasonCodeList, readonly Row[]>> = {
  PAUSE: [
    ['MATERIAL_WAIT', 'Attesa materiale', 'Waiting for material', 'package', AMBER],
    ['MACHINE', 'Macchina ferma', 'Machine stopped', 'alert', RED],
    ['INSTRUCTIONS', 'Attesa istruzioni', 'Waiting for instructions', 'flag', BLUE],
    ['BREAK', 'Pausa', 'Break', 'clock', EMERALD],
    OTHER(),
  ],
  DOWNTIME: [
    ['BREAKDOWN', 'Guasto', 'Breakdown', 'alert', RED],
    ['SETUP', 'Attrezzaggio', 'Set-up', 'zap', AMBER],
    ['PLANNED_MAINTENANCE', 'Manutenzione programmata', 'Planned maintenance', 'calendar', BLUE],
    ['POWER', 'Mancanza di corrente', 'Power cut', 'zap', ORANGE],
    OTHER(),
  ],
  HELP_CALL: [
    ['TEAM_LEADER', 'Capo reparto', 'Team leader', 'flag', BLUE],
    ['QUALITY', 'Qualità', 'Quality', 'shield', VIOLET],
    ['MAINTENANCE', 'Manutenzione', 'Maintenance', 'alert', RED],
    ['MATERIAL', 'Materiale', 'Material', 'package', AMBER],
    ['SAFETY', 'Sicurezza', 'Safety', 'shield', RED],
  ],
  ADJUSTMENT: [['COUNT_ERROR', 'Errore di conteggio', 'Count error', null, BLUE], ['FOUND', 'Ritrovato', 'Found', null, EMERALD], ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED], OTHER()],
  HOLD: [
    ['QUALITY_CHECK', 'Verifica qualità', 'Quality check', 'shield', VIOLET],
    ['MISSING_CERTIFICATE', 'Certificato mancante', 'Missing certificate', 'award', AMBER],
    ['CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request', 'flag', BLUE],
    ['SUPPLIER_CHECK', 'Verifica fornitore', 'Supplier check', 'truck', INDIGO],
    OTHER(),
  ],
  CANCEL: [
    ['CUSTOMER_REQUEST', 'Richiesta del cliente', 'Customer request', null, BLUE],
    ['DUPLICATE', 'Duplicato', 'Duplicate', null, null],
    ['PRICE', 'Prezzo', 'Price', null, AMBER],
    ['LEAD_TIME', 'Tempi di consegna', 'Lead time', 'clock', ORANGE],
    OTHER(),
  ],
  WRITE_OFF: [
    ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED],
    ['EXPIRED', 'Scaduto', 'Expired', 'calendar', AMBER],
    ['OBSOLETE', 'Obsoleto', 'Obsolete', 'box', INDIGO],
    ['LOST', 'Smarrito', 'Lost', null, ORANGE],
    OTHER('camera'),
  ],
  RETURN: [
    ['WRONG_SIZE', 'Taglia errata', 'Wrong size', 'shirt', BLUE],
    ['DEFECT', 'Difetto', 'Defect', 'alert', RED],
    ['DAMAGED_IN_TRANSIT', 'Danneggiato nel trasporto', 'Damaged in transit', 'truck', ORANGE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'package', AMBER],
    OTHER('camera'),
  ],
  DISCREPANCY: [
    ['SHORT', 'Quantità mancante', 'Short', 'package', AMBER],
    ['OVER', 'Quantità in eccesso', 'Over', 'package', BLUE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'box', ORANGE],
    ['DAMAGED', 'Danneggiato', 'Damaged', 'alert', RED],
  ],
  CLAIM: [
    ['QUALITY', 'Difetto di qualità', 'Quality defect', 'shield', VIOLET],
    ['SHORT_DELIVERY', 'Fornitura incompleta', 'Short delivery', 'package', AMBER],
    ['LATE_DELIVERY', 'Consegna in ritardo', 'Late delivery', 'clock', ORANGE],
    ['WRONG_ITEM', 'Articolo errato', 'Wrong item', 'box', RED],
    OTHER(),
  ],
  DOWNGRADE: [['GRAIN_DEFECT', 'Difetto del fiore', 'Grain defect', 'leaf', AMBER], ['SHADE', 'Differenza di tonalità', 'Shade difference', 'sun', PINK], ['REPAIRED', 'Riparato', 'Repaired', 'shirt', BLUE], OTHER()],
}

const reasonOf = ([code, labelIt, labelEn, icon, colour, needsDetail]: Row): StandardReason => Object.freeze({ code, labelIt, labelEn, icon, colour, needsDetail: needsDetail ?? false })

/** The ReasonCode lists' standard reasons, in tile order (the seed and the API give them in this order). */
export const BASE_REASONS: Readonly<Record<ReasonCodeList, readonly StandardReason[]>> = Object.freeze(
  Object.fromEntries(Object.entries(ROWS).map(([list, rows]) => [list, Object.freeze(rows.map(reasonOf))])) as Record<ReasonCodeList, readonly StandardReason[]>,
)

/**
 * Any list's standard reasons in tile order: the ReasonCode lists' above, the scan lists' W1 reasons (no icon or colour:
 * the floor's standard look per code; W2b: OTHER needs detail).
 */
export function standardReasonsOf(list: ReasonList): readonly StandardReason[] {
  if (list === 'SCRAP' || list === 'REWORK') {
    return W1_SCAN_REASONS.filter((reason) => reason.kind === list).map((reason) =>
      Object.freeze({ code: reason.code, labelIt: reason.label.it, labelEn: reason.label.en, icon: reason.icon ?? null, colour: reason.colour ?? null, needsDetail: reason.needsDetail ?? false }),
    )
  }
  return BASE_REASONS[list]
}

/** The standard reasons a list does not have yet (by code; a code the list has, active or not, is never added again). */
export function missingStandardReasons(list: ReasonList, codes: Iterable<string>): StandardReason[] {
  const have = new Set(codes)
  return standardReasonsOf(list).filter((reason) => !have.has(reason.code))
}
