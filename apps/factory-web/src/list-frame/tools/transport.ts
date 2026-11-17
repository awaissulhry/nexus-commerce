import { createContext, useContext } from 'react'
import type { ExportFormat, ExportStatus } from '@nexus/factory-domain/views/exports'
import type { ViewAudience } from '@nexus/factory-domain/views/rules'
import type { ColumnLayout, Density, ViewState } from '@nexus/factory-domain/views/state'
import type { BulkApplyRow, BulkPreviewRow, BulkResult, BulkValue } from '@nexus/factory-domain/views/bulk/rules'

/**
 * The list tools' seam (B-W2a-23; design shell.lists toolbar "Columns ▾ · Export ▾", pop:customise, pop:save-view,
 * pop:export-job): everything the ONE list frame needs from outside to save views and export a list — the page's
 * address, the API, the clipboard, this browser's working layout. The Office mounts the real one once for every list
 * (areas/_shared/list-tools ListToolsProvider, in the Office shell); a design case mounts made-up data. Without one (a
 * Floor or a Links page, a test) the frame draws no Columns ▾ and no Export ▾, and every list works as before.
 */

export interface SavedView {
  readonly id: string
  readonly listKey: string
  readonly name: string
  readonly ownerId: string
  readonly ownerName: string
  readonly mine: boolean
  readonly audience: ViewAudience
  readonly roleId: string | null
  readonly roleName: string | null
  readonly roleDefault: boolean
  /** B-W2b-24: my own default view of the list (only ever a view of mine; the list opens on it before a role default). */
  readonly personalDefault: boolean
  readonly state: ViewState
  /** Why the reader may not change or remove it, in the API's words (the screen says its own). Null: they may. */
  readonly changeHeld: string | null
  readonly version: number
}

export interface RoleRef {
  readonly id: string
  readonly name: string
}

export interface ViewsAnswer {
  readonly views: readonly SavedView[]
  readonly roleDefaultId: string | null
  /** B-W2b-24: my own default view of the list, or null. */
  readonly personalDefaultId: string | null
  readonly roles: readonly RoleRef[]
  readonly allRoles: readonly RoleRef[]
  readonly can: { readonly save: boolean; readonly manage: boolean; readonly export: boolean }
  readonly exports: { readonly formats: readonly ExportFormat[] } | null
}

export interface ExportColumn {
  readonly key: string
  readonly label: string
}

export interface ExportJob {
  readonly id: string
  readonly listKey: string
  readonly format: ExportFormat
  readonly status: ExportStatus
  readonly title: string
  readonly viewName: string | null
  readonly columns: readonly ExportColumn[]
  readonly omitted: readonly ExportColumn[]
  readonly rowsDone: number
  readonly rowCount: number | null
  readonly failureReason: string | null
  readonly file: { readonly id: string; readonly name: string; readonly sizeBytes: number } | null
  readonly createdAt: string
  readonly startedAt: string | null
  readonly finishedAt: string | null
  readonly expiresAt: string | null
  /** B-W2b-13: how many selected rows were asked (the selection row's Export N); null: the whole view. */
  readonly selected?: number | null
}

/** A view as the Save view dialog sends it. */
export interface ViewDraft {
  readonly name: string
  readonly audience: ViewAudience
  readonly roleId: string | null
  readonly roleDefault: boolean
  readonly state: ViewState
}

export interface ExportAsk {
  readonly listKey: string
  readonly format: ExportFormat
  readonly query: string
  readonly columns: readonly ExportColumn[]
  readonly title: string
  readonly viewName?: string
  /** B-W2b-13 (Z16:02): only these rows of the view (the selection row's Export N). */
  readonly ids?: readonly string[]
}

/** B-W2b-13 (PLT-182, PLT-166): a bulk edit's preview (old → new per row, or why not). */
export interface BulkPreviewAsk {
  readonly listKey: string
  readonly ids: readonly string[]
  readonly changes: Readonly<Record<string, BulkValue>>
}

/** The rows a bulk edit (or a cell edited in the grid, or Undo) writes, each with the version the person saw. */
export interface BulkApplyAsk {
  readonly listKey: string
  readonly rows: readonly BulkApplyRow[]
  readonly undo?: boolean
}

/** What went wrong, as the tools say it (their own words: `lists` tools.problem.<key>). */
export type ToolsProblem = 'nameTaken' | 'tooMany' | 'busy' | 'stale' | 'forbidden' | 'notFound' | 'invalid' | 'sharing' | 'offline' | 'failed'

export class ToolsError extends Error {
  override name = 'ToolsError'
  constructor(readonly problem: ToolsProblem) {
    super(problem)
  }
}

export const problemOf = (error: unknown): ToolsProblem => (error instanceof ToolsError ? error.problem : 'failed')

/** The layout a person works with before (or without) saving a view: kept in this browser, per list. */
export interface WorkingLayout {
  readonly columns?: ColumnLayout
  readonly density?: Density
  /** The saved view it started from, if any. */
  readonly viewId?: string | null
}

/** A design case's starting state (the gallery shows a menu or a dialog open). */
export interface ToolsDesignState {
  readonly menu?: 'columns' | 'export'
  readonly dialog?: 'customise' | 'save' | 'edit' | 'remove' | 'job'
  readonly activeViewId?: string
  /** The job the export dialog shows (it is not asked for again: the gallery holds its state still). */
  readonly job?: ExportJob
}

