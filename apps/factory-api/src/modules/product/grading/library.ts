import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { CreateRuleBody, ListRulesQuery, RuleRow, RuleStatusBody, RuleStepsBody, RuleView, UpdateRuleBody } from '@nexus/factory-domain/product/grading/contracts'
import { normaliseRule, normaliseStep, ruleProblems, sameStep, stepProblems, type GradeFormat, type RuleFields, type StepData } from '@nexus/factory-domain/product/grading/rules'
import { RULE_CHANGES } from '@nexus/factory-domain/product-measures/events'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMayWrite, contextOf, invalid, isUniqueViolation, prefixed } from '../measures/store'
import { afterCursor, decodeCursor, encodeCursor } from '../styles/cursor'
import { readRuleFor, readScaleSizes, readStepPoints, readSteps, RULE_COLUMNS, ruleRowsOf, ruleViewOf, type RuleRowData } from './store'

/**
 * The grade rule library (B-W2b-224; PRD-051, PRD-049; design products.sizes "Grade rules": rule, scale, base size, points,
 * increment format; the Grade rule pop-up's increments per point × size step; the size scale's Grade rules tab). Office
 * only, product.styles.view | manage over the rule's company, as its size scale (a company's scale only for that
 * company's rule; a tenant-wide rule only by a role over every company). Every write: one command on the rule (its
 * version), audited, `grade_rule.changed`. The steps are saved whole (the pop-up's Save): what is left out goes.
 */

const NOUN = 'grade rule'
type RuleChange = (typeof RULE_CHANGES)[number]

const codeTaken = (code: string) => new ConflictError(`The grade rule code ${code} is taken.`)

function changed(tools: CommandTools, row: { id: string; code: string; companyId: string | null; sizeScaleId: string }, change: RuleChange): void {
  tools.emit({ type: 'grade_rule.changed', subject: row.id, companyId: row.companyId, payload: { gradeRuleId: row.id, code: row.code, sizeScaleId: row.sizeScaleId, change } })
}

const SCOPE = { company: { field: 'companyId', nullable: true } } as const

// ---- reads --------------------------------------------------------------------------------------------------------------

export async function listRules(caller: CommandCaller, query: ListRulesQuery): Promise<{ rules: RuleRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const filters: Prisma.GradeRuleWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, SCOPE) as Prisma.GradeRuleWhereInput,
    query.status === 'ALL' ? {} : { status: query.status },
    query.scaleId ? { sizeScaleId: query.scaleId } : {},
    search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCursor(query.cursor)
  return caller.withClient(async (client) => {
    const rows = await client.gradeRule.findMany({ where: { AND: [...filters, afterCursor(cursor)] }, select: RULE_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const count = await client.gradeRule.count({ where: { AND: filters } })
    const page = rows.slice(0, query.limit)
    const last = page.at(-1)
    return { rules: await ruleRowsOf(client, page), nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null, count }
  })
}

export async function getRule(caller: CommandCaller, ruleId: string): Promise<RuleView> {
  const row = await readRuleFor(caller, ruleId)
  return caller.withClient((client) => ruleViewOf(client, row))
}

/** The size scale's Grade rules tab: its rules (every status), as the caller may see the scale. */
export async function scaleRules(caller: CommandCaller, scaleId: string): Promise<{ rules: RuleRow[] }> {
  const context = contextOf(caller)
  const scale = isUuid(scaleId) ? await caller.withClient((client) => client.sizeScale.findUnique({ where: { id: scaleId }, select: { id: true, companyId: true } })) : null
  if (!scale || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: scale.companyId })) throw new NotFoundError('Size scale not found.')
  return caller.withClient(async (client) => {
    const rows = await client.gradeRule.findMany({ where: { AND: [{ sizeScaleId: scaleId }, scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, SCOPE) as Prisma.GradeRuleWhereInput] }, select: RULE_COLUMNS, orderBy: [{ status: 'asc' }, { code: 'asc' }] })
    return { rules: await ruleRowsOf(client, rows) }
  })
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** The scale's active size codes (the rule's sizes are checked against them). */
async function activeSizes(tx: CommandTx, scaleId: string): Promise<string[]> {
  return (await readScaleSizes(tx, scaleId)).filter((size) => size.status === 'ACTIVE').map((size) => size.code)
}

/** Every problem of a rule and its whole list of steps against the scale and the library. */
async function wholeRuleProblems(tx: CommandTx, fields: RuleFields, scaleId: string, steps: readonly StepData[], kept: ReadonlySet<string>): Promise<Issue[]> {
  const sizes = await activeSizes(tx, scaleId)
  const points = await readStepPoints(
    tx,
    steps.map((step) => step.pointOfMeasureId),
  )
  return [...prefixed(ruleProblems(fields, sizes)), ...prefixed(stepProblems(steps, { scaleSizes: sizes, baseSize: fields.baseSize, format: fields.format, points, kept }))]
}

