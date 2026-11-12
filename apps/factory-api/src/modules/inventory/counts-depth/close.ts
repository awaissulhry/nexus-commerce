import type { ItemKind } from '@nexus/factory-db'
import { businessDate } from '@nexus/factory-domain/core/time'
import { itemsOfClass } from '@nexus/factory-domain/inventory/counts-depth/abc'
import { countCovers, nextDueAfter, type AbcClass, type KeyFacts } from '@nexus/factory-domain/inventory/counts-depth/schedules'
import { OPEN_TASK_STATUSES } from '@nexus/factory-domain/inventory/tasks/rules'
import type { CommandTools } from '../../../core/command'
import { balancesAt, siteLocations, subtreeOf } from '../counts/ledger-at'
import type { CountRow } from '../counts/store'
import { doneInCommand } from '../tasks/lifecycle'
import { TASK_COLUMNS } from '../tasks/store'
import { classesOfSite } from './abc'
import { auditedSchedule, dayColumn, lockSchedule, SCHEDULE_COLUMNS, scheduleChanged } from './store'

/**
 * A count closes, its schedules move on (B-W2b-299; SCM-227 "the next date is set when a count closes"): called by the counts'
 * apply (../counts/counts.ts, one line marked B-W2b-299) in its own command. Its own file: the counts import it, and
 * ./schedules.ts imports the counts (its "Start count" is the counts' own create).
 */

const OPEN_TASKS = [...OPEN_TASK_STATUSES]

const lineKey = (line: KeyFacts): KeyFacts => ({ locationId: line.locationId, itemId: line.itemId, itemColourId: line.itemColourId, lotId: line.lotId, hideId: line.hideId })

/**
 * In the counts' apply command, once the count is APPLIED: every active schedule of its site the count covered (every stock
 * key the schedule's scope held at the count's snapshot is a line of it) gets the count as its last one, the day as its last
 * counted day and its next date that day plus its days; its open COUNT task is done by who applied the count.
 */
export async function closeSchedulesInCommand(tools: CommandTools, count: CountRow): Promise<string[]> {
  const { tx } = tools
  if (count.status !== 'APPLIED' || !count.snapshotAt) return []
  const schedules = await tx.countSchedule.findMany({ where: { siteId: count.siteId, active: true }, select: SCHEDULE_COLUMNS, orderBy: [{ id: 'asc' }] })
  if (schedules.length === 0) return []
  const tree = await siteLocations(tx, count.siteId)
  const countPlaces = count.locationId ? subtreeOf(tree, count.locationId) : null
  const candidates = schedules.filter((schedule) => !countPlaces || (schedule.locationId !== null && countPlaces.has(schedule.locationId)))
  if (candidates.length === 0) return []
  const lines = (await tx.stockCountLine.findMany({ where: { countId: count.id }, select: { locationId: true, itemId: true, itemColourId: true, lotId: true, hideId: true } })).map(lineKey)
  const classes = candidates.some((schedule) => schedule.abcClass !== null) ? await classesOfSite(tx, count.siteId, tools.now) : []
  const today = businessDate(tools.now)
  const moved: string[] = []
  for (const schedule of candidates) {
    const places = schedule.locationId ? subtreeOf(tree, schedule.locationId) : null
    const balances = await balancesAt(tx, { siteId: count.siteId, locationIds: places, itemKind: (schedule.itemKind as ItemKind | null) ?? null }, count.snapshotAt)
    const inClass = schedule.abcClass ? itemsOfClass(classes, schedule.abcClass as AbcClass) : null
    const keys = balances.filter((balance) => balance.onHand.greaterThan(0) && (!inClass || inClass.has(balance.itemId))).map((balance) => lineKey({ locationId: balance.locationId, itemId: balance.itemId, itemColourId: balance.itemColourId ?? null, lotId: balance.lotId ?? null, hideId: balance.hideId ?? null }))
    const scopeContains = count.itemId === null && count.lotId === null && (count.itemKind === null || count.itemKind === schedule.itemKind) && (!countPlaces || (schedule.locationId !== null && countPlaces.has(schedule.locationId)))
    if (!countCovers(keys, lines, scopeContains)) continue
    const row = await lockSchedule(tx, schedule.id)
    const after = await tx.countSchedule.update({
      where: { id: row.id },
      data: { lastCountedOn: dayColumn(today), lastCountId: count.id, nextDueOn: dayColumn(nextDueAfter(today, row.everyDays)), version: { increment: 1 }, updatedAt: tools.now },
      select: SCHEDULE_COLUMNS,
    })
    tools.audit({ action: 'inventory.countSchedules.counted', recordType: 'CountSchedule', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: auditedSchedule(row), after: auditedSchedule(after), reason: `Count ${count.number} covered it.` })
    scheduleChanged(tools, after, 'COUNTED', count.id)
    if (tools.context.audience === 'office') {
      const actor = { kind: 'USER' as const, id: tools.context.actorId }
      for (const task of await tx.warehouseTask.findMany({ where: { kind: 'COUNT', status: { in: OPEN_TASKS }, sourceType: 'CountSchedule', sourceId: row.id }, select: TASK_COLUMNS })) await doneInCommand(tools, task, actor)
    }
    moved.push(row.id)
  }
  return moved
}
