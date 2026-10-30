import type { Prisma } from '@nexus/factory-db'
import { workingTimeOf } from '@nexus/factory-domain/calendars/working-time'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, businessDayStart, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { actualWeek, earnedByLine } from '@nexus/factory-domain/planning/capacity/actual'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { uniformBuckets, weekStart } from '@nexus/factory-domain/planning/settings/buckets'
import { PLANNING_SETTINGS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import { efficiencyPctOf } from '@nexus/factory-domain/planning/settings/settings'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { workingCalendarsFor, ownerKey } from '../../../platform/calendars/service'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import type { EditLineCapacityBody, EditWorkCentreCapacityBody, LaneView } from './contract'
import { defaultEfficiencyOf, pct, readSettings, siteViewOf, storedAnswer, type SettingsRow } from './store'

/**
 * The lanes of a site for planning (B-W2a-16; PLN-014 line efficiency, PLN-115 capacity per line and work centre;
 * design planning.settings "Line efficiency"): each ACTIVE line with its planned efficiency and people per shift (a
 * headcount, never who: Statuto dei Lavoratori art. 4), each ACTIVE work centre with its units and efficiency, what
 * applies without a row of its own (the site's default efficiency; one per active station), and a line's actual
 * efficiency over the last four whole weeks: the standard minutes of the good whole garments its stations reported
 * (standing scans, per line only, never per person or station) over people × its working minutes. Read with
 * planning.view, kept with planning.settings.manage over the lane's company and site. The capacity row has the lane's
 * own id: the first save makes it; a change is ONE command on it (its version bump locks it), audited, with
 * planning.capacity_changed.
 */

type LaneKind = 'LINE' | 'WORK_CENTRE'

const LINE_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, status: true } as const satisfies Prisma.LineSelect
const CENTRE_SELECT = { id: true, companyId: true, siteId: true, code: true, name: true, kind: true, status: true } as const satisfies Prisma.WorkCentreSelect
const LINE_CAPACITY_SELECT = { id: true, plannedEfficiencyPct: true, operators: true, note: true, version: true, updatedAt: true } as const satisfies Prisma.LineCapacitySelect
const CENTRE_CAPACITY_SELECT = { id: true, plannedEfficiencyPct: true, units: true, note: true, version: true, updatedAt: true } as const satisfies Prisma.WorkCentreCapacitySelect

/** A lane's capacity row, the same shape for both kinds. */
export interface CapacityRow {
  readonly id: string
  readonly plannedEfficiencyPct: string
  readonly people: number | null
  readonly note: string | null
  readonly version: number
  readonly updatedAt: Date
}

export interface LaneFacts {
  readonly kind: LaneKind
  readonly id: string
  readonly companyId: string
  readonly siteId: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: string | null
  readonly status: string
  /** Active stations. */
  readonly stations: number
  /** The work centres of its active stations (a line). */
  readonly workCentreIds: readonly string[]
  readonly row: CapacityRow | null
}

const lineRowOf = (row: Prisma.LineCapacityGetPayload<{ select: typeof LINE_CAPACITY_SELECT }>): CapacityRow => ({ id: row.id, plannedEfficiencyPct: pct(row.plannedEfficiencyPct), people: row.operators, note: row.note, version: row.version, updatedAt: row.updatedAt })
const centreRowOf = (row: Prisma.WorkCentreCapacityGetPayload<{ select: typeof CENTRE_CAPACITY_SELECT }>): CapacityRow => ({ id: row.id, plannedEfficiencyPct: pct(row.plannedEfficiencyPct), people: row.units, note: row.note, version: row.version, updatedAt: row.updatedAt })

