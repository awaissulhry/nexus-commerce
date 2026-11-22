import { DomainError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
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
  trackingUrlProblems, // B-OP-034
  trackingRefusal,
  type ArrangementInput,
  type ManualEventStatus,
  type OwnTransportFacts,
  type OwnTransportRefusalCode,
} from '@nexus/factory-domain/shipping/own-transport/rules'
// B-OS-015, B-OS-016 (order shipments tab): ended by hand over a carrier's labels (a reason); the expected arrival typed by hand.
import { etaProblems, etaRefusal, hasCarrierLabel, overrideReasonProblems } from '@nexus/factory-domain/shipping/own-transport/rules'
// B-OS-022 (order shipments 1/1): a tracking number typed by hand per parcel.
import { PARCEL_TRACKING_WORDS, parcelReasonProblems, parcelTrackingProblems, parcelTrackingRefusal, type ParcelTrackingAsk } from '@nexus/factory-domain/shipping/own-transport/rules'
// B-OS-022 (os-fx3): the shipment's own consignment number the customer could read asks the same reason as a parcel's.
import { seenNumbersReasonNeeded } from '@nexus/factory-domain/shipping/own-transport/rules'
import { trackingPageOf } from '@nexus/factory-domain/shipping/labels/tracking'
import { SHIPPING_MANAGE } from '@nexus/factory-domain/shipping/permissions'
import { isTestLabel } from '@nexus/factory-domain/shipping/test-mode/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { liveDdtOf } from '../ddt/store'
import { officeShipment } from '../shipments/shipments'
import { readShipment, type ShipmentHeader } from '../store'
// B-OS-022 (os-fx3): when the shipping notice last went to the customer, for the tracking window's "Customer told {day}".
import { noticeSentAtOf } from '../store'
// B-OP-034: the orders a shipment carries (its lines' orders).
import { ordersOfShipment } from '../shipments/orders-of'

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
async function factsOf(db: CommandTx, shipment: ShipmentHeader): Promise<OwnTransportFacts & { readonly ddt: { id: string; number: string } | null; /* B-OP-034 */ readonly manualTrackingUrl: string | null }> {
  const row = await db.shipment.findUnique({ where: { id: shipment.id }, select: { manualTrackingNumber: true, /* B-OP-034 (office only, never the floor) */ manualTrackingUrl: true } })
  const parcels = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { trackingNumber: true, carrierParcelId: true }, orderBy: { seq: 'asc' } })
  const ddt = await liveDdtOf(db, shipment.id)
  return {
    status: shipment.status,
    transportBy: shipment.transportBy,
    manualTrackingNumber: row?.manualTrackingNumber ?? null,
    parcels: parcels.map((parcel) => ({ trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId })),
    liveDdts: ddt ? 1 : 0,
    ddt,
    manualTrackingUrl: row?.manualTrackingUrl ?? null, // B-OP-034
  }
}

const allowance = (refusal: { code: OwnTransportRefusalCode; message: string } | null) => ({ allowed: refusal === null, refusal })

