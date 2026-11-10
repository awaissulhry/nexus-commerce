import type { Reconciliation, SpoilKind } from './api'

/**
 * The label reconciliation on the floor (B-W2b-259; MES-140; design floor.labels sec:print "printed vs used vs spoiled, 'Log
 * spoiled'", page.h "Log spoiled labels (W2b)"), pure: the container (Labels.tsx) and the design cases (fixtures.ts) draw the
 * same panel and the same Log spoiled labels step from the same state. Figures only: the screen says its own words.
 */

export interface Counts {
  readonly printed: number
  readonly used: number
  readonly spoiled: number
  readonly returned: number
  readonly difference: number
}

/** Why Log spoiled labels waits (null: it may run). */
export type SpoilHeld = 'offline' | 'busy' | 'nothingPrinted' | 'noneLeft' | null

export interface ReconcileModel {
  /** The picked size's figures (null: no size picked, or the size is not in the answer). */
  readonly size: (Counts & { readonly label: string }) | null
  readonly total: Counts
  readonly balanced: boolean
  /** A difference holds the work order's final release (a requirement asks it). */
  readonly holdsRelease: boolean
  /** Labels of the picked size that may still be logged spoiled or returned: printed − spoiled − returned. */
  readonly room: number
  readonly held: SpoilHeld
}

/** The fixed reasons a spoiled label is logged with: the same words in the office's log in any language. */
export const SPOIL_REASONS = ['DAMAGED', 'MISPRINTED', 'LOST', 'JAMMED'] as const
export type SpoilReason = (typeof SPOIL_REASONS)[number]
export const SPOIL_REASON_TEXT: Readonly<Record<SpoilReason, string>> = {
  DAMAGED: 'Label damaged or torn',
  MISPRINTED: 'Misprinted',
  LOST: 'Label lost',
  JAMMED: 'Printer jammed',
}

/** The panel's model from the answer, the picked size and the screen's state. */
export function reconcileModel(answer: Reconciliation | null, picked: string | null, state: { readonly online: boolean; readonly busy: boolean }): ReconcileModel | null {
  if (!answer) return null
  const row = picked ? answer.cells.find((cell) => cell.workOrderSizeId === picked) : undefined
  const room = row ? Math.max(0, row.printed - row.spoiled - row.returned) : 0
  const held: SpoilHeld = !state.online ? 'offline' : state.busy ? 'busy' : !row || row.printed === 0 ? 'nothingPrinted' : room === 0 ? 'noneLeft' : null
  return {
    size: row ? { label: `${row.colourwayCode} ${row.size}`, printed: row.printed, used: row.used, spoiled: row.spoiled, returned: row.returned, difference: row.difference } : null,
    total: answer.total,
    balanced: answer.balanced,
    holdsRelease: answer.holdsRelease,
    room,
    held,
  }
}

/** What one tap on a reason sends: a spoiled reason, or the labels handed back unused. */
export function spoilAsk(choice: SpoilReason | 'RETURNED', cellId: string, count: number): { workOrderSizeId: string; kind: SpoilKind; quantity: number; reason: string | null } {
  return choice === 'RETURNED' ? { workOrderSizeId: cellId, kind: 'RETURNED', quantity: count, reason: null } : { workOrderSizeId: cellId, kind: 'SPOILED', quantity: count, reason: SPOIL_REASON_TEXT[choice] }
}

/** The count a person may log: 1 to what is left, the typed one clamped. */
export const spoilCount = (typed: number | null, room: number): number => Math.max(1, Math.min(typed ?? 1, Math.max(1, room)))
