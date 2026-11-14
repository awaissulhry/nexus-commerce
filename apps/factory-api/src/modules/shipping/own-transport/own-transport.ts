import { DomainError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { carrierNameFor } from '@nexus/factory-domain/shipping/labels/labels'
import {
  arrangeRefusal,
  arrangementData,
  arrangementOf,
  arrangementProblems,
  eventRefusal,
  eventTimeProblems,
  moveOfStatus,
  ownTransportRefusalPath,
  trackingNumberProblems,
  trackingRefusal,
  type ArrangementInput,
  type ManualEventStatus,
  type OwnTransportFacts,
  type OwnTransportRefusalCode,
} from '@nexus/factory-domain/shipping/own-transport/rules'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { isTestLabel } from '@nexus/factory-domain/shipping/test-mode/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { liveDdtOf } from '../ddt/store'
import { officeShipment } from '../shipments/shipments'
import { readShipment, type ShipmentHeader } from '../store'

/**
 * A manual carrier or our own van (B-W2b-390; LOG-122; rules factory-domain shipping/own-transport). Office only. The DDT
 * (W1, "trasporto a cura del" mittente or vettore) and the ship step are W1's and work for both; this part says how the
 * goods travel, keeps the manual carrier's tracking number and gives the shipment its status when no carrier tracks it.
 *
 *   read          shipping.view: the arrangement, the manual tracking number, the DDT, the labels (carrier and TEST), what
 *                 may change now (each with its refusal in words) and the statuses typed so far (TrackingEvent MANUAL)
 *   arrangement   shipping.manage, one command on the Shipment (its version): OWN_VAN or MANUAL_CARRIER, while the goods are
 *                 planned or packed and no label or live DDT declares them
 *   tracking      shipping.manage: the manual carrier's tracking number typed, corrected or cleared, until it is cancelled
 *   status        shipping.manage: a status typed once the goods left (in transit, out for delivery, a problem, delivered,
 *                 back): a MANUAL TrackingEvent of the whole shipment; DELIVERED and RETURNED move it (W1's
 *                 shipment.status_changed: the order follows, as for a carrier's tracking)
 *
 * Refusals are 409 `refusal/<CODE>` in words; field problems 400 at their field.
 */

const refused = (code: OwnTransportRefusalCode, message: string): never => {
  throw new DomainError('conflict', message, [{ path: ownTransportRefusalPath(code), message }])
}
const refuseIf = (refusal: { code: OwnTransportRefusalCode; message: string } | null): void => {
  if (refusal) refused(refusal.code, refusal.message)
}

/** What the rules read of a shipment (a scoped client or the command's transaction). */
async function factsOf(db: CommandTx, shipment: ShipmentHeader): Promise<OwnTransportFacts & { readonly ddt: { id: string; number: string } | null }> {
  const row = await db.shipment.findUnique({ where: { id: shipment.id }, select: { manualTrackingNumber: true } })
  const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { trackingNumber: true, carrierParcelId: true }, orderBy: { seq: 'asc' } })
  const ddt = await liveDdtOf(db, shipment.id)
  return {
    status: shipment.status,
    transportBy: shipment.transportBy,
    manualTrackingNumber: row?.manualTrackingNumber ?? null,
    parcels: parcels.map((parcel) => ({ trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId })),
    liveDdts: ddt ? 1 : 0,
    ddt,
  }
}

const allowance = (refusal: { code: OwnTransportRefusalCode; message: string } | null) => ({ allowed: refusal === null, refusal })

/** The answer: the shipment's transport as it stands. */
async function transportView(db: CommandTx, shipmentId: string) {
  const shipment = (await readShipment(db, shipmentId))!
  const facts = await factsOf(db, shipment)
  const events = await db.trackingEvent.findMany({
    where: { shipmentId: shipment.id, source: 'MANUAL' },
    select: { id: true, status: true, description: true, location: true, occurredAt: true, recordedAt: true, createdById: true },
    orderBy: [{ occurredAt: 'desc' }, { recordedAt: 'desc' }, { id: 'desc' }],
  })
  return {
    shipment: {
      id: shipment.id,
      number: shipment.number,
      status: shipment.status,
      version: shipment.version,
      transportBy: shipment.transportBy,
      carrierCode: shipment.carrierCode,
      carrierName: shipment.carrierName,
      serviceCode: shipment.serviceCode,
      manualTrackingNumber: facts.manualTrackingNumber,
      ddtRequired: shipment.ddtRequired,
      shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
      deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null,
      returnedAt: shipment.returnedAt ? toUtcIso(shipment.returnedAt) : null,
    },
    arrangement: arrangementOf(facts),
    ddt: facts.ddt,
    labels: {
      carrier: facts.parcels.filter((parcel) => (parcel.trackingNumber !== null || parcel.providerId !== null) && !isTestLabel(parcel.providerId)).length,
      test: facts.parcels.filter((parcel) => isTestLabel(parcel.providerId)).length,
    },
    may: { arrange: allowance(arrangeRefusal(facts)), track: allowance(trackingRefusal(facts)), status: allowance(eventRefusal(facts)) },
    events: events.map((event) => ({
      id: event.id,
      status: event.status,
      description: event.description,
      location: event.location,
      occurredAt: toUtcIso(event.occurredAt),
      recordedAt: toUtcIso(event.recordedAt),
      typedById: event.createdById,
    })),
  }
}

