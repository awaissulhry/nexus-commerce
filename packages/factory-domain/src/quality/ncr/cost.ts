import type { Issue } from '../../core/errors'

/**
 * The cost of an NCR (B-W2b-113; QHS-086 "NCR cost comes with standard versus actual cost"; design quality.ncr record tab
 * "Cost" ncr-cost: "Material, labour, rework time, scrap value, freight … Lines with amounts and source (computed from moves
 * and rework scans, or typed); total" — "Typed lines autosave; computed lines read-only with SourceIndicator" — "cost: whole
 * tab; wages grain hides labour rates (only the labour total shows)"). Pure: the kinds, what a typed line needs, the total,
 * and how a fresh computation replaces the computed lines (one per record it was computed from).
 *
 * Every amount is the cost grain (money.cost): the office with it sees and types them; nobody else, never the floor, never a
 * partner, never a letter or a report that leaves the company. Amounts are whole minor units of the company's currency,
 * from 0. The …_quality_problems_w2b_guards trigger (NcrCostLine_guard) holds the same rules for every login: writes only
 * while the NCR is neither CLOSED nor CANCELLED; a COMPUTED line names its record, a TYPED one none; OTHER says what.
 *
 * What is computed (the cost ledger and the stock valuation already value it; nothing is guessed):
 *   SCRAP_VALUE  each SCRAP decision of the NCR (one line per decision, its record the NcrDispositionLine): carried out, the
 *                SCRAP moves it posted — their work order cost entries (the ledger's SCRAP), else the lot's valuation × the
 *                quantity moved; not carried out yet, the lot's valuation × the quantity decided (when the NCR names its lot
 *                in the material's base unit). And each rework order opened for the NCR that ended in scrap: the ledger's
 *                SCRAP entries it posted (B-W2b-22). A decision or rework not valued yet waits, said in words.
 * Labour, rework time, freight and material lines are typed (a labour rate per work centre is the costing's own; the screen
 * shows the total, never a rate).
 */

export const COST_KINDS = ['MATERIAL', 'LABOUR', 'REWORK_TIME', 'SCRAP_VALUE', 'FREIGHT', 'OTHER'] as const
export type CostKind = (typeof COST_KINDS)[number]
export const COST_SOURCES = ['TYPED', 'COMPUTED'] as const
export type CostSource = (typeof COST_SOURCES)[number]

export const COST_LIMITS = Object.freeze({
  /** Lines of one NCR. */
  lines: 60,
  description: 200,
  /** The largest amount of one line: 100 million in minor units (one million euro). */
  amount: 100_000_000,
})

/** The record a computed line is computed from. */
export const COMPUTED_RECORD_TYPES = ['NcrDispositionLine', 'ReworkOrder'] as const
export type ComputedRecordType = (typeof COMPUTED_RECORD_TYPES)[number]

export interface CostLineDraft {
  readonly kind?: CostKind | undefined
  readonly description?: string | null | undefined
  readonly amount?: number | null | undefined
}

/** A typed line as written: problems at body/<field>. `creating`: kind and amount are required. */
export function costLineProblems(draft: CostLineDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating && draft.kind === undefined) problems.push({ path: 'body/kind', message: 'What the cost is: material, labour, rework time, scrap value, freight or other.' })
  if (creating && (draft.amount === undefined || draft.amount === null)) problems.push({ path: 'body/amount', message: 'The amount, from 0.' })
  if (draft.amount !== undefined && draft.amount !== null && (!Number.isInteger(draft.amount) || draft.amount < 0 || draft.amount > COST_LIMITS.amount)) {
    problems.push({ path: 'body/amount', message: `A whole amount in cents, from 0 to ${COST_LIMITS.amount}.` })
  }
  const words = draft.description === undefined ? undefined : (draft.description ?? '').trim()
  if (words !== undefined && words.length > COST_LIMITS.description) problems.push({ path: 'body/description', message: `At most ${COST_LIMITS.description} characters.` })
  return problems
}

/** OTHER says what it is in words (checked against the line as it will be). */
export function otherNeedsWords(kind: CostKind, description: string | null): Issue | null {
  return kind === 'OTHER' && !(description ?? '').trim() ? { path: 'body/description', message: 'Say what the cost is (other).' } : null
}

/** The NCR's cost: the sum of its lines (minor units). */
export const costTotal = (lines: readonly { readonly amount: number }[]): number => lines.reduce((sum, line) => sum + line.amount, 0)

/** One line a computation found: its record and amount. */
export interface ComputedLine {
  readonly kind: CostKind
  readonly recordType: ComputedRecordType
  readonly recordId: string
  readonly amount: number
  readonly description: string
}

/** A stored computed line (its id and version). */
export interface StoredComputed {
  readonly id: string
  readonly recordType: string | null
  readonly recordId: string | null
  readonly kind: CostKind
  readonly amount: number
  readonly description: string | null
}

export interface ComputePlan {
  readonly add: readonly ComputedLine[]
  readonly change: readonly { readonly id: string; readonly line: ComputedLine }[]
  readonly remove: readonly string[]
}

const keyOf = (recordType: string | null, recordId: string | null) => `${recordType ?? ''}|${recordId ?? ''}`

/** How a fresh computation replaces the stored computed lines: one line per record, changed in place, gone when it found none. */
export function computePlan(stored: readonly StoredComputed[], fresh: readonly ComputedLine[]): ComputePlan {
  const byKey = new Map(stored.map((line) => [keyOf(line.recordType, line.recordId), line]))
  const seen = new Set<string>()
  const add: ComputedLine[] = []
  const change: { id: string; line: ComputedLine }[] = []
  for (const line of fresh) {
    const key = keyOf(line.recordType, line.recordId)
    seen.add(key)
    const found = byKey.get(key)
    if (!found) add.push(line)
    else if (found.amount !== line.amount || found.kind !== line.kind || (found.description ?? '') !== line.description) change.push({ id: found.id, line })
  }
  const remove = stored.filter((line) => !seen.has(keyOf(line.recordType, line.recordId))).map((line) => line.id)
  return { add, change, remove }
}

export const planIsEmpty = (plan: ComputePlan): boolean => plan.add.length === 0 && plan.change.length === 0 && plan.remove.length === 0

/** Why the cost cannot change now (null: it can), in words: a closed or cancelled NCR keeps its cost as it is. */
export function costHeld(stage: string): string | null {
  return stage === 'CLOSED' || stage === 'CANCELLED' ? `The NCR is ${stage === 'CLOSED' ? 'closed' : 'cancelled'}: its cost never changes.` : null
}
