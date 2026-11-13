import type { PlanningCard, PlanningLane, PlanningMark, PlanningPlace } from '@nexus/ui/patterns/planning-board/index'
import { isApiError, issuePath } from '../../../../lib/api/errors'
import { INTL_LOCALE, type Locale } from '../../../../lib/i18n/locales'
import type { Translate } from '../../../../lib/i18n/messages'
import { capacityLineWords, laneHoldCodes, holdWords, workshopDetail, workshopOf, type Words as AllocationWords } from '../../allocation/depth/model'
import type { AllocationWorkshops } from '../../allocation/depth/api'
import type { Subcontractors } from '../../capacity/depth/api'
import type { Board, BoardSlot, FloorView, MoreProblem } from '../api'
import { dayWords, laneKeyOf, laneRefOf, whenWords, workOrderOfTrayCard, type MovePlan } from '../model'
import type { BacklogRun, ChangeEntry, MaterialAnswer, VersionBoard, VersionSlot, WhatIf, WhatIfMoveInput } from './api'

/**
 * The planning board in depth (SCR-122, B-W2b-337), pure: the bars' state on the floor and their pins, the workshops as lanes
 * (what they are approved for, their DURC, their weekly capacity in words, a drop held for a workshop that takes no work),
 * the private what-if drawn on the board (the working plan with the tried moves) and the list of moves it sends, its
 * effect in words, the change log in words (who, when, from → to, why an undo is held), the problems list's three W2b
 * kinds, the backlog reschedule's review, the material check's words, a published version on the DS board and the day
 * sheets' address. The API's English is never shown: codes and facts become words of `planning-board-depth`. No money; per
 * line, work centre, workshop and work order; a planner's name only inside one change of the log.
 */

export const DEPTH_NAMESPACE = 'planning-board-depth'

export interface DepthWords {
  t: Translate
  locale: Locale
  timeZone: string
}

const number = (value: number | string, locale: Locale, digits = 0) => new Intl.NumberFormat(INTL_LOCALE[locale], { maximumFractionDigits: digits }).format(Number(value))

/** "17 Nov, 10:00–18:00" (the end's day too when it is another day). */
export function spanWords(startAt: string, endAt: string, words: Pick<DepthWords, 'locale' | 'timeZone'>): string {
  const start = whenWords(startAt, words)
  const sameDay = new Intl.DateTimeFormat('en-CA', { timeZone: words.timeZone }).format(new Date(startAt)) === new Intl.DateTimeFormat('en-CA', { timeZone: words.timeZone }).format(new Date(endAt))
  const end = sameDay ? new Intl.DateTimeFormat(INTL_LOCALE[words.locale], { timeZone: words.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(endAt)) : whenWords(endAt, words)
  return `${start}–${end}`
}

// ---- the floor's state and the pin on a bar (PLN-133, PLN-139) --------------------------------------------------------------

/** The bar's state on the floor as a mark in words, its colour by tone (the DS card has no progress fill: named). */
export function floorMark(floor: FloorView | null | undefined, words: DepthWords): PlanningMark | null {
  if (!floor) return null
  const { t, locale } = words
  const args = { done: number(floor.done, locale), of: number(floor.of, locale), pct: number(floor.pct, locale) }
  if (floor.state === 'NOT_STARTED') return { label: t('floor.NOT_STARTED'), tone: 'neutral' }
  if (floor.state === 'DONE') return { label: t('floor.DONE'), tone: 'success' }
  if (floor.state === 'PAUSED') return { label: t('floor.PAUSED', args), tone: 'warning' }
  return { label: t(floor.runningBundles > 0 ? 'floor.RUNNING' : 'floor.UNDER_WAY', args), tone: 'info' }
}

/** The floor's state in a sentence (the bar's detail). */
export function floorSentence(floor: FloorView | null | undefined, words: DepthWords): string | null {
  if (!floor) return null
  const { t, locale } = words
  const args = { done: number(floor.done, locale), of: number(floor.of, locale), count: floor.runningBundles, bundles: number(floor.runningBundles, locale), paused: number(floor.pausedBundles, locale), since: floor.since ? whenWords(floor.since, words) : '—' }
  if (floor.state === 'RUNNING' && floor.runningBundles > 0) return t('floor.sentence.RUNNING', args)
  if (floor.state === 'RUNNING') return t('floor.sentence.UNDER_WAY', args)
  return t(`floor.sentence.${floor.state}`, args)
}

export interface CardExtras {
  /** Work orders that wait on a pre-production gate not passed (the problems list's GATE_NOT_PASSED). */
  gates: ReadonlySet<string>
  /** Bars a what-if moved or placed (said on the card). */
  tried: ReadonlySet<string>
}

/** The W2a cards with the W2b facts: pinned (the DS refuses to move it), the floor's state, a gate not passed, a what-if try. */
export function decorateCards(cards: readonly PlanningCard[], board: Board, extras: CardExtras, words: DepthWords): PlanningCard[] {
  const slots = new Map(board.slots.map((slot) => [slot.id, slot]))
  return cards.map((card) => {
    const tray = workOrderOfTrayCard(card.id)
    const slot = tray ? undefined : slots.get(card.id)
    const workOrderId = tray ?? slot?.workOrderId ?? null
    const marks: PlanningMark[] = [...(card.marks ?? [])]
    const floor = floorMark(slot?.floor, words)
    if (floor) marks.unshift(floor)
    if (workOrderId && extras.gates.has(workOrderId)) marks.push({ label: words.t('mark.gate'), tone: 'danger' })
    if (extras.tried.has(card.id)) marks.push({ label: words.t('mark.tried'), tone: 'info' })
    return { ...card, pinned: slot?.pinned === true, marks }
  })
}

export const isPinned = (slot: Pick<BoardSlot, 'pinned'> | undefined | null): boolean => slot?.pinned === true

// ---- workshops as lanes (B-W2b-321) --------------------------------------------------------------------------------------

export type Loaded<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; value: T }

