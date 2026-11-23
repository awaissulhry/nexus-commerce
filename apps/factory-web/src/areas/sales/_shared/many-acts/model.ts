import { isApiError, issuePath } from '../../../../lib/api/errors'

/**
 * F-CQ-201 (customer page › Quotes & incoming, 13-backend §11 "The many-acts window"; settles C9, C10, C12, C36) — ONE generic window
 * for an act on many records of a Sales list (Cancel N quotes, Ask for approval on N, Make the orders for N, Send a new link to N, Mark
 * N lost, Ask <customer> about N requests), pure. Before the click it says what it runs on and what not, with why beside each ("Runs
 * on 5 · Not on 1"); then it runs one record after the other with each record's own version and ONE `batchId` (one bell per batch,
 * S2); the receipt NAMES each record (a button that docks its thread, or its page) with what happened, and "Run the rest again" for
 * the ones not done. The words of the window are the Orders sheet's (read only) and `before-order`'s; the acts' are their lists'.
 * The Orders sheet keeps its own window until it moves onto this one (later job, C9).
 *
 * And the bars (F-CQ-201): each list's pure `barOf` names its acts in order; an act WITHOUT its right is not drawn; one blocked by the
 * state or a cap is held with words; the first three drawn stand in the bar, the rest go under More ▾ (the next allowed act moves up).
 */

