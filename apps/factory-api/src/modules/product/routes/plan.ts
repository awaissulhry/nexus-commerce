import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import type { RouteRulesView, RouteStepView } from '@nexus/factory-domain/product/routing/contracts'
import { minutesOf } from '@nexus/factory-domain/product/routing/operations'
import { routeProblems, ROUTE_RULE_WORDS, SEQ_STEP, type RouteRules } from '@nexus/factory-domain/product/routing/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { readDepartments, type RoutingDepartment } from '../routing/read'

/**
 * The steps of a route that is not the revision's routing (owb-pd2 2.3, 2.4): a model or customer route (StyleRoute), a ready-made
 * route (RouteTemplate), one order line's exception — checked and planned the same way, under the same rules as the product route
 * (factory-domain routeProblems; the route builder's save, ../routing/save.ts, is the product route's own).
 *
 *   department  of the tenant, of the route's company or the whole factory (400 with the step's path otherwise)
 *   minutes     typed: above 0, at most 3 decimals kept (factory-domain minutesOf); left out: none said
 *   operation   a style route's step works with its department's ONE default library operation (owb-b1 G3); a department without
 *               one is refused in words (400)
 *   rules       TOO_FEW, LAST_NOT_PACKING, DEPARTMENT_CLOSED (a closed department that was not in the route before) refuse: 400 with
 *               each code at `refusal/<code>` in words; NO_QUALITY is a note (`rules.warnings`)
 */

export interface PlannedRouteStep {
  readonly seq: number
  readonly departmentId: string
  /** The department's default library operation (only when asked: a style route's step). */
  readonly operationId: string | null
  /** Minutes per garment as stored ("12.5"); null: none said. */
  readonly minutes: string | null
}

export interface RoutePlan {
  readonly steps: readonly PlannedRouteStep[]
  readonly rules: RouteRules
  readonly departments: readonly RoutingDepartment[]
}

/** A save refused by the route rules: 400, each error's code at `refusal/<code>`, in words. */
export function ruleRefusal(codes: readonly (keyof typeof ROUTE_RULE_WORDS)[]): ValidationError {
  const issues = codes.map((code) => ({ path: `refusal/${code}`, message: ROUTE_RULE_WORDS[code].en }))
  return new ValidationError(issues.map((issue) => issue.message).join(' '), issues)
}

/** The steps sent, checked and planned (see the header); `before`: the departments the route had (a closed one may stay). */
export async function planRouteSteps(
  tx: CommandTx,
  input: { readonly steps: readonly { readonly departmentId: string; readonly minutes?: string | undefined }[]; readonly companyId: string | null; readonly before?: readonly string[]; readonly withOperation: boolean; readonly at?: string },
): Promise<RoutePlan> {
  const at = input.at ?? 'body/steps'
  const departments = await readDepartments(tx)
  const byId = new Map(departments.map((department) => [department.id, department]))
  const issues: Issue[] = []
  input.steps.forEach((step, index) => {
    const department = byId.get(step.departmentId)
    if (!department) issues.push({ path: `${at}/${index}/departmentId`, message: 'No such department.' })
    else if (department.companyId !== null && department.companyId !== input.companyId) issues.push({ path: `${at}/${index}/departmentId`, message: `Department ${department.number} belongs to another company.` })
    if (step.minutes !== undefined) {
      const minutes = minutesOf(step.minutes)
      if (!minutes.ok) issues.push({ path: `${at}/${index}/minutes`, message: minutes.message })
    }
  })
  if (issues.length > 0) throw new ValidationError('The route is not valid.', issues)
  const before = new Set(input.before ?? [])
  const rules = routeProblems(input.steps.map((step) => ({ departmentId: step.departmentId, isNew: !before.has(step.departmentId) })), departments)
  if (rules.errors.length > 0) throw ruleRefusal(rules.errors)

  let defaults = new Map<string, string>()
  if (input.withOperation && input.steps.length > 0) {
    const rows = await tx.operation.findMany({ where: { departmentId: { in: [...new Set(input.steps.map((step) => step.departmentId))] }, departmentDefault: true }, select: { id: true, departmentId: true } })
    defaults = new Map(rows.flatMap((row) => (row.departmentId ? [[row.departmentId, row.id] as const] : [])))
    input.steps.forEach((step, index) => {
      if (!defaults.has(step.departmentId)) issues.push({ path: `${at}/${index}/departmentId`, message: `Department ${byId.get(step.departmentId)!.number} has no default operation in the library: add the department again in the route builder.` })
    })
    if (issues.length > 0) throw new ValidationError('The route is not valid.', issues)
  }
  const steps = input.steps.map((step, index): PlannedRouteStep => {
    const minutes = step.minutes === undefined ? null : minutesOf(step.minutes)
    return { seq: (index + 1) * SEQ_STEP, departmentId: step.departmentId, operationId: input.withOperation ? defaults.get(step.departmentId)! : null, minutes: minutes?.ok ? minutes.minutes : null }
  })
  return { steps, rules, departments }
}

/** A route's steps as the builder reads them: the department's number with each, minutes as plain text. */
export function routeStepViews(steps: readonly { readonly id?: string | null; readonly seq: number; readonly departmentId: string; readonly minutes: { toString(): string } | string | null }[], departments: readonly Pick<RoutingDepartment, 'id' | 'number'>[]): RouteStepView[] {
  const numberOf = new Map(departments.map((department) => [department.id, department.number]))
  return [...steps]
    .sort((a, b) => a.seq - b.seq)
    .map((step) => ({
      ...(step.id ? { stepId: step.id } : {}),
      departmentId: step.departmentId,
      number: numberOf.get(step.departmentId) ?? 0,
      minutes: step.minutes === null ? null : decimalText(step.minutes.toString()),
    }))
}

/** The rules of a route as it is (nothing added new): for a view. */
export function rulesOf(steps: readonly { readonly departmentId: string }[], departments: readonly RoutingDepartment[]): RouteRulesView {
  const rules = routeProblems(steps.map((step) => ({ departmentId: step.departmentId })), departments)
  return { errors: [...rules.errors], warnings: [...rules.warnings] }
}