async function insertSteps(tools: CommandTools, ruleId: string, steps: readonly StepData[]): Promise<void> {
  if (steps.length === 0) return
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.gradeRuleStep.createMany({
    data: steps.map((step) => ({ id: newId(), ruleId, pointOfMeasureId: step.pointOfMeasureId, fromSize: step.fromSize, toSize: step.toSize, increment: step.increment, createdAt: now, updatedAt: now, createdById })),
  })
}

/** product.grading.createRule: a rule of a size scale, with its steps (none yet is fine). */
export async function createRule(caller: CommandCaller, body: CreateRuleBody, idempotencyKey?: string): Promise<RuleView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, companyId, NOUN)
  const fields = normaliseRule({ code: body.code, name: body.name, baseSize: body.baseSize, format: body.format })
  const steps = body.steps.map(normaliseStep)

  const { result } = await command(caller, { name: 'product.grading.createRule', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const scale = isUuid(body.sizeScaleId) ? await tx.sizeScale.findUnique({ where: { id: body.sizeScaleId }, select: { id: true, companyId: true, code: true, status: true } }) : null
    if (!scale || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: scale.companyId })) throw invalid([{ path: 'body/sizeScaleId', message: 'No such size scale.' }], NOUN)
    if (scale.status !== 'ACTIVE') throw invalid([{ path: 'body/sizeScaleId', message: `Size scale ${scale.code} is archived.` }], NOUN)
    if (scale.companyId !== null && scale.companyId !== companyId) throw invalid([{ path: 'body/sizeScaleId', message: `Size scale ${scale.code} is one company's: its rules are that company's.` }], NOUN)
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }], NOUN)
    const problems = await wholeRuleProblems(tx, fields, scale.id, steps, new Set())
    if (problems.length > 0) throw invalid(problems, NOUN)
    if (await tx.gradeRule.findFirst({ where: { code: fields.code }, select: { id: true } })) throw codeTaken(fields.code)
    const id = newId()
    await tx.gradeRule.create({ data: { id, companyId, sizeScaleId: scale.id, ...fields, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null }, select: { id: true } })
    await insertSteps(tools, id, steps)
    tools.audit({ recordType: 'GradeRule', recordId: id, companyId, after: { companyId, sizeScaleId: scale.id, ...fields, status: 'ACTIVE', steps } })
    changed(tools, { id, code: fields.code, companyId, sizeScaleId: scale.id }, 'CREATED')
    return ruleViewOf(tx, await tx.gradeRule.findUniqueOrThrow({ where: { id }, select: RULE_COLUMNS }))
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeTaken(fields.code)
    throw error
  })
  return result
}

/** product.grading.updateRule: its name, code, base size, format (its steps checked again), or ARCHIVED / ACTIVE. */
export async function updateRule(caller: CommandCaller, ruleId: string, body: UpdateRuleBody, idempotencyKey?: string): Promise<RuleView> {
  const context = contextOf(caller)
  const seen = await readRuleFor(caller, ruleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, NOUN)
  const { version, status, ...patch } = body

  const { result } = await command(
    caller,
    { name: 'product.grading.updateRule', idempotencyKey, input: { ruleId, ...body }, record: { type: 'GradeRule', id: ruleId, expectedVersion: version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.gradeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
      const before: RuleFields = { code: row.code, name: row.name, baseSize: row.baseSize, format: row.format as GradeFormat }
      const next = normaliseRule({ code: patch.code ?? before.code, name: patch.name ?? before.name, baseSize: patch.baseSize ?? before.baseSize, format: patch.format ?? before.format })
      const fields = (['code', 'name', 'baseSize', 'format'] as const).filter((field) => next[field] !== before[field])
      const move = status !== undefined && status !== row.status ? status : undefined
      if (fields.length === 0 && !move) throw invalid([{ path: 'body', message: 'Nothing changes: name a field with a new value.' }], NOUN)
      if (fields.length > 0 && row.status !== 'ACTIVE' && move !== 'ACTIVE') throw new InvalidStateError(`Grade rule ${row.code} is archived: restore it before changing it.`)
      if (fields.length > 0) {
        const steps = await readSteps(tx, ruleId)
        const problems = await wholeRuleProblems(tx, next, row.sizeScaleId, steps, new Set(steps.map((step) => step.pointOfMeasureId)))
        if (problems.length > 0) throw invalid(problems, NOUN)
        if (fields.includes('code') && (await tx.gradeRule.findFirst({ where: { code: next.code, id: { not: ruleId } }, select: { id: true } }))) throw codeTaken(next.code)
      }
      if (move === 'ACTIVE' && (await tx.sizeScale.findUnique({ where: { id: row.sizeScaleId }, select: { status: true } }))?.status !== 'ACTIVE') {
        throw new InvalidStateError(`The size scale of grade rule ${row.code} is archived: restore the scale first.`)
      }
      await tx.gradeRule.update({ where: { id: ruleId }, data: { ...Object.fromEntries(fields.map((field) => [field, next[field]])), ...(move ? { status: move } : {}), updatedAt: now }, select: { id: true } })
      tools.audit({
        recordType: 'GradeRule',
        recordId: ruleId,
        companyId: row.companyId,
        before: { ...Object.fromEntries(fields.map((field) => [field, before[field]])), ...(move ? { status: row.status } : {}) },
        after: { ...Object.fromEntries(fields.map((field) => [field, next[field]])), ...(move ? { status: move } : {}) },
      })
      changed(tools, { id: ruleId, code: next.code, companyId: row.companyId, sizeScaleId: row.sizeScaleId }, move === 'ARCHIVED' ? 'ARCHIVED' : move === 'ACTIVE' ? 'RESTORED' : 'UPDATED')
      return ruleViewOf(tx, await tx.gradeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS }))
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeTaken(body.code ?? seen.code)
    throw error
  })
  return result
}

