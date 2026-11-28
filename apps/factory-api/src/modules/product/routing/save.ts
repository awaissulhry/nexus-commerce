import { DomainError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { RoutingView, SaveRouteStepsBody } from '@nexus/factory-domain/product/routing/contracts'
import { minutesOf, sameMinutes } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { MAX_ROUTING_STEPS, planNewStep, routeProblems, ROUTE_RULE_WORDS, SEQ_STEP, type StepData } from '@nexus/factory-domain/product/routing/rules'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertTypedStepSmv } from '../minutes/governance'
import { readOperations, type OperationFacts } from './read'
import {
  assertMayWrite,
  assertNoLinesUse,
  assertNoWorkOrders,
  auditedStep,
  contextOf,
  deleteSteps,
  departmentOfStep,
  fitsStyle,
  insertSteps,
  invalid,
  isUniqueViolation,
  lockDraft,
  lockOperations,
  moveSteps,
  readDepartments,
  readRevisionFor,
  readSteps,
  routingViewInTx,
  type RoutingDepartment,
  type StepRecord,
} from './store'

/**
 * The route builder's ONE save of a product route (owb-pd2 2.2; design § 5w "Save"; prototype prod.js `rbSave`):
 * `PUT /product/styles/:styleId/revisions/:revisionId/routing/steps { version, steps: [{ stepId?, departmentId, minutes? }] }`, ONE
 * command under the revision's version, DRAFT only, product.routing.manage (the production manager: S4 settle 5 — the designer
 * never opens the builder).
 *
 *   kept step   a step with `stepId` keeps its row, so its depth (cells, checkpoint, settings, size times) survives; only its place,
 *               its minutes (when sent: a typed SMV, under SMV governance) and its department change (its operation stays)
 *   new step    the department's ONE default library operation (owb-b1 G3: Operation.departmentDefault), its departmentId copied;
 *               minutes sent, else the operation's
 *   removed     a step of the routing not named: removed (refused while a BOM line uses it, as one step's removal)
 *   order       the body's order: 10, 20, 30 …; the kept steps move by the reorder's parking (BOM lines follow their step)
 *   rules       factory-domain routeProblems: TOO_FEW, LAST_NOT_PACKING, DEPARTMENT_CLOSED (a closed department added, or a kept step
 *               moved into one) refuse the save — 400 with each code at `refusal/<code>` in words; NO_QUALITY is only a note
 *
 * Answers the routing (the GET's view: steps with their department, the rules). Audit: one row per step written, one on the revision;
 * `style.routing_changed` (the product's history line: no money).
 */

/** The tenant's departments, and the default library operation of each department named (by department id). */
async function departmentFacts(tx: CommandTx, departmentIds: readonly string[]): Promise<{ departments: RoutingDepartment[]; defaultOf: Map<string, OperationFacts> }> {
  const departments = await readDepartments(tx)
  const ids = [...new Set(departmentIds)]
  const defaults = ids.length === 0 ? [] : await tx.operation.findMany({ where: { departmentId: { in: ids }, departmentDefault: true }, select: { id: true, departmentId: true } })
  const operations = await readOperations(tx, defaults.map((row) => row.id))
  return { departments, defaultOf: new Map(defaults.flatMap((row) => (row.departmentId && operations.has(row.id) ? [[row.departmentId, operations.get(row.id)!] as const] : []))) }
}

/** Typed minutes as stored (checked before: a refused value never gets here). */
const typedMinutes = (value: string): string => {
  const minutes = minutesOf(value)
  return minutes.ok ? minutes.minutes : value
}

function ruleRefusal(codes: readonly string[]): ValidationError {
  const issues = codes.map((code) => ({ path: `refusal/${code}`, message: ROUTE_RULE_WORDS[code as keyof typeof ROUTE_RULE_WORDS].en }))
  return new ValidationError(issues.map((issue) => issue.message).join(' '), issues)
}

