import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { LEG_LABEL_ACTION } from '@nexus/factory-domain/sales/order-log/faces'
import type { CommandTx } from '../../../core/command'
import { portalOf } from '../../../platform/auth/portal/service'
import { partnerOrder, portalReader } from '../../sales/portal-orders/access'
import { shipmentsOfOrderWhere } from '../shipments/orders-of'
import { readShipment } from '../store'
import { labelInCommand } from './legs'

/**
 * The customer's side of our warehouse first (owb- order workflow, S3 ss1 step 1.5; design core.js `label`, "Send the shipping
 * label"; S1 draws the screen, po6):
 *
 *   POST /portal/sales-orders/:orderId/shipments/:shipmentId/label   partner, portal.upload over the party (the manifest): the
 *        customer's own label for a shipment of ITS order that goes through our warehouse — a file the customer put on the shipment
 *        with today's portal upload (POST /portal/threads/Shipment/:shipmentId/files, then …/complete: shared with its party, made
 *        by the portal); body { fileId, version } (the shipment's version as read) → { shipmentId, labelSentAt }
 *   atWarehouseOf(db, { partyId, shipmentIds })   for S1's portal Shipments read: where each of the party's shipments is at our
 *        warehouse — never who in the office acted, never a hold, never an office note
 *
 * The brand wall: the order is the party's own in the portal's company (the partner read, else 404), the shipment carries that order
 * and is of the party (else 404, the same words as an unknown one), the file is the customer's own upload on that shipment (else
 * LABEL_FILE). The partner role reads the leg only: the write runs in the tenant's office scope as the person, after those checks
 * (the base's precedent: modules/sales/orders/picture-set.ts setPortalOrderPicture), ONE command on the Shipment, ONE audit row
 * (shipping.warehouseLeg.label, byCustomer: true), one event. Refusals in the person's language.
 */

export interface PortalLabelBody {
  readonly fileId: string
  readonly version?: number | undefined
}

/** POST /portal/sales-orders/:orderId/shipments/:shipmentId/label (see the module's head). */
export async function portalLabel(app: FastifyInstance, request: FastifyRequest, orderId: string, shipmentId: string, body: PortalLabelBody, idempotencyKey?: string): Promise<{ shipmentId: string; labelSentAt: string }> {
  const reader = portalReader(app, request)
  const { session } = reader
  const locale: 'en' | 'it' = session.person.locale === 'it' ? 'it' : 'en'
  if (session.preview) throw new ForbiddenError(locale === 'it' ? "Un'anteprima del portale non invia nulla." : 'A preview of the portal sends nothing.')
  const order = await partnerOrder(request, reader, orderId) // the party's own order in the portal's company, else 404
  // The shipment, read in the partner scope (the party's rows only): it carries this order.
  const shipment = isUuid(shipmentId)
    ? await request.withClient((client) => client.shipment.findFirst({ where: { AND: [{ id: shipmentId }, shipmentsOfOrderWhere(order.id)] }, select: { id: true, partyId: true } }))
    : null
  if (!shipment || shipment.partyId !== session.partyId) throw new NotFoundError('Shipment not found.')
  const p = portalOf(app)
  const outcome = await p.auth.command(
    p.auth.contextFor(request, session.tenantId, session.userId),
    { name: LEG_LABEL_ACTION, idempotencyKey, input: { orderId, shipmentId, ...body, sessionId: session.id }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      // Read again in the tenant's scope: still the party's own (the brand wall holds inside the command too).
      if (current.partyId !== session.partyId) throw new NotFoundError('Shipment not found.')
      const { labelSentAt } = await labelInCommand(tools, current, { fileId: body.fileId, door: 'portal', byUserId: session.userId, locale })
      return { shipmentId: current.id, labelSentAt }
    },
  )
  return outcome.result
}

/** Where one of the party's shipments is at our warehouse (for S1's portal Shipments read). No person, no hold, no office note. */
export interface AtWarehouse {
  /** The warehouse site's name (the customer's words "At the factory's warehouse" are S1's). */
  readonly place: string
  readonly city: string | null
  /** When it arrived there (null: on its way). */
  readonly since: string | null
  /** It was sent on to the customer. */
  readonly sentOn: boolean
  /** The customer's label came. */
  readonly labelSent: boolean
}

/**
 * For S1 (no route): the legs of these shipments of the party, by shipment; a shipment of another party, or one that goes straight to
 * the customer, is absent. `db`: the tenant's office scope as the person (PortalReader.inTenant), after the partner read found the
 * shipments — the partner role reads no site — and the party filter here keeps the brand wall. Reads no person column.
 */
export async function atWarehouseOf(db: FactoryClient | CommandTx, input: { readonly partyId: string; readonly shipmentIds: readonly string[] }): Promise<Map<string, AtWarehouse>> {
  const ids = input.shipmentIds.filter(isUuid)
  if (ids.length === 0 || !isUuid(input.partyId)) return new Map()
  const legs = await db.shipmentWarehouseLeg.findMany({
    where: { shipmentId: { in: ids }, partyId: input.partyId },
    select: { shipmentId: true, warehouseSiteId: true, arrivedAt: true, forwardedAt: true, customerLabelFileId: true },
  })
  if (legs.length === 0) return new Map()
  const sites = await db.site.findMany({ where: { id: { in: [...new Set(legs.map((leg) => leg.warehouseSiteId))] } }, select: { id: true, name: true, address: true } })
  const siteOf = new Map(sites.map((site) => [site.id, site]))
  const cityOf = (address: unknown): string | null => {
    const city = address !== null && typeof address === 'object' ? (address as Record<string, unknown>).city : null
    return typeof city === 'string' && city.trim() !== '' ? city.trim() : null
  }
  return new Map(
    legs.map((leg) => {
      const site = siteOf.get(leg.warehouseSiteId)
      return [leg.shipmentId, { place: site?.name ?? '', city: cityOf(site?.address), since: leg.arrivedAt ? toUtcIso(leg.arrivedAt) : null, sentOn: leg.forwardedAt !== null, labelSent: leg.customerLabelFileId !== null }]
    }),
  )
}
