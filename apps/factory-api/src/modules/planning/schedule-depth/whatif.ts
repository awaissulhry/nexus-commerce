import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { DomainError, isDomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { holdWords } from '@nexus/factory-domain/planning/milestones/rules'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { deltaWords, mergeMoves, touchedLanes, type WhatIfConflictCode, type WhatIfMove, type WhatIfPlace } from '@nexus/factory-domain/planning/schedule-depth/whatif'
import { PLANNING_SCHEDULE_MANAGE } from '@nexus/factory-domain/planning/schedule/permissions'
import { refusalIssue, ScheduleRefusal } from '@nexus/factory-domain/planning/schedule/refusals'
import { laneColumns, laneKey, laneOfSlot, slotInputProblems, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords, whenWords } from '@nexus/factory-domain/planning/schedule/time'
import { uniformBuckets } from '@nexus/factory-domain/planning/settings/buckets'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { Prisma } from '@nexus/factory-db'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { capacityAnswer, type CapacityWorld } from '../capacity/service'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import { gateHoldsOf } from '../schedule/gates'
import { siteViewOf } from '../schedule/publish'
import { capacityWith, overDays, scheduleWorld, schedulesOf, type OverDay, type PlannedSlot, type ScheduleWorld } from '../schedule/service'
import { assertFits, endFor, slotMinutes } from '../schedule/slots'
import { lockedWorkingPlan, userNamesOf, type SlotRow } from '../schedule/store'
import type { ApplyWhatIfBody, CreateWhatIfBody, SetWhatIfMovesBody, WhatIfMoveInput } from './contract'
import { emitDepthChange, logChanges, type LoggedChange } from './log'
import { materialCheckOf, materialStartsOf } from './material'

/**
 * What-if on the planning board (B-W2b-312; design planning.board sec:whatif; WhatIfScenario of B-W2b-286): one planner's
 * private moves on the site's working plan, their effect shown, then applied (merged into the working plan) or thrown away.
 * Private: a scenario is read and changed by its owner only (another planner gets 404), and nothing of it reaches the
 * floor, the board or another planner until Apply: no event is sent for a draft.
 *
 *   POST /planning/schedule/what-ifs {siteId, name?}            a DRAFT based on the working plan now (planning.schedule.manage)
 *   GET  /planning/schedule/what-ifs?siteId                     the caller's own drafts at the site
 *   GET  /planning/schedule/what-ifs/:id                        the moves, each one's conflict and material, and the effect
 *   PUT  /planning/schedule/what-ifs/:id/moves {version, moves}  the moves tried (each checked like a board move: the lane
 *                                                               does the operation, the work order is open, a pinned bar is
 *                                                               never moved); the effect in the answer
 *   POST /planning/schedule/what-ifs/:id/apply {version, …}     ONE command under the site's schedule lock: the moves
 *                                                               checked against the working plan NOW (conflicts: 409 listing
 *                                                               them, or skipped with `skipConflicts`), the gate holds and
 *                                                               the overload rule as every move, the slots written, a
 *                                                               ScheduleChange per move naming the scenario, the scenario
 *                                                               APPLIED, planning.schedule_changed WHAT_IF_APPLIED
 *   POST /planning/schedule/what-ifs/:id/discard {version}      DISCARDED
 *
 * The effect (the design's deltas): late work orders before → after (B-W2a-34's backward schedule on the plan with the
 * moves), the standard minutes over the lanes' available minutes over the window ("overtime needed"), each touched lane's
 * load over the days its moves touch, the work orders whose planned start or finish changes.
 */

const SCENARIO_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  ownerId: true,
  name: true,
  basePlanVersionId: true,
  basedAt: true,
  moves: true,
  status: true,
  appliedAt: true,
  discardedAt: true,
  version: true,
  updatedAt: true,
  site: { select: SITE_COLUMNS },
} as const
type ScenarioRow = { id: string; companyId: string; siteId: string; ownerId: string; name: string | null; basedAt: Date; moves: unknown; status: 'DRAFT' | 'APPLIED' | 'DISCARDED'; appliedAt: Date | null; discardedAt: Date | null; version: number; updatedAt: Date; site: SiteRow }

const BANNER = 'What-if — nothing reaches the floor or other planners until you apply.'

