import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'

/**
 * The calls of the material's "Grades and usable area" section (B-W2b-131 on B-W2b-94's API; PRD-031; design
 * products.materials › Material › Properties & grades › material.props.grades), each answer checked against the shape of
 * the API's contract (apps/factory-api modules/inventory/hides/contract.ts: gradeRulesContract, createGradeRuleContract,
 * editGradeRuleContract). Shares are percents as decimal strings with two places ("74.00"); panels are words (empty: every
 * panel). Every write sends an idempotency key; a change of a rule sends the version it was read at (a 409 reads again).
 */

const gradeRef = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })
const ruleRef = z.object({ id: z.string(), usableShare: z.string(), panels: z.array(z.string()), version: z.number().int(), updatedAt: z.string() })

export const gradeRuleRowSchema = z.object({
  /** The grade, with its own default share (no rule of the article's). */
  grade: gradeRef.extend({ defaultShare: z.string() }),
  /** The article's own active rule for the grade; null: the grade's default applies. */
  rule: ruleRef.nullable(),
  /** What applies: the rule's share, else the grade's default. */
  share: z.string(),
  source: z.enum(['RULE', 'GRADE']),
  /** The panels the grade may be cut for; empty: every panel. */
  panels: z.array(z.string()),
  /** Earlier rules of the article for the grade, retired (history). */
  retiredRules: z.array(ruleRef),
  /** Hides of the article in stock with this grade. */
  hidesInStock: z.number().int(),
})
export type GradeRuleRow = z.infer<typeof gradeRuleRowSchema>
export type GradeRule = z.infer<typeof ruleRef>

export const gradesViewSchema = z.object({
  material: z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), tracksHides: z.boolean() }),
  /** Every active grade, and a retired one the article still has a rule for, in tile order. Empty: not tracked by the hide. */
  grades: z.array(gradeRuleRowSchema),
  /** product.materials.manage over the material's company (a material of every company: over every company). */
  canManage: z.boolean(),
})
export type GradesView = z.infer<typeof gradesViewSchema>

const one = z.object({ grade: gradeRuleRowSchema })
const enc = encodeURIComponent
const base = (materialId: string) => `/product/materials/${enc(materialId)}/grades`

/** GET /product/materials/:materialId/grades. */
export function getGrades(api: ApiClient, materialId: string): Promise<GradesView> {
  return api.get(base(materialId), { schema: gradesViewSchema })
}

export interface CreateRuleBody {
  gradeId: string
  usableShare: string
  panels?: string[]
}

/** POST …/grades: the article's own rule for a grade (201); the row as it now reads. */
export function createRule(api: ApiClient, materialId: string, body: CreateRuleBody): Promise<GradeRuleRow> {
  return api.post(base(materialId), { body, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.grade)
}

export interface RulePatch {
  usableShare?: string
  panels?: string[]
  /** false: retire (back to the grade's default); true: use a retired rule again. */
  active?: boolean
}

/** PATCH …/grades/:ruleId at the rule's version; the row as it now reads. */
export function editRule(api: ApiClient, materialId: string, rule: { id: string; version: number }, patch: RulePatch): Promise<GradeRuleRow> {
  return api.request('PATCH', `${base(materialId)}/${enc(rule.id)}`, { body: { ...patch, version: rule.version }, schema: one, idempotencyKey: newIdempotencyKey() }).then((answer) => answer.grade)
}
