/**
 * What the hides module's events name (B-W2b-94; the events themselves are declared in inventory/events.ts, the module's one
 * events file): what changed on a hide graded by the office, and what happened to an article's grade rule.
 */

export const GRADING_CHANGES = ['GRADE', 'SHADE', 'THICKNESS', 'DEFECTS'] as const
export type GradingChange = (typeof GRADING_CHANGES)[number]

export const GRADE_RULE_CHANGES = ['CREATED', 'EDITED', 'RETIRED', 'REACTIVATED'] as const
export type GradeRuleChange = (typeof GRADE_RULE_CHANGES)[number]
