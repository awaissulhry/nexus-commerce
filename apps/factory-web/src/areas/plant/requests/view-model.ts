import type { CapturedPhoto } from '@nexus/ui/components/PhotoCapture/index'
import type { CloseReason, JobType, Machine, MaintenanceRequest, Priority, RequestRecord, RequestTiles, SafeAfter, Symptom, Technician } from '../_shared/api'
import type { LiveState } from '../_shared/hooks'
import type { PlantCan, RequestsAddress, Words } from '../_shared/model'
import type { Loaded, Notice, StepUpState } from '../_shared/parts'

/**
 * The ONE view model of Plant › Machine requests (SCR-148) and the actions it reports. The container
 * (RequestsPage.tsx) loads the queue, the tiles and the open request, and maps them here; the views fetch nothing.
 */

export interface SiteChoice {
  id: string
  code: string
  name: string
}

export interface RequestRows {
  /** null while the first read runs. */
  items: MaintenanceRequest[] | null
  /** The queue read its first 200 (unsafe first, then the oldest) and more wait. */
  truncated: boolean
  /** A list paged by a cursor (All, Done) has more. */
  more: boolean
  /** A message key of a failed read. */
  problem: string | null
}

/** A photo of the open request: its address once read (null while reading or when it could not be read). */
export interface PhotoView {
  id: string
  name: string
  src: string | null
}

export interface RequestDetailModel {
  id: string
  loaded: Loaded<RequestRecord>
  photos: PhotoView[]
  /** The photo shown full size (Lightbox), or null. */
  lightbox: number | null
  busy: boolean
  /** What went wrong with the last decision, in words (a refusal names its code). */
  problem: Words | null
}

/** "Make a job": a new job (prefilled from the request) or the machine's open job. */
export interface MakeJobDraft {
  mode: 'new' | 'join'
  type: JobType
  problem: string
  priority: Priority
  /** '' nobody; `USER:<id>` an office technician; `WORKER:<id>` a floor technician. */
  assignee: string
  /** The due time as typed (`YYYY-MM-DDTHH:mm`, the site's zone); '' none. */
  due: string
  plan: boolean
}

export interface CloseDraft {
  reason: CloseReason | null
  note: string
  keepDown: boolean
}

export interface SignSafeDraft {
  note: string
  machineAfter: SafeAfter | null
}

export interface ReportDraft {
  /** What was typed to find the machine (its asset number, make or model). */
  query: string
  machine: Machine | null
  symptomId: string | null
  description: string
  unsafe: boolean
  down: boolean
  /** The photo taken or picked (sent once the report is made). */
  photo: CapturedPhoto | null
  /** The photo step is open. */
  photoStep: boolean
}

export type RequestDialog =
  | { kind: 'makeJob'; draft: MakeJobDraft; technicians: Technician[] | null; floorListed: boolean; techniciansProblem: string | null; openJob: { id: string; number: string } | null; busy: boolean; problem: Words | null }
  | { kind: 'close'; draft: CloseDraft; machineDown: boolean; busy: boolean; problem: Words | null }
  | { kind: 'signSafe'; draft: SignSafeDraft; busy: boolean; problem: Words | null }
  | { kind: 'merge'; into: MaintenanceRequest; busy: boolean; problem: Words | null }
  | { kind: 'report'; draft: ReportDraft; found: Machine[] | null; searching: boolean; symptoms: Symptom[] | null; busy: boolean; problem: Words | null }

export interface RequestsListModel {
  prefix: string
  can: PlantCan
  address: Pick<RequestsAddress, 'view' | 'tile' | 'siteId'>
  sites: SiteChoice[]
  rows: RequestRows
  tiles: RequestTiles | null
  asOf: string | null
  live: LiveState
  /** New requests (not unsafe) waiting behind "N new · Show". */
  updates: number
  timeZone: string
  detail: RequestDetailModel | null
  dialog: RequestDialog | null
  stepUp: StepUpState
  notice: Notice | null
  /** Bulk acknowledge running. */
  busy: boolean
  /** Design cases: rows selected, the keys panel open. */
  selected?: readonly string[]
  helpOpen?: boolean
}

export interface RequestsListActions {
  onView?: (view: RequestsAddress['view']) => void
  onTile?: (tile: RequestsAddress['tile']) => void
  onSite?: (siteId: string | null) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  /** Open a request's detail (null: close it). */
  onOpen?: (id: string | null) => void
  onRetryDetail?: () => void
  onPhoto?: (index: number | null) => void
  onAcknowledge?: () => void
  onMakeJob?: () => void
  onClose?: () => void
  onSignSafe?: () => void
  onMerge?: (into: MaintenanceRequest) => void
  onDialogClose?: () => void
  onMakeJobDraft?: (patch: Partial<MakeJobDraft>) => void
  onCloseDraft?: (patch: Partial<CloseDraft>) => void
  onSignSafeDraft?: (patch: Partial<SignSafeDraft>) => void
  onReportDraft?: (patch: Partial<ReportDraft>) => void
  onSubmitDialog?: () => void
  onReport?: () => void
  onFindMachine?: (text: string) => void
  onSubmitStepUp?: (code: string) => void
  onCancelStepUp?: () => void
  onAcknowledgeMany?: (ids: readonly string[]) => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
}
