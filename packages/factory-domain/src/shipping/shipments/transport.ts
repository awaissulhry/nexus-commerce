/**
 * The mode of transport of a shipment and of its DDT (B-W2b-19; the B-W2a-39 note; Intrastat, Reg. (EU) 2019/2152 and
 * its implementing rules: the mode by which the goods are presumed to leave the country, codes 1 to 9 without 6): the
 * office records it on the shipment (Shipment.transportMode, still set after the goods left), the DDT keeps the one in
 * force when it was issued (Ddt.transportMode, frozen). The accounting step reads it for the Intrastat file (B-W2b-22);
 * nothing guesses it: unknown stays null.
 */

export const TRANSPORT_MODES = ['SEA', 'RAIL', 'ROAD', 'AIR', 'POST', 'FIXED_INSTALLATION', 'INLAND_WATERWAY', 'OWN_PROPULSION'] as const
export type TransportMode = (typeof TRANSPORT_MODES)[number]

/** The Intrastat code of each mode (6, the old "fixed installations" split, is not used). */
export const INTRASTAT_TRANSPORT_CODES: Readonly<Record<TransportMode, number>> = Object.freeze({
  SEA: 1,
  RAIL: 2,
  ROAD: 3,
  AIR: 4,
  POST: 5,
  FIXED_INSTALLATION: 7,
  INLAND_WATERWAY: 8,
  OWN_PROPULSION: 9,
})

export const isTransportMode = (value: unknown): value is TransportMode => typeof value === 'string' && (TRANSPORT_MODES as readonly string[]).includes(value)

/** Why a shipment's mode of transport cannot change now (empty: it can): until the shipment is cancelled. */
export function transportModeProblems(status: string): string[] {
  return status === 'CANCELLED' ? ['The shipment is CANCELLED: its mode of transport no longer changes.'] : []
}
