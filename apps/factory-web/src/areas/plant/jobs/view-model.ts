import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { JobChange, JobMove, JobTiles, JobType, Machine, MaintenanceJob, ManualJobSource, Priority, Technicians } from '../_shared/api'
import type { LiveState } from '../_shared/hooks'
import type { JobsAddress, PlantCan, Words } from '../_shared/model'
import type { Loaded, Notice, StepUpState } from '../_shared/parts'
import type { DeepJobRecord, MediaCategory } from '../requests/depth/api'
import type { CloseDraft, MediaView } from '../requests/depth/model'
import type { SignSafeDraft } from '../requests/view-model'

/**
 * The ONE view model of Plant › Maintenance jobs (SCR-149: the list or the board, New job, Assign jobs) and of a job's
 * record, and the actions they report. The containers (JobsPage.tsx, record/JobRecord.tsx) load and map; the views fetch
 * nothing.
 */

export interface SiteChoice {
  id: string
  code: string
  name: string
}

export interface JobRows {
  items: MaintenanceJob[] | null
  more: boolean
  problem: string | null
}

/** A cell saved inline (priority, due, assignee): saving, saved, or refused with its words. */
export interface CellState {
  state: 'saving' | 'saved' | 'failed'
  words?: Words | null
}

/** Technicians per site, read once when a job of that site is edited or made (null: still reading). */
export type TechniciansBySite = Readonly<Record<string, (Technicians & { problem: string | null }) | null>>

export interface NewJobDraft {
  query: string
  machine: Machine | null
  type: JobType
  problem: string
  priority: Priority
  source: ManualJobSource
  /** '' nobody; `USER:<id>`; `WORKER:<id>`. */
  assignee: string
  /** `YYYY-MM-DDTHH:mm` in the site's zone; '' none. */
  due: string
  plan: boolean
}

/** The Hand back dialog (B-W2b-140; design pop:close): the one-screen close of one job, its record read when it opens. */
export interface HandBackDialogState {
  kind: 'handBack'
  jobId: string
  number: string
  loaded: Loaded<DeepJobRecord>
  draft: CloseDraft
  busy: boolean
  problem: Words | null
}

export type JobsDialog =
  | { kind: 'new'; draft: NewJobDraft; found: Machine[] | null; searching: boolean; busy: boolean; problem: Words | null }
  | { kind: 'assign'; jobs: MaintenanceJob[]; assignee: string; busy: boolean; problem: Words | null }
  | HandBackDialogState