async function scenarioFor(caller: CommandCaller, scenarioId: string, permission: Permission): Promise<ScenarioRow> {
  const context = officeContextOf(caller)
  const row = (await caller.withClient((db) => (isUuid(scenarioId) ? db.whatIfScenario.findUnique({ where: { id: scenarioId }, select: SCENARIO_COLUMNS }) : Promise.resolve(null)))) as ScenarioRow | null
  // Another planner's scenario does not exist for the caller: it is private.
  if (!row || row.ownerId !== context.actorId) throw new NotFoundError('What-if not found: a what-if is its planner\'s own.')
  assertMayAt(context, permission, { companyId: row.companyId, siteId: row.siteId }, 'What-if')
  return row
}

const movesOf = (json: unknown): WhatIfMove[] => (Array.isArray(json) ? (json as WhatIfMove[]) : [])
const placeOf = (slot: Pick<SlotRow, 'lineId' | 'workCentreId' | 'partyId' | 'startAt' | 'endAt'>): WhatIfPlace => ({ lane: laneOfSlot(slot), startAt: toUtcIso(slot.startAt), endAt: toUtcIso(slot.endAt) })
const at = (value: string): Date => parseInstant(value)!

/** The tried moves checked against the working plan as it is (a 400 names each one that is not a move the board takes). */
function resolveMoves(world: ScheduleWorld, inputs: readonly WhatIfMoveInput[]): { moves: WhatIfMove[]; problems: Issue[] } {
  const moves: WhatIfMove[] = []
  const problems: Issue[] = []
  inputs.forEach((input, index) => {
    const path = `body/moves/${index}`
    const fail = (field: string, message: string) => problems.push({ path: `${path}/${field}`, message })
    try {
      if (input.kind === 'MOVE' || input.kind === 'REMOVE') {
        const slot = input.slotId ? world.slots.find((candidate) => candidate.id === input.slotId) : undefined
        if (!slot) return fail('slotId', 'Not a slot of the working plan.')
        if (slot.pinned) return fail('slotId', 'The slot is pinned: it stays where it is until it is unpinned.')
        const workOrder = world.workOrders.find((candidate) => candidate.id === slot.workOrderId)
        if (!workOrder) return fail('slotId', 'Its work order is not open any more.')
        if (input.kind === 'REMOVE') {
          moves.push({ kind: 'REMOVE', slotId: slot.id, slotVersion: slot.version, workOrderId: slot.workOrderId, operationId: slot.workOrderOperationId, from: placeOf(slot), to: null })
          return
        }
        const operation = slot.workOrderOperationId ? (workOrder.operations.find((candidate) => candidate.id === slot.workOrderOperationId) ?? null) : null
        const lane: LaneRef = input.lane ?? laneOfSlot(slot)
        const info = world.lanes.get(laneKey(lane))
        if (!info) return fail('lane', 'Not a lane of this site.')
        assertFits(world, operation, lane, info.name)
        const start = input.startAt ? at(input.startAt) : slot.startAt
        const moved = input.startAt !== undefined || input.lane !== undefined
        const minutes = slotMinutes(world, workOrder, operation, lane, operation ? 0 : (slot.pieces ?? workOrder.garments))
        const end = input.endAt ? at(input.endAt) : moved ? endFor(world, workOrder, operation, lane, start, minutes) : slot.endAt
        const bad = slotInputProblems({ startAt: start.getTime(), endAt: end.getTime() }, { whole: !operation, garments: workOrder.garments })
        if (bad.length > 0) return fail('endAt', bad[0]!.message)
        moves.push({ kind: 'MOVE', slotId: slot.id, slotVersion: slot.version, workOrderId: slot.workOrderId, operationId: slot.workOrderOperationId, from: placeOf(slot), to: { lane, startAt: toUtcIso(start), endAt: toUtcIso(end) } })
        return
      }
      const workOrder = input.workOrderId ? world.workOrders.find((candidate) => candidate.id === input.workOrderId) : undefined
      if (!workOrder) return fail('workOrderId', 'Not an open work order of this site.')
      const operation = input.operationId ? workOrder.operations.find((candidate) => candidate.id === input.operationId) : undefined
      if (!operation) return fail('operationId', 'Not an operation of the work order.')
      if (operation.remaining === 0) return fail('operationId', `Op ${operation.seq} ${operation.name} is done: nothing to place.`)
      if (world.slots.some((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === operation.id)) return fail('operationId', `Op ${operation.seq} ${operation.name} already has a bar on the board: move that one.`)
      if (!input.startAt) return fail('startAt', 'Give the start.')
      const lane: LaneRef = input.lane ?? world.operationLanes.get(operation.id)!
      const info = world.lanes.get(laneKey(lane))
      if (!info) return fail('lane', 'Not a lane of this site.')
      assertFits(world, operation, lane, info.name)
      const start = at(input.startAt)
      const end = input.endAt ? at(input.endAt) : endFor(world, workOrder, operation, lane, start, slotMinutes(world, workOrder, operation, lane, 0))
      const bad = slotInputProblems({ startAt: start.getTime(), endAt: end.getTime() }, { whole: false, garments: workOrder.garments })
      if (bad.length > 0) return fail('endAt', bad[0]!.message)
      moves.push({ kind: 'PLACE', slotId: null, slotVersion: null, workOrderId: workOrder.id, operationId: operation.id, from: null, to: { lane, startAt: toUtcIso(start), endAt: toUtcIso(end) } })
    } catch (error) {
      if (!isDomainError(error)) throw error
      fail('lane', error.message)
    }
  })
  return { moves, problems }
}

interface Conflict {
  readonly code: WhatIfConflictCode
  readonly words: string
}

/** Why a move cannot be applied to the working plan as it is now (null: it can). */
async function conflictsOf(db: Reader, world: ScheduleWorld, moves: readonly WhatIfMove[]): Promise<(Conflict | null)[]> {
  const say = (date: Date) => whenWords(date.getTime(), world.site.timezone)
  const names = await userNamesOf(db, world.slots.flatMap((slot) => [slot.updatedById, slot.pinnedById]))
  const holds = await gateHoldsOf(db, [...new Set(moves.filter((move) => move.kind !== 'REMOVE').map((move) => move.workOrderId))])
  return moves.map((move) => {
    const workOrder = world.workOrders.find((candidate) => candidate.id === move.workOrderId)
    if (!workOrder) return { code: 'NOT_OPEN', words: 'The work order is not open any more.' }
    if (move.kind === 'PLACE') {
      const operation = workOrder.operations.find((candidate) => candidate.id === move.operationId)
      if (!operation || operation.remaining === 0) return { code: 'OPERATION_DONE', words: `${workOrder.number}: the operation is done since.` }
      if (world.slots.some((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === move.operationId)) return { code: 'ALREADY_ON_BOARD', words: `${workOrder.number} Op ${operation.seq} ${operation.name} got a bar on the board since.` }
    } else {
      const slot = world.slots.find((candidate) => candidate.id === move.slotId)
      if (!slot) return { code: 'SLOT_GONE', words: `${workOrder.number}: the bar was sent back to the tray since.` }
      if (slot.pinned) return { code: 'SLOT_PINNED', words: `${workOrder.number}: the bar was pinned${slot.pinnedById && names.get(slot.pinnedById) ? ` by ${names.get(slot.pinnedById)}` : ''}${slot.pinnedAt ? ` at ${say(slot.pinnedAt)}` : ''} since.` }
      if (slot.version !== move.slotVersion) return { code: 'SLOT_MOVED', words: `${workOrder.number}: the bar was moved${slot.updatedById && names.get(slot.updatedById) ? ` by ${names.get(slot.updatedById)}` : ''} at ${say(slot.updatedAt)} since you tried it.` }
    }
    const gates = move.kind === 'REMOVE' ? undefined : holds.get(workOrder.id)
    if (gates) return { code: 'GATE_NOT_PASSED', words: holdWords(workOrder.number, gates) }
    return null
  })
}

type VirtualSlot = PlannedSlot & Pick<SlotRow, 'partyId'>

/** The working plan with the moves (those without a conflict, when `conflicts` are given). */
function virtualOf(world: ScheduleWorld, moves: readonly WhatIfMove[], conflicts: readonly (Conflict | null)[] = []): { slots: VirtualSlot[]; placed: Map<number, string> } {
  const slots = new Map<string, VirtualSlot>(world.slots.map((slot) => [slot.id, slot]))
  const placed = new Map<number, string>()
  moves.forEach((move, index) => {
    if (conflicts[index]) return
    const workOrder = world.workOrders.find((candidate) => candidate.id === move.workOrderId)
    if (!workOrder) return
    const operation = move.operationId ? (workOrder.operations.find((candidate) => candidate.id === move.operationId) ?? null) : null
    if (move.kind === 'REMOVE') {
      slots.delete(move.slotId!)
      return
    }
    const to = move.to!
    if (move.kind === 'MOVE') {
      const slot = slots.get(move.slotId!)
      if (!slot) return
      slots.set(slot.id, { ...slot, ...laneColumns(to.lane), startAt: at(to.startAt), endAt: at(to.endAt), minutes: slotMinutes(world, workOrder, operation, to.lane, operation ? 0 : (slot.pieces ?? workOrder.garments)) })
      return
    }
    const id = newId()
    placed.set(index, id)
    slots.set(id, { id, workOrderId: workOrder.id, workOrderOperationId: move.operationId, ...laneColumns(to.lane), startAt: at(to.startAt), endAt: at(to.endAt), pieces: null, minutes: slotMinutes(world, workOrder, operation, to.lane, 0) })
  })
  return { slots: [...slots.values()], placed }
}

const sumOver = (capacity: CapacityWorld, from: BusinessDate, to: BusinessDate) => {
  const answer = capacityAnswer(capacity, { from, to, buckets: uniformBuckets(from, to, 'DAY') })
  return answer.lanes.reduce((sum, lane) => lane.cells.reduce((inner, cell) => inner.plus(cell.overMinutes), sum), new Dec(0))
}

const iso = (value: number | null): string | null => (value === null ? null : toUtcIso(new Date(value)))

/** The effect of the moves (see above). */
function effectOf(world: ScheduleWorld, moves: readonly WhatIfMove[], virtual: readonly VirtualSlot[]) {
  const tz = world.site.timezone
  const after = schedulesOf(world, virtual)
  const capacity = capacityWith(world, virtual)
  const days = moves.flatMap((move) => [move.from, move.to].flatMap((place) => (place ? [businessDate(at(place.startAt), tz), businessDate(new Date(at(place.endAt).getTime() - 1), tz)] : [])))
  const last = [plusDays(world.today, 27), ...days].reduce((a, b) => (a > b ? a : b))
  const window = { from: world.today, to: last }
  const late = (schedules: ReadonlyMap<string, { status: string }>) => world.workOrders.filter((workOrder) => schedules.get(workOrder.id)?.status === 'LATE').length
  const lanes = touchedLanes(moves)
    .filter((lane) => lane.kind !== 'WORKSHOP')
    .flatMap((lane) => {
      // The days its moves touch (where bars leave and arrive); the lane's load is its busiest such day, before and after.
      const touched = new Set<BusinessDate>()
      for (const move of moves) {
        for (const place of [move.from, move.to]) {
          if (!place || laneKey(place.lane) !== laneKey(lane)) continue
          for (let day = businessDate(at(place.startAt), tz); day <= businessDate(new Date(at(place.endAt).getTime() - 1), tz); day = plusDays(day, 1)) touched.add(day)
        }
      }
      if (touched.size === 0) return []
      const sorted = [...touched].sort()
      const from = sorted[0]!
      const to = sorted[sorted.length - 1]!
      const period = { from, to, buckets: uniformBuckets(from, to, 'DAY') }
      const peakOf = (cap: CapacityWorld): string | null => {
        const cells = capacityAnswer(cap, period).lanes.find((candidate) => candidate.kind === lane.kind && candidate.id === lane.id)?.cells ?? []
        const values = cells.filter((cell) => touched.has(cell.key) && cell.loadPct !== null).map((cell) => new Dec(cell.loadPct!))
        return values.length === 0 ? null : values.reduce((a, b) => (a.gt(b) ? a : b)).toFixed(1)
      }
      const info = world.lanes.get(laneKey(lane))
      return [{ lane, code: info?.code ?? '', name: info?.name ?? '', from, to, beforePct: peakOf(world.capacity), afterPct: peakOf(capacity) }]
    })
  const orders = world.workOrders
    .map((workOrder) => ({ workOrder, before: world.schedules.get(workOrder.id)!, after: after.schedules.get(workOrder.id)! }))
    .filter(({ before, after: next }) => before.plannedStart !== next.plannedStart || before.plannedFinish !== next.plannedFinish)
    .map(({ workOrder, before, after: next }) => ({
      workOrderId: workOrder.id,
      number: workOrder.number,
      before: { status: before.status, plannedStart: iso(before.plannedStart), plannedFinish: iso(before.plannedFinish) },
      after: { status: next.status, plannedStart: iso(next.plannedStart), plannedFinish: iso(next.plannedFinish) },
    }))
  const delta = {
    lateOrders: { before: late(world.schedules), after: late(after.schedules) },
    overMinutes: { before: sumOver(world.capacity, window.from, window.to).toFixed(1), after: sumOver(capacity, window.from, window.to).toFixed(1) },
    lanes: lanes.map((entry) => ({ lane: entry.lane, code: entry.code, beforePct: entry.beforePct, afterPct: entry.afterPct })),
    ordersThatMove: orders.length,
  }
  return { lateOrders: delta.lateOrders, overMinutes: delta.overMinutes, window, lanes, orders, words: deltaWords(delta) }
}

/** The world a scenario is read on: from today to the last day its moves touch (at least four weeks). */
async function worldFor(db: Reader, site: SiteRow, moves: readonly WhatIfMove[], now: Date): Promise<ScheduleWorld> {
  const today = businessDate(now, site.timezone)
  const days = moves.flatMap((move) => [move.from, move.to].flatMap((place) => (place ? [businessDate(at(place.endAt), site.timezone)] : [])))
  const to = [plusDays(today, 27), ...days].reduce((a, b) => (a > b ? a : b))
  return scheduleWorld(db, site, { from: today, to }, now)
}

/** A scenario as the answers give it: its moves with their conflicts and material, and the effect. */
async function scenarioViewOf(db: Reader, row: ScenarioRow, now: Date) {
  const moves = movesOf(row.moves)
  const world = await worldFor(db, row.site, moves, now)
  const draft = row.status === 'DRAFT'
  const conflicts = draft ? await conflictsOf(db, world, moves) : moves.map(() => null)
  const virtual = virtualOf(world, draft ? moves : [], conflicts)
  const effect = effectOf(world, draft ? moves : [], virtual.slots)
  const starts = draft ? await materialStartsOf(db, world, [...new Set(moves.filter((move) => move.kind !== 'REMOVE').map((move) => move.workOrderId))]) : new Map()
  const operations = new Map(world.workOrders.flatMap((workOrder) => workOrder.operations.map((operation) => [operation.id, operation] as const)))
  const numbers = new Map(world.workOrders.map((workOrder) => [workOrder.id, workOrder.number]))
  const say = (date: Date) => whenWords(date.getTime(), row.site.timezone)
  return {
    id: row.id,
    siteId: row.siteId,
    name: row.name,
    status: row.status,
    version: row.version,
    basedAt: toUtcIso(row.basedAt),
    planChanged: draft && world.plan !== null && world.plan.updatedAt > row.basedAt,
    planVersion: world.plan?.version ?? null,
    appliedAt: row.appliedAt ? toUtcIso(row.appliedAt) : null,
    discardedAt: row.discardedAt ? toUtcIso(row.discardedAt) : null,
    banner: draft ? BANNER : row.status === 'APPLIED' ? `Applied to the working plan at ${say(row.appliedAt!)}.` : `Discarded at ${say(row.discardedAt!)}.`,
    moves: moves.map((move, index) => {
      const operation = move.operationId ? operations.get(move.operationId) : undefined
      const start = starts.get(move.workOrderId)
      return {
        kind: move.kind,
        slotId: move.slotId,
        slotVersion: move.slotVersion,
        workOrderId: move.workOrderId,
        number: numbers.get(move.workOrderId) ?? '',
        operationId: move.operationId,
        operation: operation ? { seq: operation.seq, code: operation.code, name: operation.name } : null,
        from: move.from,
        to: move.to,
        conflict: conflicts[index] ?? null,
        material: start && move.to ? materialCheckOf(world, start, move.to.lane, at(move.to.startAt).getTime()) : null,
      }
    }),
    conflicts: conflicts.filter(Boolean).length,
    effect,
  }
}

async function answer(caller: CommandCaller, scenarioId: string, replayed: boolean) {
  return caller.withClient(async (db) => {
    const row = (await db.whatIfScenario.findUniqueOrThrow({ where: { id: scenarioId }, select: SCENARIO_COLUMNS })) as ScenarioRow
    const now = serverClock.now()
    return { site: siteViewOf(row.site), asOf: toUtcIso(now), scenario: await scenarioViewOf(db, row, now), replayed }
  })
}

const audited = (row: Pick<ScenarioRow, 'status' | 'version'>, moves: number) => ({ status: row.status, version: row.version, moves })

/** POST /planning/schedule/what-ifs: a private DRAFT on the site's working plan as it is now. */
export async function createWhatIf(caller: CommandCaller, body: CreateWhatIfBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_SCHEDULE_MANAGE)
  const { result, replayed } = await command(caller, { name: 'planning.whatif.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, site, context.tenantId, { actorId: context.actorId, now, bump: false })
    const id = newId()
    const name = body.name?.trim() ? body.name.trim() : null
    await tx.whatIfScenario.create({ data: { id, companyId: site.companyId, siteId: site.id, ownerId: context.actorId, name, basePlanVersionId: plan.id, basedAt: now, moves: [], createdAt: now, updatedAt: now, createdById: context.actorId }, select: { id: true } })
    tools.audit({ action: 'planning.whatif.create', recordType: 'WhatIfScenario', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: { name, basePlanVersionId: plan.id, planVersion: plan.version } })
    return { id }
  })
  return answer(caller, result.id, replayed)
}

/** GET /planning/schedule/what-ifs: the caller's own drafts at the site. */
export async function listWhatIfs(caller: CommandCaller, query: { readonly siteId: string }) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (db) => {
    const rows = await db.whatIfScenario.findMany({ where: { siteId: site.id, ownerId: context.actorId, status: 'DRAFT' }, select: { id: true, name: true, status: true, version: true, basedAt: true, moves: true, updatedAt: true }, orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }], take: 50 })
    return { site: siteViewOf(site), scenarios: rows.map((row) => ({ id: row.id, name: row.name, status: row.status, version: row.version, basedAt: toUtcIso(row.basedAt), moves: movesOf(row.moves).length, updatedAt: toUtcIso(row.updatedAt) })) }
  })
}

