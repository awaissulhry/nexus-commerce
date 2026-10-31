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
}

export const ListToolsContext = createContext<ListToolsTransport | null>(null)

/** The list tools of this page, or null (no Columns ▾, no Export ▾). */
export function useListToolsTransport(): ListToolsTransport | null {
  return useContext(ListToolsContext)
}
