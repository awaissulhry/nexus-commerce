import type { Department } from '../../../../../lib/department/model'
import type { RouteStep } from '../route/api'
import { problemKeyOf, type DeptLook, type Words } from '../route/model'
import type { ProductStepOut, RouteBody, RouteSource, RouteTemplate, StepOut } from './api'

/**
 * owb-pd6 step 6.2 (S4; design plan § 5w; prototype prod.js routeBuilder, rbErrors, rbAdd, rbDrop, rbMove, rbUp, rbDown, rbDel,
 * rbCopy, rbSaveTpl, rbSave) — the route builder's pure side. ONE window is the ONE place a route changes: the product's route, a
 * model or customer route, one order line's exception. The route is free: any order, a department may be there twice. Two rules
 * hold Save (two steps or more · the last step is Packing; a closed department may not be added new); no quality check is a note.
 * The builder's own: a new route needs a name (and its customer when it is only for one), a line needs its reason, minutes are a
 * number. No React, no API.
 */

export type BuilderMode = 'product' | 'route' | 'new' | 'line'

export interface BuilderStep {
  /** The row's own key (a department may be there twice). */
  readonly key: string
  /** The product route's routing step: kept, its depth survives the save. Absent: a new step. */
  readonly stepId?: string
  /** '' when the step came without a department (an old step): it must be taken out. */
  readonly departmentId: string
  /** As typed ('' = none). */
  readonly minutes: string
  /** Added (or copied) in this window: a closed department may not come in new. */
  readonly fresh: boolean
}

export interface BuilderState {
  readonly mode: BuilderMode
  readonly steps: readonly BuilderStep[]
  /** A model or customer route's name. */
  readonly name: string
  /** MODEL: a model, for any customer (sales picks it); CUSTOMER: only for one customer (used by itself on its orders). */
  readonly forWhom: 'MODEL' | 'CUSTOMER'
  readonly partyId: string | null
  /** A line's exception: why this order is different (required). */
  readonly reason: string
  /** The next row key's number. */
  readonly next: number
}

/** A step the builder starts from. */
export interface StartStep {
  readonly stepId?: string
  readonly departmentId: string | null | undefined
  readonly minutes: string | null | undefined
}

export const NAME_MAX = 80
export const REASON_MAX = 500
export const TEMPLATE_NAME_MAX = 80
const MINUTES = /^\d{1,5}(?:\.\d{1,3})?$/

/** A decimal of the server as the field shows it: "12.500" → "12.5", null → "". */
export function minutesInputOf(value: string | null | undefined): string {
  const text = value?.trim() ?? ''
  if (!/^\d+(?:\.\d+)?$/.test(text)) return ''
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text
}

/** What the field holds, as the server reads it: undefined for none, null for a value that is not minutes. */
export function minutesOut(text: string): string | undefined | null {
  const value = text.trim().replace(',', '.')
  if (value === '') return undefined
  return MINUTES.test(value) ? value : null
}

export function startBuilder(mode: BuilderMode, steps: readonly StartStep[], extras: { name?: string; forWhom?: 'MODEL' | 'CUSTOMER'; partyId?: string | null; fresh?: boolean } = {}): BuilderState {
  return {
    mode,
    steps: steps.map((step, index) => ({ key: `s${index}`, ...(mode === 'product' && step.stepId ? { stepId: step.stepId } : {}), departmentId: step.departmentId ?? '', minutes: minutesInputOf(step.minutes), fresh: extras.fresh === true })),
    name: extras.name ?? '',
    forWhom: extras.forWhom ?? 'MODEL',
    partyId: extras.partyId ?? null,
    reason: '',
    next: steps.length,
  }
}

// ---- changing the route ---------------------------------------------------------------------------------------------------------

/** A department's kind (PACKING, INSPECTION …); null: not known. */
export type KindOf = (departmentId: string) => string | null
export const kindOfLooks =
  (looks: readonly DeptLook[]): KindOf =>
  (departmentId) =>
    looks.find((look) => look.id === departmentId)?.kind ?? null

/** Where + puts a department: at the end, but before a last Packing step (unless it is Packing itself). */
export function endIndexFor(state: BuilderState, departmentId: string, kindOf: KindOf): number {
  const last = state.steps[state.steps.length - 1]
  return last && kindOf(departmentId) !== 'PACKING' && kindOf(last.departmentId) === 'PACKING' ? state.steps.length - 1 : state.steps.length
}

