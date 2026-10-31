import { REASON_LIST_GROUPS, type ReasonList } from '../../reasons/lists'
import { standardReasonsOf, type StandardReason } from '../../reasons/standard'

/**
 * The floor's full reason lists (B-W2b-53; MES-293 "Reason code lists": pause, scrap, rework, downtime, help-call
 * reasons with icon and translations; design production.settings "Reason codes" fr-reasons: "W1 a short platform list,
 * W2b full lists"), pure. W1 and W2a gave every tenant a short standard list per list (factory-domain reasons/standard:
 * four or five reasons; the scans' seven scrap and six rework reasons). The full lists below keep every one of those
 * codes with their words, and add what a leather garment floor commonly needs. A tenant adds the codes of the full list it
 * does not have yet in one step (apps/factory-api modules/production/settings reason-lists.ts), and keeps them in the
 * W2a reason editor (words, other languages, icon, colour, order, active), as every list.
 *
 * Made-up wording a factory edits; Italian and English (the other floor languages are typed in the editor). Icons are the
 * design system's tag icons and colours its swatches (reasons/rules REASON_ICONS, REASON_COLOURS; a test checks them).
 * Nothing here names or measures a person: pause reasons are about the work (material, machine, instructions, quality),
 * never about a worker's body or private life (Statuto dei Lavoratori art. 4; GDPR art. 9).
 *
 * The lists are the whole tenant's, as the W2a editor keeps them (ReasonCode and ScrapReason have no company or site): a
 * list per company or per site is a schema follow-up, named in the step's notes.
 */

/** The lists of Floor rules & codes (design fr-reasons), in the editor's order. */
export const FLOOR_REASON_LISTS = REASON_LIST_GROUPS.floorRules
export type FloorReasonList = (typeof FLOOR_REASON_LISTS)[number]

export const isFloorReasonList = (value: unknown): value is FloorReasonList => (FLOOR_REASON_LISTS as readonly unknown[]).includes(value)

type Row = readonly [code: string, labelIt: string, labelEn: string, icon: string | null, colour: string | null, needsDetail?: boolean]

// The design system's swatches (packages/ui tokens/colors.ts tagSwatches; reasons/rules REASON_COLOURS).
const BLUE = '#1f6fde'
const AMBER = '#b87503'
const RED = '#e5484d'
const ORANGE = '#ea580c'
const EMERALD = '#059669'
const VIOLET = '#8b5cf6'
const INDIGO = '#6366f1'
const PINK = '#be185d'
const TEAL = '#0e7490'
const SLATE = '#5b6573'

