import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import type { CreateShipmentBody, RoundView, ShipmentView, UpdateShipmentBody } from '@nexus/factory-domain/sales/samples/contracts'
import { SALES_SAMPLES_MANAGE } from '@nexus/factory-domain/sales/samples/permissions'
import {
  returnAddressRefusal,
  shipmentAddRefusal,
  shipmentDatesRefusal,
  shipmentRemoveRefusal,
  stageAfterShipment,
  type SampleStage,
  type ShipmentDirection,
} from '@nexus/factory-domain/sales/samples/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { readRound } from './rounds'
import { badBody, databaseRefusal, may, officeRound, readRoundRow, refuse, SHIPMENT_COLUMNS, type Reader, type RoundData } from './store'

/**
 * Sample shipments (B-W2b-246; SAL-316 "Sample shipments tracking"; design products.samples › Shipments: courier, tracking,
 * sent, received, autosave per cell). Sales owns sample orders, so their shipments too (SCOPE). A shipment goes to a party
 * (OUTBOUND: the brand, a notified body, an agent; default the round's customer) or comes back from it (RETURN); the courier
 * and its tracking are typed (no carrier booking here: the Sendcloud shipments of orders are W1's); sent and received are set
 * once each, received only after sent.
 *
 *   POST   /sales/samples/rounds/:roundId/shipments   sales.samples.manage: add one (not to a cancelled round)
 *   PATCH  /sales/samples/shipments/:shipmentId       a cell saved: courier, tracking, page, address, note; sent, received (once)
 *   DELETE /sales/samples/shipments/:shipmentId       only a shipment not sent yet
 *
 * An OUTBOUND shipment sent moves its round to SENT (from REQUESTED or IN_MAKING); received, to UNDER_REVIEW (from SENT); never
 * backwards, in the same command, said by the round's event. Each answer is the shipment and its round as they are now.
 */

const FUTURE_SLACK_MS = 5 * 60 * 1000

const authorOf = (tools: CommandTools): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** An instant typed on the grid, never in the future (a few minutes of clock difference aside). */
function instantOf(value: string | undefined, path: string, now: Date): Date | undefined {
  if (value === undefined) return undefined
  const instant = parseInstant(value)!
  if (instant.getTime() > now.getTime() + FUTURE_SLACK_MS) badBody(path, path === 'sentAt' ? 'When it was sent is in the future.' : 'When it arrived is in the future.')
  return instant
}

/** The party it goes to or comes from: of the round's company (or tenant-wide), reached by the caller's role. */
async function assertParty(db: Reader, round: RoundData, partyId: string): Promise<void> {
  const party = await db.party.findUnique({ where: { id: partyId }, select: { companyId: true, status: true } })
  if (!party || (party.companyId !== null && party.companyId !== round.companyId)) badBody('partyId', 'No such party for this company.')
  if (party.status === 'ARCHIVED') badBody('partyId', 'This party is archived.')
}

/** An active address of the party (OUTBOUND only). */
async function assertAddress(db: Reader, partyId: string, addressId: string): Promise<void> {
  const address = await db.partyAddress.findUnique({ where: { id: addressId }, select: { partyId: true, status: true } })
  if (!address || address.partyId !== partyId) badBody('shipToAddressId', 'Not an address of the party it goes to.')
  if (address.status !== 'ACTIVE') badBody('shipToAddressId', 'This address is archived.')
}

/**
 * Moves the round forward after a shipment was sent or received (stageAfterShipment), at the stage it was read in (a round
 * moved meanwhile is left as it is); its version moves with it (an open screen reloads).
 */
async function advanceRound(tools: CommandTools, roundId: string, direction: ShipmentDirection, happened: readonly ('SENT' | 'RECEIVED')[]): Promise<void> {
  const { tx } = tools
  const row = (await readRoundRow(tx, roundId))!
  let stage = row.stage as SampleStage
  for (const what of happened) stage = stageAfterShipment(stage, direction, what) ?? stage
  if (stage === row.stage) return
  const { count } = await tx.sampleRound.updateMany({ where: { id: roundId, stage: row.stage }, data: { stage, version: { increment: 1 } } })
  if (count === 0) return
  tools.audit({ action: 'sales.samples.move', recordType: 'SampleRound', recordId: roundId, companyId: row.companyId, before: { stage: row.stage }, after: { stage }, reason: `The samples were ${happened.includes('RECEIVED') ? 'received by' : 'sent to'} the party.` })
  tools.emit({
    type: 'sample_round.changed',
    subject: roundId,
    companyId: row.companyId,
    payload: { sampleRoundId: roundId, number: row.number, styleId: row.styleId, stage, previousStage: row.stage, change: 'MOVED', workOrderId: null },
  })
}