/**
 * A workshop lane with its W2b facts: what it is approved for and its DURC (under its name), its weekly capacity per bucket in
 * words (minutes or garments, as each line counts; "no capacity set" when none, never 0). Its LoadBar stays "not known": a
 * workshop's capacity counts one kind of work or garments, the board's minutes count every operation (B-W2b-338's rule).
 */
export function decorateWorkshopLanes(lanes: readonly PlanningLane[], workshops: Loaded<AllocationWorkshops>, subs: Loaded<Subcontractors>, aw: AllocationWords): PlanningLane[] {
  return lanes.map((lane) => {
    const ref = laneRefOf(lane.id)
    if (ref?.kind !== 'WORKSHOP') return lane
    const workshop = workshops.status === 'ready' ? workshopOf(workshops.value, ref.id) : null
    const lines = subs.status === 'ready' ? subs.value.lanes.filter((line) => line.id === ref.id) : []
    const capacityWords: Record<string, string> = { ...(lane.capacityWords ?? {}) }
    if (subs.status === 'ready') {
      for (const bucket of subs.value.buckets) {
        const said = lines.map((line) => {
          const cell = line.cells.find((entry) => entry.key === bucket.key)
          return capacityLineWords({ workCentreKind: line.workCentreKind, unit: line.unit, available: cell?.available ?? null, booked: cell?.booked ?? '0', proposed: cell?.proposed ?? '0', loadPct: cell?.loadPct ?? null, over: cell?.over ?? false }, aw)
        })
        capacityWords[bucket.key] = said.length > 0 ? said.join(' ') : aw.t('al.capacity.unknown', { workshop: lane.label })
      }
    }
    return { ...lane, detail: workshop ? `${lane.detail ?? ''}${lane.detail ? ' · ' : ''}${workshopDetail(workshop, aw)}` : lane.detail, capacityWords }
  })
}

/**
 * Why a bar (or a tray card) may not be dropped on a workshop lane from elsewhere, or null: while the workshops are read, a
 * workshop that takes no work whatever the card (not active, its supplier's status, no stock location, no valid DURC), and in
 * what-if (work goes outside only through Move to a subcontractor, with its kit). A bar already at the workshop moves in time.
 */
export function workshopDropHeld(board: Board, card: Pick<PlanningCard, 'id' | 'laneId'>, to: PlanningPlace, workshops: Loaded<AllocationWorkshops>, whatIf: boolean, siteName: string, words: DepthWords, aw: AllocationWords): string | null {
  const ref = laneRefOf(to.laneId)
  if (ref?.kind !== 'WORKSHOP' || card.laneId === to.laneId) return null
  if (whatIf) return words.t('held.workshopInWhatIf')
  if (workshops.status === 'loading') return words.t('held.workshopChecking')
  if (workshops.status === 'error') return words.t('held.workshopNotChecked')
  const workshop = workshopOf(workshops.value, ref.id)
  if (!workshop) return words.t('held.workshopNotOffered', { workshop: board.lanes.find((lane) => laneKeyOf(lane) === to.laneId)?.name ?? '' })
  const code = laneHoldCodes(workshop)[0]
  return code ? holdWords({ code, words: code === 'SUPPLIER_STATUS' ? (workshop.supplierProblem ?? '') : '' }, workshop, siteName, aw) : null
}

