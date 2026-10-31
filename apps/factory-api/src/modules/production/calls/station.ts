import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { parseInstant, toUtcIso } from '@nexus/factory-domain/core/time'
import { CALL_REFUSALS, sentAtOf, stepChange, stepRefusal, type CallKind, type CallStatus, type CallStep } from '@nexus/factory-domain/production/calls/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type FloorContext } from '../../../core/context'
import { hasAcknowledgedNotice, scanSubjectFor } from '../settings/subject'
import { bodyIssue, floorOf, refuse } from './access'
import type { SendBody } from './contract'
import { endWaitingInCommand, startWaitingInCommand } from './waiting'
import { callByClientEvent, callRecord, devicePlaceOf, lockCall, openCallOf, readCall, readType, siteOf, stationOf, typesOfSite, typeViews, type CallRow } from './store'

/**
 * The station's side of help calls (B-W2b-35; MES-142, MES-143, MES-145, MES-137; design floor.help SCR-172 "Who do you
 * need?", "Your call", "Who is coming", "Add details", popup help.cancel). Everything runs in the device's FLOOR scope at
 * its own site, with floor.work (every floor role: one tap):
 *
 *   GET  /production/calls/station                 the tiles (the site's active types in their order, each with this
 *                                                  station's open call of it) and the station's open calls, each as one
 *                                                  call: its timeline and who is coming
 *   POST /production/calls/station                 one tap sends the call: the tablet's station (a team leader may name
 *                                                  another station of the site: floor.lead, MES-137 "the lead requests
 *                                                  extra material"), its line, the caller where the site names workers;
 *                                                  the same type open at the station answers that call (200, existing),
 *                                                  never a second one (MES-143); its client event id once per device
 *   POST /production/calls/station/:id/details     words added to the open call (call first, explain after)
 *   POST /production/calls/station/:id/solve       "It's solved" by the station itself (the tablet that sent it, or one at
 *   POST /production/calls/station/:id/cancel      its station); nothing else is marked (nobody was seen coming)
 *
 * Who a call names follows the site's floor rules (settings/subject.ts): at a site that records workers the signed-in
 * worker once they acknowledged the notice; else nobody (never a refusal: a call for help always goes out).
 */

const keyOf = (context: FloorContext, clientEventId: string) => `${context.deviceId}.${clientEventId}`

/** The worker a floor record names at the site now: the signed-in worker where the site names workers and they acknowledged the notice. */
async function namedWorker(tx: Pick<CommandTx, 'productionSettings' | 'workerNoticeAck' | 'site' | 'privacyNotice' | 'worker'>, siteId: string, workerId: string): Promise<{ readonly workerId: string; readonly employeeId: string | null } | null> {
  if ((await scanSubjectFor(tx, siteId)) !== 'WORKER' || !(await hasAcknowledgedNotice(tx, siteId, workerId))) return null
  const worker = await tx.worker.findUnique({ where: { id: workerId }, select: { employeeId: true } })
  return { workerId, employeeId: worker?.employeeId ?? null }
}

/** The tablet's station and line, and the site. */
async function placeOf(caller: CommandCaller, context: FloorContext) {
  return caller.withClient(async (db) => {
    const site = await siteOf(db, context.siteId)
    if (!site) throw new NotFoundError('Site not found.')
    return { site, ...(await devicePlaceOf(db, context.deviceId)) }
  })
}

/** GET /production/calls/station. */
export async function stationState(caller: CommandCaller) {
  const context = floorOf(caller)
  const now = new Date()
  const place = await placeOf(caller, context)
  return caller.withClient(async (db) => {
    const subject = await scanSubjectFor(db, place.site.id)
    const station = place.stationId ? await stationOf(db, place.stationId) : null
    const types = await typesOfSite(db, place.site.id, { active: true })
    const tiles = await typeViews(db, types)
    const open = station ? await db.helpCall.findMany({ where: { stationId: station.id, status: { in: ['SENT', 'SEEN', 'ON_THE_WAY'] } }, orderBy: [{ sentAt: 'asc' }, { id: 'asc' }], select: { id: true } }) : []
    const records = await Promise.all(open.map(async ({ id }) => callRecord(db, (await readCall(db, id))!, context, now)))
    return {
      subject,
      station: station ? { id: station.id, code: station.code, name: station.name, line: station.line ? { id: station.line.id, code: station.line.code, name: station.line.name } : null } : null,
      tiles: tiles.map((tile) => ({
        type: { id: tile.id, code: tile.code, kind: tile.kind, labelIt: tile.labelIt, labelEn: tile.labelEn, labelI18n: tile.labelI18n, icon: tile.icon, colour: tile.colour, sortOrder: tile.sortOrder },
        open: records.find((record) => record.type.id === tile.id) ?? null,
      })),
      open: records,
    }
  })
}

