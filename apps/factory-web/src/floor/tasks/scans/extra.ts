import type { BundleCard, CardOperation } from './model'

/**
 * An unplanned operation on the tablet (B-W2b-82; MES-086): the rules of SCR-090's part without React or the network. The
 * office or a team leader adds a library operation to a released work order with a reason (online only: the choice is the
 * office's list); it then stands on the bundle's card, marked, and is picked by hand: a scan still opens the routing's next
 * step, so finishing a bundle stays one tap. It counts good garments only (factory-domain production/extraops), and nothing
 * else on the card waits for it.
 */

export const EXTRA_REASON_CODES = ['QUALITY_FIX', 'MATERIAL_ISSUE', 'CUSTOMER_CHANGE', 'MISSING_FROM_ROUTING', 'OTHER'] as const
export type ExtraReasonCode = (typeof EXTRA_REASON_CODES)[number]

/** What a report at it pays, as the person adding it is told (a word, never a figure). */
export type ExtraPay = 'PIECE_RATE' | 'OFF_STANDARD' | 'NO_PIECE_PAY'

export interface ExtraChoice {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly workCentreKind: string
  readonly standardMinutes: string
  readonly pays: ExtraPay
}

export interface ExtraReason {
  readonly code: ExtraReasonCode
  readonly label: { readonly it: string; readonly en: string }
  readonly needsNote: boolean
}

export interface ExtraChoices {
  readonly operations: readonly ExtraChoice[]
  readonly reasons: readonly ExtraReason[]
}

export interface ExtraDraft {
  readonly operationId: string | null
  readonly reason: ExtraReasonCode | null
  readonly words: string
  /** B-W2b-GB29 (G215): the garments that need it; null: none typed (it stays off the plan). Left out on a kept older draft. */
  readonly planned?: number | null
}

export const NEW_EXTRA: ExtraDraft = Object.freeze({ operationId: null, reason: null, words: '', planned: null })

/** The note's limits (the API's: a few words, required with Other). */
export const EXTRA_NOTE = { min: 3, max: 200 } as const

/** Why Add cannot run, or null: an operation, a reason, the words of Other. */
export function extraHeld(draft: ExtraDraft, choices: ExtraChoices | null): 'operation' | 'reason' | 'words' | null {
  if (!draft.operationId || !choices?.operations.some((operation) => operation.id === draft.operationId)) return 'operation'
  if (!draft.reason) return 'reason'
  const tile = choices.reasons.find((reason) => reason.code === draft.reason)
  if (tile?.needsNote && draft.words.trim().length < EXTRA_NOTE.min) return 'words'
  return null
}

export function extraBody(draft: ExtraDraft): Record<string, unknown> {
  const note = draft.words.trim()
  // B-W2b-GB29 (G215): the planned garments only when typed (the API checks them against the work order's).
  return { operationId: draft.operationId, reasonCode: draft.reason, ...(note.length >= EXTRA_NOTE.min ? { note } : {}), ...(typeof draft.planned === 'number' && draft.planned >= 1 ? { plannedQuantity: draft.planned } : {}) }
}

/** The card's unplanned operations this station may report, not reported on this bundle yet (`current` left out). */
export function unplannedHere(card: BundleCard, current: string | null = null): CardOperation[] {
  return card.operations.filter((operation) => operation.unplanned && operation.state !== 'DONE' && operation.id !== current && (!card.station || operation.workCentreKind === card.station.kind))
}

/** The routing's operation the card opened on, to go back to from an unplanned one, or null. */
export const routingStep = (card: BundleCard): CardOperation | null => card.operations.find((operation) => operation.id === card.next) ?? null
