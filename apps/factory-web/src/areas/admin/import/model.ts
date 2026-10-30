import type { Loaded } from '../shared/model'
import type { FirstLoadModel } from './guided/model'
import { reachOf, type BulkNotice, type Reach } from '../kit/bulk-model'
import { IMPORT_MAX_BYTES, layoutSchema, type ImportJob, type Importer, type ImportRow, type Layout, type NumberFormat } from './api'

/**
 * SCR-017 Import & export (design 02 admin.import; PLT-176, PLT-177, SCM-288; 00 §3.13, DS gap D14 ImportFlow): start
 * from the thing ("what do you want to load?"), never from the file; one flow for every importer — upload → dry run
 * (new, changed, unchanged, refused with the reasons; nothing is written) → apply what was seen (rows changed since the
 * dry run are skipped, never overwritten) → the result with the refused rows to download. Pure: the tests hold every
 * rule; ImportPage.tsx reads the API, the views draw this.
 */

/** The importers this web has its own words for (factory-domain *importer.ts keys). Another key shows the API's label. */
export const KNOWN_IMPORTERS = ['product.materials', 'parties.parties', 'inventory.locations', 'inventory.opening', 'product.bom', 'product.operations'] as const

/** The message stem of an importer's words (`inventory.opening` → its `inventory_opening` words). */
export const importerStem = (key: string) => `imp.importer.${key.replace(/\./g, '_')}`
export const hasOwnWords = (key: string) => (KNOWN_IMPORTERS as readonly string[]).includes(key)

/**
 * Every importer's template (B-W2a-41, PLT-177: `GET /imports/importers/:importerKey/template`, served for each importer
 * the person may use; its money columns only with their grain) as a plain link through this app's `/api` (a GET: the
 * session cookie, no header needed), in the number format the sheet will be read in.
 */
export function templateHref(importerKey: string, format: 'csv' | 'xlsx', numberFormat: NumberFormat): string {
  return `/api/imports/importers/${encodeURIComponent(importerKey)}/template?${new URLSearchParams({ format, numberFormat }).toString()}`
}

/** The refused rows of a job as a CSV, a plain link. */
export const refusedRowsHref = (jobId: string) => `/api/imports/${encodeURIComponent(jobId)}/errors`

/** The wizard's four steps (Stepper). */
export const WIZARD_STEPS = ['upload', 'check', 'apply', 'result'] as const
export type WizardStep = (typeof WIZARD_STEPS)[number]

/**
 * Where a job is, in the person's terms:
 *   reading     the worker is reading the sheet (UPLOADED)
 *   planned     the dry run is ready to review (PLANNED)
 *   planFailed  the sheet could not be read or planned (FAILED before a plan): upload a corrected sheet
 *   applying    the planned rows are being written (APPLYING)
 *   applyFailed the apply stopped (FAILED after a plan): earlier batches stay, "Apply again" resumes
 *   applied     done (APPLIED)
 *   cancelled   cancelled (nothing more is written)
 */
export type Phase = 'reading' | 'planned' | 'planFailed' | 'applying' | 'applyFailed' | 'applied' | 'cancelled'

export function phaseOf(job: Pick<ImportJob, 'status' | 'plannedAt'>): Phase {
  switch (job.status) {
    case 'UPLOADED':
      return 'reading'
    case 'PLANNED':
      return 'planned'
    case 'APPLYING':
      return 'applying'
    case 'APPLIED':
      return 'applied'
    case 'CANCELLED':
      return 'cancelled'
    case 'FAILED':
      return job.plannedAt ? 'applyFailed' : 'planFailed'
  }
}

/** The Stepper's step for a job (none yet: upload). A cancelled job stays at the step it was cancelled in. */
export function stepOf(job: Pick<ImportJob, 'status' | 'plannedAt'> | null): WizardStep {
  if (!job) return 'upload'
  const phase = phaseOf(job)
  if (phase === 'reading' || phase === 'planned' || phase === 'planFailed') return 'check'
  if (phase === 'applying' || phase === 'applyFailed') return 'apply'
  if (phase === 'cancelled') return job.plannedAt ? 'apply' : 'check'
  return 'result'
}

