import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { PartyRole, PartyStatus } from '@nexus/factory-domain/parties/rules'
import { defaultAddressOf, shipToPartyProblem, shipToProblems, workshopPlaceOf } from '@nexus/factory-domain/purchasing/po-depth/ship-to'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller } from '../../../core/command'
import { assertDraft, onOrder } from '../orders'
import { officeOrder } from '../store'
import { depthOf, type DepthView } from './read'
import { asPlace } from './store'

/**
 * Ship to a third party, or straight to a subcontractor (B-W2b-296; SCM-066, SCM-147): a DRAFT order delivered to a workshop,
 * a customer or a brand instead of its site — the party, one of its delivery addresses (default: its default delivery
 * address, else its only one) and, for a workshop, its place of ours on the order's site (default: its only one), where the
 * receipt lands. ONE command on the order (its version guards it); the rules are factory-domain purchasing/po-depth/ship-to,
 * the triggers hold the same. The order's PDF prints the address as "Deliver to"; null puts the order back to its site.
 *
 *   PUT /purchasing/orders/:purchaseOrderId/ship-to {version, partyId | null, addressId?, locationId?}    purchasing.manage
 */

export interface ShipToBody {
  readonly version: number
  readonly partyId: string | null
  readonly addressId?: string | null | undefined
  readonly locationId?: string | null | undefined
}

const ADDRESS = { id: true, partyId: true, kinds: true, status: true, approvalStatus: true, isDefaultShipTo: true } as const

export async function putShipTo(caller: CommandCaller, orderId: string, body: ShipToBody, idempotencyKey?: string): Promise<{ depth: DepthView }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.shipTo', idempotencyKey, input: { orderId, ...body }, version: body.version }, async (tools, current) => {
    assertDraft(current)
    const { tx } = tools
    const before = await tx.purchaseOrder.findUniqueOrThrow({ where: { id: current.id }, select: { shipToPartyId: true, shipToAddressId: true, shipToLocationId: true } })
    let data: { shipToPartyId: string | null; shipToAddressId: string | null; shipToLocationId: string | null } = { shipToPartyId: null, shipToAddressId: null, shipToLocationId: null }
    if (body.partyId !== null) {
      const party = isUuid(body.partyId) ? await tx.party.findUnique({ where: { id: body.partyId }, select: { id: true, legalName: true, roles: true, status: true } }) : null
      if (!party) throw new NotFoundError('Party not found.')
      const facts = { id: party.id, name: party.legalName, roles: party.roles as PartyRole[], status: party.status as PartyStatus }
      const partyProblem = shipToPartyProblem(facts, current.partyId)
      if (partyProblem) throw new ValidationError(partyProblem, [{ path: 'body/partyId', message: partyProblem }])
      const addresses = await tx.partyAddress.findMany({ where: { partyId: party.id }, select: ADDRESS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
      const addressNamed = body.addressId !== undefined && body.addressId !== null
      const address = addressNamed ? (addresses.find((row) => row.id === body.addressId) ?? null) : defaultAddressOf(addresses)
      const places = await tx.location.findMany({ where: { partyId: party.id, siteId: current.siteId, kind: 'SUBCONTRACTOR' }, select: { id: true, partyId: true, siteId: true, kind: true, status: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
      const placeNamed = body.locationId !== undefined && body.locationId !== null
      const usablePlaces = places.filter((row) => workshopPlaceOf(asPlace(row), party.id, current.siteId))
      const namedPlace = placeNamed ? (isUuid(body.locationId!) ? ((await tx.location.findUnique({ where: { id: body.locationId! }, select: { id: true, partyId: true, siteId: true, kind: true, status: true, code: true, name: true } })) ?? null) : null) : null
      const place = placeNamed ? namedPlace : body.locationId === null ? null : party.roles.includes('SUBCONTRACTOR') && usablePlaces.length === 1 ? usablePlaces[0]! : null
      const problems = shipToProblems({ party: facts, address, addressNamed, place: place ? asPlace(place) : null, placeNamed, siteId: current.siteId })
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
      data = { shipToPartyId: party.id, shipToAddressId: address!.id, shipToLocationId: place?.id ?? null }
    }
    const fields = (['shipToPartyId', 'shipToAddressId', 'shipToLocationId'] as const).filter((key) => before[key] !== data[key])
    if (fields.length === 0) return { depth: await depthOf(tx, current.id) }
    await tx.purchaseOrder.update({ where: { id: current.id }, data, select: { id: true } })
    tools.audit({ action: 'purchasing.shipTo', recordType: 'PurchaseOrder', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before, after: data })
    tools.emit({ type: 'purchase_order.updated', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { purchaseOrderId: current.id, number: current.number, fields: [...fields] } })
    return { depth: await depthOf(tx, current.id) }
  })
}
