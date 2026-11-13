/**
 * The packing rules the database holds for every login (factory-db …_packing_w2b_guards, W2b-6 schema wave 46/57,
 * B-W2b-364; LOG-003, LOG-007, LOG-010, LOG-013, LOG-017), read back from the database's own words, pure. The carton
 * routes (B-W2b-384) check them first in words; when a write reaches a rule without that check — W1's packing and
 * shipment routes (the move to PACKED of a shipment whose carton contents do not add up, a serial of a line with contents
 * in no carton, cartons whose "n of N" is out of date; a parcel or a line removed with its contents), a shipment on hold,
 * or a race — the API answers 409 in these words instead of a 500 (apps/factory-api core/errors). Every other `packing:`
 * refusal is a 409 in fixed words (never the database's text).
 */

/** The issue paths of the refusals. */
export const PACKING_REFUSAL_ISSUES = Object.freeze({
  held: 'packing/ON_HOLD',
  contents: 'packing/CONTENTS_DO_NOT_ADD_UP',
  serials: 'packing/SERIALS_NOT_IN_CARTONS',
  marks: 'packing/MARKS_OUT_OF_DATE',
  keptParcel: 'packing/PARCEL_HAS_CONTENTS',
  keptLine: 'packing/LINE_HAS_CONTENTS',
  draft: 'packing/NOT_DRAFT',
  released: 'packing/NOT_RELEASED',
  packaging: 'packing/PACKAGING',
  other: 'packing/REFUSED',
} as const)

/** A hold's reason in words (factory-db ShipmentHoldReason). */
const HOLD_REASONS: Readonly<Record<string, string>> = Object.freeze({
  CREDIT: 'credit',
  DEPOSIT: 'the deposit is not paid',
  BALANCE_UNPAID: 'the balance is not paid',
  QUALITY: 'quality',
  CUSTOMER_REQUEST: "the customer's request",
  OTHER: 'another reason',
})

/** A hold's reason in words: the code's, or "a hold" for one this list does not know. */
export const holdReasonWords = (reason: string): string => HOLD_REASONS[reason] ?? 'a hold'

const HELD = /^packing: shipment \S+ is on hold \(([A-Z_]+)\); (.+)$/
const CONTENTS = /^packing: shipment \S+ is PACKED with the contents of its cartons adding up to each line they hold \((\d+) line/
const SERIALS = /^packing: shipment \S+ is PACKED with each serial in a carton that holds its line \((\d+) serial\(s\) of a line with carton contents in no carton, (\d+) carton\(s\) holding more serials of a line than its contents, (\d+) serial/
const MARKS = /^packing: shipment \S+ is PACKED with its numbered cartons each a different n, of N = its (\d+) carton/
const KEPT_PARCEL = /^packing: parcel \S+ holds carton contents or packed serials/
const KEPT_LINE = /^packing: shipment line \S+ has carton contents/
const DRAFT = /^packing: shipment \S+ is ([A-Z]+); (its cartons' contents change|serials go into its cartons) only while it is a DRAFT/
const RELEASED = /^packing: serial \S+ is ([A-Z]+); only a RELEASED serial goes into a carton/
const PACKAGING = /^packing: (parcel \S+ (names packaging type \S+, which is switched off|is a CARTON, a BOX or a PALLET|is packed in packaging type \S+ of another company)|packaging default \S+ names packaging type \S+, which is switched off)/
const ANY = /^packing: /

/** The words and issue path of a packing refusal of the database, or null when the message is not one. */
export function databasePackingRefusal(message: string): { readonly path: string; readonly message: string } | null {
  const held = HELD.exec(message)
  if (held) return { path: PACKING_REFUSAL_ISSUES.held, message: `This shipment is on hold (${holdReasonWords(held[1]!)}): ${held[2]!.replace(/\.$/, '')}.` }
  const contents = CONTENTS.exec(message)
  if (contents) {
    return { path: PACKING_REFUSAL_ISSUES.contents, message: `The carton contents do not add up to the shipment's lines (${contents[1]} line(s)): scan every garment of those lines into its carton, or take the extra ones out.` }
  }
  const serials = SERIALS.exec(message)
  if (serials) {
    return {
      path: PACKING_REFUSAL_ISSUES.serials,
      message: `Each serial lies in the carton of its line: ${serials[1]} serial(s) are in no carton, ${serials[2]} carton(s) hold more serials of a line than its garments there, ${serials[3]} serial(s) lie outside their line's parcel. Scan those serials into their carton.`,
    }
  }
  const marks = MARKS.exec(message)
  if (marks) return { path: PACKING_REFUSAL_ISSUES.marks, message: `The cartons' marks do not say "n of ${marks[1]}" for each of the shipment's ${marks[1]} carton(s): print the marks again.` }
  if (KEPT_PARCEL.test(message)) return { path: PACKING_REFUSAL_ISSUES.keptParcel, message: 'This carton holds scanned garments: take them out of it first.' }
  if (KEPT_LINE.test(message)) return { path: PACKING_REFUSAL_ISSUES.keptLine, message: 'Garments of this line are scanned into a carton: take them out of the carton first.' }
  const draft = DRAFT.exec(message)
  if (draft) return { path: PACKING_REFUSAL_ISSUES.draft, message: `The shipment is ${draft[1]}: its cartons change only while it is a DRAFT (unpack it first).` }
  const released = RELEASED.exec(message)
  if (released) return { path: PACKING_REFUSAL_ISSUES.released, message: `This serial is ${released[1]}: only garments quality released are packed (QHS-073).` }
  if (PACKAGING.test(message)) return { path: PACKING_REFUSAL_ISSUES.packaging, message: "A carton is packed in a carton, a box or a pallet in use of the shipment's company." }
  if (ANY.test(message)) return { path: PACKING_REFUSAL_ISSUES.other, message: 'The packing rules refuse this change.' }
  return null
}
