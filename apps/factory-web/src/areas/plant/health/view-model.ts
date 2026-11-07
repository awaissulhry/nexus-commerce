import type { FitnessOutcome, VoidReason } from '@nexus/factory-domain/safety/health/rules'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { DoctorChoice, HealthFrame, HealthPlan, Judgement, JudgementRow, PickedPerson, PrintRow, Proposal, ShownJudgement, ViewsAnswer, ViewsOf, Visit, VisitRow } from './api'
import type { BookDraft, ByHandDraft, HealthAddress, HealthCan, JudgementDraft, PlanDraft, Problem, VisitMoveDraft, Words } from './model'

/**
 * The view models of SCR-212 (the page, its dialogs and windows), SCR-212-visits (the doctor's visit list) and SCR-212-copy
 * (a judgement's copy). One model per view, nothing fetched in a view. Names and health values are here only as a recorded
 * read handed them (the container's state, never the address or browser storage); they leave with the dialog, the Hide, a new
 * read or the page.
 */

export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- the sections ----------------------------------------------------------------------------------------------------------

export interface DueState {
  readonly rows: readonly VisitRow[]
  readonly more: boolean
  /** When this read was recorded (the PrivacyNote says it). */
  readonly at: string
}

export interface JudgementsState {
  readonly rows: readonly JudgementRow[]
  readonly more: boolean
}

/** The judgements' values shown (one OPEN view recorded per row), by id; in the container's state only. */
export type Shown =
  | { readonly state: 'hidden' }
  | { readonly state: 'confirm'; readonly ids: readonly string[] }
  | { readonly state: 'reading'; readonly ids: readonly string[] }
  | { readonly state: 'shown'; readonly byId: Readonly<Record<string, ShownJudgement>>; readonly at: string }
  | { readonly state: 'error'; readonly problem: string }

/** "Who looked" (a DetailPopover): whose log is open and what it read. */
export interface WhoLookedState {
  readonly of: ViewsOf
  readonly read: Read<ViewsAnswer>
}

// ---- dialogs and windows -----------------------------------------------------------------------------------------------------

