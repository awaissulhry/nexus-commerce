import type { BusinessDate } from '../../core/time'
import type { DateOnly } from '../../planning/promise/date-only'
import { parseDecimal } from '../../tax/decimal'
import { freezeVerdict, type FreezeRuleFacts, type OrderFreezeField, type OrderFreezeStage } from '../order-changes/freeze'
import { dayWords, type OrderRequestKind, type Words } from './rules'

/**
 * B-PR-24 (production plan §3 "Before Send it sees: what is frozen, priced or not, earliest date"; 08-backend §4.2 "Impact
 * before Send"; 07-control §1.3; review fixes R-09, R-32; wall test PW-P06): the impact of a customer's ask, pure. Shown
 * before Send (B-PR-25's read), and kept on the request at Send as it was shown (OrderChangeRequest.impact, never changed).
 *
 *   frozen    what the ask touches that the freeze rules hold now (the customer's own rules, else the company's:
 *             order-changes/freeze rulesForParty), per size cell, line or order: "Line 10, size 52: Cutting started — size
 *             frozen: a change is a priced change request the customer accepts". A field still open is not listed. BLOCKED
 *             means that part cannot change any more (B-PR-25 holds it at Send: blockedProblems)
 *   priced    yes or no, never an amount (R-09): a change that touches a field frozen as a priced change request, a cancel with
 *             a fee. Everyone reads "A price may apply: we will tell you"; the amount is read live, only by a role with the
 *             price grain (the API's)
 *   earliest  planning's answer read through the ONE shared helper planning/promise/date-only — a date only, never a load
 *             (R-32): "From about 12 Dec — we confirm it"
 *   notes     what the kind may do to the date ("A pause may move your date")
 *
 * The wall (PW-P06, "impact words never carry a load, a line, another order or another brand"): the impact is built only from
 * the customer's OWN order's lines and a date only; a cell naming a line that is not one of them is left out; nothing of
 * planning's answer but the date travels (no lane, step, minute, group or warning: dateOnly builds a new object of three
 * fields); no rule id, no amount, no person. It holds no number at all (the database's check: words, codes, dates and yes or
 * no only — the line's number travels as text), and fits in 8000 characters.
 */

/** One line of the customer's own order, as the impact reads it. */
export interface ImpactLine {
  readonly id: string
  readonly seq: number
  readonly closedShort: boolean
  /** The furthest production stage of the line's cells (null: nothing of it in production yet). */
  readonly stage: OrderFreezeStage | null
  /** Per size, the furthest stage of its cells (a size left out reads the line's stage). */
  readonly sizeStages?: Readonly<Record<string, OrderFreezeStage | null>> | undefined
}

/** What the ask touches. */
export interface ImpactAsk {
  readonly kind: OrderRequestKind
  /** A change's cells: a size asked (its sizes and quantities), or another colourway of the line. */
  readonly cells?: readonly { readonly lineId: string; readonly size: string | null; readonly colourway?: boolean | undefined }[] | undefined
  /** A change's date, a rush's need-by date, a split's first part's date. */
  readonly requestedDate?: BusinessDate | null | undefined
  /** A change asks another delivery address. */
  readonly shipTo?: boolean | undefined
}

export interface ImpactFacts {
  /** The customer's own order's lines (and nothing else). */
  readonly lines: readonly ImpactLine[]
  /** The order's furthest stage (the date and the address are read for the whole order). */
  readonly orderStage: OrderFreezeStage | null
  /** The rules that decide for this customer (freeze rulesForParty). */
  readonly rules: readonly FreezeRuleFacts[]
  /** SalesSettings.cancelFeePct (null: free): a cancel with a fee is priced. */
  readonly cancelFeePct: string | null
  /** Planning's answer through dateOnly; null: planning was not asked (no date said). */
  readonly earliest: DateOnly | null
}

/** One frozen part of what is asked. */
export interface ImpactItem {
  readonly field: OrderFreezeField
  /** The order line (null: the order as a whole) and its number as text. */
  readonly lineId: string | null
  readonly line: string | null
  /** The size (null: the line or the order as a whole). */
  readonly size: string | null
  readonly state: 'CHANGE_REQUEST' | 'BLOCKED'
  readonly words: Words
}

