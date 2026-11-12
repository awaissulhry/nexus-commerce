import type { Issue } from '../../core/errors'
import type { PartyRole, PartyStatus } from '../../parties/rules'
import type { DepthCheck } from './codes'

/**
 * Ship to a third party, or straight to a subcontractor (B-W2b-296; SCM-066, SCM-147; factory-db supply.prisma
 * PurchaseOrder.shipToPartyId, shipToAddressId, shipToLocationId), pure.
 *
 *   who       a DRAFT order may be delivered to another party than its site: a workshop (SUBCONTRACTOR) that works the
 *             material for us, or a customer or brand; never the supplier itself; an ACTIVE party.
 *   where     one of that party's addresses the goods are delivered to (kind SHIP_TO), ACTIVE and not waiting for, or
 *             refused, the office's check (the default: its default delivery address, else its only one). The order's
 *             PDF prints it as "Deliver to".
 *   workshop  a workshop that holds our stock has its SUBCONTRACTOR place on the order's site: the receipt of the goods
 *             lands there (the material it holds of ours: its balance), not at our dock. When the party has exactly one
 *             such place on the site it is taken by default. A workshop without one: the send warns, and the office picks
 *             where the receipt lands.
 *   receive   the goods never come to our dock: the office records the receipt from the delivery note (a tablet at the
 *             dock does not); the receipt's default place is the workshop's.
 */

export const SHIP_TO_ROLES: readonly PartyRole[] = Object.freeze(['SUBCONTRACTOR', 'CUSTOMER', 'BRAND'])

export interface ShipToParty {
  readonly id: string
  readonly name: string
  readonly roles: readonly PartyRole[]
  readonly status: PartyStatus
}
export interface ShipToAddress {
  readonly id: string
  readonly partyId: string
  readonly kinds: readonly string[]
  readonly status: string
  readonly approvalStatus: string | null
  readonly isDefaultShipTo: boolean
}
export interface ShipToPlace {
  readonly id: string
  readonly partyId: string | null
  readonly siteId: string
  readonly kind: string
  readonly status: string
}

/** Why the party cannot be shipped to for an order of `supplierId`, or null. */
export function shipToPartyProblem(party: ShipToParty, supplierId: string): string | null {
  if (party.id === supplierId) return 'The supplier is who delivers: ship to another party, or to the order’s own site.'
  if (!party.roles.some((role) => SHIP_TO_ROLES.includes(role))) return `${party.name} is not a workshop, a customer or a brand: give it its role first.`
  if (party.status !== 'ACTIVE') return `${party.name} is ${party.status.toLowerCase()}: goods are delivered only to an active party.`
  return null
}

/** Whether an address takes deliveries (kind SHIP_TO, active, not waiting for or refused the office's check). */
export const usableAddress = (address: ShipToAddress): boolean =>
  address.kinds.includes('SHIP_TO') && address.status === 'ACTIVE' && address.approvalStatus !== 'WAITING' && address.approvalStatus !== 'REFUSED'

/** The address a ship-to uses when none is named: the default delivery address, else the only usable one, else null. */
export function defaultAddressOf(addresses: readonly ShipToAddress[]): ShipToAddress | null {
  const usable = addresses.filter(usableAddress)
  return usable.find((address) => address.isDefaultShipTo) ?? (usable.length === 1 ? usable[0]! : null)
}

/** Whether a location is the party's workshop place on the order's site. */
export const workshopPlaceOf = (place: ShipToPlace, partyId: string, siteId: string): boolean => place.kind === 'SUBCONTRACTOR' && place.partyId === partyId && place.siteId === siteId && place.status === 'ACTIVE'

/** What is wrong with a ship-to as typed (the party's checked by shipToPartyProblem): its address and place. */
export function shipToProblems(input: { readonly party: ShipToParty; readonly address: ShipToAddress | null; readonly addressNamed: boolean; readonly place: ShipToPlace | null; readonly placeNamed: boolean; readonly siteId: string }): Issue[] {
  const problems: Issue[] = []
  const { party, address, place } = input
  if (address === null) {
    problems.push({ path: 'body/addressId', message: input.addressNamed ? `Not an address of ${party.name}.` : `${party.name} has no single address to deliver to: choose one (a delivery address of the party).` })
  } else if (address.partyId !== party.id) problems.push({ path: 'body/addressId', message: `Not an address of ${party.name}.` })
  else if (!usableAddress(address)) problems.push({ path: 'body/addressId', message: 'Choose an active delivery address (one the office checked).' })
  if (input.placeNamed && (place === null || !workshopPlaceOf(place, party.id, input.siteId))) {
    problems.push({ path: 'body/locationId', message: `Choose the workshop place of ${party.name} on the order’s site (an active subcontractor location).` })
  }
  return problems
}

/** The send's checks of a ship-to (none when the order goes to its own site). */
export function shipToChecks(shipTo: { readonly party: ShipToParty; readonly address: ShipToAddress | null; readonly hasPlace: boolean } | null, supplierId: string): DepthCheck[] {
  if (shipTo === null) return []
  const checks: DepthCheck[] = []
  const partyProblem = shipToPartyProblem(shipTo.party, supplierId)
  if (partyProblem) checks.push({ code: 'SHIP_TO_NOT_USABLE', severity: 'BLOCKS', path: 'shipToPartyId', message: partyProblem })
  if (shipTo.address === null || !usableAddress(shipTo.address)) checks.push({ code: 'SHIP_TO_NOT_USABLE', severity: 'BLOCKS', path: 'shipToAddressId', message: `The delivery address of ${shipTo.party.name} cannot take goods any more: choose another one.` })
  if (!shipTo.hasPlace && shipTo.party.roles.includes('SUBCONTRACTOR')) {
    checks.push({ code: 'SHIP_TO_NO_WORKSHOP_PLACE', severity: 'WARNING', path: 'shipToLocationId', message: `${shipTo.party.name} has no workshop place of ours on the order’s site: the receipt will not land on its stock (add the place, or pick where the receipt goes).` })
  }
  return checks
}
