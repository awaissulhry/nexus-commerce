import type { Machine, MachineClass, MachineRecord, MachineTiles, PlantSite, SupplierChoice } from '../_shared/api'
import type { LiveState } from '../_shared/hooks'
import type { MachinesAddress, PlantCan, Words } from '../_shared/model'
import type { Loaded, Notice } from '../_shared/parts'

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
}

// ---- the record -------------------------------------------------------------------------------------------------------------

export const MACHINE_TABS = ['overview', 'history'] as const
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
}