/** A drop from another lane on a workshop (a bar of an operation, not a part): it opens Move to a subcontractor instead. */
export function workshopDropOf(board: Board, plan: MovePlan): { slotId: string; workOrderId: string; operationId: string; partyId: string; start: string | null } | null {
  if (plan.kind !== 'move' || !plan.lane || plan.lane.kind !== 'WORKSHOP') return null
  const slot = board.slots.find((entry) => entry.id === plan.slotId)
  if (!slot || slot.operationId === null || slot.lane.kind === 'WORKSHOP') return null
  const start = plan.startAt ?? slot.startAt
  return { slotId: slot.id, workOrderId: slot.workOrderId, operationId: slot.operationId, partyId: plan.lane.id, start: new Intl.DateTimeFormat('en-CA', { timeZone: board.site.timeZone }).format(new Date(start)) }
}

// ---- what-if (design sec:whatif) -------------------------------------------------------------------------------------------

export const WHAT_IF_CARD = 'whatif:'
export const whatIfCardOf = (workOrderId: string, operationId: string): string => `${WHAT_IF_CARD}${workOrderId}:${operationId}`
export function whatIfCardParts(cardId: string): { workOrderId: string; operationId: string } | null {
  if (!cardId.startsWith(WHAT_IF_CARD)) return null
  const [workOrderId, operationId] = cardId.slice(WHAT_IF_CARD.length).split(':')
  return workOrderId && operationId ? { workOrderId, operationId } : null
}

/**
 * The working plan as the what-if has it: each tried bar at its new place, a bar sent back to the tray off the board (its
 * order back in the tray), an operation placed from the tray as a bar of its own. Everything the board does (drawing, the
 * drops it holds, what a move asks) then works on it unchanged; nothing of it is saved but the scenario's list of moves.
 */
export function whatIfBoard(board: Board, scenario: Pick<WhatIf, 'moves' | 'basedAt'> | null): Board {
  if (!scenario || scenario.moves.length === 0) return board
  const slots = board.slots.map((slot) => ({ ...slot }))
  const byId = new Map(slots.map((slot) => [slot.id, slot]))
  const workOrders = board.workOrders.map((workOrder) => ({ ...workOrder, operations: workOrder.operations.map((operation) => ({ ...operation, slotIds: [...operation.slotIds] })) }))
  const orderOf = new Map(workOrders.map((workOrder) => [workOrder.id, workOrder]))
  const tray = board.tray.map((entry) => ({ ...entry }))
  const removed = new Set<string>()
  const added: BoardSlot[] = []
  for (const move of scenario.moves) {
    const workOrder = orderOf.get(move.workOrderId)
    if (move.kind === 'MOVE' && move.slotId && move.to) {
      const slot = byId.get(move.slotId)
      if (slot) Object.assign(slot, { lane: move.to.lane, startAt: move.to.startAt, endAt: move.to.endAt })
    } else if (move.kind === 'REMOVE' && move.slotId) {
      const slot = byId.get(move.slotId)
      if (!slot) continue
      removed.add(slot.id)
      const operation = workOrder?.operations.find((entry) => entry.id === slot.operationId)
      if (operation) operation.slotIds = operation.slotIds.filter((id) => id !== slot.id)
      const entry = tray.find((row) => row.workOrderId === move.workOrderId)
      if (entry) {
        entry.unplacedOperations += 1
        entry.minutes = (Number(entry.minutes) + Number(slot.minutes)).toFixed(1)
      } else tray.push({ workOrderId: move.workOrderId, unplacedOperations: 1, minutes: slot.minutes, latestSafeStart: workOrder?.schedule.latestSafeStart ?? null, chips: [] })
    } else if (move.kind === 'PLACE' && move.operationId && move.to && workOrder) {
      const operation = workOrder.operations.find((entry) => entry.id === move.operationId)
      const id = whatIfCardOf(move.workOrderId, move.operationId)
      added.push({
        id,
        version: 0,
        lane: move.to.lane,
        workOrderId: move.workOrderId,
        operationId: move.operationId,
        startAt: move.to.startAt,
        endAt: move.to.endAt,
        pieces: null,
        minutes: operation?.minutes ?? '0',
        overloadReason: null,
        note: null,
        updatedAt: scenario.basedAt,
        updatedBy: null,
        booksCapacity: workOrder.booksCapacity,
        latestStart: operation?.latestStart ?? null,
        latestFinish: operation?.latestFinish ?? null,
        startsLate: false,
        pinned: false,
        floor: null,
      })
      if (operation) operation.slotIds.push(id)
      const entry = tray.find((row) => row.workOrderId === move.workOrderId)
      if (entry) {
        entry.unplacedOperations -= 1
        entry.minutes = Math.max(0, Number(entry.minutes) - Number(operation?.minutes ?? 0)).toFixed(1)
      }
    }
  }
  return { ...board, slots: [...slots.filter((slot) => !removed.has(slot.id)), ...added], workOrders, tray: tray.filter((entry) => entry.unplacedOperations > 0) }
}