const happenedOf = (sent: boolean, received: boolean): ('SENT' | 'RECEIVED')[] => [...(sent ? (['SENT'] as const) : []), ...(received ? (['RECEIVED'] as const) : [])]

async function answer(caller: CommandCaller, roundId: string, shipmentId: string | null): Promise<{ shipment?: ShipmentView; round: RoundView }> {
  const round = await readRound(caller, roundId)
  const shipment = shipmentId ? round.shipmentsList.find((entry) => entry.id === shipmentId) : undefined
  return { ...(shipment ? { shipment } : {}), round }
}

/** POST /sales/samples/rounds/:roundId/shipments */
export async function addShipment(caller: CommandCaller, roundId: string, body: CreateShipmentBody, idempotencyKey?: string): Promise<{ shipment?: ShipmentView; round: RoundView }> {
  const { context, round } = await officeRound(caller, roundId, SALES_SAMPLES_MANAGE)
  refuse(shipmentAddRefusal({ number: round.number, stage: round.stage as SampleStage }))
  const direction = body.direction ?? 'OUTBOUND'
  const partyId = body.partyId ?? round.partyId
  if (!partyId) badBody('partyId', 'An internal round names who the samples go to or come from (a notified body, an agent …).')
  if (!may(context, SALES_SAMPLES_MANAGE, { companyId: round.companyId, partyId })) badBody('partyId', 'No such party for this company.')
  refuse(returnAddressRefusal(direction, body.shipToAddressId))
  const now = serverClock.now()
  const sentAt = instantOf(body.sentAt, 'sentAt', now)
  const receivedAt = instantOf(body.receivedAt, 'receivedAt', now)
  refuse(shipmentDatesRefusal({ direction, sentAt: null, receivedAt: null }, { sentAt, receivedAt }))
  await caller.withClient(async (db) => {
    if (body.partyId) await assertParty(db, round, partyId)
    if (body.shipToAddressId) await assertAddress(db, partyId, body.shipToAddressId)
  })
  const id = newId()
  await command(caller, { name: 'sales.samples.addShipment', idempotencyKey, input: { roundId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = await readRoundRow(tx, roundId)
    if (!row) throw new NotFoundError('Sample round not found.')
    refuse(shipmentAddRefusal({ number: row.number, stage: row.stage as SampleStage }))
    const data = {
      id,
      roundId,
      partyId,
      direction,
      shipToAddressId: body.shipToAddressId ?? null,
      carrierName: body.carrierName ?? null,
      trackingNumber: body.trackingNumber ?? null,
      trackingUrl: body.trackingUrl ?? null,
      sentAt: sentAt ?? null,
      receivedAt: receivedAt ?? null,
      note: body.note ?? null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: authorOf(tools),
    }
    await tx.sampleShipment.create({ data, select: { id: true } })
    tools.audit({
      action: 'sales.samples.addShipment',
      recordType: 'SampleShipment',
      recordId: id,
      companyId: row.companyId,
      after: { ...data, sentAt: sentAt ? toUtcIso(sentAt) : null, receivedAt: receivedAt ? toUtcIso(receivedAt) : null, createdAt: toUtcIso(tools.now), updatedAt: undefined },
    })
    tools.emit({ type: 'sample_shipment.changed', subject: roundId, companyId: row.companyId, payload: { sampleShipmentId: id, sampleRoundId: roundId, direction, change: 'ADDED' } })
    await advanceRound(tools, roundId, direction, happenedOf(sentAt !== undefined, receivedAt !== undefined))
    return { id }
  }).catch(databaseRefusal)
  return answer(caller, roundId, id)
}

/** The shipment the caller may keep (its round seen and kept with sales.samples.manage), else not found / forbidden. */
async function officeShipment(caller: CommandCaller, shipmentId: string) {
  const shipment = isUuid(shipmentId) ? await caller.withClient((db) => db.sampleShipment.findUnique({ where: { id: shipmentId }, select: SHIPMENT_COLUMNS })) : null
  if (!shipment) throw new NotFoundError('Sample shipment not found.')
  const { round } = await officeRound(caller, shipment.roundId, SALES_SAMPLES_MANAGE).catch((error: unknown) => {
    if (error instanceof NotFoundError) throw new NotFoundError('Sample shipment not found.')
    throw error
  })
  return { shipment, round }
}

/** PATCH /sales/samples/shipments/:shipmentId */
export async function updateShipment(caller: CommandCaller, shipmentId: string, body: UpdateShipmentBody, idempotencyKey?: string): Promise<{ shipment?: ShipmentView; round: RoundView }> {
  const { shipment: seen, round } = await officeShipment(caller, shipmentId)
  const { version, ...changes } = body
  const fields = Object.keys(changes).filter((key) => changes[key as keyof typeof changes] !== undefined)
  if (fields.length === 0) badBody('version', 'Say what changes.')
  refuse(returnAddressRefusal(seen.direction, changes.shipToAddressId))
  const now = serverClock.now()
  const sentAt = instantOf(changes.sentAt, 'sentAt', now)
  const receivedAt = instantOf(changes.receivedAt, 'receivedAt', now)
  refuse(shipmentDatesRefusal(seen, { sentAt, receivedAt }))
  if (changes.shipToAddressId) await caller.withClient((db) => assertAddress(db, seen.partyId, changes.shipToAddressId!))
  await command(caller, { name: 'sales.samples.updateShipment', idempotencyKey, input: { shipmentId, ...body }, record: { type: 'SampleShipment', id: shipmentId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const row = await tx.sampleShipment.findUniqueOrThrow({ where: { id: shipmentId }, select: SHIPMENT_COLUMNS })
    refuse(shipmentDatesRefusal(row, { sentAt, receivedAt }))
    const nowSent = sentAt !== undefined && row.sentAt === null
    const nowReceived = receivedAt !== undefined && row.receivedAt === null
    const data = {
      ...(changes.shipToAddressId !== undefined ? { shipToAddressId: changes.shipToAddressId } : {}),
      ...(changes.carrierName !== undefined ? { carrierName: changes.carrierName } : {}),
      ...(changes.trackingNumber !== undefined ? { trackingNumber: changes.trackingNumber } : {}),
      ...(changes.trackingUrl !== undefined ? { trackingUrl: changes.trackingUrl } : {}),
      ...(nowSent ? { sentAt } : {}),
      ...(nowReceived ? { receivedAt } : {}),
      ...(changes.note !== undefined ? { note: changes.note } : {}),
    }
    if (Object.keys(data).length > 0) await tx.sampleShipment.update({ where: { id: shipmentId }, data, select: { id: true } })
    const show = (value: unknown) => (value instanceof Date ? toUtcIso(value) : value)
    const before = Object.fromEntries(Object.keys(data).map((key) => [key, show(row[key as keyof typeof row])]))
    const after = Object.fromEntries(Object.entries(data).map(([key, value]) => [key, show(value)]))
    tools.audit({ action: 'sales.samples.updateShipment', recordType: 'SampleShipment', recordId: shipmentId, companyId: round.companyId, before, after })
    const change = nowReceived ? 'RECEIVED' : nowSent ? 'SENT' : 'UPDATED'
    tools.emit({ type: 'sample_shipment.changed', subject: row.roundId, companyId: round.companyId, payload: { sampleShipmentId: shipmentId, sampleRoundId: row.roundId, direction: row.direction, change } })
    await advanceRound(tools, row.roundId, row.direction, happenedOf(nowSent, nowReceived))
    return null
  }).catch(databaseRefusal)
  return answer(caller, round.id, shipmentId)
}

/** DELETE /sales/samples/shipments/:shipmentId?version= */
export async function removeShipment(caller: CommandCaller, shipmentId: string, version: number, idempotencyKey?: string): Promise<{ round: RoundView }> {
  const { shipment: seen, round } = await officeShipment(caller, shipmentId)
  refuse(shipmentRemoveRefusal(seen))
  await command(caller, { name: 'sales.samples.removeShipment', idempotencyKey, input: { shipmentId, version }, record: { type: 'SampleShipment', id: shipmentId, expectedVersion: version } }, async (tools) => {
    const { tx } = tools
    const row = await tx.sampleShipment.findUniqueOrThrow({ where: { id: shipmentId }, select: SHIPMENT_COLUMNS })
    refuse(shipmentRemoveRefusal(row))
    await tx.sampleShipment.delete({ where: { id: shipmentId }, select: { id: true } })
    tools.audit({ action: 'sales.samples.removeShipment', recordType: 'SampleShipment', recordId: shipmentId, companyId: round.companyId, before: { partyId: row.partyId, direction: row.direction, carrierName: row.carrierName, trackingNumber: row.trackingNumber } })
    tools.emit({ type: 'sample_shipment.changed', subject: row.roundId, companyId: round.companyId, payload: { sampleShipmentId: shipmentId, sampleRoundId: row.roundId, direction: row.direction, change: 'REMOVED' } })
    return null
  }).catch(databaseRefusal)
  return { round: await readRound(caller, round.id) }
}