export interface ImpactDate {
  readonly date: BusinessDate | null
  readonly partial: boolean
  readonly meetsWanted: boolean | null
  readonly words: Words
}

export interface Impact {
  readonly kind: OrderRequestKind
  readonly frozen: readonly ImpactItem[]
  /** Some part asked cannot change any more. */
  readonly blocked: boolean
  readonly priced: boolean
  /** The same words for every reader when priced (never an amount); null: no price applies. */
  readonly pricedWords: Words | null
  readonly earliest: ImpactDate | null
  readonly notes: readonly Words[]
  /** The headline: nothing frozen, or what is. */
  readonly words: Words
}

/** "A price may apply: we will tell you" — every reader; the amount only live and only under the price grain. */
export const PRICED_WORDS: Words = Object.freeze({ it: 'Può essere previsto un costo: te lo diciamo noi', en: 'A price may apply: we will tell you' })

/** What the kind may do to the date, as the customer reads it before Send. */
export const IMPACT_NOTES: Readonly<Partial<Record<OrderRequestKind, Words>>> = Object.freeze({
  RUSH: { it: 'Guardiamo di nuovo la data e te la confermiamo', en: 'We look at the date again and confirm it to you' },
  HOLD: { it: 'Una pausa può spostare la tua data', en: 'A pause may move your date' },
  RESUME: { it: 'Alla ripresa ti confermiamo la data', en: 'When the work starts again, we confirm your date' },
  SPLIT_SHIPMENT: { it: 'Il resto parte quando è pronto', en: 'The rest ships when it is ready' },
  SAMPLE_ROUND: { it: 'Un altro campione può spostare la tua data', en: 'Another sample may move your date' },
})

const NOTHING_FROZEN: Words = Object.freeze({ it: 'Niente di ciò che chiedi è bloccato', en: 'Nothing you ask is frozen' })

/** The earliest date in the customer's words (an estimate: dates only). */
export function earliestWords(earliest: Pick<DateOnly, 'date' | 'partial' | 'meetsWanted'>): Words {
  if (earliest.date === null) return { it: 'Ti diamo una data appena l’abbiamo pianificata', en: 'We give you a date once we have planned it' }
  const day = { it: dayWords(earliest.date, 'it'), en: dayWords(earliest.date, 'en') }
  const later = earliest.meetsWanted === false ? { it: ', dopo la data che hai chiesto', en: ', later than the date you asked' } : { it: '', en: '' }
  const partial = earliest.partial ? { it: ' (alcune righe non sono ancora datate)', en: ' (some lines are not dated yet)' } : { it: '', en: '' }
  return { it: `Dal ${day.it} circa${later.it} — te lo confermiamo noi${partial.it}`, en: `From about ${day.en}${later.en} — we confirm it${partial.en}` }
}

const feeApplies = (pct: string | null): boolean => {
  const percent = pct === null ? null : parseDecimal(pct)
  return percent !== null && !percent.isZero() && percent.gt(0)
}

function itemWords(line: ImpactLine | null, size: string | null, verdict: Words): Words {
  if (line === null) return { it: verdict.it, en: verdict.en }
  if (size !== null) return { it: `Riga ${line.seq}, taglia ${size}: ${verdict.it}`, en: `Line ${line.seq}, size ${size}: ${verdict.en}` }
  return { it: `Riga ${line.seq}: ${verdict.it}`, en: `Line ${line.seq}: ${verdict.en}` }
}