/** product.routing.saveSteps: the whole product route in one command (see the header). */
export async function saveRouteSteps(caller: CommandCaller, styleId: string, revisionId: string, body: SaveRouteStepsBody, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)
  if (body.steps.length > MAX_ROUTING_STEPS) throw new ValidationError('The route is too long.', [{ path: 'body/steps', message: `A route has at most ${MAX_ROUTING_STEPS} steps.` }])

  const { result } = await command(caller, { name: 'product.routing.saveSteps', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const current = await readSteps(tx, revisionId)
    const byId = new Map(current.map((step) => [step.id, step]))
    const { departments, defaultOf } = await departmentFacts(tx, body.steps.map((step) => step.departmentId))
    const departmentOf = new Map<string, RoutingDepartment>(departments.map((department) => [department.id, department]))

    // ---- what was sent, checked: each kept step once and of this routing, each department of the tenant and the style's company.
    const issues: Issue[] = []
    const named = new Set<string>()
    body.steps.forEach((entry, index) => {
      const at = `body/steps/${index}`
      if (entry.stepId !== undefined) {
        if (!byId.has(entry.stepId)) issues.push({ path: `${at}/stepId`, message: 'Not a step of this routing.' })
        else if (named.has(entry.stepId)) issues.push({ path: `${at}/stepId`, message: 'This step is named twice.' })
        named.add(entry.stepId)
      }
      const department = departmentOf.get(entry.departmentId)
      if (!department) issues.push({ path: `${at}/departmentId`, message: 'No such department.' })
      else if (department.companyId !== null && department.companyId !== draft.style.companyId) issues.push({ path: `${at}/departmentId`, message: `Department ${department.number} belongs to another company than the style's.` })
      if (entry.minutes !== undefined) {
        const minutes = minutesOf(entry.minutes)
        if (!minutes.ok) issues.push({ path: `${at}/minutes`, message: minutes.message })
      }
    })
    if (issues.length > 0) throw invalid(issues, 'route')

    // ---- the rules: a closed department may stay where a kept step had it, never come in new.
    const keptDepartment = (step: StepRecord): string | null => departmentOfStep(step, departments)?.id ?? null
    const rules = routeProblems(
      body.steps.map((entry) => ({ departmentId: entry.departmentId, isNew: entry.stepId === undefined || keptDepartment(byId.get(entry.stepId)!) !== entry.departmentId })),
      departments,
    )
    if (rules.errors.length > 0) throw ruleRefusal(rules.errors)

    // ---- the plan: the kept steps' changes, the new steps (each its department's default operation), the removed steps.
    const newOperations = body.steps.filter((entry) => entry.stepId === undefined).map((entry) => defaultOf.get(entry.departmentId)?.id).filter((id): id is string => id !== undefined)
    await lockOperations(tx, newOperations)
    const planned: StepData[] = []
    const kept: { step: StepRecord; seq: number; minutes: string | null; departmentId: string | null }[] = []
    body.steps.forEach((entry, index) => {
      const seq = (index + 1) * SEQ_STEP
      const at = `body/steps/${index}`
      if (entry.stepId !== undefined) {
        const step = byId.get(entry.stepId)!
        const minutes = entry.minutes === undefined ? null : typedMinutes(entry.minutes)
        const moved = keptDepartment(step) !== entry.departmentId
        kept.push({ step, seq, minutes: minutes !== null && !sameMinutes(minutes, step.standardMinutes) ? minutes : null, departmentId: moved ? entry.departmentId : null })
        return
      }
      const operation = defaultOf.get(entry.departmentId)
      const department = departmentOf.get(entry.departmentId)!
      if (!operation) {
        issues.push({ path: `${at}/departmentId`, message: `Department ${department.number} has no default operation in the library: add the department again in the route builder.` })
        return
      }
      if (!fitsStyle(operation, draft.style.companyId)) {
        issues.push({ path: `${at}/departmentId`, message: `The default operation ${operation.code} of department ${department.number} belongs to another company than the style's.` })
        return
      }
      const plan = planNewStep({ ...operation, departmentId: entry.departmentId }, { ...(entry.minutes !== undefined ? { standardMinutes: entry.minutes } : {}) }, seq)
      if (plan.ok) planned.push({ id: newId(), ...plan.step })
      else issues.push(...plan.issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message })))
    })
    if (issues.length > 0) throw invalid(issues, 'route')
    const removed = current.filter((step) => !named.has(step.id))
    const moves = kept.filter((entry) => entry.step.seq !== entry.seq).map((entry) => ({ id: entry.step.id, from: entry.step.seq, to: entry.seq }))

    // ---- the writes, in an order that keeps every place unique: out, then the moves (parked first), then the changes, then in.
    if (removed.length > 0 || moves.length > 0) await assertNoWorkOrders(tx, revisionId)
    if (removed.length > 0) {
      await assertNoLinesUse(tx, revisionId, removed)
      await deleteSteps(tools, removed.map((step) => step.id))
      for (const step of removed) tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: draft.style.companyId, before: { revisionId, ...auditedStep(step) }, after: { removed: true } })
    }
    await moveSteps(tools, moves)
    for (const entry of kept) {
      const changes = { ...(entry.minutes !== null ? { standardMinutes: entry.minutes } : {}), ...(entry.departmentId !== null ? { departmentId: entry.departmentId } : {}) }
      if (entry.minutes !== null) await assertTypedStepSmv(tx, entry.step.id)
      if (Object.keys(changes).length > 0) await tx.routingOperation.update({ where: { id: entry.step.id }, data: { ...changes, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      if (Object.keys(changes).length > 0 || entry.step.seq !== entry.seq) {
        tools.audit({
          recordType: 'RoutingOperation',
          recordId: entry.step.id,
          companyId: draft.style.companyId,
          before: { seq: entry.step.seq, ...(entry.minutes !== null ? { standardMinutes: entry.step.standardMinutes } : {}), ...(entry.departmentId !== null ? { departmentId: entry.step.departmentId ?? null } : {}) },
          after: { seq: entry.seq, ...changes },
        })
      }
    }
    await insertSteps(tools, { styleId, revisionId }, planned)
    for (const step of planned) tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: draft.style.companyId, after: { revisionId, ...auditedStep(step) } })
    recordSave(tools, draft, body.steps.length, { kept: kept.length, added: planned.length, removed: removed.length, moved: moves.length, warnings: [...rules.warnings] }, [...kept.map((entry) => entry.step.id), ...planned.map((step) => step.id)])
    return routingViewInTx(tx, styleId, revisionId, actorOf(context))
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new DomainError('conflict', 'Another change took a place in the routing at the same time: load it again.')
    throw error
  })
  return result
}

function recordSave(tools: CommandTools, draft: Awaited<ReturnType<typeof lockDraft>>, steps: number, change: Record<string, unknown>, stepIds: readonly string[]): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { routing: { saved: steps, ...change }, version: draft.version } })
  tools.emit({ type: 'style.routing_changed', subject: style.id, companyId: style.companyId, payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, stepIds: [...stepIds] } })
}