/**
 * product.grading.saveSteps: every step of the rule (the pop-up's Save): the steps that stay as they are are kept, the
 * others removed and the new ones added, in one write. A spec graded with the rule keeps its values until the rule is
 * applied again.
 */
export async function saveSteps(caller: CommandCaller, ruleId: string, body: RuleStepsBody, idempotencyKey?: string): Promise<RuleView> {
  const context = contextOf(caller)
  const seen = await readRuleFor(caller, ruleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, NOUN)
  const steps = body.steps.map(normaliseStep)

  const { result } = await command(caller, { name: 'product.grading.saveSteps', idempotencyKey, input: { ruleId, ...body }, record: { type: 'GradeRule', id: ruleId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const row = await tx.gradeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS })
    if (row.status !== 'ACTIVE') throw new InvalidStateError(`Grade rule ${row.code} is archived: restore it before changing its steps.`)
    const current = await readSteps(tx, ruleId)
    const fields: RuleFields = { code: row.code, name: row.name, baseSize: row.baseSize, format: row.format as GradeFormat }
    const problems = await wholeRuleProblems(tx, fields, row.sizeScaleId, steps, new Set(current.map((step) => step.pointOfMeasureId)))
    if (problems.length > 0) throw invalid(problems, NOUN)
    const gone = current.filter((step) => !steps.some((entry) => sameStep(entry, step)))
    const added = steps.filter((step) => !current.some((entry) => sameStep(entry, step)))
    if (gone.length > 0) {
      const { count } = await tx.gradeRuleStep.deleteMany({ where: { id: { in: gone.map((step) => step.id) } } })
      if (count !== gone.length) throw new ConflictError('The rule changed while its steps were saved: load it again.')
    }
    await insertSteps(tools, ruleId, added)
    tools.audit({ recordType: 'GradeRule', recordId: ruleId, companyId: row.companyId, before: { steps: gone.map(({ id: _id, ...step }) => step) }, after: { steps: added, kept: current.length - gone.length } })
    changed(tools, row, 'STEPS')
    return ruleViewOf(tx, await tx.gradeRule.findUniqueOrThrow({ where: { id: ruleId }, select: RULE_COLUMNS }))
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another change saved the same step at the same time: load the rule again.')
    throw error
  })
  return result
}

/** product.grading.rulesStatus: the list's selection archived or restored in one write (all or none). */
export async function setRuleStatus(caller: CommandCaller, body: RuleStatusBody, idempotencyKey?: string): Promise<{ rules: RuleRow[] }> {
  const context = contextOf(caller)
  const ids = body.rules.map((rule) => rule.id)
  if (new Set(ids).size !== ids.length) throw invalid([{ path: 'body/rules', message: 'Each rule once.' }], NOUN)
  const seen: RuleRowData[] = []
  for (const id of ids) seen.push(await readRuleFor(caller, id))
  for (const row of seen) assertMayWrite(context, PRODUCT_STYLES_MANAGE, row.companyId, NOUN)

  const { result } = await command(caller, { name: 'product.grading.rulesStatus', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const issues: string[] = []
    const moved: RuleRowData[] = []
    for (const asked of [...body.rules].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "GradeRule" WHERE "id" = ${asked.id}::uuid FOR UPDATE`
      const row = seen.find((entry) => entry.id === asked.id)!
      if (!locked || locked.version !== asked.version) issues.push(`${row.code} changed since it was read: load the list again.`)
      else if (row.status !== body.status) moved.push(row)
    }
    if (issues.length > 0) throw new ConflictError(issues.join(' '))
    if (body.status === 'ACTIVE') {
      const scales = await tx.sizeScale.findMany({ where: { id: { in: moved.map((row) => row.sizeScaleId) }, status: { not: 'ACTIVE' } }, select: { id: true } })
      const blocked = moved.filter((row) => scales.some((scale) => scale.id === row.sizeScaleId))
      if (blocked.length > 0) throw new InvalidStateError(`The size scale of ${blocked.map((row) => row.code).join(', ')} is archived: restore the scale first.`)
    }
    for (const row of moved) {
      await tx.gradeRule.update({ where: { id: row.id }, data: { status: body.status, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'GradeRule', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: body.status } })
      changed(tools, row, body.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED')
    }
    if (moved.length === 0) tools.audit({ recordType: 'GradeRule', recordId: ids[0]!, after: { status: body.status, unchanged: ids } })
    const rows = await tx.gradeRule.findMany({ where: { id: { in: ids } }, select: RULE_COLUMNS, orderBy: { code: 'asc' } })
    return { rules: await ruleRowsOf(tx, rows) }
  })
  return result
}
