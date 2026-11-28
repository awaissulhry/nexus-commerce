import { departmentByNo, departmentOfAnswer, type Department, type DepartmentAnswer } from '../../../../../lib/department/model'
import { NO_RULES, type RouteParty, type RouteRouting, type RouteRules, type StyleRouteView } from './api'

/**
 * owb-pd6 step 6.1 (S4; design plan § 5u, § 5v, § 5w; prototype prod.js prodOpsTab, routeVariants, deptWord) — the Route tab's pure
 * side: the departments as the route parts read them, the chips (the product's route and one per model or customer route), the
 * steps table of the chosen route, the rules as notes, who may open the builder and why not, in words (catalogue `products-route`).
 * No React, no API.
 */

/** Words of the `products-route` catalogue: a key and its parameters. */
export interface Words {
  readonly key: string
  readonly params?: Readonly<Record<string, string | number>>
}

// ---- the departments as the route parts read them -------------------------------------------------------------------------------

/** A department of the factory as the builder and the tab need it: the chip's look, and what the rules and Manage ask. */
export interface DeptLook {
  readonly id: string
  readonly dept: Department
  /** Its work-centre kind (PACKING ends a route, INSPECTION is a quality check); null: the server did not say. */
  readonly kind: string | null
  /** Screens on the floor: fixed name, never closed (design § 5x). */
  readonly floorReady: boolean
  readonly closed: boolean
  readonly version: number | null
  readonly seq: number
}

/** The server's rows in the factory's ONE order (seq, then number), in the page's language. */
export function deptLooksOf(rows: readonly DepartmentAnswer[], locale: string): DeptLook[] {
  return [...rows]
    .sort((a, b) => (a.seq ?? a.number) - (b.seq ?? b.number) || a.number - b.number)
    .map((row) => ({
      id: row.id,
      dept: departmentOfAnswer(row, locale),
      kind: row.workCentreKind ?? null,
      floorReady: row.floorReady === true,
      closed: row.status === 'CLOSED',
      version: row.version ?? null,
      seq: row.seq ?? row.number,
    }))
}

/** The department of a step: by its id among the rows, else by its number (the rows, then the fixed table); null: none names it. */
export function stepDepartment(looks: readonly DeptLook[], departmentId: string | null | undefined, number: number | null | undefined, fixed: readonly Department[]): Department | null {
  if (departmentId) {
    const look = looks.find((entry) => entry.id === departmentId)
    if (look) return look.dept
  }
  if (number == null) return null
  return looks.find((entry) => entry.dept.no === number)?.dept ?? departmentByNo(fixed, number)
}

// ---- the chips and the chosen route ------------------------------------------------------------------------------------------

export interface RouteChip {
  /** null: the product's route. */
  readonly id: string | null
  readonly kind: 'PRODUCT' | 'MODEL' | 'CUSTOMER'
  /** The route's name ('' for the product's route: the view says "Product route"). */
  readonly name: string
  readonly party: RouteParty | null
  readonly pressed: boolean
}

/** The model and customer routes of the revision (none before the server's routes wave). */
export const routesOf = (routing: RouteRouting): readonly StyleRouteView[] => routing.routes ?? []

/** The chosen model or customer route; null: the product's route (also when the chosen one is gone). */
export function chosenRouteOf(routing: RouteRouting, chosen: string | null): StyleRouteView | null {
  return chosen ? (routesOf(routing).find((route) => route.id === chosen) ?? null) : null
}

/** "Product route" first, then one chip per model or customer route, in the server's order. */
export function routeChipsOf(routing: RouteRouting, chosen: string | null): RouteChip[] {
  const picked = chosenRouteOf(routing, chosen)
  return [
    { id: null, kind: 'PRODUCT', name: '', party: null, pressed: picked === null },
    ...routesOf(routing).map((route): RouteChip => ({ id: route.id, kind: route.kind, name: route.name, party: route.party ?? null, pressed: picked?.id === route.id })),
  ]
}

/** A customer as the route parts name it: "CODE · Name". */
export const partyWords = (party: RouteParty): string => `${party.code} · ${party.name}`

/** Who the chosen route is for, in one line. */
export function forWhomOf(route: StyleRouteView | null): Words {
  if (!route) return { key: 'routes.forProduct' }
  if (route.kind === 'CUSTOMER' && route.party) return { key: 'routes.forCustomer', params: { customer: partyWords(route.party) } }
  if (route.party) return { key: 'routes.forModelOnly', params: { customer: partyWords(route.party) } }
  return { key: 'routes.forModel' }
}

/** The answer line: how many steps the product's route has, and how many other routes there are. */
export function answerOf(routing: RouteRouting): Words[] {
  const others = routesOf(routing).length
  return [{ key: 'routes.answerSteps', params: { count: routing.steps.length } }, ...(others > 0 ? [{ key: 'routes.answerOthers', params: { count: others } }] : [])]
}

// ---- the steps table ------------------------------------------------------------------------------------------------------------

export interface RouteRow {
  /** The step's place in the route, from 1. */
  readonly no: number
  /** Its department; null: an old step no department names (drawn by its name). */
  readonly dept: Department | null
  /** The step's own name, shown when no department names it. */
  readonly name: string
  /** Minutes for one piece (a decimal text); null: none typed. */
  readonly minutes: string | null
}

