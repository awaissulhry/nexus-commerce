import type { LiveState, Tone } from '../../quality/_shared/model'
import type { StepUpState } from '../../quality/_shared/hooks'
import type {
  CreditNotes,
  DdtPreview,
  DecisionPreview,
  PartyOption,
  Person,
  ReasonOption,
  Repair,
  RepairCounts,
  RepairOptions,
  RepairPreview,
  RepairRow,
  ReturnCounts,
  Returnable,
  ReturnPreview,
  Rma,
} from './api'
import type {
  AfterSalesRow,
  ChecklistDraft,
  DdtDraft,
  DecisionDraft,
  FinishReason,
  ListAddress,
  NewRepairDraft,
  NewReturnDraft,
  ReceiptDraft,
  ReturnsCan,
  Words,
} from './model'

/**
 * The view models of Sales › Returns & repairs (SCR-111 list, SCR-112 the RMA and the repair order): what each view
 * draws, nothing it fetches. The containers (ReturnsPage, ReturnRecord, RepairRecord) read the API and fill these; the
 * design fixtures fill them with made-up data.
 */

export interface Notice {
  readonly tone: Tone
  readonly words: Words
  /** A link the notice offers (the view it filters to, or a page). */
  readonly href?: string
  readonly linkWords?: Words
  /** Kept dismissed by this value: a new fact shows again. */
  readonly id: string
}

// ---- dialogs of the list (and the RMA's Make repair order) ----------------------------------------------------------------

export interface NewReturnModel {
  readonly draft: NewReturnDraft
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null }
  readonly returnable: { readonly value: Returnable | null; readonly loading: boolean; readonly problem: string | null }
  readonly reasons: readonly ReasonOption[] | null
  readonly preview: ReturnPreview | null
  readonly previewing: boolean
  readonly showProblems: boolean
  readonly busy: boolean
  readonly problem: Words | null
  readonly today: string
  readonly price: boolean
}

export interface NewRepairModel {
  readonly draft: NewRepairDraft
  /** Made from an RMA line: its number and line (the garment, customer and site come from it). */
  readonly fromLine: { readonly returnNumber: string; readonly seq: number; readonly garment: string } | null
  readonly customers: { readonly items: readonly PartyOption[] | null; readonly problem: string | null }
  readonly preview: RepairPreview | null
  readonly previewing: boolean
  readonly showProblems: boolean
  readonly busy: boolean
  readonly problem: Words | null
  readonly today: string
}

export interface CloseModel {
  readonly number: string
  readonly reason: FinishReason | ''
  readonly note: string
  readonly busy: boolean
  readonly problem: Words | null
  /** After the close: the API's warnings (lines to replace without the order, goods without their return DDT). */
  readonly warnings: number | null
}

// ---- the list ----------------------------------------------------------------------------------------------------------------

export interface ReturnsListModel {
  readonly prefix: string
  readonly can: ReturnsCan
  readonly me: string
  readonly address: ListAddress
  readonly rows: { readonly items: readonly AfterSalesRow[] | null; readonly problem: string | null; readonly truncated: boolean }
  readonly counts: { readonly returns: ReturnCounts | null; readonly repairs: RepairCounts | null; readonly failed: boolean }
  readonly people: readonly Person[]
  readonly asOf: string | null
  readonly live: LiveState
  readonly offline: boolean
  readonly updates: number
  readonly today: string
  readonly notices: readonly Notice[]
  readonly receipt: { readonly tone: Tone; readonly words: Words } | null
  readonly newReturn: NewReturnModel | null
  readonly newRepair: NewRepairModel | null
  readonly close: CloseModel | null
  /** Design cases: rows picked, the keys panel open, the focused row. */
  readonly selected?: readonly string[]
  readonly helpOpen?: boolean
  readonly focusRow?: number
}

export interface NewReturnActions {
  onNewReturnDraft?: (patch: Partial<NewReturnDraft>) => void
  onNewReturnLine?: (key: string, patch: Partial<NewReturnDraft['lines'][string]>) => void
  onNewReturnSubmit?: () => void
  onNewReturnClose?: () => void
}

export interface NewRepairActions {
  onNewRepairDraft?: (patch: Partial<NewRepairDraft>) => void
  onNewRepairLookUp?: () => void
  onNewRepairSubmit?: () => void
  onNewRepairClose?: () => void
}

export interface CloseActions {
  onCloseDraft?: (patch: { reason?: FinishReason | ''; note?: string }) => void
  onCloseSubmit?: () => void
  onCloseDismiss?: () => void
}

export interface ReturnsListActions extends NewReturnActions, NewRepairActions, CloseActions {
  onAddress?: (patch: Partial<ListAddress>) => void
  onClearFilters?: () => void
  onRetry?: () => void
  onShowUpdates?: () => void
  onNewReturn?: () => void
  onNewRepair?: () => void
  onClose?: (row: AfterSalesRow) => void
  onOpen?: (row: AfterSalesRow) => void
  onCopy?: (text: string) => void
  onExport?: (rows: readonly AfterSalesRow[]) => void
  onDismissNotice?: (id: string) => void
  onDismissReceipt?: () => void
}

// ---- the RMA record --------------------------------------------------------------------------------------------------------

export const RMA_TABS = ['lines', 'inspection', 'credit', 'shipments', 'activity'] as const
export type RmaTab = (typeof RMA_TABS)[number]

