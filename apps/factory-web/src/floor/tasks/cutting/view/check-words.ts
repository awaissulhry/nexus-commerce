import { shadeLotWords } from '@nexus/factory-domain/inventory/reservations/shade'
import { formatNumber } from '../../../../lib/i18n/format'
import type { Translate } from '../../../../lib/i18n/messages'
import type { CheckWarning, CutWarningKind, ShadeLot, ThicknessView } from '../model'

/**
 * SCR-094's words for the hide check (B-W2b-110): each warning of B-W2b-103 said in the screen's language from its facts
 * (the API's sentences are English and never shown), a shade lot ("lot LOT-7, shade 2" / "lotto LOT-7, tonalità 2": the
 * domain's own words), the thickness range and the pieces' grades. Pure: the view and the pop-up share it.
 */

export type Locale = 'it' | 'en'

export interface CheckContext {
  readonly number: string
  readonly locale: Locale
}

export const lotWords = (lot: ShadeLot, locale: Locale): string => shadeLotWords(lot, locale)

const lots = (list: readonly ShadeLot[], locale: Locale): string => list.map((lot) => lotWords(lot, locale)).join('; ') || '—'

/** A thickness in mm in the language's own numbers ("0,95" in Italian), two places. */
export function mmWords(value: string, locale: Locale): string {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? formatNumber(parsed, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : value
}

/** "1.10–1.30 mm", "at least 1.10 mm", "at most 1.30 mm" (null: no range). */
export function rangeWords(t: Translate, thickness: Pick<ThicknessView, 'minMm' | 'maxMm'>, locale: Locale): string | null {
  if (thickness.minMm !== null && thickness.maxMm !== null) return t('check.range.both', { min: mmWords(thickness.minMm, locale), max: mmWords(thickness.maxMm, locale) })
  if (thickness.minMm !== null) return t('check.range.min', { min: mmWords(thickness.minMm, locale) })
  if (thickness.maxMm !== null) return t('check.range.max', { max: mmWords(thickness.maxMm, locale) })
  return null
}

/** One warning in words (what differs, never what to do: the card's action says that). */
export function warningWords(t: Translate, warning: CheckWarning, context: CheckContext): string {
  const { number, locale } = context
  if (warning.shade) {
    const hide = lotWords(warning.shade.hide, locale)
    if (warning.code === 'OUT_OF_SHADE') return t('check.warning.OUT_OF_SHADE', { hide, number })
    if (warning.code === 'GARMENT_SHADE') return t('check.warning.GARMENT_SHADE', { cell: warning.shade.cell ?? '—', cutFrom: lots(warning.shade.cutFrom, locale), hide })
    return t('check.warning.SHADE_LOT', { number, cutFrom: lots(warning.shade.cutFrom, locale), hide })
  }
  if (warning.wrongHide) {
    const facts = warning.wrongHide
    if (warning.code === 'RESERVED_LOT') return t('check.warning.RESERVED_LOT', { number, lots: facts.reservedLots.join(', ') || '—', lot: facts.hide.lotCode })
    const grades = [...new Set(facts.reservedHides.flatMap((row) => (row.grade ? [row.grade] : [])))].sort()
    const differs = facts.differs.map((what) =>
      what === 'COLOUR'
        ? t('check.differ.COLOUR')
        : what === 'LOT'
          ? t('check.differ.LOT', { lot: facts.hide.lotCode, lots: facts.reservedLots.join(', ') || '—' })
          : t('check.differ.GRADE', { grade: facts.hide.grade ?? '—', grades: grades.join(', ') || '—' }),
    )
    const hides = facts.reservedHides.map((row) => row.code).filter(Boolean)
    return t('check.warning.NOT_RESERVED', { number, count: hides.length, hides: hides.join(', ') || '—', differs: differs.join('; ') || t('check.differ.none') })
  }
  if (warning.thickness) {
    const range = rangeWords(t, warning.thickness, locale) ?? '—'
    const where = t(`check.where.${warning.thickness.source}`)
    return t(warning.code === 'THICK' ? 'check.warning.THICK' : 'check.warning.THIN', { value: mmWords(warning.thickness.valueMm, locale), where, range })
  }
  if (warning.grade) {
    const pieces = warning.grade.pieces.map((piece) => t('check.piece.asks', { name: piece.name, grade: piece.minGrade })).join('; ')
    if (warning.code === 'UNGRADED' || warning.grade.hideGrade === null) return t('check.warning.UNGRADED', { pieces })
    return t('check.warning.BELOW', { grade: warning.grade.hideGrade, pieces })
  }
  return t('check.warning.other', { kind: t(`check.kind.${warning.kind}`) })
}

/** The kinds in words, joined ("shade, thickness"). */
export function kindsWords(t: Translate, kinds: readonly CutWarningKind[]): string {
  return kinds.map((kind) => t(`check.kind.${kind}`)).join(', ')
}

/** The thickness fact: the value and where it is from, and the range the leather asks ("0.95 mm as recorded · asks 1.10–1.30 mm"). */
export function thicknessWords(t: Translate, thickness: ThicknessView, locale: Locale): string {
  const range = rangeWords(t, thickness, locale)
  const value = thickness.valueMm === null ? t('check.thickness.unknown') : t(thickness.source === 'TABLE' ? 'check.thickness.measured' : 'check.thickness.recorded', { value: mmWords(thickness.valueMm, locale) })
  return range ? t('check.thickness.withRange', { value, range }) : value
}
