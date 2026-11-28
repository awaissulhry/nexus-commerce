import type { Department } from '../../../lib/department/model'
import type { BasketStep } from '../api'
import { deptOf, readyOf } from '../model'

/**
 * owb-fl6 (design § 5zg "ONE way": the step bar → the Steps window → Undo; lead settle 7; P/fsteps.js fstepsModal, fstepTo, fstepMany,
 * fsEditModal, fsApply) — the Steps window and the route editor without a screen. Pure, so the tests hold the rules:
 *   one basket   a row per step and "Ready to ship"; a tap puts it there; forward asks nothing; BACK asks why (only a team leader:
 *                a worker reads "Only the team leader moves a basket back."); Ready to ship only after the last step is reported
 *   many         "Change all" on an order: All · the ones at one step · Choose; a tap on a department moves every chosen basket whose
 *                own route has it (forward or back, one question when any goes back); the others stay, and the window says how many
 *   the route    what is still to come: Skip / Put back, Add a step (before the last), Why? one tap; the last step is never skippable
 */

// ---- one basket -----------------------------------------------------------------------------------------------------------------

export type StepRowState = 'done' | 'here' | 'next' | 'later'

export interface StepRow {
  /** The step's operation, or 'READY'. */
  readonly key: string
  /** The step's operation; null: Ready to ship. */
  readonly operationId: string | null
  readonly dept: Department | null
  readonly name: string
  readonly state: StepRowState
  readonly added: boolean
}

export const READY_KEY = 'READY'

/** The steps that count, in the route's order (a skipped step is not a place). */
const counted = (steps: readonly BasketStep[]): BasketStep[] => steps.filter((step) => step.state !== 'SKIPPED')

/** Where it is on its counted steps: the HERE step, else the first step still to come; the length when every step is reported. */
export function hereIndexOf(steps: readonly BasketStep[]): number {
  const list = counted(steps)
  if (readyOf(steps)) return list.length
  const here = list.findIndex((step) => step.state === 'HERE')
  if (here >= 0) return here
  const first = list.findIndex((step) => step.state === 'NEXT' || step.state === 'TODO')
  return first >= 0 ? first : list.length
}

/** The window's rows: every counted step and "Ready to ship". Done = ticked, "It is here", "Next". */
export function stepRowsOf(steps: readonly BasketStep[], locale: string): StepRow[] {
  const list = counted(steps)
  const at = hereIndexOf(steps)
  const rows = list.map((step, index): StepRow => ({
    key: step.operationId,
    operationId: step.operationId,
    dept: deptOf(step.department, locale),
    name: step.name,
    state: index === at ? 'here' : index === at + 1 ? 'next' : index < at ? 'done' : 'later',
    added: step.added,
  }))
  return [...rows, { key: READY_KEY, operationId: null, dept: null, name: '', state: at >= list.length ? 'here' : at === list.length - 1 ? 'next' : 'later', added: false }]
}

/** Why a basket goes back (design: Work again is a quality fact; Moved by mistake only a correction). */
export const BACK_WHY = ['REDO', 'MISTAKE', 'OTHER'] as const
export type BackWhy = (typeof BACK_WHY)[number]

export type MovePlan =
  /** It is there already. */
  | { readonly kind: 'none' }
  /** Refused in words: a worker moves no basket back; Ready to ship waits for the last step's report (settle 7). */
  | { readonly kind: 'refused'; readonly why: 'leaderBack' | 'packFirst' }
  /** A move back: one more tap, why. */
  | { readonly kind: 'ask'; readonly to: StepRow }
  | { readonly kind: 'go'; readonly move: { readonly kind: 'FORWARD' | 'BACK'; readonly toOperationId: string | null; readonly reason?: BackWhy } }

/** The route's last step has its standing report (a redo after Packing): only then may a hand move make it ready to ship. */
export const lastReportedOf = (steps: readonly BasketStep[]): boolean => {
  const list = counted(steps)
  return list.length > 0 && list[list.length - 1]!.state === 'DONE'
}

/** What a tap on a row does for one basket. */
export function planOne(steps: readonly BasketStep[], rows: readonly StepRow[], target: StepRow, options: { readonly leader: boolean; readonly why?: BackWhy | null }): MovePlan {
  if (target.state === 'here') return { kind: 'none' }
  const at = rows.findIndex((row) => row.state === 'here')
  const to = rows.findIndex((row) => row.key === target.key)
  const back = to < at
  if (target.operationId === null && !back && !lastReportedOf(steps)) return { kind: 'refused', why: 'packFirst' }
  if (back) {
    if (!options.leader) return { kind: 'refused', why: 'leaderBack' }
    if (!options.why) return { kind: 'ask', to: target }
    return { kind: 'go', move: { kind: 'BACK', toOperationId: target.operationId, reason: options.why } }
  }
  return { kind: 'go', move: { kind: 'FORWARD', toOperationId: target.operationId } }
}

