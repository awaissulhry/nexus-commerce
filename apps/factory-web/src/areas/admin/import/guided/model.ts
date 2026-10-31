import { FIRST_LOAD_STEPS, type FirstLoadStep, type FirstLoadStepView, type Reconciliation, type StepState } from './api'

/**
 * The guided first load (B-W2a-41; PLT-185; design admin.import "First load, in order"): a company's opening data in the
 * order the records need each other — customers, suppliers, materials, opening stock, open orders — each step with its
 * reconciliation (the sheet against what is loaded now) and a person's "Done", refused while it does not match. The
 * API decides each step's state (factory-domain imports/first-load); these rules only say it in the page's words and
 * hold each button with its reason. Pure: the tests hold every rule.
 */

/** A message of `admin-import` with its values. */
export interface Words {
  key: string
  params?: Readonly<Record<string, string | number>>
}

/** The section as the page holds it. */
export interface FirstLoadModel {
  /** The company the first load is for. */
  companyId: string
  steps: readonly FirstLoadStepView[] | null
  complete: boolean
  /** A message key of `admin` when the read failed (other sections keep working). */
  problem: string | null
  /** "Done" or "Nothing to load" asked for a step (the confirm is open). */
  confirm: { step: FirstLoadStep; nothing: boolean; reason: string } | null
  busy: boolean
  /** A receipt or a refusal (message key of `admin-import` or `admin`). */
  notice: { key: string; tone: 'success' | 'info' | 'warning' | 'danger'; params?: Readonly<Record<string, string | number>> } | null
}

export const firstLoadLoading = (companyId: string): FirstLoadModel => ({ companyId, steps: null, complete: false, problem: null, confirm: null, busy: false, notice: null })

/** The step's name and what it holds. */
export const stepName = (step: FirstLoadStep) => `imp.first.step.${step}.name`
export const stepWhat = (step: FirstLoadStep) => `imp.first.step.${step}.what`
export const stateKey = (state: StepState) => `imp.first.state.${state}`

/** The state's tone (a Pill). */
export const STATE_TONE: Readonly<Record<StepState, 'success' | 'warning' | 'info' | 'danger' | 'neutral'>> = {
  done: 'success',
  ready: 'info',
  mismatch: 'danger',
  running: 'info',
  todo: 'warning',
  waiting: 'neutral',
  held: 'neutral',
}

/** The step's place (1 to 5). */
export const stepNumber = (step: FirstLoadStep) => FIRST_LOAD_STEPS.indexOf(step) + 1

/** Rows that should have a record but have none now (archived or moved since). */
export const missingRows = (r: Reconciliation) => Math.max(0, r.rows - r.loaded - r.refused - r.skipped)

/** The reconciliation in words: rows, then the parties' roles, quantities per unit, the stock value (only when sent). */
export function reconciliationWords(step: FirstLoadStep, r: Reconciliation, money: (minor: number, currency: string) => string): Words[] {
  const lines: Words[] = [{ key: 'imp.first.rec.rows', params: { rows: r.rows, loaded: r.loaded } }]
  if (r.roles && step === 'customers') lines.push({ key: 'imp.first.rec.customers', params: { count: r.roles.customers } })
  if (r.roles && step === 'suppliers') lines.push({ key: 'imp.first.rec.suppliers', params: { count: r.roles.suppliers } })
  for (const line of r.quantities ?? []) lines.push({ key: 'imp.first.rec.quantity', params: { unit: line.unit, sheet: line.sheet, loaded: line.loaded } })
  if (r.value) {
    lines.push({ key: 'imp.first.rec.value', params: { sheet: money(r.value.sheet, r.value.currency), loaded: money(r.value.loaded, r.value.currency) } })
    if (r.value.rowsAtStandard > 0) lines.push({ key: 'imp.first.rec.atStandard', params: { count: r.value.rowsAtStandard, value: money(r.value.atStandard, r.value.currency) } })
  }
  return lines
}

/**
 * Each difference in the page's words, from the API's path and the numbers (factory-domain imports/first-load `judge`):
 * refused, skipped and missing rows, a unit's quantities, the stock value, an empty import. A path this web does not know
 * is shown as the API said it (`said`), quoted as data.
 */