export interface BookDialogState {
  readonly ids: readonly string[]
  readonly draft: BookDraft
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface JudgementDialogState {
  readonly draft: JudgementDraft
  /** The visit it was opened from (a visit's window), when the due list on screen does not hold it. */
  readonly fromWindow: VisitRow | null
  /** The person picked by hand (HR: the staff list): their name lives here while the dialog is open. */
  readonly picked: PickedPerson | null
  readonly people: Read<{ people: readonly PickedPerson[]; complete: boolean }> | null
  readonly peopleQuery: string
  readonly copy: File | null
  readonly busy: boolean
  readonly problem: Problem | null
  /** Saved, but its copy was not taken: open the judgement to add it. */
  readonly savedWithoutCopy: string | null
}

export interface PlanVisitsState {
  readonly proposals: Read<{ proposals: readonly Proposal[]; at: string }>
  readonly chosen: readonly string[]
  readonly byHand: readonly ByHandDraft[]
  /** The person picker of one visit by hand (its key), and what it read. */
  readonly picking: string | null
  readonly people: Read<{ people: readonly PickedPerson[]; complete: boolean }> | null
  readonly peopleQuery: string
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface VisitWindowState {
  readonly id: string
  readonly read: Read<{ visit: Visit; at: string }>
  readonly move: VisitMoveDraft | null
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface JudgementWindowState {
  readonly id: string
  readonly read: Read<{ judgement: Judgement; at: string }>
  readonly mode: 'view' | 'void' | 'copy'
  readonly reason: VoidReason | null
  readonly copy: File | null
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface PlanDialogState {
  readonly plan: HealthPlan
  readonly draft: PlanDraft
  readonly doctors: Read<readonly DoctorChoice[]> | null
  readonly busy: boolean
  readonly problem: Problem | null
}

// ---- the page --------------------------------------------------------------------------------------------------------------

export interface HealthPageModel {
  readonly prefix: string
  readonly can: HealthCan
  readonly scope: OfficeScope
  readonly companyId: string | null
  readonly address: HealthAddress
  readonly today: string
  readonly locale?: 'it' | 'en'
  /** GET /safety/health: the privacy words, live use, the tiles (counts), what the caller may do. Read FIRST. */
  readonly frame: Read<HealthFrame>
  readonly due: Read<DueState> | null
  readonly dueMore: boolean
  readonly dueUpdates: number
  readonly judgements: Read<JudgementsState> | null
  readonly judgementsMore: boolean
  readonly judgementUpdates: number
  readonly shown: Shown
  readonly plans: Read<readonly HealthPlan[]> | null
  readonly readAt: string | null
  readonly notice: PageNotice | null
  readonly dueSelected?: readonly string[]
  readonly judgementSelected?: readonly string[]
  readonly whoLooked: WhoLookedState | null
  readonly book: BookDialogState | null
  readonly judge: JudgementDialogState | null
  readonly planVisits: PlanVisitsState | null
  readonly visit: VisitWindowState | null
  readonly judgement: JudgementWindowState | null
  readonly plan: PlanDialogState | null
  readonly keysOpen?: boolean
}

export interface HealthPageActions {
  onAddress?: (change: Partial<HealthAddress>) => void
  onRetryFrame?: () => void
  onRetryDue?: () => void
  onRetryJudgements?: () => void
  onRetryPlans?: () => void
  onDueMore?: () => void
  onDueUpdates?: () => void
  onJudgementsMore?: () => void
  onJudgementUpdates?: () => void
  onDismissNotice?: () => void
  onDueSelected?: (ids: string[]) => void
  onJudgementSelected?: (ids: string[]) => void
  onWhoLooked?: (of: ViewsOf | null) => void
  // Show the judgements' values (one view recorded per row)
  onAskShow?: (ids: readonly string[]) => void
  onShow?: () => void
  onHideShown?: () => void
  // Mark booked
  onBook?: (ids: readonly string[]) => void
  onBookDraft?: (draft: BookDraft) => void
  onBookSave?: () => void
  onBookClose?: () => void
  // Record a judgement
  onJudgeDraft?: (draft: JudgementDraft) => void
  onJudgePeopleQuery?: (q: string) => void
  onJudgePick?: (person: PickedPerson | null) => void
  onJudgeCopy?: (file: File | null) => void
  onJudgeSave?: () => void
  onJudgeClose?: () => void
  // Plan visits
  onPlanChosen?: (keys: readonly string[]) => void
  onPlanByHand?: (items: readonly ByHandDraft[]) => void
  onPlanPick?: (key: string | null) => void
  onPlanPeopleQuery?: (q: string) => void
  onPlanPerson?: (key: string, person: PickedPerson) => void
  onPlanRetry?: () => void
  onPlanSave?: () => void
  onPlanClose?: () => void
  // a visit's window
  onVisitMove?: (draft: VisitMoveDraft | null) => void
  onVisitSave?: () => void
  onVisitRetry?: () => void
  onVisitClose?: () => void
  // a judgement's window
  onJudgementMode?: (mode: 'view' | 'void' | 'copy') => void
  onJudgementReason?: (reason: VoidReason) => void
  onJudgementCopy?: (file: File | null) => void
  onJudgementSave?: () => void
  onJudgementRetry?: () => void
  onJudgementClose?: () => void
  // a role's plan
  onPlanDraft?: (draft: PlanDraft) => void
  onPlanEditSave?: () => void
  onPlanEditClose?: () => void
}

/** A held reason or a problem in words. */
export type Said = Words | Problem

// ---- the windows -------------------------------------------------------------------------------------------------------------

export interface VisitListPrintModel {
  readonly person: string
  readonly at: string
  readonly company: string
  readonly site: string | null
  readonly allSites: boolean
  readonly chosen: number
  readonly canView: boolean
  readonly list: { readonly rows: readonly PrintRow[] | null; readonly problem: string | null; readonly law: string | null }
}

export interface JudgementCopyModel {
  readonly canView: boolean
  /** What the copy is, read from its first bytes (its file name is never shown: it may name the person). */
  readonly kind: 'pdf' | 'image' | null
  readonly bytes: Uint8Array | null
  readonly problem: string | null
  /** When this opening was recorded. */
  readonly at: string | null
}

export type { FitnessOutcome }
