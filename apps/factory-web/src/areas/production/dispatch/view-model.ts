import type { PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import type { Phrase } from '../_shared/model'
import type { DispatchBoard, DispatchCard, LaneOperator, MoveBody, OperatorPicker } from './api'
import type { DispatchAddress, DispatchCan } from './model'

/**
 * The ONE view model of the Dispatch board (SCR-138) and what it may ask for. The view fetches nothing: the page container
 * (DispatchPage.tsx) reads the API and fills this; the design cases (fixtures.ts) fill it with made-up data.
 */

export type Loaded<T> = { readonly status: 'loading' } | { readonly status: 'error'; readonly problem: string } | { readonly status: 'ready'; readonly value: T }

/** Who the Assign operator dialog is for. */
export type AssignTarget =
  /** A station lane: who works there this day; the operation only names which level to show. */
  | { readonly kind: 'station'; readonly stationId: string; readonly operationId: string | null; readonly place: string }
  /** One card: this work is theirs. */
  | { readonly kind: 'card'; readonly stationId: string | null; readonly operationId: string; readonly place: string }
  /** Someone else takes what this assignment holds. */
  | { readonly kind: 'reassign'; readonly assignmentId: string; readonly version: number; readonly operationId: string | null; readonly from: string; readonly place: string }

export type DispatchDialog =
  /** The card's detail (by the board's own id): where "Move bundles" and the lane's order open from. */
  | { readonly kind: 'card'; readonly cardId: string }
  | { readonly kind: 'assign'; readonly target: AssignTarget; readonly picker: Loaded<OperatorPicker>; readonly workerId: string | null; readonly reason: string; readonly askReason: boolean; readonly problem: Phrase | null }
  | { readonly kind: 'move'; readonly cardId: string; readonly picked: readonly string[]; readonly target: string | null; readonly problem: Phrase | null }
  | { readonly kind: 'keys' }

/** The words over the board: a move's warning, a refusal, what a dialog did (with its Undo). */
export interface DispatchNotice {
  readonly tone: 'success' | 'warning' | 'danger'
  readonly words: Phrase
  /** The body that puts it back. */
  readonly undo?: MoveBody
}

export interface DispatchViewModel {
  /** `/w/<company>`: the links to the Office's pages. */
  readonly prefix: string
  readonly can: DispatchCan
  readonly address: DispatchAddress
  /** The sites to choose from when the top bar says All sites (none: the top bar's site). */
  readonly sites: readonly { readonly id: string; readonly code?: string | undefined; readonly name: string }[]
  readonly read: Loaded<DispatchBoard>
  /** The cards' ids now → the ids the board knows them by (see model `boardIdsOf`). */
  readonly aliases: ReadonlyMap<string, string>
  readonly live: 'connecting' | 'live' | 'offline'
  readonly offline: boolean
  /** "List changed 10:42": when the work last moved. */
  readonly changedAt: string | null
  readonly notice: DispatchNotice | null
  readonly dialog: DispatchDialog | null
  /** The site's rule asks a reason before this goes on: the label of the work (over any dialog). */
  readonly reasonFor: string | null
  readonly busy: boolean
  /** A design case: a keyboard move under way. */
  readonly moving?: { readonly cardId: string; readonly laneId: string | null } | undefined
}

export interface DispatchActions {
  onAddress?: (next: Partial<DispatchAddress>) => void
  onRetry?: () => void
  /** A move on the board (drag, keyboard, the phone's dialog, undo, redo): false when it did not happen. */
  onMove?: (move: PlanningMove) => Promise<boolean>
  onDialog?: (dialog: DispatchDialog | null) => void
  onAssignStart?: (target: AssignTarget) => void
  onAssign?: () => void
  onRemove?: (operator: LaneOperator, place: string) => void
  onMoveBundles?: () => void
  /** One place earlier or later in the station's queue. */
  onStep?: (card: DispatchCard, direction: -1 | 1) => void
  /** Back to Not assigned, all of the card. */
  onBack?: (card: DispatchCard) => void
  onUndoNotice?: () => void
  onDismissNotice?: () => void
  /** The reason asked for (null: keep it as it was). */
  onReason?: (reason: string | null) => void
}
