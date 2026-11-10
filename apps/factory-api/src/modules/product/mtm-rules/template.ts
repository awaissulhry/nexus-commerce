import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { MTM_RULE_CHANGES } from '@nexus/factory-domain/product-mtm/events'
import type { PutRulesBody, SwitchRulesBody, TemplateRulesView } from '@nexus/factory-domain/product/mtm-rules/contracts'
import { PRODUCT_MTM_SWITCH } from '@nexus/factory-domain/product/mtm-rules/permissions'
import {
  baseSizeRuleOf,
  baseSizeRuleProblems,
  limitsProblems,
  normaliseRule,
  rulesProblems,
  rulesSummary,
  sameDecimal,
  sameRule,
  type BaseSizeRule,
  type PointLimits,
  type RuleFields,
} from '@nexus/factory-domain/product/mtm-rules/rules'
import { PRODUCT_STYLES_MANAGE } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { mayWrite } from '../materials/store'
import { assertMayWrite, invalid, isUniqueViolation, prefixed } from '../measures/store'
import { checkTemplateOf, contextOf, decimalOrNull, nameWordsOf, readTemplate, readTemplateFor, ruleFieldsOf, templatePointsOf, type Reader, type TemplateRecord } from './store'

/**
 * A measurement template's made-to-measure rules (B-W2b-248; PRD-201, PRD-202, PRD-203; GATE-MTM): read and saved per
 * template (GET / PUT; product.styles.view | manage over the template's company, as the size library), and turned on or
 * off (product.mtm.switch, the Owner's word that made-to-measure starts: while off nothing is checked). Every write is ONE
 * command on the template (its version compared and bumped: the row is locked for the write), its rules checked in words
 * first (the database's MeasurementRule_check, MeasurementTemplate_base_size_rule and MeasurementPoint_mtm_depth would
 * refuse the same, as a 500), audited on the template, `measurement_template.mtm_rules_changed`.
 */

const NOUN = 'measurement template'
type Change = (typeof MTM_RULE_CHANGES)[number]

const changed = (tools: CommandTools, template: { id: string; code: string; companyId: string | null }, change: Change): void =>
  tools.emit({ type: 'measurement_template.mtm_rules_changed', subject: template.id, companyId: template.companyId, payload: { templateId: template.id, code: template.code, change } })

const archivedRefusal = (code: string): string => `Measurement template ${code} is archived: its made-to-measure rules do not change.`

/** The template's rules as the caller sees them (who may change them, and why not). */
export async function rulesViewOf(db: Reader, record: TemplateRecord, context: RequestContext): Promise<TemplateRulesView> {
  const { template, points, rules } = record
  const actor = actorOf(context)
  const libraryIds = [...new Set(points.flatMap((point) => (point.pointOfMeasureId ? [point.pointOfMeasureId] : [])))]
  const library = new Map((libraryIds.length === 0 ? [] : await db.pointOfMeasure.findMany({ where: { id: { in: libraryIds } }, select: { id: true, code: true, bodyZone: true } })).map((row) => [row.id, row]))
  const measured = await db.style.count({ where: { measurementTemplateId: template.id } })
  const madeToMeasure = await db.style.count({ where: { measurementTemplateId: template.id, mtmAllowed: true } })
  const checkable = checkTemplateOf(record)
  const fields = ruleFieldsOf(rules, points)
  const mayKeep = mayWrite(actor, PRODUCT_STYLES_MANAGE, template.companyId)
  const active = template.status === 'ACTIVE'
  const baseSizeRule = baseSizeRuleOf(template.baseSizeRule)
  return {
    template: {
      id: template.id,
      companyId: template.companyId,
      code: template.code,
      name: template.name,
      nameI18n: nameWordsOf(template.nameI18n),
      productType: template.productType,
      status: template.status,
      rulesOn: template.rulesOn,
      baseSizeRule: baseSizeRule ? { points: [...baseSizeRule.points], tie: baseSizeRule.tie } : null,
      version: template.version,
      updatedAt: toUtcIso(template.updatedAt),
    },
    points: points.map((point) => {
      const pom = point.pointOfMeasureId ? library.get(point.pointOfMeasureId) : undefined
      return {
        id: point.id,
        code: point.code,
        name: point.name,
        nameI18n: nameWordsOf(point.nameI18n),
        seq: point.seq,
        uom: point.uom,
        required: point.required,
        minValue: decimalOrNull(point.minValue),
        maxValue: decimalOrNull(point.maxValue),
        tolerance: decimalOrNull(point.tolerance),
        alterationMinus: decimalOrNull(point.alterationMinus),
        alterationPlus: decimalOrNull(point.alterationPlus),
        status: point.status,
        pointOfMeasure: pom ? { id: pom.id, code: pom.code, bodyZone: pom.bodyZone } : null,
      }
    }),
    rules: rules.map((rule, index) => ({ id: rule.id, ...fields[index]!, messageI18n: { ...fields[index]!.messageI18n } })),
    styles: { measured, madeToMeasure },
    summary: rulesSummary(checkable),
    editable: mayKeep && active,
    refusal: !active ? archivedRefusal(template.code) : mayKeep ? null : 'You can view these rules, not change them: keeping them needs product.styles.manage over the template’s company.',
    switchable: active && mayWrite(actor, PRODUCT_MTM_SWITCH, template.companyId),
  }
}

