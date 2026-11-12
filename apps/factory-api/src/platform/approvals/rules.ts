import type { z } from 'zod'
import type { Prisma } from '@nexus/factory-db'
import { events as approvalEvents } from '@nexus/factory-domain/approvals/events'
import { APPROVALS_DECIDE, APPROVALS_RULES_MANAGE, APPROVALS_VIEW } from '@nexus/factory-domain/approvals/permissions'
import {
  APPROVAL_LIMITS,
  APPROVAL_MEANINGS,
  APPROVAL_REFUSALS,
  APPROVAL_TASK_KINDS,
  conditionHolds,
  conditionProblems,
  MEANING_WORDS,
  parseCondition,
  ruleSentence,
  RULE_OPERATORS,
  storedCondition,
  type ApprovalMeaning,
  type ApprovalTaskKind,
  type RuleCondition,
  type Words,
} from '@nexus/factory-domain/approvals/rules'
import { DomainError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, holds, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { eventFor } from '@nexus/factory-domain/events/define'
import { command, type CommandCaller } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { serverClock } from '../../core/time'
import type { kindView } from './contract'
import { kindOf, registeredKinds } from './kinds'
import { decidersOf, grainsOf, heldGrain, hiddenFieldsOf, officeOf, peopleNames, personMay, RULE_SCOPE, type Reader } from './store'
import { databaseRefusal } from './tasks'
import { kindLabelOf } from './views'

/**
 * The approval rules (B-W2b-282; PLT-086, PLT-042; design admin.automation "Approval rules" and its popup rule): when a
 * request of a kind needs a yes and from whom. The list (sentence, kind, company, approver, meaning, step-up, order, time to
 * decide, from when, fired in 30 days, on/off, who changed it last) with the locked "Nobody approves their own request";
 * one rule; a new rule, always written OFF (Owner answer 11-10: no rule is active until a person switches it on); a change
 * (its kind and company never change) and the switch; the test of a draft against the kind's latest records ("would have
 * asked for 4 of the last 50") with who would approve. A condition is checked against the facts the kind exposes; a money
 * fact's threshold is read and written only with its grain; the approver is an office role whose people may decide
 * (approvals.decide), or one active office person who may.
 */

const [, , , , ruleChanged] = approvalEvents

const NO_SELF_APPROVAL: Words = {
  en: 'Nobody approves their own request, the Owner included: whoever asked or wrote a request never decides it (the database holds it on every path).',
  it: 'Nessuno approva la propria richiesta, il titolare compreso: chi l’ha chiesta o scritta non la decide mai (il database lo garantisce su ogni percorso).',
}

const RULE_COLUMNS = {
  id: true,
  companyId: true,
  kind: true,
  name: true,
  condition: true,
  approverRoleId: true,
  approverUserId: true,
  signatureMeaning: true,
  requireStepUp: true,
  sequence: true,
  dueHours: true,
  active: true,
  effectiveFrom: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  updatedById: true,
} as const satisfies Prisma.ApprovalRuleSelect
type RuleRow = Prisma.ApprovalRuleGetPayload<{ select: typeof RULE_COLUMNS }>

const refused = (code: keyof typeof APPROVAL_REFUSALS, path: string): DomainError => new DomainError('conflict', APPROVAL_REFUSALS[code], [{ path, message: APPROVAL_REFUSALS[code] }])

/** May the actor keep a rule of this company (a rule of every company: a grant over every company). */
export function mayManage(actor: Actor, companyId: string | null): boolean {
  if (companyId !== null) return can(actor, APPROVALS_RULES_MANAGE, { companyId })
  return grantsFor(actor, APPROVALS_RULES_MANAGE).some((grant) => grant.companies === 'all')
}

/** The rows of a rule on facts whose values the reader may not see (a money threshold without its grain). */
function heldRows(rule: Pick<RuleRow, 'kind' | 'condition'>, actor: Actor): number {
  const kind = kindOf(rule.kind)
  if (!kind) return 0
  const hidden = hiddenFieldsOf(kind.fields, grainsOf(actor))
  return (parseCondition(rule.condition)?.rows ?? []).filter((row) => hidden.has(row.field)).length
}

async function ruleViews(db: Reader, actor: Actor, me: string, rules: readonly RuleRow[], now: Date) {
  const ids = rules.map((rule) => rule.id)
  const since = new Date(now.getTime() - 30 * 86_400_000)
  const fired = ids.length
    ? await db.$queryRaw<Array<{ id: string; n: number }>>`SELECT r.id::text AS id, count(t.id)::int AS n FROM unnest(${ids}::uuid[]) AS r(id) JOIN "ApprovalTask" t ON r.id = ANY (t."ruleIds") AND t."requestedAt" >= ${since} GROUP BY r.id`
    : []
  const people = await peopleNames(db, rules.flatMap((rule) => [rule.approverUserId, rule.updatedById]))
  const roleIds = [...new Set(rules.map((rule) => rule.approverRoleId).filter((id): id is string => id !== null))]
  const roles = new Map((roleIds.length ? await db.role.findMany({ where: { id: { in: roleIds } }, select: { id: true, name: true } }) : []).map((role) => [role.id, role.name]))
  const companyIds = [...new Set(rules.map((rule) => rule.companyId).filter((id): id is string => id !== null))]
  const companies = new Map((companyIds.length ? await db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, tradeName: true, legalName: true } }) : []).map((company) => [company.id, company.tradeName ?? company.legalName]))
  const grains = grainsOf(actor)
  return rules.map((rule) => {
    const kind = kindOf(rule.kind)
    const fields = kind?.fields ?? []
    const hidden = hiddenFieldsOf(fields, grains)
    const condition = parseCondition(rule.condition) ?? { combinator: 'and' as const, rows: [] }
    const approverName = rule.approverUserId ? (people.get(rule.approverUserId) ?? '') : (roles.get(rule.approverRoleId ?? '') ?? '')
    const sentenceInput = { kindLabel: kindLabelOf(rule.kind), condition, fields, hiddenFields: hidden, approver: approverName, meaning: rule.signatureMeaning as ApprovalMeaning | null }
    const held = condition.rows.some((row) => hidden.has(row.field))
    const canChange = mayManage(actor, rule.companyId)
    return {
      id: rule.id,
      kind: rule.kind as ApprovalTaskKind,
      kindLabel: kindLabelOf(rule.kind),
      registered: kind !== undefined,
      name: rule.name,
      sentence: { en: ruleSentence(sentenceInput, 'en'), it: ruleSentence(sentenceInput, 'it') },
      companyId: rule.companyId,
      companyName: rule.companyId ? (companies.get(rule.companyId) ?? null) : null,
      condition: {
        combinator: condition.combinator,
        rows: condition.rows.map((row) => ({ id: row.id ?? null, field: row.field, operator: row.operator, value: hidden.has(row.field) ? null : (row.value as string | string[] | null), held: hidden.has(row.field) })),
      },
      approver: rule.approverUserId ? { kind: 'PERSON' as const, id: rule.approverUserId, name: approverName } : { kind: 'ROLE' as const, id: rule.approverRoleId!, name: approverName },
      signatureMeaning: rule.signatureMeaning as ApprovalMeaning | null,
      requireStepUp: rule.requireStepUp,
      sequence: rule.sequence,
      dueHours: rule.dueHours,
      active: rule.active,
      effectiveFrom: rule.effectiveFrom ? toUtcIso(rule.effectiveFrom) : null,
      fired30Days: fired.find((entry) => entry.id === rule.id)?.n ?? 0,
      changedBy: rule.updatedById ? { id: rule.updatedById, name: people.get(rule.updatedById) ?? '', me: rule.updatedById === me } : null,
      updatedAt: toUtcIso(rule.updatedAt),
      canChange,
      heldReason: !canChange ? 'Your roles do not keep the approval rules of this company.' : held ? APPROVAL_REFUSALS.CHANGE_GRAIN : null,
      version: rule.version,
    }
  })
}