/** The answer: the shipment's transport as it stands. */
async function transportView(db: CommandTx, shipmentId: string) {
  const shipment = (await readShipment(db, shipmentId))!
  const facts = await factsOf(db, shipment)
  // B-OS-022: each parcel with its label's number (read only) or the number typed for it, and whether one may be typed now.
  // os-fx3: + its weight ("Parcel 2 of 3 · 27.5 kg"), and when the shipping notice last went to the customer.
  const parcelRows = await db.parcel.findMany({ where: { shipmentId: shipment.id }, select: { id: true, seq: true, trackingNumber: true, carrierParcelId: true, trackingUrl: true, manualTrackingNumber: true, manualTrackingUrl: true, /* os-fx3 */ grossWeightKg: true }, orderBy: { seq: 'asc' } })
  const noticeSentAt = (await noticeSentAtOf(db, [shipment.id])).get(shipment.id) ?? null
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
      /** B-OP-034: the tracking link typed beside it (https only); null: none. */
      manualTrackingUrl: facts.manualTrackingUrl,
      ddtRequired: shipment.ddtRequired,
      shippedAt: shipment.shippedAt ? toUtcIso(shipment.shippedAt) : null,
      deliveredAt: shipment.deliveredAt ? toUtcIso(shipment.deliveredAt) : null,
      returnedAt: shipment.returnedAt ? toUtcIso(shipment.returnedAt) : null,
      /** B-OS-016: the expected arrival (the carrier's, or typed by hand where no carrier feed tracks it). */
      expectedDeliveryAt: shipment.expectedDeliveryAt ? toUtcIso(shipment.expectedDeliveryAt) : null,
      /** B-OS-022 (os-fx3): when the shipping notice last went to the customer ("Customer told {day}"); null: never. */
      noticeSentAt: noticeSentAt ? toUtcIso(noticeSentAt) : null,
    },
    arrangement: arrangementOf(facts),
    ddt: facts.ddt,
    labels: {
      carrier: facts.parcels.filter((parcel) => (parcel.trackingNumber !== null || parcel.providerId !== null) && !isTestLabel(parcel.providerId)).length,
      test: facts.parcels.filter((parcel) => isTestLabel(parcel.providerId)).length,
    },
    may: {
      arrange: allowance(arrangeRefusal(facts)),
      track: allowance(trackingRefusal(facts)),
      status: allowance(eventRefusal(facts)),
      // B-OS-015: delivered or came back typed by a person over a carrier's labels (with a reason); B-OS-016: the expected arrival.
      endByHand: allowance(eventRefusal(facts, { status: 'DELIVERED', override: true })),
      eta: { allowed: etaRefusal(facts) === null, refusal: etaRefusal(facts) },
    },
    // ── B-OS-022 ──
    // The whole shipment's refusal first (cancelled, not a carrier, a carrier's labels), then the parcel's own.
    parcels: parcelRows.map((parcel) => {
      const own = parcelTrackingRefusal(shipment.status, { trackingNumber: parcel.trackingNumber, providerId: parcel.carrierParcelId })
      return {
        id: parcel.id,
        seq: parcel.seq,
        label: parcel.trackingNumber !== null || parcel.carrierParcelId !== null ? { number: parcel.trackingNumber, test: isTestLabel(parcel.carrierParcelId), url: trackingPageOf(parcel.trackingUrl) } : null,
        typed: parcel.manualTrackingNumber !== null ? { number: parcel.manualTrackingNumber, url: parcel.manualTrackingUrl } : null,
        // os-fx3: its weight, as Warehouse's parcels read it (kilograms, four places; null: not weighed yet).
        grossWeightKg: parcel.grossWeightKg === null ? null : parcel.grossWeightKg.toFixed(4),
        may: { allowed: trackingRefusal(facts) === null && own === null, refusal: trackingRefusal(facts) ?? (own ? { code: own, message: PARCEL_TRACKING_WORDS[own] } : null) },
      }
    }),
    // ── end B-OS-022 ──
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
  tools.emit({ type: 'shipment.packing_changed', subject: shipment.id, companyId: shipment.companyId, siteId: shipment.siteId, payload: { shipmentId: shipment.id, number: shipment.number, status: shipment.status, change: 'details', partyId: shipment.partyId /* B-SA-004 */ } })

// ── B-OP-030 (order page plan N5): a typed tracking number tells the office (the order's thread: ./tracking-notes.ts) ──
/**
 * The tracking number of a carrier booked by hand typed, corrected or cleared: every order the shipment carries (B-OP-034: its
 * lines' orders, ordersOfShipment — several since B-OP-047), and whether a tracking link is typed beside it.
 */
const trackingChanged = async (tools: CommandTools, shipment: ShipmentHeader, hasNumber: boolean, /* B-OP-034 */ hasLink: boolean, /* B-OS-022 */ parcels = 0) =>
  tools.emit({
    type: 'shipment.tracking_changed',
    subject: shipment.id,
    companyId: shipment.companyId,
    siteId: shipment.siteId,
    payload: { shipmentId: shipment.id, number: shipment.number, status: shipment.status, hasNumber, hasLink, salesOrderIds: await ordersOfShipment(tools.tx, shipment), partyId: shipment.partyId, /* B-OS-022: the parcels whose typed number changed */ ...(parcels > 0 ? { parcels } : {}) },
  })
