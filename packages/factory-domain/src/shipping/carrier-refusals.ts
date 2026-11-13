/**
 * The carrier rules the database holds for every shipment write (factory-db …_carriers_w2b_guards Shipment_carriers_check,
 * W2b-6 schema wave 48/57, B-W2b-367; LOG-049, LOG-053, LOG-122), read back from the database's own words, pure: a carrier
 * booked by hand (its tracking number typed) takes no Sendcloud shipment and stays with a carrier, a shipment that records the
 * customer's collection stays a collection by the customer, and a shipment on its carrier's day sheet stays a carrier
 * shipment of that carrier, PACKED or gone, until it is taken off an open sheet. The commands of B-W2b-390, -395 and -400
 * check these first in words; when a write reaches the rule without that check (W1's shipment, packing and label routes),
 * the API answers 409 in these words instead of a 500 (apps/factory-api core/errors).
 */

/** The issue paths of the refusals. */
export const CARRIER_REFUSAL_ISSUES = Object.freeze({
  manual: 'shipping/MANUAL_CARRIER',
  collected: 'shipping/CUSTOMER_COLLECTED',
  sheet: 'shipping/ON_DAY_SHEET',
  closed: 'shipping/DAY_SHEET_CLOSED',
} as const)

const MANUAL = /^carriers: shipment \S+ has a tracking number typed by hand/
const COLLECTED = /^carriers: shipment \S+ records who collected it, the plate and the signature only when the customer collects/
const SHEET = /^carriers: shipment \S+ (is on a day's sheet only while a carrier carries it|goes with carrier \S+, not on the day's sheet of)/
const CLOSED = /^carriers: the day's sheet \S+ is closed; shipment/

/** The words and issue path of a carrier refusal of the database, or null when the message is another one. */
export function databaseCarrierRefusal(message: string): { readonly path: string; readonly message: string } | null {
  if (MANUAL.test(message)) {
    return { path: CARRIER_REFUSAL_ISSUES.manual, message: 'This shipment goes with a carrier booked by hand (its tracking number typed): it takes no Sendcloud label and stays with a carrier. Clear the typed tracking number first.' }
  }
  if (COLLECTED.test(message)) {
    return { path: CARRIER_REFUSAL_ISSUES.collected, message: "This shipment records the customer's collection (who collected it, the plate, the signature): it stays a collection by the customer." }
  }
  if (SHEET.test(message)) {
    return { path: CARRIER_REFUSAL_ISSUES.sheet, message: "This shipment is on its carrier's day sheet: take it off the sheet first." }
  }
  if (CLOSED.test(message)) {
    return { path: CARRIER_REFUSAL_ISSUES.closed, message: 'That day sheet is closed: the shipments on it stay, and a later one goes on the next sheet.' }
  }
  return null
}