/** The bars a what-if moved or placed (their cards say so). */
export function triedCards(scenario: Pick<WhatIf, 'moves'> | null): Set<string> {
  const out = new Set<string>()
  for (const move of scenario?.moves ?? []) {
    if (move.kind === 'MOVE' && move.slotId) out.add(move.slotId)
    if (move.kind === 'PLACE' && move.operationId) out.add(whatIfCardOf(move.workOrderId, move.operationId))
  }
  return out
}

const moveKey = (move: WhatIfMoveInput): string => (move.kind === 'PLACE' ? `op:${move.workOrderId}:${move.operationId}` : `slot:${move.slotId}`)

/** The scenario's moves as the API takes them again (each with its target, so an unchanged one keeps its first version). */
export function whatIfInputs(scenario: Pick<WhatIf, 'moves'>): WhatIfMoveInput[] {
  return scenario.moves.flatMap((move): WhatIfMoveInput[] => {
    if (move.kind === 'REMOVE' && move.slotId) return [{ kind: 'REMOVE', slotId: move.slotId }]
    if (move.kind === 'MOVE' && move.slotId && move.to) return [{ kind: 'MOVE', slotId: move.slotId, lane: move.to.lane, startAt: move.to.startAt, endAt: move.to.endAt }]
    if (move.kind === 'PLACE' && move.operationId && move.to) return [{ kind: 'PLACE', workOrderId: move.workOrderId, operationId: move.operationId, lane: move.to.lane, startAt: move.to.startAt, endAt: move.to.endAt }]
    return []
  })
}

/**
 * The scenario's next list after one move of the board (planned on the what-if board): a bar moved again replaces its entry,
 * a placed operation moved again is placed elsewhere, a placed one sent back to the tray leaves the list. Null: nothing to try.
 */
export function withTriedMove(inputs: readonly WhatIfMoveInput[], plan: MovePlan, board: Board): WhatIfMoveInput[] | null {
  if (plan.kind === 'none') return null
  let entry: WhatIfMoveInput | null = null
  let drop: string | null = null
  if (plan.kind === 'place') entry = { kind: 'PLACE', workOrderId: plan.workOrderId, operationId: plan.operationId, lane: plan.lane, startAt: plan.startAt }
  else {
    const slot = board.slots.find((candidate) => candidate.id === plan.slotId)
    if (!slot) return null
    const placed = whatIfCardParts(slot.id)
    if (plan.kind === 'remove') {
      if (placed) drop = `op:${placed.workOrderId}:${placed.operationId}`
      else entry = { kind: 'REMOVE', slotId: slot.id }
    } else if (placed) entry = { kind: 'PLACE', workOrderId: placed.workOrderId, operationId: placed.operationId, lane: plan.lane ?? slot.lane, startAt: plan.startAt ?? slot.startAt }
    else entry = { kind: 'MOVE', slotId: slot.id, lane: plan.lane ?? slot.lane, startAt: plan.startAt ?? slot.startAt }
  }
  const out = inputs.filter((input) => moveKey(input) !== drop)
  if (!entry) return out
  const key = moveKey(entry)
  const at = out.findIndex((input) => moveKey(input) === key)
  if (at >= 0) out[at] = entry
  else out.push(entry)
  return out
}

/** "6 h" / "2.5 h" from standard minutes in the page's language. */
export const hoursWords = (minutes: string | number, words: Pick<DepthWords, 't' | 'locale'>): string => words.t('whatif.hours', { hours: number(Number(minutes) / 60, words.locale, 1) })

/** The WhatIfBar's deltas in words: late orders, overtime needed, each touched lane's load, the orders that move. */
export function effectParts(scenario: WhatIf, words: DepthWords): string[] {
  const { t, locale } = words
  const effect = scenario.effect
  const parts = [
    t('whatif.late', { before: number(effect.lateOrders.before, locale), after: number(effect.lateOrders.after, locale) }),
    t('whatif.overtime', { before: hoursWords(effect.overMinutes.before, words), after: hoursWords(effect.overMinutes.after, words) }),
    ...effect.lanes.map((lane) => t('whatif.lane', { lane: lane.code, before: lane.beforePct === null ? '—' : `${number(lane.beforePct, locale)}%`, after: lane.afterPct === null ? '—' : `${number(lane.afterPct, locale)}%` })),
    t('whatif.orders', { count: effect.orders.length, orders: number(effect.orders.length, locale) }),
  ]
  return parts
}

/** One order the what-if moves: "WO-0102 finishes 21 Nov, 12:00 → 20 Nov, 16:00 (Late → On time)". */
export function orderMoveWords(order: WhatIf['effect']['orders'][number], words: DepthWords): string {
  const { t } = words
  const when = (value: string | null) => (value ? whenWords(value, words) : t('whatif.notPlanned'))
  const status = order.before.status === order.after.status ? '' : ` (${t(`status.${order.before.status}`)} → ${t(`status.${order.after.status}`)})`
  return `${t('whatif.orderFinish', { order: order.number, before: when(order.before.plannedFinish), after: when(order.after.plannedFinish) })}${status}`
}

