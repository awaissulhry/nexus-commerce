import type { Issue } from '../core/errors'
import { Dec } from '../tax/decimal'

/**
 * The guided first load (B-W2a-41; PLT-185; design admin.import "First load, in order"): a company's opening data in
 * the order the records need each other — customers, suppliers, materials, opening stock (its lots name materials and
 * suppliers), open orders — each step with its reconciliation, the sheet against what is loaded now. Pure; the API
 * (platform/imports/guided) reads the jobs and the records.
 *
 *   - a step reads one APPLIED import of its importer for the company (or a tenant-wide one): its sheet rows against the
 *     rows whose record is there now; refused and skipped rows are the difference. Opening stock adds the quantities per
 *     unit (sheet against the posted moves) and, with the cost grain, the value (sheet quantity × unit cost against the
 *     moves' valuation; cent rounding per hide allowed and said). Customers and suppliers are one importer
 *     (`parties.parties`, a `roles` column): the two steps read the same sheet and count the parties each role holds.
 *   - "Done" is a person's word that the step matches, kept as an audit row (no table of its own yet: a schema need in
 *     the step notes). It is refused while an earlier step is not done, without an applied import, or with a difference;
 *     a step with nothing to load is done with that said (open orders have no importer yet: entered as sales orders).
 */

export const FIRST_LOAD_STEPS = ['customers', 'suppliers', 'materials', 'openingStock', 'openOrders'] as const
export type FirstLoadStep = (typeof FIRST_LOAD_STEPS)[number]
export const isFirstLoadStep = (value: unknown): value is FirstLoadStep => (FIRST_LOAD_STEPS as readonly unknown[]).includes(value)

/** Each step's importer; null: no importer yet. */
export const FIRST_LOAD_IMPORTERS: Readonly<Record<FirstLoadStep, string | null>> = Object.freeze({
  customers: 'parties.parties',
  suppliers: 'parties.parties',
  materials: 'product.materials',
  openingStock: 'inventory.opening',
  openOrders: null,
})

/** The audit action that keeps a step's "Done". */
export const FIRST_LOAD_DONE_ACTION = 'imports.firstLoadStepDone'

export interface QuantityLine {
  readonly unit: string
  /** Decimal strings. */
  readonly sheet: string
  readonly loaded: string
}

export interface ValueCheck {
  /** Minor units (cents) of the rows that give a unit cost: sheet quantity × unit cost. */
  readonly sheet: number
  /** Minor units of the same rows' posted moves as valued. */
  readonly loaded: number
  /** Minor units of the rows without a unit cost (valued at the standard cost; nothing in the sheet to compare). */
  readonly atStandard: number
  readonly rowsAtStandard: number
  /** The cents rounding may move (one per posted move). */
  readonly tolerance: number
  readonly currency: string
}

export interface Reconciliation {
  /** Rows in the sheet. */
  readonly rows: number
  /** Rows whose record is there now. */
  readonly loaded: number
  readonly refused: number
  readonly skipped: number
  /** Parties among the loaded rows that hold each role now (customers and suppliers steps). */
  readonly roles?: { readonly customers: number; readonly suppliers: number }
  /** Opening stock: per unit. */
  readonly quantities?: readonly QuantityLine[]
  /** Opening stock, with the cost grain only. */
  readonly value?: ValueCheck
}

export interface Judgement {
  readonly matches: boolean
  /** Each difference in words (path `difference/<what>`). */
  readonly differences: readonly Issue[]
}

const sameDecimal = (a: string, b: string): boolean => new Dec(a).equals(new Dec(b))