const visibleRules = (actor: Actor): Prisma.ApprovalRuleWhereInput => scopeWhere(actor, APPROVALS_VIEW, RULE_SCOPE) as Prisma.ApprovalRuleWhereInput

/** GET /approvals/kinds: the kinds with the facts their rules may test (a money fact held without its grain). */
export function listKinds(caller: CommandCaller) {
  const actor = actorOf(officeOf(caller))
  const grains = grainsOf(actor)
  const kinds: Array<z.infer<typeof kindView>> = registeredKinds().map((kind) => ({
    kind: kind.kind,
    recordType: kind.recordType,
    label: kind.label,
    askable: kind.ask !== null,
    fields: kind.fields.map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.kind,
      unit: field.unit ?? null,
      grain: field.grain ?? null,
      options: [...(field.options ?? [])],
      min: field.min ?? null,
      max: field.max ?? null,
      heldReason: heldGrain(field.grain, grains) ? 'A money figure your roles do not show.' : null,
    })),
  }))
  const registered = new Set(kinds.map((kind) => kind.kind))
  return {
    kinds,
    notRegistered: APPROVAL_TASK_KINDS.filter((kind) => !registered.has(kind)),
    meanings: APPROVAL_MEANINGS.map((meaning) => ({ meaning, label: MEANING_WORDS[meaning] })),
    operators: [...RULE_OPERATORS],
  }
}

