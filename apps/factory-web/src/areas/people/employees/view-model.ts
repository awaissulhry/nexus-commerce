import type { ReviewState } from '@nexus/ui/patterns'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { AuditEntry, Employee, EmployeeCounts, EmployeeKind, EmployeeRecord, Leaver, LeaverStep, LeavingPreview, LineCheck, MoveRow, Ref, SiteLine, Team, TeamMember, UnlinkedWorker } from '../_shared/api'
import type { EmployeesAddress, PeopleCan, Words } from '../_shared/model'
import type { Loaded, Notice, SightState } from '../_shared/parts'

/**
 * The ONE view model of People › Employees (SCR-084: tiles, the data notice, the register, the Teams view, leavers in
 * progress, the pop-ups) and of an employee's record (SCR-085), and the actions they report. The containers
 * (EmployeesPage.tsx, record/EmployeeRecord.tsx) load and map; the views fetch nothing.
 */

export type LiveState = 'connecting' | 'live' | 'offline'

export interface Rows<T> {
  items: T[] | null
  more?: boolean
  problem: string | null
}

/** A cell saved inline (team, home line). */
export interface CellState {
  state: 'saving' | 'saved' | 'failed'
  words?: Words | null
}

/** Who a pop-up is about (from a row or the record). */
export interface Person {
  id: string
  name: string
  displayName: string
  employeeCode: string | null
  siteId: string
  siteCode: string
  homeLine: Ref | null
  team: Ref | null
  version: number
}

export const personOf = (row: Employee): Person => ({
  id: row.id,
  name: row.name,
  displayName: row.displayName,
  employeeCode: row.employeeCode,
  siteId: row.site.id,
  siteCode: row.site.code,
  homeLine: row.homeLine,
  team: row.team ? { id: row.team.id, code: row.team.code, name: row.team.name } : null,
  version: row.version,
})

/** New employee as typed. */
export interface NewDraft {
  firstName: string
  lastName: string
  employeeCode: string
  kind: EmployeeKind
  agency: Ref | null
  siteId: string | null
  jobRole: string
  startDate: string
  endDate: string
  locale: string
  floorSignIn: boolean
}

export type EmployeesDialog =
  | { kind: 'new'; draft: NewDraft; agencies: Ref[] | null; busy: boolean; problem: Words | null; field: string | null }
  | { kind: 'loan'; person: Person; toLineId: string | null; toTeamId: string | null; startsAt: string; endsAt: string; reason: string; check: LineCheck | 'loading' | 'none' | null; busy: boolean; problem: Words | null; field: string | null }
  | { kind: 'leaver'; person: Person; lastWorkingDay: string; exitVisit: boolean; preview: LeavingPreview | null; reading: boolean; busy: boolean; problem: Words | null }
  | { kind: 'badges'; people: Person[] }
  | { kind: 'teamChange'; people: Person[]; teamId: string | null; rows: MoveRow[] | null; state: ReviewState; reviewing: boolean }
  | { kind: 'addTeam'; siteId: string | null; lineId: string | null; code: string; name: string; busy: boolean; problem: Words | null; field: string | null }
  | { kind: 'skip'; leaver: Leaver; step: LeaverStep; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'cancelLeaving'; leaver: Leaver; reason: string; busy: boolean; problem: Words | null }
  | { kind: 'link'; workers: UnlinkedWorker[]; busy: boolean; refused: Array<{ name: string; words: Words }> }

/** A lead with My team only (people.team.view, no people.view): "Showing your team (8)". */
export interface TeamOnly {
  employeeId: string | null
  teams: Array<Team & { mine: 'LEAD' | 'MEMBER' }>
}

/** The member rows of the Teams view (one row per person in a team, sorted site › line › team). */
export interface MemberRow extends TeamMember {
  rowId: string
  team: Team
}

