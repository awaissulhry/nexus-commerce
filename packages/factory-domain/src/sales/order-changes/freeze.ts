import type { Words } from '../../approvals/rules'
import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * What freezes on an order at each production stage (B-W2b-309; SAL-218 "field freeze by production stage"; design
 * order.changes.freeze "What is frozen", order.lines.cards "Sizes already cut are locked with the reason 'Cutting started —
 * size frozen'"), pure. A company keeps its rules (factory-db OrderFreezeRule, B-W2b-281): per field of its orders (sizes
 * and quantities, colourway, options, delivery date, ship-to, prices) the production stage from which it is frozen and what
 * a change then needs: a priced change request the customer accepts (CHANGE_REQUEST, SAL-219) or nothing at all (BLOCKED).
 * A company with no rule leaves every field open. The database keeps one active rule per company, field and stage, and a
 * later stage never loosening an earlier BLOCKED; it does not read production: the stage of a line is the orders module's.
 *
 *   stages    RELEASED < CUT < SEWING < FINISHED < SHIPPED (a work order of the cell released, cutting started, sewing
 *             started, pieces released by quality, something shipped); a size cell's stage is the furthest its cells
 *             reached, a line's the furthest of its sizes, the order's the furthest of its lines
 *   verdict   per field and stage: the active rule of the field with the latest stage at or before it decides (OPEN when
 *             none), in words: the rule's note, else "Cutting started — size frozen: a change is a priced change request"
 *   where     sizes and quantities per size cell, colourway / options / price per line, delivery date and ship-to per order
 *   problems  an amendment's changes against the verdicts: BLOCKED always refused, CHANGE_REQUEST refused unless the change
 *             is priced (POST …/priced-changes)
 */

export const ORDER_FREEZE_FIELDS = ['SIZE_QUANTITY', 'COLOURWAY', 'OPTION', 'DELIVERY_DATE', 'SHIP_TO', 'PRICE'] as const
export type OrderFreezeField = (typeof ORDER_FREEZE_FIELDS)[number]
/** In the stages' order (the database compares them by it). */
export const ORDER_FREEZE_STAGES = ['RELEASED', 'CUT', 'SEWING', 'FINISHED', 'SHIPPED'] as const
export type OrderFreezeStage = (typeof ORDER_FREEZE_STAGES)[number]
export const ORDER_FREEZE_ACTIONS = ['CHANGE_REQUEST', 'BLOCKED'] as const
export type OrderFreezeAction = (typeof ORDER_FREEZE_ACTIONS)[number]
export const FREEZE_STATES = ['OPEN', 'CHANGE_REQUEST', 'BLOCKED'] as const
export type FreezeState = (typeof FREEZE_STATES)[number]

/** Where a field is read: per size cell, per line, or for the whole order. */
export const FIELD_SCOPE: Readonly<Record<OrderFreezeField, 'SIZE' | 'LINE' | 'ORDER'>> = Object.freeze({
  SIZE_QUANTITY: 'SIZE',
  COLOURWAY: 'LINE',
  OPTION: 'LINE',
  PRICE: 'LINE',
  DELIVERY_DATE: 'ORDER',
  SHIP_TO: 'ORDER',
})

export const FREEZE_LIMITS = Object.freeze({ note: 200, rules: 100 })
const ONE_LINE = /^[^\r\n]+$/

export const FIELD_WORDS: Readonly<Record<OrderFreezeField, Words>> = Object.freeze({
  SIZE_QUANTITY: { en: 'sizes and quantities', it: 'taglie e quantità' },
  COLOURWAY: { en: 'colourway', it: 'variante colore' },
  OPTION: { en: 'options', it: 'opzioni' },
  DELIVERY_DATE: { en: 'delivery date', it: 'data di consegna' },
  SHIP_TO: { en: 'delivery address', it: 'indirizzo di consegna' },
  PRICE: { en: 'prices', it: 'prezzi' },
})

