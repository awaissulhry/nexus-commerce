import { newId } from '@nexus/factory-domain/core/ids'
import { CLOCK_OUT_PAUSE, clockOutClientId, openStretchOf, sameSubject, stretchesOf, type TimingSubject } from '@nexus/factory-domain/production/terminal/rules'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { lockBundleScans, readHeader, readOperations, scanWorkOrderLock } from '../scans/store'
import { hasAcknowledgedNotice } from '../settings/subject'
import { openWorkOf, timedEvent } from './timing'
import { readOperationRows, readRow } from './store'

/**
 * Open work paused at clock-out (B-W2b-40; MES-117; design floor.clock "Open work": "Clock-out pauses open operations; the
 * next sign-in offers to continue"). The worker's handler `production.pauseAtClockOut` listens to `clock.out` (B-W2b-33:
 * a clock-out on the floor, kept offline, or the automatic one at the shift end) and, in ONE system command keyed
 * `clock-out:<clock event>`, pauses every stretch of that person that RUNS at the clock event's site and started before
 * the clock-out's moment: a PAUSE with the system's code CLOCK_OUT naming the stretch's worker and station, no device,
 * the clock-out's moment as its time (ClockEvent.occurredAt; the minutes stop there), audited and announced
 * (production.operation_timed, postedBy SYSTEM). Paused work stays paused (it already stopped); work started after the
 * clock-out's moment is left alone (offline clock-outs arrive late). Re-read under each bundle's locks: a stretch closed
 * or paused meanwhile is skipped. Safe to repeat: a repeat answers from the receipt, or finds nothing running.
 *
 * Where the site records the station only, timing names no worker: a person's clock-out pauses nothing there (named).
 * A worker who has not acknowledged a worker notice published since they started is not named on a new row by the
 * database (Statuto art. 4 c.3): their stretch is left running and counted in `skipped` (the lead sees it on the floor).
 */

export interface ClockOutPayload {
  readonly clockEventId: string
  readonly siteId: string
  readonly employeeId: string
  readonly workerId: string | null
  readonly source: string
}

/** Pauses the person's running work at the clock-out; answers how many stretches were paused and skipped. */
export async function pauseAtClockOut(caller: CommandCaller, payload: ClockOutPayload, cause: { readonly causationId?: string } = {}): Promise<{ readonly paused: number; readonly skipped: number }> {
  const context = caller.factoryContext
  if (!context || context.audience !== 'system') return { paused: 0, skipped: 0 }
  const tenantId = context.tenantId
  const found = await caller.withClient(async (db) => {
    const clock = await db.clockEvent.findUnique({ where: { id: payload.clockEventId }, select: { occurredAt: true, siteId: true, employeeId: true, workerId: true } })
    if (!clock) return null
    const settings = await db.productionSettings.findUnique({ where: { id: clock.siteId }, select: { scanSubject: true } })
    if (settings?.scanSubject === 'STATION') return null
    const workerIds = clock.workerId ? [clock.workerId] : (await db.worker.findMany({ where: { employeeId: clock.employeeId, siteId: clock.siteId }, select: { id: true } })).map((row) => row.id)
    const now = serverClock.now()
    const open = []
    for (const workerId of workerIds) {
      const subject: TimingSubject = { workerId, stationId: null }
      for (const entry of await openWorkOf(db, clock.siteId, subject, now)) {
        const running = entry.stretch.runs.find((run) => run.to === null)
        if (entry.stretch.open === 'RUNNING' && running && running.from.getTime() <= clock.occurredAt.getTime()) open.push({ ...entry, workerId })
      }
    }
    return { clock, open }
  })
  if (!found || found.open.length === 0) return { paused: 0, skipped: 0 }
  const { clock } = found
  // Locks in one order (work order, then bundle): two clock-outs of a crew never wait on each other in a circle.
  const ordered = [...found.open].sort((a, b) => a.workOrderId.localeCompare(b.workOrderId) || a.bundleId.localeCompare(b.bundleId) || a.workOrderOperationId.localeCompare(b.workOrderOperationId))
  const { result } = await command(
    caller,
    { name: 'production.pauseAtClockOut', idempotencyKey: `clock-out:${payload.clockEventId}`, input: { clockEventId: payload.clockEventId, stretches: ordered.map((entry) => entry.stretch.startedBy) }, ...(cause.causationId ? { causationId: cause.causationId } : {}) },
    async (tools) => {
      const { tx } = tools
      let paused = 0
      let skipped = 0
      let n = 0
      for (const entry of ordered) {
        n += 1
        await scanWorkOrderLock(tx, tenantId, entry.workOrderId)
        const header = await readHeader(tx, entry.workOrderId)
        if (!header) continue
        await lockBundleScans(tx, tenantId, header.siteId, entry.bundleId)
        const rows = await readOperationRows(tx, entry.bundleId, entry.workOrderOperationId)
        const open = openStretchOf(stretchesOf(rows))
        const last = rows.at(-1)
        if (!open || open.open !== 'RUNNING' || !sameSubject(open, { workerId: entry.workerId, stationId: null }) || !last) continue
        if (!(await hasAcknowledgedNotice(tx, header.siteId, entry.workerId))) {
          skipped += 1
          continue
        }
        const id = newId()
        await tx.operationScan.create({
          data: {
            id,
            siteId: header.siteId,
            workOrderId: header.id,
            workOrderOperationId: entry.workOrderOperationId,
            bundleId: entry.bundleId,
            kind: 'PAUSE',
            pauseReasonCode: CLOCK_OUT_PAUSE,
            reason: 'Paused at clock-out.',
            workerId: entry.workerId,
            stationId: last.stationId,
            deviceId: null,
            clientScanId: clockOutClientId(payload.clockEventId, n),
            // The moment the work stopped: the clock-out's (the minutes stop there); the server's time orders the row.
            deviceTime: clock.occurredAt,
            serverTime: tools.now,
            createdById: null,
          },
          select: { id: true },
        })
        const row = (await readRow(tx, id))!
        const operation = (await readOperations(tx, header.id)).find((candidate) => candidate.id === entry.workOrderOperationId)
        tools.audit({ action: 'production.pauseAtClockOut', recordType: 'OperationScan', recordId: id, companyId: header.companyId, siteId: header.siteId, after: { clockEventId: payload.clockEventId, workOrderId: header.id, bundleId: entry.bundleId, operationId: entry.workOrderOperationId, kind: 'PAUSE', pauseReasonCode: CLOCK_OUT_PAUSE, workerId: entry.workerId, stationId: last.stationId }, reason: 'Paused at clock-out.' })
        tools.emit(timedEvent(header, row, operation?.seq ?? 0, 0, 'SYSTEM'))
        paused += 1
      }
      // Every command keeps one audit row: nothing paused (closed meanwhile, or a notice not acknowledged) is said on the clock event.
      if (paused === 0) tools.audit({ action: 'production.pauseAtClockOut', recordType: 'ClockEvent', recordId: payload.clockEventId, siteId: clock.siteId, after: { paused, skipped } })
      return { paused, skipped }
    },
  )
  return result
}

/** The worker's handler (listed in background.ts): a clock-out pauses the person's running work. Safe to repeat. */
export function pauseAtClockOutHandler(): EventHandler {
  return defineHandler({
    name: 'production.pauseAtClockOut',
    events: ['clock.out'],
    async handle(event, { caller }) {
      await pauseAtClockOut(caller, event.payload as ClockOutPayload, { causationId: event.eventId })
    },
  })
}
