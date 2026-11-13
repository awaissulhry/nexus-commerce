import type { PlanningCard, PlanningMove } from '@nexus/ui/patterns/planning-board/index'
import type { BarDetail, Board, PlaceByDueDate, PlanningSite, PublishedVersion, PublishPreview, VersionHeader } from './api'
import type { BoardControls, OverDay, ProblemRow, ReadProblem, Refusal } from './model'
// B-W2b-337: the board in depth (what-if, the change log, pins, workshops, the day sheets, the backlog, export).
import type { ExportJob, ToolsProblem } from '../../../list-frame/tools/transport'
import type { AllocationWorkshops, KitTiming, OutsideAnswer, WorkOrderWorkshops } from '../allocation/depth/api'
import type { Subcontractors } from '../capacity/depth/api'
import type { BacklogRun, ChangesPage, DaySheetPaper, MaterialAnswer, WhatIf } from './depth/api'
import type { DepthProblemRow, LogKind } from './depth/model'

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
  // ---- B-W2b-337 ----
  /** A drop earlier than the material: "Leather arrives 14 Nov. Earliest start with material: 15 Nov" → Snap · Keep my date. */
  | { kind: 'material'; answer: MaterialAnswer }
  /** Move to a subcontractor (design pop:subcontract-move): approved workshops only, the kit's ship-out day and list. */
  | { kind: 'subcontract'; slotId: string; workOrderId: string; operationId: string; partyId: string | null; start: string | null; pieces: number; workshops: Loaded<WorkOrderWorkshops>; timing: Loaded<KitTiming> | null; busy?: boolean; error?: string | null; done?: { answer: OutsideAnswer; stayed: Refusal | null } | null }
  /** Print day sheets (design pop:print): lines, date, language (and which plan), the sheets' preview, then the PDF in a new tab. */
  | { kind: 'print'; lanes: readonly string[]; date: string; language: 'it' | 'en'; plan: 'PUBLISHED' | 'WORKING'; paper: Loaded<DaySheetPaper> | { status: 'noVersion' } | null; busy?: boolean; error?: string | null }
  /** Reschedule backlog: the review of what moves (from → to, why), then applied with the plan's version. */
  | { kind: 'backlog'; preview: Loaded<BacklogRun> | { status: 'nothing' }; busy?: boolean; error?: string | null }
  /** Apply to plan refused: the tried moves that clash with the working plan now (ReviewChangesModal), Apply the rest. */
  | { kind: 'whatifConflicts'; conflicts: ReadonlyArray<{ index: number; code: string }>; busy?: boolean; error?: string | null }
  /** Export board (XLSX): the list frame's export job. */
  | { kind: 'export'; job: ExportJob | null; problem: ToolsProblem | null }

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
  /** B-W2b-337: the board in depth; absent on a W2a case (drawn as before). */
  depth?: BoardDepth
}

/** B-W2b-337: what the board in depth draws beside the W2a board. */
export interface BoardDepth {
  /** What this person may do (the API decides; these hold the buttons with the reason). */
  may: { pin: boolean; outsource: boolean; order: boolean; export: boolean }
  /** The private what-if (null: off): its scenario read, the effect, Apply / Discard. */
  whatIf: { read: Loaded<WhatIf>; busy?: boolean; error?: string | null } | null
  /** The change log (design sec:log). */
  changes: ChangesState
  /** The workshops' approval and DURC (B-W2b-321) and their weekly capacity per bucket. */
  workshops: Loaded<AllocationWorkshops> | { status: 'error' }
  subcontractors: Loaded<Subcontractors> | { status: 'error' }
}

export interface ChangesState {
  read: Loaded<ChangesPage>
  /** PUBLISHED: since the last version (default); ALL: the whole log. */
  since: 'PUBLISHED' | 'ALL'
  kinds: readonly LogKind[]
  /** "Filter by planner": one office user, or everyone. */
  planner: string | null
  /** The planners named in the log read so far (the filter's choices). */
  planners: ReadonlyArray<{ id: string; name: string }>
  /** Reading the next page. */
  more?: boolean
  /** The change being undone. */
  busy?: string | null
  /** An undo (or an older page) refused, said in the page's words. */
  error?: Refusal | null
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
  // ---- B-W2b-337 ----
  /** One sentence in the band's status line (a held key: P without the permission, P in what-if). */
  onNotice?: (text: string) => void
  onDepthDialog?: (kind: 'print' | 'backlog' | 'export') => void
  onWhatIf?: (on: boolean) => void
  onWhatIfApply?: () => void
  onWhatIfApplyRest?: () => void
  onWhatIfDiscard?: () => void
  onWhatIfRetry?: () => void
  onPin?: (slotId: string, pinned: boolean) => void
  onPinOrder?: (workOrderId: string, pinned: boolean) => void
  onSubcontract?: (slotId: string) => void
  onSubcontractPick?: (partyId: string) => void
  onSubcontractPieces?: (pieces: number) => void
  onSubcontractConfirm?: () => void
  onSubcontractRetry?: () => void
  onMaterialChoice?: (choice: 'snap' | 'keep' | 'cancel') => void
  onPrintChange?: (next: { lanes?: readonly string[]; date?: string; language?: 'it' | 'en'; plan?: 'PUBLISHED' | 'WORKING' }) => void
  onPrintOpen?: () => void
  onBacklogApply?: (reason: string | null) => void
  onChangesFilter?: (next: { since?: 'PUBLISHED' | 'ALL'; kinds?: readonly LogKind[]; planner?: string | null }) => void
  onChangesMore?: () => void
  onChangesRetry?: () => void
  onUndo?: (changeId: string) => void
  onProblemFix?: (row: DepthProblemRow) => void
  onShowDepthProblem?: (row: DepthProblemRow) => void
  onExportDownload?: () => void
  onExportAgain?: () => void
}