/** The short word of a frozen field on its cell ("size frozen"). */
const FROZEN_WORDS: Readonly<Record<OrderFreezeField, Words>> = Object.freeze({
  SIZE_QUANTITY: { en: 'size frozen', it: 'taglia bloccata' },
  COLOURWAY: { en: 'colourway frozen', it: 'colore bloccato' },
  OPTION: { en: 'options frozen', it: 'opzioni bloccate' },
  DELIVERY_DATE: { en: 'delivery date frozen', it: 'data di consegna bloccata' },
  SHIP_TO: { en: 'delivery address frozen', it: 'indirizzo di consegna bloccato' },
  PRICE: { en: 'price frozen', it: 'prezzo bloccato' },
})

export const STAGE_WORDS: Readonly<Record<OrderFreezeStage, Words>> = Object.freeze({
  RELEASED: { en: 'Released to production', it: 'Rilasciato in produzione' },
  CUT: { en: 'Cutting started', it: 'Taglio iniziato' },
  SEWING: { en: 'Sewing started', it: 'Cucitura iniziata' },
  FINISHED: { en: 'Pieces finished', it: 'Capi finiti' },
  SHIPPED: { en: 'Shipped', it: 'Spedito' },
})

export const ACTION_WORDS: Readonly<Record<OrderFreezeAction, Words>> = Object.freeze({
  CHANGE_REQUEST: { en: 'a change is a priced change request the customer accepts', it: 'una modifica è una richiesta di modifica con prezzo che il cliente accetta' },
  BLOCKED: { en: 'it cannot change any more', it: 'non si può più cambiare' },
})

export const NOT_STARTED_WORDS: Words = Object.freeze({ en: 'Not in production yet', it: 'Non ancora in produzione' })
export const OPEN_WORDS: Words = Object.freeze({ en: 'Still open', it: 'Ancora modificabile' })

/** The stage's place in the order (RELEASED 0 … SHIPPED 4). */
export const stageRank = (stage: OrderFreezeStage): number => ORDER_FREEZE_STAGES.indexOf(stage)

/** The furthest of some stages (null: none reached). */
export function furthestStage(stages: readonly (OrderFreezeStage | null)[]): OrderFreezeStage | null {
  let best: OrderFreezeStage | null = null
  for (const stage of stages) if (stage !== null && (best === null || stageRank(stage) > stageRank(best))) best = stage
  return best
}

/** A rule as the reading needs it. */
export interface FreezeRuleFacts {
  readonly id: string
  readonly field: OrderFreezeField
  readonly frozenFrom: OrderFreezeStage
  readonly action: OrderFreezeAction
  readonly active: boolean
  readonly note: string | null
}

export interface FreezeVerdict {
  readonly field: OrderFreezeField
  readonly state: FreezeState
  /** The stage reached (null: not in production). */
  readonly stage: OrderFreezeStage | null
  /** The rule that decides (null: none applies). */
  readonly ruleId: string | null
  readonly frozenFrom: OrderFreezeStage | null
  /** In words: "Cutting started — size frozen: a change is a priced change request the customer accepts", or "Still open". */
  readonly words: Words
}

/**
 * The verdict of a field at a stage: the active rule of the field with the latest stage at or before the stage reached
 * decides (the database keeps a later stage from loosening an earlier BLOCKED, so the latest is the strictest). OPEN when no
 * rule applies or nothing is in production.
 */
export function freezeVerdict(rules: readonly FreezeRuleFacts[], field: OrderFreezeField, stage: OrderFreezeStage | null): FreezeVerdict {
  const open: FreezeVerdict = { field, state: 'OPEN', stage, ruleId: null, frozenFrom: null, words: OPEN_WORDS }
  if (stage === null) return open
  let rule: FreezeRuleFacts | null = null
  for (const candidate of rules) {
    if (!candidate.active || candidate.field !== field || stageRank(candidate.frozenFrom) > stageRank(stage)) continue
    // The latest stage wins; on the same stage (never two active rules: the database's unique key) BLOCKED first.
    if (rule === null || stageRank(candidate.frozenFrom) > stageRank(rule.frozenFrom) || (candidate.frozenFrom === rule.frozenFrom && candidate.action === 'BLOCKED')) rule = candidate
  }
  if (rule === null) return open
  const started = STAGE_WORDS[rule.frozenFrom]
  const frozen = FROZEN_WORDS[field]
  const then = ACTION_WORDS[rule.action]
  const words: Words = rule.note ? { en: rule.note, it: rule.note } : { en: `${started.en} — ${frozen.en}: ${then.en}`, it: `${started.it} — ${frozen.it}: ${then.it}` }
  return { field, state: rule.action, stage, ruleId: rule.id, frozenFrom: rule.frozenFrom, words }
}

