import type { AppointmentSignMethod } from '@nexus/factory-domain/safety/organisation/rules'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import type { AppointmentRecord, CalendarAnswer, CalendarItem, CountsAnswer, Deadline, DeadlineRecord, NoticesAnswer, Organisation, OrgContact, OrgPerson, Owner, RlsNotice } from './api'
import type { AppointmentDraft, CalendarAddress, CalendarCan, DeadlineDraft, EndDraft, FilingDraft, Problem } from './model'

/**
 * SCR-267's view model (B-W2b-120): ONE typed model the page view draws (`view/CalendarPageView.tsx`), filled by the
 * container (`CalendarPage.tsx` + `use-dialogs.ts`) from the API, or by `fixtures.ts` with made-up data. Each section
 * reads and fails on its own; a dialog holds its own read, draft, busy state and the API's last refusal in our words.
 */

/** A section's read: loading (a skeleton, "still loading" after a second), ready, or failed (our words + Try again). */
export type Read<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly problem: string }

export interface PageNotice {
  readonly tone: 'success' | 'info' | 'warning' | 'danger'
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
  /** Params that are message keys themselves (said first). */
  readonly sub?: Readonly<Record<string, string>>
  /** Rows a many-rows action left as they were, each with why (a message key). */
  readonly refused?: readonly { readonly label: string; readonly key: string }[]
}

/** Add deadline (`?new=1`). */
export interface DeadlineNewState {
  readonly draft: DeadlineDraft
  readonly owners: Read<readonly Owner[]>
  readonly busy: boolean
  readonly problem: Problem | null
}

/** The Deadline window (`?open=DEADLINE:<id>`), J / K over the list's deadlines. */
export interface DeadlineOpenState {
  readonly key: string
  readonly id: string
  readonly read: Read<DeadlineRecord>
  readonly mode: 'view' | 'edit' | 'cancel'
  readonly draft: DeadlineDraft | null
  readonly owners: Read<readonly Owner[]> | null
  readonly doneNote: string
  readonly cancelReason: string
  readonly busy: boolean
  readonly uploading: boolean
  readonly problem: Problem | null
  /** The next occurrence a done repeating deadline made. */
  readonly next: Deadline | null
  /** What was just done, in words. */
  readonly saved: string | null
}

/** The Appointment dialog for a new appointment (`?appoint=new&role=&at=`). */
export interface AppointmentNewState {
  readonly mode: 'new'
  readonly draft: AppointmentDraft
  readonly people: Read<{ readonly people: readonly OrgPerson[]; readonly complete: boolean }>
  readonly contacts: Read<{ readonly contacts: readonly OrgContact[]; readonly complete: boolean }>
  readonly shifts: Read<readonly { id: string; code: string; name: string }[]>
  readonly busy: boolean
  readonly problem: Problem | null
}

/** The Appointment dialog on a saved appointment (`?appoint=<id>`): letter, signature, end, note. */
export interface AppointmentOpenState {
  readonly mode: 'open'
  readonly id: string
  readonly read: Read<AppointmentRecord>
  readonly step: 'view' | 'end'
  readonly signMethod: AppointmentSignMethod
  readonly end: EndDraft
  readonly note: string | null
  readonly busy: boolean
  readonly uploading: boolean
  readonly problem: Problem | null
  readonly saved: string | null
  /** Just made by the New dialog: say so on top. */
  readonly created?: boolean
}

/** Record RLS notice (`?filing=<notice id>`): the notice comes from the panel's read. */
export interface FilingState {
  readonly id: string
  /** The notice as the last write answered it (newer than the panel's read until that one comes back). */
  readonly latest: RlsNotice | null
  readonly step: 'file' | 'due' | 'cancel'
  readonly draft: FilingDraft
  readonly busy: boolean
  readonly uploading: boolean
  readonly problem: Problem | null
  readonly saved: string | null
}

/** End term N (the organisation's bulk action): one last day and one reason for every term chosen. */
export interface EndTermsState {
  readonly ids: readonly string[]
  readonly draft: EndDraft
  readonly busy: boolean
  readonly problem: Problem | null
}

export interface CalendarPageModel {
  /** `/w/<company>`: links are company-free plus this. */
  readonly prefix: string
  readonly can: CalendarCan
  readonly scope: OfficeScope
  /** The page's company (`/w/<company>`), the one a new deadline or appointment is for. */
  readonly companyId: string | null
  readonly address: CalendarAddress
  /** The site's day (the API's, once read). */
  readonly today: string
  /** The month the Month view shows. */
  readonly month: string
  readonly counts: Read<CountsAnswer>
  readonly calendar: Read<CalendarAnswer>
  /** A read again runs while the last one stays on screen. */
  readonly calendarReading: boolean
  /** When the calendar was last read (the band's AsOf). */
  readonly readAt: string | null
  readonly organisation: Read<Organisation>
  readonly notices: Read<NoticesAnswer>
  readonly notice: PageNotice | null
  readonly bulkBusy: boolean
  readonly deadlineNew: DeadlineNewState | null
  readonly deadline: DeadlineOpenState | null
  readonly appointment: AppointmentNewState | AppointmentOpenState | null
  readonly filing: FilingState | null
  readonly endTerms: EndTermsState | null
  /** Design cases: rows chosen, the keys list open. */
  readonly selected?: readonly string[]
  readonly orgSelected?: readonly string[]
  readonly keysOpen?: boolean
}

export interface CalendarPageActions {
  onAddress?: (change: Partial<CalendarAddress>) => void
  onNavigate?: (href: string) => void
  onRetryCounts?: () => void
  onRetryCalendar?: () => void
  onRetryOrganisation?: () => void
  onRetryNotices?: () => void
  onDismissNotice?: () => void
  /** An item kept on a page not built yet: said on top. */
  onKept?: (item: CalendarItem) => void
  /** Mark done N: one call per deadline; resolves once every row was tried. */
  onBulkDone?: (items: readonly CalendarItem[]) => Promise<void>
  // Add deadline
  onDeadlineDraft?: (draft: DeadlineDraft) => void
  onCreateDeadline?: () => void
  // the Deadline window
  onDeadlineMode?: (mode: DeadlineOpenState['mode']) => void
  onDeadlineEditDraft?: (draft: DeadlineDraft) => void
  onSaveDeadline?: () => void
  onDoneNote?: (note: string) => void
  onMarkDone?: () => void
  onCancelReason?: (reason: string) => void
  onCancelDeadline?: () => void
  onEvidence?: (files: File[]) => void
  onOpenFile?: (fileId: string) => void
  onRetryDeadline?: () => void
  // the Appointment
  onAppointmentDraft?: (draft: AppointmentDraft) => void
  onSaveAppointment?: () => void
  onRetryAppointment?: () => void
  onLetter?: (files: File[]) => void
  onSignMethod?: (method: AppointmentSignMethod) => void
  onSign?: (name: string) => void
  onAppointmentStep?: (step: AppointmentOpenState['step']) => void
  onEndDraft?: (draft: EndDraft) => void
  onEndTerm?: () => void
  onNoteDraft?: (note: string) => void
  onSaveNote?: () => void
  // Record RLS notice
  onFilingDraft?: (draft: FilingDraft) => void
  onFilingStep?: (step: FilingState['step']) => void
  onRecordFiling?: () => void
  onSetDue?: () => void
  onCancelNotice?: () => void
  onReceipt?: (files: File[]) => void
  // End term N
  onEndTerms?: (ids: readonly string[] | null) => void
  onEndTermsDraft?: (draft: EndDraft) => void
  onApplyEndTerms?: () => Promise<void>
}
