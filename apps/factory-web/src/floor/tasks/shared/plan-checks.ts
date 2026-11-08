/**
 * An inspection plan's checks as every floor bench answers them (lifted from B-W2b-105's In-line inspection for B-W2b-115's
 * Incoming inspection; B-W2b-109's final bench reads them through In-line's model): the check's words in the worker's
 * language, how the floor answers it, and a measurement's verdict by the numbers. Pure, so the tests hold them.
 *
 *   tap      pass / fail on the DS FloorChecklist (PASS_FAIL, PHOTO, SIGNATURE)
 *   value    a number on the DS QuantityPad (MEASUREMENT, COUNT) or a choice (CHOICE): the shared MeasureStep
 *   read     an instruction, read only
 *   office   free words: answered in the office (no typing on the floor)
 */

export interface CheckLabels {
  readonly labelIt: string
  readonly labelEn: string
  /** Other floor languages, when the plan has them. */
  readonly labelI18n?: Readonly<Record<string, string>>
}

/** The check's words in the worker's language (another floor language, else English; Italian for Italian). */
export function checkWords(check: CheckLabels, language: string): string {
  if (language === 'it') return check.labelIt || check.labelEn
  if (language === 'en') return check.labelEn || check.labelIt
  return check.labelI18n?.[language] || check.labelEn || check.labelIt
}

/** How the floor answers a check: a tap (pass / fail), a value (measure, count, choice), read only (instruction), or in the office (words). */
export type CheckWay = 'tap' | 'value' | 'read' | 'office'

export function wayOf(check: { readonly type: string }): CheckWay {
  switch (check.type) {
    case 'MEASUREMENT':
    case 'COUNT':
    case 'CHOICE':
      return 'value'
    case 'INSTRUCTION':
      return 'read'
    case 'FREE_TEXT':
      return 'office'
    default:
      return 'tap'
  }
}

/** A measurement against its nominal ± tolerance, by the numbers (= factory-domain measuredOutcome; the database computes the same). */
export function measuredOutcome(value: string, nominal: string, tolerance: string): 'PASS' | 'FAIL' {
  const thousandths = (text: string) => Math.round(Number(text) * 1000)
  return Math.abs(thousandths(value) - thousandths(nominal)) <= thousandths(tolerance) ? 'PASS' : 'FAIL'
}

/** The verdict a value gets by itself: by the numbers for a measurement with a nominal and a tolerance; else the inspector says it. */
export function verdictOf(check: { readonly type: string; readonly nominal: string | null; readonly tolerance: string | null }, value: string): 'PASS' | 'FAIL' | null {
  if (check.type !== 'MEASUREMENT' || check.nominal === null || check.tolerance === null || value.trim() === '') return null
  return measuredOutcome(value, check.nominal, check.tolerance)
}

/** A typed number as the API takes it (a dot, up to three decimals). */
export function valueText(value: number, type: string): string {
  return type === 'COUNT' ? String(Math.round(value)) : String(Math.round(value * 1000) / 1000)
}