/** Every field's verdict at a stage (the "What is frozen" panel's rows). */
export const verdictsAt = (rules: readonly FreezeRuleFacts[], stage: OrderFreezeStage | null): FreezeVerdict[] => ORDER_FREEZE_FIELDS.map((field) => freezeVerdict(rules, field, stage))

/** What a rule as written would break, in the database's words first (paths under `at`). */
export function freezeRuleProblems(input: { readonly note?: string | null | undefined }, at = 'body'): Issue[] {
  const issues: Issue[] = []
  const note = input.note?.trim() ?? ''
  if (note !== '' && (note.length > FREEZE_LIMITS.note || !ONE_LINE.test(note))) issues.push({ path: `${at}/note`, message: `The words beside a frozen field are one line of at most ${FREEZE_LIMITS.note} characters.` })
  return issues
}

/**
 * Among a company's ACTIVE rules of one field (the rule being written included), the first CHANGE_REQUEST at a stage after a
 * BLOCKED one (the database refuses it: a later stage never loosens an earlier block), in words; null when none.
 */
export function looseningProblem(rules: readonly Pick<FreezeRuleFacts, 'field' | 'frozenFrom' | 'action' | 'active'>[], field: OrderFreezeField): string | null {
  const active = rules.filter((rule) => rule.active && rule.field === field).sort((a, b) => stageRank(a.frozenFrom) - stageRank(b.frozenFrom))
  const blocked = active.find((rule) => rule.action === 'BLOCKED')
  if (!blocked) return null
  const looser = active.find((rule) => rule.action === 'CHANGE_REQUEST' && stageRank(rule.frozenFrom) > stageRank(blocked.frozenFrom))
  if (!looser) return null
  return `The ${FIELD_WORDS[field].en} are blocked from "${STAGE_WORDS[blocked.frozenFrom].en.toLowerCase()}": a later stage (${STAGE_WORDS[looser.frozenFrom].en.toLowerCase()}) cannot open them again for a change request.`
}

// ---- an amendment's changes against the verdicts --------------------------------------------------------------------------

/** One change an amendment makes to a frozen-able field, where it is (a line, a size), and its verdict there. */
export interface FrozenChange {
  readonly field: OrderFreezeField
  /** The line (null: the whole order). */
  readonly lineId: string | null
  readonly seq: number | null
  /** The size (SIZE_QUANTITY only). */
  readonly size: string | null
  readonly verdict: FreezeVerdict
}

/**
 * The problems of an amendment's frozen changes: BLOCKED is refused; CHANGE_REQUEST is refused unless the change is priced
 * (the priced change request, SAL-219). Paths `body/lines/<seq>/<field>` and `body/<field>`.
 */
export function frozenProblems(changes: readonly FrozenChange[], priced: boolean): Issue[] {
  const issues: Issue[] = []
  for (const change of changes) {
    if (change.verdict.state === 'OPEN') continue
    if (change.verdict.state === 'CHANGE_REQUEST' && priced) continue
    const where = change.lineId === null ? 'The order' : change.size !== null ? `Line ${change.seq}, size ${change.size}` : `Line ${change.seq}`
    const path = change.lineId === null ? `body/${change.field}` : `body/lines/${change.seq}/${change.field}`
    const what =
      change.verdict.state === 'BLOCKED'
        ? `${where}: ${change.verdict.words.en}.`
        : `${where}: ${change.verdict.words.en} — send it as a priced change (POST …/priced-changes), not as a plain amendment.`
    issues.push({ path, message: what })
  }
  return issues
}

/** A size cell, a line or the order with the stage it reached and the day (the "What is frozen" panel). */
export interface StageReached {
  readonly stage: OrderFreezeStage | null
  readonly on: BusinessDate | null
}
