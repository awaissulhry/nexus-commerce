import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { syncBundleInCommand } from './scans'
import { PayFacts, SCAN_SELECT } from './store'

/**
 * Earnings in the background (B-W2b-43; MES-256, MES-264): the worker's handlers, a system command only where there is
 * something to do (read first: a site whose switch never went ON costs one read per scan and writes nothing).
 *
 *   people.earningsFromScan      production.scan_recorded, production.operation_timed (a PARTIAL: the pieces done so far) →
 *                                that bundle at that operation in step: one entry per paid scan, a hold when the worker was
 *                                not clocked in, a reversal when a scan was undone or corrected
 *   people.heldScansAfterClock   attendance.day_changed → the person's open holds of that day looked at again: a late
 *                                clock event or HR's fix shows them clocked in, so they count
 * background.ts lists them (one handler line). No cron: a missed event is put right by the period's run.
 */

class NoChange extends Error {}

/** One bundle at one operation in step, in its own system command. */
export async function earnBundleNow(caller: CommandCaller, input: { readonly bundleId: string; readonly workOrderOperationId: string; readonly siteId: string }, key?: string): Promise<boolean> {
  const windows = await caller.withClient(async (db) => (await db.piecePaySwitch.findFirst({ where: { siteId: input.siteId }, select: { onFrom: true, earlierWindows: true } })) ?? null)
  if (!windows || (windows.onFrom === null && (windows.earlierWindows as unknown[]).length === 0)) return false
  try {
    await runCommand(
      caller,
      { name: 'people.recordEarnings', idempotencyKey: key, input: { bundleId: input.bundleId, workOrderOperationId: input.workOrderOperationId } },
      async (tools) => {
        const moved = await syncBundleInCommand(tools, new PayFacts(tools.tx, tools.now), input)
        if (moved.added + moved.reversed + moved.held + moved.released === 0) throw new NoChange()
        return moved
      },
      COMMAND_SETTINGS,
    )
    return true
  } catch (error) {
    if (error instanceof NoChange) return false
    throw error
  }
}

export function earningsHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'people.earningsFromScan',
      events: ['production.scan_recorded', 'production.operation_timed'],
      async handle(event, { caller }) {
        const payload = event.payload as { bundleId: string; operationId: string; kind: string }
        const siteId = event.siteId
        // START, PAUSE, RESUME and HAND_BACK are time, never pieces.
        if (!siteId || (event.type === 'production.operation_timed' && payload.kind !== 'PARTIAL')) return
        await earnBundleNow(caller, { bundleId: payload.bundleId, workOrderOperationId: payload.operationId, siteId }, `earnings-scan:${event.eventId}`)
      },
    }),
    defineHandler({
      name: 'people.heldScansAfterClock',
      events: ['attendance.day_changed'],
      async handle(event, { caller }) {
        const payload = event.payload as { employeeId: string; dayId: string }
        const open = await caller.withClient(async (db) => {
          const holds = await db.heldScan.findMany({ where: { employeeId: payload.employeeId, status: 'OPEN' }, select: { operationScanId: true } })
          return holds.length === 0 ? [] : db.operationScan.findMany({ where: { id: { in: holds.map((row) => row.operationScanId) } }, select: SCAN_SELECT })
        })
        const seen = new Set<string>()
        for (const scan of open) {
          const pair = `${scan.bundleId}|${scan.workOrderOperationId}`
          if (seen.has(pair)) continue
          seen.add(pair)
          await earnBundleNow(caller, { bundleId: scan.bundleId, workOrderOperationId: scan.workOrderOperationId, siteId: scan.siteId }, `earnings-clock:${event.eventId}:${seen.size}`)
        }
      },
    }),
  ]
}