/** A department into the route: at `at` (a drop on a row), else where + puts it. */
export function addStep(state: BuilderState, departmentId: string, kindOf: KindOf, at?: number): BuilderState {
  const index = Math.max(0, Math.min(state.steps.length, at ?? endIndexFor(state, departmentId, kindOf)))
  const step: BuilderStep = { key: `s${state.next}`, departmentId, minutes: '', fresh: true }
  return { ...state, steps: [...state.steps.slice(0, index), step, ...state.steps.slice(index)], next: state.next + 1 }
}

/** A step to another place (drag, ↑ / ↓, Alt+↑ / Alt+↓); out of range: nothing. */
export function moveStep(state: BuilderState, from: number, to: number): BuilderState {
  if (from < 0 || from >= state.steps.length || to < 0 || to >= state.steps.length || from === to) return state
  const steps = [...state.steps]
  const [moved] = steps.splice(from, 1)
  steps.splice(to, 0, moved!)
  return { ...state, steps }
}

/** The order the sortable list hands back (its keys); a list that does not hold exactly the route's keys changes nothing. */
export function reorderSteps(state: BuilderState, keys: readonly string[]): BuilderState {
  if (keys.length !== state.steps.length) return state
  const byKey = new Map(state.steps.map((step) => [step.key, step]))
  const steps = keys.map((key) => byKey.get(key))
  return steps.every((step): step is BuilderStep => step !== undefined) && new Set(keys).size === keys.length ? { ...state, steps } : state
}

/** Take a step out. */
export function removeStep(state: BuilderState, index: number): BuilderState {
  if (index < 0 || index >= state.steps.length) return state
  return { ...state, steps: state.steps.filter((_, at) => at !== index) }
}

export function setMinutes(state: BuilderState, index: number, text: string): BuilderState {
  if (index < 0 || index >= state.steps.length) return state
  return { ...state, steps: state.steps.map((step, at) => (at === index ? { ...step, minutes: text.slice(0, 9) } : step)) }
}

/** "Start from a copy": the copied steps replace the route's (new rows: no step is kept). */
export function copySteps(state: BuilderState, steps: readonly Pick<RouteStep, 'departmentId' | 'minutes'>[]): BuilderState {
  return { ...state, steps: steps.map((step, index) => ({ key: `s${state.next + index}`, departmentId: step.departmentId, minutes: minutesInputOf(step.minutes), fresh: true })), next: state.next + steps.length }
}

export const setName = (state: BuilderState, name: string): BuilderState => ({ ...state, name: name.slice(0, NAME_MAX) })
export const setReason = (state: BuilderState, reason: string): BuilderState => ({ ...state, reason: reason.slice(0, REASON_MAX) })
export const setForWhom = (state: BuilderState, forWhom: 'MODEL' | 'CUSTOMER', partyId: string | null): BuilderState => ({ ...state, forWhom, partyId: forWhom === 'MODEL' ? null : partyId })

/** How often each department is in the route (the small "2 ×" beside it). */
export function countsOf(state: BuilderState): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const step of state.steps) if (step.departmentId) counts.set(step.departmentId, (counts.get(step.departmentId) ?? 0) + 1)
  return counts
}

// ---- the rules ---------------------------------------------------------------------------------------------------------------

export type RouteError = 'TOO_FEW' | 'LAST_NOT_PACKING' | 'DEPARTMENT_CLOSED'
export type RouteWarning = 'NO_QUALITY'

/**
 * The server's rules (D/product/routing/rules.ts routeProblems, the same codes): fewer than two steps · the last step is not of
 * kind PACKING · a closed department added new; the note: no step of kind INSPECTION.
 */
export function routeProblems(steps: readonly Pick<BuilderStep, 'departmentId' | 'fresh'>[], looks: readonly DeptLook[]): { errors: RouteError[]; warnings: RouteWarning[] } {
  const look = (id: string) => looks.find((entry) => entry.id === id)
  const errors: RouteError[] = []
  if (steps.length < 2) errors.push('TOO_FEW')
  const last = steps[steps.length - 1]
  if (!last || look(last.departmentId)?.kind !== 'PACKING') errors.push('LAST_NOT_PACKING')
  if (steps.some((step) => step.fresh && look(step.departmentId)?.closed === true)) errors.push('DEPARTMENT_CLOSED')
  const warnings: RouteWarning[] = steps.some((step) => look(step.departmentId)?.kind === 'INSPECTION') ? [] : ['NO_QUALITY']
  return { errors, warnings }
}

export interface BuilderIssue {
  readonly code: string
  readonly words: Words
}