// ── end B-OP-030 ──

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
      // B-OP-034: a link lives only beside its number — own van, or a carrier with no number typed, drops it; a new number keeps it.
      const manualTrackingUrl = data.manualTrackingNumber === null ? null : facts.manualTrackingUrl
      await tools.tx.shipment.update({ where: { id: current.id }, data: { ...data, manualTrackingUrl }, select: { id: true } })
      tools.audit({
        action: 'shipping.arrangeTransport',
        recordType: 'Shipment',
        recordId: current.id,
        companyId: current.companyId,
        siteId: current.siteId,
        before: { transportBy: current.transportBy, carrierCode: current.carrierCode, carrierName: current.carrierName, serviceCode: current.serviceCode, manualTrackingNumber: facts.manualTrackingNumber, /* B-OP-034 */ manualTrackingUrl: facts.manualTrackingUrl },
        after: { mode: body.mode, transportBy: data.transportBy, carrierCode: data.carrierCode, carrierName: data.carrierName, serviceCode: null, manualTrackingNumber: data.manualTrackingNumber, /* B-OP-034 */ manualTrackingUrl },
      })
      changed(tools, current)
      // B-OP-030: a number typed (or dropped) with the arrangement tells the office too.
      if (data.manualTrackingNumber !== facts.manualTrackingNumber || manualTrackingUrl !== facts.manualTrackingUrl) await trackingChanged(tools, current, data.manualTrackingNumber !== null, manualTrackingUrl !== null)
      return { shipmentId: current.id }
    },
  )
  return caller.withClient((client) => transportView(client, shipment.id))
}

/**
 * shipping.manage: the manual carrier's tracking number typed, corrected or cleared (null); B-OP-034: with its tracking link
 * (`trackingUrl`: https only, only with a number; null clears it; left out: kept — but clearing the number clears it too). Also
 * after the goods left. B-OS-022 (order shipments 1/1, Owner D4): and/or its parcels' numbers (`parcels`), in the same ONE
 * command on the shipment's version — each parcel no label tracks, from PACKED on; once the goods left, a parcel number the
 * customer could read changes or is cleared only with a `reason` — os-fx3: and so does the shipment's own (consignment) number.
 * The customer is not mailed (the web sends the notice again when the person ticks it).
 */