/** The station's open call of the type (a second tap): the answer is that call (thrown out of the command, which writes nothing). */
class AlreadyOpen extends Error {
  constructor(readonly call: CallRow) {
    super('already open')
  }
}

const isOpenCallClash = (error: unknown): boolean => {
  const found = error as { code?: unknown; message?: unknown; meta?: unknown } | null
  return found?.code === 'P2002' || found?.code === '23505' || /HelpCall_one_open_per_station_type/.test(String(found?.message ?? '')) || /HelpCall_one_open_per_station_type/.test(JSON.stringify(found?.meta ?? null))
}

/** POST /production/calls/station: one tap sends the call (or answers the station's open call of the type). */
export async function sendCall(caller: CommandCaller, body: SendBody, key?: string) {
  const context = floorOf(caller)
  const now = new Date()
  const answer = async (row: CallRow, existing: boolean, replayed: boolean) => ({ call: await caller.withClient((db) => callRecord(db, row, context, now)), existing, replayed })

  // Sent before under this client event id (a queued call sent again): that call, nothing done again.
  const before = await caller.withClient((db) => callByClientEvent(db, context.deviceId, body.clientEventId))
  if (before) return answer(before, false, true)

  const place = await placeOf(caller, context)
  const stationId = body.stationId ?? place.stationId
  if (!stationId) refuse(CALL_REFUSALS.NO_STATION)
  const station = await caller.withClient((db) => stationOf(db, stationId!))
  if (!station || station.siteId !== context.siteId || station.status !== 'ACTIVE') throw new NotFoundError('Station not found at this site.')
  if (stationId !== place.stationId && !can(actorOf(context), 'floor.lead', { companyId: station.companyId, siteId: station.siteId })) refuse(CALL_REFUSALS.OTHER_STATION)
  const type = isUuid(body.typeId) ? await caller.withClient((db) => readType(db, body.typeId)) : null
  if (!type || type.siteId !== context.siteId) throw new NotFoundError('Help-call type not found at this site.')
  // A second tap shows the open call, even of a type switched off since it was sent.
  const open = await caller.withClient((db) => openCallOf(db, station.id, type.id))
  if (open) return answer(open, true, false)
  if (!type.active) refuse(CALL_REFUSALS.TYPE_INACTIVE)
  if (body.bundleId && !body.workOrderId) throw bodyIssue('workOrderId', 'Name the work order of the bundle.')
  if (body.workOrderId) {
    const workOrder = await caller.withClient((db) => db.workOrder.findUnique({ where: { id: body.workOrderId }, select: { siteId: true } }))
    if (!workOrder || workOrder.siteId !== context.siteId) throw bodyIssue('workOrderId', 'Not a work order of this site.')
  }
  if (body.bundleId) {
    const bundle = await caller.withClient((db) => db.bundle.findUnique({ where: { id: body.bundleId }, select: { workOrderId: true } }))
    if (!bundle || bundle.workOrderId !== body.workOrderId) throw bodyIssue('bundleId', 'Not a bundle of this work order.')
  }
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null

  try {
    const { result, replayed } = await command(
      caller,
      { name: 'production.sendCall', idempotencyKey: key ?? keyOf(context, body.clientEventId), input: body, ...(occurredAt ? { deviceTime: occurredAt } : {}) },
      async (tools: CommandTools) => {
        const { tx } = tools
        const clash = await openCallOf(tx, station.id, type.id)
        if (clash) throw new AlreadyOpen(clash)
        const named = await namedWorker(tx, station.siteId, context.actorId)
        const id = newId()
        const sentAt = sentAtOf(occurredAt, tools.now)
        await tx.helpCall.create({
          data: {
            id,
            siteId: station.siteId,
            typeId: type.id,
            stationId: station.id,
            lineId: station.lineId,
            workerId: named?.workerId ?? null,
            employeeId: named?.employeeId ?? null,
            workOrderId: body.workOrderId ?? null,
            bundleId: body.bundleId ?? null,
            note: body.note ?? null,
            status: 'SENT',
            sentAt,
            deviceId: context.deviceId,
            clientEventId: body.clientEventId,
            deviceTime: occurredAt,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: named?.workerId ?? null,
          },
          select: { id: true },
        })
        const scope = { companyId: station.companyId, siteId: station.siteId }
        tools.audit({
          recordType: 'HelpCall',
          recordId: id,
          ...scope,
          after: { typeId: type.id, code: type.code, stationId: station.id, lineId: station.lineId, workerId: named?.workerId ?? null, workOrderId: body.workOrderId ?? null, bundleId: body.bundleId ?? null, note: body.note ?? null, sentAt: toUtcIso(sentAt), deviceId: context.deviceId },
        })
        tools.emit({
          type: 'help_call.raised',
          subject: id,
          ...scope,
          payload: { callId: id, typeId: type.id, code: type.code, kind: type.kind as CallKind, stationId: station.id, lineId: station.lineId, responderTeamId: type.responderTeamId, workOrderId: body.workOrderId ?? null, bundleId: body.bundleId ?? null, by: 'FLOOR' },
        })
        // MES-148: the station's waiting books to the type's off-standard code while the call is open (B-W2b-29's writes).
        if (type.offStandardCodeId && station.id === place.stationId) {
          await startWaitingInCommand(tools, { tenantId: context.tenantId, site: place.site, station, codeId: type.offStandardCodeId, named, callId: id, at: sentAt, deviceId: context.deviceId })
        }
        return { call: await callRecord(tx, (await readCall(tx, id))!, context, tools.now), existing: false }
      },
    )
    return { ...result, replayed }
  } catch (error) {
    if (error instanceof AlreadyOpen) return answer(error.call, true, false)
    // Two taps at the same moment: the other one's call stands.
    if (isOpenCallClash(error)) {
      const won = (await caller.withClient((db) => callByClientEvent(db, context.deviceId, body.clientEventId))) ?? (await caller.withClient((db) => openCallOf(db, station.id, type.id)))
      if (won) return answer(won, won.clientEventId !== body.clientEventId || won.deviceId !== context.deviceId, won.clientEventId === body.clientEventId && won.deviceId === context.deviceId)
    }
    throw error
  }
}

