import type { FloorChain, FloorChainLot, ReportBody } from './api'

/**
 * owb-fl9 step 3 — a chain on the floor, pure (design § 4.8; P/lines.js chainSteps; settle 10): ONE step on the screen (a chip per step:
 * its number, its department, done), its lots as big rows (size, model, done, waiting), **+12** = one report of the cell's next bundle,
 * **−12** = the worker's own Undo of that report while today's two minutes last. The slowest step says it in words and a number.
 */

/** Today's own Undo: two minutes after the report (the Operation screen's rule). */
export const UNDO_MS = 2 * 60_000

export const UNDO_KIND = 'production.scan.undo'

export interface LastReport {
  readonly workOrderSizeId: string
  readonly operationId: string
  readonly scanId: string
  readonly quantity: number
  readonly bundleCode: string
  /** When the phone got the answer (ms). */
  readonly at: number
}

/** The step on screen: the one asked for, else the first with pieces waiting, else the first. */
export function stepOf(chain: Pick<FloorChain, 'steps'>, asked: string | null): string | null {
  if (asked && chain.steps.some((step) => step.operationId === asked)) return asked
  return (chain.steps.find((step) => step.waiting > 0) ?? chain.steps[0])?.operationId ?? null
}

/** One lot at one step. */
export function lotAt(lot: FloorChainLot, operationId: string): { readonly done: number; readonly waiting: number; readonly full: boolean } {
  const cell = lot.perStep.find((entry) => entry.operationId === operationId)
  const done = cell?.done ?? 0
  return { done, waiting: cell?.waiting ?? 0, full: lot.quantity !== undefined && lot.quantity > 0 && done >= lot.quantity }
}

/** "+12": exactly ONE report body (one client id: a resend is answered once, never a second report). */
export const reportBody = (lineId: string, operationId: string, workOrderSizeId: string, clientEventId: string): ReportBody => ({ lineId, operationId, workOrderSizeId, clientEventId })

/** "−12": exactly ONE undo of the last report, by its scan. */
export const undoPayload = (last: Pick<LastReport, 'scanId'>): Record<string, unknown> => ({ scanId: last.scanId })

/** The last report of this lot at this step may still be undone by its worker (today's two minutes). */
export function undoOpen(last: LastReport | null | undefined, workOrderSizeId: string, operationId: string, now: number): boolean {
  return Boolean(last) && last!.workOrderSizeId === workOrderSizeId && last!.operationId === operationId && now - last!.at < UNDO_MS
}

/** The "+" button's number: one bundle's pieces when the server says it, else the word "a bundle" (null). */
export const plusOf = (lot: Pick<FloorChainLot, 'bundleSize'>): number | null => (lot.bundleSize && lot.bundleSize > 0 ? lot.bundleSize : null)

/** The device's chain: the line of a line tablet (or a person's line), else none (a phone of no chain says so in words). */
export const lineOf = (me: { readonly line?: { readonly id: string } | null } | null, device: { readonly line?: { readonly id: string } | null } | null): string | null => me?.line?.id ?? device?.line?.id ?? null
