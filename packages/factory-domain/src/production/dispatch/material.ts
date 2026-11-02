import type { BusinessDate } from '../../core/time'
import { READINESS_LABELS, type ReadinessWord } from '../../planning/readiness/readiness'

/**
 * The material ready flag (B-W2b-49; MES-026 "each dispatch item shows whether its components, trims and protectors are in
 * stock, on the way or missing, by colour and icon"; design floor.mywork "Next"), pure: one flag from the planning
 * readiness word of the work order (factory-domain planning/readiness). Readiness is per work order: no column says which
 * operation uses which component (schema need), so every operation of a work order shows the same flag.
 */

export const MATERIAL_STATES = ['IN_STOCK', 'ON_THE_WAY', 'MISSING', 'NOT_KNOWN'] as const
export type MaterialState = (typeof MATERIAL_STATES)[number]

const STATE_OF: Readonly<Record<ReadinessWord, MaterialState>> = Object.freeze({
  RECEIVED: 'IN_STOCK',
  NOT_BOOKED: 'IN_STOCK',
  EXPECTED: 'ON_THE_WAY',
  REQUESTED: 'ON_THE_WAY',
  DELAYED: 'ON_THE_WAY',
  NOT_ENOUGH: 'MISSING',
  NOT_PLANNED: 'NOT_KNOWN',
})

export const MATERIAL_LOOK: Readonly<Record<MaterialState, { readonly icon: string; readonly tone: 'success' | 'warning' | 'danger' | 'neutral' }>> = Object.freeze({
  IN_STOCK: { icon: 'check-circle', tone: 'success' },
  ON_THE_WAY: { icon: 'truck', tone: 'warning' },
  MISSING: { icon: 'alert-triangle', tone: 'danger' },
  NOT_KNOWN: { icon: 'help-circle', tone: 'neutral' },
})

export interface MaterialFlag {
  readonly state: MaterialState
  readonly word: ReadinessWord
  readonly label: string
  readonly date: BusinessDate | null
  readonly words: string
}

const WORDS: Readonly<Record<MaterialState, string>> = Object.freeze({
  IN_STOCK: 'Components, trims and protectors are in stock.',
  ON_THE_WAY: 'Some material is on the way.',
  MISSING: 'Some material is missing.',
  NOT_KNOWN: 'The plan says nothing about its material.',
})

export function materialFlagOf(word: ReadinessWord, date: BusinessDate | null): MaterialFlag {
  const state = STATE_OF[word]
  const words = state === 'ON_THE_WAY' && date ? `Some material is on the way: expected ${date}.` : WORDS[state]
  return { state, word, label: READINESS_LABELS[word], date, words }
}

/** A station's or a line's worst flag, for a tile (nothing known counts for nothing). */
export function worstMaterial(states: readonly MaterialState[]): MaterialState | null {
  for (const state of ['MISSING', 'ON_THE_WAY', 'IN_STOCK'] as const) if (states.includes(state)) return state
  return states.length > 0 ? 'NOT_KNOWN' : null
}
