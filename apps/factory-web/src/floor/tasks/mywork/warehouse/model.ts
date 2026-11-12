import { TASK_ACTS, TASK_KINDS, type TaskAudience, type TaskKind, type TaskStatus } from '@nexus/factory-domain/inventory/tasks/rules'

export type { TaskKind }
import { floorListChanges } from '@nexus/ui/floor/FloorListUpdates/floorListUpdatesModel'

/**
 * My work at the warehouse (B-W2b-308; design floor.mywork sec:queue "Variants: warehouse task inbox (W2b, SCM-274: receive, put
 * away, pick, move, count; next task first)"; the API of B-W2b-292 `GET /inventory/tasks/inbox`): the rules of the inbox without
 * React or the network, so the tests hold them.
 *
 *   inbox     the signed-in worker's tasks as the API orders them (in hand first, then due, then the oldest): the first is
 *             "Next", big; the rest "Then". Never a person: a task is for them, their role or anyone.
 *   acts      what each kind asks on the floor: a put-away, a move and a quarantine move are done on Move & put away by their
 *             scans (the bin label confirms; a quarantine move only by the quarantine place's scan); a delivery, a pick and a
 *             count by ONE tap on Done (their own screens do the work).
 *   steps     Take, Give back and Done, online first, else kept in the tablet's queue (inventory.task.take | giveBack | done):
 *             this tablet shows them at once and drops them once the office's list says the same.
 *   changed   a fresher list waits behind "List changed · Show" (rows never move under a gloved finger).
 *   counts    what waits per kind: the Move tile counts put-aways, moves and quarantine moves (design floor.move "a new
 *             quarantine move task → a count on the Move tile"); the My work tile counts them all.
 */

export interface TaskPlace {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly kind: string
}

export interface WarehouseTask {
  readonly id: string
  readonly kind: TaskKind
  readonly status: TaskStatus
  /** The record that made it (a receipt, a hold, a work order …); null: asked by hand in the office. */
  readonly source: { readonly type: string; readonly id: string } | null
  readonly item: { readonly id: string; readonly code: string; readonly name: string; readonly baseUom: string } | null
  readonly colour: { readonly code: string; readonly name: string } | null
  readonly lot: { readonly id: string; readonly code: string } | null
  readonly hide: { readonly id: string; readonly code: string } | null
  readonly from: TaskPlace | null
  /** Where it goes: a put-away's suggestion (the bin scanned confirms it), a move's or a quarantine move's place. */
  readonly to: TaskPlace | null
  readonly quantity: string | null
  readonly uom: string | null
  readonly dueAt: string | null
  readonly note: string | null
  readonly version: number
  readonly createdAt: string
  /** For this worker, their role, anyone (the inbox never holds another person's). */
  readonly audience: TaskAudience
  /** In this worker's hands (taken by them). */
  readonly mine: boolean
}

export type KindCounts = Readonly<Record<TaskKind, number>>

export interface TaskInbox {
  readonly asOf: string
  readonly tasks: readonly WarehouseTask[]
  readonly counts: KindCounts
  /** More wait than the inbox shows. */
  readonly more: boolean
}

/** The kinds Move & put away does (its tile's count). */
export const MOVE_KINDS: readonly TaskKind[] = ['PUT_AWAY', 'MOVE', 'QUARANTINE']

export const isMoveKind = (kind: TaskKind): boolean => MOVE_KINDS.includes(kind)

/** What waits on the Move tile: put-aways, moves and quarantine moves; null when not known (never 0 for "not read"). */
export function moveCount(counts: KindCounts | null): number | null {
  return counts ? MOVE_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0) : null
}

/** Every task that waits (the My work tile's count); null when not known. */
export function totalCount(counts: KindCounts | null): number | null {
  return counts ? TASK_KINDS.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0) : null
}

/** What a task's goods carry as a label to scan: the hide's tag, else the lot's number; null when it names neither. */
export function codeOfTask(task: Pick<WarehouseTask, 'hide' | 'lot'>): string | null {
  return task.hide?.code ?? task.lot?.code ?? null
}

/** The screen that does a kind (a floor task route key), or null: none on the floor yet (a count: B-W2b-310's screen). */
export type TaskScreen = 'move' | 'receive' | 'pick' | null

export function screenOf(kind: TaskKind): TaskScreen {
  switch (kind) {
    case 'PUT_AWAY':
    case 'MOVE':
    case 'QUARANTINE':
      return 'move'
    case 'RECEIVE':
      return 'receive'
    case 'PICK':
      return 'pick'
    case 'COUNT':
      return null
  }
}

/** Why Done is not one tap for this task, or null. A quarantine move is confirmed only by the scan of its place. */
export function doneHeld(task: Pick<WarehouseTask, 'kind'>): 'scanPlace' | null {
  return TASK_ACTS[task.kind].doneBy === 'PLACE_SCAN' ? 'scanPlace' : null
}

