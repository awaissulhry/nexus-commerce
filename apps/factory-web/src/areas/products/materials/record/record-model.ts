import type { Lot } from '../../../quality/_shared/lots'
import type { SupplierPricesModel } from '../../../purchasing/suppliers/sources/model'
import type { LibraryCan, Notice, Read, WriteProblem } from '../../library/model'
import type { ColourInput, CoveringCertificate, LibraryColour, MaterialColour, MaterialPatch, MaterialStock, MaterialView, SupplierRow } from '../api'
import type { MaterialTab } from '../model'
import type { GradesActions, GradesModel } from './grades/grades-model'
import type { MaterialDepthActions, MaterialDepthModel } from '../approval/depth-model'

/** A record read: loading, the material, or why there is none. */
export type MaterialLoad =
  | { status: 'loading' }
  | { status: 'ready'; value: MaterialView }
  | { status: 'error'; problem: string }
  | { status: 'notFound' }
  | { status: 'forbidden' }

export type MaterialDialog =
  | { kind: 'colour'; colourId: string | null }
  | { kind: 'archive' }
  | { kind: 'help' }

export interface MaterialRecordViewModel {
  prefix: string
  can: LibraryCan
  tab: MaterialTab
  material: MaterialLoad
  /** The colour library (a material colour names the one it matches); null while it loads or for a person without it. */
  libraryColours: LibraryColour[] | null
  /** The certificates that cover it (an EN 1621 protector): null when the person cannot read them. */
  certificates: Read<CoveringCertificate[]> | null
  /** Its lots among the newest read, with their Cr VI results: null without quality.lots.view. */
  lots: Read<{ lots: Lot[]; capped: boolean }> | null
  /** Its stock by location, lot and hide: null without inventory.stock.view. */
  stock: Read<MaterialStock> | null
  /** The supplier search of the default supplier card. */
  suppliers: { q: string; results: SupplierRow[] | null } | null
  save: { state: 'idle' | 'saving' | 'failed'; at: string | null }
  busy: boolean
  notice: Notice | null
  /** Someone else changed it meanwhile (live): Reload. */
  changed: { at: string } | null
  dialog: MaterialDialog | null
  /** The last refused write's fields (for a form to point at). */
  refused: WriteProblem | null
  /** B-W2a-69: Purchasing's approved sources of this material (Suppliers & prices › Supplier prices, read only). */
  supplierPrices?: SupplierPricesModel
  /** B-W2b-131: Properties & grades › Grades and usable area of a leather (idle for any other kind). */
  grades?: GradesModel
  /** B-W2b-238: the properties of its kind and its fibres, its approval, where it is used (idle while their tab is not shown). */
  depth?: MaterialDepthModel
}

export interface MaterialRecordActions {
  onRetry?: () => void
  onReload?: () => void
  /** A change of the material's fields; resolves true when saved. */
  onSave?: (patch: MaterialPatch) => Promise<boolean>
  onSetCost?: (cost: string | null, reason: string) => Promise<boolean>
  onArchive?: (reason: string) => Promise<boolean>
  onReactivate?: () => void
  onAddColour?: (colour: ColourInput) => Promise<boolean>
  onUpdateColour?: (colour: MaterialColour, patch: Partial<ColourInput> & { status?: 'ACTIVE' | 'ARCHIVED' }) => Promise<boolean>
  onColoursStatus?: (ids: string[], status: 'ACTIVE' | 'ARCHIVED') => Promise<boolean>
  onSupplierSearch?: (q: string) => void
  onDialog?: (dialog: MaterialDialog | null) => void
  onDismissNotice?: () => void
  /** B-W2a-69: read the Supplier prices again after a failed read. */
  onRetrySupplierPrices?: () => void
  /** B-W2b-131: the Grades and usable area section's cells and row moves. */
  grades?: GradesActions
  /** B-W2b-238: a decision on the approval, the properties of its kind, Where used's colour and export. */
  depth?: MaterialDepthActions
}
