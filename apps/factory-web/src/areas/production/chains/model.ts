import type { Chain, ChainLot, ChainStep } from './api'

/**
 * owb-fl9 step 3 — the office's Chains, pure (design § 4.8; P/lines.js chainMatrix, slowStep): a matrix lots × steps; the slowest
 * step (the server's mark: where pieces wait longest) in red WITH its number and its word, never colour alone.
 */

export const CHAINS_NAMESPACE = 'production-chains'
export const CHAINS_NAMESPACES = [CHAINS_NAMESPACE] as const

/** One lot at one step: done and waiting (a step the lot never reaches reads 0 / 0). */
export function cellOf(lot: ChainLot, operationId: string): { readonly done: number; readonly waiting: number } {
  const cell = lot.perStep.find((entry) => entry.operationId === operationId)
  return { done: cell?.done ?? 0, waiting: cell?.waiting ?? 0 }
}

/** The slowest step (the server's mark), or null when no step is marked. */
export const slowestOf = (chain: Pick<Chain, 'steps'>): { readonly step: ChainStep; readonly index: number } | null => {
  const index = chain.steps.findIndex((step) => step.slowest)
  return index >= 0 ? { step: chain.steps[index]!, index } : null
}

/** A cell is full when the lot's pieces are all done there (only when the server gives the lot's quantity). */
export const cellFull = (lot: ChainLot, done: number): boolean => lot.quantity !== undefined && lot.quantity > 0 && done >= lot.quantity

/** The share of a cell done, 0..100 (for its bar; 0 without the lot's quantity). */
export const cellShare = (lot: ChainLot, done: number): number => (lot.quantity && lot.quantity > 0 ? Math.min(100, Math.round((done / lot.quantity) * 100)) : 0)
