import type { SheetImportChange, SheetImportFormat, SheetImportStatus } from '@nexus/shared/catalog-transfer'

/** PSIE — the Import dialog's words, as pure functions: one place for every sentence the user reads. */

export const IMPORT_ACCEPT = '.xlsx,.xlsm,.csv,.zip'
/** The server's own limit for one upload (`PRODUCT_TRANSFER_MAX_BYTES`). */
export const IMPORT_MAX_BYTES = 50 * 1024 * 1024

const FORMATS: Record<SheetImportFormat, string> = {
  nexus: 'Nexus file', 'nexus-legacy': 'Older Nexus file', amazon: 'Amazon template', ebay: 'eBay file', shopify: 'Shopify file', csv: 'CSV file', undo: 'Undo',
}
export const formatLabel = (format: SheetImportFormat) => FORMATS[format] ?? 'File'
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`

/** "Nexus file · 20 products · 20 listings · Shared, Amazon · IT" */
export function summaryLine(status: Pick<SheetImportStatus, 'format' | 'summary' | 'destinations'>): string {
  const { summary } = status
  return [formatLabel(status.format), summary.products ? plural(summary.products, 'product') : '', summary.listings ? plural(summary.listings, 'listing') : '',
    status.destinations.join(', ')].filter(Boolean).join(' · ')
}

/** The one primary button while the check is on screen. `null` = nothing can be saved. */
export function applyLabel(status: Pick<SheetImportStatus, 'summary' | 'total'>): string | null {
  if (!status.total || !status.summary.changes) return null
  const apply = `Apply ${plural(status.summary.changes, 'change')}`
  return status.summary.problems ? `${apply}, skip ${plural(status.summary.problems, 'problem')}` : apply
}

export interface DoneView { tone: 'success' | 'warning' | 'danger'; title: string; body: string }
/** What the finished import says. Always states that nothing went to a channel (the Owner's D1 (a)). */
export function doneView(status: Pick<SheetImportStatus, 'state' | 'receipt' | 'format' | 'error'>): DoneView {
  const saved = status.receipt?.saved ?? 0, failed = status.receipt?.failed ?? 0, skipped = status.receipt?.skipped ?? 0
  const undo = status.format === 'undo'
  const channels = 'Nothing was sent to the channels.'
  if (status.state === 'FAILED') return { tone: 'danger', title: undo ? 'The undo failed' : 'The import failed', body: status.error ?? 'Nothing was saved. Try again, or drop another file.' }
  if (status.state === 'PARTIAL') return { tone: 'warning', title: `${plural(saved, 'record')} saved, ${plural(failed, 'record')} not saved`,
    body: `The records not saved changed in Nexus while you were importing. Their reasons are listed below. ${channels}` }
  return { tone: 'success', title: undo ? 'Import undone' : `${plural(saved, 'record')} saved in Nexus`,
    body: undo ? `Every value this import changed is back. ${channels}` : `${skipped ? `${plural(skipped, 'record')} with problems ${skipped === 1 ? 'was' : 'were'} skipped. ` : ''}${channels} Publish from the product when you are ready.` }
}

/** A cell value for people: empty is a dash, lists are joined, a measure reads "1.2 kilograms". */
export function displayValue(value: unknown, max = 120): string {
  if (value === null || value === undefined || value === '' || Array.isArray(value) && !value.length) return '—'
  let text: string
  if (typeof value === 'string') text = value
  else if (Array.isArray(value)) text = value.map(v => displayValue(v, max)).join(' · ')
  else if (typeof value === 'object' && value && 'value' in value && Object.keys(value).every(k => ['value', 'unit'].includes(k))) text = `${String((value as { value: unknown }).value)} ${String((value as { unit?: unknown }).unit ?? '')}`.trim()
  else text = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * Two long texts that differ only near the end read the same in a clipped cell. Start both a little before the first
 * difference ("…Livello 2 (2026)"), so the change is what the eye lands on. Short or unrelated texts are left whole.
 */
export function focusChange(before: string, after: string, lead = 24): [string, string] {
  let i = 0
  while (i < before.length && i < after.length && before[i] === after[i]) i++
  if (i <= lead + 8) return [before, after]
  const start = before.lastIndexOf(' ', i - lead) + 1 || i - lead
  return [`…${before.slice(start)}`, `…${after.slice(start)}`]
}

/** "follows Shared" reads better than a dash for a cell that inherits. */
export function cellValue(change: Pick<SheetImportChange, 'before' | 'after' | 'beforeState' | 'afterState'>, side: 'before' | 'after', max = 120): string {
  const state = side === 'before' ? change.beforeState : change.afterState
  const value = side === 'before' ? change.before : change.after
  if (state === 'inherited') return value === null || value === undefined || value === '' ? 'Follows Shared' : `Follows Shared (${displayValue(value, 60)})`
  return displayValue(value, max)
}

/** The two table cells of a change: full texts, started just before their first difference (the cell clips the rest). */
export function changeCells(change: Pick<SheetImportChange, 'before' | 'after' | 'beforeState' | 'afterState'>): [string, string] {
  return focusChange(cellValue(change, 'before', 4000), cellValue(change, 'after', 4000))
}

export const STATUS_LABELS: Record<SheetImportChange['status'], string> = { ready: 'Ready', new: 'New', problem: 'Problem', saved: 'Saved', failed: 'Not saved', skipped: 'Skipped' }

/** Where in the file a problem is: "Amazon IT · row 14 · column F". */
export function whereInFile(change: Pick<SheetImportChange, 'sheet' | 'row' | 'column'>): string {
  return [change.sheet, change.row ? `row ${change.row}` : '', change.column ? `column ${change.column}` : ''].filter(Boolean).join(' · ')
}

/** Still working: poll. */
export const isBusy = (status: Pick<SheetImportStatus, 'state'> | null) => !!status && ['CHECKING', 'SAVING'].includes(status.state)
export const isFinished = (status: Pick<SheetImportStatus, 'state'> | null) => !!status && ['DONE', 'PARTIAL', 'FAILED'].includes(status.state)