export async function typeTrackingNumber(
  caller: CommandCaller,
  shipmentId: string,
  body: { version?: number | undefined; trackingNumber?: string | null | undefined; /* B-OP-034 */ trackingUrl?: string | null | undefined; /* B-OS-022 */ parcels?: readonly ParcelTrackingAsk[] | undefined; reason?: string | null | undefined },
  idempotencyKey?: string,
) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  // B-OS-022: the shipment's own number when it is sent (left out: kept), the parcels' when they are.
  const typesShipment = body.trackingNumber !== undefined
  if (!typesShipment && body.parcels === undefined) throw new ValidationError('Type the tracking number, or the numbers of the parcels.', [{ path: 'body/trackingNumber', message: 'Required (or send parcels).' }])
  const trackingNumber = typesShipment ? body.trackingNumber?.trim() || null : null
  const problems = [
    ...(typesShipment ? [...trackingNumberProblems(body.trackingNumber), ...trackingUrlProblems(body.trackingUrl, trackingNumber !== null)] : []), // B-OP-034
    ...parcelTrackingProblems(body.parcels ?? []), // B-OS-022
  ]
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  refuseIf(trackingRefusal(await caller.withClient((client) => factsOf(client, shipment))))
  await command(
    caller,
    { name: 'shipping.typeTrackingNumber', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const facts = await factsOf(tools.tx, current)
      refuseIf(trackingRefusal(facts))
      // B-OP-034: the link as asked (left out: kept), never without its number.
      const number = typesShipment ? trackingNumber : facts.manualTrackingNumber
      const trackingUrl = !typesShipment ? facts.manualTrackingUrl : trackingNumber === null ? null : body.trackingUrl === undefined ? facts.manualTrackingUrl : body.trackingUrl?.trim() || null
      const shipmentChanged = facts.manualTrackingNumber !== number || facts.manualTrackingUrl !== trackingUrl
      // B-OS-022: what changes on each parcel named (refused per parcel in words), and the reason a seen number needs.
      const parcelChanges = body.parcels ? await parcelChangesOf(tools.tx, current, body.parcels) : []
      const reason = blankToNull(body.reason)
      // B-OS-022 (os-fx3): any number the customer could read — the consignment number as well as a parcel's — changed or cleared
      // after the goods left asks why.
      const consignment = { before: facts.manualTrackingNumber, after: number }
      if (seenNumbersReasonNeeded(current.status, { consignment, parcels: parcelChanges.map((change) => ({ before: change.before.number, after: change.after.number })) })) {
        const missing = parcelReasonProblems(body.reason)
        if (missing.length > 0) throw new ValidationError(missing[0]!.message, missing)
      }
      // op-fx2 (end check): the same number (and link) again changes nothing and emits nothing, but the command still wrote
      // (the record's version): its audit row says so, as every unchanged write of the app does.
      if (!shipmentChanged && parcelChanges.length === 0) {
        tools.audit({ action: 'shipping.typeTrackingNumber', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, after: { manualTrackingNumber: number, manualTrackingUrl: trackingUrl, unchanged: true } })
        return { changed: false }
      }
      if (shipmentChanged) {
        await tools.tx.shipment.update({ where: { id: current.id }, data: { manualTrackingNumber: number, manualTrackingUrl: trackingUrl }, select: { id: true } })
        tools.audit({
          action: 'shipping.typeTrackingNumber',
          recordType: 'Shipment',
          recordId: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          before: { manualTrackingNumber: facts.manualTrackingNumber, /* B-OP-034 */ manualTrackingUrl: facts.manualTrackingUrl },
          after: { manualTrackingNumber: number, /* B-OP-034 */ manualTrackingUrl: trackingUrl },
          // B-OS-022 (os-fx3): the command's reason (required for a seen consignment number) is kept on its row, as on the parcels'.
          ...(reason ? { reason } : {}),
        })
      }
      // ── B-OS-022: each parcel's number and link, one audit row with every parcel before → after (the old value never lost) ──
      for (const change of parcelChanges) {
        await tools.tx.parcel.update({ where: { id: change.parcelId }, data: { manualTrackingNumber: change.after.number, manualTrackingUrl: change.after.url, version: { increment: 1 } }, select: { id: true } })
      }
      if (parcelChanges.length > 0) {
        tools.audit({
          action: 'shipping.typeParcelTracking',
          recordType: 'Shipment',
          recordId: current.id,
          companyId: current.companyId,
          siteId: current.siteId,
          before: { parcels: parcelChanges.map((change) => ({ parcelId: change.parcelId, seq: change.seq, manualTrackingNumber: change.before.number, manualTrackingUrl: change.before.url })) },
          after: { parcels: parcelChanges.map((change) => ({ parcelId: change.parcelId, seq: change.seq, manualTrackingNumber: change.after.number, manualTrackingUrl: change.after.url })) },
          ...(reason ? { reason } : {}),
        })
      }
      // ── end B-OS-022 ──
      changed(tools, current)
      await trackingChanged(tools, current, number !== null, trackingUrl !== null, parcelChanges.length) // B-OP-030, B-OP-034, B-OS-022
      return { changed: true }
    },
  )
  return caller.withClient((client) => transportView(client, shipment.id))
}

// ── B-OS-022 (order shipments 1/1): the parcels' typed numbers ─────────────────────────────────────────────────────────────────
interface ParcelChange {
  readonly parcelId: string
  readonly seq: number
  readonly before: { readonly number: string | null; readonly url: string | null }
  readonly after: { readonly number: string | null; readonly url: string | null }
}

/**
 * Inside the command (the shipment's row locked by its version): each parcel named, of this shipment (else not found), that may take
 * a typed number now (PARCEL_LABELLED, NOT_PACKED: 409 in words naming the parcel), and what changes on it (an unchanged one: none).
 */
