import { newId } from '@nexus/factory-domain/core/ids'
import { gradeRulesImporter, importRecordValues, parseStep } from '@nexus/factory-domain/product/grading/importer'
import { normaliseRule, normaliseStep, ruleProblems, stepProblems, type GradeFormat } from '@nexus/factory-domain/product/grading/rules'
import { measureText } from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { CheckRow, ImportAdapter, ImportScope } from '../../../platform/imports/registry'
import { mayWrite } from '../materials/store'
import { readScaleSizes, readStepPoints, readSteps, RULE_COLUMNS } from './store'

/**
 * The grade rules' import adapter (platform/imports; B-W2b-224, PRD-051; design products.sizes "Import (W2b)"):
 * factory-domain's `gradeRulesImporter` reads each row (rule, point, step, increment; a new rule's name, scale, base size
 * and format); this finds the rule by code, the point by code (whatever its letter case) and the step, checks what needs
 * the database — the rule's scale and its active sizes, a garment point, an absolute rule's steps from its base, one way
 * per pair of sizes — in the dry run and again in each batch, and writes one planned row inside the batch's command: a
 * new rule (from the row) with its step, a new step, or a step's new increment, each audited with `grade_rule.changed`.
 * Writing needs product.styles.manage, seeing the plans product.styles.view; a job for every company needs it over every
 * company.
 */

const ACTION = 'product.grading.import'

class ImportRowRefused extends ApiError {
  constructor(rule: string, detail: string) {
    super('conflict', `The import row for grade rule ${rule} no longer fits: ${detail}. Run the dry run again.`)
  }
}

interface RuleFacts {
  readonly id: string | null
  readonly code: string
  readonly companyId: string | null
  readonly sizeScaleId: string
  readonly baseSize: string
  readonly format: GradeFormat
  readonly status: string
  readonly name: string
}

/** The rule a row names: the library's (by code), or the one the row would make (its scale by code); with what is wrong. */
async function ruleOfRow(client: CommandTx, values: Readonly<Record<string, unknown>>, scope: ImportScope): Promise<{ rule: RuleFacts | null; issues: { column?: string; message: string }[] }> {
  const code = String(values.rule)
  const found = await client.gradeRule.findFirst({ where: { code }, select: RULE_COLUMNS })
  if (found) {
    if (found.companyId !== scope.companyId) return { rule: null, issues: [{ column: 'rule', message: `Grade rule ${code} is another company's (or one for every company): import it with that company.` }] }
    if (found.status !== 'ACTIVE') return { rule: null, issues: [{ column: 'rule', message: `Grade rule ${code} is archived: restore it before importing its steps.` }] }
    return { rule: { ...found, format: found.format as GradeFormat, status: String(found.status) }, issues: [] }
  }
  const missing = (['scale', 'baseSize'] as const).filter((name) => values[name] === undefined)
  if (missing.length > 0) return { rule: null, issues: missing.map((name) => ({ column: name, message: `Grade rule ${code} is new: give its ${name === 'scale' ? 'size scale' : 'base size'}.` })) }
  const scale = await client.sizeScale.findFirst({ where: { code: String(values.scale) }, select: { id: true, companyId: true, status: true } })
  if (!scale || scale.status !== 'ACTIVE') return { rule: null, issues: [{ column: 'scale', message: `No active size scale ${String(values.scale)}.` }] }
  if (scale.companyId !== null && scale.companyId !== scope.companyId) return { rule: null, issues: [{ column: 'scale', message: `Size scale ${String(values.scale)} is another company's.` }] }
  const fields = normaliseRule({ code, name: typeof values.ruleName === 'string' ? values.ruleName : code, baseSize: String(values.baseSize), format: (values.format as GradeFormat | undefined) ?? 'RELATIVE' })
  const sizes = (await readScaleSizes(client, scale.id)).filter((size) => size.status === 'ACTIVE').map((size) => size.code)
  const problems = ruleProblems(fields, sizes)
  if (problems.length > 0) return { rule: null, issues: problems.map((issue) => ({ column: issue.path === 'baseSize' ? 'baseSize' : issue.path === 'name' ? 'ruleName' : 'rule', message: issue.message })) }
  return { rule: { id: null, code, companyId: scope.companyId, sizeScaleId: scale.id, baseSize: fields.baseSize, format: fields.format, status: 'ACTIVE', name: fields.name }, issues: [] }
}

async function pointByCode(client: CommandTx, code: string) {
  return client.pointOfMeasure.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true, code: true } })
}

/** What a row's step breaks against its rule (the rule's other steps, as they are now, beside it). */
async function stepIssues(client: CommandTx, rule: RuleFacts, values: Readonly<Record<string, unknown>>): Promise<{ column?: string; message: string }[]> {
  const point = await pointByCode(client, String(values.point))
  if (!point) return [{ column: 'point', message: `No point of measure ${String(values.point)}.` }]
  const parsed = parseStep(String(values.step))
  if (!parsed) return [{ column: 'step', message: 'Write the step as "50-52" or "*".' }]
  const step = normaliseStep({ pointOfMeasureId: point.id, ...parsed, increment: values.increment === undefined ? '0' : String(values.increment) })
  const others = rule.id ? (await readSteps(client, rule.id)).filter((entry) => !(entry.pointOfMeasureId === step.pointOfMeasureId && entry.fromSize === step.fromSize && entry.toSize === step.toSize)) : []
  const sizes = (await readScaleSizes(client, rule.sizeScaleId)).filter((size) => size.status === 'ACTIVE').map((size) => size.code)
  const points = await readStepPoints(client, [...others.map((entry) => entry.pointOfMeasureId), point.id])
  const problems = stepProblems([...others, step], { scaleSizes: sizes, baseSize: rule.baseSize, format: rule.format, points, kept: new Set(others.map((entry) => entry.pointOfMeasureId)) })
  const own = `steps/${others.length}/`
  return problems
    .filter((issue) => issue.path.startsWith(own) || issue.path === 'steps')
    .map((issue) => ({ column: issue.path.endsWith('increment') ? 'increment' : issue.path.endsWith('pointOfMeasureId') ? 'point' : 'step', message: issue.message }))
}

