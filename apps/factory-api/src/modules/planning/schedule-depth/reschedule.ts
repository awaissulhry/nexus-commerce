import { daysFrom, plusDays } from '@nexus/factory-domain/calendars/dates'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { holdWords } from '@nexus/factory-domain/planning/milestones/rules'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { leftInThePast, planChains, runOrder, type BusySpan, type ChainKept, type ChainMode, type ChainMove, type ChainOperation, type ChainOrder, type MoveWhy } from '@nexus/factory-domain/planning/schedule-depth/forward'
import type { MaterialStart } from '@nexus/factory-domain/planning/schedule-depth/material'
import { PLANNING_SCHEDULE_MANAGE } from '@nexus/factory-domain/planning/schedule/permissions'
import { refusalIssue, ScheduleRefusal, type SkipCode } from '@nexus/factory-domain/planning/schedule/refusals'
import { laneColumns, laneKey, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import { dayWords, whenWords } from '@nexus/factory-domain/planning/schedule/time'
import type { Decimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { officeContextOf, siteFor } from '../access'
import type { Reader, SiteRow } from '../store'
import { gateHoldsOf } from '../schedule/gates'
import { barsByLane, capacityWith, durationOn, overDays, scheduleWorld, schedulesOf, standardOf, type BoardOperation, type BoardWorkOrder, type OverDay, type PlannedSlot, type ScheduleWorld } from '../schedule/service'
import { lockedWorkingPlan, type SlotRow } from '../schedule/store'
import type { BacklogBody, ForwardBody } from './contract'
import { emitDepthChange, logChanges } from './log'
import { earliestOnLane, firstLaneOf, materialStartsOf, materialStartViewOf, nextMinuteOf } from './material'

/**
 * Forward scheduling for late orders (B-W2b-312; PLN-130) and the backlog reschedule (PLN-141), on the lanes' free time
 * (factory-domain planning/schedule-depth/forward), around pins (PLN-139), from the earliest start with material (PLN-134).
 *
 *   forward   POST /planning/schedule/forward {siteId, workOrderIds?, apply}: the work orders that cannot meet their due date
 *             scheduled backwards (B-W2a-34's LATE with PAST_DUE, CANNOT_FINISH_IN_TIME or BEFORE_CALENDAR: their latest
 *             safe start has passed), or the ones named: every operation with work left from now (or the material's
 *             earliest start), one after another on its lane's free time; a bar on the board moves, an operation in the
 *             tray is placed; a pinned bar stays. The answer gives each order's REAL earliest finish and days late.
 *   backlog   POST /planning/schedule/reschedule-backlog {siteId, apply}: every unpinned bar that should have ended by now
 *             while its operation has work left goes to the first free time from now; a later bar of its work order moves
 *             on only as far as it must (finish to start); a pinned bar in the past stays and is named. The tray is left
 *             to "Place all by due date".
 *   running   a bar the floor is on now (started, not ended) stays in both runs.
 *
 * Both: the most urgent work order first (rush, priority, latest safe start, due date); a work order on hold or waiting on a
 * pre-production gate (B-W2b-263) is skipped with its words; a preview first (planning.view), then ONE command
 * (planning.schedule.manage) at the working plan's version the preview read, under the site's schedule lock: the bars moved
 * (version CAS, never a pinned one), the placements made, a ScheduleChange per bar (MOVE, PLACE), one audit row on the
 * working plan, planning.schedule_changed SCHEDULED_FORWARD | BACKLOG_RESCHEDULED. A move that overbooks a lane (only
 * released work books capacity; the due-date load of work not on the board counts) needs a reason, as every move.
 */

export type RunMode = 'FORWARD' | 'BACKLOG'

/** The days the run's world loads (calendars and load): forward work may land weeks out. */
const HORIZON_DAYS = 120
const CANNOT_BACKWARD = new Set(['PAST_DUE', 'CANNOT_FINISH_IN_TIME', 'BEFORE_CALENDAR'])

interface Skip {
  readonly workOrderId: string
  readonly operationId: string | null
  readonly code: SkipCode
  readonly words: string
}

interface RunMove extends ChainMove {
  readonly lane: LaneRef
  readonly workOrder: BoardWorkOrder
  readonly operation: BoardOperation
  readonly slot: SlotRow | null
  readonly newId: string | null
  readonly minutes: Decimal
  readonly over: OverDay[]
}

interface Run {
  readonly mode: RunMode
  readonly moves: readonly RunMove[]
  readonly kept: readonly ChainKept[]
  readonly skipped: readonly Skip[]
  readonly candidates: readonly BoardWorkOrder[]
  readonly from: ReadonlyMap<string, number>
  readonly finishes: ReadonlyMap<string, number | null>
  readonly starts: ReadonlyMap<string, MaterialStart>
  readonly after: ReturnType<typeof schedulesOf>
}

const barOf = (world: ScheduleWorld, workOrder: BoardWorkOrder, operation: BoardOperation): SlotRow | null => world.slots.find((slot) => slot.workOrderId === workOrder.id && slot.workOrderOperationId === operation.id) ?? null

/** The run (see above), read only: what it would move and place, on the world given. */
export async function runOf(db: Reader, world: ScheduleWorld, mode: RunMode, workOrderIds?: readonly string[]): Promise<Run> {
  const now = world.now.getTime()
  const skipped: Skip[] = []
  const wanted = workOrderIds ? new Set(workOrderIds) : null
  for (const id of wanted ?? []) if (!world.workOrders.some((workOrder) => workOrder.id === id)) skipped.push({ workOrderId: id, operationId: null, code: 'NOT_OPEN', words: 'Not an open work order of this site.' })
  const inThePast = (workOrder: BoardWorkOrder) =>
    workOrder.operations.some((operation) => {
      const bar = barOf(world, workOrder, operation)
      return bar !== null && leftInThePast({ end: bar.endAt.getTime() }, operation.remaining, now)
    })
  let candidates = world.workOrders.filter((workOrder) => {
    const schedule = world.schedules.get(workOrder.id)!
    if (schedule.status === 'DONE') return false
    if (mode === 'BACKLOG') return inThePast(workOrder)
    return wanted ? wanted.has(workOrder.id) : schedule.status === 'LATE' && schedule.reasons.some((reason) => CANNOT_BACKWARD.has(reason.code))
  })
  const holds = await gateHoldsOf(db, candidates.map((workOrder) => workOrder.id))
  candidates = candidates.filter((workOrder) => {
    if (workOrder.status === 'ON_HOLD') {
      skipped.push({ workOrderId: workOrder.id, operationId: null, code: 'ON_HOLD', words: `${workOrder.number} is on hold${workOrder.holdReason ? `: ${workOrder.holdReason}` : ''}; it waits until the hold is lifted.` })
      return false
    }
    const gates = holds.get(workOrder.id)
    if (gates) {
      skipped.push({ workOrderId: workOrder.id, operationId: null, code: 'GATE_NOT_PASSED', words: holdWords(workOrder.number, gates) })
      return false
    }
    return true
  })
  candidates.sort((a, b) => {
    const x = world.schedules.get(a.id)!
    const y = world.schedules.get(b.id)!
    return runOrder({ rush: a.rush, priority: a.priority, latestSafeStart: x.latestSafeStart, dueDate: a.dueDate, number: a.number }, { rush: b.rush, priority: b.priority, latestSafeStart: y.latestSafeStart, dueDate: b.dueDate, number: b.number })
  })
  const starts = await materialStartsOf(db, world, candidates.map((workOrder) => workOrder.id))
  const kept: ChainKept[] = []
  const orders: ChainOrder[] = []
  const from = new Map<string, number>()
  for (const workOrder of candidates) {
    const start = starts.get(workOrder.id)!
    const begin = start.startDay ? earliestOnLane(world, firstLaneOf(world, workOrder), start.startDay) : nextMinuteOf(world)
    from.set(workOrder.id, begin)
    const operations: ChainOperation[] = []
    for (const operation of [...workOrder.operations].filter((candidate) => candidate.remaining > 0).sort((a, b) => a.seq - b.seq)) {
      const lane = world.operationLanes.get(operation.id)!
      const bar = barOf(world, workOrder, operation)
      const past = bar !== null && leftInThePast({ end: bar.endAt.getTime() }, operation.remaining, now)
      // A bar the floor is on now (started, not ended) stays: it is the work of the hour, in both runs.
      const running = bar !== null && bar.startAt.getTime() <= now && bar.endAt.getTime() > now
      let chain: ChainMode
      let why: MoveWhy = mode === 'FORWARD' ? 'FORWARD' : 'PAST'
      if (bar !== null && (bar.pinned || running)) chain = 'FIXED'
      else if (mode === 'FORWARD') chain = 'REPLAN'
      else if (bar === null) chain = 'UNPLACED'
      else if (past) chain = 'REPLAN'
      else {
        chain = 'KEEP_IF_FITS'
        why = 'PUSHED'
      }
      if ((chain === 'REPLAN' || chain === 'KEEP_IF_FITS') && !world.lanes.has(laneKey(lane))) {
        skipped.push({ workOrderId: workOrder.id, operationId: operation.id, code: 'LANE_NOT_ACTIVE', words: `${workOrder.number} Op ${operation.seq} ${operation.name}: its lane is not active on this site.` })
        chain = bar ? 'FIXED' : 'UNPLACED'
      }
      if (mode === 'BACKLOG' && bar?.pinned && past) {
        kept.push({ workOrderId: workOrder.id, operationId: operation.id, slotId: bar.id, code: 'PINNED_IN_THE_PAST', words: `${workOrder.number} Op ${operation.seq} ${operation.name} is pinned on ${whenWords(bar.startAt.getTime(), world.site.timezone)}, in the past, with work left: it stays (unpin it to reschedule it).` })
      }
      operations.push({
        id: operation.id,
        seq: operation.seq,
        label: `Op ${operation.seq} ${operation.name}`,
        laneKey: laneKey(lane),
        duration: durationOn(world, lane, operation, operation.remaining),
        current: bar ? { slotId: bar.id, start: bar.startAt.getTime(), end: bar.endAt.getTime(), pinned: bar.pinned } : null,
        mode: chain,
        why,
      })
    }
    orders.push({ workOrderId: workOrder.id, number: workOrder.number, from: begin, operations })
  }
  const busy = new Map<string, BusySpan[]>([...barsByLane(world.slots).entries()])
  const chains = planChains(orders, busy, world.site.timezone)
  // A pinned bar left in the past is named once (not also as starting before the operation before it).
  const pastPins = new Set(kept.map((entry) => entry.operationId))
  kept.push(...chains.kept.filter((entry) => !(entry.code === 'PINNED_BEFORE_PREVIOUS' && pastPins.has(entry.operationId))))
  // The plan after the run: moved bars at their new times, the placements added; then the load and the schedules on it.
  const byWorkOrder = new Map(candidates.map((workOrder) => [workOrder.id, workOrder]))
  const staged = chains.moves.map((move) => {
    const workOrder = byWorkOrder.get(move.workOrderId)!
    const operation = workOrder.operations.find((candidate) => candidate.id === move.operationId)!
    const lane = world.lanes.get(move.laneKey)!.ref
    return { move, workOrder, operation, lane, slot: move.slotId ? (world.slots.find((slot) => slot.id === move.slotId) ?? null) : null, newId: move.slotId ? null : newId(), minutes: standardOf(operation, operation.remaining) }
  })
  const movedSlots = new Map(staged.filter((entry) => entry.slot).map((entry) => [entry.slot!.id, entry]))
  const slotsAfter: (PlannedSlot & Pick<SlotRow, 'partyId'>)[] = [
    ...world.slots.map((slot) => {
      const entry = movedSlots.get(slot.id)
      return entry ? { ...slot, startAt: new Date(entry.move.to.start), endAt: new Date(entry.move.to.end), minutes: entry.minutes } : slot
    }),
    ...staged.filter((entry) => entry.newId).map((entry) => ({ id: entry.newId!, workOrderId: entry.workOrder.id, workOrderOperationId: entry.operation.id, ...laneColumns(entry.lane), startAt: new Date(entry.move.to.start), endAt: new Date(entry.move.to.end), pieces: null, minutes: entry.minutes })),
  ]
  const capacity = capacityWith(world, slotsAfter)
  const moves: RunMove[] = staged.map((entry) => ({
    ...entry.move,
    lane: entry.lane,
    workOrder: entry.workOrder,
    operation: entry.operation,
    slot: entry.slot,
    newId: entry.newId,
    minutes: entry.minutes,
    over: entry.workOrder.booksCapacity ? overDays(world, capacity, entry.lane, new Date(entry.move.to.start), new Date(entry.move.to.end)) : [],
  }))
  return { mode, moves, kept, skipped, candidates, from, finishes: chains.finishes, starts, after: schedulesOf(world, slotsAfter) }
}

const iso = (value: number | null): string | null => (value === null ? null : toUtcIso(new Date(value)))

/** The answer of a preview or an applied run. */
function runView(world: ScheduleWorld, run: Run, planVersion: number | null, applied: boolean) {
  const tz = world.site.timezone
  const say = (instant: number) => whenWords(instant, tz)
  const orders = run.candidates.map((workOrder) => {
    const before = world.schedules.get(workOrder.id)!
    const after = run.after.schedules.get(workOrder.id)!
    const finish = run.finishes.get(workOrder.id) ?? null
    const daysLate = workOrder.dueDate && finish !== null ? Math.max(0, daysFrom(workOrder.dueDate, businessDate(new Date(finish), tz))) : null
    const own = run.moves.filter((move) => move.workOrderId === workOrder.id)
    const start = run.starts.get(workOrder.id)!
    const material = materialStartViewOf(world, workOrder, start)
    const due = workOrder.dueDate ? dayWords(workOrder.dueDate) : null
    const lateWords = finish === null ? '' : due === null ? '' : daysLate && daysLate > 0 ? `, ${daysLate === 1 ? '1 day' : `${daysLate} days`} after its due date ${due}` : `, by its due date ${due}`
    const from = run.from.get(workOrder.id)!
    let words: string
    if (finish === null) words = `${workOrder.number}: nothing of it could be scheduled on the lanes' free time.`
    else if (run.mode === 'FORWARD') words = `Scheduled forward from ${say(from)} on the lanes' free time, ${workOrder.number} finishes ${say(finish)}${lateWords}.`
    else words = own.length === 0 ? `${workOrder.number}: what is left in the past stays (pinned); it finishes ${say(finish)}${lateWords}.` : `${workOrder.number}: ${own.length === 1 ? '1 bar moves' : `${own.length} bars move`} into the free time from ${say(Math.min(...own.map((move) => move.to.start)))}; it finishes ${say(finish)}${lateWords}.`
    return {
      workOrderId: workOrder.id,
      number: workOrder.number,
      dueDate: workOrder.dueDate,
      before: { status: before.status, plannedFinish: iso(before.plannedFinish), earliestFinish: iso(before.earliestFinish), words: before.words },
      after: { status: after.status, plannedFinish: iso(after.plannedFinish), words: after.words },
      finish: iso(finish),
      daysLate,
      material: { state: material.state, earliestStart: material.earliestStart, words: material.words },
      moves: own.length,
      words,
    }
  })
  const moved = run.moves.filter((move) => move.slotId !== null).length
  const placed = run.moves.length - moved
  const pinned = run.kept.filter((entry) => entry.code !== 'NO_WORKING_TIME').length
  const parts = [moved ? `${moved === 1 ? '1 bar moves' : `${moved} bars move`}` : null, placed ? `${placed} placed from the tray` : null, pinned ? `${pinned === 1 ? '1 pinned bar stays' : `${pinned} pinned bars stay`}` : null].filter(Boolean)
  const subject = run.mode === 'FORWARD' ? `${run.candidates.length === 1 ? '1 work order' : `${run.candidates.length} work orders`} scheduled forward from today` : `The backlog of ${run.candidates.length === 1 ? '1 work order' : `${run.candidates.length} work orders`}`
  const words =
    run.candidates.length === 0
      ? run.mode === 'FORWARD'
        ? 'No work order to schedule forward: every open order can still meet its due date scheduled backwards.'
        : 'Nothing is left in the past: every bar that should have ended is done.'
      : `${subject}: ${parts.length ? parts.join(', ') : 'nothing moves'}.`
  return {
    planVersion,
    applied,
    mode: run.mode,
    moves: run.moves.map((move) => ({
      workOrderId: move.workOrderId,
      number: move.workOrder.number,
      operationId: move.operationId,
      operation: { seq: move.operation.seq, code: move.operation.code, name: move.operation.name },
      slotId: move.slotId,
      lane: move.lane,
      from: move.from ? { startAt: toUtcIso(new Date(move.from.start)), endAt: toUtcIso(new Date(move.from.end)) } : null,
      to: { startAt: toUtcIso(new Date(move.to.start)), endAt: toUtcIso(new Date(move.to.end)) },
      minutes: move.minutes.toFixed(1),
      why: move.why,
      over: move.over,
    })),
    orders,
    kept: run.kept.map((entry) => ({ ...entry })),
    skipped: run.skipped.map((entry) => ({ ...entry })),
    overbooked: run.moves.filter((move) => move.over.length > 0).length,
    words,
  }
}

const reasonOf = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

const spanOf = (world: Pick<ScheduleWorld, 'today'>) => ({ from: world.today, to: plusDays(world.today, HORIZON_DAYS) })

async function runRoute(caller: CommandCaller, mode: RunMode, body: ForwardBody | BacklogBody, idempotencyKey: string | undefined) {
  const context = officeContextOf(caller)
  const site: SiteRow = await siteFor(caller, body.siteId, body.apply ? PLANNING_SCHEDULE_MANAGE : PLANNING_VIEW)
  const workOrderIds = 'workOrderIds' in body ? body.workOrderIds : undefined
  if (!body.apply) {
    const now = serverClock.now()
    return caller.withClient(async (db) => {
      const today = businessDate(now, site.timezone)
      const world = await scheduleWorld(db, site, spanOf({ today }), now)
      const run = await runOf(db, world, mode, workOrderIds)
      return { ...runView(world, run, world.plan?.version ?? null, false), replayed: false }
    })
  }
  const { result, replayed } = await command(caller, { name: mode === 'FORWARD' ? 'planning.schedule.forward' : 'planning.schedule.rescheduleBacklog', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const plan = await lockedWorkingPlan(tx, site, context.tenantId, { actorId: context.actorId, now, expectedVersion: body.version, bump: true })
    const today = businessDate(now, site.timezone)
    const world = await scheduleWorld(tx, site, spanOf({ today }), now)
    const run = await runOf(tx, world, mode, workOrderIds)
    if (run.moves.length === 0) {
      const first = run.kept[0]?.words ?? run.skipped[0]?.words ?? null
      const why =
        run.candidates.length === 0
          ? runView(world, run, plan.version, false).words
          : first
            ? `Nothing to move: ${first}`
            : `Nothing to move: ${run.candidates.length === 1 ? `${run.candidates[0]!.number} is` : `the ${run.candidates.length} work orders are`} already where ${mode === 'FORWARD' ? 'scheduling from today' : 'the backlog reschedule'} puts ${run.candidates.length === 1 ? 'it' : 'them'}.`
      throw new ScheduleRefusal('NOTHING_TO_RESCHEDULE', why)
    }
    const over = run.moves.filter((move) => move.over.length > 0)
    const reason = reasonOf(body.overloadReason)
    if (over.length > 0 && reason === null) {
      const first = over[0]!
      const name = world.lanes.get(laneKey(first.lane))?.name ?? 'A lane'
      const day = first.over[0]!
      throw new DomainError('conflict', `${over.length} of the ${run.moves.length} moves would overbook their lanes (${name} would be at ${day.loadPct ?? '—'}% on ${dayWords(day.date)}, +${day.overMinutes} min over). Give a reason to keep them, or move them by hand.`, [
        { path: 'body/overloadReason', message: 'Say why they stay on the overbooked lanes.' },
        ...first.over.map((entry) => ({ path: `over/${entry.date}`, message: `${entry.bookedMinutes} of ${entry.availableMinutes} min (${entry.loadPct ?? '—'}%), +${entry.overMinutes} over.` })),
        refusalIssue('OVERLOAD'),
      ])
    }
    if (reason !== null && reason.length < 3) throw new ValidationError('Say in a few words why they stay on the overbooked lanes.', [{ path: 'body/overloadReason', message: 'At least 3 characters.' }])
    for (const move of run.moves) {
      if (!move.slot) continue
      const { count } = await tx.scheduleSlot.updateMany({
        where: { id: move.slot.id, version: move.slot.version, pinned: false },
        data: { startAt: new Date(move.to.start), endAt: new Date(move.to.end), minutes: move.minutes.toFixed(3), overloadReason: move.over.length > 0 ? reason : null, version: move.slot.version + 1, updatedAt: now, updatedById: context.actorId },
      })
      if (count !== 1) throw new ScheduleRefusal('SLOT_MOVED', 'A bar moved meanwhile: reload the board.')
    }
    const placements = run.moves.filter((move) => move.newId)
    if (placements.length > 0) {
      await tx.scheduleSlot.createMany({
        data: placements.map((move) => ({
          id: move.newId!,
          siteId: site.id,
          planVersionId: plan.id,
          planKind: 'WORKING' as const,
          workOrderId: move.workOrderId,
          workOrderOperationId: move.operationId,
          ...laneColumns(move.lane),
          startAt: new Date(move.to.start),
          endAt: new Date(move.to.end),
          pieces: null,
          minutes: move.minutes.toFixed(3),
          overloadReason: move.over.length > 0 ? reason : null,
          note: null,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
          updatedById: context.actorId,
        })),
      })
    }
    await logChanges(
      tx,
      site,
      plan.id,
      run.moves.map((move) => ({
        kind: move.slot ? ('MOVE' as const) : ('PLACE' as const),
        slotId: move.slot?.id ?? move.newId!,
        workOrderId: move.workOrderId,
        operationId: move.operationId,
        from: move.slot ? { lane: move.lane, startAt: move.slot.startAt, endAt: move.slot.endAt } : null,
        to: { lane: move.lane, startAt: new Date(move.to.start), endAt: new Date(move.to.end) },
        reason: move.over.length > 0 ? reason : null,
      })),
      context.actorId,
      now,
    )
    const view = runView(world, run, plan.version, true)
    tools.audit({
      action: mode === 'FORWARD' ? 'planning.schedule.forward' : 'planning.schedule.rescheduleBacklog',
      recordType: 'PlanVersion',
      recordId: plan.id,
      companyId: site.companyId,
      siteId: site.id,
      before: null,
      after: {
        moves: run.moves.map((move, index) => ({ slotId: move.slot?.id ?? move.newId, workOrderId: move.workOrderId, operationId: move.operationId, lane: move.lane, from: view.moves[index]!.from, to: view.moves[index]!.to, why: move.why })),
        kept: view.kept.map((entry) => ({ slotId: entry.slotId, code: entry.code })),
        overbooked: view.overbooked,
        overloadReason: over.length > 0 ? reason : null,
      },
    })
    emitDepthChange(
      tools,
      site,
      plan,
      mode === 'FORWARD' ? 'SCHEDULED_FORWARD' : 'BACKLOG_RESCHEDULED',
      run.moves.map((move) => move.slot?.id ?? move.newId!),
      run.moves.map((move) => move.workOrderId),
    )
    return view
  })
  return { ...result, replayed }
}

/** POST /planning/schedule/forward: late work orders scheduled forward from today; a preview, or applied in one command. */
export const scheduleForward = (caller: CommandCaller, body: ForwardBody, idempotencyKey?: string) => runRoute(caller, 'FORWARD', body, idempotencyKey)

/** POST /planning/schedule/reschedule-backlog: bars left in the past into the first free time; a preview, or applied. */
export const rescheduleBacklog = (caller: CommandCaller, body: BacklogBody, idempotencyKey?: string) => runRoute(caller, 'BACKLOG', body, idempotencyKey)