/** Every ACTIVE line and work centre of a site (or the ones named), with stations and capacity rows. One query after another. */
export async function readLanes(db: Reader, siteId: string, only?: { readonly kind: LaneKind; readonly id: string }): Promise<{ lines: LaneFacts[]; workCentres: LaneFacts[] }> {
  const lineWhere: Prisma.LineWhereInput = only ? (only.kind === 'LINE' ? { id: only.id } : { id: { in: [] } }) : { siteId, status: 'ACTIVE' }
  const centreWhere: Prisma.WorkCentreWhereInput = only ? (only.kind === 'WORK_CENTRE' ? { id: only.id } : { id: { in: [] } }) : { siteId, status: 'ACTIVE' }
  const lines = await db.line.findMany({ where: lineWhere, select: LINE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const centres = await db.workCentre.findMany({ where: centreWhere, select: CENTRE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const stations = await db.station.findMany({ where: { siteId, status: 'ACTIVE' }, select: { id: true, lineId: true, workCentreId: true } })
  const lineRows = lines.length ? await db.lineCapacity.findMany({ where: { id: { in: lines.map((line) => line.id) } }, select: LINE_CAPACITY_SELECT }) : []
  const centreRows = centres.length ? await db.workCentreCapacity.findMany({ where: { id: { in: centres.map((centre) => centre.id) } }, select: CENTRE_CAPACITY_SELECT }) : []
  const lineRow = new Map(lineRows.map((row) => [row.id, lineRowOf(row)]))
  const centreRow = new Map(centreRows.map((row) => [row.id, centreRowOf(row)]))
  return {
    lines: lines.map((line) => {
      const own = stations.filter((station) => station.lineId === line.id)
      return { kind: 'LINE', ...line, workCentreKind: null, stations: own.length, workCentreIds: [...new Set(own.map((station) => station.workCentreId))].sort(), row: lineRow.get(line.id) ?? null }
    }),
    workCentres: centres.map((centre) => ({
      kind: 'WORK_CENTRE',
      id: centre.id,
      companyId: centre.companyId,
      siteId: centre.siteId,
      code: centre.code,
      name: centre.name,
      status: centre.status,
      workCentreKind: centre.kind,
      stations: stations.filter((station) => station.workCentreId === centre.id).length,
      workCentreIds: [],
      row: centreRow.get(centre.id) ?? null,
    })),
  }
}

/** What a lane plans with: its own efficiency and people, else the site's default and its active stations. */
export function effectiveOf(lane: LaneFacts, settings: SettingsRow | null) {
  const fallback = defaultEfficiencyOf(settings)
  return {
    efficiencyPct: lane.row?.plannedEfficiencyPct ?? fallback.efficiencyPct,
    efficiencySource: lane.row ? ('LANE' as const) : fallback.source,
    people: lane.row?.people ?? lane.stations,
    peopleSource: lane.row?.people != null ? ('CAPACITY' as const) : ('STATIONS' as const),
  }
}

export interface ActualWeek {
  readonly week: string
  readonly from: BusinessDate
  readonly to: BusinessDate
  readonly earnedMinutes: string
  readonly availableMinutes: string
  readonly pct: string | null
}

/**
 * The lines' actual efficiency over the four whole weeks before today's (oldest first): earned standard minutes (the
 * good garments of whole-garment bundles in the standing REPORT and CORRECTION scans their stations sent that week ×
 * the operation's frozen standard minutes) over people × the line's working minutes. Per line only: no scan is read
 * with its worker, nothing is kept or shown per station.
 */
export async function actualEfficiencyOf(db: Reader, site: SiteRow, lines: readonly LaneFacts[], settings: SettingsRow | null, today: BusinessDate): Promise<Map<string, ActualWeek[]>> {
  const out = new Map<string, ActualWeek[]>()
  if (lines.length === 0) return out
  const monday = weekStart(today)
  const from = plusDays(monday, -28)
  const to = plusDays(monday, -1)
  const weeks = uniformBuckets(from, to, 'WEEK')
  const calendars = await workingCalendarsFor(db, lines.map((line) => ({ scope: 'LINE' as const, id: line.id })), { from, to })
  const scans = await db.operationScan.findMany({
    where: { siteId: site.id, serverTime: { gte: businessDayStart(from, site.timezone) } },
    // Never the worker: per line only.
    select: { id: true, kind: true, bundleId: true, workOrderOperationId: true, correctsId: true, goodQuantity: true, stationId: true, serverTime: true },
    orderBy: [{ serverTime: 'asc' }, { id: 'asc' }],
  })
  const end = businessDayStart(monday, site.timezone).getTime()
  const counting = scans.filter((scan) => scan.serverTime.getTime() < end)
  const ids = (values: (string | null)[]) => [...new Set(values.filter((value): value is string => value !== null))]
  const bundles = counting.length ? await db.bundle.findMany({ where: { id: { in: ids(counting.map((scan) => scan.bundleId)) } }, select: { id: true, part: true, status: true } }) : []
  const operations = counting.length ? await db.workOrderOperation.findMany({ where: { id: { in: ids(counting.map((scan) => scan.workOrderOperationId)) } }, select: { id: true, standardMinutes: true } }) : []
  const stations = counting.length ? await db.station.findMany({ where: { id: { in: ids(counting.map((scan) => scan.stationId)) } }, select: { id: true, lineId: true } }) : []
  const earned = earnedByLine({
    // The voiding rows are later than the rows they void, so every one that matters was read with them.
    scans: scans.map((scan) => ({ id: scan.id, kind: scan.kind, correctsId: scan.correctsId, bundleId: scan.bundleId, operationId: scan.workOrderOperationId, good: scan.serverTime.getTime() < end ? scan.goodQuantity : 0, stationId: scan.stationId, at: scan.serverTime })),
    bundles: new Map(bundles.map((bundle) => [bundle.id, bundle])),
    standardMinutes: new Map(operations.map((operation) => [operation.id, operation.standardMinutes.toString()])),
    lineOfStation: new Map(stations.map((station) => [station.id, station.lineId])),
    weeks,
    timeZone: site.timezone,
  })
  for (const line of lines) {
    const calendar = calendars.get(ownerKey({ scope: 'LINE', id: line.id }))
    const people = effectiveOf(line, settings).people
    out.set(
      line.id,
      weeks.map((week) => ({
        week: week.key,
        from: week.from,
        to: week.to,
        ...actualWeek(earned.get(`${line.id}|${week.key}`) ?? new Dec(0), people, calendar ? (workingTimeOf(calendar.calendar, week.from, week.to).minutes ?? 0) : 0),
      })),
    )
  }
  return out
}

export function laneViewOf(lane: LaneFacts, settings: SettingsRow | null, actual: ActualWeek[] | null): LaneView {
  return {
    kind: lane.kind,
    id: lane.id,
    code: lane.code,
    name: lane.name,
    workCentreKind: lane.workCentreKind,
    stations: lane.stations,
    capacity: lane.row ? { plannedEfficiencyPct: lane.row.plannedEfficiencyPct, people: lane.row.people, note: lane.row.note, version: lane.row.version, updatedAt: toUtcIso(lane.row.updatedAt) } : null,
    effective: effectiveOf(lane, settings),
    actual,
  }
}

/** planning.view: the site's lines (with their actual efficiency) and work centres, as the settings' lanes grid shows them. */
export async function listLanes(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, PLANNING_VIEW)
  return caller.withClient(async (client) => {
    const settings = await readSettings(client, site.id)
    const { lines, workCentres } = await readLanes(client, site.id)
    const actual = await actualEfficiencyOf(client, site, lines, settings, businessDate(serverClock.now(), site.timezone))
    const fallback = defaultEfficiencyOf(settings)
    return {
      site: siteViewOf(site),
      defaultEfficiencyPct: fallback.efficiencyPct,
      defaultEfficiencySource: fallback.source,
      lines: lines.map((line) => laneViewOf(line, settings, actual.get(line.id) ?? [])),
      workCentres: workCentres.map((centre) => laneViewOf(centre, settings, null)),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------------

interface LaneBody {
  readonly version?: number | undefined
  readonly plannedEfficiencyPct?: string | undefined
  readonly note?: string | null | undefined
  /** operators (a line) or units (a work centre); null: its active stations. */
  readonly people?: number | null | undefined
}

async function laneFor(caller: CommandCaller, kind: LaneKind, laneId: string): Promise<{ lane: LaneFacts; site: SiteRow }> {
  const context = officeContextOf(caller)
  const found = isUuid(laneId)
    ? await caller.withClient(async (client) => {
        const owner = kind === 'LINE' ? await client.line.findUnique({ where: { id: laneId }, select: { siteId: true } }) : await client.workCentre.findUnique({ where: { id: laneId }, select: { siteId: true } })
        if (!owner) return null
        const site = await client.site.findUnique({ where: { id: owner.siteId }, select: SITE_COLUMNS })
        const lanes = await readLanes(client, owner.siteId, { kind, id: laneId })
        const lane = (kind === 'LINE' ? lanes.lines : lanes.workCentres)[0]
        return site && lane ? { site, lane } : null
      })
    : null
  assertMayAt(context, PLANNING_SETTINGS_MANAGE, found ? { companyId: found.lane.companyId, siteId: found.lane.siteId } : null, kind === 'LINE' ? 'Line' : 'Work centre')
  return found!
}

const sameNote = (a: string | null, b: string | null): boolean => (a ?? '') === (b ?? '')

/** One capacity change: the row made at the first save, else changed at its version (planning.settings.manage). */
async function editLane(caller: CommandCaller, kind: LaneKind, laneId: string, body: LaneBody, input: unknown, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const { lane, site } = await laneFor(caller, kind, laneId)
  if (lane.status !== 'ACTIVE') throw new InvalidStateError(`This ${kind === 'LINE' ? 'line' : 'work centre'} is archived: its capacity no longer changes.`)
  if (!lane.row && body.version !== undefined) throw new NotFoundError('This lane has no capacity of its own yet; save it without a version.')
  const settings = await caller.withClient((client) => readSettings(client, site.id))
  const efficiency = body.plannedEfficiencyPct === undefined ? undefined : efficiencyPctOf(body.plannedEfficiencyPct)
  if (efficiency === null) throw new ValidationError('The planned efficiency is above 0 and at most 200 %.', [{ path: 'body/plannedEfficiencyPct', message: 'Give a percent above 0 and at most 200, with at most two decimals (85 or 92.5).' }])
  const peopleField = kind === 'LINE' ? 'operators' : 'units'
  const next = (row: CapacityRow | null) => ({
    plannedEfficiencyPct: efficiency ?? row?.plannedEfficiencyPct ?? defaultEfficiencyOf(settings).efficiencyPct,
    people: body.people === undefined ? (row?.people ?? null) : body.people,
    note: body.note === undefined ? (row?.note ?? null) : body.note === '' ? null : body.note,
  })
  const changedOf = (row: CapacityRow | null, values: ReturnType<typeof next>): ('plannedEfficiencyPct' | 'people' | 'note')[] => {
    const out: ('plannedEfficiencyPct' | 'people' | 'note')[] = []
    if (!row || !new Dec(row.plannedEfficiencyPct).eq(values.plannedEfficiencyPct)) out.push('plannedEfficiencyPct')
    if ((row?.people ?? null) !== values.people) out.push('people')
    if (!sameNote(row?.note ?? null, values.note)) out.push('note')
    return out
  }
  const recordType = kind === 'LINE' ? ('LineCapacity' as const) : ('WorkCentreCapacity' as const)
  const name = kind === 'LINE' ? ('planning.editLineCapacity' as const) : ('planning.editWorkCentreCapacity' as const)
  if (lane.row && changedOf(lane.row, next(lane.row)).length === 0) {
    const replay = await storedAnswer<{ lane: LaneView; changed: string[] }>(caller, { name, idempotencyKey, input }, [undefined, { type: recordType, id: lane.id, expectedVersion: body.version }])
    return replay ?? { lane: laneViewOf(lane, settings, null), changed: [] as string[] }
  }
  const { result } = await command(
    caller,
    { name, idempotencyKey, input, ...(lane.row ? { record: { type: recordType, id: lane.id, expectedVersion: body.version } } : {}) },
    async (tools) => {
      const fresh = (await readLanes(tools.tx, site.id, { kind, id: lane.id }))
      const current = (kind === 'LINE' ? fresh.lines : fresh.workCentres)[0]!
      if (!lane.row && current.row) throw new ConflictError('The capacity of this lane was just saved by someone else; reload it and save again.')
      const values = next(current.row)
      const changed = changedOf(current.row, values)
      const data = { plannedEfficiencyPct: values.plannedEfficiencyPct, [peopleField]: values.people, note: values.note }
      if (current.row) {
        if (kind === 'LINE') await tools.tx.lineCapacity.update({ where: { id: lane.id }, data, select: { id: true } })
        else await tools.tx.workCentreCapacity.update({ where: { id: lane.id }, data, select: { id: true } })
      } else {
        const row = { id: lane.id, companyId: lane.companyId, siteId: lane.siteId, ...data, createdById: context.actorId }
        const { count } =
          kind === 'LINE'
            ? await tools.tx.lineCapacity.createMany({ data: [{ ...row, lineId: lane.id }], skipDuplicates: true })
            : await tools.tx.workCentreCapacity.createMany({ data: [{ ...row, workCentreId: lane.id }], skipDuplicates: true })
        if (count !== 1) throw new ConflictError('The capacity of this lane was just saved by someone else; reload it and save again.')
      }
      const after = (await readLanes(tools.tx, site.id, { kind, id: lane.id }))
      const saved = (kind === 'LINE' ? after.lines : after.workCentres)[0]!
      const auditOf = (row: CapacityRow | null) => (row ? { plannedEfficiencyPct: row.plannedEfficiencyPct, [peopleField]: row.people, note: row.note } : null)
      tools.audit({ recordType, recordId: lane.id, companyId: lane.companyId, siteId: lane.siteId, before: auditOf(current.row), after: auditOf(saved.row) })
      tools.emit({
        type: 'planning.capacity_changed',
        subject: lane.id,
        companyId: lane.companyId,
        siteId: lane.siteId,
        payload: { siteId: lane.siteId, laneKind: kind, laneId: lane.id, change: current.row ? 'EDITED' : 'CREATED', changed: changed.length > 0 ? changed : ['plannedEfficiencyPct'] },
      })
      return { lane: laneViewOf(saved, settings, null), changed: changed as string[] }
    },
  )
  return result
}

/** planning.settings.manage: a line's planned efficiency, people per shift (null: one per active station) and note. */
export const editLineCapacity = (caller: CommandCaller, lineId: string, body: EditLineCapacityBody, idempotencyKey?: string) =>
  editLane(caller, 'LINE', lineId, { version: body.version, plannedEfficiencyPct: body.plannedEfficiencyPct, note: body.note, people: body.operators }, { lineId, ...body }, idempotencyKey)

/** planning.settings.manage: a work centre's units at once (null: its active stations), planned efficiency and note. */
export const editWorkCentreCapacity = (caller: CommandCaller, workCentreId: string, body: EditWorkCentreCapacityBody, idempotencyKey?: string) =>
  editLane(caller, 'WORK_CENTRE', workCentreId, { version: body.version, plannedEfficiencyPct: body.plannedEfficiencyPct, note: body.note, people: body.units }, { workCentreId, ...body }, idempotencyKey)