/** Whether the sheet and what is loaded agree, and each difference in words. */
export function judge(reconciliation: Reconciliation): Judgement {
  const differences: Issue[] = []
  const { rows, loaded, refused, skipped } = reconciliation
  if (refused > 0) differences.push({ path: 'difference/refused', message: `${refused} row${refused === 1 ? ' was' : 's were'} refused: fix ${refused === 1 ? 'it' : 'them'} in the sheet (download the refused rows) and import again.` })
  if (skipped > 0) differences.push({ path: 'difference/skipped', message: `${skipped} row${skipped === 1 ? ' was' : 's were'} skipped because the record changed after the dry run: import the sheet again.` })
  const gone = rows - loaded - refused - skipped
  if (gone > 0) differences.push({ path: 'difference/missing', message: `${gone} row${gone === 1 ? "'s record is" : "s' records are"} not there any more (archived or moved since the import).` })
  for (const line of reconciliation.quantities ?? []) {
    if (!sameDecimal(line.sheet, line.loaded)) differences.push({ path: `difference/quantity/${line.unit}`, message: `${line.unit}: ${line.sheet} in the sheet, ${line.loaded} loaded.` })
  }
  const value = reconciliation.value
  if (value && Math.abs(value.sheet - value.loaded) > value.tolerance) {
    differences.push({ path: 'difference/value', message: `Stock value: ${(value.sheet / 100).toFixed(2)} ${value.currency} in the sheet, ${(value.loaded / 100).toFixed(2)} ${value.currency} loaded.` })
  }
  return { matches: differences.length === 0 && rows > 0, differences }
}

export interface StepFacts {
  readonly step: FirstLoadStep
  /** The person's "Done" (an audit row), or null. */
  readonly done: { readonly at: string; readonly nothing: boolean } | null
  /** An import of the step's importer still under way (uploaded, planned, applying). */
  readonly running: boolean
  /** The applied import the step reads, with its reconciliation; null: none yet. */
  readonly applied: Reconciliation | null
}

export const STEP_STATES = ['done', 'ready', 'mismatch', 'running', 'todo', 'waiting', 'held'] as const
export type StepState = (typeof STEP_STATES)[number]

/**
 * A step's state: done (a person said so), waiting (an earlier step is not done), held (no importer: only "nothing to
 * load"), running (an import under way), ready (an applied import matches), mismatch (it does not), todo (nothing yet).
 */
export function stepStateOf(facts: StepFacts, earlierDone: boolean): StepState {
  if (facts.done) return 'done'
  if (!earlierDone) return 'waiting'
  if (FIRST_LOAD_IMPORTERS[facts.step] === null) return 'held'
  if (facts.running) return 'running'
  if (facts.applied) return judge(facts.applied).matches ? 'ready' : 'mismatch'
  return 'todo'
}

/** What stops "Done" (409 issues): an earlier step, no import, a difference. `nothing`: done with nothing to load. */
export function doneProblems(input: { readonly step: FirstLoadStep; readonly earlier: readonly { readonly step: FirstLoadStep; readonly done: boolean }[]; readonly applied: Reconciliation | null; readonly nothing: boolean; readonly alreadyDone: boolean }): Issue[] {
  const problems: Issue[] = []
  if (input.alreadyDone) problems.push({ path: 'step/done', message: 'This step is done already.' })
  const open = input.earlier.filter((step) => !step.done)
  if (open.length > 0) problems.push({ path: `step/waiting/${open[0]!.step}`, message: `Finish the earlier steps first, in order (${open.map((step) => step.step).join(', ')}).` })
  if (input.nothing) {
    if (input.applied && input.applied.loaded > 0) problems.push({ path: 'body/nothing', message: 'An import of this step loaded records: mark it done with its reconciliation, not as "nothing to load".' })
    return problems
  }
  if (FIRST_LOAD_IMPORTERS[input.step] === null) {
    problems.push({ path: 'step/noImporter', message: 'Open orders have no importer yet: enter them as sales orders (Sales › Orders), then mark this step "nothing to load".' })
    return problems
  }
  if (!input.applied) {
    problems.push({ path: 'step/noImport', message: 'Import the sheet of this step first (Download template, then Import a sheet).' })
    return problems
  }
  problems.push(...judge(input.applied).differences)
  if (input.applied.rows === 0) problems.push({ path: 'difference/empty', message: 'The import had no rows.' })
  return problems
}