/** Words of one catalogue (the window loads every namespace a word may come from). */
export interface ManyWords {
  readonly ns: string
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

/** The namespaces the window and the bars speak. */
export const MANY_NAMESPACES = ['before-order', 'orders-sheet', 'sales', 'sales-inquiries'] as const

/** One record a window acts on: its id, its number in words, where its name goes in the receipt. */
export interface ManyRecord {
  readonly id: string
  readonly label: string
  /** Its page (the receipt's name opens it when no dock is given). */
  readonly href: string | null
}

/** A field typed for ONE record (Make the orders for N: the customer's PO number of a quote that needs one, C36). */
export interface RecordField {
  readonly label: ManyWords
  readonly required: boolean
  readonly max: number
}

/** The text typed once for every record it runs on (a reason, a note, a question). */
export interface ManyText {
  readonly label: ManyWords
  readonly hint?: ManyWords
  /** Needed for the records it runs on (a sent quote's cancel needs a reason; a question is needed). */
  readonly required: boolean
  readonly min: number
  readonly max: number
}

/** What one record's run answers: done (its words), or not done (why, in words). */
export type RunAnswer = { readonly done: true; readonly words: ManyWords } | { readonly done: false; readonly why: ManyWords }

/** One act of the window. `R` is the list's row (each act reads its own facts). */
export interface ManyAct<R extends ManyRecord> {
  readonly kind: string
  readonly title: ManyWords
  readonly go: ManyWords
  /** What happens, in words, under the title (what the customer reads, what stops). */
  readonly body?: ManyWords | null
  /** Why it does not run on this record (its state), or null: it runs. */
  readonly notOn: (record: R) => ManyWords | null
  /** The text typed once (null: none); `required` may depend on the records it runs on. */
  readonly text?: ((runs: readonly R[]) => ManyText | null) | null
  /** The words the text starts with (one record: a template; null: empty). Read once when the window opens. */
  readonly start?: ((runs: readonly R[]) => Promise<string | null>) | null
  /** A field of one record (null: none for it). */
  readonly field?: ((record: R) => RecordField | null) | null
  readonly danger?: boolean
  /** Run on one record (its own version), with the text, its own field and the batch's id. */
  readonly run: (record: R, input: { readonly text: string; readonly field: string; readonly batchId: string }) => Promise<RunAnswer>
}

/** The most records one window acts on (a reply's cap; the API's bulk commands take 100). */
export const MANY_MAX = 50

/** The plan before the click: the records it runs on, and the rest with why. */
export interface ManyPlan<R> {
  readonly runs: readonly R[]
  readonly notOn: ReadonlyArray<{ readonly record: R; readonly why: ManyWords }>
}

export function planOf<R extends ManyRecord>(records: readonly R[], act: Pick<ManyAct<R>, 'notOn'>): ManyPlan<R> {
  const runs: R[] = []
  const notOn: Array<{ record: R; why: ManyWords }> = []
  for (const record of records) {
    const why = act.notOn(record)
    if (why) notOn.push({ record, why })
    else runs.push(record)
  }
  return { runs, notOn }
}

/** One line of the receipt: the record named, what happened. */
export interface ManyResult {
  readonly id: string
  readonly label: string
  readonly href: string | null
  readonly done: boolean
  readonly words: ManyWords
}

export interface ManyReceipt {
  readonly done: number
  readonly left: number
  /** The records not done (Run the rest again runs on them). */
  readonly rest: readonly string[]
}

export function receiptOf(results: readonly ManyResult[]): ManyReceipt {
  const rest = results.filter((result) => !result.done).map((result) => result.id)
  return { done: results.length - rest.length, left: rest.length, rest }
}

/** Why the window cannot run now, in words (nothing to run on, a text or a field missing, too many), or null. */
export function manyHeld<R extends ManyRecord>(plan: ManyPlan<R>, text: ManyText | null, typed: string, fields: Readonly<Record<string, string>>, fieldOf: ((record: R) => RecordField | null) | null | undefined): ManyWords | null {
  if (plan.runs.length === 0) return { ns: 'orders-sheet', key: 'commands.many.nothing' }
  if (plan.runs.length > MANY_MAX) return { ns: 'before-order', key: 'acts.held.tooMany', params: { max: MANY_MAX } }
  const length = typed.trim().length
  if (text?.required && length < text.min) return { ns: 'before-order', key: 'acts.held.text', params: { min: text.min } }
  if (text && length > text.max) return { ns: 'before-order', key: 'acts.held.long', params: { max: text.max } }
  for (const record of plan.runs) {
    const field = fieldOf?.(record) ?? null
    const value = (fields[record.id] ?? '').trim()
    if (field?.required && value === '') return { ns: 'before-order', key: 'acts.held.field', params: { number: record.label } }
    if (field && value.length > field.max) return { ns: 'before-order', key: 'acts.held.long', params: { max: field.max } }
  }
  return null
}

/**
 * A refused run, in words (never the API's own message): changed meanwhile (read it again: "Open it and try again"), not allowed for
 * this reader, gone, or the state no longer allows it — each named by the record's number. `state` lets an act say its own words for
 * a state refusal (a firm offer, no rule needing an approval).
 */
export function refusedWords(error: unknown, number: string, state: ManyWords | null = null): ManyWords {
  if (!isApiError(error)) return { ns: 'before-order', key: 'acts.why.failed' }
  if (error.kind === 'conflict') {
    const moved = error.code === 'version_conflict' || error.issues.some((issue) => issuePath(issue).split(/[./]/).includes('version'))
    if (moved) return { ns: 'orders-sheet', key: 'commands.many.stale', params: { number } }
    return state ?? { ns: 'before-order', key: 'acts.why.state' }
  }
  if (error.kind === 'forbidden') return { ns: 'before-order', key: 'acts.why.forbidden' }
  if (error.kind === 'not_found') return { ns: 'before-order', key: 'acts.why.gone' }
  if (error.kind === 'invalid') return { ns: 'before-order', key: 'acts.why.invalid' }
  if (error.kind === 'rate_limited' || error.kind === 'unavailable') return { ns: 'before-order', key: 'acts.why.later' }
  return { ns: 'before-order', key: 'acts.why.failed' }
}

// ---- the bars (F-CQ-201) -----------------------------------------------------------------------------------------------

/** One act of a bar: drawn only with its right; held with words by the state or a cap. */
export interface BarAct {
  readonly id: string
  readonly label: ManyWords
  /** Why it is held now (no ticked record it runs on, a cap), or null. */
  readonly held: ManyWords | null
  readonly danger?: boolean
}

export interface Bar {
  /** At most three acts in the bar. */
  readonly promoted: readonly BarAct[]
  /** The rest under More ▾. */
  readonly more: readonly BarAct[]
  /** One line under the bar (a portal order is answered one at a time; a role that acts on none). */
  readonly note: ManyWords | null
}

/** The candidates of a bar in their order, each with its right: the ones without their right are not drawn (never held for it). */
export interface BarCandidate extends BarAct {
  readonly right: boolean
}

/** The bar from its candidates: drawn = with its right; the first three stand, the rest go under More ▾. */
export function barFrom(candidates: readonly BarCandidate[], note: ManyWords | null, noAct: ManyWords): Bar {
  const drawn = candidates.filter((candidate) => candidate.right).map((candidate): BarAct => ({ id: candidate.id, label: candidate.label, held: candidate.held, ...(candidate.danger ? { danger: true } : {}) }))
  return { promoted: drawn.slice(0, 3), more: drawn.slice(3), note: drawn.length === 0 ? noAct : note }
}

/** The bar's "no act" line (a role that reads these and changes none: Read-only). */
export const NO_ACT: ManyWords = Object.freeze({ ns: 'before-order', key: 'acts.noAct' })

/** A new batch's id (one per run of a window: one bell per batch, S2). */
export const newBatchId = (): string => globalThis.crypto.randomUUID()
