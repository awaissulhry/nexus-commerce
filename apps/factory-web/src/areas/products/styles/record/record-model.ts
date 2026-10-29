import type { RecordPanelsViewModel } from '../../../../record-panels/model'
import type {
  BomLineInput,
  BomView,
  BrandRow,
  ColourRow,
  ColourwayInput,
  CostDiffView,
  CostSheetView,
  LabelTemplateRow,
  MaterialRow,
  MaterialView,
  OperationRow,
  RoutingView,
  ScaleRow,
  StyleComplianceView,
  StylePatch,
  StyleView,
} from '../api'
import type { Grains, StyleAbilities, StyleTab } from '../model'

/** The style itself: read, or why not. */
export type Loaded<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string } | { status: 'not_found' } | { status: 'forbidden' }

/** A part of the studio (the BOM, the routing, the cost sheet, the compliance tab): each loads and fails alone. */
export type Part<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface SaveState {
  state: 'idle' | 'saving' | 'saved' | 'failed'
  at: string | null
}

export interface StyleNotice {
  key: string
  tone: 'info' | 'success' | 'warning' | 'danger'
  params?: Record<string, string | number>
}

export type BomViewMode = 'lines' | 'sizes' | 'colours'

/** The pop-ups of the studio (one at a time). */
export type StyleDialog =
  | { kind: 'release' }
  | { kind: 'startRevision' }
  | { kind: 'abandon' }
  | { kind: 'archive' }
  | { kind: 'colourway'; colourwayId: string | null }
  | { kind: 'generate' }
  | { kind: 'bomLine'; lineId: string | null }
  | { kind: 'removeLine'; lineId: string }
  | { kind: 'addOperations' }
  | { kind: 'removeStep'; stepId: string }
  | { kind: 'upload'; documentKind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'; language: string }
  | { kind: 'help' }

export interface SearchState<T> {
  query: string
  results: T[] | null
  problem: string | null
}

export interface StyleRecordViewModel {
  /** `/w/<company>`. */
  prefix: string
  tab: StyleTab
  can: StyleAbilities
  grains: Grains
  /** The company the page works in (a tenant-wide style's cost sheet is priced for it). */
  companyId: string | null
  style: Loaded<StyleView>
  /** The revision in view (`?rev=`, else the draft, else the released one). */
  revisionId: string | null
  bom: Part<BomView>
  routing: Part<RoutingView>
  cost: Part<CostSheetView>
  /** The draft's cost against the released revision's (the strip's change), when both exist. */
  costCompare: CostDiffView | null
  compliance: Part<StyleComplianceView>
  libraries: {
    scales: ScaleRow[] | null
    colours: ColourRow[] | null
    brands: BrandRow[] | null
    labels: LabelTemplateRow[] | null
  }
  /** The materials of the BOM's colour-dependent lines (their colours fill the colour grid's choices). */
  materials: Record<string, MaterialView | null>
  materialSearch: SearchState<MaterialRow>
  operationSearch: SearchState<OperationRow> & { kind: string | null }
  bomView: BomViewMode
  /** The Cost tab's cell (a colourway and a size). */
  costCell: { colourwayId: string; size: string } | null
  save: SaveState
  dialog: StyleDialog | null
  busy: boolean
  notice: StyleNotice | null
  /** Someone else changed the style while this page holds unsaved work. */
  changed: { at: string } | null
  /** The thread beside the tab (Owner O1, ⌘J, 1280 px and wider). */
  dockOpen: boolean
  /** Design cases: the record panels drawn from made-up data. */
  panelsPreview?: RecordPanelsViewModel
  /** Design cases: the identity form already being edited. */
  identityDraft?: StylePatch
  /** Design cases: the range card already being edited. */
  rangeDraft?: { sizeScaleId: string; sizes: string[]; baseSize: string | null }
  /** Design cases: a BOM line already chosen in the add dialog. */
  lineDraft?: { material: MaterialView }
}

export interface StyleRecordActions {
  onRetry?: () => void
  onReload?: () => void
  onDock?: () => void
  onDialog?: (dialog: StyleDialog | null) => void
  onDismissNotice?: () => void
  onRevision?: (revisionId: string) => void
  // identity and range
  onSaveIdentity?: (patch: StylePatch) => Promise<boolean>
  onSaveRange?: (range: { sizeScaleId: string; sizes: string[]; baseSize: string | null }) => Promise<boolean>
  // colourways and SKUs
  onColourway?: (input: ColourwayInput, colourwayId: string | null) => Promise<boolean>
  onColourwayStatus?: (colourwayId: string, status: 'ACTIVE' | 'ARCHIVED') => void
  onGenerate?: () => Promise<boolean>
  onSkus?: (changes: Array<{ skuId: string; version: number; status?: 'ACTIVE' | 'ARCHIVED'; gtin?: string | null }>) => Promise<boolean>
  // revisions and the style's life
  onRelease?: (changeNote: string) => Promise<boolean>
  onStartRevision?: (changeNote: string) => Promise<boolean>
  onAbandon?: (reason: string) => Promise<boolean>
  onArchive?: (reason: string) => Promise<boolean>
  onReactivate?: () => void
  // BOM
  onBomView?: (view: BomViewMode) => void
  onMaterialQuery?: (query: string) => void
  onLoadMaterial?: (itemId: string) => void
  onAddLine?: (input: BomLineInput & { itemId: string }) => Promise<boolean>
  onEditLine?: (lineId: string, input: BomLineInput) => Promise<boolean>
  onRemoveLine?: (lineId: string) => Promise<boolean>
  onLineSizes?: (lineId: string, sizes: Array<{ size: string; qty: string | null }>) => void
  onLineColours?: (lineId: string, colours: Array<{ colourwayId: string; itemColourId: string | null }>) => void
  onHideYield?: (pct: string | null) => Promise<boolean>
  // routing
  onOperationQuery?: (query: string, kind: string | null) => void
  onAddSteps?: (operationIds: string[]) => Promise<boolean>
  onStep?: (stepId: string, patch: { standardMinutes?: string; scanRequired?: boolean; instructions?: string | null }) => Promise<boolean>
  onRemoveStep?: (stepId: string) => Promise<boolean>
  onMoveStep?: (stepId: string, delta: -1 | 1) => void
  // cost
  onCostCell?: (cell: { colourwayId: string; size: string }) => void
  // compliance
  onUpload?: (input: { kind: 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'; language: string; number: string | null; file: File }) => Promise<boolean>
  onDownload?: (documentId: string, fileId: string) => void
  onAssignLabel?: (templateId: string | null) => Promise<boolean>
  onGarmentTracking?: (tracking: StyleView['garmentTracking']) => Promise<boolean>
}
