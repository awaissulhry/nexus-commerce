import { QUANTITY_SCALE } from '../../product/units/units'
import { Dec, HUNDRED, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Leather grades and usable area (B-W2b-94; PRD-031, SCM-250; factory-db leather.prisma LeatherGrade, ItemGradeRule, B-W2b-80),
 * pure. A hide's grade is a record of the tenant's list (Hide.gradeId); a W1 hide graded in text only takes the grade whose
 * code its text is (`byText`), and a text no grade has leaves it ungraded. The share of a hide that can be cut is the
 * article's own rule for the grade (ItemGradeRule, active) or else the grade's default (LeatherGrade.usableShare):
 *
 *   usable area = area × share ÷ 100      (four decimals, rounded down: an estimate never promises more leather)
 *
 * The area is what is left of the hide (a whole hide: its measured area). Grade mix: per grade the hides, their measured
 * area, what is left and its usable area; the ungraded hides apart, with no usable area (nobody knows it). Planning and the
 * incoming inspection read these; nothing here changes a figure already recorded.
 */

export interface GradeFacts {
  readonly id: string
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  /** Percent, "72.00": the default of an article with no rule of its own. */
  readonly usableShare: string
  readonly sortOrder: number
  readonly active: boolean
}

export interface RuleFacts {
  readonly id: string
  readonly gradeId: string
  readonly usableShare: string
  readonly panels: readonly string[]
  readonly active: boolean
}

export const SHARE_SOURCES = ['RULE', 'GRADE'] as const
export type ShareSource = (typeof SHARE_SOURCES)[number]

export interface Share {
  /** Percent with two decimals. */
  readonly share: string
  /** RULE: the article's own rule for the grade; GRADE: the grade's default. */
  readonly source: ShareSource
  /** The panels the article's rule allows the grade for; empty: every panel (and always for a grade's default). */
  readonly panels: readonly string[]
}

/** The article's active rules by grade (one per grade: the database's ItemGradeRule_one_active). */
export function activeRules(rules: readonly RuleFacts[]): Map<string, RuleFacts> {
  return new Map(rules.filter((rule) => rule.active).map((rule) => [rule.gradeId, rule]))
}

/** The share of a hide of this grade that can be cut, for the article whose active rules are given. */
export function shareFor(grade: GradeFacts, rules: ReadonlyMap<string, RuleFacts>): Share {
  const rule = rules.get(grade.id)
  return rule
    ? { share: new Dec(rule.usableShare).toFixed(2), source: 'RULE', panels: [...rule.panels] }
    : { share: new Dec(grade.usableShare).toFixed(2), source: 'GRADE', panels: [] }
}

/** area × share ÷ 100, four decimals, rounded down. */
export function usableArea(area: DecimalInput, share: DecimalInput): Decimal {
  return new Dec(area.toString()).times(share.toString()).dividedBy(HUNDRED).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_DOWN)
}

export interface GradeOfHide {
  readonly grade: GradeFacts | null
  /** The grade was found by the hide's W1 text, not by its record. */
  readonly byText: boolean
}

/**
 * The grade of a hide: its record, else the grade whose code its text is (trimmed, any case), else none. A retired grade a
 * hide names stays its grade.
 */
export function gradeOfHide(hide: { readonly gradeId: string | null; readonly grade: string | null }, grades: readonly GradeFacts[]): GradeOfHide {
  if (hide.gradeId) {
    const named = grades.find((grade) => grade.id === hide.gradeId)
    if (named) return { grade: named, byText: false }
  }
  const text = hide.grade?.trim().toUpperCase()
  if (!text) return { grade: null, byText: false }
  const byCode = grades.find((grade) => grade.code === text)
  return byCode ? { grade: byCode, byText: true } : { grade: null, byText: false }
}