/** One tried move in words: "Op 20 Sewing of WO-0101: L1 · 17 Nov, 08:00–16:00 → L2 · 18 Nov, 08:00–16:00". */
export function triedMoveWords(move: WhatIf['moves'][number], board: Board, words: DepthWords): { what: string; from: string | null; to: string | null } {
  const { t } = words
  const what = move.operation ? t('log.what', { seq: move.operation.seq, operation: move.operation.name, order: move.number }) : t('log.whatPart', { order: move.number })
  const place = (value: { lane: { kind: string; id: string }; startAt: string; endAt: string } | null) => {
    if (!value) return null
    const lane = board.lanes.find((entry) => entry.kind === value.lane.kind && entry.id === value.lane.id)
    return `${lane?.code ?? '—'} · ${spanWords(value.startAt, value.endAt, words)}`
  }
  return { what, from: move.kind === 'PLACE' ? null : place(move.from), to: move.kind === 'REMOVE' ? null : place(move.to) }
}

/** The conflicts of an Apply refused (issues `moves/<i>/<CODE>`), else the scenario's own per move. */
export function applyConflicts(error: unknown, scenario: WhatIf | null): Array<{ index: number; code: string }> {
  if (isApiError(error)) {
    const found = error.issues.flatMap((issue) => {
      const match = /^moves\/(\d+)\/([A-Z_]+)$/.exec(issuePath(issue).replace(/\./g, '/'))
      return match ? [{ index: Number(match[1]), code: match[2]! }] : []
    })
    if (found.length > 0) return found
  }
  return (scenario?.moves ?? []).flatMap((move, index) => (move.conflict ? [{ index, code: move.conflict.code }] : []))
}

// ---- the change log (PLN-149, design sec:log) ---------------------------------------------------------------------------------

export const LOG_KINDS = ['MOVE', 'PLACE', 'REMOVE', 'PIN', 'PUBLISH', 'UNDO'] as const
export type LogKind = (typeof LOG_KINDS)[number]
/** The kinds a filter chip asks for (pins with unpins). */
export const kindsOf = (chips: readonly LogKind[]): string[] => chips.flatMap((chip) => (chip === 'PIN' ? ['PIN', 'UNPIN'] : [chip]))

const toneOf: Record<ChangeEntry['kind'], 'neutral' | 'info' | 'success' | 'warning'> = { PLACE: 'success', MOVE: 'info', REMOVE: 'warning', PIN: 'neutral', UNPIN: 'neutral', PUBLISH: 'success', UNDO: 'neutral' }
export const changeTone = (entry: Pick<ChangeEntry, 'kind'>) => toneOf[entry.kind]

/** What the change was about: "Op 20 Sewing of WO-0101", "part of WO-0101". */
export function changeWhat(entry: Pick<ChangeEntry, 'operation' | 'workOrder'>, words: Pick<DepthWords, 't'>): string {
  const order = entry.workOrder?.number ?? '—'
  const op = entry.operation
  if (!op) return words.t('log.whatPart', { order })
  // B-W2b-F39: an operation that left its work order since, by the record's copy ("… (no longer on the work order)").
  if (!op.onWorkOrder) return op.seq !== null && op.name !== null ? words.t('log.whatGone', { seq: op.seq, operation: op.name, order }) : words.t('log.whatGoneUnnamed', { order })
  return words.t('log.what', { seq: op.seq ?? '—', operation: op.name ?? '—', order })
}

/** The entry's head line in words. */
export function changeLabel(entry: ChangeEntry, words: DepthWords): string {
  const { t } = words
  if (entry.kind === 'PUBLISH') return t('log.kind.PUBLISH', { version: entry.publishedVersion?.number ?? '—' })
  const what = changeWhat(entry, words)
  if (entry.kind === 'UNDO') return t('log.kind.UNDO', { what, kind: t(`log.undid.${entry.undoes?.kind ?? 'MOVE'}`) })
  if (entry.kind === 'PLACE') return t('log.kind.PLACE', { what, lane: entry.to?.lane.code ?? '—' })
  return t(`log.kind.${entry.kind}`, { what })
}

/** A place of the log: "L1 · 17 Nov, 10:00–18:00". */
export const changePlaceWords = (place: ChangeEntry['from'], words: DepthWords): string | null => (place ? `${place.lane.code} · ${spanWords(place.startAt, place.endAt, words)}` : null)