/** GET /product/measurement-templates/:templateId/mtm-rules */
export async function getRules(caller: CommandCaller, templateId: string): Promise<TemplateRulesView> {
  const record = await readTemplateFor(caller, templateId)
  return caller.withClient((client) => rulesViewOf(client, record, contextOf(caller)))
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())


/**
 * PUT /product/measurement-templates/:templateId/mtm-rules: the rules saved whole (a rule keeps its id while its code
 * stays; a changed one is updated, a new one added, one left out removed), the base size rule (null: none) and the limits
 * of the points named (the others keep theirs). Each part is written only when it changed.
 */
export async function putRules(caller: CommandCaller, templateId: string, body: PutRulesBody, idempotencyKey?: string): Promise<TemplateRulesView> {
  const context = contextOf(caller)
  const seen = await readTemplateFor(caller, templateId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.template.companyId, NOUN)
  const rules: RuleFields[] = body.rules.map((rule) =>
    normaliseRule({
      code: rule.code,
      kind: rule.kind,
      pointCode: rule.pointCode,
      otherPointCode: rule.otherPointCode ?? null,
      minFactor: rule.minFactor ?? null,
      maxFactor: rule.maxFactor ?? null,
      minValue: rule.minValue ?? null,
      maxValue: rule.maxValue ?? null,
      severity: rule.severity,
      messageI18n: rule.messageI18n,
      status: rule.status,
    }),
  )
  const baseSizeRule: BaseSizeRule | null = body.baseSizeRule ? { points: body.baseSizeRule.points.map((code) => code.trim()), tie: body.baseSizeRule.tie } : null
  const limits: PointLimits[] = body.points.map((point) => ({ code: point.code.trim(), tolerance: blank(point.tolerance), alterationMinus: blank(point.alterationMinus), alterationPlus: blank(point.alterationPlus) }))

  const { result } = await command(
    caller,
    { name: 'product.mtmRules.save', idempotencyKey, input: { templateId, ...body }, record: { type: 'MeasurementTemplate', id: templateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const record = await readTemplate(tx, { id: templateId })
      if (!record) throw new NotFoundError('Measurement template not found.')
      const { template } = record
      if (template.status !== 'ACTIVE') throw new InvalidStateError(archivedRefusal(template.code))
      const points = templatePointsOf(record.points)
      const problems = [...rulesProblems(rules, points), ...baseSizeRuleProblems(baseSizeRule, points), ...limitsProblems(limits, points)]
      if (problems.length > 0) throw invalid(prefixed(problems), 'set of made-to-measure rules')
      const pointByCode = new Map(record.points.map((point) => [point.code, point]))

      // The points' limits (PRD-203; the inspection tolerance, B-W2b-97).
      const limitChanges: { code: string; before: PointLimits; after: PointLimits }[] = []
      for (const limit of limits) {
        const row = pointByCode.get(limit.code)!
        const before: PointLimits = { code: row.code, tolerance: decimalOrNull(row.tolerance), alterationMinus: decimalOrNull(row.alterationMinus), alterationPlus: decimalOrNull(row.alterationPlus) }
        if (sameDecimal(before.tolerance, limit.tolerance) && sameDecimal(before.alterationMinus, limit.alterationMinus) && sameDecimal(before.alterationPlus, limit.alterationPlus)) continue
        await tx.measurementPoint.update({
          where: { id: row.id },
          data: { tolerance: limit.tolerance, alterationMinus: limit.alterationMinus, alterationPlus: limit.alterationPlus, version: { increment: 1 }, updatedAt: now },
          select: { id: true },
        })
        limitChanges.push({ code: limit.code, before, after: limit })
      }

      // The base size rule (PRD-202).
      const beforeRule = baseSizeRuleOf(template.baseSizeRule)
      const ruleChanged = JSON.stringify(beforeRule) !== JSON.stringify(baseSizeRule)
      if (ruleChanged) {
        if (baseSizeRule) await tx.measurementTemplate.update({ where: { id: templateId }, data: { baseSizeRule: { points: [...baseSizeRule.points], tie: baseSizeRule.tie }, updatedAt: now }, select: { id: true } })
        // factory-db exports Prisma's types, not its runtime DbNull: a JSON column is cleared in SQL.
        else await tx.$executeRaw`UPDATE "MeasurementTemplate" SET "baseSizeRule" = NULL, "updatedAt" = ${now} WHERE "id" = ${templateId}::uuid`
      }

      // The plausibility rules (PRD-201), by code.
      const current = ruleFieldsOf(record.rules, record.points)
      const kept = new Map(record.rules.map((row, index) => [row.code, { row, fields: current[index]! }]))
      const gone = record.rules.filter((row) => !rules.some((rule) => rule.code === row.code))
      if (gone.length > 0) {
        const { count } = await tx.measurementRule.deleteMany({ where: { id: { in: gone.map((row) => row.id) } } })
        if (count !== gone.length) throw new ConflictError('The rules changed while they were saved: load them again.')
      }
      const added: string[] = []
      const updated: string[] = []
      for (const rule of rules) {
        const data = {
          kind: rule.kind,
          pointId: pointByCode.get(rule.pointCode)!.id,
          otherPointId: rule.otherPointCode === null ? null : pointByCode.get(rule.otherPointCode)!.id,
          minFactor: rule.minFactor,
          maxFactor: rule.maxFactor,
          minValue: rule.minValue,
          maxValue: rule.maxValue,
          severity: rule.severity,
          messageI18n: { ...rule.messageI18n },
          status: rule.status,
        }
        const existing = kept.get(rule.code)
        if (!existing) {
          await tx.measurementRule.create({ data: { id: newId(), templateId, code: rule.code, ...data, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null }, select: { id: true } })
          added.push(rule.code)
        } else if (!sameRule(existing.fields, rule)) {
          await tx.measurementRule.update({ where: { id: existing.row.id }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
          updated.push(rule.code)
        }
      }

      const anything = limitChanges.length > 0 || ruleChanged || gone.length > 0 || added.length > 0 || updated.length > 0
      tools.audit({
        recordType: 'MeasurementTemplate',
        recordId: templateId,
        companyId: template.companyId,
        before: { baseSizeRule: beforeRule, rules: current.filter((rule) => gone.some((row) => row.code === rule.code) || updated.includes(rule.code)), limits: limitChanges.map((entry) => entry.before) },
        after: anything
          ? { baseSizeRule, rules: rules.filter((rule) => added.includes(rule.code) || updated.includes(rule.code)), removed: gone.map((row) => row.code), limits: limitChanges.map((entry) => entry.after) }
          : { unchanged: true },
      })
      if (anything) changed(tools, template, 'RULES')
      const fresh = await readTemplate(tx, { id: templateId })
      return rulesViewOf(tx, fresh!, context)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('Another change saved a rule with the same code at the same time: load the rules again.')
    throw error
  })
  return result
}

/**
 * PUT /product/measurement-templates/:templateId/mtm-rules/switch: the template's rules on or off (product.mtm.switch, the
 * Owner's: GATE-MTM). On only while the template is active; asking for the state it is in already changes nothing.
 */
export async function switchRules(caller: CommandCaller, templateId: string, body: SwitchRulesBody, idempotencyKey?: string): Promise<TemplateRulesView> {
  const context = contextOf(caller)
  const seen = await readTemplateFor(caller, templateId)
  assertMayWrite(context, PRODUCT_MTM_SWITCH, seen.template.companyId, NOUN)
  if (seen.template.rulesOn === body.on && seen.template.version === body.version) return caller.withClient((client) => rulesViewOf(client, seen, context))
  const reason = blank(body.reason)

  const { result } = await command(
    caller,
    { name: 'product.mtmRules.switch', idempotencyKey, input: { templateId, ...body }, record: { type: 'MeasurementTemplate', id: templateId, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const record = await readTemplate(tx, { id: templateId })
      if (!record) throw new NotFoundError('Measurement template not found.')
      const { template } = record
      if (body.on && template.status !== 'ACTIVE') throw new InvalidStateError(`Measurement template ${template.code} is archived: its made-to-measure rules are not turned on.`)
      if (template.rulesOn !== body.on) {
        await tx.measurementTemplate.update({ where: { id: templateId }, data: { rulesOn: body.on, updatedAt: now }, select: { id: true } })
        changed(tools, template, body.on ? 'ON' : 'OFF')
      }
      tools.audit({ recordType: 'MeasurementTemplate', recordId: templateId, companyId: template.companyId, before: { rulesOn: template.rulesOn }, after: { rulesOn: body.on }, ...(reason ? { reason } : {}) })
      const fresh = await readTemplate(tx, { id: templateId })
      return rulesViewOf(tx, fresh!, context)
    },
  )
  return result
}
