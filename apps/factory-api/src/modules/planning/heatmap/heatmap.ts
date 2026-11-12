import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { cellText, DEFAULT_WEEKS, heatBand, LEGEND, MAX_WEEKS } from '@nexus/factory-domain/planning/heatmap/bands'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { uniformBuckets, weekStart } from '@nexus/factory-domain/planning/settings/buckets'
import { amountText } from '@nexus/factory-domain/planning/subcontract-capacity/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { siteFor } from '../access'
import { capacityAnswer, capacityWorld } from '../capacity/service'
import { subcontractorWorld } from '../capacity/subcontractors'

/**
 * The load heatmap (B-W2b-321; PLN-117; design planning.capacity › Load heatmap: "Lanes down, weeks across, cells coloured
 * by % load with the number in each cell"; "Click a cell = the same DetailModal"):
 *
 *   GET /planning/heatmap?siteId&from&weeks   every line and work centre of the site (B-W2a-16's capacity, the same
 *       numbers as Capacity & load) and every workshop capacity line (this step's), by week from the Monday of `from`
 *       (default: this week) for `weeks` weeks (default 8, at most 26): per cell the load %, its band (factory-domain
 *       planning/heatmap/bands) and the text the cell writes ("112%", "—"), with the numbers behind it; the cell's detail
 *       is GET /planning/capacity/cell (a line or work centre) or GET /planning/capacity/subcontractors/cell (a workshop)
 *
 * planning.view over the site. No money, no person.
 */

export async function heatmap(caller: CommandCaller, query: { readonly siteId: string; readonly from?: BusinessDate | undefined; readonly weeks?: number | undefined }) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const weeks = query.weeks ?? DEFAULT_WEEKS
  if (!Number.isSafeInteger(weeks) || weeks < 1 || weeks > MAX_WEEKS) throw new ValidationError(`From 1 to ${MAX_WEEKS} weeks.`, [{ path: 'querystring/weeks', message: `At most ${MAX_WEEKS}.` }])
  const now = serverClock.now()
  const today = businessDate(now, site.timezone)
  const from = weekStart(query.from ?? today)
  const to = plusDays(from, weeks * 7 - 1)
  const buckets = uniformBuckets(from, to, 'WEEK')
  return caller.withClient(async (db) => {
    const world = await capacityWorld(db, site, { from, to }, today)
    const answer = capacityAnswer(world, { from, to, buckets })
    const workshops = await subcontractorWorld(db, site, buckets, today)
    const cell = (key: string, cellFrom: BusinessDate, cellTo: BusinessDate, loadPct: string | null, available: string | null, booked: string, over: boolean) => ({ key, from: cellFrom, to: cellTo, loadPct, band: heatBand(loadPct), text: cellText(loadPct), available, booked, over })
    const lanes = [
      ...answer.lanes.map((lane) => ({
        kind: lane.kind,
        id: lane.id,
        code: lane.code,
        name: lane.name,
        workCentreKind: lane.workCentreKind,
        unit: 'MINUTES' as const,
        cells: lane.cells.map((entry) => cell(entry.key, entry.from, entry.to, entry.loadPct, entry.availableMinutes, entry.bookedMinutes, Number(entry.overMinutes) > 0)),
      })),
      ...workshops.lines.map((line) => ({
        kind: 'WORKSHOP' as const,
        id: line.workshop.id,
        code: line.workshop.code,
        name: line.workshop.name,
        workCentreKind: line.key?.workCentreKind ?? null,
        unit: line.key?.unit ?? null,
        cells: line.cells.map((entry) => cell(entry.key, entry.from, entry.to, entry.loadPct, entry.known ? amountText(entry.available) : null, amountText(entry.booked), entry.over)),
      })),
    ]
    return {
      site: { id: site.id, companyId: site.companyId, code: site.code, name: site.name, timeZone: site.timezone },
      from,
      to,
      today,
      asOf: toUtcIso(now),
      weeks: buckets.map((bucket) => ({ key: bucket.key, from: bucket.from, to: bucket.to })),
      lanes,
      legend: LEGEND.map((entry) => ({ band: entry.band, words: entry.words })),
      counts: { cellsOver: lanes.reduce((sum, lane) => sum + lane.cells.filter((entry) => entry.band === 'OVER').length, 0), lanesOver: lanes.filter((lane) => lane.cells.some((entry) => entry.band === 'OVER')).length },
    }
  })
}
