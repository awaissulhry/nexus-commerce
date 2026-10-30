import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { AddStepsBody, CopyStepsBody, ReorderStepsBody, RoutingView, UpdateStepBody } from '@nexus/factory-domain/product/routing/contracts'
import { operationUseRefusal } from '@nexus/factory-domain/product/routing/operations'
import { PRODUCT_ROUTING_MANAGE } from '@nexus/factory-domain/product/routing/permissions'
import { planSubcontract, sameSubcontract, type Subcontract } from '@nexus/factory-domain/product/routing/subcontract'
import {
  copySourceRefusal,
  copySteps,
  MAX_ROUTING_STEPS,
  MAX_SEQ,
  nextSeq,
  orderProblems,
  planNewStep,
  planStepChange,
  renumbering,
  SEQ_STEP,
  sequenceOf,
  stepChanges,
  type StepData,
} from '@nexus/factory-domain/product/routing/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { findRevision } from '../bom/store'
import {
  assertMayWrite,
  assertNoWorkOrders,
  auditedStep,
  auditedSubcontract,
  contextOf,
  deleteSteps,
  fitsStyle,
  insertSteps,
  invalid,
  isUniqueViolation,
  lockDraft,
  lockOperations,
  moveSteps,
  prefixed,
  readOperations,
  readRevisionFor,
  readStyleFor,
  readSteps,
  readSubcontracts,
  routingViewInTx,
  subcontractColumns,
  workshopProblems,
  type LockedDraft,
  type StepRecord,
} from './store'

/**
 * A draft revision's routing (features PRD-110, PRD-111): operations from the library added at the end, a step's
 * minutes, scan point and instructions changed, a step removed, the steps reordered, and the steps of a released routing
 * copied in. Every write sends the revision's version: it locks the style row, checks the revision is a draft (409
 * otherwise, before the database's own refusal), compares and sets the revision's version, locks the library operations
 * it copies, then writes the steps; it records an audit row per step and one on the revision, and `style.routing_changed`.
 */

function recordChange(tools: CommandTools, draft: LockedDraft, stepIds: readonly string[], change: Record<string, unknown>): void {
  const { style } = draft
  tools.audit({ recordType: 'StyleRevision', recordId: draft.revisionId, companyId: style.companyId, after: { routing: change, version: draft.version } })
  tools.emit({
    type: 'style.routing_changed',
    subject: style.id,
    companyId: style.companyId,
    payload: { styleId: style.id, code: style.code, revisionId: draft.revisionId, revision: draft.revision, stepIds: [...stepIds] },
  })
}

const placeTaken = (error: unknown): never => {
  if (isUniqueViolation(error)) throw new DomainError('conflict', 'Another change took this place in the routing at the same time: load it again.')
  throw error
}

function tooMany(count: number): ValidationError {
  return new ValidationError('The routing is full.', [{ path: 'body', message: `A routing has at most ${MAX_ROUTING_STEPS} steps (${count} asked).` }])
}

/** The step of this revision, read inside the command. */
function stepOf(steps: readonly StepRecord[], stepId: string): StepRecord {
  const step = isUuid(stepId) ? steps.find((entry) => entry.id === stepId) : undefined
  if (!step) throw new NotFoundError('Routing step not found.')
  return step
}

/** product.routing.addSteps: library operations at the end of the draft's routing, in the order sent. */
export async function addSteps(caller: CommandCaller, styleId: string, revisionId: string, body: AddStepsBody, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.addSteps', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const current = await readSteps(tx, revisionId)
    if (current.length + body.operations.length > MAX_ROUTING_STEPS) throw tooMany(current.length + body.operations.length)
    const operationIds = body.operations.map((entry) => entry.operationId)
    await lockOperations(tx, operationIds)
    const library = await readOperations(tx, operationIds)

    const issues: Issue[] = []
    const planned: StepData[] = []
    let seq = nextSeq(current)
    body.operations.forEach((entry, index) => {
      const at = `body/operations/${index}`
      const operation = library.get(entry.operationId)
      if (!operation) issues.push({ path: `${at}/operationId`, message: 'No such operation.' })
      else if (!fitsStyle(operation, draft.style.companyId)) issues.push({ path: `${at}/operationId`, message: `Operation ${operation.code} belongs to another company than the style's.` })
      else {
        const { operationId: _operation, ...change } = entry
        const plan = planNewStep(operation, change, seq)
        if (plan.ok) planned.push({ id: newId(), ...plan.step })
        else issues.push(...prefixed(plan.issues, at))
      }
      seq += SEQ_STEP
    })
    if (issues.length > 0) throw invalid(issues)

    await insertSteps(tools, { styleId, revisionId }, planned)
    for (const step of planned) tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: draft.style.companyId, after: { revisionId, ...auditedStep(step) } })
    recordChange(tools, draft, planned.map((step) => step.id), { added: planned.map((step) => ({ id: step.id, seq: step.seq, operationId: step.operationId })) })
    return routingViewInTx(tx, styleId, revisionId)
  }).catch(placeTaken)
  return result
}

