/**
 * Publish history — what the LIST's columns say (sheet publish parity, step 4; docs/sheet-publish-parity/PLAN.md).
 * Pure, so the grid, the screen-reader names and the tests share one rule. The pill, the destination, the change
 * and the source words come from `runActions.ts` — the drawer's file — so a run reads the same in the list and in its
 * detail.
 */
import type { HistoryCounts, HistoryRun } from '@nexus/shared/publication-history'
import { formatElapsed } from '@/design-system/lib'
import { publishFullTime } from '@/design-system/grid'
import { runDestination, runStatusMeta } from './runActions'

export type RunColumnKey = 'status' | 'started' | 'product' | 'destination' | 'change' | 'results' | 'source' | 'by' | 'duration' | 'reference'

/**
 * The columns, by scope and width. The scope decides: a product's own list has no Product column (the product is
 * the page). A phone shows only what answers "what happened, where, when". The channel reference is long and rarely
 * read: on a desktop it is a column that starts HIDDEN (`defaultHidden`) and can be switched on in Customise; the
 * detail always shows it with a copy button.
 */
export function runColumnKeys(scope: 'business' | 'product', layout: 'desktop' | 'phone'): RunColumnKey[] {
  if (layout === 'phone') return ['status', 'destination', 'started']
  const all: RunColumnKey[] = ['status', 'started', 'product', 'destination', 'change', 'results', 'source', 'by', 'duration', 'reference']
  return scope === 'product' ? all.filter(key => key !== 'product') : all
}

/** Counts in reading order. A zero part is not shown: "21 accepted · 2 failed", never "0 waiting". */
const COUNT_WORDS: ReadonlyArray<[keyof HistoryCounts, string]> = [
  ['verified', 'verified'], ['accepted', 'accepted'], ['failed', 'failed'], ['notSent', 'not sent'],
  ['waiting', 'waiting'], ['unknown', 'unknown'], ['skipped', 'skipped'],
]

export function resultsParts(counts: HistoryCounts): string[] {
  return COUNT_WORDS.filter(([key]) => counts[key] > 0).map(([key, word]) => `${counts[key]} ${word}`)
}

/** "21 accepted · 2 failed · 1 waiting"; "—" when the run names no product. */
export function resultsText(counts: HistoryCounts): string {
  const parts = resultsParts(counts)
  return parts.length ? parts.join(' · ') : '—'
}

/** How long the run took, for a finished run only ("1 min 4 s"); empty while it has no result. */
export function durationText(run: Pick<HistoryRun, 'startedAt' | 'finishedAt'>): string {
  if (!run.finishedAt) return ''
  const ms = Date.parse(run.finishedAt) - Date.parse(run.startedAt)
  return Number.isFinite(ms) ? formatElapsed(ms) : ''
}

/** "Xavia Racing", "Xavia Racing · Second listing" — the account and alias line under the destination. */
export function accountLine(run: Pick<HistoryRun, 'accountLabel' | 'aliasLabel'>): string {
  return [run.accountLabel, run.aliasLabel].filter((part): part is string => !!part && !!part.trim()).join(' · ')
}

/** The person, or the honest "Not recorded" (the older pages kept no name). */
export function byText(run: Pick<HistoryRun, 'userName'>): string {
  return run.userName?.trim() || 'Not recorded'
}

/** The product a business-wide row is about; a run that named several families has none. */
export function productText(run: Pick<HistoryRun, 'familySku' | 'familyTitle'>): { sku: string; title: string | null } {
  return run.familySku ? { sku: run.familySku, title: run.familyTitle } : { sku: 'Several products', title: null }
}

/** "Result unknown · checked by Dev Owner" — the second line of a run a person marked as checked. */
export function checkedLine(run: Pick<HistoryRun, 'checkedAt' | 'checkedBy'>): string | null {
  if (!run.checkedAt) return null
  return run.checkedBy ? `Checked by ${run.checkedBy}` : 'Marked as checked'
}

/**
 * The row's whole name for a screen reader: "Partly failed, eBay IT, Xavia Racing, 2 failed of 23, started 1 Oct,
 * 22:20". The words carry everything the colours do.
 */
export function rowAriaLabel(run: HistoryRun, now: number = Date.now()): string {
  const meta = runStatusMeta(run)
  const parts = [meta.label, runDestination(run)]
  const account = accountLine(run)
  if (account) parts.push(account)
  const bad = run.counts.failed + run.counts.notSent
  if (run.productCount > 0) parts.push(bad > 0 ? `${bad} failed of ${run.productCount}` : `${run.productCount} ${run.productCount === 1 ? 'product' : 'products'}`)
  const checked = checkedLine(run)
  // Lower-case only the first word: the person's name keeps its own spelling ("checked by Dev Owner").
  if (checked) parts.push(checked.charAt(0).toLowerCase() + checked.slice(1))
  parts.push(`started ${publishFullTime(run.startedAt, now)}`)
  return parts.join(', ')
}

/** The live region's one sentence when a run finishes: "eBay IT publish finished: 21 accepted, 2 failed." */
export function finishedAnnouncement(run: HistoryRun): string {
  const where = runDestination(run)
  if (run.state === 'needs_check') return `${where} publish has no confirmed result. Check it before you publish again.`
  const parts = resultsParts(run.counts)
  return parts.length ? `${where} publish finished: ${parts.join(', ')}.` : `${where} publish finished: ${runStatusMeta(run).label.toLowerCase()}.`
}
