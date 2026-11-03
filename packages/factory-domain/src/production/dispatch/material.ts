import type { BusinessDate } from '../../core/time'
import { READINESS_LABELS, READINESS_WORDS, type ReadinessWord } from '../../planning/readiness/readiness'

/**
 * The material ready flag (B-W2b-49; MES-026 "each dispatch item shows whether its components, trims and protectors are in
 * stock, on the way or missing, by colour and icon"; design floor.mywork "Next"), pure: one flag from the planning
 * readiness word of the work order (factory-domain planning/readiness).
 *
 * B-W2b-88: per OPERATION where the BOM says which step uses a line (BomLine.routingSeq): an operation's flag is the worst
 * word of the materials its own lines name, with those of the lines that name no step (they may be used anywhere). A work
 * order whose BOM ties no line keeps the work order's flag (scope WORK_ORDER, as before); an operation that then uses no
 * material has no flag at all (null: nothing to wait for, said by no pill).
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

/** B-W2b-88: whose material the flag is about: the operation's own lines (and the untied ones), or the whole work order's. */
export const MATERIAL_SCOPES = ['OPERATION', 'WORK_ORDER'] as const
export type MaterialScope = (typeof MATERIAL_SCOPES)[number]

export interface MaterialFlag {
  readonly state: MaterialState
  readonly word: ReadinessWord
  readonly label: string
  readonly date: BusinessDate | null
  readonly words: string
  readonly scope: MaterialScope
}

const WORDS: Readonly<Record<MaterialScope, Readonly<Record<MaterialState, string>>>> = Object.freeze({
  WORK_ORDER: Object.freeze({
    IN_STOCK: 'Components, trims and protectors are in stock.',
    ON_THE_WAY: 'Some material is on the way.',
    MISSING: 'Some material is missing.',
    NOT_KNOWN: 'The plan says nothing about its material.',
  }),
  OPERATION: Object.freeze({
    IN_STOCK: 'The material this operation uses is in stock.',
    ON_THE_WAY: 'Some material this operation uses is on the way.',
    MISSING: 'Some material this operation uses is missing.',
    NOT_KNOWN: 'The plan says nothing about the material this operation uses.',
  }),
})

export function materialFlagOf(word: ReadinessWord, date: BusinessDate | null, scope: MaterialScope = 'WORK_ORDER'): MaterialFlag {
  const state = STATE_OF[word]
  const onTheWay = scope === 'OPERATION' ? 'Some material this operation uses is on the way' : 'Some material is on the way'
  const words = state === 'ON_THE_WAY' && date ? `${onTheWay}: expected ${date}.` : WORDS[scope][state]
  return { state, word, label: READINESS_LABELS[word], date, words, scope }
}

/** The key of a material in its colour, as readiness and the work order's planned materials name it. */
export const materialKey = (itemId: string, itemColourId: string | null): string => `${itemId}|${itemColourId ?? ''}`

/** What readiness says of a work order, as the flag reads it (factory-domain planning/readiness WorkOrderReadiness). */
export interface ReadinessFacts {
  readonly word: ReadinessWord
  readonly date: BusinessDate | null
  readonly materials: readonly { readonly itemId: string; readonly itemColourId: string | null; readonly word: Exclude<ReadinessWord, 'NOT_PLANNED'>; readonly date: BusinessDate | null }[]
}

/**
 * What an operation of a work order uses, from its planned materials (WorkOrderMaterial → BomLine.routingSeq): `tied` the
 * work order's BOM names a step on at least one line; `keys` the materials (materialKey) of this operation's own lines and
 * of the lines that name no step.
 */
export interface OperationUse {
  readonly tied: boolean
  readonly keys: ReadonlySet<string>
}

/**
 * The flag of one operation (B-W2b-88): the work order's when its BOM ties no line; else the worst word of the materials
 * the operation uses (the latest date among the worst, for EXPECTED and DELAYED), NOT_KNOWN when the plan says nothing of
 * them, and null when it uses none.
 */
export function operationMaterialFlag(readiness: ReadinessFacts, use: OperationUse): MaterialFlag | null {
  if (!use.tied) return materialFlagOf(readiness.word, readiness.date)
  if (use.keys.size === 0) return null
  if (readiness.word === 'NOT_PLANNED') return materialFlagOf('NOT_PLANNED', null, 'OPERATION')
  const rows = readiness.materials.filter((material) => use.keys.has(materialKey(material.itemId, material.itemColourId)))
  if (rows.length === 0) return materialFlagOf('NOT_PLANNED', null, 'OPERATION')
  const rank = (word: ReadinessWord) => READINESS_WORDS.indexOf(word)
  const worst = rows.reduce((top, row) => (rank(row.word) < rank(top.word) ? row : top), rows[0]!).word
  const date = worst === 'EXPECTED' || worst === 'DELAYED' ? rows.filter((row) => row.word === worst).reduce<BusinessDate | null>((latest, row) => (row.date !== null && (latest === null || row.date > latest) ? row.date : latest), null) : null
  return materialFlagOf(worst, date, 'OPERATION')
}

/** A station's or a line's worst flag, for a tile (nothing known counts for nothing). */
export function worstMaterial(states: readonly MaterialState[]): MaterialState | null {
  for (const state of ['MISSING', 'ON_THE_WAY', 'IN_STOCK'] as const) if (states.includes(state)) return state
  return states.length > 0 ? 'NOT_KNOWN' : null
}