/**
 * product.routing.updateStep: a step's minutes for this style, its scan point, its instructions, and (W2a, PRD-120) its
 * subcontract details: the workshop (SUBCONTRACTOR role, of the style's company or every company), its fee per piece
 * (the cost grain: the grain filter refuses a fee from a caller without it) and the transit days; null takes the step
 * back in-house.
 */
export async function updateStep(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, body: UpdateStepBody, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)
  const { version, subcontract: subcontractChange, ...change } = body

  const { result } = await command(caller, { name: 'product.routing.updateStep', idempotencyKey, input: { styleId, revisionId, stepId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const current = stepOf(await readSteps(tx, revisionId), stepId)
    const plan = planStepChange(current, change)
    if (!plan.ok) throw invalid(prefixed(plan.issues))
    const changed = stepChanges(current, plan.step)
    const was: Subcontract | null = (await readSubcontracts(tx, revisionId)).get(stepId) ?? null
    let next = was
    if (subcontractChange !== undefined) {
      const planned = planSubcontract(was, subcontractChange)
      if (!planned.ok) throw invalid(prefixed(planned.issues))
      next = planned.subcontract
      if (next !== null && next.supplierId !== was?.supplierId) {
        const problems = await workshopProblems(tx, next.supplierId, draft.style.companyId)
        if (problems.length > 0) throw invalid(problems)
      }
    }
    const subcontracted = !sameSubcontract(was, next)
    if (changed.length > 0 || subcontracted) {
      await tx.routingOperation.update({
        where: { id: stepId },
        data: {
          standardMinutes: plan.step.standardMinutes,
          scanRequired: plan.step.scanRequired,
          instructions: plan.step.instructions,
          ...(subcontracted ? subcontractColumns(next) : {}),
          version: { increment: 1 },
          updatedAt: now,
        },
        select: { id: true },
      })
    }
    const before = auditedStep(current)
    const after = auditedStep(plan.step)
    tools.audit({
      recordType: 'RoutingOperation',
      recordId: stepId,
      companyId: draft.style.companyId,
      before: { ...Object.fromEntries(changed.map((field) => [field, before[field]])), ...(subcontracted ? { subcontract: auditedSubcontract(was) } : {}) },
      after: { ...Object.fromEntries(changed.map((field) => [field, after[field]])), ...(subcontracted ? { subcontract: auditedSubcontract(next) } : {}) },
    })
    recordChange(tools, draft, [stepId], { changed: stepId, fields: [...changed, ...(subcontracted ? ['subcontract'] : [])] })
    return routingViewInTx(tx, styleId, revisionId)
  })
  return result
}

/** product.routing.removeStep: the step out of the draft (the others keep their places). */
export async function removeStep(caller: CommandCaller, styleId: string, revisionId: string, stepId: string, version: number, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.removeStep', idempotencyKey, input: { styleId, revisionId, stepId, version } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraft(tools, styleId, revisionId, version)
    const current = stepOf(await readSteps(tx, revisionId), stepId)
    await assertNoWorkOrders(tx, revisionId)
    await deleteSteps(tools, [stepId])
    tools.audit({ recordType: 'RoutingOperation', recordId: stepId, companyId: draft.style.companyId, before: { revisionId, ...auditedStep(current) }, after: { removed: true } })
    recordChange(tools, draft, [stepId], { removed: stepId, seq: current.seq, operationId: current.operationId })
    return routingViewInTx(tx, styleId, revisionId)
  })
  return result
}

/** product.routing.reorder: every step in the new order, numbered 10, 20, 30 … */
export async function reorderSteps(caller: CommandCaller, styleId: string, revisionId: string, body: ReorderStepsBody, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)

  const { result } = await command(caller, { name: 'product.routing.reorder', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const steps = await readSteps(tx, revisionId)
    const problems = orderProblems(
      steps.map((step) => step.id),
      body.stepIds,
    )
    if (problems.length > 0) throw invalid(prefixed(problems), 'order')
    const moves = renumbering(steps, sequenceOf(body.stepIds))
    if (moves.length > 0) await assertNoWorkOrders(tx, revisionId)
    await moveSteps(tools, moves)
    for (const move of moves) tools.audit({ recordType: 'RoutingOperation', recordId: move.id, companyId: draft.style.companyId, before: { seq: move.from }, after: { seq: move.to } })
    recordChange(tools, draft, body.stepIds, { reordered: body.stepIds, moved: moves.length })
    return routingViewInTx(tx, styleId, revisionId)
  }).catch(placeTaken)
  return result
}