/** The call, as the station sees it: of this site, sent from this tablet or from its station; else the station's refusal. */
async function stationsCall(caller: CommandCaller, context: FloorContext, callId: string): Promise<CallRow> {
  const call = isUuid(callId) ? await caller.withClient((db) => readCall(db, callId)) : null
  if (!call || call.siteId !== context.siteId) throw new NotFoundError('Call not found.')
  const place = await caller.withClient((db) => devicePlaceOf(db, context.deviceId))
  if (call.deviceId !== context.deviceId && call.stationId !== place.stationId) refuse(CALL_REFUSALS.NOT_THIS_STATION)
  return call
}

/** POST /production/calls/station/:callId/details: words added to the open call. */
export async function addDetails(caller: CommandCaller, callId: string, body: { readonly version?: number | undefined; readonly note: string }, key?: string) {
  const context = floorOf(caller)
  const known = await stationsCall(caller, context, callId)
  const refusal = stepRefusal({ status: known.status as CallStatus, sentAt: known.sentAt, seenAt: known.seenAt, onTheWayAt: known.onTheWayAt }, 'CANCELLED')
  if (refusal) refuse(refusal)
  const { result, replayed } = await command(caller, { name: 'production.addCallDetails', idempotencyKey: key, input: { callId, ...body }, record: { type: 'HelpCall', id: callId, ...(body.version !== undefined ? { expectedVersion: body.version } : {}) } }, async (tools) => {
    const { tx, now } = tools
    const call = (await lockCall(tx, callId))!
    const again = stepRefusal({ status: call.status as CallStatus, sentAt: call.sentAt, seenAt: call.seenAt, onTheWayAt: call.onTheWayAt }, 'CANCELLED')
    if (again) refuse(again)
    await tx.helpCall.update({ where: { id: callId }, data: { note: body.note, updatedAt: now }, select: { id: true } })
    const scope = { companyId: call.station.companyId, siteId: call.siteId }
    tools.audit({ recordType: 'HelpCall', recordId: callId, ...scope, before: { note: call.note }, after: { note: body.note } })
    tools.emit({ type: 'help_call.changed', subject: callId, ...scope, payload: { callId, stationId: call.stationId, lineId: call.lineId, change: 'DETAILS', outcomeRecordType: null } })
    return { call: await callRecord(tx, (await readCall(tx, callId))!, context, now) }
  })
  return { ...result, replayed }
}