/** The muted line under it: who, why, a what-if, undone by whom. */
export function changeDetail(entry: ChangeEntry, words: DepthWords): string {
  const { t } = words
  const parts: string[] = [entry.changedBy ? t('log.by', { name: entry.changedBy.name, time: whenWords(entry.changedAt, words) }) : t('log.byNobody', { time: whenWords(entry.changedAt, words) })]
  if (entry.whatIfScenarioId) parts.push(t('log.fromWhatIf'))
  if (entry.reason) parts.push(t('log.reason', { reason: entry.reason }))
  if (entry.undoneBy) parts.push(entry.undoneBy.changedBy ? t('log.undoneBy', { name: entry.undoneBy.changedBy.name, time: whenWords(entry.undoneBy.changedAt, words) }) : t('log.undone', { time: whenWords(entry.undoneBy.changedAt, words) }))
  return parts.join(' · ')
}

/** Why "Undo" is held on an entry, or null when it may be undone now. */
export function undoHeldWords(entry: ChangeEntry, words: DepthWords): string | null {
  if (entry.undo.may) return null
  const { t } = words
  const code = entry.undo.code ?? 'NOT_UNDOABLE'
  if (code === 'ALREADY_UNDONE' && entry.undoneBy) return entry.undoneBy.changedBy ? t('log.undoHeld.ALREADY_UNDONE_BY', { name: entry.undoneBy.changedBy.name, time: whenWords(entry.undoneBy.changedAt, words) }) : t('log.undoHeld.ALREADY_UNDONE')
  if (code === 'NOT_UNDOABLE' && entry.kind === 'REMOVE' && entry.operation === null) return t('log.undoHeld.PART_REMOVED')
  return t(`log.undoHeld.${code}`)
}

/** ⌘Z: the newest change of mine that may be undone now (it goes back one change at a time). */
export function myLatestUndoable(entries: readonly ChangeEntry[], me: string | null): ChangeEntry | null {
  if (!me) return null
  return entries.find((entry) => entry.changedBy?.id === me && entry.undo.may) ?? null
}

/** The planners named in the log read so far ("Filter by planner"): office users already named on the entries, no count. */
export function plannersOf(entries: readonly ChangeEntry[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>()
  for (const entry of entries) if (entry.changedBy) seen.set(entry.changedBy.id, entry.changedBy.name)
  return [...seen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name))
}

// ---- the problems list's W2b kinds ----------------------------------------------------------------------------------------------

export interface DepthProblemRow {
  id: string
  kind: MoreProblem['kind']
  words: string
  workOrderId: string
  slotId: string | null
  laneId: string | null
  date: string | null
  /** The quick fix there is: snap the first bar to the material's day, or reschedule the backlog. */
  fix: 'snap' | 'backlog' | null
}

export function depthProblemRows(board: Board, words: DepthWords): DepthProblemRow[] {
  const { t, locale } = words
  return (board.moreProblems ?? []).map((problem, index) => {
    const workOrder = board.workOrders.find((entry) => entry.id === problem.workOrderId)
    const slot = problem.slotId ? board.slots.find((entry) => entry.id === problem.slotId) : undefined
    const operation = slot?.operationId ? workOrder?.operations.find((entry) => entry.id === slot.operationId) : undefined
    const lane = problem.lane ? board.lanes.find((entry) => laneKeyOf(entry) === laneKeyOf(problem.lane!)) : undefined
    const order = workOrder?.number ?? '—'
    const base = { id: `${problem.kind}:${problem.slotId ?? problem.workOrderId}:${index}`, kind: problem.kind, workOrderId: problem.workOrderId, slotId: problem.slotId, laneId: problem.lane ? laneKeyOf(problem.lane) : null, date: problem.date }
    if (problem.kind === 'IN_THE_PAST') {
      const what = operation ? t('log.what', { seq: operation.seq, operation: operation.name, order }) : t('log.whatPart', { order })
      return { ...base, words: t(isPinned(slot) ? 'problem.IN_THE_PAST_PINNED' : 'problem.IN_THE_PAST', { what, lane: lane?.name ?? '—', day: problem.date ? dayWords(problem.date, locale) : '—' }), fix: isPinned(slot) ? null : 'backlog' }
    }
    if (problem.kind === 'MATERIAL_NOT_IN_TIME') {
      const start = workOrder?.materialStart
      const known = problem.date ?? start?.startDay ?? null
      if (start?.state === 'NOT_COVERED' || !known) return { ...base, words: t('problem.MATERIAL_NOT_COVERED', { order, materials: start?.notCovered.map((entry) => entry.label).join(', ') || '—' }), fix: null }
      return { ...base, words: t('problem.MATERIAL_NOT_IN_TIME', { order, day: dayWords(known, locale) }), fix: slot && !isPinned(slot) ? 'snap' : null }
    }
    return { ...base, words: t('problem.GATE_NOT_PASSED', { order }), fix: null }
  })
}

/** The work orders the board holds on a gate not passed. */
export const gatedOrders = (board: Board): Set<string> => new Set((board.moreProblems ?? []).filter((problem) => problem.kind === 'GATE_NOT_PASSED').map((problem) => problem.workOrderId))

// ---- the material check of a drop (PLN-134) ---------------------------------------------------------------------------------------