/** What holds Save (errors), and the notes that do not: the route's rules, then the window's own. */
export function builderProblems(state: BuilderState, looks: readonly DeptLook[]): { errors: BuilderIssue[]; notes: BuilderIssue[] } {
  const rules = routeProblems(state.steps, looks)
  const errors: BuilderIssue[] = rules.errors.map((code) => ({ code, words: { key: `rule.${code}` } }))
  state.steps.forEach((step, index) => {
    if (!step.departmentId) errors.push({ code: 'NO_DEPARTMENT', words: { key: 'builder.error.NO_DEPARTMENT', params: { no: index + 1 } } })
    else if (minutesOut(step.minutes) === null) errors.push({ code: 'MINUTES_BAD', words: { key: 'builder.error.MINUTES_BAD', params: { no: index + 1 } } })
  })
  if ((state.mode === 'new' || state.mode === 'route') && !state.name.trim()) errors.push({ code: 'NAME_NEEDED', words: { key: 'builder.error.NAME_NEEDED' } })
  if ((state.mode === 'new' || state.mode === 'route') && state.forWhom === 'CUSTOMER' && !state.partyId) errors.push({ code: 'CUSTOMER_NEEDED', words: { key: 'builder.error.CUSTOMER_NEEDED' } })
  if (state.mode === 'line' && !state.reason.trim()) errors.push({ code: 'REASON_NEEDED', words: { key: 'builder.error.REASON_NEEDED' } })
  const notes: BuilderIssue[] = rules.errors.length === 0 && rules.warnings.includes('NO_QUALITY') ? [{ code: 'NO_QUALITY', words: { key: 'builder.note.NO_QUALITY' } }] : []
  const twice = state.steps.find((step, index) => index > 0 && step.departmentId !== '' && state.steps[index - 1]!.departmentId === step.departmentId)
  const twiceDept = twice ? looks.find((entry) => entry.id === twice.departmentId) : undefined
  if (twiceDept) notes.push({ code: 'TWICE_IN_A_ROW', words: { key: 'builder.note.twice', params: { name: twiceDept.dept.shortName } } })
  return { errors, notes }
}

/** Why Save is held: the first error's words; a save running; null: it saves. */
export function saveHeldOf(state: BuilderState, looks: readonly DeptLook[], busy: boolean): Words | null {
  if (busy) return { key: 'held.busy' }
  return builderProblems(state, looks).errors[0]?.words ?? null
}

// ---- what is sent -----------------------------------------------------------------------------------------------------------

/** The route's steps as sent: the department and, when typed, the minutes. */
export function stepsOut(state: BuilderState): StepOut[] {
  return state.steps.map((step) => {
    const minutes = minutesOut(step.minutes)
    return { departmentId: step.departmentId, ...(minutes ? { minutes } : {}) }
  })
}

/** `PUT …/routing/steps`: the whole product route; a kept step names its `stepId` (its depth survives), a new one does not. */
export function productBody(state: BuilderState, version: number): { version: number; steps: ProductStepOut[] } {
  const out = stepsOut(state)
  return { version, steps: state.steps.map((step, index) => ({ ...(step.stepId ? { stepId: step.stepId } : {}), ...out[index]! })) }
}

/** `POST …/routes` / `PUT …/routes/:id`: name, who it is for, the steps. */
export function routeBody(state: BuilderState): RouteBody {
  return { name: state.name.trim(), kind: state.forWhom, partyId: state.forWhom === 'CUSTOMER' ? state.partyId : null, steps: stepsOut(state) }
}

/** `PUT …/lines/:lineId/route-exception`: the steps and why (the line's version when it has one). */
export function lineBody(state: BuilderState, version: number | null): { version?: number; steps: StepOut[]; reason: string } {
  return { ...(version !== null ? { version } : {}), steps: stepsOut(state), reason: state.reason.trim() }
}

// ---- ready-made routes and "Start from a copy" -------------------------------------------------------------------------------

/** Why "Save as ready-made" is held: the route's rules, a name, a name used by another ready-made route (open or closed). */
export function templateHeldOf(state: BuilderState, name: string, templates: readonly RouteTemplate[], looks: readonly DeptLook[], busy: boolean): Words | null {
  if (busy) return { key: 'held.busy' }
  const rules = routeProblems(state.steps, looks).errors
  if (rules.length > 0) return { key: `rule.${rules[0]}` }
  const wanted = name.trim().toLowerCase()
  if (!wanted) return { key: 'builder.template.nameNeeded' }
  const same = templates.find((entry) => entry.name.trim().toLowerCase() === wanted)
  if (same) return { key: same.status === 'CLOSED' ? 'builder.template.nameClosed' : 'builder.template.nameTaken' }
  return null
}

