import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { type GradeRuleChange } from '@nexus/factory-domain/inventory/hides/changes'
import { gradeRuleDraftProblems, panelsOf } from '@nexus/factory-domain/inventory/hides/grading'
import { activeRules, byOrder, gradeOfHide, shareFor, type GradeFacts } from '@nexus/factory-domain/inventory/hides/usable'
import { PRODUCT_MATERIALS_MANAGE, PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { usableShareText } from '@nexus/factory-domain/quality/defects/grades'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { officeContextOf } from '../ledger/access'
import type { GradeRuleRowView } from './contract'
import { gradeRefOf, gradesOf, RULE_SELECT, ruleFactsOf, rulesOf, type RuleRow } from './facts'

/**
 * An article's grades and usable shares (B-W2b-94; PRD-031 "Grade per panel feeds nesting and yield"; design products.materials
 * record, Properties & grades › "Grades and usable area": Grade (A / B / C) · Usable share % · Panels allowed; autosave per
 * cell). The material's: product.materials.view to read, product.materials.manage over its company to change (a material
 * for every company: a grant over every company), as every other field of the material.
 *
 *   GET   /product/materials/:materialId/grades          every active grade (and a retired one the article still has a rule
 *                                                       for) with the article's own rule, what applies (the rule's share,
 *                                                       else the grade's default), the panels, the retired rules and how
 *                                                       many hides of the article in stock have the grade. Empty for a
 *                                                       material not tracked hide by hide.
 *   POST  /product/materials/:materialId/grades          the article's rule for a grade (one active per article and grade;
 *                                                       a retired grade takes none).
 *   PATCH /product/materials/:materialId/grades/:ruleId  at the version read: the share, the panels, retire (active false)
 *                                                       or make active again. The article and the grade never change and a
 *                                                       rule is never deleted (the database's ItemGradeRule guard).
 *
 * One command() each with an Idempotency-Key, an audit row on the rule (the material's company), one
 * `inventory.grade_rule_changed`. A share changed here changes the usable-area estimate of the article's hides of the grade;
 * no stock, no figure already recorded.
 */

interface MaterialFacts {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly tracking: string
}

async function materialFor(caller: CommandCaller, materialId: string): Promise<{ material: MaterialFacts; context: OfficeContext }> {
  const context = officeContextOf(caller)
  const row = isUuid(materialId) ? await caller.withClient((client) => client.item.findUnique({ where: { id: materialId }, select: { id: true, code: true, name: true, companyId: true, tracking: true, kind: true } })) : null
  if (!row || (row.kind as string) === 'FINISHED' || !can(actorOf(context), PRODUCT_MATERIALS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Material not found.')
  return { material: { id: row.id, code: row.code, name: row.name, companyId: row.companyId, tracking: row.tracking }, context }
}

const mayManage = (context: OfficeContext, material: MaterialFacts) => mayWrite(actorOf(context), PRODUCT_MATERIALS_MANAGE, material.companyId)

function assertManage(context: OfficeContext, material: MaterialFacts): void {
  if (!mayManage(context, material)) throw new ForbiddenError(material.companyId === null ? 'A material for every company is changed only by a role over every company.' : 'This needs product.materials.manage over the material\'s company.')
}

function assertHides(material: MaterialFacts): void {
  if (material.tracking !== 'HIDE') throw new InvalidStateError(`${material.code} is not tracked hide by hide: grades and usable shares are of a leather counted by the hide.`)
}

const ruleRefOf = (row: RuleRow) => ({ id: row.id, usableShare: row.usableShare.toFixed(2), panels: [...row.panels], version: row.version, updatedAt: toUtcIso(row.updatedAt) })

type Reader = Pick<CommandTx, 'leatherGrade' | 'itemGradeRule' | 'hide'>

/** In-stock hides of the article per grade (by record, or by the W1 text). */
async function hidesPerGrade(db: Pick<CommandTx, 'hide'>, itemId: string, grades: readonly GradeFacts[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>()
  const rows = await db.hide.groupBy({ by: ['gradeId', 'grade'], where: { itemId, state: { in: ['FULL', 'PARTLY_CUT', 'REMNANT'] } }, _count: { _all: true } })
  for (const row of rows) {
    const { grade } = gradeOfHide({ gradeId: row.gradeId, grade: row.grade }, grades)
    if (grade) counts.set(grade.id, (counts.get(grade.id) ?? 0) + row._count._all)
  }
  return counts
}

/** The rows of the material's section: every active grade, a retired one with an active rule, in tile order. */
async function rowsOf(db: Reader, itemId: string): Promise<GradeRuleRowView[]> {
  const grades = await gradesOf(db)
  const all = (await rulesOf(db, [itemId])).get(itemId) ?? []
  const rules = activeRules(all.map(ruleFactsOf))
  const counts = await hidesPerGrade(db, itemId, grades)
  return grades
    .filter((grade) => grade.active || rules.has(grade.id))
    .sort(byOrder)
    .map((grade) => {
      const share = shareFor(grade, rules)
      const active = all.find((row) => row.active && row.gradeId === grade.id)
      return {
        grade: { ...gradeRefOf(grade), defaultShare: grade.usableShare },
        rule: active ? ruleRefOf(active) : null,
        share: share.share,
        source: share.source,
        panels: [...share.panels],
        retiredRules: all.filter((row) => !row.active && row.gradeId === grade.id).map(ruleRefOf),
        hidesInStock: counts.get(grade.id) ?? 0,
      }
    })
}

async function rowFor(db: Reader, itemId: string, gradeId: string): Promise<GradeRuleRowView> {
  const row = (await rowsOf(db, itemId)).find((entry) => entry.grade.id === gradeId)
  if (row) return row
  // A retired grade whose last rule was just retired: still answer its row.
  const grade = (await gradesOf(db)).find((entry) => entry.id === gradeId)!
  const all = ((await rulesOf(db, [itemId])).get(itemId) ?? []).filter((rule) => rule.gradeId === gradeId)
  return {
    grade: { ...gradeRefOf(grade), defaultShare: grade.usableShare },
    rule: null,
    share: grade.usableShare,
    source: 'GRADE',
    panels: [],
    retiredRules: all.filter((rule) => !rule.active).map(ruleRefOf),
    hidesInStock: (await hidesPerGrade(db, itemId, [grade])).get(grade.id) ?? 0,
  }
}

/** GET /product/materials/:materialId/grades. */
export async function readGradeRules(caller: CommandCaller, materialId: string) {
  const { material, context } = await materialFor(caller, materialId)
  const tracksHides = material.tracking === 'HIDE'
  return caller.withClient(async (client) => ({
    material: { id: material.id, code: material.code, name: material.name, companyId: material.companyId, tracksHides },
    grades: tracksHides ? await rowsOf(client, material.id) : [],
    canManage: tracksHides && mayManage(context, material),
  }))
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const LOCK_RULES = (tx: CommandTx, itemId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.item-grade-rules', current_setting('factory.tenant_id', true), ${itemId}::text), 0))`

const audited = (row: RuleRow, gradeCode: string) => ({ itemId: row.itemId, gradeId: row.gradeId, grade: gradeCode, usableShare: row.usableShare.toFixed(2), panels: [...row.panels], active: row.active })

function changed(tools: Pick<CommandTools, 'emit'>, row: RuleRow, gradeCode: string, companyId: string | null, change: GradeRuleChange): void {
  tools.emit({ type: 'inventory.grade_rule_changed', subject: row.itemId, companyId, siteId: null, payload: { ruleId: row.id, itemId: row.itemId, gradeId: row.gradeId, gradeCode, change } })
}

export interface CreateGradeRuleBody {
  readonly gradeId: string
  readonly usableShare: string
  readonly panels?: readonly string[] | undefined
}

/** POST /product/materials/:materialId/grades. */
export async function createGradeRule(caller: CommandCaller, materialId: string, body: CreateGradeRuleBody, idempotencyKey?: string): Promise<{ grade: GradeRuleRowView }> {
  const { material, context } = await materialFor(caller, materialId)
  assertManage(context, material)
  assertHides(material)
  const problems = gradeRuleDraftProblems(body, true)
  if (problems.length > 0) refuse(problems, 'The grade rule is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'inventory.createGradeRule', idempotencyKey, input: { materialId, ...body } }, async (tools) => {
    const { tx, now } = tools
    await LOCK_RULES(tx, material.id)
    const grade = await tx.leatherGrade.findUnique({ where: { id: body.gradeId }, select: { id: true, code: true, active: true } })
    if (!grade) refuse([{ path: 'gradeId', message: 'Not a grade of the tenant.' }], 'Not a grade of the tenant.')
    if (!grade!.active) refuse([{ path: 'gradeId', message: `Grade ${grade!.code} is retired: no article takes it any more.` }], 'The grade is retired.')
    const taken = await tx.itemGradeRule.findFirst({ where: { itemId: material.id, gradeId: grade!.id, active: true }, select: { id: true } })
    if (taken) throw new ConflictError(`${material.code} has a rule for grade ${grade!.code} already: change that one.`)
    const row = await tx.itemGradeRule.create({
      data: { id, itemId: material.id, gradeId: grade!.id, usableShare: usableShareText(body.usableShare), panels: panelsOf(body.panels ?? []), createdAt: now, updatedAt: now, createdById: context.actorId },
      select: RULE_SELECT,
    })
    tools.audit({ action: 'inventory.createGradeRule', recordType: 'ItemGradeRule', recordId: id, companyId: material.companyId, after: audited(row, grade!.code) })
    changed(tools, row, grade!.code, material.companyId, 'CREATED')
    return { grade: await rowFor(tx, material.id, grade!.id) }
  })
  return result
}

export interface EditGradeRuleBody {
  readonly version: number
  readonly usableShare?: string | undefined
  readonly panels?: readonly string[] | undefined
  readonly active?: boolean | undefined
}

/** PATCH /product/materials/:materialId/grades/:ruleId. */
export async function editGradeRule(caller: CommandCaller, materialId: string, ruleId: string, body: EditGradeRuleBody, idempotencyKey?: string): Promise<{ grade: GradeRuleRowView }> {
  const { material, context } = await materialFor(caller, materialId)
  assertManage(context, material)
  assertHides(material)
  const before = isUuid(ruleId) ? await caller.withClient((client) => client.itemGradeRule.findUnique({ where: { id: ruleId }, select: RULE_SELECT })) : null
  if (!before || before.itemId !== material.id) throw new NotFoundError('Grade rule not found.')
  const problems = gradeRuleDraftProblems(body, false)
  if (body.usableShare === undefined && body.panels === undefined && body.active === undefined) problems.push({ path: 'usableShare', message: 'Change the usable share, the panels, or retire the rule.' })
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'inventory.editGradeRule', idempotencyKey, input: { materialId, ruleId, ...body }, record: { type: 'ItemGradeRule', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      await LOCK_RULES(tx, material.id)
      const current = (await tx.itemGradeRule.findUnique({ where: { id: before.id }, select: RULE_SELECT }))!
      const grade = (await tx.leatherGrade.findUnique({ where: { id: current.gradeId }, select: { code: true, active: true } }))!
      if (body.active === true && !current.active) {
        if (!grade.active) throw new ConflictError(`Grade ${grade.code} is retired: its rule stays retired.`)
        const other = await tx.itemGradeRule.findFirst({ where: { itemId: material.id, gradeId: current.gradeId, active: true, id: { not: current.id } }, select: { id: true } })
        if (other) throw new ConflictError(`${material.code} has another active rule for grade ${grade.code}: change that one.`)
      }
      if (!current.active && body.active !== true && (body.usableShare !== undefined || body.panels !== undefined)) {
        throw new ConflictError('A retired rule is history: make it active again first, or add a new rule.')
      }
      const row = await tx.itemGradeRule.update({
        where: { id: current.id },
        data: {
          updatedAt: now,
          ...(body.usableShare !== undefined ? { usableShare: usableShareText(body.usableShare) } : {}),
          ...(body.panels !== undefined ? { panels: panelsOf(body.panels) } : {}),
          ...(body.active !== undefined ? { active: body.active } : {}),
        },
        select: RULE_SELECT,
      })
      tools.audit({ action: 'inventory.editGradeRule', recordType: 'ItemGradeRule', recordId: row.id, companyId: material.companyId, before: audited(current, grade.code), after: audited(row, grade.code) })
      const change: GradeRuleChange = body.active === false && current.active ? 'RETIRED' : body.active === true && !current.active ? 'REACTIVATED' : 'EDITED'
      changed(tools, row, grade.code, material.companyId, change)
      return { grade: await rowFor(tx, material.id, row.gradeId) }
    },
  )
  return result
}