/** GET /approvals/rules: every rule the reader may see, with the locked "Nobody approves their own request". */
export async function listRules(caller: CommandCaller, query: { kind?: ApprovalTaskKind | undefined; active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const rules = await db.approvalRule.findMany({
      where: { AND: [visibleRules(actor), query.kind ? { kind: query.kind } : {}, query.active ? { active: query.active === 'true' } : {}] },
      orderBy: [{ kind: 'asc' }, { sequence: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take: 500,
      select: RULE_COLUMNS,
    })
    return {
      asOf: toUtcIso(now),
      rules: await ruleViews(db, actor, context.actorId, rules, now),
      fixed: [{ code: 'NO_SELF_APPROVAL' as const, sentence: NO_SELF_APPROVAL }],
      canAdd: holds(actor, APPROVALS_RULES_MANAGE),
    }
  })
}

async function oneRule(db: Reader, actor: Actor, ruleId: string): Promise<RuleRow> {
  const rule = await db.approvalRule.findFirst({ where: { AND: [{ id: ruleId }, visibleRules(actor)] }, select: RULE_COLUMNS })
  if (!rule) throw new NotFoundError()
  return rule
}

/** GET /approvals/rules/:id */
export async function getRule(caller: CommandCaller, ruleId: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  return caller.withClient(async (db) => ({ rule: (await ruleViews(db, actor, context.actorId, [await oneRule(db, actor, ruleId)], serverClock.now()))[0]! }))
}

type Approver = { roleId: string } | { userId: string }

/** The checks of a rule's content, in words (issues), before the database's. */
async function contentProblems(db: Reader, context: OfficeContext, input: { kind: ApprovalTaskKind; companyId: string | null; condition?: RuleCondition | undefined; approver?: Approver | undefined }, now: Date): Promise<Issue[]> {
  const actor = actorOf(context)
  const kind = kindOf(input.kind)
  if (!kind) return [{ path: 'body/kind', message: APPROVAL_REFUSALS.NO_KIND }]
  const issues: Issue[] = []
  if (input.condition) {
    for (const problem of conditionProblems(input.condition, kind.fields, hiddenFieldsOf(kind.fields, grainsOf(actor)))) issues.push({ path: `body/${problem.path}`, message: problem.message })
  }
  if (input.approver && 'roleId' in input.approver) {
    const role = await db.role.findUnique({ where: { id: input.approver.roleId }, select: { audience: true, permissions: true } })
    if (!role || role.audience !== 'OFFICE' || !role.permissions.includes(APPROVALS_DECIDE)) issues.push({ path: 'body/approver/roleId', message: APPROVAL_REFUSALS.APPROVER_ROLE })
  }
  if (input.approver && 'userId' in input.approver) {
    const user = await db.user.findUnique({ where: { id: input.approver.userId }, select: { status: true, audience: true } })
    if (!user || user.status !== 'ACTIVE' || user.audience !== 'OFFICE' || !(await personMay(db, context.tenantId, input.approver.userId, APPROVALS_DECIDE, { companyId: input.companyId }, now))) {
      issues.push({ path: 'body/approver/userId', message: APPROVAL_REFUSALS.APPROVER_PERSON })
    }
  }
  return issues
}

const approverColumns = (approver: Approver) => ('roleId' in approver ? { approverRoleId: approver.roleId, approverUserId: null } : { approverRoleId: null, approverUserId: approver.userId })

export interface RuleBody {
  readonly name: string
  readonly condition: RuleCondition
  readonly approver: Approver
  readonly signatureMeaning: ApprovalMeaning | null
  readonly requireStepUp: boolean
  readonly sequence: number
  readonly dueHours: number | null
  readonly effectiveFrom: string | null
}

/** POST /approvals/rules: a new rule, written OFF. */
export async function createRule(caller: CommandCaller, body: RuleBody & { kind: ApprovalTaskKind; companyId: string | null }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  if (!mayManage(actor, body.companyId)) throw new ForbiddenError()
  const kind = kindOf(body.kind)
  if (!kind) throw refused('NO_KIND', 'body/kind')
  const id = newId()
  await caller.withClient(async (db) => {
    if (body.companyId && !(await db.company.findUnique({ where: { id: body.companyId }, select: { id: true } }))) throw new ValidationError('No such company.', [{ path: 'body/companyId', message: 'No such company.' }])
    const issues = await contentProblems(db, context, body, serverClock.now())
    if (issues.length) throw new ValidationError(issues[0]!.message, issues)
  })
  try {
    await command(caller, { name: APPROVALS_RULES_MANAGE, idempotencyKey, input: body }, async (tools) => {
      const condition = storedCondition(body.condition, kind.fields)
      await tools.tx.approvalRule.create({
        data: {
          id,
          companyId: body.companyId,
          kind: body.kind,
          name: body.name,
          condition: condition as unknown as Prisma.InputJsonObject,
          ...approverColumns(body.approver),
          signatureMeaning: body.signatureMeaning,
          requireStepUp: body.requireStepUp,
          sequence: body.sequence,
          dueHours: body.dueHours,
          active: false,
          effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null,
          createdAt: tools.now,
          updatedAt: tools.now,
          createdById: context.actorId,
          updatedById: context.actorId,
        },
      })
      tools.audit({
        action: 'approvals.rule.create',
        recordType: 'ApprovalRule',
        recordId: id,
        companyId: body.companyId,
        after: { kind: body.kind, name: body.name, rows: condition.rows.length, ...approverColumns(body.approver), signatureMeaning: body.signatureMeaning, requireStepUp: body.requireStepUp, sequence: body.sequence, dueHours: body.dueHours, active: false },
      })
      tools.emit(eventFor(ruleChanged, { subject: id, companyId: body.companyId, payload: { ruleId: id, kind: body.kind, change: 'CREATED', active: false } }))
      return { id }
    })
  } catch (error) {
    databaseRefusal(error)
  }
  return getRule(caller, id)
}

export interface RuleUpdate {
  readonly version: number
  readonly name?: string | undefined
  readonly condition?: RuleCondition | undefined
  readonly approver?: Approver | undefined
  readonly signatureMeaning?: ApprovalMeaning | null | undefined
  readonly requireStepUp?: boolean | undefined
  readonly sequence?: number | undefined
  readonly dueHours?: number | null | undefined
  readonly effectiveFrom?: string | null | undefined
  readonly active?: boolean | undefined
}

/** PUT /approvals/rules/:id: a change and the switch (its kind and company never change; a money threshold only with its grain). */
export async function updateRule(caller: CommandCaller, ruleId: string, body: RuleUpdate, idempotencyKey?: string) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const rule = await caller.withClient(async (db) => {
    const rule = await oneRule(db, actor, ruleId)
    if (!mayManage(actor, rule.companyId)) throw new ForbiddenError()
    if (body.condition && heldRows(rule, actor) > 0) throw refused('CHANGE_GRAIN', 'body/condition')
    const issues = await contentProblems(db, context, { kind: rule.kind as ApprovalTaskKind, companyId: rule.companyId, condition: body.condition, approver: body.approver }, serverClock.now())
    if (issues.length) throw new ValidationError(issues[0]!.message, issues)
    if (body.active === true && !kindOf(rule.kind)) throw refused('NO_KIND', 'body/active')
    return rule
  })
  const kind = kindOf(rule.kind)
  try {
    await command(caller, { name: APPROVALS_RULES_MANAGE, idempotencyKey, input: body, record: { type: 'ApprovalRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
      const data: Prisma.ApprovalRuleUncheckedUpdateInput = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.condition !== undefined ? { condition: storedCondition(body.condition, kind?.fields ?? []) as unknown as Prisma.InputJsonObject } : {}),
        ...(body.approver !== undefined ? approverColumns(body.approver) : {}),
        ...(body.signatureMeaning !== undefined ? { signatureMeaning: body.signatureMeaning } : {}),
        ...(body.requireStepUp !== undefined ? { requireStepUp: body.requireStepUp } : {}),
        ...(body.sequence !== undefined ? { sequence: body.sequence } : {}),
        ...(body.dueHours !== undefined ? { dueHours: body.dueHours } : {}),
        ...(body.effectiveFrom !== undefined ? { effectiveFrom: body.effectiveFrom ? new Date(body.effectiveFrom) : null } : {}),
        ...(body.active !== undefined ? { active: body.active } : {}),
        updatedById: context.actorId,
        updatedAt: tools.now,
      }
      await tools.tx.approvalRule.update({ where: { id: ruleId }, data })
      const switched = body.active !== undefined && body.active !== rule.active
      const change = switched ? (body.active ? 'SWITCHED_ON' : 'SWITCHED_OFF') : 'UPDATED'
      tools.audit({
        action: 'approvals.rule.update',
        recordType: 'ApprovalRule',
        recordId: ruleId,
        companyId: rule.companyId,
        before: { name: rule.name, active: rule.active, approverRoleId: rule.approverRoleId, approverUserId: rule.approverUserId, signatureMeaning: rule.signatureMeaning, requireStepUp: rule.requireStepUp, sequence: rule.sequence, dueHours: rule.dueHours },
        after: { name: body.name ?? rule.name, active: body.active ?? rule.active, conditionChanged: body.condition !== undefined, ...(body.approver ? approverColumns(body.approver) : {}), signatureMeaning: body.signatureMeaning ?? rule.signatureMeaning, requireStepUp: body.requireStepUp ?? rule.requireStepUp, sequence: body.sequence ?? rule.sequence, dueHours: body.dueHours === undefined ? rule.dueHours : body.dueHours },
      })
      tools.emit(eventFor(ruleChanged, { subject: ruleId, companyId: rule.companyId, payload: { ruleId, kind: rule.kind as ApprovalTaskKind, change, active: body.active ?? rule.active } }))
      return { id: ruleId }
    })
  } catch (error) {
    databaseRefusal(error)
  }
  return getRule(caller, ruleId)
}