/** "Leather BLK arrives 14 Nov (a purchase order). Earliest start with material: 15 Nov, 06:00." in our words. */
export function materialWords(answer: MaterialAnswer, words: DepthWords): string {
  const { t, locale } = words
  const start = answer.materialStart
  if (start.state === 'NOT_COVERED') return t('material.notCovered', { order: answer.workOrder.number, materials: start.notCovered.map((entry) => entry.label).join(', ') || '—' })
  const earliest = answer.check?.earliestStart ?? start.earliestStart
  const arrives = start.setBy?.arrives ? t(start.setBy.source === 'FIRM' ? 'material.arrivesFirm' : 'material.arrives', { material: start.setBy.label, date: dayWords(start.setBy.arrives, locale) }) : ''
  const from = earliest ? t('material.earliest', { start: whenWords(earliest, words) }) : start.startDay ? t('material.earliestDay', { day: dayWords(start.startDay, locale) }) : ''
  return [arrives, from].filter(Boolean).join(' ')
}

/** Whether a move asks the material check (its start changes, or a tray drop), and of what. */
export function materialAsk(board: Board, plan: MovePlan): { workOrderId: string; startAt: string; laneKind: string; laneId: string } | null {
  const waits = (workOrderId: string) => {
    const state = board.workOrders.find((entry) => entry.id === workOrderId)?.materialStart?.state
    return state === 'ARRIVES' || state === 'NOT_COVERED'
  }
  if (plan.kind === 'place') return waits(plan.workOrderId) ? { workOrderId: plan.workOrderId, startAt: plan.startAt, laneKind: plan.lane.kind, laneId: plan.lane.id } : null
  if (plan.kind !== 'move' || !plan.startAt) return null
  const slot = board.slots.find((entry) => entry.id === plan.slotId)
  if (!slot || slot.operationId === null || !waits(slot.workOrderId)) return null
  // Only an earlier start can come before the material.
  if (new Date(plan.startAt).getTime() >= new Date(slot.startAt).getTime()) return null
  const lane = plan.lane ?? slot.lane
  return { workOrderId: slot.workOrderId, startAt: plan.startAt, laneKind: lane.kind, laneId: lane.id }
}

// ---- the backlog reschedule (PLN-141) ------------------------------------------------------------------------------------------

/** The review's rows: each bar from → to with why it moves. */
export function backlogChanges(run: BacklogRun, board: Board, words: DepthWords) {
  const { t } = words
  const lane = (ref: { kind: string; id: string }) => board.lanes.find((entry) => entry.kind === ref.kind && entry.id === ref.id)?.code ?? '—'
  return run.moves.map((move, index) => ({
    id: `${move.slotId ?? move.operationId}:${index}`,
    where: move.number,
    what: t('log.what', { seq: move.operation.seq, operation: move.operation.name, order: move.number }),
    now: move.from ? `${lane(move.lane)} · ${spanWords(move.from.startAt, move.from.endAt, words)}` : t('backlog.tray'),
    next: `${lane(move.lane)} · ${spanWords(move.to.startAt, move.to.endAt, words)}`,
    note: `${t(`backlog.why.${move.why}`)}${move.over.length > 0 ? ` · ${t('backlog.over')}` : ''}`,
  }))
}

/** What stays and what is left out, in words (kept codes, skipped codes). */
export function backlogLeftOut(run: BacklogRun, board: Board, words: DepthWords): string[] {
  const { t } = words
  const order = (id: string) => board.workOrders.find((entry) => entry.id === id)?.number ?? '—'
  return [...run.kept.map((entry) => t(`backlog.kept.${entry.code}`, { order: order(entry.workOrderId) })), ...run.skipped.map((entry) => t(`backlog.skipped.${entry.code}`, { order: order(entry.workOrderId) }))]
}

// ---- day sheets (PLN-154) ------------------------------------------------------------------------------------------------------

/** The lanes a day sheet may be printed for: every line and work centre of the board (workshops have no sheet). */
export function sheetLanes(board: Pick<Board, 'lanes'>): Array<{ value: string; label: string }> {
  return board.lanes.filter((lane) => lane.kind !== 'WORKSHOP').map((lane) => ({ value: laneKeyOf(lane), label: `${lane.code} · ${lane.name}` }))
}

/** The picked lane keys as the API takes them. */
export function sheetIds(keys: readonly string[]): { lineIds: string[]; workCentreIds: string[] } {
  const refs = keys.map((key) => laneRefOf(key)).filter((ref): ref is NonNullable<typeof ref> => ref !== null)
  return { lineIds: refs.filter((ref) => ref.kind === 'LINE').map((ref) => ref.id), workCentreIds: refs.filter((ref) => ref.kind === 'WORK_CENTRE').map((ref) => ref.id) }
}

// ---- Export board (XLSX) ---------------------------------------------------------------------------------------------------------