export function differenceWords(step: Pick<FirstLoadStepView, 'differences' | 'reconciliation'>, money: (minor: number, currency: string) => string): Array<Words | { said: string }> {
  const r = step.reconciliation
  return step.differences.map((item): Words | { said: string } => {
    if (r && item.path === 'difference/refused') return { key: 'imp.first.diff.refused', params: { count: r.refused } }
    if (r && item.path === 'difference/skipped') return { key: 'imp.first.diff.skipped', params: { count: r.skipped } }
    if (r && item.path === 'difference/missing') return { key: 'imp.first.diff.missing', params: { count: missingRows(r) } }
    if (r && item.path === 'difference/empty') return { key: 'imp.first.diff.empty' }
    if (r?.value && item.path === 'difference/value') return { key: 'imp.first.diff.value', params: { sheet: money(r.value.sheet, r.value.currency), loaded: money(r.value.loaded, r.value.currency) } }
    if (r && item.path.startsWith('difference/quantity/')) {
      const unit = item.path.slice('difference/quantity/'.length)
      const line = r.quantities?.find((entry) => entry.unit === unit)
      if (line) return { key: 'imp.first.diff.quantity', params: { unit, sheet: line.sheet, loaded: line.loaded } }
    }
    return { said: item.message }
  })
}

const stepParam = (step: FirstLoadStep | null): Words['params'] => ({ step: step ? stepNumber(step) : 1 })

/**
 * Why "Import the sheet" is held (a message key and values), or null. A done step and an import under way show a link to
 * the import instead (`importLink`).
 */
export function importHeld(step: FirstLoadStepView): Words | null {
  if (step.state === 'held' || step.importerKey === null) return { key: 'imp.first.held.noImporter' }
  if (step.state === 'waiting') return { key: 'imp.first.held.waiting', params: stepParam(step.waitingFor) }
  if (!step.canImport) return { key: 'imp.first.held.noImportRight' }
  return null
}

/** Why "Done" is held, or null. A mismatch names the first difference; open orders point to "Nothing to load". */
export function doneHeld(step: FirstLoadStepView): Words | null {
  if (step.state === 'done') return { key: 'imp.first.held.done' }
  if (step.state === 'waiting') return { key: 'imp.first.held.waiting', params: stepParam(step.waitingFor) }
  if (step.state === 'held' || step.importerKey === null) return { key: 'imp.first.held.noImporterDone' }
  if (!step.canMarkDone) return { key: 'imp.first.held.noDoneRight' }
  if (step.state === 'running') return { key: 'imp.first.held.running' }
  if (step.state === 'todo') return { key: 'imp.first.held.noImport' }
  if (step.state === 'mismatch') return { key: 'imp.first.held.mismatch', params: { count: Math.max(1, step.differences.length) } }
  return null
}

/** Why "Nothing to load" is held, or null: an import that loaded records says it matches instead. */
export function nothingHeld(step: FirstLoadStepView): Words | null {
  if (step.state === 'done') return { key: 'imp.first.held.done' }
  if (step.state === 'waiting') return { key: 'imp.first.held.waiting', params: stepParam(step.waitingFor) }
  if (!step.canMarkDone) return { key: 'imp.first.held.noDoneRight' }
  if (step.state === 'running') return { key: 'imp.first.held.running' }
  if ((step.reconciliation?.loaded ?? 0) > 0) return { key: 'imp.first.held.loadedSomething' }
  return null
}

/** Where the step's import is: the one under way, else the applied one it reads; null: none. */
export const importLink = (step: Pick<FirstLoadStepView, 'runningJobId' | 'job'>): string | null => step.runningJobId ?? step.job?.id ?? null

/** The "Done" line: when, nothing to load or matched, and whether it still matches now. */
export function doneWords(step: FirstLoadStepView, when: (iso: string) => string): Words | null {
  if (!step.done) return null
  if (step.done.nothing) return step.done.reason ? { key: 'imp.first.done.nothingWhy', params: { when: when(step.done.at), reason: step.done.reason } } : { key: 'imp.first.done.nothing', params: { when: when(step.done.at) } }
  if (step.done.stillMatches === false) return { key: 'imp.first.done.changed', params: { when: when(step.done.at) } }
  return { key: 'imp.first.done.matched', params: { when: when(step.done.at) } }
}

/** How many of the five steps are done. */
export const doneCount = (steps: readonly FirstLoadStepView[]) => steps.filter((step) => step.done !== null).length

/** The reason a "Nothing to load" needs: a few words, as the API keeps it (≤ 500). */
export const reasonProblem = (reason: string): string | null => (reason.trim().length < 3 ? 'imp.first.confirm.reasonShort' : reason.length > 500 ? 'imp.first.confirm.reasonLong' : null)