/** The job is moving on the server: ask again every POLL_MS (no live event reaches this page yet). */
export const isMoving = (job: Pick<ImportJob, 'status'> | null) => job?.status === 'UPLOADED' || job?.status === 'APPLYING'
export const POLL_MS = 2000

/** The rows an apply would write: new and changed. */
export const applicable = (job: Pick<ImportJob, 'createCount' | 'updateCount'>) => job.createCount + job.updateCount

/** May be cancelled (the API's machine: UPLOADED, PLANNED, APPLYING, FAILED). */
export const mayCancel = (job: Pick<ImportJob, 'status'>) => job.status !== 'APPLIED' && job.status !== 'CANCELLED'

/**
 * "Cancel N imports" (bulk) applies to the selected jobs nothing was written from yet: the sheet being read, or the
 * dry run waiting to be applied. A job being applied, one that stopped (open it: apply again or cancel it alone), and
 * one applied or cancelled already are left out with the reason. Each is one `POST /imports/:id/cancel` with its version.
 */
export function cancelReach(jobs: readonly ImportJob[]): Reach<ImportJob> {
  return reachOf(jobs, (job) => {
    const phase = phaseOf(job)
    return phase === 'reading' || phase === 'planned' ? null : `imp.bulk.left.${phase}`
  })
}

export interface ImportRights {
  view: boolean
  /** imports.run and files.upload (the sheet is a file upload). */
  run: boolean
  apply: boolean
  /** users.view: the list names who started each import. */
  people: boolean
}

/** Why Apply is held (a message key of `admin-import`), or null when it may run. */
export function applyHeld(job: Pick<ImportJob, 'status' | 'plannedAt' | 'createCount' | 'updateCount'>, can: Pick<ImportRights, 'apply'>, busy = false): string | null {
  const phase = phaseOf(job)
  if (phase !== 'planned' && phase !== 'applyFailed') return 'imp.held.notPlanned'
  if (!can.apply) return 'imp.held.noApplyRight'
  if (applicable(job) === 0) return 'imp.held.nothing'
  if (busy) return 'imp.held.busy'
  return null
}

/** The rows an apply of a failed job still writes (earlier batches stay applied). */
export const leftToApply = (job: Pick<ImportJob, 'createCount' | 'updateCount' | 'appliedCount' | 'skippedCount'>) =>
  Math.max(0, applicable(job) - job.appliedCount - job.skippedCount)

/** The dry run's layout, or null (not read yet, or a shape this web does not know). */
export function layoutOf(job: Pick<ImportJob, 'layout'>): Layout | null {
  const parsed = layoutSchema.safeParse(job.layout)
  return parsed.success ? parsed.data : null
}

