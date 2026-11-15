import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { eventFor } from '@nexus/factory-domain/events/define'
import { serviceCodeProblem } from '@nexus/factory-domain/shipping/carrier-accounts/rules'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { servicesChangeRefusal, servicesProblems, type BookingProblem } from '@nexus/factory-domain/shipping/services/booking'
import { events as contractEvents } from '@nexus/factory-domain/shipping-contracts/events'
import { command, type CommandCaller } from '../../../core/command'
import { officeShipment } from '../shipments/shipments'
import { lockedStatus, readShipment } from '../store'
import { refusedFor, refusingInWords } from '../carrier-accounts/refusals'
import { bookingView, holdsPrice, readBooking } from './booking'

/**
 * A shipment's carrier services (B-W2b-400; LOG-041 "express and duty options for exports", LOG-038 the customer's default
 * service; design warehouse.shipments "Carrier & label"). Office only.
 *
 *   GET /shipping/shipments/:shipmentId/booking    shipping.view: the booking as it stands ("shown in the booking cost"):
 *                                                  where the goods go, what the carrier offers, who the carrier bills (the
 *                                                  customer's account, our own contract, Sendcloud's rates), the services
 *                                                  with their state and cost in words, each parcel's goods, declared and
 *                                                  insured values with the site's rule (the price grain), what stops the
 *                                                  booking (the label buy refuses the same) and what only warns
 *   PUT /shipping/shipments/:shipmentId/services   shipping.manage: the service code, express, who pays an export's duties
 *                                                  and paperless trade, or the customer's carrier and default service
 *                                                  (`customerDefaults`), at the shipment's version, before any label (void
 *                                                  the labels first) and while it has not left; what the carrier does not
 *                                                  offer and an export's services on another shipment are refused 409 in
 *                                                  words. Event shipment.services_changed
 */

const servicesChanged = contractEvents.find((event): event is Extract<(typeof contractEvents)[number], { type: 'shipment.services_changed' }> => event.type === 'shipment.services_changed')!

const refuseAll = (problems: readonly BookingProblem[]): never => {
  const first = problems[0]!
  throw new DomainError('conflict', problems.length === 1 ? first.message : problems.map((problem) => problem.message).join(' '), problems.map((problem) => ({ path: `refusal/${problem.code}`, message: problem.message })))
}

/** GET /shipping/shipments/:shipmentId/booking */
export async function getBooking(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient(async (client) => bookingView(shipment, await readBooking(client, shipment, { amounts: holdsPrice(caller) })))
}

export interface ServicesBody {
  readonly version?: number | undefined
  readonly serviceCode?: string | null | undefined
  readonly express?: boolean | undefined
  readonly dutyPayer?: 'SENDER' | 'RECEIVER' | null | undefined
  readonly paperless?: boolean | undefined
  /** Take the customer's carrier and its default service (unless a service code is sent). */
  readonly customerDefaults?: boolean | undefined
}

/** PUT /shipping/shipments/:shipmentId/services (see the file's comment). */
export async function setServices(caller: CommandCaller, shipmentId: string, body: ServicesBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const sent = (['serviceCode', 'express', 'dutyPayer', 'paperless'] as const).some((field) => body[field] !== undefined) || body.customerDefaults === true
  if (!sent) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send a service, express, who pays the duties, paperless trade or the customer’s defaults.' }])
  const service = serviceCodeProblem(body.serviceCode, 'body/serviceCode')
  if (service) throw new ValidationError(service.message, [service])

  /** The change as it would stand on the shipment as read now (`read`): refused in words, or the new values. */
  const plan = (read: Awaited<ReturnType<typeof readBooking>>, status: typeof shipment.status, transportBy: typeof shipment.transportBy, current: { carrierCode: string | null; serviceCode: string | null }) => {
    const refusal = servicesChangeRefusal(status, read.facts.parcels.filter((parcel) => parcel.labelled).length)
    if (refusal) refuseAll([refusal])
    let carrierCode = current.carrierCode
    let serviceCode = body.serviceCode === undefined ? current.serviceCode : body.serviceCode === null ? null : body.serviceCode.trim()
    if (body.customerDefaults) {
      const customer = read.facts.customer
      if (transportBy !== 'CARRIER') throw refusedFor('NOT_CARRIER', 'The goods do not travel with a carrier (our own van or the customer collects): the customer’s carrier does not apply.')
      if (!customer?.carrierCode) throw refusedFor('NO_CUSTOMER_CARRIER', `${customer?.name ?? 'The customer'} has no carrier of its own on file (its preferred carrier): choose the carrier here.`)
      carrierCode = customer.carrierCode
      if (body.serviceCode === undefined) serviceCode = customer.defaultService ?? (carrierCode === current.carrierCode ? current.serviceCode : null)
    }
    const next = {
      carrierCode,
      serviceCode,
      express: body.express ?? read.facts.shipment.express,
      dutyPayer: body.dutyPayer === undefined ? read.facts.shipment.dutyPayer : body.dutyPayer,
      paperless: body.paperless ?? read.facts.shipment.paperless,
    }
    const problems = servicesProblems({ carrierCode: next.carrierCode, transportBy, destination: read.facts.destination, express: next.express, dutyPayer: next.dutyPayer, paperless: next.paperless })
    if (problems.length > 0) refuseAll(problems)
    return next
  }
  const amounts = holdsPrice(caller)
  await caller.withClient(async (client) => plan(await readBooking(client, shipment, { amounts }), shipment.status, shipment.transportBy, shipment))

  await refusingInWords(() =>
    command(caller, { name: 'shipping.setServices', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } }, async (tools) => {
      const { tx } = tools
      const current = await lockedStatus(tools, shipment.id, ['DRAFT', 'PACKED'], 'its carrier services change')
      const read = await readBooking(tx, current, { amounts })
      const next = plan(read, current.status, current.transportBy, current)
      const before = { carrierCode: current.carrierCode, serviceCode: current.serviceCode, express: read.facts.shipment.express, dutyPayer: read.facts.shipment.dutyPayer, paperless: read.facts.shipment.paperless }
      const carrierMoved = next.carrierCode !== current.carrierCode
      await tx.shipment.update({
        where: { id: current.id },
        data: { serviceCode: next.serviceCode, express: next.express, dutyPayer: next.dutyPayer, paperless: next.paperless, ...(carrierMoved ? { carrierCode: next.carrierCode, carrierName: carrierNameFor(current.transportBy, next.carrierCode) } : {}) },
        select: { id: true },
      })
      tools.audit({ recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before, after: { ...next, customerDefaults: body.customerDefaults === true } })
      tools.emit(eventFor(servicesChanged, { subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, ...next } }))
      return { shipmentId: current.id }
    }),
  )
  return caller.withClient(async (client) => {
    const after = (await readShipment(client, shipment.id))!
    return bookingView(after, await readBooking(client, after, { amounts }))
  })
}