export interface EmployeesListModel {
  prefix: string
  /** The Office origin for the badges' QR (an absolute address of the record). */
  origin: string
  can: PeopleCan
  address: EmployeesAddress & { teamId: string | null }
  /** The top bar's company and site ("All sites": a Site column and the chip). */
  scope: OfficeScope
  sight: SightState
  rows: Rows<Employee>
  counts: EmployeeCounts | null
  /** The person's own team (Rows ▾ My team), when they have one. */
  myTeam: { id: string; code: string; name: string } | null
  teamOnly: TeamOnly | null
  unlinked: Rows<UnlinkedWorker> & { complete: boolean }
  teams: Rows<Team>
  leavers: Rows<Leaver>
  lines: SiteLine[]
  sites: Ref[]
  asOf: string | null
  live: LiveState
  updates: number
  cells: Record<string, CellState>
  /** The data notice: dismissed problems by value, and which of the open ones is shown. */
  dismissed: string[]
  noticeIndex: number
  dialog: EmployeesDialog | null
  notice: Notice | null
  today: string
  timeZone: string
  /** Design cases and tests. */
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface EmployeesListActions {
  onTile?: (tile: EmployeesAddress['tile']) => void
  onRows?: (rows: EmployeesAddress['rows']) => void
  onSearch?: (q: string) => void
  onView?: (view: EmployeesAddress['view']) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onCell?: (row: Employee, change: { teamId: string | null } | { homeLineId: string | null }) => void
  onNew?: () => void
  onImport?: () => void
  onNoticeDismiss?: (key: string) => void
  onNoticeNext?: () => void
  onLoan?: (person: Person) => void
  onLeaver?: (person: Person) => void
  onBadges?: (people: Person[]) => void
  onTeamChange?: (people: Person[]) => void
  onLink?: (workers: UnlinkedWorker[]) => void
  onAddTeam?: () => void
  onSetLead?: (team: Team, employeeId: string | null) => void
  onArchiveTeam?: (team: Team) => void
  onStepDone?: (leaver: Leaver, step: LeaverStep) => void
  onStepSkip?: (leaver: Leaver, step: LeaverStep) => void
  onCancelLeaving?: (leaver: Leaver) => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
  dialog?: DialogActions
}

/** What every pop-up reports (the list and the record share them). */
export interface DialogActions {
  onClose?: () => void
  onSubmit?: () => void
  onNewDraft?: (patch: Partial<NewDraft>) => void
  onFindAgency?: (text: string) => void
  onLoan?: (patch: Partial<Pick<Extract<EmployeesDialog, { kind: 'loan' }>, 'toLineId' | 'toTeamId' | 'startsAt' | 'endsAt' | 'reason'>>) => void
  onLeaver?: (patch: Partial<Pick<Extract<EmployeesDialog, { kind: 'leaver' }>, 'lastWorkingDay' | 'exitVisit'>>) => void
  onTeam?: (teamId: string | null) => void
  onReview?: () => void
  onAddTeam?: (patch: Partial<Pick<Extract<EmployeesDialog, { kind: 'addTeam' }>, 'siteId' | 'lineId' | 'code' | 'name'>>) => void
  onReason?: (reason: string) => void
}

// ---- the record ----------------------------------------------------------------------------------------------------------------

export const EMPLOYEE_TABS = ['profile', 'job', 'documents', 'activity'] as const
export type EmployeeTab = (typeof EMPLOYEE_TABS)[number]

/** The record's explicit edit (Profile › Identity, Job & team › Job), as typed. */
export interface EditDraft {
  firstName: string
  lastName: string
  displayName: string
  employeeCode: string
  kind: EmployeeKind
  agency: Ref | null
  locale: string
  startDate: string
  endDate: string
  department: string
  jobRole: string
  homeLineId: string | null
  contract: 'FULL_TIME' | 'PART_TIME' | null
  hours: string
}

export interface EmployeeRecordModel {
  prefix: string
  origin: string
  can: PeopleCan
  tab: EmployeeTab
  loaded: Loaded<EmployeeRecord>
  sight: SightState
  asOf: string | null
  live: LiveState
  edit: { section: 'identity' | 'job'; draft: EditDraft; busy: boolean; problem: Words | null; field: string | null; codeTaken: boolean } | null
  lines: SiteLine[]
  agencies: Ref[] | null
  teams: Team[]
  audit: Rows<AuditEntry> | null
  dialog: EmployeesDialog | null
  notice: Notice | null
  /** J / K: the employees before and after this one in the list last opened. */
  neighbours: { prev: string | null; next: string | null }
  timeZone: string
}

export interface EmployeeRecordActions {
  onRetry?: () => void
  onEdit?: (section: 'identity' | 'job') => void
  onDraft?: (patch: Partial<EditDraft>) => void
  onCodeLeft?: () => void
  onApply?: () => void
  onDiscard?: () => void
  onFindAgency?: (text: string) => void
  onLoan?: () => void
  onEndLoan?: (loanId: string) => void
  onRemoveLoan?: (loanId: string) => void
  onLeaver?: () => void
  onCancelLeaving?: () => void
  onBadge?: () => void
  onTeamChange?: () => void
  onCreateSignIn?: () => void
  onStepDone?: (step: LeaverStep) => void
  onStepSkip?: (step: LeaverStep) => void
  onDismissNotice?: () => void
  dialog?: DialogActions
}