export interface CopyOption {
  /** `tpl:<id>`, `prod:<styleId>`, `var:<styleId>:<routeId>`. */
  readonly value: string
  readonly name: string
  readonly steps: number
}

/** The choices of "Start from a copy": the OPEN ready-made routes, then each product's route and its model and customer routes. */
export function copyOptionsOf(templates: readonly RouteTemplate[], sources: readonly RouteSource[]): { templates: CopyOption[]; products: CopyOption[] } {
  return {
    templates: templates.filter((entry) => entry.status === 'OPEN').map((entry) => ({ value: `tpl:${entry.id}`, name: entry.name, steps: entry.steps.length })),
    products: sources.flatMap((product) => [
      { value: `prod:${product.styleId}`, name: `${product.code} ${product.name}`, steps: product.product.length },
      ...product.routes.map((route) => ({ value: `var:${product.styleId}:${route.id}`, name: `${product.code} ${product.name} · ${route.name}`, steps: route.steps.length })),
    ]),
  }
}

/** The steps a choice copies; null: the choice is not (or no longer) there. */
export function copyStepsOf(value: string, templates: readonly RouteTemplate[], sources: readonly RouteSource[]): readonly RouteStep[] | null {
  const [kind, first, second] = value.split(':')
  if (kind === 'tpl') return templates.find((entry) => entry.id === first)?.steps ?? null
  const product = sources.find((entry) => entry.styleId === first)
  if (!product) return null
  if (kind === 'prod') return product.product
  if (kind === 'var') return product.routes.find((route) => route.id === second)?.steps ?? null
  return null
}

// ---- the window's rows -----------------------------------------------------------------------------------------------------------

export interface PaletteRow {
  readonly id: string
  readonly dept: Department
  /** How often it is in the route now (0: not in it). */
  readonly count: number
  /** Made in this window (the mark "new"). */
  readonly fresh: boolean
}

/** The departments to add: the open ones, in the factory's order. */
export function paletteOf(state: BuilderState, looks: readonly DeptLook[], fresh: ReadonlySet<string>): PaletteRow[] {
  const counts = countsOf(state)
  return looks.filter((look) => !look.closed).map((look) => ({ id: look.id, dept: look.dept, count: counts.get(look.id) ?? 0, fresh: fresh.has(look.id) }))
}

export interface StepRow {
  readonly key: string
  readonly no: number
  readonly dept: Department | null
  readonly minutes: string
  readonly minutesBad: boolean
}

export function stepRowsOf(state: BuilderState, looks: readonly DeptLook[]): StepRow[] {
  return state.steps.map((step, index) => ({ key: step.key, no: index + 1, dept: looks.find((look) => look.id === step.departmentId)?.dept ?? null, minutes: step.minutes, minutesBad: minutesOut(step.minutes) === null }))
}

// ---- a refusal in words -----------------------------------------------------------------------------------------------------------

/** The refusal codes the server sends that this window says in its own words (the server's English is for logs). */
export const REFUSAL_CODES = ['NAME_EMPTY', 'NAME_TAKEN', 'FLOOR_FIXED', 'FROZEN', 'PRINTED', 'NOT_DRAFT'] as const
const RULE_CODES: readonly string[] = ['TOO_FEW', 'LAST_NOT_PACKING', 'DEPARTMENT_CLOSED']

/** Every code a refusal carries: its own, each issue's, the last part of each issue's path (`name/NAME_TAKEN`). */
export function refusalCodesOf(error: unknown): string[] {
  const value = error as { code?: unknown; issues?: ReadonlyArray<{ code?: unknown; path?: unknown }> } | null
  const codes: string[] = []
  if (typeof value?.code === 'string') codes.push(value.code)
  for (const issue of value?.issues ?? []) {
    if (typeof issue.code === 'string') codes.push(issue.code)
    const path = typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('/') : ''
    const last = path.split(/[/.]/).pop()
    if (last) codes.push(last)
  }
  return codes
}

/** A refused write in this web's words: a known refusal or rule code first, else by the kind of answer (conflict, forbidden …). */
export function refusalOf(error: unknown): Words {
  const codes = refusalCodesOf(error)
  const known = codes.find((code) => (REFUSAL_CODES as readonly string[]).includes(code))
  if (known) return { key: `refusal.${known}` }
  const rule = codes.find((code) => RULE_CODES.includes(code))
  if (rule) return { key: `rule.${rule}` }
  return { key: problemKeyOf(error) }
}