export const EXPORT_LIST_KEY = 'planning.board'
export const EXPORT_COLUMNS = ['lane', 'start', 'end', 'workOrder', 'style', 'operation', 'pieces', 'minutes', 'due', 'schedule', 'floor', 'pinned', 'note'] as const

/** The board's address as the export source reads it: the site and the window (or a published version). */
export function exportQuery(input: { siteId: string; from: string; to: string } | { versionId: string }): string {
  const query = new URLSearchParams()
  if ('versionId' in input) query.set('version', input.versionId)
  else {
    query.set('site', input.siteId)
    query.set('from', input.from)
    query.set('to', input.to)
  }
  return query.toString()
}

// ---- a published version on the board (design tab:version) -----------------------------------------------------------------------

export interface VersionDrawn {
  lanes: PlanningLane[]
  buckets: Array<{ id: string; label: string; today?: boolean }>
  cards: PlanningCard[]
}

/** The days a version covers, as buckets ("Mon 16 Nov" …), at most six weeks. */
export function versionDays(version: VersionBoard['version'], today: string): string[] {
  const out: string[] = []
  let day = version.coversFrom
  while (day <= version.coversTo && out.length < 42) {
    out.push(day)
    const next = new Date(`${day}T12:00:00Z`)
    next.setUTCDate(next.getUTCDate() + 1)
    day = next.toISOString().slice(0, 10)
  }
  return out.length > 0 ? out : [today]
}

/** The version's bars on the DS board, read-only, each saying where the working plan has it now and its floor state. */
export function drawVersion(board: VersionBoard, today: string, words: DepthWords): VersionDrawn {
  const { t, locale } = words
  const days = versionDays(board.version, today)
  const buckets = days.map((day) => ({ id: day, label: dayWords(day, locale), today: day === today }))
  const lanes: PlanningLane[] = board.lanes.map((lane) => ({ id: laneKeyOf(lane), label: lane.name, detail: `${lane.code} · ${t(`laneKind.${lane.kind}`)}` }))
  const local = (instant: string) => new Intl.DateTimeFormat('en-CA', { timeZone: board.site.timeZone }).format(new Date(instant))
  const cards = board.slots.flatMap((slot): PlanningCard[] => {
    const first = local(slot.startAt)
    const last = local(new Date(Math.max(new Date(slot.startAt).getTime(), new Date(slot.endAt).getTime() - 1)).toISOString())
    const start = days.findIndex((day) => day >= first)
    if (start < 0 || last < days[0]!) return []
    const end = days.findIndex((day) => day >= last)
    const span = (end < 0 ? days.length - 1 : end) - Math.max(0, start) + 1
    return [{
      id: slot.id,
      label: slot.workOrder.number,
      detail: slot.operation ? t('version.card', { seq: slot.operation.seq, operation: slot.operation.name, style: slot.workOrder.style.name }) : t('version.cardPart', { style: slot.workOrder.style.name }),
      minutes: Number(slot.minutes),
      laneId: laneKeyOf(slot.lane),
      bucketId: days[Math.max(0, start)]!,
      span: Math.max(1, span),
      pinned: slot.pinned === true,
      marks: versionMarks(slot, board, words),
    }]
  })
  return { lanes, buckets, cards }
}

function versionMarks(slot: VersionSlot, board: VersionBoard, words: DepthWords): PlanningMark[] {
  const { t } = words
  const marks: PlanningMark[] = []
  if (slot.workOrder.rush) marks.push({ label: t('version.rush'), tone: 'info' })
  const floor = floorMark(slot.floor, words)
  if (floor) marks.push(floor)
  if (slot.working.state === 'MOVED' && slot.working.slot) {
    const lane = board.lanes.find((entry) => entry.kind === slot.working.slot!.lane.kind && entry.id === slot.working.slot!.lane.id)
    marks.push({ label: t('version.moved', { lane: lane?.code ?? '—', when: spanWords(slot.working.slot.startAt, slot.working.slot.endAt, words) }), tone: 'warning' })
  } else if (slot.working.state === 'REMOVED') marks.push({ label: t('version.removed'), tone: 'danger' })
  return marks
}

/** The band of the version tab: what the floor works to, and the working plan beside it in words. */
export function versionBand(board: VersionBoard, words: DepthWords): { title: string; compare: string } {
  const { t, locale } = words
  const v = board.version
  const title = t(`version.floor.${board.floor}`, { version: v.number, from: dayWords(v.coversFrom, locale), to: dayWords(v.coversTo, locale), start: whenWords(v.effectiveFrom, words) })
  const c = board.compare
  const compare = c.moved + c.added + c.removed === 0 ? t('version.same', { version: v.number }) : t('version.compare', { version: v.number, moved: number(c.moved, locale), added: number(c.added, locale), removed: number(c.removed, locale) })
  return { title, compare }
}
