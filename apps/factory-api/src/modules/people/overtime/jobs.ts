import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSettings } from '../../../core/command'
import { defineHandler, type EventHandler } from '../../../platform/outbox/dispatch'
import { dayOf } from '../employees/access'
import { lockPerson } from '../attendance/compute'
import { personOf } from '../attendance/store'
import { entriesWouldChange, syncEntriesInCommand } from './sync'

/**
 * Overtime computed in the background (B-W2b-42; MES-229): the worker's handler after an attendance day changed, a system
 * command only when the entries would change (read first). A computation records; approving is a person's.
 *
 *   handler people.overtimeEntries   attendance.day_changed → that day's overtime entries in step (key
 *                                    `overtime-entries:<event id>`)
 *
 * background.ts lists it (one handler line). The day's own computation is B-W2b-37's cron and handler: every change it
 * makes emits attendance.day_changed, so no cron of this step's is needed.
 */

class NoChange extends Error {}

/** One person's day: its entries in step, in its own system command when they would change. */
export async function computeEntriesNow(caller: CommandCaller, settings: CommandSettings, tenantId: string, employeeId: string, date: BusinessDate, key?: string): Promise<boolean> {
  const person = await caller.withClient((db) => personOf(db, employeeId))
  if (!person) return false
  if (!(await caller.withClient((db) => entriesWouldChange(db, person, date, settings.clock.now())))) return false
  try {
    await runCommand(
      caller,
      { name: 'people.computeOvertimeEntries', idempotencyKey: key, input: { employeeId, date } },
      async (tools) => {
        await lockPerson(tools.tx, tenantId, employeeId)
        const changed = await syncEntriesInCommand(tools, person, date)
        if (changed === 0) throw new NoChange()
        return { changed }
      },
      settings,
    )
    return true
  } catch (error) {
    if (error instanceof NoChange) return false
    throw error
  }
}

export function overtimeHandlers(): EventHandler[] {
  return [
    defineHandler({
      name: 'people.overtimeEntries',
      events: ['attendance.day_changed'],
      async handle(event, { caller }) {
        const payload = event.payload as { dayId: string; employeeId: string }
        const day = await caller.withClient((db) => db.attendanceDay.findUnique({ where: { id: payload.dayId }, select: { date: true } }))
        if (day) await computeEntriesNow(caller, COMMAND_SETTINGS, event.tenantId, payload.employeeId, dayOf(day.date), `overtime-entries:${event.eventId}`)
      },
    }),
  ]
}

