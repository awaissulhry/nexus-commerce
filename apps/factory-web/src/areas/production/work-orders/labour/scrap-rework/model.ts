import type { ScrapRework, ScrapReworkRow } from './api'

/**
 * B-W2b-GB02 (G053; B-W2b-424's gap 5) — the scrap and rework cost on the work order's Labour & cost tab, the pure rules.
 * F-PR-06 (06-tree A.4 Tab 6): Quality is the work order's one scrap home (its scrap, reasons, rework and replacements); Labour &
 * cost keeps ONE line, the value of the scrap and rework, from the totals: reading, failed, nothing scrapped or reworked, not known
 * (a rework with no cost per minute in force: never a 0) or the amount. Per work order: never per person.
 */

export interface ScrapReworkModel {
  readonly part: { readonly value: ScrapRework | null; readonly problem: string | null } | null
}

/** The rework of a reason has minutes but no cost per minute in force: its cost (and the total) is not known. */
export const costUnknown = (row: Pick<ScrapReworkRow, 'reworkCost'>): boolean => row.reworkCost === null

export type ScrapValue =
  | { readonly state: 'loading' | 'failed' | 'none' | 'unknown' }
  | { readonly state: 'amount'; readonly amount: number; readonly currency: string }

/** The one scrap value line: the totals' amount in minor units, or why there is none. */
export function scrapValueOf(model: ScrapReworkModel): ScrapValue {
  if (model.part?.problem) return { state: 'failed' }
  const value = model.part?.value
  if (!value) return { state: 'loading' }
  if (value.rows.length === 0) return { state: 'none' }
  if (costUnknown(value.totals) || value.totals.total === null || value.totals.total === undefined) return { state: 'unknown' }
  return { state: 'amount', amount: value.totals.total, currency: value.currency }
}
