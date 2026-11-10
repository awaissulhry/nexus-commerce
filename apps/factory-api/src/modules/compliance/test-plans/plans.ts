import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { SUBSTANCES_MANAGE, SUBSTANCES_VIEW } from '@nexus/factory-domain/compliance/substances/permissions'
import { planProblems, planSwitchRefusal, RULE_CODE_OF_TEST, type PlanDraft } from '@nexus/factory-domain/compliance/test-plans/rules'
import type { SubstanceTest } from '@nexus/factory-domain/compliance/substances/rules'
import { ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, holds, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { runCommand, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { companyReach, officeOf } from '../register-of-rules/common'
import { substancesClock, substancesGuarded, substancesSettings } from '../substances/common'
import type { Reader } from '../substances/store'
import { PLAN_SELECT, planViews, type PlanRow } from './store'

/**
 * Test plan rules (B-W2b-256; PRD-309; design compliance.tests "Test plan rules (W2b)"): which lab test a material needs
 * (by its kind, or one material), how often, for which market, and the substance rule it proves. Reading needs
 * compliance.certificates.view (tenant-wide rules and the companies the person reads); keeping them needs
 * compliance.substances.manage over the rule's company (a tenant-wide rule: every company), as the substance rules (B-W2b-250).
 * A rule is switched off with the reason (Owner answer 11-09 Q5 A: until a style or a market needs it), archived when no
 * longer used, never deleted. Nothing is ordered from a lab: the test is the company's own to order at its lab's price.
 */

type Caller = CommandCaller & Pick<FastifyRequest, 'withClient'>

export interface PlanQuery {
  readonly test?: SubstanceTest | undefined
  readonly itemKind?: string | undefined
  readonly itemId?: string | undefined
  readonly switchedOn?: boolean | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | undefined
}

/** GET /compliance/test-plans. */
export async function listPlans(request: FastifyRequest, query: PlanQuery) {
  const actor = actorOf(officeOf(request))
  const now = substancesClock().now()
  return request.withClient(async (db) => {
    const where: Prisma.TestPlanRuleWhereInput = {
      AND: [
        companyReach(actor, SUBSTANCES_VIEW) as Prisma.TestPlanRuleWhereInput,
        ...(query.status === 'ALL' ? [] : [{ status: query.status ?? 'ACTIVE' }]),
        ...(query.test ? [{ test: query.test }] : []),
        ...(query.itemKind ? [{ itemKind: query.itemKind as never }] : []),
        ...(query.itemId ? [{ itemId: query.itemId }] : []),
        ...(query.switchedOn !== undefined ? [{ switchedOn: query.switchedOn }] : []),
      ],
    }
    const rows = await db.testPlanRule.findMany({ where, select: PLAN_SELECT, orderBy: [{ test: 'asc' }, { itemKind: 'asc' }, { createdAt: 'asc' }] })
    return { plans: await planViews(db, rows), mayManage: holds(actor, SUBSTANCES_MANAGE), asOf: toUtcIso(now) }
  })
}

async function readPlan(db: Reader, actor: Actor, planId: string): Promise<PlanRow> {
  const row = isUuid(planId) ? await db.testPlanRule.findUnique({ where: { id: planId }, select: PLAN_SELECT }) : null
  if (!row || (row.companyId !== null && !can(actor, SUBSTANCES_VIEW, { companyId: row.companyId }))) throw new NotFoundError('Test plan rule not found.')
  return row
}

function assertMayKeep(actor: Actor, companyId: string | null): void {
  if (!mayWrite(actor, SUBSTANCES_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'A test plan rule for every company is kept only by a role over every company.' : 'Keeping test plan rules needs compliance.substances.manage over this company.')
}

/** What the plan names, checked against the database (the material, the substance rule of its test). */
async function namedProblems(db: Reader, draft: PlanDraft & { readonly substanceRuleId?: string | null | undefined }, companyId: string | null): Promise<Issue[]> {
  const issues: Issue[] = []
  if (draft.itemId) {
    const item = isUuid(draft.itemId) ? await db.item.findUnique({ where: { id: draft.itemId }, select: { kind: true, companyId: true } }) : null
    if (!item || item.kind === 'FINISHED') issues.push({ path: 'body/itemId', message: 'A material (never a finished garment).' })
    else if (item.companyId !== null && item.companyId !== companyId) issues.push({ path: 'body/itemId', message: "Another company's material." })
  }
  if (draft.substanceRuleId) {
    const rule = isUuid(draft.substanceRuleId) ? await db.substanceRule.findUnique({ where: { id: draft.substanceRuleId }, select: { code: true, companyId: true, key: true } }) : null
    if (!rule) issues.push({ path: 'body/substanceRuleId', message: 'Not a substance rule.' })
    else if (rule.companyId !== null && rule.companyId !== companyId) issues.push({ path: 'body/substanceRuleId', message: "Another company's substance rule." })
    else if (rule.code !== 'CMR' && rule.code !== 'OTHER' && rule.code !== RULE_CODE_OF_TEST[draft.test as SubstanceTest]) issues.push({ path: 'body/substanceRuleId', message: `Rule ${rule.key} is a ${rule.code} rule: a ${draft.test} test proves a ${RULE_CODE_OF_TEST[draft.test as SubstanceTest] ?? '?'} rule.` })
  }
  return issues
}

function changeEvent(tools: Pick<CommandTools, 'emit'>, row: PlanRow, change: 'CREATED' | 'EDITED' | 'SWITCHED' | 'ARCHIVED' | 'RESTORED'): void {
  tools.emit({ type: 'compliance_material_tests.test_plan_changed', subject: row.id, companyId: row.companyId, payload: { planId: row.id, test: row.test as SubstanceTest, frequency: row.frequency as 'EVERY_LOT' | 'FIRST_LOT' | 'YEARLY' | 'ON_CHANGE', switchedOn: row.switchedOn, change } })
}

const auditShape = (row: PlanRow) => ({ itemKind: row.itemKind, itemId: row.itemId, test: row.test, frequency: row.frequency, marketCode: row.marketCode, substanceRuleId: row.substanceRuleId, method: row.method, switchedOn: row.switchedOn, offReason: row.offReason, status: row.status })

export interface CreateBody extends PlanDraft {
  readonly companyId?: string | null | undefined
  readonly substanceRuleId?: string | null | undefined
}

/** POST /compliance/test-plans. */
export async function createPlan(caller: Caller, body: CreateBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const companyId = body.companyId ?? null
  assertMayKeep(actor, companyId)
  const problems = planProblems(body)
  if (problems.length > 0) throw new ValidationError('The test plan rule is not valid.', problems)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.testPlans.create', idempotencyKey: key, input: body },
      async (tools) => {
        const named = await namedProblems(tools.tx, body, companyId)
        if (named.length > 0) throw new ValidationError('The test plan rule is not valid.', named)
        const id = newId()
        const on = body.switchedOn !== false
        const row = await tools.tx.testPlanRule.create({
          data: {
            id,
            companyId,
            itemKind: (body.itemKind ?? null) as never,
            itemId: body.itemId ?? null,
            test: body.test as SubstanceTest,
            frequency: body.frequency as never,
            marketCode: body.marketCode ?? null,
            substanceRuleId: body.substanceRuleId ?? null,
            method: body.method?.trim() || null,
            switchedOn: on,
            offReason: on ? null : (body.offReason?.trim() ?? null),
            switchedAt: tools.now,
            switchedById: context.actorId,
            note: body.note?.trim() || null,
            createdAt: tools.now,
            updatedAt: tools.now,
            createdById: context.actorId,
          },
          select: PLAN_SELECT,
        })
        tools.audit({ action: 'compliance.testPlans.create', recordType: 'TestPlanRule', recordId: id, companyId, after: auditShape(row) })
        changeEvent(tools, row, 'CREATED')
        return { plan: (await planViews(tools.tx, [row]))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}

export interface EditBody {
  readonly version: number
  readonly itemKind?: string | null | undefined
  readonly itemId?: string | null | undefined
  readonly test?: string | undefined
  readonly frequency?: string | undefined
  readonly marketCode?: string | null | undefined
  readonly substanceRuleId?: string | null | undefined
  readonly method?: string | null | undefined
  readonly note?: string | null | undefined
  readonly status?: 'ACTIVE' | 'ARCHIVED' | undefined
}

/** PATCH /compliance/test-plans/:planId — its scope, test, frequency, market, rule, method, note; archive or restore. */
export async function editPlan(caller: Caller, planId: string, body: EditBody, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readPlan(db, actor, planId))
  assertMayKeep(actor, first.companyId)
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.testPlans.edit', idempotencyKey: key, input: { planId, ...body }, record: { type: 'TestPlanRule', id: planId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readPlan(tools.tx, actor, planId)
        // A kind replaces the material and back: naming one clears the other.
        const itemKind = body.itemKind !== undefined ? body.itemKind : body.itemId ? null : row.itemKind
        const itemId = body.itemId !== undefined ? body.itemId : body.itemKind ? null : row.itemId
        const draft = {
          itemKind,
          itemId,
          test: body.test ?? row.test,
          frequency: body.frequency ?? row.frequency,
          marketCode: body.marketCode !== undefined ? body.marketCode : row.marketCode,
          substanceRuleId: body.substanceRuleId !== undefined ? body.substanceRuleId : row.substanceRuleId,
          method: body.method !== undefined ? body.method : row.method,
          note: body.note !== undefined ? body.note : row.note,
          switchedOn: row.switchedOn,
          offReason: row.offReason,
        }
        const problems = [...planProblems(draft), ...(await namedProblems(tools.tx, draft, row.companyId))]
        if (problems.length > 0) throw new ValidationError('The test plan rule is not valid.', problems)
        const status = body.status ?? row.status
        const updated = await tools.tx.testPlanRule.update({
          where: { id: row.id },
          data: {
            itemKind: (draft.itemKind ?? null) as never,
            itemId: draft.itemId ?? null,
            test: draft.test as SubstanceTest,
            frequency: draft.frequency as never,
            marketCode: draft.marketCode ?? null,
            substanceRuleId: draft.substanceRuleId ?? null,
            method: draft.method?.trim() || null,
            note: draft.note?.trim() || null,
            status: status as never,
            updatedAt: tools.now,
          },
          select: PLAN_SELECT,
        })
        tools.audit({ action: 'compliance.testPlans.edit', recordType: 'TestPlanRule', recordId: row.id, companyId: row.companyId, before: auditShape(row), after: auditShape(updated) })
        changeEvent(tools, updated, status !== row.status ? (status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED') : 'EDITED')
        return { plan: (await planViews(tools.tx, [updated]))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}

/** PUT /compliance/test-plans/:planId/switch {version, on, reason?}. */
export async function switchPlan(caller: Caller, planId: string, body: { readonly version: number; readonly on: boolean; readonly reason?: string | null | undefined }, key: string | null | undefined) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const first = await caller.withClient((db) => readPlan(db, actor, planId))
  assertMayKeep(actor, first.companyId)
  const refusal = planSwitchRefusal(first, body.on, body.reason)
  if (refusal) {
    if (first.switchedOn === body.on || first.status !== 'ACTIVE') throw new InvalidStateError(refusal)
    throw new ValidationError(refusal, [{ path: 'body/reason', message: refusal }])
  }
  const { result } = await substancesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.testPlans.switch', idempotencyKey: key, input: { planId, ...body }, record: { type: 'TestPlanRule', id: planId, expectedVersion: body.version } },
      async (tools) => {
        const row = await readPlan(tools.tx, actor, planId)
        const again = planSwitchRefusal(row, body.on, body.reason)
        if (again) throw new InvalidStateError(again)
        // Each switch moves its time (one within the same millisecond as the last moves on by one).
        const at = row.switchedAt && row.switchedAt.getTime() >= tools.now.getTime() ? new Date(row.switchedAt.getTime() + 1) : tools.now
        const updated = await tools.tx.testPlanRule.update({
          where: { id: row.id },
          data: { switchedOn: body.on, offReason: body.on ? null : body.reason!.trim(), switchedAt: at, switchedById: context.actorId, updatedAt: tools.now },
          select: PLAN_SELECT,
        })
        tools.audit({ action: 'compliance.testPlans.switch', recordType: 'TestPlanRule', recordId: row.id, companyId: row.companyId, before: { switchedOn: row.switchedOn, offReason: row.offReason }, after: { switchedOn: updated.switchedOn, offReason: updated.offReason } })
        changeEvent(tools, updated, 'SWITCHED')
        return { plan: (await planViews(tools.tx, [updated]))[0]! }
      },
      substancesSettings(),
    ),
  )
  return result
}