export type RmaDialog =
  | { readonly kind: 'receive'; readonly draft: ReceiptDraft }
  | { readonly kind: 'grade'; readonly lineIds: readonly string[]; readonly grade: string; readonly cause: string; readonly note: string }
  | { readonly kind: 'decide'; readonly lineIds: readonly string[] }
  | { readonly kind: 'replacement'; readonly note: string }
  | { readonly kind: 'credit' }
  | { readonly kind: 'ddt'; readonly draft: DdtDraft; readonly preview: DdtPreview | null; readonly previewing: boolean }
  | { readonly kind: 'cancel'; readonly reason: string }

export interface RmaModel {
  readonly prefix: string
  readonly can: ReturnsCan
  readonly me: string
  readonly tab: RmaTab
  readonly rma: Rma
  readonly people: readonly Person[]
  readonly reasons: readonly ReasonOption[] | null
  readonly asOf: string | null
  readonly live: LiveState
  readonly offline: boolean
  readonly today: string
  readonly receipt: { readonly tone: Tone; readonly words: Words; readonly href?: string } | null
  readonly changedAt: string | null
  /** Lines tab: each cell's save state (`<lineId>:<field>`). */
  readonly marks: Readonly<Record<string, { readonly state: 'saving' | 'saved' | 'refused'; readonly words?: Words }>>
  /** Inspection tab: the drafts per line and their preview. */
  readonly decisions: Readonly<Record<string, DecisionDraft>>
  readonly decisionPreview: DecisionPreview | null
  readonly decisionPreviewing: boolean
  readonly credit: { readonly value: CreditNotes | null; readonly problem: string | null }
  readonly repairs: { readonly items: readonly RepairRow[] | null; readonly problem: string | null }
  readonly dialog: RmaDialog | null
  readonly dialogBusy: boolean
  readonly dialogProblem: Words | null
  readonly close: CloseModel | null
  readonly newRepair: NewRepairModel | null
  readonly dockOpen: boolean
}

export interface RmaActions extends CloseActions, NewRepairActions {
  onReload?: () => void
  onDismissReceipt?: () => void
  onDock?: () => void
  onQuantity?: (lineId: string, value: string) => void
  onReason?: (lineId: string, code: string) => void
  onRemoveLine?: (lineId: string) => void
  onDialog?: (dialog: RmaDialog | null) => void
  onDialogSubmit?: () => void
  onDecision?: (lineId: string, patch: Partial<DecisionDraft>) => void
  onDecide?: (lineIds: readonly string[]) => void
  onDecisionPreview?: () => void
  onMakeRepair?: (lineId: string) => void
  onCloseOpen?: () => void
  onCopy?: (text: string) => void
}

// ---- the repair record ------------------------------------------------------------------------------------------------------

export const REPAIR_TABS = ['intake', 'work', 'safety', 'return', 'activity'] as const
export type RepairTab = (typeof REPAIR_TABS)[number]

export interface IntakeDraft {
  readonly kind: Repair['kind']
  readonly problem: string
  readonly inboundDdtNumber: string
  readonly inboundDdtDate: string
  readonly internalNote: string
}

export type RepairDialog =
  | { readonly kind: 'receive'; readonly ddtNumber: string; readonly ddtDate: string; readonly note: string }
  | { readonly kind: 'move'; readonly action: 'estimate' | 'approve' | 'startRepair' | 'finishRepair' | 'reopenRepair'; readonly note: string }
  | { readonly kind: 'workOrder'; readonly options: RepairOptions | null; readonly problem: string | null; readonly seqs: readonly number[] }
  | { readonly kind: 'ship'; readonly draft: DdtDraft; readonly note: string; readonly preview: DdtPreview | null; readonly previewing: boolean; readonly useLive: boolean }
  | { readonly kind: 'cancel'; readonly reason: string }

export interface PhotoView {
  readonly id: string
  readonly name: string
  readonly src: string | null
}

export interface RepairModel {
  readonly prefix: string
  readonly can: ReturnsCan
  readonly me: string
  readonly tab: RepairTab
  readonly repair: Repair
  readonly asOf: string | null
  readonly live: LiveState
  readonly offline: boolean
  readonly today: string
  readonly receipt: { readonly tone: Tone; readonly words: Words; readonly href?: string } | null
  readonly changedAt: string | null
  readonly edit: { readonly draft: IntakeDraft; readonly busy: boolean; readonly problem: Words | null } | null
  readonly photos: readonly PhotoView[]
  readonly uploading: boolean
  readonly checklist: ChecklistDraft
  readonly checkProblem: Words | null
  readonly checkBusy: boolean
  readonly showCheckProblems: boolean
  readonly stepUp: StepUpState
  readonly dialog: RepairDialog | null
  readonly dialogBusy: boolean
  readonly dialogProblem: Words | null
  readonly dockOpen: boolean
}

export interface RepairActions {
  onReload?: () => void
  onDismissReceipt?: () => void
  onDock?: () => void
  onEdit?: () => void
  onEditDraft?: (patch: Partial<IntakeDraft>) => void
  onEditSave?: () => void
  onEditCancel?: () => void
  onPhotos?: (files: readonly File[]) => void
  onChecklist?: (patch: Partial<ChecklistDraft>) => void
  onSign?: () => void
  onStepUpSubmit?: (code: string) => void
  onStepUpCancel?: () => void
  onDialog?: (dialog: RepairDialog | null) => void
  onDialogSubmit?: () => void
  onShipPreview?: () => void
  onCopy?: (text: string) => void
}
