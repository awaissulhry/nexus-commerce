/**
 * Our payroll codes (B-W2b-54; MES-271; design people.payroll "3 · Code mapping"): the hour types and earning types Nexus
 * knows, in the order a file lists them. Absence codes are data (AbsenceCode.code). What the provider calls each one (voce,
 * causale) is the company's PayrollCodeMapping row: data, never code (GATE-PAYROLL).
 */

export const PAYROLL_CODE_KINDS = ['HOUR', 'ABSENCE', 'EARNING'] as const
export type PayrollCodeKind = (typeof PAYROLL_CODE_KINDS)[number]

export const HOUR_CODES = ['ORD', 'OT_DAY', 'OT_NIGHT', 'OT_HOLIDAY', 'NIGHT', 'HOLIDAY'] as const
export type HourCode = (typeof HOUR_CODES)[number]

/**
 * EARLIER_MONTH: earnings of a month already locked, paid in this one (the ledger's correctsPeriodId). BONUS (B-W2b-84): a
 * standard-minute bonus scheme's bonus.
 */
export const EARNING_CODES = ['PIECE', 'TEAM_SHARE', 'OFF_STANDARD', 'MAKE_UP', 'BONUS', 'ADJUSTMENT', 'EARLIER_MONTH'] as const
export type EarningCode = (typeof EARNING_CODES)[number]

export const CODE_LIMITS = Object.freeze({ code: 40, meaning: 200, providerCode: 40 })

/** What each of our fixed codes means, in the languages the screens and the summary speak. */
export const CODE_MEANINGS: Readonly<Record<HourCode | EarningCode, { readonly en: string; readonly it: string }>> = Object.freeze({
  ORD: { en: 'Ordinary hours', it: 'Ore ordinarie' },
  OT_DAY: { en: 'Overtime, day', it: 'Straordinario diurno' },
  OT_NIGHT: { en: 'Overtime, night', it: 'Straordinario notturno' },
  OT_HOLIDAY: { en: 'Overtime, holiday', it: 'Straordinario festivo' },
  NIGHT: { en: 'Night hours (of which)', it: 'Ore notturne (di cui)' },
  HOLIDAY: { en: 'Holiday hours (of which)', it: 'Ore festive (di cui)' },
  PIECE: { en: 'Piece pay', it: 'Cottimo' },
  TEAM_SHARE: { en: 'Team piece pay, own share', it: 'Cottimo di squadra, quota personale' },
  OFF_STANDARD: { en: 'Paid time off standard', it: 'Tempo pagato fuori standard' },
  MAKE_UP: { en: 'Make-up to guaranteed pay', it: 'Integrazione alla paga garantita' },
  BONUS: { en: 'Standard-minute bonus', it: 'Premio a minuti standard' },
  ADJUSTMENT: { en: 'Adjustment', it: 'Rettifica' },
  EARLIER_MONTH: { en: 'Earnings of an earlier month', it: 'Competenze di un mese precedente' },
})

export const isFixedCode = (code: string): code is HourCode | EarningCode => Object.hasOwn(CODE_MEANINGS, code)

/** The fixed codes of a kind (ABSENCE has none: they are the company's absence codes). */
export function fixedCodes(kind: PayrollCodeKind): readonly (HourCode | EarningCode)[] {
  if (kind === 'HOUR') return HOUR_CODES
  return kind === 'EARNING' ? EARNING_CODES : []
}

/** A code's place in a file: hours, then absences, then earnings; fixed codes in their order, absence codes by name. */
export function codeOrder(a: { readonly kind: PayrollCodeKind; readonly code: string }, b: { readonly kind: PayrollCodeKind; readonly code: string }): number {
  if (a.kind !== b.kind) return PAYROLL_CODE_KINDS.indexOf(a.kind) - PAYROLL_CODE_KINDS.indexOf(b.kind)
  if (a.kind === 'ABSENCE') return a.code < b.code ? -1 : a.code > b.code ? 1 : 0
  const list = fixedCodes(a.kind) as readonly string[]
  return list.indexOf(a.code) - list.indexOf(b.code)
}

export const mappingKey = (kind: PayrollCodeKind, code: string): string => `${kind}|${code}`
