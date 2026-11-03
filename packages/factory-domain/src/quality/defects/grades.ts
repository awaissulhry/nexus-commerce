import type { Issue } from '../../core/errors'
import { Dec } from '../../tax/decimal'
import { appliesAt, wordsProblems, type QualityStage, type WordsDraft } from './rules'

/**
 * Leather grades and hide defects as one vocabulary for incoming and cutting (B-W2b-90; QHS-006; design quality.defects
 * df-grades "Grades A-D; hide defect types with icons"; factory-db leather.prisma LeatherGrade, B-W2b-80), pure.
 *
 *   grades        the tenant's one list (A, B, C, D …): a code of 1 to 10 upper-case letters, digits, hyphens or
 *                 underscores that never changes (a hide copies it into Hide.grade), Italian and English words, the
 *                 other floor languages, the share of a hide of the grade that can be cut (percent, 0 to 100, at most two
 *                 decimals: the default when an article has no grade rule of its own, B-W2b-94), the order of the tiles.
 *                 A grade is retired, never deleted (the database refuses a DELETE); a retired grade is taken by no new
 *                 hide, rule or mark, and stays on those that have it.
 *   hide defects  the defects of the library's hide category (LEATHER, the starter set's) that apply at incoming or
 *                 cutting (a defect with no stages applies everywhere): what an incoming inspection marks on a hide
 *                 (HideMark.defectCodeId) and what the cutter avoids. They are kept in the defect library, as every
 *                 defect is; this list only gathers them. Their icon is their own, else their category's.
 */

/** A grade's code: 1-10 upper-case letters, digits, hyphens, underscores (the guard: no spaces). */
export const GRADE_CODE = /^[A-Z0-9][A-Z0-9_-]{0,9}$/

/** A usable share: a percent from 0 to 100 with at most two decimals ("85", "72.5"). */
export const USABLE_SHARE = /^\d{1,3}(\.\d{1,2})?$/

export const GRADE_LIMITS = Object.freeze({ perTenant: 50 })

/** The library category whose defects are the hide defects (the starter set's LEATHER). */
export const HIDE_DEFECT_CATEGORY = 'LEATHER' as const

/** The stages the hide vocabulary serves: the incoming inspection of a lot and the cutting table. */
export const HIDE_STAGES = ['INCOMING', 'CUTTING'] as const satisfies readonly QualityStage[]

export interface GradeDraft extends Omit<WordsDraft, 'icon' | 'colour'> {
  readonly code?: string | undefined
  readonly usableShare?: string | undefined
  readonly sortOrder?: number | undefined
}

const shareProblem = (value: string): string | null => {
  const text = value.trim()
  if (!USABLE_SHARE.test(text) || new Dec(text).greaterThan(100)) return 'The usable share is a percent from 0 to 100, at most two decimals ("72.5").'
  return null
}

/** A new grade (`creating`) or a change of one: a change never names the code. */
export function gradeDraftProblems(draft: GradeDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating && (draft.code === undefined || !GRADE_CODE.test(draft.code))) problems.push({ path: 'code', message: 'A grade is 1 to 10 upper-case letters, digits, hyphens and underscores (A, B, 1-ST).' })
  if (!creating && draft.code !== undefined) problems.push({ path: 'code', message: 'A grade\'s code never changes (hides copy it): retire it and add another.' })
  problems.push(...wordsProblems(draft, 'grade'))
  if (creating) {
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Name the grade in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Name the grade in English.' })
    if (draft.usableShare === undefined) problems.push({ path: 'usableShare', message: 'Say what share of a hide of this grade can be cut, in percent.' })
  }
  if (draft.usableShare !== undefined) {
    const problem = shareProblem(draft.usableShare)
    if (problem) problems.push({ path: 'usableShare', message: problem })
  }
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > 1_000_000)) problems.push({ path: 'sortOrder', message: 'A whole number from 0.' })
  return problems
}

/** The usable share as the database keeps it (Decimal(5,2)): "72.50". */
export const usableShareText = (value: string): string => new Dec(value.trim()).toFixed(2)

/** Is a defect of the library a hide defect: in the hide category, applying at incoming or cutting (or every stage)? */
export function isHideDefect(defect: { readonly stages: readonly string[] }, categoryCode: string): boolean {
  return categoryCode === HIDE_DEFECT_CATEGORY && HIDE_STAGES.some((stage) => appliesAt(defect.stages, stage))
}

export interface StarterGrade {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly usableShare: string
}

const g = (code: string, labelIt: string, labelEn: string, usableShare: string): StarterGrade => Object.freeze({ code, labelIt, labelEn, usableShare })

/** Grades A-D (the design's; the seed's codes and shares, so a seeded tenant misses none). Made-up shares. */
export const STARTER_GRADES: readonly StarterGrade[] = Object.freeze([
  g('A', 'Prima scelta', 'First choice', '85.00'),
  g('B', 'Seconda scelta', 'Second choice', '72.00'),
  g('C', 'Terza scelta', 'Third choice', '60.00'),
  g('D', 'Quarta scelta', 'Fourth choice', '45.00'),
])

/** The starter grades a tenant does not have yet (by code), in order. */
export const missingGrades = (existing: ReadonlySet<string>): StarterGrade[] => STARTER_GRADES.filter((grade) => !existing.has(grade.code))