export const gradeRulesImportAdapter = Object.freeze({
  importer: gradeRulesImporter,
  permission: PRODUCT_STYLES_MANAGE,
  viewPermission: PRODUCT_STYLES_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PRODUCT_STYLES_MANAGE, null)) {
      return [{ path: 'companyId', message: 'A grade rules import for every company needs product.styles.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async check(client, rows: readonly CheckRow[], scope) {
    const out: { column?: string; message: string }[][] = []
    for (const row of rows) {
      const values = { ...row.key, ...row.values }
      const { rule, issues } = await ruleOfRow(client, values, scope)
      out.push(rule ? [...issues, ...(await stepIssues(client, rule, values))] : issues)
    }
    return out
  },

  async load(client, keys) {
    const out = []
    for (const key of keys) {
      const rule = await client.gradeRule.findFirst({ where: { code: String(key.rule) }, select: { id: true, code: true } })
      const point = rule ? await pointByCode(client, String(key.point)) : null
      const parsed = parseStep(String(key.step))
      if (!rule || !point || !parsed) continue
      const step = await client.gradeRuleStep.findFirst({ where: { ruleId: rule.id, pointOfMeasureId: point.id, fromSize: parsed.fromSize, toSize: parsed.toSize }, select: { id: true, increment: true } })
      if (!step) continue
      // The engine finds a record by its key as the sheet wrote it (the point's code and the step whatever their writing).
      out.push({ id: step.id, values: { ...importRecordValues({ ruleCode: rule.code, pointCode: String(key.point), ...parsed, increment: step.increment.toString() }), step: String(key.step) } })
    }
    return out
  },

  async write(tools, row, scope) {
    const { tx, now } = tools
    const code = String(row.key.rule)
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    const values = { ...row.key, ...row.values }
    if (row.action === 'UPDATE') {
      const stepId = row.recordId!
      const [locked] = await tx.$queryRaw<{ ruleId: string }[]>`SELECT "ruleId"::text AS "ruleId" FROM "GradeRuleStep" WHERE "id" = ${stepId}::uuid FOR UPDATE`
      if (!locked) throw new ImportRowRefused(code, 'the step was removed since')
      const rule = await tx.gradeRule.findUniqueOrThrow({ where: { id: locked.ruleId }, select: RULE_COLUMNS })
      if (rule.status !== 'ACTIVE' || rule.companyId !== scope.companyId) throw new ImportRowRefused(code, 'the rule was archived or moved')
      const increment = measureText(String(row.values.increment))
      await tx.gradeRuleStep.update({ where: { id: stepId }, data: { increment, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      await tx.gradeRule.update({ where: { id: rule.id }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: ACTION, recordType: 'GradeRule', recordId: rule.id, companyId: rule.companyId, before: { step: String(row.key.step), point: String(row.key.point), increment: row.before.increment ?? null }, after: { increment } })
      tools.emit({ type: 'grade_rule.changed', subject: rule.id, companyId: rule.companyId, payload: { gradeRuleId: rule.id, code: rule.code, sizeScaleId: rule.sizeScaleId, change: 'STEPS' } })
      return { recordId: stepId }
    }
    const found = await ruleOfRow(tx, values, scope)
    if (!found.rule) throw new ImportRowRefused(code, found.issues.map((issue) => issue.message).join(' '))
    let rule = found.rule
    let made = false
    if (rule.id === null) {
      const id = newId()
      await tx.gradeRule.create({ data: { id, companyId: scope.companyId, code: rule.code, name: rule.name, sizeScaleId: rule.sizeScaleId, baseSize: rule.baseSize, format: rule.format, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
      tools.audit({ action: ACTION, recordType: 'GradeRule', recordId: id, companyId: scope.companyId, after: { code: rule.code, name: rule.name, sizeScaleId: rule.sizeScaleId, baseSize: rule.baseSize, format: rule.format, status: 'ACTIVE' } })
      rule = { ...rule, id }
      made = true
    } else {
      await tx.$queryRaw`SELECT "id" FROM "GradeRule" WHERE "id" = ${rule.id}::uuid FOR UPDATE`
    }
    const issues = await stepIssues(tx, rule, values)
    if (issues.length > 0) throw new ImportRowRefused(code, issues.map((issue) => issue.message).join(' '))
    const point = (await pointByCode(tx, String(values.point)))!
    const parsed = parseStep(String(values.step))!
    const stepId = newId()
    const increment = measureText(String(values.increment))
    await tx.gradeRuleStep.create({ data: { id: stepId, ruleId: rule.id!, pointOfMeasureId: point.id, fromSize: parsed.fromSize, toSize: parsed.toSize, increment, createdAt: now, updatedAt: now, createdById }, select: { id: true } })
    if (!made) await tx.gradeRule.update({ where: { id: rule.id! }, data: { version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: ACTION, recordType: 'GradeRule', recordId: rule.id!, companyId: scope.companyId, after: { step: { point: point.code, fromSize: parsed.fromSize, toSize: parsed.toSize, increment } } })
    tools.emit({ type: 'grade_rule.changed', subject: rule.id!, companyId: scope.companyId, payload: { gradeRuleId: rule.id!, code: rule.code, sizeScaleId: rule.sizeScaleId, change: made ? 'CREATED' : 'STEPS' } })
    return { recordId: stepId }
  },
} satisfies ImportAdapter)