export interface JobsListModel {
  prefix: string
  can: PlantCan
  address: Pick<JobsAddress, 'view' | 'siteId' | 'machineId' | 'mode'>
  /** The machine the list is filtered to (`?machine=`), when known. */
  machine: { id: string; assetNumber: string } | null
  sites: SiteChoice[]
  rows: JobRows
  tiles: JobTiles | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  /** The clock the due words are read against (the design cases pin it). */
  now: string
  technicians: TechniciansBySite
  cells: Readonly<Record<string, CellState>>
  dialog: JobsDialog | null
  notice: Notice | null
  /** A board move under way (the card's id). */
  moving: string | null
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface JobsListActions {
  onView?: (view: JobsAddress['view']) => void
  onSite?: (siteId: string | null) => void
  onMachine?: (machineId: string | null) => void
  onMode?: (mode: JobsAddress['mode']) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  /** An inline edit of one field of a job (autosaved with its version). */
  onEdit?: (job: MaintenanceJob, change: Omit<JobChange, 'version'>, cell: 'priority' | 'due' | 'assignee') => void
  /** A cell needs its site's technicians. */
  onNeedTechnicians?: (siteId: string) => void
  /** A board move; false when it did not happen. */
  onBoardMove?: (job: MaintenanceJob, move: JobMove) => Promise<boolean>
  onNew?: () => void
  onAssign?: (jobs: MaintenanceJob[]) => void
  onDialogClose?: () => void
  onNewDraft?: (patch: Partial<NewJobDraft>) => void
  onFindMachine?: (text: string) => void
  onAssignee?: (assignee: string) => void
  /** The Hand back dialog's draft (B-W2b-140) and a failed read of its job again. */
  onCloseDraft?: (patch: Partial<CloseDraft>) => void
  onRetryHandBack?: () => void
  onSubmitDialog?: () => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
}

// ---- the record ---------------------------------------------------------------------------------------------------------------

// ---- B-TH-265 (threads plan, the rule of picture 38; 08-tabs O-PLT-JOB): tabs 4 → 2 — "Problem & photos" (the Problem body, then the
// Photos body as they are: before / after is a category the thread's Files view does not show, and the requests' photos live on other
// records) and Hand-back. Activity went: the job's thread is docked beside both tabs (notes only: a job has no party), its tools in the
// thread's "⋯" (R-ACT).
export const JOB_TABS = ['problem', 'handback'] as const
export type JobTab = (typeof JOB_TABS)[number]
/** Every old `?tab=` keeps working (R-8): Photos lands on Problem & photos, Activity too (the record frame opens the thread). */
export const MERGED_JOB_TABS: Readonly<Record<string, JobTab>> = { photos: 'problem', activity: 'problem' }
export function jobTabOf(value: string | null | undefined): JobTab {
  const asked = value ?? ''
  if ((JOB_TABS as readonly string[]).includes(asked)) return asked as JobTab
  return Object.hasOwn(MERGED_JOB_TABS, asked) ? MERGED_JOB_TABS[asked]! : 'problem'
}
// ---- end B-TH-265

export interface JobEditDraft {
  type: JobType
  problem: string
  priority: Priority
  assignee: string
  due: string
}

export type JobRecordDialog =
  | { kind: 'cancel'; reason: string; busy: boolean; problem: Words | null }
  /** B-W2b-140: the one-screen close in a dialog (the record's primary, `h`). */
  | { kind: 'handBack'; busy: boolean; problem: Words | null }
  /** B-W2b-140: Sign safe from the Unsafe lock panel (then a fresh code). */
  | { kind: 'signSafe'; draft: SignSafeDraft; busy: boolean; problem: Words | null }

/** A photo or voice note being added (B-W2b-140): the camera open, sending, or failed with Try again. */
export type Capture =
  | { state: 'camera'; category: MediaCategory }
  | { state: 'sending'; kind: 'PHOTO' | 'AUDIO' }
  | { state: 'failed'; kind: 'PHOTO' | 'AUDIO'; words: Words }

export interface JobRecordModel {
  prefix: string
  can: PlantCan
  tab: JobTab
  loaded: Loaded<DeepJobRecord>
  timeZone: string
  now: string
  live: LiveState
  asOf: string | null
  technicians: (Technicians & { problem: string | null }) | null
  /** The side panel's explicit edit (null: not editing). */
  edit: JobEditDraft | null
  editBusy: boolean
  /** The one-screen close (the Hand-back tab and the Hand back dialog share it). */
  handBack: CloseDraft
  busy: boolean
  dialog: JobRecordDialog | null
  notice: Notice | null
  /** B-W2b-140: the job's and its requests' photos and voice notes, each with its address once read. */
  media: MediaView[]
  /** The photo shown full size (an index into the photos that could be read), or null. */
  lightbox: number | null
  capture: Capture | null
  stepUp: StepUpState
  /** B-TH-265: the reader (the docked thread's width is remembered per person and record type). */
  personId?: string | null
}

export interface JobRecordActions {
  onRetry?: () => void
  onMove?: (move: JobMove) => void
  onEdit?: () => void
  onEditDraft?: (patch: Partial<JobEditDraft>) => void
  onEditCancel?: () => void
  onEditApply?: () => void
  onHandBackDraft?: (patch: Partial<CloseDraft>) => void
  onHandBack?: () => void
  /** B-W2b-140: the Hand back dialog (the record's primary, `h`). */
  onOpenHandBack?: () => void
  /** B-W2b-140: the line lead confirms the machine works. */
  onConfirmLead?: () => void
  onSignSafe?: () => void
  onSignSafeDraft?: (patch: Partial<SignSafeDraft>) => void
  onSubmitStepUp?: (code: string) => void
  onCancelStepUp?: () => void
  onPhoto?: (index: number | null) => void
  /** Open the camera for a photo before / after the work; null closes it. */
  onCamera?: (category: MediaCategory | null) => void
  onPhotoTaken?: (photo: CapturedPhoto) => void
  /** A voice note picked (or recorded by the phone through the file picker). */
  onVoicePicked?: (file: File) => void
  onRetryUpload?: () => void
  onCancelJob?: () => void
  onDialogDraft?: (reason: string) => void
  onDialogClose?: () => void
  onDialogSubmit?: () => void
  onDismissNotice?: () => void
}