/** shipping.view: the shipment's transport (see the file's comment). */
export async function getOwnTransport(caller: CommandCaller, shipmentId: string) {
  const shipment = await officeShipment(caller, shipmentId)
  return caller.withClient((client) => transportView(client, shipment.id))
}

const changed = (tools: CommandTools, shipment: ShipmentHeader) =>
  tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status: shipment.status, change: 'details' } })

export interface ArrangeBody extends ArrangementInput {
  readonly version?: number | undefined
}

/** shipping.manage: our own van or a carrier booked by hand (see the file's comment). */
export async function arrangeTransport(caller: CommandCaller, shipmentId: string, body: ArrangeBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const problems = arrangementProblems(body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The transport is not valid.', problems)
  refuseIf(arrangeRefusal(await caller.withClient((client) => factsOf(client, shipment))))
  await command(
    caller,
    { name: 'shipping.arrangeTransport', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const facts = await factsOf(tools.tx, current)
      refuseIf(arrangeRefusal(facts))
      const data = arrangementData(body, (code) => carrierNameFor('CARRIER', code))
      await tools.tx.shipment.update({ where: { id: current.id }, data, select: { id: true } })
      tools.audit({
        action: 'shipping.arrangeTransport',
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { transportBy: current.transportBy, carrierCode: current.carrierCode, carrierName: current.carrierName, serviceCode: current.serviceCode, manualTrackingNumber: facts.manualTrackingNumber },
        after: { mode: body.mode, transportBy: data.transportBy, carrierCode: data.carrierCode, carrierName: data.carrierName, serviceCode: null, manualTrackingNumber: data.manualTrackingNumber },
      })
      changed(tools, current)
      return { shipmentId: current.id }
    },
  )
  return caller.withClient((client) => transportView(client, shipment.id))
}

/** shipping.manage: the manual carrier's tracking number typed, corrected or cleared (null). */
export async function typeTrackingNumber(caller: CommandCaller, shipmentId: string, body: { version?: number | undefined; trackingNumber: string | null }, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const problems = trackingNumberProblems(body.trackingNumber)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  refuseIf(trackingRefusal(await caller.withClient((client) => factsOf(client, shipment))))
  const trackingNumber = body.trackingNumber?.trim() || null
  await command(
    caller,
    { name: 'shipping.typeTrackingNumber', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const facts = await factsOf(tools.tx, current)
      refuseIf(trackingRefusal(facts))
      if (facts.manualTrackingNumber === trackingNumber) return { changed: false }
      await tools.tx.shipment.update({ where: { id: current.id }, data: { manualTrackingNumber: trackingNumber }, select: { id: true } })
      tools.audit({
        action: 'shipping.typeTrackingNumber',
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { manualTrackingNumber: facts.manualTrackingNumber },
        after: { manualTrackingNumber: trackingNumber },
      })
      changed(tools, current)
      return { changed: true }
    },
  )
  return caller.withClient((client) => transportView(client, shipment.id))
}

export interface StatusBody {
  readonly version?: number | undefined
  readonly status: ManualEventStatus
  /** An ISO instant (the contract checked it); default now. */
  readonly occurredAt?: string | undefined
  readonly description?: string | null | undefined
  readonly location?: string | null | undefined
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** shipping.manage: a status typed for goods no carrier tracks (see the file's comment). */
export async function typeStatus(caller: CommandCaller, shipmentId: string, body: StatusBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  refuseIf(eventRefusal(await caller.withClient((client) => factsOf(client, shipment))))
  const { result } = await command(
    caller,
    { name: 'shipping.typeTransportStatus', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      refuseIf(eventRefusal(await factsOf(tools.tx, current)))
      const occurredAt = body.occurredAt ? (parseInstant(body.occurredAt) ?? tools.now) : tools.now
      const times = eventTimeProblems(occurredAt, current.shippedAt, tools.now)
      if (times.length > 0) throw new ValidationError(times[0]!.message, times)
      const id = newId()
      await tools.tx.trackingEvent.create({
        data: {
          id,
          siteId: current.siteId,
          partyId: current.partyId,
          shipmentId: current.id,
          parcelId: null,
          status: body.status,
          description: blankToNull(body.description),
          location: blankToNull(body.location),
          occurredAt,
          recordedAt: tools.now,
          source: 'MANUAL',
          externalEventId: null,
          createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
        select: { id: true },
      })
      tools.audit({ action: 'shipping.typeTransportStatus', recordType: 'TrackingEvent', recordId: id, companyId: current.companyId, siteId: current.siteId, after: { shipmentId: current.id, status: body.status, source: 'MANUAL', occurredAt: toUtcIso(occurredAt) } })
      tools.emit({ type: 'shipment.tracking_recorded', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, events: 1, status: body.status, source: 'MANUAL' } })
      const move = moveOfStatus(body.status)
      if (move !== null) {
        if (current.status !== 'SHIPPED') throw new InvalidStateError(`The shipment is ${current.status}; it moves to ${move} only once it left.`)
        await tools.tx.shipment.update({ where: { id: current.id }, data: { status: move, ...(move === 'DELIVERED' ? { deliveredAt: occurredAt } : { returnedAt: occurredAt }) }, select: { id: true } })
        tools.audit({ action: 'shipping.trackingMove', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: move, at: toUtcIso(occurredAt), source: 'MANUAL' } })
        tools.emit({ type: 'shipment.status_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, from: current.status, to: move } })
      }
      return { eventId: id, moved: move }
    },
  )
  return { ...(await caller.withClient((client) => transportView(client, shipment.id))), recorded: { eventId: result.eventId, moved: result.moved } }
}