export interface ListToolsTransport {
  /** The page's list key (its Office address with dots), or null on a record page. */
  readonly pageKey: string | null
  /** The address terms a view keeps (factory-domain views/state viewQuery). */
  readonly query: string
  /** A shared link's `?savedView=` and the e-mail's `?export=`. */
  readonly linked: { readonly view: string | null; readonly export: string | null }
  /** Puts a view's terms in the address (the list reads them as it always does); drops the link terms. */
  goTo(query: string): void
  /** Drops the link terms from the address, once they were opened. */
  clearLinked(): void
  /** The address of the list opening a saved view (Copy link). */
  viewLink(viewId: string): string
  readonly locale: 'it' | 'en'
  listViews(listKey: string): Promise<ViewsAnswer>
  createView(listKey: string, draft: ViewDraft, idempotencyKey: string): Promise<SavedView>
  updateView(view: SavedView, change: Partial<ViewDraft>, idempotencyKey: string): Promise<SavedView>
  removeView(view: SavedView): Promise<void>
  /** B-W2b-24: makes my own view my default of its list (on) or no longer (off); the old default loses its mark. */
  setPersonalDefault(view: SavedView, on: boolean, idempotencyKey: string): Promise<{ readonly view: SavedView; readonly personalDefaultId: string | null }>
  startExport(ask: ExportAsk, idempotencyKey: string): Promise<ExportJob>
  readExport(jobId: string): Promise<ExportJob>
  listExports(listKey: string): Promise<readonly ExportJob[]>
  /** Opens the finished file (a presigned download). */
  download(job: ExportJob): Promise<void>
  copy(text: string): Promise<boolean>
  readLayout(listKey: string): WorkingLayout | null
  writeLayout(listKey: string, layout: WorkingLayout | null): void
  /** A fresh Idempotency-Key. */
  newKey(): string
  /** Design only: where the gallery starts. */
  readonly design?: ToolsDesignState
  /** B-W2b-13: a bulk edit's preview, read as the rows are now (platform/views/bulk). */
  bulkPreview(ask: BulkPreviewAsk): Promise<readonly BulkPreviewRow[]>
  /** B-W2b-13: writes the rows through each record's own command (a bulk edit, a cell, Undo). */
  bulkApply(ask: BulkApplyAsk, idempotencyKey: string): Promise<readonly BulkResult[]>
  /** B-W2b-388: Pin to Today (absent: the menu has no such item). */
  readonly pins?: ListPins
  /** B-TH-241: the custom fields a list frame draws as columns (absent: no custom columns). */
  readonly fields?: ListFieldsTransport
}

// ── B-TH-241 (threads plan TH-4, SHEET-G04; features SHEET.brand-fields-F02, -F05): custom columns in the list frame ──
/**
 * A custom field as a list frame draws it (apps/factory-api platform/fields `fieldView`: `GET /fields`). Its column id is the
 * API's (`cf:<code>`, a money field `cf:<grain>:<code>`), so the export engine writes it and leaves a money one out for a person
 * without its grain. `partyId` (B-TH-056): a field for one customer only (null: every customer).
 */
export interface ListField {
  readonly code: string
  readonly columnId: string
  readonly type: string
  readonly labelIt: string
  readonly labelEn: string
  readonly unit: string | null
  readonly companyId: string | null
  readonly partyId: string | null
  /** A select's values (code → label), deactivated ones too (a record may hold one). */
  readonly options: ReadonlyArray<{ readonly code: string; readonly labelIt: string; readonly labelEn: string; readonly active: boolean }>
}

/** One record's value of one field (`POST /fields/rows/:recordType`): the stored value and its words (a select's label, a name). */
export interface ListFieldValue {
  readonly value: unknown
  readonly wordsIt: string | null
  readonly wordsEn: string | null
}

/** Whose fields a list reads: a company's (and every company's), and one customer's (and every customer's). */
export interface ListFieldScope {
  readonly companyId?: string | null
  readonly partyId?: string | null
}

export interface ListFieldsTransport {
  /** The fields this person sees of a record type, in the scope (`GET /fields?recordType=&companyId=&partyId=`). */
  read(recordType: string, scope: ListFieldScope): Promise<readonly ListField[]>
  /**
   * The values of these records (at most 200 ids), by record id then field code; a record the person may not see is left out
   * (`POST /fields/rows/:recordType`). A field for one customer has values only on that customer's records (the API's rule).
   */
  rows(recordType: string, ids: readonly string[]): Promise<ReadonlyMap<string, Readonly<Record<string, ListFieldValue>>>>
}
// ── end B-TH-241 ──

/** B-W2b-388 (PLT-163, design home.today `my-views` "Pin a view from any list with Columns ▾ › Pin to Today"): a view pinned to
 * Today is followed (PLT-151): My saved views shows its count, and a change tells me. */
export interface ListPins {
  /** The views I pinned, by id. */
  list(): Promise<readonly string[]>
  /** Pin or unpin one: `notFollowable` when the list has no count to follow, `tooMany` at the limit. */
  set(viewId: string, pinned: boolean): Promise<'ok' | 'notFollowable' | 'tooMany'>
}

export const ListToolsContext = createContext<ListToolsTransport | null>(null)

/** The list tools of this page, or null (no Columns ▾, no Export ▾). */
export function useListToolsTransport(): ListToolsTransport | null {
  return useContext(ListToolsContext)
}
