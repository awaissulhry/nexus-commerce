import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import type { BarDetail, Board, PlaceByDueDate, PlanningSite, PublishedVersion, PublishPreview, VersionHeader } from './api'
import type { BoardControls, OverDay, ProblemRow, ReadProblem, Refusal } from './model'

/**
 * The ONE view model of the planning board (SCR-122) and what it may ask for. The view fetches nothing: the page
 * container (BoardPage.tsx) reads the API and fills this; the design cases (fixtures.ts) fill it with made-up data.
 */

export type Loaded<T> = { status: 'loading' } | { status: 'error'; problem: ReadProblem } | { status: 'ready'; value: T }

/** The band's save words: "All moves saved · 10:42" / "Saving…" / "Not saved: …". */
export type SaveState = { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: string } | { state: 'failed'; refusal: Refusal }

export type PublishRangeKind = 'default' | 'tomorrow' | 'custom'

export type BoardDialog =
  | { kind: 'bar'; workOrderId: string; slotId: string | null; detail: Loaded<BarDetail>; busy?: boolean; error?: string | null }
  /** The drop warning: the lane would go over capacity ("Line 2 would be at 112% on Tue"). */
  | { kind: 'drop'; cardLabel: string; laneName: string; days: readonly OverDay[]; source: 'board' | 'api'; next: boolean; busy?: boolean; error?: string | null }
  | { kind: 'publish'; range: PublishRangeKind; from: string | null; to: string | null; preview: Loaded<PublishPreview>; busy?: boolean; error?: string | null; done?: VersionHeader | null }
  | { kind: 'place'; preview: Loaded<PlaceByDueDate>; busy?: boolean; error?: string | null }
  | { kind: 'legend' }
  | { kind: 'versions'; versions: Loaded<PublishedVersion[]> }
  | { kind: 'keys' }

export type DialogKind = BoardDialog['kind']

export interface BoardViewModel {
  /** `/w/<company>`: the links to the Office's pages. */
  prefix: string
  /** The signed-in person: "Moved by …" is said for another planner only. */
  me: string | null
  sites: readonly PlanningSite[]
  controls: BoardControls
  read: Loaded<Board>
  /** No live channel (or no network): moves are held with the reason. */
  offline: boolean
  save: SaveState
  dialog: BoardDialog | null
  /** One sentence in the status line ("WO-0002 moved by another planner: the board was read again."). */
  notice: string | null
  /** "Show on board": the card or lane outlined. */
  focus: { cardId?: string; laneId?: string } | null
}

export type DropChoice = { kind: 'keep'; reason: string } | { kind: 'next' } | { kind: 'cancel' }

export interface BoardActions {
  onControls?: (next: Partial<BoardControls>) => void
  onRetry?: () => void
  /** A move of the board (drag, keyboard, list, undo): saved before it shows; false = not made. */
  onMove?: (move: PlanningMove) => boolean | Promise<boolean>
  onOpen?: (card: PlanningCard) => void
  onOpenDialog?: (kind: 'publish' | 'place' | 'legend' | 'versions' | 'keys') => void
  onCloseDialog?: () => void
  onDropChoice?: (choice: DropChoice) => void
  onPublishRange?: (range: PublishRangeKind, from?: string | null, to?: string | null) => void
  onPublish?: () => void
  onPlaceApply?: (reason: string | null) => void
  onSendToTray?: (slotId: string) => void
  onShowProblem?: (row: ProblemRow) => void
  onShowCheck?: (target: { workOrderId: string | null; slotId: string | null; laneId: string | null }) => void
}