async function parcelChangesOf(tx: CommandTx, shipment: ShipmentHeader, asks: readonly ParcelTrackingAsk[]): Promise<ParcelChange[]> {
  const rows = await tx.parcel.findMany({
    where: { shipmentId: shipment.id, id: { in: asks.map((ask) => ask.parcelId) } },
    select: { id: true, seq: true, trackingNumber: true, carrierParcelId: true, manualTrackingNumber: true, manualTrackingUrl: true },
  })
  const byId = new Map(rows.map((row) => [row.id, row]))
  const changes: ParcelChange[] = []
  for (const ask of asks) {
    const row = byId.get(ask.parcelId)
    if (!row) throw new NotFoundError('Parcel not found in this shipment.')
    const refusal = parcelTrackingRefusal(shipment.status, { trackingNumber: row.trackingNumber, providerId: row.carrierParcelId })
    if (refusal) {
      const message = `Parcel ${row.seq}: ${PARCEL_TRACKING_WORDS[refusal]}`
      throw new DomainError('conflict', message, [{ path: `refusal/${refusal}`, message }])
    }
    const number = blankToNull(ask.trackingNumber)
    // The link as asked (left out: kept), never without its number.
    const url = number === null ? null : ask.trackingUrl === undefined ? row.manualTrackingUrl : blankToNull(ask.trackingUrl)
    if (number === row.manualTrackingNumber && url === row.manualTrackingUrl) continue
    changes.push({ parcelId: row.id, seq: row.seq, before: { number: row.manualTrackingNumber, url: row.manualTrackingUrl }, after: { number, url } })
  }
  return changes.sort((a, b) => a.seq - b.seq)
}
// ── end B-OS-022 ──

export interface StatusBody {
  readonly version?: number | undefined
  readonly status: ManualEventStatus
  /** An ISO instant (the contract checked it); default now. */
  readonly occurredAt?: string | undefined
  readonly description?: string | null | undefined
  readonly location?: string | null | undefined
  /** B-OS-015: why a shipment its carrier's labels track is marked delivered or came back by hand (3 to 500; required then). */
  readonly reason?: string | null | undefined
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** shipping.manage: a status typed for goods no carrier tracks (see the file's comment). */
export async function typeStatus(caller: CommandCaller, shipmentId: string, body: StatusBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  // ── B-OS-015: DELIVERED or RETURNED over a carrier's labels, by a person, with a reason (required: a 400 before the state check) ──
  const reason = blankToNull(body.reason)
  const overrides = (facts: OwnTransportFacts) => moveOfStatus(body.status) !== null && hasCarrierLabel(facts)
  const checked = (facts: OwnTransportFacts) => {
    const override = overrides(facts)
    if (override) {
      const problems = overrideReasonProblems(body.reason)
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    }
    refuseIf(eventRefusal(facts, { status: body.status, override }))
    return override
  }
  checked(await caller.withClient((client) => factsOf(client, shipment)))
  // ── end B-OS-015 ──
  const { result } = await command(
    caller,
    { name: 'shipping.typeTransportStatus', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const overrode = checked(await factsOf(tools.tx, current)) // B-OS-015
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
          // B-OS-015: a move by hand over the carrier's labels keeps its reason as the event's words (the deliveries read says it).
          description: overrode ? reason : (blankToNull(body.description) ?? reason),
          location: blankToNull(body.location),
          occurredAt,
          recordedAt: tools.now,
          source: 'MANUAL',
          externalEventId: null,
          createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
        },
        select: { id: true },
      })
      tools.audit({ action: 'shipping.typeTransportStatus', recordType: 'TrackingEvent', recordId: id, companyId: current.companyId, siteId: current.siteId, after: { shipmentId: current.id, status: body.status, source: 'MANUAL', occurredAt: toUtcIso(occurredAt), /* B-OS-015 */ overrode }, ...(reason ? { reason } : {}) })
      tools.emit({ type: 'shipment.tracking_recorded', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, events: 1, status: body.status, source: 'MANUAL', partyId: current.partyId /* B-SA-004 */ } })
      const move = moveOfStatus(body.status)
      if (move !== null) {
        if (current.status !== 'SHIPPED') throw new InvalidStateError(`The shipment is ${current.status}; it moves to ${move} only once it left.`)
        await tools.tx.shipment.update({ where: { id: current.id }, data: { status: move, ...(move === 'DELIVERED' ? { deliveredAt: occurredAt } : { returnedAt: occurredAt }) }, select: { id: true } })
        tools.audit({ action: 'shipping.trackingMove', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { status: current.status }, after: { status: move, at: toUtcIso(occurredAt), source: 'MANUAL', /* B-OS-015 */ overrode, ...(reason ? { reason } : {}) }, ...(reason ? { reason } : {}) })
        tools.emit({ type: 'shipment.status_changed', subject: current.id, companyId: current.companyId, siteId: current.siteId, payload: { shipmentId: current.id, number: current.number, from: current.status, to: move, partyId: current.partyId /* B-SA-004 */ } })
      }
      return { eventId: id, moved: move }
    },
  )
  return { ...(await caller.withClient((client) => transportView(client, shipment.id))), recorded: { eventId: result.eventId, moved: result.moved } }
}