/**
 * A step of a call inside a command (the station's own close, or a responder's step): the row locked, the version, the
 * rule, the change, its audit row and event. `takerId`: who took it (null where nobody is named).
 */
export async function stepInCommand(
  tools: CommandTools,
  callId: string,
  step: CallStep,
  input: { readonly expectedVersion?: number | undefined; readonly at: Date; readonly takerId: string | null; readonly actor: 'RESPONDER' | 'STATION'; readonly resolutionCode?: string | undefined; readonly resolutionNote?: string | undefined; readonly reason?: string | undefined },
): Promise<CallRow> {
  const { tx, now, context } = tools
  const call = (await lockCall(tx, callId))!
  const state = { status: call.status as CallStatus, sentAt: call.sentAt, seenAt: call.seenAt, onTheWayAt: call.onTheWayAt }
  const refusal = stepRefusal(state, step)
  if (refusal) refuse(refusal)
  if (input.expectedVersion !== undefined && input.expectedVersion !== call.version) throw new StaleVersionError('HelpCall', call.id, call.version, input.expectedVersion)
  const change = stepChange(state, step, { at: input.at, takerId: input.takerId, actor: input.actor, resolutionCode: input.resolutionCode ?? null, resolutionNote: input.resolutionNote ?? null })
  await tx.helpCall.update({ where: { id: callId }, data: { ...change, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  const scope = { companyId: call.station.companyId, siteId: call.siteId }
  const shown = (value: unknown) => (value instanceof Date ? toUtcIso(value) : value)
  tools.audit({
    recordType: 'HelpCall',
    recordId: callId,
    ...scope,
    before: { status: call.status },
    after: Object.fromEntries(Object.entries({ ...change, actor: input.actor }).map(([field, value]) => [field, shown(value)])),
    ...(input.reason ? { reason: input.reason } : {}),
  })
  tools.emit({
    type: 'help_call.answered',
    subject: callId,
    ...scope,
    payload: { callId, typeId: call.typeId, kind: call.type.kind as CallKind, stationId: call.stationId, lineId: call.lineId, step, status: change.status, actor: input.actor, by: context.audience === 'floor' ? 'FLOOR' : 'OFFICE' },
  })
  // MES-148: a solved or cancelled call ends the station's waiting it booked.
  const ended = change.solvedAt ?? change.cancelledAt
  if (ended) await endWaitingInCommand(tools, { tenantId: (context as { readonly tenantId: string }).tenantId, callId, at: ended })
  return (await readCall(tx, callId))!
}

/** POST /production/calls/station/:callId/solve | cancel: the station closes its own call. */
export async function closeAtStation(caller: CommandCaller, callId: string, step: 'SOLVED' | 'CANCELLED', body: { readonly version?: number | undefined; readonly occurredAt?: string | undefined }, key?: string) {
  const context = floorOf(caller)
  const known = await stationsCall(caller, context, callId)
  const early = stepRefusal({ status: known.status as CallStatus, sentAt: known.sentAt, seenAt: known.seenAt, onTheWayAt: known.onTheWayAt }, step)
  if (early) refuse(early)
  const occurredAt = body.occurredAt ? parseInstant(body.occurredAt) : null
  const { result, replayed } = await command(caller, { name: step === 'SOLVED' ? 'production.solveCallAtStation' : 'production.cancelCallAtStation', idempotencyKey: key, input: { callId, ...body }, ...(occurredAt ? { deviceTime: occurredAt } : {}) }, async (tools) => {
    const named = await namedWorker(tools.tx, known.siteId, context.actorId)
    const after = await stepInCommand(tools, callId, step, { expectedVersion: body.version, at: sentAtOf(occurredAt, tools.now), takerId: named?.workerId ?? null, actor: 'STATION' })
    return { call: await callRecord(tools.tx, after, context, tools.now) }
  })
  return { ...result, replayed }
}

