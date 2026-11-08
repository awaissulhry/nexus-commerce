import type { MachineStatus as DbMachineStatus } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addDaysTo } from '@nexus/factory-domain/plant/machines/history'
import { releasesDoNotUse, statusChangeRefusal, statusReasonProblems, type SettableStatus } from '@nexus/factory-domain/plant/machines/status'
import { PLANT_MACHINES_MANAGE, PLANT_SIGN_SAFE, PLANT_VIEW } from '@nexus/factory-domain/plant/permissions'
import type { MachineStatus } from '@nexus/factory-domain/plant/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMay, assertMayWrite, assertVersion, may, officeOf, problemsError } from '../access'
import { lockMachine, locksOf, machineViews, readMachine } from '../store'
import { refuse } from './depth-access'

/**
 * A machine's status by hand and its history (B-W2b-136; QHS-167; design plant.machines pop "Change status", record tab
 * "Status & downtime"):
 *
 *   POST /plant/machines/:machineId/status       Change status: RUNNING, DOWN, UNDER_MAINTENANCE or DO_NOT_USE with the
 *        reason (plant.machines.manage). Out of DO_NOT_USE only a technician (plant.signSafe) with a fresh code (the
 *        route's step-up, as a sign-safe). Never a machine locked as unsafe (H1: its request's sign-safe frees it), never
 *        a retired one, never RETIRED (Retire is its own act). One command on the machine row (locked first), the version
 *        read, an audit row, machine.status_changed (cause CHANGE); the database's trigger writes the history row.
 *   GET  /plant/machines/:machineId/status-history?from=&days=   the changes of the window (days in Europe/Rome), the
 *        status before it and the newest changes (plant.view). No person: the history names none (Statuto art. 4).
 */

export interface ChangeStatusBody {
  readonly version: number
  readonly to: SettableStatus
  readonly reason: string
}

export async function changeStatus(caller: CommandCaller, machineId: string, body: ChangeStatusBody, stepUp: () => void | Promise<void>, idempotencyKey?: string) {
  const context = officeOf(caller)
  const problems = statusReasonProblems(body.reason)
  if (problems.length > 0) throw problemsError(problems, 'Say why the status changes.')
  const known = isUuid(machineId) ? await caller.withClient((client) => readMachine(client, context, machineId)) : null
  if (!known) throw new NotFoundError('Machine not found.')
  assertMay(context, PLANT_VIEW, known, 'Machine')
  assertMayWrite(context, PLANT_MACHINES_MANAGE, known, 'The status of the machines of this site is changed by a role that keeps them (plant.machines.manage).')
  // A refused change never asks for the code (as a refused sign-safe): the rules first, on what was read.
  const lockedNow = (await caller.withClient((client) => locksOf(client, [known.id]))).has(known.id)
  const early = statusChangeRefusal({ assetNumber: known.assetNumber, status: known.status as MachineStatus, locked: lockedNow, to: body.to })
  if (early) refuse(early)
  const release = releasesDoNotUse(known.status as MachineStatus, body.to)
  if (release) {
    if (!may(context, PLANT_SIGN_SAFE, known)) throw new ForbiddenError('Only a technician releases a machine marked do-not-use (plant.signSafe), as a sign-safe.')
    await stepUp()
  }
  const reason = body.reason.trim()
  const { result, replayed } = await command(caller, { name: 'plant.changeMachineStatus', idempotencyKey, input: { machineId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const machine = (await lockMachine(tx, context, machineId))!
    assertVersion('machine', machine.version, body.version)
    const locked = (await locksOf(tx, [machine.id])).has(machine.id)
    const refusal = statusChangeRefusal({ assetNumber: machine.assetNumber, status: machine.status as MachineStatus, locked, to: body.to })
    if (refusal) refuse(refusal)
    const from = machine.status as MachineStatus
    await tx.machine.update({
      where: { id: machine.id },
      data: { status: body.to as DbMachineStatus, statusSince: now, statusReason: reason, version: { increment: 1 }, updatedAt: now },
      select: { id: true },
    })
    const scope = { companyId: machine.companyId, siteId: machine.siteId }
    tools.audit({
      action: 'plant.changeMachineStatus',
      recordType: 'Machine',
      recordId: machine.id,
      ...scope,
      before: { status: from, statusReason: machine.statusReason },
      after: { status: body.to, statusReason: reason, released: release },
      reason,
    })
    tools.emit({
      type: 'machine.status_changed',
      subject: machine.id,
      ...scope,
      payload: { machineId: machine.id, assetNumber: machine.assetNumber, from, to: body.to, cause: 'CHANGE', recordType: 'Machine', recordId: machine.id, locked: false, by: 'OFFICE' },
    })
    const [view] = await machineViews(tx, [(await readMachine(tx, context, machine.id))!], context)
    return { machine: view! }
  })
  return { ...result, replayed }
}

const EVENT_SELECT = { id: true, at: true, fromStatus: true, toStatus: true, reason: true } as const
const eventView = (row: { id: string; at: Date; fromStatus: string | null; toStatus: string; reason: string | null }) => ({
  id: row.id,
  at: toUtcIso(row.at),
  from: (row.fromStatus as MachineStatus | null) ?? null,
  to: row.toStatus as MachineStatus,
  reason: row.reason,
})

export async function statusHistory(caller: CommandCaller, machineId: string, query: { readonly from: BusinessDate; readonly days: number }) {
  const context = officeOf(caller)
  const from = businessDayStart(query.from)
  const to = businessDayStart(addDaysTo(query.from, query.days))
  return caller.withClient(async (client) => {
    const machine = isUuid(machineId) ? await readMachine(client, context, machineId) : null
    if (!machine) throw new NotFoundError('Machine not found.')
    assertMay(context, PLANT_VIEW, machine, 'Machine')
    const events = await client.machineStatusEvent.findMany({ where: { machineId: machine.id, at: { gte: from, lt: to } }, orderBy: [{ at: 'asc' }, { id: 'asc' }], select: EVENT_SELECT })
    const before = await client.machineStatusEvent.findFirst({ where: { machineId: machine.id, at: { lt: from } }, orderBy: [{ at: 'desc' }, { id: 'desc' }], select: EVENT_SELECT })
    const latest = await client.machineStatusEvent.findMany({ where: { machineId: machine.id }, orderBy: [{ at: 'desc' }, { id: 'desc' }], take: 20, select: EVENT_SELECT })
    return {
      from: toUtcIso(from),
      to: toUtcIso(to),
      now: toUtcIso(serverClock.now()),
      registeredAt: toUtcIso(machine.createdAt),
      before: before ? { status: before.toStatus as MachineStatus, reason: before.reason } : null,
      current: { status: machine.status as MachineStatus, reason: machine.statusReason, since: toUtcIso(machine.statusSince) },
      events: events.map(eventView),
      latest: latest.map(eventView),
    }
  })
}
