import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PRODUCT_BOM_MANAGE } from '@nexus/factory-domain/product/bom/permissions'
import type { AppliedGradeView, ApplyGradeBody, GradePreviewBody, GradePreviewView } from '@nexus/factory-domain/product/grading/contracts'
import { gradeSpec, gradeWords, writtenCells, type GradeFormat, type GradePlan } from '@nexus/factory-domain/product/grading/rules'
import type { PlannedCell } from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { readRevisionFor, STYLE_COLUMNS } from '../bom/store'
import { writeCells } from '../measures/spec'
import { assertMayWrite, bumpSpec, contextOf, lockSpec, readLiveSpec, readSpecPoints, readValues, specViewInTx, type ValueRecord } from '../measures/store'
import { readScaleSizes, readSteps, RULE_COLUMNS, type RuleRowData } from './store'

/**
 * "Apply grade rule" on a style's measurement spec (B-W2b-224; PRD-052; design products.styles pop-up styles.grade: the
 * rule, a preview of the changed cells, manual overrides kept unless chosen). The preview is a read; the apply is one
 * command on the spec (its version, a DRAFT spec of a draft revision, the edit rule): every cell the rule reaches is
 * written GRADED (added, changed, or a typed value overwritten when asked), the spec names the rule, an audit row lists
 * the cells, `style.measurement_spec_changed` GRADED. Both answer the same plan (factory-domain product/grading
 * `gradeSpec`); the answer of the apply is the plan it wrote. The rule is an ACTIVE rule of the style's size scale.
 */

async function ruleFor(client: CommandTx | Parameters<Parameters<CommandCaller['withClient']>[0]>[0], caller: CommandCaller, ruleId: string, scaleId: string): Promise<RuleRowData> {
  const rule = isUuid(ruleId) ? await client.gradeRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS }) : null
  if (!rule || !can(actorOf(contextOf(caller)), PRODUCT_STYLES_VIEW, { companyId: rule.companyId })) throw new NotFoundError('Grade rule not found.')
  if (rule.sizeScaleId !== scaleId) throw new ConflictError(`Grade rule ${rule.code} is of another size scale than the style's: it does not grade this spec.`)
  if (rule.status !== 'ACTIVE') throw new InvalidStateError(`Grade rule ${rule.code} is archived: restore it to grade with it.`)
  return rule
}

async function planWith(client: CommandTx | Parameters<Parameters<CommandCaller['withClient']>[0]>[0], rule: RuleRowData, spec: { baseSize: string; id: string }, range: readonly string[], keepOverrides: boolean): Promise<{ plan: GradePlan; values: ValueRecord[]; codeOf: (id: string) => string }> {
  const values = await readValues(client, spec.id)
  const points = await readSpecPoints(
    client,
    values.map((value) => value.pointOfMeasureId),
  )
  const codeOf = (id: string) => points.get(id)?.code ?? id
  const scaleSizes = (await readScaleSizes(client, rule.sizeScaleId)).filter((size) => size.status === 'ACTIVE' || range.includes(size.code))
  const plan = gradeSpec({
    rule: { baseSize: rule.baseSize, format: rule.format as GradeFormat },
    steps: await readSteps(client, rule.id),
    scaleSizes,
    baseSize: spec.baseSize,
    range,
    values,
    codeOf,
    unitOf: (id) => points.get(id)?.uom ?? 'CM',
    keepOverrides,
  })
  return { plan, values, codeOf }
}

function previewOf(rule: RuleRowData, baseSize: string, keepOverrides: boolean, plan: GradePlan, codeOf: (id: string) => string): GradePreviewView {
  return {
    rule: { id: rule.id, code: rule.code, name: rule.name, format: rule.format as GradeFormat, baseSize: rule.baseSize },
    baseSize,
    keepOverrides,
    cells: plan.cells.map((cell) => ({ ...cell, code: codeOf(cell.pointOfMeasureId) })),
    notInRule: plan.notInRule.map((id) => ({ pointOfMeasureId: id, code: codeOf(id) })),
    noBase: plan.noBase.map((id) => ({ pointOfMeasureId: id, code: codeOf(id) })),
    counts: { ...plan.counts },
    words: gradeWords(plan),
  }
}

/** POST …/measurement-spec/grade/preview: what applying the rule would do, cell by cell (nothing is written). */
export async function previewGrade(caller: CommandCaller, styleId: string, revisionId: string, body: GradePreviewBody): Promise<GradePreviewView> {
  const { style } = await readRevisionFor(caller, styleId, revisionId)
  return caller.withClient(async (client) => {
    const spec = await readLiveSpec(client, revisionId)
    if (!spec) throw new NotFoundError('This revision has no measurement spec: start one first.')
    const rule = await ruleFor(client, caller, body.ruleId, style.sizeScaleId)
    const { plan, codeOf } = await planWith(client, rule, spec, style.sizes, body.keepOverrides)
    return previewOf(rule, spec.baseSize, body.keepOverrides, plan, codeOf)
  })
}

/** product.measures.grade: the rule applied to the draft spec (see above). */
export async function applyGrade(caller: CommandCaller, styleId: string, revisionId: string, body: ApplyGradeBody, idempotencyKey?: string): Promise<AppliedGradeView> {
  const { style: seen } = await readRevisionFor(caller, styleId, revisionId)
  assertMayWrite(contextOf(caller), PRODUCT_BOM_MANAGE, seen.companyId, 'measurement spec of a style')

  const { result } = await command(caller, { name: 'product.measures.grade', idempotencyKey, input: { styleId, revisionId, ...body } }, async (tools) => {
    const { tx } = tools
    const locked = await lockSpec(tools, styleId, revisionId, body.version)
    const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: STYLE_COLUMNS })
    const rule = await ruleFor(tx, caller, body.ruleId, style.sizeScaleId)
    const { plan, values, codeOf } = await planWith(tx, rule, locked.spec, style.sizes, body.keepOverrides)
    const byKey = new Map(values.map((value) => [`${value.pointOfMeasureId}|${value.size}`, value]))
    const cells: PlannedCell[] = writtenCells(plan).map((cell) => ({ pointOfMeasureId: cell.pointOfMeasureId, size: cell.size, ...cell.after!, source: 'GRADED', before: byKey.get(`${cell.pointOfMeasureId}|${cell.size}`) ?? null }))
    const written = await writeCells(tools, locked, values, cells, 'GRADED')
    await bumpSpec(tools, locked, locked.spec.gradeRuleId === rule.id ? {} : { gradeRuleId: rule.id })
    const { style: lockedStyle, revision } = locked
    tools.audit({
      recordType: 'MeasurementSpec',
      recordId: locked.spec.id,
      companyId: lockedStyle.companyId,
      after: { styleId, revisionId, revision: revision.revision, change: 'GRADED', rule: rule.code, keepOverrides: body.keepOverrides, written, counts: plan.counts, cells: writtenCells(plan).slice(0, 200).map((cell) => cell.words) },
    })
    tools.emit({ type: 'style.measurement_spec_changed', subject: styleId, companyId: lockedStyle.companyId, payload: { styleId, code: lockedStyle.code, revisionId, revision: revision.revision, specId: locked.spec.id, change: 'GRADED' } })
    return { spec: await specViewInTx(tx, styleId, revisionId), applied: previewOf(rule, locked.spec.baseSize, body.keepOverrides, plan, codeOf) }
  }).catch((error: unknown) => {
    if ((error as { code?: unknown } | null)?.code === 'P2002') throw new ConflictError('Another change wrote the same cell at the same time: load the spec again.')
    throw error
  })
  return result
}
