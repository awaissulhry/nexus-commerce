import { ValidationError } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { dispatchOrder } from '@nexus/factory-domain/planning/schedule/dispatch'
import { sumMinutes } from '@nexus/factory-domain/production/dispatch/load'
import { MATERIAL_LOOK, type MaterialFlag } from '@nexus/factory-domain/production/dispatch/material'
import { PRODUCTION_DISPATCH_HANDOVER, PRODUCTION_DISPATCH_MANAGE, PRODUCTION_DISPATCH_VIEW } from '@nexus/factory-domain/production/dispatch/permissions'
import { assignmentKindOf, isPastDay, laneFirst } from '@nexus/factory-domain/production/dispatch/rules'
import { LEVEL_LABELS } from '@nexus/factory-domain/people/skills/rules'
import type { CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { qualificationRuleFor } from '../../people/skills/rule'
import { knownSite, may, officeOf } from './access'
import { attendanceOfDay, lineLoads, lineMinutesOf, stationOperators, type AttendanceOfDay } from './facts'
import { levelsOfBoard, type LevelsOf } from './levels'
import { activeLinesOf, dayOf, workerNames, type AssignmentRow, type Reader, type StationRow } from './store'
import { dispatchWorld, materialFlags, planView, type DayCard, type DispatchWorld, type MaterialFlags } from './world'

/**
 * The dispatch board (B-W2b-49; MES-023, -026, -027, -028, -031; design production.dispatch SCR-138): GET
 * /production/dispatch/board?siteId&date&lineId (office, production.dispatch.view): the load of each line, the lanes
 * (lines › stations) with their cards, what has no station yet, the site's rules. One read per screen.
 *
 * Names: an operator's floor name beside a station or a card, with the skill level for that operation, only where the site's
 * floor records name workers; never a figure, a rank, a filter or a group by person (Statuto dei Lavoratori art. 4; Owner
 * answer W1). Where someone stands (not clocked in, on another shift) only to whoever runs the board
 * (production.dispatch.manage), only with the ATTENDANCE gate in force, and never why. Load per line; queued minutes per
 * station.
 */

export const materialView = (flag: MaterialFlag | null) => (flag ? { state: flag.state, word: flag.word, label: flag.label, date: flag.date, words: flag.words, scope: flag.scope, ...MATERIAL_LOOK[flag.state] } : null)

/** Rush first, the board's order, then the W2a order. */
export function sortCards<Card extends DayCard>(cards: readonly Card[]): Card[] {
  const keyOf = (card: Card) => ({ rush: card.workOrder.rush, priority: card.workOrder.priority, dueDate: card.workOrder.dueDate ? dayOf(card.workOrder.dueDate) : null, startAt: card.slot?.startAt.getTime() ?? 0, seq: card.operation.seq, workOrderNumber: card.workOrder.number })
  return [...cards].sort((a, b) => laneFirst({ rush: a.workOrder.rush, order: a.order }, { rush: b.workOrder.rush, order: b.order }) || dispatchOrder(keyOf(a), keyOf(b)))
}

interface Named {
  readonly names: ReadonlyMap<string, string>
  readonly levels: LevelsOf
  readonly attendance: AttendanceOfDay
  readonly showStanding: boolean
  readonly namesWorkers: boolean
}

function operatorView(row: AssignmentRow, operationId: string | null, lineId: string | null, named: Named) {
  const held = operationId ? named.levels(row.employeeId, operationId) : null
  const standing = named.attendance.standingOf(row.employeeId, lineId)
  return {
    assignmentId: row.id,
    version: row.version,
    kind: assignmentKindOf(row),
    workerId: row.workerId!,
    name: named.names.get(row.workerId!) ?? '—',
    level: held?.level ?? null,
    levelLabel: held ? LEVEL_LABELS[held.level] : null,
    trainee: held?.trainee ?? false,
    overridden: row.overrideReason !== null,
    presence: named.showStanding ? standing.state : null,
    reassign: named.showStanding && standing.reassign,
    words: named.showStanding ? standing.words : null,
  }
}

function cardView(card: DayCard, world: DispatchWorld, flags: MaterialFlags, named: Named) {
  const station = card.stationId ? world.stations.find((row) => row.id === card.stationId) : undefined
  const lineId = station?.lineId ?? card.lineId
  const rows = named.namesWorkers ? card.rows.filter((row) => row.workerId !== null) : []
  const fromStation = named.namesWorkers && card.stationId ? stationOperators(world, card.stationId).filter((row) => !rows.some((own) => own.workerId === row.workerId)) : []
  const operators = [...rows, ...fromStation].map((row) => operatorView(row, card.operation.id, lineId, named))
  return {
    id: card.id,
    key: card.key,
    workOrder: { id: card.workOrder.id, number: card.workOrder.number, status: card.workOrder.status, priority: card.workOrder.priority, rush: card.workOrder.rush, dueDate: card.workOrder.dueDate ? dayOf(card.workOrder.dueDate) : null, style: card.workOrder.style, holdReason: card.workOrder.holdReason },
    operation: { id: card.operation.id, seq: card.operation.seq, code: card.operation.code, name: card.operation.name, workCentreId: card.operation.workCentreId },
    previous: card.previous ? { seq: card.previous.seq, code: card.previous.code, name: card.previous.name } : null,
    parallel: card.parallel ? { group: card.parallel.group, with: card.parallel.with.map((operation) => ({ id: operation.id, seq: operation.seq, code: operation.code, name: operation.name })) } : null,
    stationId: card.stationId,
    lineId,
    bundles: card.bundleIds.map((id) => ({ id, code: world.bundles.get(id)?.code ?? '', garments: world.bundles.get(id)?.garments ?? 0 })),
    whole: card.whole,
    pieces: card.pieces,
    standardMinutes: card.operation.standardMinutes.toString(),
    minutes: card.minutes,
    state: card.state,
    words: card.words,
    sequence: card.sequence,
    material: materialView(flags.of(card.workOrder.id, card.operation.id)),
    order: card.order,
    counted: card.counted,
    movable: card.workOrder.status !== 'DRAFT',
    operators,
    reassign: operators.some((operator) => operator.reassign),
  }
}

function stationLane(station: StationRow, cards: readonly DayCard[], world: DispatchWorld, flags: MaterialFlags, named: Named) {
  const own = sortCards(cards.filter((card) => card.stationId === station.id))
  const views = own.map((card) => cardView(card, world, flags, named))
  const operators = named.namesWorkers ? stationOperators(world, station.id).map((row) => operatorView(row, own[0]?.operation.id ?? null, station.lineId, named)) : []
  return { id: station.id, code: station.code, name: station.name, lineId: station.lineId, workCentreId: station.workCentreId, operators, queuedMinutes: sumMinutes(own.filter((card) => card.counted).map((card) => card.minutes)), cards: views, reassign: views.some((card) => card.reassign) || operators.some((operator) => operator.reassign) }
}

export interface BoardQuery {
  readonly siteId: string
  readonly date?: BusinessDate | undefined
  readonly lineId?: string | undefined
}

export async function dispatchBoard(caller: CommandCaller, query: BoardQuery) {
  const context = officeOf(caller)
  const site = await knownSite(caller, context, query.siteId, PRODUCTION_DISPATCH_VIEW)
  const now = serverClock.now()
  const scope = { companyId: site.companyId, siteId: site.id }
  return caller.withClient(async (db: Reader) => {
    const day = query.date ?? businessDate(now, site.timezone)
    const world = await dispatchWorld(db, site, day, now)
    const lines = await activeLinesOf(db, site.id)
    if (query.lineId && !lines.some((line) => line.id === query.lineId)) throw new ValidationError('This line is not an active line of the site.', [{ path: 'querystring/lineId', message: 'Pick an active line of the site.' }])
    const minutes = await lineMinutesOf(db, world, lines)
    const attendance = await attendanceOfDay(db, world, minutes)
    const loads = await lineLoads(db, world, minutes, attendance)
    const flags = await materialFlags(db, site, world.cards.map((card) => card.workOrder.id))
    const mayManage = may(context, PRODUCTION_DISPATCH_MANAGE, scope)
    const namesWorkers = world.subject === 'WORKER'
    const names = await workerNames(db, namesWorkers ? world.rows.map((row) => row.workerId) : [])
    const levels = await levelsOfBoard(db, namesWorkers ? world.rows.map((row) => row.employeeId) : [], world.cards.map((card) => card.operation.id))
    const named: Named = { names, levels, attendance, showStanding: mayManage, namesWorkers }
    const shown = query.lineId ? lines.filter((line) => line.id === query.lineId) : lines
    const lanes = shown.map((line) => ({
      id: line.id,
      code: line.code,
      name: line.name,
      load: loads.get(line.id)!,
      stations: world.stations.filter((station) => station.lineId === line.id).map((station) => stationLane(station, world.cards, world, flags, named)),
    }))
    const otherStations = query.lineId ? [] : world.stations.filter((station) => station.lineId === null).map((station) => stationLane(station, world.cards, world, flags, named))
    // A card whose station was switched off since is back to find a place.
    const noStation = world.cards.filter((card) => card.stationId === null || !world.stations.some((station) => station.id === card.stationId))
    const notAssigned = sortCards(noStation.filter((card) => !query.lineId || card.lineId === query.lineId)).map((card) => cardView(card, world, flags, named))
    const empty = lanes.every((line) => line.stations.every((station) => station.cards.length === 0)) && otherStations.every((station) => station.cards.length === 0) && notAssigned.length === 0
    const qualification = await qualificationRuleFor(db, site.id)
    return {
      site: { id: site.id, code: site.code, name: site.name, timeZone: site.timezone },
      day,
      today: world.today,
      past: isPastDay(day, world.today),
      asOf: toUtcIso(now),
      version: world.plan ? planView(world.plan) : null,
      rules: { sequence: world.sequenceRule, qualification: qualification.mode, qualificationWords: qualification.words, scanSubject: world.subject, namesWorkers },
      attendance: { open: attendance.open, words: attendance.words },
      lines: lanes,
      otherStations,
      notAssigned,
      words: empty ? 'Nothing queued for this shift.' : null,
      mayManage,
      mayWriteHandover: may(context, PRODUCTION_DISPATCH_HANDOVER, scope),
    }
  })
}

