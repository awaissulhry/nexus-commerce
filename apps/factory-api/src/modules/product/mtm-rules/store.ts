import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { baseSizeRuleOf, type BaseSizeRule, type RuleFields, type RuleKind, type RuleSeverity, type RuleStatus, type TemplatePoint, type Words } from '@nexus/factory-domain/product/mtm-rules/rules'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../materials/store'

/**
 * The made-to-measure rules' rows (B-W2b-248): a measurement template (factory-db `MeasurementTemplate`, W1) with its
 * points (`MeasurementPoint`: alteration limits and inspection tolerance, B-W2b-210) and plausibility rules
 * (`MeasurementRule`), read by id or by code (a profile's garment type, the measurement link's), and as the domain's rules
 * read them (rules by their points' codes). Every read names its columns and reads its relations one after another (a
 * transaction client runs one query at a time). Who may: the template's company, as the size library (product.styles.view).
 */

export { contextOf }

export type Reader = FactoryClient | CommandTx

export const TEMPLATE_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  productType: true,
  status: true,
  rulesOn: true,
  baseSizeRule: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.MeasurementTemplateSelect
export type TemplateRow = Prisma.MeasurementTemplateGetPayload<{ select: typeof TEMPLATE_COLUMNS }>

export const POINT_COLUMNS = {
  id: true,
  code: true,
  name: true,
  nameI18n: true,
  seq: true,
  uom: true,
  required: true,
  minValue: true,
  maxValue: true,
  tolerance: true,
  alterationMinus: true,
  alterationPlus: true,
  status: true,
  pointOfMeasureId: true,
} as const satisfies Prisma.MeasurementPointSelect
export type PointRow = Prisma.MeasurementPointGetPayload<{ select: typeof POINT_COLUMNS }>

export const RULE_COLUMNS = {
  id: true,
  code: true,
  kind: true,
  pointId: true,
  otherPointId: true,
  minFactor: true,
  maxFactor: true,
  minValue: true,
  maxValue: true,
  severity: true,
  messageI18n: true,
  status: true,
} as const satisfies Prisma.MeasurementRuleSelect
export type RuleRow = Prisma.MeasurementRuleGetPayload<{ select: typeof RULE_COLUMNS }>

export interface TemplateRecord {
  readonly template: TemplateRow
  /** In the template's order. */
  readonly points: readonly PointRow[]
  /** In code order. */
  readonly rules: readonly RuleRow[]
}

const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

/** Words per language as stored (JSON), the strings only. */
export function wordsOf(value: unknown): Words {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

export const nameWordsOf = (value: unknown): Words | null => (value === null || value === undefined ? null : wordsOf(value))

/** A template with its points and rules, by id or by code (null: none). */
export async function readTemplate(db: Reader, where: { readonly id: string } | { readonly code: string }): Promise<TemplateRecord | null> {
  if ('id' in where && !isUuid(where.id)) return null
  const template = 'id' in where ? await db.measurementTemplate.findUnique({ where: { id: where.id }, select: TEMPLATE_COLUMNS }) : await db.measurementTemplate.findFirst({ where: { code: where.code }, select: TEMPLATE_COLUMNS })
  if (!template) return null
  const points = await db.measurementPoint.findMany({ where: { templateId: template.id }, select: POINT_COLUMNS, orderBy: [{ seq: 'asc' }, { code: 'asc' }] })
  const rules = await db.measurementRule.findMany({ where: { templateId: template.id }, select: RULE_COLUMNS, orderBy: { code: 'asc' } })
  return { template, points, rules }
}

/** The template as the caller may see it (another company's, outside the caller's grants, or another tenant's: not found). */
export async function readTemplateFor(caller: CommandCaller, templateId: string): Promise<TemplateRecord> {
  const context = contextOf(caller)
  const record = await caller.withClient((client) => readTemplate(client, { id: templateId }))
  if (!record || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: record.template.companyId })) throw new NotFoundError('Measurement template not found.')
  return record
}

/** The points as the domain's rules read them. */
export const templatePointsOf = (points: readonly PointRow[]): TemplatePoint[] =>
  points.map((point) => ({ id: point.id, code: point.code, name: point.name, uom: point.uom, status: point.status, alterationMinus: text(point.alterationMinus), alterationPlus: text(point.alterationPlus) }))

/** The rules by their points' codes, as the domain reads them. */
export function ruleFieldsOf(rules: readonly RuleRow[], points: readonly PointRow[]): RuleFields[] {
  const codeOf = new Map(points.map((point) => [point.id, point.code]))
  return rules.map((rule) => ({
    code: rule.code,
    kind: rule.kind as RuleKind,
    pointCode: codeOf.get(rule.pointId) ?? '?',
    otherPointCode: rule.otherPointId === null ? null : (codeOf.get(rule.otherPointId) ?? '?'),
    minFactor: text(rule.minFactor),
    maxFactor: text(rule.maxFactor),
    minValue: text(rule.minValue),
    maxValue: text(rule.maxValue),
    severity: rule.severity as RuleSeverity,
    messageI18n: wordsOf(rule.messageI18n),
    status: rule.status as RuleStatus,
  }))
}

/** The template as the one check reads it. */
export function checkTemplateOf(record: TemplateRecord): { id: string; code: string; rulesOn: boolean; baseSizeRule: BaseSizeRule | null; points: TemplatePoint[]; rules: RuleFields[] } {
  return {
    id: record.template.id,
    code: record.template.code,
    rulesOn: record.template.rulesOn,
    baseSizeRule: baseSizeRuleOf(record.template.baseSizeRule),
    points: templatePointsOf(record.points),
    rules: ruleFieldsOf(record.rules, record.points),
  }
}

/** A stored decimal as a plain string ("4.00" → "4"), or null. */
export const decimalOrNull = text
