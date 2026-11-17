import { progressFigure, type ProgressFigure } from '../../../../lib/production/model'
import type { OrderWorkOrder } from '../api'

/**
 * Lead fix (production-page lane): the order's Production tab showed `sewn ?? 0` — "0 sewn" where the site does not scan
 * sewing. A work order's progress there is ONE figure — the furthest step counted, its words and its bar from the same number
 * (lib/production `progressFigure`, rule R5) — plus the steps its site does not count (a null count: "—" with "Sewing not
 * counted here"), never 0. Not released: no figure, no steps.
 */
export const COUNTED_STEPS = ['cut', 'sewn', 'finished'] as const
export type CountedStep = (typeof COUNTED_STEPS)[number]

export function productionProgress(row: Pick<OrderWorkOrder, 'progress' | 'pieces' | 'status'>): { readonly figure: ProgressFigure; readonly notCounted: readonly CountedStep[] } {
  const released = row.status !== 'DRAFT'
  const figure = progressFigure(row.progress, row.pieces, released)
  const notCounted = released && row.progress ? COUNTED_STEPS.filter((step) => row.progress![step] === null) : []
  return { figure, notCounted }
}
