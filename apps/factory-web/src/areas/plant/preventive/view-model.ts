import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { BodyChoice, CalendarAnswer, CheckPlan, CheckResult, CheckType, CountsAnswer, MachineChoice, OwnerChoice, PlanRecord, ResultRecord } from './api'
import type { MoveDraft, PlanDraft, PreventiveAddress, PreventiveCan, Problem, ResultDraft } from './model'

/**
 * SCR-266's view model (B-W2b-142): ONE typed model the page view draws (`view/PreventivePageView.tsx`), filled by the
 * container (`PreventivePage.tsx` + `use-dialogs.ts`) from the API, or by `fixtures.ts` with made-up data. Each section
 * reads and fails on its own; a dialog holds its own read, draft, busy state and the API's last refusal in our words.
 */

/** A section's read: loading (a skeleton, "still loading" after a second), ready, or failed (our words + Try again). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

/** A list read page by page ("Show more"): the rows so far and the next page's cursor. */
export interface Paged<T> {
  readonly rows: readonly T[]
  readonly next: string | null
  readonly more: boolean
}

export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** Rows a many-rows action left as they were, each with why (a message key). */
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** New plan (`?new=1`): the pickers read when it opens; a type list per machine class. */
export interface PlanNewState {
  readonly draft: PlanDraft
  readonly machines: Read<readonly MachineChoice[]>
  readonly types: Read<readonly CheckType[]> | null
  readonly bodies: Read<readonly BodyChoice[]> | null
  readonly owners: Read<readonly OwnerChoice[]> | null
  readonly busy: boolean
  readonly problem: Problem | null
}

/** Record a check result (`?record=1|<plan>`, `?corrects=<result>`). */
export interface ResultNewState {
  readonly draft: ResultDraft
  /** The plan it is recorded on (read when it opens), else null. */
  readonly plan: Read<CheckPlan> | null
  /** A correction: the result it corrects (read when it opens), else null. */
  readonly corrects: Read<CheckResult> | null
  /** Without a plan: the machines and the types of the one picked. */
  readonly machines: Read<readonly MachineChoice[]> | null
  readonly types: Read<readonly CheckType[]> | null
  readonly bodies: Read<readonly BodyChoice[]> | null
  readonly busy: boolean
  /** The result is saved and its report files are on their way. */
  readonly uploading: boolean
  readonly problem: Problem | null
}

/** The Plan window (`?plan=<id>`), J / K over the plans list. */
export interface PlanOpenState {
  readonly id: string
  readonly read: Read<PlanRecord>
}

/** The result's window (`?result=<id>`), J / K over the register. */
export interface ResultOpenState {
  readonly id: string
  readonly read: Read<ResultRecord>
  readonly step: 'view' | 'lock'
  readonly lockNote: string
  readonly busy: boolean
  readonly uploading: boolean
  readonly problem: Problem | null
  /** What was just done, in words (a message key with its params). */
  readonly saved: { readonly key: string; readonly params?: Readonly<Record<string, string | number>> } | null
}

/** Move a check (`?move=<plan>&date=`, a drag on the calendar), or Move N over the plans chosen. */
export interface MoveState {
  /** The plans moved (one from the address, several from the list). */
  readonly plans: Read<readonly CheckPlan[]>
  readonly draft: MoveDraft
  readonly busy: boolean
  readonly problem: Problem | null
  /** Move N: one call per plan. */
  readonly bulk: boolean
}

export interface PreventivePageModel {
  /** `/w/<company>`: links are company-free plus this. */
  readonly prefix: string
  /** `/w/<company>/plant/preventive`: the page's own address (a chip's link keeps the page's filters). */
  readonly path: string
  readonly can: PreventiveCan
  readonly scope: OfficeScope
  readonly address: PreventiveAddress
  /** The site's day (the API's, once read). */
  readonly today: string
  /** The month the Month view shows. */
  readonly month: string
  readonly counts: Read<CountsAnswer>
  readonly calendar: Read<CalendarAnswer>
  /** A read again runs while the last one stays on screen. */
  readonly calendarReading: boolean
  readonly plans: Read<Paged<CheckPlan>>
  readonly plansMore: boolean
  readonly register: Read<Paged<CheckResult>>
  readonly registerMore: boolean
  /** When the page was last read (the band's AsOf). */
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly planNew: PlanNewState | null
  readonly resultNew: ResultNewState | null
  readonly planOpen: PlanOpenState | null
  readonly resultOpen: ResultOpenState | null
  readonly move: MoveState | null
  /** Design cases: rows chosen, the keys list open, a chip being dragged. */
  readonly selected?: readonly string[]
  readonly chipSelected?: readonly string[]
  readonly registerSelected?: readonly string[]
  readonly keysOpen?: boolean
}

export interface PreventivePageActions {
  onAddress?: (change: Partial<PreventiveAddress>) => void
  onRetryCounts?: () => void
  onRetryCalendar?: () => void
  onRetryPlans?: () => void
  onRetryRegister?: () => void
  onMorePlans?: () => void
  onMoreRegister?: () => void
  onDismissNotice?: () => void
  // New plan
  onPlanDraft?: (draft: PlanDraft) => void
  onPickMachine?: (machineId: string) => void
  onCreatePlan?: () => void
  // Record a check result
  onResultDraft?: (draft: ResultDraft) => void
  onPickResultMachine?: (machineId: string) => void
  onSaveResult?: () => void
  // the windows
  onRetryPlan?: () => void
  onRetryResult?: () => void
  onResultStep?: (step: ResultOpenState['step']) => void
  onLockNote?: (note: string) => void
  onMakeJob?: () => void
  onLock?: () => void
  onReports?: (files: File[]) => void
  onOpenReport?: (resultId: string, fileId: string) => void
  // Move a check, Move N
  onMoveDraft?: (draft: MoveDraft) => void
  onMove?: () => void
  /** Move N: the plans chosen (a list's rows), null closes it. */
  onMoveMany?: (planIds: readonly string[] | null) => void
}
