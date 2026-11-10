import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { RuleRow, RuleView } from '@nexus/factory-domain/product/grading/contracts'
import { stepsByPoint, type GradeFormat, type RuleStatus, type ScaleSize, type StepData, type StepPoint } from '@nexus/factory-domain/product/grading/rules'
import { measureText, type PomStatus, type PomUom } from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../measures/store'

/**
 * The grade rules' rows (factory-db `GradeRule`, `GradeRuleStep`, B-W2b-210) and what they name (`SizeScale`, `Size`,
 * `PointOfMeasure`): the columns every read names, how they become the views, and who may see a rule (product.styles.view
 * over its company, as its size scale). A rule's writes go through command()'s record guard on the rule (its version);
 * its steps are written under that lock.
 */

export const RULE_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  sizeScaleId: true,
  baseSize: true,
  format: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.GradeRuleSelect
export type RuleRowData = Prisma.GradeRuleGetPayload<{ select: typeof RULE_COLUMNS }>

export const STEP_COLUMNS = { id: true, pointOfMeasureId: true, fromSize: true, toSize: true, increment: true } as const satisfies Prisma.GradeRuleStepSelect

type Client = FactoryClient | CommandTx

export interface StepRecord extends StepData {
  readonly id: string
}

export async function readSteps(client: Client, ruleId: string): Promise<StepRecord[]> {
  const rows = await client.gradeRuleStep.findMany({ where: { ruleId }, select: STEP_COLUMNS, orderBy: [{ pointOfMeasureId: 'asc' }, { fromSize: 'asc' }, { toSize: 'asc' }] })
  return rows.map((row) => ({ id: row.id, pointOfMeasureId: row.pointOfMeasureId, fromSize: row.fromSize, toSize: row.toSize, increment: measureText(row.increment.toString()) }))
}

/** The scale's sizes in order, with their fit, every status (grading reads the active ones). */
export async function readScaleSizes(client: Client, scaleId: string): Promise<(ScaleSize & { label: string | null; status: string })[]> {
  const rows = await client.size.findMany({ where: { scaleId }, select: { code: true, seq: true, fitCode: true, label: true, status: true }, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  return rows.map((row) => ({ code: row.code, seq: row.seq, fitCode: row.fitCode, label: row.label, status: String(row.status) }))
}

/** The rule as the caller may see it (its company, as its scale's); another's is not found. */
export async function readRuleFor(caller: CommandCaller, ruleId: string): Promise<RuleRowData> {
  const context = contextOf(caller)
  const row = isUuid(ruleId) ? await caller.withClient((client) => client.gradeRule.findUnique({ where: { id: ruleId }, select: RULE_COLUMNS })) : null
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Grade rule not found.')
  return row
}

/** The points the steps name, as the step rules read them. */
export async function readStepPoints(client: Client, ids: readonly string[]): Promise<Map<string, StepPoint & { name: string; uom: PomUom }>> {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return new Map()
  const rows = await client.pointOfMeasure.findMany({ where: { id: { in: unique } }, select: { id: true, code: true, name: true, kind: true, status: true, uom: true } })
  return new Map(rows.map((row) => [row.id, { id: row.id, code: row.code, name: row.name, kind: row.kind as StepPoint['kind'], status: row.status as StepPoint['status'], uom: row.uom as PomUom }]))
}

/** Rows of the list: their scale, how many points and steps, how many specs use each. */
export async function ruleRowsOf(client: Client, rows: readonly RuleRowData[]): Promise<RuleRow[]> {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const scales = new Map((await client.sizeScale.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.sizeScaleId))] } }, select: { id: true, code: true, name: true, dimensions: true } })).map((row) => [row.id, row]))
  const steps = await client.gradeRuleStep.groupBy({ by: ['ruleId', 'pointOfMeasureId'], where: { ruleId: { in: ids } }, _count: { _all: true } })
  const specs = await client.measurementSpec.groupBy({ by: ['gradeRuleId'], where: { gradeRuleId: { in: ids } }, _count: { _all: true } })
  return rows.map((row) => {
    const own = steps.filter((entry) => entry.ruleId === row.id)
    const scale = scales.get(row.sizeScaleId)
    return {
      id: row.id,
      companyId: row.companyId,
      code: row.code,
      name: row.name,
      scale: { id: row.sizeScaleId, code: scale?.code ?? '', name: scale?.name ?? '', dimensions: scale?.dimensions ?? 1 },
      baseSize: row.baseSize,
      format: row.format as GradeFormat,
      points: own.length,
      steps: own.reduce((sum, entry) => sum + entry._count._all, 0),
      specs: specs.find((entry) => entry.gradeRuleId === row.id)?._count._all ?? 0,
      status: row.status as RuleStatus,
      version: row.version,
      updatedAt: toUtcIso(row.updatedAt),
    }
  })
}

/** One rule with its scale's sizes and its steps per point (the Grade rule pop-up). */
export async function ruleViewOf(client: Client, row: RuleRowData): Promise<RuleView> {
  const [base] = await ruleRowsOf(client, [row])
  const sizes = await readScaleSizes(client, row.sizeScaleId)
  const steps = await readSteps(client, row.id)
  const points = await readStepPoints(
    client,
    steps.map((step) => step.pointOfMeasureId),
  )
  const grouped = [...stepsByPoint(steps)].map(([pointId, list]) => {
    const point = points.get(pointId)
    return {
      pointOfMeasureId: pointId,
      code: point?.code ?? '',
      name: point?.name ?? '',
      uom: point?.uom ?? 'CM',
      status: (point?.status ?? 'ACTIVE') as PomStatus,
      standard: list.find((step) => step.fromSize === null)?.increment ?? null,
      steps: list.filter((step) => step.fromSize !== null).map((step) => ({ id: step.id!, fromSize: step.fromSize, toSize: step.toSize, increment: step.increment })),
    }
  })
  grouped.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  return {
    ...base!,
    sizes: sizes.map((size) => ({ code: size.code, label: size.label, fitCode: size.fitCode, status: size.status })),
    byPoint: grouped,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}
