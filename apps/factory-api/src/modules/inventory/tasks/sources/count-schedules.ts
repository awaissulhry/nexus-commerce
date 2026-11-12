import { createHash } from 'node:crypto'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import { scheduleDue } from '@nexus/factory-domain/inventory/tasks/sources'
import { command, type CommandCaller } from '../../../../core/command'
import type { Reader } from '../../issue/store'
import { cancelInCommand, createTaskInCommand } from '../lifecycle'
import { derivedKey, type TimedTaskSource } from '../source-kit'
import { TASK_COLUMNS } from '../store'

/**
 * A due count makes a COUNT task (B-W2b-292; SCM-274; SCM-227's schedules are B-W2b-299's): every hour the scheduler gives each
 * active count schedule due today or earlier (Europe/Rome; CountSchedule.nextDueOn) one open COUNT task (source
 * CountSchedule), at its place when it names one, due at the start of its day; a schedule no longer due (counted and moved on,
 * or retired) has its open task cancelled. ONE system command per tenant and hour when something changes.
 */

const OPEN = [...OPEN_TASK_STATUSES]
const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

export const countSchedules: TimedTaskSource = Object.freeze({
  name: 'countSchedules',
  async tick(caller: CommandCaller, now: Date) {
    const today = businessDate(now)
    const read = await caller.withClient(async (client) => {
      const db = client as unknown as Reader
      const due = await db.countSchedule.findMany({ where: { active: true, nextDueOn: { lte: new Date(`${today}T00:00:00.000Z`) } }, select: { id: true, companyId: true, siteId: true, name: true, locationId: true, nextDueOn: true, active: true }, orderBy: [{ nextDueOn: 'asc' }, { id: 'asc' }] })
      const open = await db.warehouseTask.findMany({ where: { kind: 'COUNT', status: { in: OPEN }, sourceType: 'CountSchedule' }, select: { id: true, sourceId: true } })
      const withTask = new Set(open.map((row) => row.sourceId))
      const make = due.filter((schedule) => scheduleDue({ active: schedule.active, nextDueOn: dayOf(schedule.nextDueOn) }, today) && !withTask.has(schedule.id))
      const dueIds = new Set(due.map((schedule) => schedule.id))
      const stale = open.filter((row) => row.sourceId !== null && !dueIds.has(row.sourceId))
      return { make, stale }
    })
    if (read.make.length === 0 && read.stale.length === 0) return { made: 0, cancelled: 0 }
    const { result } = await command(caller, { name: 'inventory.warehouseTaskSource', idempotencyKey: derivedKey('task-source.countSchedules', createHash('sha256').update(JSON.stringify([today, read.make.map((row) => row.id), read.stale.map((row) => row.id)])).digest('hex').slice(0, 48)), input: { source: 'countSchedules', today, make: read.make.map((row) => row.id), stale: read.stale.map((row) => row.id) } }, async (tools) => {
      let made = 0
      let cancelled = 0
      for (const schedule of read.make) {
        const open = await tools.tx.warehouseTask.count({ where: { kind: 'COUNT', status: { in: OPEN }, sourceType: 'CountSchedule', sourceId: schedule.id } })
        if (open > 0) continue
        await createTaskInCommand(tools, { companyId: schedule.companyId, siteId: schedule.siteId, kind: 'COUNT', source: { type: 'CountSchedule', id: schedule.id }, fromLocationId: schedule.locationId, dueAt: businessDayStart(dayOf(schedule.nextDueOn)), note: schedule.name })
        made++
      }
      for (const { id } of read.stale) {
        const row = await tools.tx.warehouseTask.findUniqueOrThrow({ where: { id }, select: TASK_COLUMNS })
        if (row.status !== 'OPEN' && row.status !== 'TAKEN') continue
        await cancelInCommand(tools, row, 'No longer due: the count schedule moved on or was retired.')
        cancelled++
      }
      if (made + cancelled === 0) tools.audit({ action: 'inventory.warehouseTaskSource', recordType: 'CountSchedule', recordId: read.make[0]?.id ?? read.stale[0]!.id, after: { countTasks: 'unchanged' } })
      return { made, cancelled }
    })
    return result
  },
})
