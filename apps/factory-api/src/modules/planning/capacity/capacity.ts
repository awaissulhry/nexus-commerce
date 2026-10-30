import { daysFrom } from '@nexus/factory-domain/calendars/dates'
import { NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { readSettings } from '../settings/store'
import { CAPACITY_MAX_DAYS, type CapacityCellQuery, type CapacityQuery } from './contract'
import { capacityAnswer, capacityWorld, cellAnswer, periodOf } from './service'

/**
 * Capacity & load (B-W2a-16; PLN-115, PLN-116; design planning.capacity, SCR-123): planning.view over the site's company
 * and the site. Reads only; the numbers are counted on every read from the lanes' capacity rows, the calendars and the
 * open work orders (./service), so a calendar, capacity or work order change shows at the next read (the screens
 * listen to calendar.changed, planning.capacity_changed and the work order events).
 */

/** planning.view: every lane's available, booked and load per bucket over the period, and the tiles. */
export async function capacity(caller: CommandCaller, query: CapacityQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  return caller.withClient(async (client) => {
    const period = periodOf(await readSettings(client, site.id), today, query)
    const world = await capacityWorld(client, site, period, today)
    return { ...capacityAnswer(world, period), bucket: period.bucket, asOf: toUtcIso(now) }
  })
}

/** planning.view: the work orders' operations booked on one lane between two days (the cell's DetailModal). */
export async function capacityCell(caller: CommandCaller, query: CapacityCellQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  if (query.to < query.from) throw new ValidationError('The days end before they start.', [{ path: 'querystring/to', message: 'Give a last day on or after the first.' }])
  if (daysFrom(query.from, query.to) + 1 > CAPACITY_MAX_DAYS) throw new ValidationError(`A capacity question covers at most ${CAPACITY_MAX_DAYS} days.`, [{ path: 'querystring/to', message: `At most ${CAPACITY_MAX_DAYS} days from the first.` }])
  const today = businessDate(serverClock.now(), site.timezone)
  return caller.withClient(async (client) => {
    const world = await capacityWorld(client, site, { from: query.from, to: query.to }, today)
    const state = world.lanes.find((lane) => lane.lane.kind === query.laneKind && lane.lane.id === query.laneId)
    if (!state) throw new NotFoundError(`${query.laneKind === 'LINE' ? 'Line' : 'Work centre'} not found on this site.`)
    return cellAnswer(world, state, query.from, query.to)
  })
}