/** The grades a hide of the article may be given: the grades of its active rules, else every active grade; in tile order. */
export function gradesForArticle(grades: readonly GradeFacts[], rules: ReadonlyMap<string, RuleFacts>): GradeFacts[] {
  const ordered = [...grades].sort(byOrder)
  if (rules.size === 0) return ordered.filter((grade) => grade.active)
  return ordered.filter((grade) => grade.active && rules.has(grade.id))
}

export const byOrder = (a: Pick<GradeFacts, 'sortOrder' | 'code'>, b: Pick<GradeFacts, 'sortOrder' | 'code'>): number =>
  a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

/** One hide as the grade mix counts it: its grade, its measured area and what is left, both in one area unit. */
export interface MixHide {
  readonly gradeId: string | null
  readonly grade: string | null
  readonly measured: DecimalInput
  readonly left: DecimalInput
}

export interface MixRow {
  /** Null: the ungraded hides (no record, and a text no grade has, or none). */
  readonly grade: GradeFacts | null
  /** The texts of the ungraded hides, as W1 wrote them (none: an empty list). */
  readonly texts: readonly string[]
  readonly hides: number
  /** Hides graded by their W1 text only. */
  readonly byText: number
  readonly measured: Decimal
  readonly left: Decimal
  /** Null for the ungraded hides. */
  readonly share: Share | null
  readonly usable: Decimal | null
  /** The row's share of the hides' measured area, percent with two decimals. */
  readonly percentOfArea: string
}

export interface Mix {
  readonly rows: readonly MixRow[]
  readonly hides: number
  readonly measured: Decimal
  readonly left: Decimal
  /** The usable area of the graded hides. */
  readonly usable: Decimal
  /** What is left of the ungraded hides: its usable area is unknown. */
  readonly ungradedLeft: Decimal
}

/**
 * The grade mix of a set of hides of ONE article (its rules apply): per grade in tile order, then the ungraded hides; a
 * grade no hide has is not listed.
 */
export function gradeMix(hides: readonly MixHide[], grades: readonly GradeFacts[], rules: ReadonlyMap<string, RuleFacts>): Mix {
  interface Acc {
    grade: GradeFacts | null
    texts: Set<string>
    hides: number
    byText: number
    measured: Decimal
    left: Decimal
  }
  const byGrade = new Map<string, Acc>()
  let measured = ZERO
  let left = ZERO
  for (const hide of hides) {
    const { grade, byText } = gradeOfHide(hide, grades)
    const key = grade?.id ?? ''
    const acc = byGrade.get(key) ?? { grade, texts: new Set<string>(), hides: 0, byText: 0, measured: ZERO, left: ZERO }
    acc.hides += 1
    if (byText) acc.byText += 1
    if (!grade && hide.grade?.trim()) acc.texts.add(hide.grade.trim())
    acc.measured = acc.measured.plus(hide.measured.toString())
    acc.left = acc.left.plus(hide.left.toString())
    byGrade.set(key, acc)
    measured = measured.plus(hide.measured.toString())
    left = left.plus(hide.left.toString())
  }
  const ordered = [...byGrade.values()].sort((a, b) => (a.grade && b.grade ? byOrder(a.grade, b.grade) : a.grade ? -1 : b.grade ? 1 : 0))
  let usable = ZERO
  let ungradedLeft = ZERO
  const rows = ordered.map((acc): MixRow => {
    const share = acc.grade ? shareFor(acc.grade, rules) : null
    const usableHere = share ? usableArea(acc.left, share.share) : null
    if (usableHere) usable = usable.plus(usableHere)
    else ungradedLeft = ungradedLeft.plus(acc.left)
    return {
      grade: acc.grade,
      texts: [...acc.texts].sort(),
      hides: acc.hides,
      byText: acc.byText,
      measured: acc.measured,
      left: acc.left,
      share,
      usable: usableHere,
      percentOfArea: measured.isZero() ? '0.00' : acc.measured.times(HUNDRED).dividedBy(measured).toFixed(2, Dec.ROUND_HALF_UP),
    }
  })
  return { rows, hides: hides.length, measured, left, usable, ungradedLeft }
}