/** What the full list adds to the standard list of each floor list (before its OTHER, which stays last). */
const ADDED: Readonly<Record<FloorReasonList, readonly Row[]>> = {
  PAUSE: [
    ['QUALITY_CHECK', 'Controllo qualità', 'Quality check', 'shield', VIOLET],
    ['NEEDLE_THREAD', 'Cambio ago o filo', 'Needle or thread change', 'zap', AMBER],
    ['CLEANING', 'Pulizia della postazione', 'Cleaning the station', 'sparkles', EMERALD],
    ['TRAINING', 'Formazione', 'Training', 'award', INDIGO],
    ['MEETING', 'Riunione', 'Meeting', 'calendar', BLUE],
    ['SAFETY', 'Sicurezza', 'Safety', 'shield', RED],
  ],
  SCRAP: [
    ['BURN', 'Bruciatura', 'Burn', 'flame', RED],
    ['WRONG_MATERIAL', 'Materiale sbagliato', 'Wrong material', 'package', ORANGE],
    ['SHADE', 'Differenza di tonalità', 'Shade difference', 'sun', PINK],
    ['MARKING', 'Marcatura o stampa errata', 'Wrong marking or print', 'flag', AMBER],
    ['PROTECTOR_DAMAGE', 'Protezione danneggiata', 'Protector damaged', 'shield', VIOLET],
    ['GLUE', 'Colla irrecuperabile', 'Glue beyond repair', 'alert', SLATE],
  ],
  REWORK: [
    ['LOOSE_THREADS', 'Fili da rifinire', 'Loose threads to trim', 'shirt', BLUE],
    ['LABEL', 'Etichetta da sistemare', 'Label to fix', 'bookmark', INDIGO],
    ['SEAM_TAPE', 'Nastratura da rifare', 'Seam tape to redo', 'shield', TEAL],
    ['PRESSING', 'Da stirare o formare', 'Needs pressing or shaping', 'flame', AMBER],
    ['REFLECTIVE', 'Inserto riflettente da sistemare', 'Reflective insert to refit', 'sparkles', VIOLET],
  ],
  DOWNTIME: [
    ['NEEDLE_BREAK', 'Ago rotto', 'Broken needle', 'alert', ORANGE],
    ['THREAD_BREAK', 'Filo rotto', 'Broken thread', 'alert', AMBER],
    ['NO_MATERIAL', 'Manca il materiale', 'No material', 'package', AMBER],
    ['COMPRESSED_AIR', 'Aria compressa', 'Compressed air', 'zap', BLUE],
    ['NETWORK', 'Rete o tablet', 'Network or tablet', 'zap', INDIGO],
  ],
  HELP_CALL: [
    ['FIRST_AID', 'Primo soccorso', 'First aid', 'heart', RED],
    ['PRODUCTION_OFFICE', 'Ufficio produzione', 'Production office', 'calendar', BLUE],
    ['TABLET', 'Tablet o rete', 'Tablet or network', 'zap', INDIGO],
    ['OTHER', 'Altro', 'Other', null, null, true],
  ],
  ADJUSTMENT: [
    ['WRONG_UNIT', 'Unità di misura errata', 'Wrong unit of measure', 'box', BLUE],
    ['MOVED_UNRECORDED', 'Spostato senza registrazione', 'Moved without a record', 'truck', ORANGE],
    ['SAMPLE', 'Campione prelevato', 'Sample taken', 'gift', VIOLET],
  ],
  HOLD: [
    ['LAB_TEST', 'In attesa di prova di laboratorio', 'Waiting for a lab test', 'shield', INDIGO],
    ['WRONG_LABEL', 'Etichetta errata', 'Wrong label', 'bookmark', AMBER],
    ['RECALL', 'Richiamo', 'Recall', 'alert', RED],
  ],
  CANCEL: [
    ['MATERIAL_UNAVAILABLE', 'Materiale non disponibile', 'Material unavailable', 'package', ORANGE],
    ['PAYMENT', 'Fido o pagamento', 'Credit or payment', 'percent', RED],
    ['DESIGN_CHANGE', 'Modifica del modello', 'Design change', 'shirt', BLUE],
  ],
}

const reasonOf = ([code, labelIt, labelEn, icon, colour, needsDetail]: Row): StandardReason => Object.freeze({ code, labelIt, labelEn, icon, colour, needsDetail: needsDetail ?? false })

function fullOf(list: FloorReasonList): readonly StandardReason[] {
  const standard = standardReasonsOf(list)
  const added = ADDED[list].map(reasonOf).filter((reason) => !standard.some((known) => known.code === reason.code))
  const other = [...standard, ...added].filter((reason) => reason.code === 'OTHER')
  return Object.freeze([...standard.filter((reason) => reason.code !== 'OTHER'), ...added.filter((reason) => reason.code !== 'OTHER'), ...other.slice(0, 1)])
}

/** Each floor list's full reasons, in tile order: the standard ones first (their words), the added ones, OTHER last. */
export const FULL_FLOOR_REASONS: Readonly<Record<FloorReasonList, readonly StandardReason[]>> = Object.freeze(
  Object.fromEntries(FLOOR_REASON_LISTS.map((list) => [list, fullOf(list)])) as Record<FloorReasonList, readonly StandardReason[]>,
)

/** The full list's reasons a list does not have yet (by code: a code the list has, active or not, is never added again). */
export function missingFullReasons(list: FloorReasonList, codes: Iterable<string>): StandardReason[] {
  const have = new Set(codes)
  return FULL_FLOOR_REASONS[list].filter((reason) => !have.has(reason.code))
}

/** For a reader that takes any list: the full reasons of a floor list, the standard ones of any other. */
export function fullReasonsOf(list: ReasonList): readonly StandardReason[] {
  return isFloorReasonList(list) ? FULL_FLOOR_REASONS[list] : standardReasonsOf(list)
}