/** The impact of an ask on the customer's own order (what is frozen, priced or not, the earliest date), in its words. */
export function impactOf(ask: ImpactAsk, facts: ImpactFacts): Impact {
  const lines = new Map(facts.lines.map((line) => [line.id, line]))
  const frozen: ImpactItem[] = []
  const seen = new Set<string>()
  const read = (field: OrderFreezeField, line: ImpactLine | null, size: string | null, stage: OrderFreezeStage | null): void => {
    const key = `${field}|${line?.id ?? ''}|${size ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    const verdict = freezeVerdict(facts.rules, field, stage)
    if (verdict.state === 'OPEN') return
    frozen.push(Object.freeze({ field, lineId: line?.id ?? null, line: line ? String(line.seq) : null, size, state: verdict.state, words: Object.freeze(itemWords(line, size, verdict.words)) }))
  }
  if (ask.kind === 'CHANGE') {
    for (const cell of ask.cells ?? []) {
      // A line that is not one of the order's own is never read (nor named): the wall.
      const line = lines.get(cell.lineId)
      if (!line) continue
      if (cell.size !== null) read('SIZE_QUANTITY', line, cell.size, line.sizeStages && cell.size in line.sizeStages ? (line.sizeStages[cell.size] ?? null) : line.stage)
      if (cell.colourway) read('COLOURWAY', line, null, line.stage)
    }
    if (ask.shipTo) read('SHIP_TO', null, null, facts.orderStage)
  }
  if ((ask.kind === 'CHANGE' || ask.kind === 'RUSH' || ask.kind === 'SPLIT_SHIPMENT') && (ask.requestedDate ?? null) !== null) read('DELIVERY_DATE', null, null, facts.orderStage)
  const priced = ask.kind === 'CHANGE' ? frozen.some((item) => item.state === 'CHANGE_REQUEST') : ask.kind === 'CANCEL' ? feeApplies(facts.cancelFeePct) : false
  const blocked = frozen.some((item) => item.state === 'BLOCKED')
  const earliest = facts.earliest
    ? Object.freeze({ date: facts.earliest.date, partial: facts.earliest.partial, meetsWanted: facts.earliest.meetsWanted, words: Object.freeze(earliestWords(facts.earliest)) })
    : null
  const note = IMPACT_NOTES[ask.kind]
  const headline: Words =
    frozen.length === 0
      ? NOTHING_FROZEN
      : blocked
        ? { it: 'Una parte di ciò che chiedi non si può più cambiare', en: 'Part of what you ask cannot change any more' }
        : { it: 'Una parte di ciò che chiedi è bloccata: diventa una modifica con prezzo', en: 'Part of what you ask is frozen: it becomes a priced change' }
  return Object.freeze({
    kind: ask.kind,
    frozen: Object.freeze(frozen),
    blocked,
    priced,
    pricedWords: priced ? PRICED_WORDS : null,
    earliest,
    notes: Object.freeze(note ? [note] : []),
    words: Object.freeze({ ...headline }),
  })
}

/** The parts asked that cannot change any more: refused at Send, by path (B-PR-25). */
export function blockedProblems(impact: Pick<Impact, 'frozen'>): { readonly path: string; readonly message: string }[] {
  return impact.frozen.filter((item) => item.state === 'BLOCKED').map((item) => ({ path: `body/${item.field}`, message: `${item.words.en}.` }))
}

/** The most characters the kept impact takes (the database's check). */
export const IMPACT_MAX_CHARS = 8000

/** Whether a value holds a number anywhere (the database refuses an impact that does: never an amount). */
function holdsNumber(value: unknown): boolean {
  if (typeof value === 'number' || typeof value === 'bigint') return true
  if (Array.isArray(value)) return value.some(holdsNumber)
  if (value !== null && typeof value === 'object') return Object.values(value as Record<string, unknown>).some(holdsNumber)
  return false
}

/** Whether an impact may be kept on the request as it is (the database's factory_order_change_request_impact_ok, said first). */
export function impactKeepable(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  if (holdsNumber(value)) return false
  return JSON.stringify(value).length <= IMPACT_MAX_CHARS
}

/** Whether every line an impact names is one of the customer's own order's lines (the wall). */
export const impactNamesOnly = (impact: Pick<Impact, 'frozen'>, ownLineIds: ReadonlySet<string>): boolean => impact.frozen.every((item) => item.lineId === null || ownLineIds.has(item.lineId))