/** A put-away or a move is done by its own scans: Done by a tap only once nothing is left where it was (the API checks). */
export const doneByScans = (task: Pick<WarehouseTask, 'kind'>): boolean => TASK_ACTS[task.kind].doneBy === 'SCAN'

// ---- this tablet's own steps --------------------------------------------------------------------------------------------

export type StepKind = 'take' | 'giveBack' | 'done'

/** A step this tablet took on a task: shown at once, dropped once the office's list says the same. */
export interface OwnStep {
  readonly taskId: string
  readonly step: StepKind
  readonly at: string
  /** Kept in the queue under this id (null: the office answered the try). */
  readonly clientEventId: string | null
}

/** The step a task now has after this one (replaces an earlier step on the same task). */
export function withStep(steps: readonly OwnStep[], step: OwnStep): OwnStep[] {
  return [...steps.filter((entry) => entry.taskId !== step.taskId), step]
}

/** The steps the office's list does not show yet (a done task still in it, a take it does not show as mine …). */
export function stepsStill(steps: readonly OwnStep[], inbox: TaskInbox | null): OwnStep[] {
  if (!inbox) return [...steps]
  return steps.filter((step) => {
    const task = inbox.tasks.find((entry) => entry.id === step.taskId)
    if (!task) return false
    if (step.step === 'done') return true
    if (step.step === 'take') return !task.mine
    return task.mine
  })
}

/** The inbox as this tablet shows it: its own steps applied (a done task leaves, a take is in hand, a give back is not). */
export function withSteps(inbox: TaskInbox | null, steps: readonly OwnStep[]): TaskInbox | null {
  if (!inbox || steps.length === 0) return inbox
  const by = new Map(steps.map((step) => [step.taskId, step.step]))
  const tasks = inbox.tasks
    .filter((task) => by.get(task.id) !== 'done')
    .map((task) => {
      const step = by.get(task.id)
      if (step === 'take') return { ...task, status: 'TAKEN' as const, mine: true }
      if (step === 'giveBack') return { ...task, status: 'OPEN' as const, mine: false }
      return task
    })
  const done = inbox.tasks.filter((task) => by.get(task.id) === 'done')
  const counts = Object.fromEntries(TASK_KINDS.map((kind) => [kind, Math.max(0, (inbox.counts[kind] ?? 0) - done.filter((task) => task.kind === kind).length)])) as Record<TaskKind, number>
  // In hand first, as the API orders it.
  const ordered = [...tasks.filter((task) => task.mine), ...tasks.filter((task) => !task.mine)]
  return { ...inbox, tasks: ordered, counts }
}

// ---- the list on screen and a fresher one ---------------------------------------------------------------------------------

const rowVersion = (task: WarehouseTask) => `${task.status}:${task.version}:${task.mine ? 1 : 0}`

/** A fresher inbox differs from the one on screen (its tasks, their order, their state). */
export function inboxChanged(shown: TaskInbox | null, fresh: TaskInbox): boolean {
  if (!shown) return false
  const sign = (inbox: TaskInbox) => inbox.tasks.map((task) => `${task.id}=${rowVersion(task)}`).join('|')
  return sign(shown) !== sign(fresh)
}

/** How many tasks differ between the list on screen and the fresher one. */
export function changedTasks(shown: TaskInbox, fresh: TaskInbox): number {
  return floorListChanges(shown.tasks, fresh.tasks, (task) => task.id, rowVersion)
}

/** The tasks of the Move screen's list (put-aways, moves, quarantine moves), in the inbox's order. */
export function moveTasks(inbox: TaskInbox | null): WarehouseTask[] {
  return (inbox?.tasks ?? []).filter((task) => isMoveKind(task.kind))
}

/** The kinds that wait, with their counts, in the kinds' order (zero left out): "Put away 3 · Pick 1". */
export function countsLine(counts: KindCounts): { readonly kind: TaskKind; readonly count: number }[] {
  return TASK_KINDS.filter((kind) => (counts[kind] ?? 0) > 0).map((kind) => ({ kind, count: counts[kind] }))
}

/** The tone of a kind's row (icon + word + tone; never colour alone): a quarantine move is quality's, so it warns. */
export const KIND_TONE: Readonly<Record<TaskKind, 'info' | 'warning' | 'neutral' | 'primary'>> = Object.freeze({
  RECEIVE: 'info',
  PUT_AWAY: 'primary',
  PICK: 'primary',
  MOVE: 'neutral',
  COUNT: 'neutral',
  QUARANTINE: 'warning',
})

/** A task's quantity as a number (the API's decimal string), or null. */
export function quantityOf(task: Pick<WarehouseTask, 'quantity'>): number | null {
  if (task.quantity === null) return null
  const value = Number(task.quantity)
  return Number.isFinite(value) ? value : null
}

/** A task is late: due before now. */
export const isLate = (task: Pick<WarehouseTask, 'dueAt'>, now: Date): boolean => task.dueAt !== null && new Date(task.dueAt).getTime() < now.getTime()