/**
 * POST /approvals/rules/test: a draft rule against the kind's latest records the reader may see (at most 50): how many it
 * would ask for, a few of them, and who would approve the first one's request (none asked: a request of the rule's
 * company). Nothing is saved.
 */
export async function testRule(caller: CommandCaller, body: { kind: ApprovalTaskKind; companyId: string | null; condition: RuleCondition; approver?: Approver | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const kind = kindOf(body.kind)
  if (!kind) throw refused('RULE_OFF_KIND', 'body/kind')
  const problems = conditionProblems(body.condition, kind.fields, hiddenFieldsOf(kind.fields, grainsOf(actor)))
  if (problems.length) throw new ValidationError(problems[0]!.message, problems.map((problem) => ({ path: `body/${problem.path}`, message: problem.message })))
  return caller.withClient(async (db) => {
    const now = serverClock.now()
    const ids = await kind.recent(db, body.companyId, APPROVAL_LIMITS.testRecords)
    const samples: Array<{ record: { type: string; id: string; label: string }; companyId: string }> = []
    let tested = 0
    let first: { companyId: string; siteId: string | null } | null = null
    for (const id of ids) {
      const subject = await kind.read(db, id)
      if (!subject || !can(actor, kind.view, { companyId: subject.companyId, siteId: subject.siteId })) continue
      tested += 1
      if (!conditionHolds(body.condition, kind.fields, subject.facts)) continue
      first ??= { companyId: subject.companyId, siteId: subject.siteId }
      samples.push({ record: { type: kind.recordType, id, label: subject.label }, companyId: subject.companyId })
    }
    const approver = body.approver ? { approverRoleId: 'roleId' in body.approver ? body.approver.roleId : null, approverUserId: 'userId' in body.approver ? body.approver.userId : null } : null
    // Who would approve: for the first record it would ask for, else for a request of the rule's company.
    const place = first ?? (body.companyId ? { companyId: body.companyId, siteId: null } : null)
    const approvers = approver && place ? await decidersOf(db, context.tenantId, approver, place, [context.actorId], now) : []
    const names = approver ? (approver.approverUserId ? (await peopleNames(db, [approver.approverUserId])).get(approver.approverUserId) ?? null : (await db.role.findUnique({ where: { id: approver.approverRoleId! }, select: { name: true } }))?.name ?? null) : null
    const input = { kindLabel: kind.label, condition: body.condition, fields: kind.fields, approver: names, meaning: null }
    return { tested, wouldAsk: samples.length, samples: samples.slice(0, 10), approvers, sentence: { en: ruleSentence(input, 'en'), it: ruleSentence(input, 'it') } }
  })
}