/**
 * product.routing.copySteps: the steps of a style's RELEASED routing (this style's or another's) copied into this draft,
 * after its steps or instead of them. Each copied step keeps its source's minutes, scan point and instructions; its
 * library operation must still be ACTIVE and of the draft style's company or every company.
 */
export async function copyRoutingSteps(caller: CommandCaller, styleId: string, revisionId: string, body: CopyStepsBody, idempotencyKey?: string): Promise<RoutingView> {
  const context = contextOf(caller)
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(context, PRODUCT_ROUTING_MANAGE, style.companyId)
  // The source is read only by a person who may see its routing.
  await readStyleFor(caller, body.fromStyleId)

  const { result } = await command(caller, { name: 'product.routing.copySteps', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const draft = await lockDraft(tools, styleId, revisionId, body.version)
    const source =
      body.fromRevisionId === undefined
        ? await tx.styleRevision.findFirst({ where: { styleId: body.fromStyleId, status: 'RELEASED' }, select: { id: true, revision: true, status: true } })
        : await findRevision(tx, body.fromStyleId, body.fromRevisionId)
    if (!source) throw new NotFoundError('That style has no released routing.')
    const refusal = copySourceRefusal(source, source.id === revisionId)
    if (refusal) throw new DomainError('invalid_state', refusal)

    const sourceSteps = await readSteps(tx, source.id)
    if (sourceSteps.length === 0) throw new DomainError('invalid_state', `Revision ${source.revision} of that style has no routing steps to copy.`)
    await lockOperations(tx, sourceSteps.map((step) => step.operationId))
    const library = await readOperations(tx, sourceSteps.map((step) => step.operationId))
    // W2a: a subcontracted step travels with its workshop, fee and transit days; the workshop must suit this style too.
    const sourceSubcontracts = await readSubcontracts(tx, source.id)
    const problems: Issue[] = []
    for (const step of sourceSteps) {
      const operation = library.get(step.operationId)
      const at = `steps/${step.seq}`
      if (!operation) problems.push({ path: at, message: `Operation ${step.code} is not in the library.` })
      else if (!fitsStyle(operation, draft.style.companyId)) problems.push({ path: at, message: `Operation ${operation.code} belongs to another company than the style's.` })
      else {
        const archived = operationUseRefusal(operation)
        if (archived) problems.push({ path: at, message: archived })
      }
      const subcontract = sourceSubcontracts.get(step.id)
      if (subcontract) problems.push(...(await workshopProblems(tx, subcontract.supplierId, draft.style.companyId, at)))
    }
    if (problems.length > 0) throw new DomainError('invalid_state', `${problems.length} step(s) cannot be copied: their operations or workshops are not usable here.`, problems)

    const current = await readSteps(tx, revisionId)
    const kept = body.replace ? [] : current
    if (kept.length + sourceSteps.length > MAX_ROUTING_STEPS) throw tooMany(kept.length + sourceSteps.length)
    const first = nextSeq(kept)
    if (first + (sourceSteps.length - 1) * SEQ_STEP > MAX_SEQ) throw tooMany(kept.length + sourceSteps.length)
    if (body.replace && current.length > 0) {
      await assertNoWorkOrders(tx, revisionId)
      await deleteSteps(
        tools,
        current.map((step) => step.id),
      )
      for (const step of current) tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: draft.style.companyId, before: { revisionId, ...auditedStep(step) }, after: { removed: true } })
    }
    const copied = copySteps(sourceSteps, first, newId)
    // copySteps keeps the source's order: the n-th copy is the n-th source step.
    const copiedSubcontracts = new Map(
      copied.flatMap((step, index): [string, Subcontract][] => {
        const subcontract = sourceSubcontracts.get(sourceSteps[index]!.id)
        return subcontract ? [[step.id, subcontract]] : []
      }),
    )
    await insertSteps(tools, { styleId, revisionId }, copied, copiedSubcontracts)
    for (const step of copied) {
      const subcontract = copiedSubcontracts.get(step.id) ?? null
      tools.audit({ recordType: 'RoutingOperation', recordId: step.id, companyId: draft.style.companyId, after: { revisionId, ...auditedStep(step), ...(subcontract ? { subcontract: auditedSubcontract(subcontract) } : {}) } })
    }
    recordChange(tools, draft, copied.map((step) => step.id), {
      copiedFrom: { styleId: body.fromStyleId, revisionId: source.id, revision: source.revision },
      replaced: body.replace ? current.length : 0,
      added: copied.length,
    })
    return routingViewInTx(tx, styleId, revisionId)
  }).catch(placeTaken)
  return result
}
