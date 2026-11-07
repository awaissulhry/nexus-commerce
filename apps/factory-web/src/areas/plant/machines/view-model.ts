import type { ReactNode } from 'react'
import type { Machine, MachineClass, MachineRecord, MachineTiles, PlantSite, SupplierChoice } from '../_shared/api'
import type { LiveState } from '../_shared/hooks'
import type { MachinesAddress, PlantCan, Words } from '../_shared/model'
import type { Loaded, Notice, StepUpState } from '../_shared/parts'
import type { HistoryAnswer, MachineDepth, TagJob } from './depth/api'
import type { DepthAddress, WallFilter } from './depth/model'
import type { DocumentsActions, DocumentsState } from './depth/view/DocumentsTab'
import type { StatusDialogState } from './depth/view/StatusDialog'
import type { TagsDialogState } from './depth/view/TagsDialog'
import type { StatusDraft } from './depth/model'
import type { WallAnswer } from './depth/api'

/**
 * The ONE view model of Plant › Machines & tools (SCR-150: the register, New machine, Retire) and of a machine's record,
 * and the actions they report. The containers (MachinesPage.tsx, record/MachineRecord.tsx) load and map; the views fetch
 * nothing.
 */

export interface MachineRows {
  items: Machine[] | null
  more: boolean
  problem: string | null
}

/** A place cell saved inline (station, work centre). */
export interface CellState {
  state: 'saving' | 'saved' | 'failed'
  words?: Words | null
}

/** The machine's fields as typed (New machine, the record's edit). Cost in the company's currency as typed ("1850,00"). */
export interface MachineDraft {
  siteId: string | null
  assetNumber: string
  classId: string | null
  make: string
  modelName: string
  serialNumber: string
  year: string
  stationId: string | null
  workCentreId: string | null
  supplier: SupplierChoice | null
  cost: string
  note: string
}

export type MachinesDialog =
  | { kind: 'new'; draft: MachineDraft; suppliers: SupplierChoice[] | null; busy: boolean; problem: Words | null; field: string | null }
  | { kind: 'retire'; machines: Machine[]; reason: string; busy: boolean; problem: Words | null; refused: { assetNumber: string; words: Words }[] }

export interface MachinesListModel {
  prefix: string
  can: PlantCan
  address: Pick<MachinesAddress, 'view' | 'q' | 'siteId' | 'classId'>
  sites: PlantSite[]
  classes: MachineClass[]
  rows: MachineRows
  tiles: MachineTiles | null
  asOf: string | null
  live: LiveState
  updates: number
  timeZone: string
  cells: Readonly<Record<string, CellState>>
  dialog: MachinesDialog | null
  notice: Notice | null
  /** The machine just made: "Print its tag". */
  made: { id: string; assetNumber: string } | null
  selected?: readonly string[]
  helpOpen?: boolean
  /** B-W2b-136: machines in depth (absent: the W2a register alone). */
  depth?: ListDepth
}

/** B-W2b-136 on the register: the section shown, the two tiles that filter, the depth columns, the wall, Print QR tags. */
export interface ListDepth {
  address: DepthAddress
  tiles: { checksOverdue: number; noCe: number } | null
  /** By machine id: next check, CE on file, the newest tag job. */
  facts: Readonly<Record<string, MachineDepth>>
  today: string
  wall: { loaded: Loaded<WallAnswer>; filter: WallFilter; asOf: string | null }
  tags: TagsDialogState | null
  canPrint: boolean
  /** The dies section (its own container; absent in a design case that does not show it). */
  dies?: ReactNode
}

export interface MachinesListActions {
  onView?: (view: MachinesAddress['view']) => void
  onSearch?: (q: string) => void
  onSite?: (siteId: string | null) => void
  onClass?: (classId: string | null) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onPlace?: (machine: Machine, change: { stationId?: string | null; workCentreId?: string | null }) => void
  onNew?: () => void
  onRetire?: (machines: Machine[]) => void
  onDialogClose?: () => void
  onDraft?: (patch: Partial<MachineDraft>) => void
  onFindSupplier?: (text: string) => void
  onRetireReason?: (reason: string) => void
  onSubmitDialog?: () => void
  onExport?: (ids: readonly string[]) => void
  onDismissNotice?: () => void
  // B-W2b-136
  onSection?: (section: DepthAddress['section']) => void
  onNeed?: (need: DepthAddress['need']) => void
  onWallFilter?: (filter: WallFilter) => void
  onRetryWall?: () => void
  onOpenTags?: (machines: Machine[]) => void
  onTagPrinter?: (id: string) => void
  onTagCopies?: (copies: number) => void
  onTagPrint?: () => void
  onTagRetry?: (job: TagJob) => void
  onTagsClose?: () => void
}

// ---- the record -------------------------------------------------------------------------------------------------------------

/** B-W2b-136 adds Documents & CE, Status & downtime and Tag (design order; Spare parts is Later). */
export const MACHINE_TABS = ['overview', 'docs', 'history', 'status', 'tag'] as const
export type MachineTab = (typeof MACHINE_TABS)[number]

export interface MachineRecordModel {
  prefix: string
  can: PlantCan
  tab: MachineTab
  loaded: Loaded<MachineRecord>
  timeZone: string
  live: LiveState
  asOf: string | null
  sites: PlantSite[]
  classes: MachineClass[]
  /** The explicit edit of the facts (null: not editing). */
  edit: MachineDraft | null
  suppliers: SupplierChoice[] | null
  busy: boolean
  /** The field a refused save names. */
  field: string | null
  retire: { reason: string; busy: boolean; problem: Words | null } | null
  notice: Notice | null
  /** B-W2b-136: machines in depth (absent: the W2a record alone). */
  depth?: RecordDepth
}

/** B-W2b-136 on a machine's record. */
export interface RecordDepth {
  today: string
  facts: MachineDepth | null
  documents: DocumentsState
  history: { loaded: Loaded<HistoryAnswer>; week: string }
  tagJob: Loaded<TagJob | null>
  status: StatusDialogState | null
  tags: TagsDialogState | null
  stepUp: StepUpState
  canPrint: boolean
}

export interface RecordDepthActions extends DocumentsActions {
  /** `r`: Report a problem for this machine. */
  onReport?: () => void
  onWeek?: (monday: string) => void
  onRetryHistory?: () => void
  onOpenStatus?: () => void
  onStatusDraft?: (patch: Partial<StatusDraft>) => void
  onStatusClose?: () => void
  onStatusSubmit?: () => void
  onOpenTags?: () => void
  onTagPrinter?: (id: string) => void
  onTagCopies?: (copies: number) => void
  onTagPrint?: () => void
  onTagRetry?: (job: TagJob) => void
  onTagsClose?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
}

export interface MachineRecordActions {
  onRetry?: () => void
  onEdit?: () => void
  onDraft?: (patch: Partial<MachineDraft>) => void
  onFindSupplier?: (text: string) => void
  onEditCancel?: () => void
  onEditApply?: () => void
  onRetire?: () => void
  onRetireReason?: (reason: string) => void
  onRetireClose?: () => void
  onRetireSubmit?: () => void
  onDismissNotice?: () => void
  depth?: RecordDepthActions
}