/** A money column the person may not import (`column/<name>` issues that name a grain): those are said apart. */
export function issueGroups(job: Pick<ImportJob, 'issues'>): { money: string[]; other: Array<{ path: string; message: string }> } {
  const money: string[] = []
  const other: Array<{ path: string; message: string }> = []
  for (const item of job.issues ?? []) {
    if (/^column\//.test(item.path) && /money grain/.test(item.message)) money.push(item.path.slice('column/'.length))
    else other.push(item)
  }
  return { money, other }
}

/** The sheet's own header of an importer column (the person's words), else the column's name. */
export function headerOf(layout: Layout | null, column: string): string {
  return layout?.columns.find((item) => item.column === column)?.header ?? column
}

/** A cell value as text ('—' for none; a list or object compact). */
export function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** The changes of a planned row: each column with its value now (UPDATE) and the sheet's. */
export function rowChanges(row: Pick<ImportRow, 'action' | 'before' | 'after'>, layout: Layout | null): Array<{ column: string; header: string; before: string | null; after: string }> {
  const after = row.after && typeof row.after === 'object' && !Array.isArray(row.after) ? (row.after as Record<string, unknown>) : {}
  const before = row.before && typeof row.before === 'object' && !Array.isArray(row.before) ? (row.before as Record<string, unknown>) : {}
  return Object.keys(after).map((column) => ({
    column,
    header: headerOf(layout, column),
    before: row.action === 'UPDATE' ? valueText(before[column]) : null,
    after: valueText(after[column]),
  }))
}

/** A row's key, from the API's JSON array of the key columns' values: "CS-0001" or "DN1 · A-01". */
export function keyText(key: string | null): string {
  if (!key) return '—'
  try {
    const values = JSON.parse(key) as unknown
    if (Array.isArray(values)) return values.map((value) => valueText(value)).join(' · ')
  } catch {
    // Not JSON: shown as it is.
  }
  return key
}

/** The newest job of an importer (the cards' "last import"). */
export function lastImportOf(jobs: readonly ImportJob[], importerKey: string): ImportJob | null {
  return jobs.filter((job) => job.importerKey === importerKey).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

// ---- the upload step ----

export interface UploadDraft {
  importerKey: string
  companyId: string
  numberFormat: NumberFormat
  sheetName: string
  /** The chosen file (its bytes stay in the container). */
  file: { name: string; size: number } | null
}

export const blankDraft = (importerKey = '', companyId = '', numberFormat: NumberFormat = 'it'): UploadDraft => ({ importerKey, companyId, numberFormat, sheetName: '', file: null })

/** The upload step's problems, field → message key. Every importer writes one company's records (B-W1-35, parties). */
export function uploadProblems(draft: UploadDraft): Partial<Record<'importerKey' | 'companyId' | 'file', string>> {
  const problems: Partial<Record<'importerKey' | 'companyId' | 'file', string>> = {}
  if (!draft.importerKey) problems.importerKey = 'imp.problem.importer'
  if (!draft.companyId) problems.companyId = 'imp.problem.company'
  if (!draft.file) problems.file = 'imp.problem.noFile'
  else if (!/\.(csv|xlsx)$/i.test(draft.file.name)) problems.file = 'imp.problem.fileType'
  else if (draft.file.size > IMPORT_MAX_BYTES) problems.file = 'imp.problem.fileSize'
  else if (draft.file.size === 0) problems.file = 'imp.problem.fileEmpty'
  return problems
}

/** "1.234,50" or "1,234.50": how the sheet writes numbers. */
export const NUMBER_SAMPLES: Readonly<Record<NumberFormat, string>> = { it: '1.234,50', en: '1,234.50' }

// ---- the page ----

/** The wizard, open on an importer (a new upload) or on a job. */
export interface WizardModel {
  draft: UploadDraft
  /** The job this wizard follows; null while uploading. */
  job: ImportJob | null
  /** The dry run's rows to review: refused ones, and new and changed ones (first page each). */
  refused: Loaded<ImportRow>
  changes: Loaded<ImportRow>
  /** The result's rows skipped as changed since the dry run. */
  skipped: Loaded<ImportRow>
  busy: boolean
  problem: string | null
  /** The cancel confirm is open. */
  confirmCancel: boolean
}

export interface ImportViewModel {
  /** `/w/<company>`. */
  prefix: string
  can: ImportRights
  importers: Loaded<Importer>
  jobs: Loaded<ImportJob>
  companies: ReadonlyArray<{ id: string; name: string }>
  /** Office people by id (users.view), for "who". */
  people: Readonly<Record<string, string>>
  asOf: string | null
  wizard: WizardModel | null
  /** The jobs ticked in Recent imports (ids). */
  selected?: readonly string[]
  /** "Cancel N imports" asked for these jobs (the bulk confirm is open). */
  cancelMany?: readonly string[] | null
  /** The bulk cancel is running. */
  bulkBusy?: boolean
  notice?: BulkNotice | null
  /** The guided first load of a company (B-W2a-41); absent: not read for this page (no company). */
  firstLoad?: FirstLoadModel | null
  /** The Templates dialog (the page's More menu) is open. */
  templatesOpen?: boolean
}

export const RECENT_LIMIT = 50

export const emptyWizard = (draft: UploadDraft, job: ImportJob | null = null): WizardModel => ({
  draft,
  job,
  refused: { items: null, problem: null },
  changes: { items: null, problem: null },
  skipped: { items: null, problem: null },
  busy: false,
  problem: null,
  confirmCancel: false,
})