// ---- many baskets: "Change all" on an order --------------------------------------------------------------------------------------

export interface ManyBasket {
  readonly bundleId: string
  readonly code: string
  readonly steps: readonly BasketStep[]
}

export type Choice = { readonly mode: 'all' } | { readonly mode: 'at'; readonly departmentId: string } | { readonly mode: 'chosen'; readonly ids: readonly string[] }

/** The department a basket is at now (null: ready to ship, or none named). */
export function hereDepartmentOf(basket: ManyBasket): string | null {
  const list = counted(basket.steps)
  return list[hereIndexOf(basket.steps)]?.department?.id ?? null
}

/** The baskets a choice keeps. */
export function chosenOf<T extends ManyBasket>(baskets: readonly T[], choice: Choice): T[] {
  if (choice.mode === 'all') return [...baskets]
  if (choice.mode === 'at') return baskets.filter((basket) => hereDepartmentOf(basket) === choice.departmentId)
  return baskets.filter((basket) => choice.ids.includes(basket.bundleId))
}

export interface ManyRow {
  /** The department's id, or 'READY'. */
  readonly key: string
  readonly dept: Department | null
  readonly name: string
  /** How many of the chosen baskets are there now. */
  readonly here: number
}

/** The departments of the chosen baskets' routes in route order (the longest route first, the others' own ones after), and Ready to ship. */
export function manyRowsOf(baskets: readonly ManyBasket[], locale: string): ManyRow[] {
  const byLength = [...baskets].sort((a, b) => counted(b.steps).length - counted(a.steps).length)
  const seen = new Map<string, ManyRow>()
  for (const basket of byLength) {
    for (const step of counted(basket.steps)) {
      const id = step.department?.id
      if (!id || seen.has(id)) continue
      seen.set(id, { key: id, dept: deptOf(step.department, locale), name: step.name, here: 0 })
    }
  }
  const rows = [...seen.values()].map((row) => ({ ...row, here: baskets.filter((basket) => hereDepartmentOf(basket) === row.key && !readyOf(basket.steps)).length }))
  return [...rows, { key: READY_KEY, dept: null, name: '', here: baskets.filter((basket) => readyOf(basket.steps)).length }]
}

export interface ManyPlan {
  /** One call per target step and direction (a work order's steps are its own: the same department is another step in another one). */
  readonly groups: readonly { readonly kind: 'FORWARD' | 'BACK'; readonly toOperationId: string | null; readonly bundleIds: readonly string[]; readonly reason?: BackWhy }[]
  /** Baskets whose own route has no such step (or that may not go: a worker's back, Ready to ship before the last report). */
  readonly stay: number
  /** Some go back and no reason was given yet: ask why first. */
  readonly ask: boolean
}

/** Where a tap on a department (or Ready to ship) sends each chosen basket. */
export function planMany(baskets: readonly ManyBasket[], target: string, options: { readonly leader: boolean; readonly why?: BackWhy | null }): ManyPlan {
  const groups = new Map<string, { kind: 'FORWARD' | 'BACK'; toOperationId: string | null; bundleIds: string[]; reason?: BackWhy }>()
  let stay = 0
  let ask = false
  for (const basket of baskets) {
    const list = counted(basket.steps)
    const at = hereIndexOf(basket.steps)
    let to = -1
    if (target === READY_KEY) {
      if (readyOf(basket.steps)) continue
      if (!lastReportedOf(basket.steps)) {
        stay += 1
        continue
      }
      to = list.length
    } else {
      const indexes = list.map((step, index) => (step.department?.id === target ? index : -1)).filter((index) => index >= 0)
      if (indexes.length === 0) {
        stay += 1
        continue
      }
      to = indexes.find((index) => index >= at) ?? indexes[indexes.length - 1]!
      if (to === at) continue
    }
    const back = to < at
    if (back && !options.leader) {
      stay += 1
      continue
    }
    if (back && !options.why) ask = true
    const toOperationId = to >= list.length ? null : list[to]!.operationId
    const kind = back ? 'BACK' : 'FORWARD'
    const key = `${kind}:${toOperationId ?? READY_KEY}`
    const group = groups.get(key) ?? { kind, toOperationId, bundleIds: [], ...(back && options.why ? { reason: options.why } : {}) }
    group.bundleIds.push(basket.bundleId)
    groups.set(key, group)
  }
  return { groups: ask ? [] : [...groups.values()], stay, ask }
}