/** GET /planning/schedule/what-ifs/:scenarioId. */
export async function getWhatIf(caller: CommandCaller, scenarioId: string) {
  const row = await scenarioFor(caller, scenarioId, PLANNING_VIEW)
  return answer(caller, row.id, false)
}

function assertDraft(row: Pick<ScenarioRow, 'status'>, version: number, current: number, id: string): void {
  if (row.status !== 'DRAFT') throw new ScheduleRefusal('WHAT_IF_CLOSED', `The what-if is ${row.status.toLowerCase()}: it never changes.`)
  if (version !== current) throw new StaleVersionError('WhatIfScenario', id, current, version)
}

/** PUT /planning/schedule/what-ifs/:scenarioId/moves: the moves tried (every one, in order); the effect in the answer. */
export async function setWhatIfMoves(caller: CommandCaller, scenarioId: string, body: SetWhatIfMovesBody, idempotencyKey?: string) {
  const target = await scenarioFor(caller, scenarioId, PLANNING_SCHEDULE_MANAGE)
  const { replayed } = await command(caller, { name: 'planning.whatif.try', idempotencyKey, input: { scenarioId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = (await tx.whatIfScenario.findUniqueOrThrow({ where: { id: target.id }, select: SCENARIO_COLUMNS })) as ScenarioRow
    assertDraft(row, body.version, row.version, row.id)
    const previous = movesOf(row.moves)
    const world = await scheduleWorld(tx, row.site, { from: businessDate(now, row.site.timezone), to: plusDays(businessDate(now, row.site.timezone), 27) }, now)
    const { moves, problems } = resolveMoves(world, body.moves)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
    const merged = mergeMoves(previous, moves)
    const { count } = await tx.whatIfScenario.updateMany({ where: { id: row.id, version: row.version, status: 'DRAFT' }, data: { moves: merged as unknown as Prisma.InputJsonValue, version: row.version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('WhatIfScenario', row.id, row.version + 1, body.version)
    tools.audit({ action: 'planning.whatif.try', recordType: 'WhatIfScenario', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: audited(row, previous.length), after: { status: row.status, version: row.version + 1, moves: merged.length } })
    return { moves: merged.length }
  })
  return answer(caller, target.id, replayed)
}

/** POST /planning/schedule/what-ifs/:scenarioId/apply: the moves merged into the working plan in one command. */
export async function applyWhatIf(caller: CommandCaller, scenarioId: string, body: ApplyWhatIfBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await scenarioFor(caller, scenarioId, PLANNING_SCHEDULE_MANAGE)
  const { result, replayed } = await command(caller, { name: 'planning.whatif.apply', idempotencyKey, input: { scenarioId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, target.site, context.tenantId, { actorId: context.actorId, now, bump: true })
    const row = (await tx.whatIfScenario.findUniqueOrThrow({ where: { id: target.id }, select: SCENARIO_COLUMNS })) as ScenarioRow
    assertDraft(row, body.version, row.version, row.id)
    const moves = movesOf(row.moves)
    if (moves.length === 0) throw new ScheduleRefusal('NOTHING_TO_RESCHEDULE', 'The what-if has no move to apply: try a move first, or discard it.')
    const world = await worldFor(tx, row.site, moves, now)
    const conflicts = await conflictsOf(tx, world, moves)
    const clashes = conflicts.flatMap((conflict, index) => (conflict ? [{ index, code: conflict.code, words: conflict.words }] : []))
    if (clashes.length > 0 && !body.skipConflicts) {
      const what = moves.length === 1 ? 'The move clashes' : `${clashes.length} of the ${moves.length} moves ${clashes.length === 1 ? 'clashes' : 'clash'}`
      const next = moves.length === clashes.length ? `Try ${clashes.length === 1 ? 'it' : 'them'} again.` : `Apply the rest, or try ${clashes.length === 1 ? 'it' : 'them'} again.`
      throw new ScheduleRefusal(
        'WHAT_IF_CONFLICTS',
        `${what} with the working plan as it is now: ${clashes[0]!.words} ${next}`,
        clashes.map((clash) => ({ path: `moves/${clash.index}/${clash.code}`, message: clash.words })),
      )
    }
    if (clashes.length === moves.length) throw new ScheduleRefusal('WHAT_IF_CONFLICTS', 'Every move of the what-if clashes with the working plan as it is now: nothing to apply.', clashes.map((clash) => ({ path: `moves/${clash.index}/${clash.code}`, message: clash.words })))
    const virtual = virtualOf(world, moves, conflicts)
    const capacity = capacityWith(world, virtual.slots)
    const reason = body.overloadReason?.trim() ? body.overloadReason.trim() : null
    const overs: { index: number; over: OverDay[] }[] = []
    moves.forEach((move, index) => {
      if (conflicts[index] || !move.to) return
      const workOrder = world.workOrders.find((candidate) => candidate.id === move.workOrderId)!
      if (!workOrder.booksCapacity) return
      const over = overDays(world, capacity, move.to.lane, at(move.to.startAt), at(move.to.endAt))
      if (over.length > 0) overs.push({ index, over })
    })
    if (overs.length > 0 && reason === null) {
      const first = overs[0]!
      const lane = world.lanes.get(laneKey(moves[first.index]!.to!.lane))?.name ?? 'A lane'
      const day = first.over[0]!
      throw new DomainError('conflict', `${overs.length === 1 ? '1 move' : `${overs.length} moves`} would overbook ${overs.length === 1 ? 'its lane' : 'their lanes'} (${lane} would be at ${day.loadPct ?? '—'}% on ${dayWords(day.date)}, +${day.overMinutes} min over). Give a reason to keep ${overs.length === 1 ? 'it' : 'them'}, or try ${overs.length === 1 ? 'it' : 'them'} again.`, [
        { path: 'body/overloadReason', message: 'Say why they stay on the overbooked lanes.' },
        ...first.over.map((entry) => ({ path: `over/${entry.date}`, message: `${entry.bookedMinutes} of ${entry.availableMinutes} min (${entry.loadPct ?? '—'}%), +${entry.overMinutes} over.` })),
        refusalIssue('OVERLOAD'),
      ])
    }
    if (reason !== null && reason.length < 3) throw new ValidationError('Say in a few words why they stay on the overbooked lanes.', [{ path: 'body/overloadReason', message: 'At least 3 characters.' }])
    const overAt = new Set(overs.map((entry) => entry.index))
    const changes: LoggedChange[] = []
    let applied = 0
    for (const [index, move] of moves.entries()) {
      if (conflicts[index]) continue
      const current = move.slotId ? world.slots.find((slot) => slot.id === move.slotId)! : null
      if (move.kind === 'REMOVE') {
        const { count } = await tx.scheduleSlot.deleteMany({ where: { id: current!.id, version: current!.version, pinned: false } })
        if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'A bar moved meanwhile: reload the what-if.')
        changes.push({ kind: 'REMOVE', slotId: current!.id, workOrderId: current!.workOrderId, operationId: current!.workOrderOperationId, from: { lane: laneOfSlot(current!), startAt: current!.startAt, endAt: current!.endAt }, whatIfScenarioId: row.id })
        applied += 1
        continue
      }
      const to = move.to!
      const slot = virtual.slots.find((candidate) => candidate.id === (move.kind === 'PLACE' ? virtual.placed.get(index) : move.slotId))!
      const minutes = new Dec(slot.minutes.toString()).toFixed(3)
      const kept = overAt.has(index) ? reason : null
      if (move.kind === 'MOVE') {
        if (laneKey(laneOfSlot(current!)) === laneKey(to.lane) && current!.startAt.getTime() === at(to.startAt).getTime() && current!.endAt.getTime() === at(to.endAt).getTime()) continue
        const { count } = await tx.scheduleSlot.updateMany({ where: { id: current!.id, version: current!.version, pinned: false }, data: { ...laneColumns(to.lane), startAt: at(to.startAt), endAt: at(to.endAt), minutes, overloadReason: kept, version: current!.version + 1, updatedAt: now, updatedById: context.actorId } })
        if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'A bar moved meanwhile: reload the what-if.')
        changes.push({ kind: 'MOVE', slotId: current!.id, workOrderId: current!.workOrderId, operationId: current!.workOrderOperationId, from: { lane: laneOfSlot(current!), startAt: current!.startAt, endAt: current!.endAt }, to: { lane: to.lane, startAt: at(to.startAt), endAt: at(to.endAt) }, reason: kept, whatIfScenarioId: row.id })
      } else {
        await tx.scheduleSlot.create({
          data: { id: slot.id, siteId: row.siteId, planVersionId: plan.id, planKind: 'WORKING', workOrderId: move.workOrderId, workOrderOperationId: move.operationId, ...laneColumns(to.lane), startAt: at(to.startAt), endAt: at(to.endAt), pieces: null, minutes, overloadReason: kept, note: null, createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId },
          select: { id: true },
        })
        changes.push({ kind: 'PLACE', slotId: slot.id, workOrderId: move.workOrderId, operationId: move.operationId, to: { lane: to.lane, startAt: at(to.startAt), endAt: at(to.endAt) }, reason: kept, whatIfScenarioId: row.id })
      }
      applied += 1
    }
    await logChanges(tx, row.site, plan.id, changes, context.actorId, now)
    const { count } = await tx.whatIfScenario.updateMany({ where: { id: row.id, version: row.version, status: 'DRAFT' }, data: { status: 'APPLIED', appliedAt: now, appliedById: context.actorId, version: row.version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('WhatIfScenario', row.id, row.version + 1, body.version)
    tools.audit({
      action: 'planning.whatif.apply',
      recordType: 'WhatIfScenario',
      recordId: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      before: audited(row, moves.length),
      after: { status: 'APPLIED', planVersion: plan.version, applied, skipped: clashes.map((clash) => ({ index: clash.index, code: clash.code })), changes: changes.map((change) => ({ kind: change.kind, slotId: change.slotId })), overloadReason: overs.length > 0 ? reason : null },
    })
    // B-W2b-329: a logged change's slot and work order may be null (a publish's); a what-if's never are.
    emitDepthChange(tools, row.site, plan, 'WHAT_IF_APPLIED', changes.flatMap((change) => (change.slotId ? [change.slotId] : [])), (changes.length > 0 ? changes : moves).flatMap((entry) => (entry.workOrderId ? [entry.workOrderId] : [])))
    return { scenario: { id: row.id, status: 'APPLIED' as const, version: row.version + 1, appliedAt: toUtcIso(now) }, applied, skipped: clashes, planVersion: plan.version }
  })
  return { site: siteViewOf(target.site), ...result, replayed }
}

/** POST /planning/schedule/what-ifs/:scenarioId/discard: thrown away (kept, DISCARDED). */
export async function discardWhatIf(caller: CommandCaller, scenarioId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const target = await scenarioFor(caller, scenarioId, PLANNING_SCHEDULE_MANAGE)
  const { result, replayed } = await command(caller, { name: 'planning.whatif.discard', idempotencyKey, input: { scenarioId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = (await tx.whatIfScenario.findUniqueOrThrow({ where: { id: target.id }, select: SCENARIO_COLUMNS })) as ScenarioRow
    assertDraft(row, body.version, row.version, row.id)
    const { count } = await tx.whatIfScenario.updateMany({ where: { id: row.id, version: row.version, status: 'DRAFT' }, data: { status: 'DISCARDED', discardedAt: now, discardedById: context.actorId, version: row.version + 1, updatedAt: now } })
    if (count !== 1) throw new StaleVersionError('WhatIfScenario', row.id, row.version + 1, body.version)
    tools.audit({ action: 'planning.whatif.discard', recordType: 'WhatIfScenario', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: audited(row, movesOf(row.moves).length), after: { status: 'DISCARDED', version: row.version + 1 } })
    return { scenario: { id: row.id, status: 'DISCARDED' as const, version: row.version + 1, discardedAt: toUtcIso(now) } }
  })
  return { ...result, replayed }
}