/** The rows of the chosen route: the product's routing steps, or the model or customer route's steps. */
export function routeRowsOf(routing: RouteRouting, route: StyleRouteView | null, looks: readonly DeptLook[], fixed: readonly Department[]): RouteRow[] {
  if (route) return route.steps.map((step, index) => ({ no: index + 1, dept: stepDepartment(looks, step.departmentId, step.number, fixed), name: '', minutes: step.minutes ?? null }))
  return [...routing.steps]
    .sort((a, b) => a.seq - b.seq)
    .map((step, index) => ({ no: index + 1, dept: stepDepartment(looks, step.department?.id, step.department?.number, fixed), name: step.name, minutes: step.standardMinutes }))
}

const DECIMAL = /^\d+(?:\.\d+)?$/

/** The minutes of one piece over the rows (thousandths, no float drift); null: no row has minutes. */
export function totalMinutesOf(rows: readonly Pick<RouteRow, 'minutes'>[]): string | null {
  const typed = rows.map((row) => row.minutes?.trim() ?? '').filter((value) => DECIMAL.test(value))
  if (typed.length === 0) return null
  const thousandths = typed.reduce((sum, value) => {
    const [whole, part = ''] = value.split('.')
    return sum + Number(whole) * 1000 + Number((part + '000').slice(0, 3))
  }, 0)
  const whole = Math.floor(thousandths / 1000)
  const rest = String(thousandths % 1000).padStart(3, '0').replace(/0+$/, '')
  return rest ? `${whole}.${rest}` : String(whole)
}

/** Minutes in the page's language ("12,5" in Italian), at most two decimals. */
export function minutesWords(value: string | null, locale: string): string {
  if (value === null || !DECIMAL.test(value.trim())) return '—'
  return new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { maximumFractionDigits: 2 }).format(Number(value))
}

// ---- the rules as notes ----------------------------------------------------------------------------------------------------------

/** The rule codes this web has words for (the server's routeProblems; D/product/routing/rules.ts). */
export const RULE_ERRORS = ['TOO_FEW', 'LAST_NOT_PACKING', 'DEPARTMENT_CLOSED'] as const
export const RULE_WARNINGS = ['NO_QUALITY'] as const

/** The chosen route's rules (the server's): its errors and warnings as word keys; a code this web does not know says so plainly. */
export function ruleNotesOf(rules: RouteRules | undefined): { errors: string[]; warnings: string[] } {
  const given = rules ?? NO_RULES
  const word = (code: string, known: readonly string[], other: string) => (known.includes(code) ? `rule.${code}` : other)
  return { errors: [...new Set(given.errors.map((code) => word(code, RULE_ERRORS, 'rule.other')))], warnings: [...new Set(given.warnings.map((code) => word(code, RULE_WARNINGS, 'rule.otherWarning')))] }
}

/** The rules of the chosen route: the product's (routing.rules) or the model or customer route's own. */
export const rulesOfChosen = (routing: RouteRouting, route: StyleRouteView | null): RouteRules | undefined => (route ? route.rules : routing.rules)

// ---- who may open the builder, and why not ------------------------------------------------------------------------------------

export interface RouteEditFacts {
  /** product.routing.manage (the production manager; S4 settle 5: the designer and sales never). */
  readonly manage: boolean
  readonly styleStatus: string
  /** The revision in view. */
  readonly revision: { readonly revision: number; readonly status: string } | null
  /** The style's open DRAFT revision, when another than the one in view. */
  readonly draft: { readonly revision: number } | null
  /** The highest revision number the style has (a new one gets the next). */
  readonly highest: number
  readonly busy: boolean
  /** The departments: read (`ready`), still reading, or the read failed. */
  readonly departments: 'ready' | 'reading' | 'failed'
}

/**
 * Why "Edit this route…", "New route…" and "Take out" are held (null: they act). In this order: the right, an archived product, a
 * revision that is not a draft (released: "Start revision n to change the route"), a write running, the departments not read.
 */
export function routeEditHeld(facts: RouteEditFacts): Words | null {
  if (!facts.manage) return { key: 'held.noRight' }
  if (facts.styleStatus === 'ARCHIVED') return { key: 'held.archived' }
  if (!facts.revision) return { key: 'held.noRevision' }
  if (facts.revision.status !== 'DRAFT') {
    if (facts.draft) return { key: 'held.draftOpen', params: { revision: facts.revision.revision, draft: facts.draft.revision } }
    return { key: 'held.released', params: { revision: facts.revision.revision, next: facts.highest + 1 } }
  }
  if (facts.busy) return { key: 'held.busy' }
  if (facts.departments === 'reading') return { key: 'held.departmentsReading' }
  if (facts.departments === 'failed') return { key: 'held.departmentsFailed' }
  return null
}

/** The builder opens only when nothing holds it: the same rule the buttons say (no builder without the right). */
export const mayOpenBuilder = (facts: RouteEditFacts): boolean => routeEditHeld(facts) === null

// ---- a failed call in words -----------------------------------------------------------------------------------------------------

/** A failed read as a `problem.*` key of `products-route` (the API's kind, never its English). */
export function problemKeyOf(error: unknown): string {
  const kind = (error as { kind?: string } | null)?.kind
  switch (kind) {
    case 'forbidden':
    case 'step_up':
      return 'problem.forbidden'
    case 'not_found':
      return 'problem.notFound'
    case 'conflict':
      return 'problem.conflict'
    case 'invalid':
      return 'problem.invalid'
    case 'signed_out':
      return 'problem.signedOut'
    case 'rate_limited':
      return 'problem.rateLimited'
    case 'unavailable':
      return 'problem.offline'
    default:
      return 'problem.unavailable'
  }
}
