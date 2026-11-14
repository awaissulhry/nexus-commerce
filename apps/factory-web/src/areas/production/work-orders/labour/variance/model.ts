import { VARIANCE_CATEGORIES, type Split, type VarianceLine } from '../../close/api'
import type { StoredClose, WorkOrderCloses } from './api'

/**
 * B-W2b-424 — the variance at close on the work order's Labour & cost tab (design production.workorders rec:labour wo-cost:
 * "W2b variance at close (MES-012)"), the pure rules: what the card shows from the work order's state (not closed yet; the
 * split the close would write now; the close that stands, settled or a status only while the accountant's switch was off),
 * the lines in the order of the categories, each line's unit, the sum the lines explain, and the earlier closes that were
 * taken back. Per work order, category and material: never per person. The whole cost section needs the cost grain.
 */

export interface VarianceModel {
  /** costing.view and the cost grain (money.cost): the whole cost section needs both (design wo-cost). */
  readonly can: { readonly view: boolean; readonly cost: boolean }
  readonly status: string
  /** A completed work order: the split the close would write now, from the close check (null: not read yet). */
  readonly preview: { readonly split: Split | null; readonly settles: boolean; readonly problem: string | null } | null
  /** A completed or closed work order: its closes, newest first (null: not asked). */
  readonly closes: { readonly value: WorkOrderCloses | null; readonly problem: string | null } | null
}

export type VarianceState = 'notYet' | 'loading' | 'failed' | 'preview' | 'previewWaits' | 'settled' | 'statusOnly'

/** What the card shows. */
export function varianceState(model: VarianceModel): VarianceState {
  if (model.status !== 'COMPLETED' && model.status !== 'CLOSED') return 'notYet'
  if (model.closes?.problem || (model.status === 'COMPLETED' && model.preview?.problem)) return 'failed'
  if (!model.closes?.value) return 'loading'
  if (model.status === 'CLOSED') {
    const live = liveClose(model.closes.value)
    return live?.settled ? 'settled' : 'statusOnly'
  }
  if (!model.preview?.split) return 'loading'
  return model.preview.settles ? 'preview' : 'previewWaits'
}

/** The close that stands (not undone), if any. */
export const liveClose = (closes: Pick<WorkOrderCloses, 'closes'>): StoredClose | null => closes.closes.find((close) => close.live) ?? null

/** The closes taken back (undone by the closer, or reopened later), newest first: the record's history. */
export const earlierCloses = (closes: Pick<WorkOrderCloses, 'closes'>): StoredClose[] => closes.closes.filter((close) => !close.live)

/** The lines in the order of the categories (the API's order inside one category). */
export function orderedLines<L extends Pick<VarianceLine, 'category'>>(lines: readonly L[]): L[] {
  return lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => VARIANCE_CATEGORIES.indexOf(a.line.category) - VARIANCE_CATEGORIES.indexOf(b.line.category) || a.index - b.index)
    .map((entry) => entry.line)
}

/** A line's quantities are base units of its material, standard minutes (labour) or garments. */
export function lineUnit(line: Pick<VarianceLine, 'category' | 'item'>): string {
  if (line.item) return line.item.baseUom
  if (line.category === 'LABOUR_EFFICIENCY' || line.category === 'LABOUR_RATE') return 'MIN'
  return 'PCS'
}

/** What the lines explain together (minor units); null when an amount is not there (no cost grain). */
export function explainedOf(lines: readonly Pick<VarianceLine, 'amount'>[]): number | null {
  let sum = 0
  for (const line of lines) {
    if (typeof line.amount !== 'number') return null
    sum += line.amount
  }
  return sum
}

/** How many entries a close wrote, and how many of them were reversed (an undone or reopened close). */
export function entriesOf(close: Pick<StoredClose, 'entries'>): { written: number; reversals: number } {
  const reversals = close.entries.filter((entry) => entry.reversalOfId !== null).length
  return { written: close.entries.length - reversals, reversals }
}