// ── B-OS-016 (order shipments tab; 13-backend §2): the expected arrival typed by hand where no carrier feed tracks it ───────────
export interface EtaBody {
  readonly version?: number | undefined
  /** An ISO instant; null clears it. */
  readonly expectedDeliveryAt: string | null
  /** Why it changes (required when the customer already reads one: 3 to 500). */
  readonly reason?: string | null | undefined
}

/**
 * PUT /shipping/shipments/:shipmentId/eta (shipping.manage): while PACKED or SHIPPED and no carrier label tracks it (our own van, a
 * carrier booked by hand; a TEST label is never tracked) — the carrier's poll never touches it (it polls labelled parcels only).
 * Refused CARRIER_FED, NOT_LEFT_OR_PACKED, ARRIVED, CANCELLED. Audit `shipping.etaTyped` before → after (what the order's deliveries
 * read calls "Set by hand"); shipment.packing_changed (details). The customer is not mailed.
 */
export async function setExpectedArrival(caller: CommandCaller, shipmentId: string, body: EtaBody, idempotencyKey?: string) {
  const shipment = await officeShipment(caller, shipmentId, SHIPPING_MANAGE)
  const at = body.expectedDeliveryAt === null ? null : parseInstant(body.expectedDeliveryAt)
  if (body.expectedDeliveryAt !== null && at === null) throw new ValidationError('Expected an ISO 8601 time with a zone.', [{ path: 'body/expectedDeliveryAt', message: 'Expected an ISO 8601 time with a zone.' }])
  const reason = blankToNull(body.reason)
  await command(
    caller,
    { name: 'shipping.typeEta', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'Shipment', id: shipment.id, expectedVersion: body.version } },
    async (tools) => {
      const current = (await readShipment(tools.tx, shipment.id))!
      const refusal = etaRefusal(await factsOf(tools.tx, current))
      if (refusal) throw new DomainError('conflict', refusal.message, [{ path: `refusal/${refusal.code}`, message: refusal.message }])
      const problems = etaProblems(at, { now: tools.now, since: current.shippedAt ?? current.packedAt, before: current.expectedDeliveryAt, reason })
      if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
      const before = current.expectedDeliveryAt ? current.expectedDeliveryAt.toISOString() : null
      const after = at ? at.toISOString() : null
      if (before === after) return { changed: false }
      await tools.tx.shipment.update({ where: { id: current.id }, data: { expectedDeliveryAt: at }, select: { id: true } })
      tools.audit({ action: 'shipping.etaTyped', recordType: 'Shipment', recordId: current.id, companyId: current.companyId, siteId: current.siteId, before: { expectedDeliveryAt: before }, after: { expectedDeliveryAt: after }, ...(reason ? { reason } : {}) })
      changed(tools, current)
      return { changed: true }
    },
  )
  return caller.withClient((client) => transportView(client, shipment.id))
}
// ── end B-OS-016 ──
