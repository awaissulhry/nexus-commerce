import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import type { CellSaveState } from '@nexus/ui/grid'
import type { LiveState } from '../../../shell/live/use-live'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { Notice, SightState } from '../_shared/parts'
import type { CheckedPerson, OvertimeListed, OvertimeRecord, PlanPreview, Ref, Roster, ShiftChoice } from './api'
import type { CellRef, DayRange, ShiftsAddress, ShiftsCan, SheetRow } from './model'

/** One view model for SCR-263: everything the page draws; the views fetch nothing. */

export interface Mark {
  readonly state: CellSaveState
  /** Why it was refused, in words (the cell's tooltip). */
  readonly reason?: string
}

export type RosterState = { status: 'loading' } | { status: 'error'; problem: string } | { status: 'ready'; value: Roster }

export interface AssignDraft {
  readonly people: ReadonlyArray<{ id: string; name: string; defaultPattern: Ref | null }>
  /** People selected that this person does not plan (left out, said). */
  readonly leftOut: number
  readonly from: string
  readonly to: string
  /** 'days': only these days. 'default': the person's default shift. */
  readonly mode: 'days' | 'default'
  /** The shift: an option of `shiftOptions`, '' until chosen. */
  readonly option: string
  /** ISO weekdays to set. */
  readonly weekdays: readonly number[]
  /** Also the days the calendar closes. */
  readonly closedToo: boolean
  readonly busy: boolean
  readonly problem: string | null
}

export type ReviewPhase = { phase: 'reading' } | { phase: 'failed'; problem: string } | { phase: 'ready' } | { phase: 'saving' } | { phase: 'done'; changed: number; skipped: number }

export interface OvertimeDraft {
  /** The site it asks at (the top bar's; held with All sites). */
  readonly siteId: string | null
  readonly date: string
  readonly lineId: string | null
  /** "18:00" or blank. */
  readonly start: string
  /** "2" or "1,5". */
  readonly hours: string
  readonly reason: string
  readonly picked: readonly string[]
  /** The picker's checks by person (null: not read yet). */
  readonly checks: Readonly<Record<string, CheckedPerson>> | null
  readonly checking: boolean
  readonly busy: boolean
  readonly problem: string | null
  /** Show what is missing (after a press). */
  readonly tried: boolean
}

export type ShiftsDialog =
  | { kind: 'assign'; draft: AssignDraft }
  | { kind: 'assign-review'; draft: AssignDraft; preview: PlanPreview | null; review: ReviewPhase }
  | { kind: 'default-review'; draft: AssignDraft; review: ReviewPhase; refused: ReadonlyArray<{ name: string; words: string }> }
  | { kind: 'copy'; week: string; source: { from: string; to: string }; target: { from: string; to: string }; preview: PlanPreview | null; review: ReviewPhase }
  | { kind: 'overtime'; draft: OvertimeDraft }
  | { kind: 'publish'; drafts: number; people: number; busy: boolean; problem: string | null }

export type RequestState = { status: 'loading'; id: string } | { status: 'error'; id: string; problem: string } | { status: 'ready'; record: OvertimeRecord; busy: boolean; problem: string | null; cancelling: { reason: string } | null; picking: { ids: string[] } | null }

export interface ShiftsModel {
  readonly prefix: string
  readonly can: ShiftsCan
  readonly address: ShiftsAddress
  readonly range: DayRange
  readonly today: string
  readonly scope: OfficeScope
  readonly sight: SightState
  readonly roster: RosterState
  /** Sheet rows of the roster read (groups, people, foot rows). */
  readonly rows: readonly SheetRow[]
  readonly dates: readonly string[]
  readonly choices: readonly ShiftChoice[]
  readonly lines: readonly Ref[]
  readonly teams: ReadonlyArray<Ref & { lineId: string | null }>
  /** Save marks by `cellId`. */
  readonly marks: Readonly<Record<string, Mark>>
  readonly save: SaveStatusState
  /** A write that never reached the server may be sent again. */
  readonly canRetry: boolean
  readonly canUndo: boolean
  readonly canRedo: boolean
  readonly drafts: { drafts: number; blocked: number; people: number }
  /** Cells somebody else changed since this tab read them. */
  readonly elsewhere: { cells: number; at: string } | null
  readonly notice: Notice | null
  readonly asOf: string | null
  readonly live: LiveState
  /** The people ticked on the sheet. */
  readonly picked: readonly string[]
  readonly requests: { items: readonly OvertimeListed[] | null; problem: string | null }
  readonly selectedRequests: readonly string[]
  readonly request: RequestState | null
  readonly dialog: ShiftsDialog | null
  readonly help: boolean
  /** Design cases: the first toned cell's popover open. */
  readonly whyOpen?: string
}

export interface ShiftsActions {
  onSpan(span: 'week' | 'month'): void
  onMove(step: -1 | 1): void
  onToday(): void
  onRange(from: string, to: string): void
  onLine(lineId: string | null): void
  onTeam(teamId: string | null): void
  onRetryRead(): void
  /** Edits the grid gathered in one tick (a key on a range, the fill handle, a paste, the cell's list). */
  onEdits(edits: ReadonlyArray<CellRef & { value: unknown }>): void
  /** A letter, Delete or the menu on these cells: a key, an option, or null = back to the default. */
  onKey(key: string, cells: readonly CellRef[]): boolean
  onSetOption(option: string, cells: readonly CellRef[]): void
  onUndo(): void
  onRedo(): void
  onRetrySave(): void
  onShowElsewhere(): void
  onPick(ids: string[]): void
  onDismissNotice(): void
  onHelp(open: boolean): void
  onExport(): void
  // Assign
  onAssign(cells: readonly CellRef[]): void
  onAssignDraft(patch: Partial<AssignDraft>): void
  onAssignReview(): void
  onAssignBack(): void
  onAssignSave(): void
  onAssignUndo(): void
  // Copy last week
  onCopy(): void
  onCopySave(): void
  onCopyRetry(): void
  onCopyUndo(): void
  // Publish
  onPublish(): void
  onPublishSave(): void
  // Overtime
  onOvertime(peopleIds?: readonly string[]): void
  onOvertimeDraft(patch: Partial<OvertimeDraft>): void
  onOvertimeSave(ask: boolean): void
  onOpenRequest(id: string | null): void
  onSelectRequests(ids: string[]): void
  onBulkAsk(): void
  onBulkApprove(): void
  onShowRequests(): void
  onRequestAsk(): void
  onRequestApprove(): void
  onRequestAnswer(agreementId: string, answer: 'AGREED' | 'DECLINED'): void
  onRequestRemove(employeeId: string): void
  onRequestPicking(ids: string[] | null): void
  onRequestAdd(): void
  onRequestCancelling(reason: string | null): void
  onRequestCancel(): void
  onCloseDialog(): void
}