// ---- the route: what is still to come ---------------------------------------------------------------------------------------------

export const ROUTE_WHY = ['NOT_NEEDED', 'REDO', 'CUSTOMER', 'OTHER'] as const
export type RouteWhy = (typeof ROUTE_WHY)[number]

export interface RouteDraft {
  /** Steps whose skip state is turned (a step to come → skipped; a skipped one → put back). */
  readonly turned: readonly string[]
  /** Departments added (each goes before the last step). */
  readonly adds: readonly string[]
  readonly why: RouteWhy | null
  /** For whom: this basket, all baskets of the order, or the baskets chosen in Change all. */
  readonly scope: 'one' | 'order' | 'chosen'
}

export const EMPTY_DRAFT: RouteDraft = { turned: [], adds: [], why: null, scope: 'one' }

export interface AheadStep {
  readonly operationId: string
  readonly dept: Department | null
  readonly departmentId: string | null
  readonly name: string
  /** Skipped now (after the draft's turns). */
  readonly skipped: boolean
  readonly added: boolean
}

export interface RouteView {
  /** What is still to come, the last step apart (Skip / Put back each). */
  readonly ahead: readonly AheadStep[]
  /** The last step: it stays the last, never skippable. */
  readonly last: AheadStep | null
  /** Something changed: Save may go once a reason is given. */
  readonly changed: boolean
  readonly canSave: boolean
}

/** The route editor's rows: the steps after the one it is at (what is done stays), the last one apart. */
export function routeViewOf(steps: readonly BasketStep[], draft: RouteDraft, locale: string): RouteView {
  const at = steps.findIndex((step) => step.state === 'HERE')
  const from = at >= 0 ? at + 1 : steps.findIndex((step) => step.state === 'NEXT' || step.state === 'TODO' || step.state === 'SKIPPED')
  const rest = from < 0 ? [] : steps.slice(from).filter((step) => step.state !== 'DONE')
  const lastAt = rest.map((step) => step.state !== 'SKIPPED').lastIndexOf(true)
  const of = (step: BasketStep): AheadStep => {
    const was = step.state === 'SKIPPED'
    return { operationId: step.operationId, dept: deptOf(step.department, locale), departmentId: step.department?.id ?? null, name: step.name, skipped: draft.turned.includes(step.operationId) ? !was : was, added: step.added }
  }
  const changed = draft.turned.length + draft.adds.length > 0
  return {
    ahead: rest.filter((_, index) => index !== lastAt).map(of),
    last: lastAt >= 0 ? of(rest[lastAt]!) : null,
    changed,
    canSave: changed && draft.why !== null,
  }
}

/** Turn a step's skip (twice = as it was). The last step is never turned. */
export function turnStep(draft: RouteDraft, view: RouteView, operationId: string): RouteDraft {
  if (view.last?.operationId === operationId) return draft
  return { ...draft, turned: draft.turned.includes(operationId) ? draft.turned.filter((id) => id !== operationId) : [...draft.turned, operationId] }
}

/**
 * The edits the route command takes: SKIP / PUT_BACK name the step (and its department, so the same department's step of another work
 * order takes it too when the change is for many baskets), ADD names a department (it lands before the last step: lead settle 6).
 */
export function editsOf(steps: readonly BasketStep[], draft: RouteDraft): { readonly kind: 'SKIP' | 'PUT_BACK' | 'ADD'; readonly operationId?: string; readonly departmentId?: string }[] {
  const turned = draft.turned.map((operationId) => steps.find((step) => step.operationId === operationId)).filter((step): step is BasketStep => Boolean(step))
  return [
    ...turned.map((step) => ({ kind: step.state === 'SKIPPED' ? ('PUT_BACK' as const) : ('SKIP' as const), operationId: step.operationId, ...(step.department ? { departmentId: step.department.id } : {}) })),
    ...draft.adds.map((departmentId) => ({ kind: 'ADD' as const, departmentId })),
  ]
}

/** What the window says after Save: saved; how many stay (their route has no such step); the warning when no quality check is left. */
export function savedLinesOf(answer: { readonly stay: number; readonly warnings: readonly string[] }): ('saved' | 'stay' | 'noQuality')[] {
  return ['saved', ...(answer.stay > 0 ? (['stay'] as const) : []), ...(answer.warnings.includes('NO_QUALITY_LEFT') ? (['noQuality'] as const) : [])]
}
