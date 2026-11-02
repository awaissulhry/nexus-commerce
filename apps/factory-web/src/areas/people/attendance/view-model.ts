import type { SiteLine, Ref } from '../_shared/api'
import type { Loaded, Notice } from '../_shared/parts'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { AbsenceCode, DayCounts, DayRow, EntryCounts, EntryRecord, EntryRow, MonthPanel, TimesheetRow, WhoIsIn } from './api'
import type { AttendanceAddress, AttendanceCan, DayTile, GateState, ManualDraft, Words } from './model'
import { heldByReason } from './model'
import type { DayActions, DayState } from './use-day'

/**
 * The ONE view model of People › Attendance (SCR-157: the band, the legal text, Period and team, the tiles, Days, Overtime to
 * approve, Timesheets, Month close, Who is in now and the pop-ups) and the actions the view reports. The container
 * (AttendancePage.tsx) reads and maps; the views fetch nothing.
 */

export type LiveState = 'connecting' | 'live' | 'offline'
export type TeamRef = Ref & { lineId: string | null }

export type { GateState }

export interface Rows<T> {
  items: T[] | null
  more: boolean
  problem: string | null
}

export interface CellState {
  state: 'saving' | 'failed'
  words?: Words | null
}

export type EntryDialog =
  | { kind: 'reject'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'reopen'; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'override'; rules: string[]; reason: string; busy: boolean; problem: Words | null }

export interface EntryState {
  id: string
  loaded: Loaded<EntryRecord>
  busy: boolean
  problem: Words | null
  dialog: EntryDialog | null
}

export type PageDialog =
  | { kind: 'manual'; draft: ManualDraft; people: Array<{ id: string; name: string; code: string | null }> | null; busy: boolean; problem: Words | null }
  | { kind: 'close'; typed: string; busy: boolean; problem: Words | null }
  | { kind: 'held'; approved: number; groups: ReturnType<typeof heldByReason> }

export type PanelState = { status: 'hidden' } | { status: 'loading' } | { status: 'ready'; value: MonthPanel } | { status: 'noReach' } | { status: 'error'; problem: string }

export interface AttendanceModel {
  prefix: string
  can: AttendanceCan
  address: AttendanceAddress
  month: string
  today: string
  now: number
  scope: OfficeScope
  gate: GateState
  lines: Array<SiteLine | Ref>
  teams: TeamRef[]
  codes: AbsenceCode[]
  tiles: { days: DayCounts | null; entries: EntryCounts | null; problem: string | null }
  days: Rows<DayRow>
  selected: string[]
  updates: number
  cells: Readonly<Record<string, CellState>>
  approving: boolean
  overtime: Rows<EntryRow> & { all: boolean; selected: string[]; busy: boolean }
  timesheets: Rows<TimesheetRow> & { canPrepare: boolean; selected: string[]; busy: boolean }
  panel: PanelState
  panelBusy: boolean
  who: { value: WhoIsIn | null; problem: string | null; stale: boolean }
  day: DayState | null
  entry: EntryState | null
  dialog: PageDialog | null
  notice: Notice | null
  asOf: string | null
  live: LiveState
  help: boolean
}

export interface AttendanceActions {
  onMonth: (month: string | null) => void
  onLine: (lineId: string | null) => void
  onTeam: (teamId: string | null) => void
  onTile: (tile: DayTile | null) => void
  onStatus: (status: AttendanceAddress['status']) => void
  onAnomaly: (anomaly: AttendanceAddress['anomaly']) => void
  onManualFilter: (manual: boolean) => void
  onClearFilters: () => void
  onRetryDays: () => void
  onMoreDays: () => void
  onShowUpdates: () => void
  onSelectDays: (ids: string[]) => void
  onApproveSelected: () => void
  onApproveClean: () => void
  onApproveFocused: (row: DayRow) => void
  onFixFocused: (row: DayRow) => void
  onInlineCode: (row: DayRow, codeId: string) => void
  onOpenDay: (id: string | null) => void
  day: DayActions
  onOpenEntry: (id: string | null) => void
  onEntryApprove: () => void
  onEntryReject: () => void
  onEntryReopen: () => void
  onEntryReason: (reason: string) => void
  onEntrySave: () => void
  onEntryClose: () => void
  onRetryEntry: () => void
  onOvertimeAll: (all: boolean) => void
  onMoreOvertime: () => void
  onRetryOvertime: () => void
  onSelectEntries: (ids: string[]) => void
  onBulkEntries: () => void
  onPrepare: () => void
  onMoreTimesheets: () => void
  onRetryTimesheets: () => void
  onSelectTimesheets: (ids: string[]) => void
  onBulkTimesheets: () => void
  onRetryPanel: () => void
  onShowItem: (item: MonthPanel['checklist'][number]['item']) => void
  onSeal: () => void
  onCloseMonth: () => void
  onCloseTyped: (typed: string) => void
  onCloseSave: () => void
  onRetryWho: () => void
  onManual: () => void
  onManualDraft: (patch: Partial<ManualDraft>) => void
  onFindPerson: (text: string) => void
  onManualSave: () => void
  onCloseDialog: () => void
  onDismissNotice: () => void
  onHelp: (open: boolean) => void
  onExport: () => void
}
