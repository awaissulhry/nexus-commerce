import { z } from 'zod'
import { id, input, instant, output } from '../../core/contracts'
import { POM_STATUSES, POM_UOMS, VALUE_SOURCES } from '../measures/rules'
import { measurementSpecView } from '../measures/contracts'
import { GRADE_ACTIONS, GRADE_FORMATS, RULE_LIMITS, RULE_STATUSES } from './rules'

/**
 * The grade rules' contracts (B-W2b-224; PRD-049, PRD-051, PRD-052; design products.sizes "Grade rules", the Grade rule
 * pop-up, the size scale's Grade rules tab, products.styles "Apply grade rule"): what apps/factory-api's
 * modules/product/grading accepts and answers. No money. Increments travel as plain decimal strings ("1.5", "-0.5").
 */

const version = () => z.number().int().min(1)
const sizeCode = () => z.string().trim().min(1).max(40)

export const listRulesQuery = input({
  q: z.string().trim().max(100).optional(),
  /** One scale's rules (the scale's Grade rules tab). */
  scaleId: id().optional(),
  status: z.enum([...RULE_STATUSES, 'ALL']).default('ACTIVE'),
  companyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
})
export type ListRulesQuery = z.output<typeof listRulesQuery>

const stepInput = input({
  pointOfMeasureId: id(),
  /** Both, or neither: the point's standard increment of every step. */
  fromSize: sizeCode().nullable(),
  toSize: sizeCode().nullable(),
  increment: z.string().trim().min(1).max(12),
})

export const createRuleBody = input({
  companyId: id().nullish(),
  code: z.string().trim().min(1).max(60),
  name: z.string().max(RULE_LIMITS.name),
  sizeScaleId: id(),
  baseSize: sizeCode(),
  format: z.enum(GRADE_FORMATS).default('RELATIVE'),
  steps: z.array(stepInput).max(RULE_LIMITS.steps).default([]),
})
export type CreateRuleBody = z.output<typeof createRuleBody>

/** Its name; its code, base size and format (the steps are checked again); ARCHIVED out of new specs, ACTIVE back. */
export const updateRuleBody = input({
  version: version(),
  code: z.string().trim().min(1).max(60).optional(),
  name: z.string().max(RULE_LIMITS.name).optional(),
  baseSize: sizeCode().optional(),
  format: z.enum(GRADE_FORMATS).optional(),
  status: z.enum(RULE_STATUSES).optional(),
})
export type UpdateRuleBody = z.output<typeof updateRuleBody>

/** The Grade rule pop-up's Save: every step of the rule (what is left out goes). */
export const ruleStepsBody = input({ version: version(), steps: z.array(stepInput).max(RULE_LIMITS.steps) })
export type RuleStepsBody = z.output<typeof ruleStepsBody>

/** The list's selection: several rules archived or restored in one write. */
export const ruleStatusBody = input({ rules: z.array(input({ id: id(), version: version() })).min(1).max(200), status: z.enum(RULE_STATUSES) })
export type RuleStatusBody = z.output<typeof ruleStatusBody>

/** "Apply grade rule": the rule (of the style's scale), and whether typed values on other sizes are kept (default) or overwritten. */
export const gradePreviewBody = input({ ruleId: id(), keepOverrides: z.boolean().default(true) })
export type GradePreviewBody = z.output<typeof gradePreviewBody>
export const applyGradeBody = input({ version: version(), ruleId: id(), keepOverrides: z.boolean().default(true) })
export type ApplyGradeBody = z.output<typeof applyGradeBody>

const scaleRef = output({ id: id(), code: z.string(), name: z.string(), dimensions: z.number().int() })

export const ruleRow = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  scale: scaleRef,
  baseSize: z.string(),
  format: z.enum(GRADE_FORMATS),
  /** The points it grades, and its steps. */
  points: z.number().int(),
  steps: z.number().int(),
  /** Specs graded with it (any status). */
  specs: z.number().int(),
  status: z.enum(RULE_STATUSES),
  version: z.number().int(),
  updatedAt: instant(),
})
export type RuleRow = z.infer<typeof ruleRow>

const stepView = output({ id: id(), fromSize: z.string().nullable(), toSize: z.string().nullable(), increment: z.string() })

export const ruleView = output({
  ...ruleRow.shape,
  /** The scale's sizes in order, with their fit on a two-dimension scale. */
  sizes: z.array(output({ code: z.string(), label: z.string().nullable(), fitCode: z.string().nullable(), status: z.string() })),
  /** Per point: its standard increment and its steps between two sizes (SizeColumns). */
  byPoint: z.array(
    output({ pointOfMeasureId: id(), code: z.string(), name: z.string(), uom: z.enum(POM_UOMS), status: z.enum(POM_STATUSES), standard: z.string().nullable(), steps: z.array(stepView) }),
  ),
  createdAt: instant(),
  createdById: id().nullable(),
})
export type RuleView = z.infer<typeof ruleView>

const cellValue = output({ nominal: z.string(), toleranceMinus: z.string(), tolerancePlus: z.string() })

export const gradePreviewView = output({
  rule: output({ id: id(), code: z.string(), name: z.string(), format: z.enum(GRADE_FORMATS), baseSize: z.string() }),
  baseSize: z.string(),
  keepOverrides: z.boolean(),
  /** Every cell the rule reaches or misses (ReviewChangesPanel): what it is, what it becomes, in words. */
  cells: z.array(
    output({
      pointOfMeasureId: id(),
      code: z.string(),
      size: z.string(),
      action: z.enum(GRADE_ACTIONS),
      before: output({ ...cellValue.shape, source: z.enum(VALUE_SOURCES) }).nullable(),
      after: cellValue.nullable(),
      words: z.string(),
    }),
  ),
  notInRule: z.array(output({ pointOfMeasureId: id(), code: z.string() })),
  noBase: z.array(output({ pointOfMeasureId: id(), code: z.string() })),
  counts: z.record(z.enum(GRADE_ACTIONS), z.number().int()),
  words: z.string(),
})
export type GradePreviewView = z.infer<typeof gradePreviewView>

export const appliedGradeView = output({ spec: measurementSpecView, applied: gradePreviewView })
export type AppliedGradeView = z.infer<typeof appliedGradeView>
