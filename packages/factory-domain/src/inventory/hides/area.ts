import { fixedRatio, QUANTITY_SCALE, UNITS } from '../../product/units/units'
import { Dec, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * Leather area and the two numbers of leather stock (B-W2b-94; SCM-258; design warehouse.hides "two numbers for the current
 * filter: '37 hides · 412.50 m²'", footer "37 hides · 412.50 m² (4,440.3 ft²)"), pure. A hide is counted AND measured: every
 * leather read gives the hides beside their area, in the unit it was entered in and in the other one (m² ↔ ft²; dm² shows
 * m²). Areas are Decimal(18,4) strings, as the ledger keeps them.
 */

/** The units a hide's area is entered in (the database's Hide and HideMeasure checks). */
export const AREA_UOMS = ['M2', 'DM2', 'FT2'] as const
export type AreaUom = (typeof AREA_UOMS)[number]

export const isAreaUom = (uom: string): uom is AreaUom => (AREA_UOMS as readonly string[]).includes(uom)

/** An area in another area unit, at four decimals (HALF_UP). */
export function areaIn(quantity: DecimalInput, from: AreaUom, to: AreaUom): Decimal {
  const ratio = fixedRatio(from, to)
  if (!ratio) throw new RangeError(`${from} does not convert to ${to}`)
  return new Dec(quantity.toString()).times(ratio.toString()).toDecimalPlaces(QUANTITY_SCALE, Dec.ROUND_HALF_UP)
}

/** The other unit a screen shows beside an area: m² beside ft², ft² beside m² and dm². */
export const otherAreaUnit = (uom: AreaUom): AreaUom => (uom === 'FT2' ? 'M2' : 'FT2')

export interface AreaFigure {
  readonly uom: AreaUom
  readonly quantity: string
}

/** An area and the same area in the other unit. */
export function withOtherUnit(quantity: DecimalInput, uom: AreaUom): AreaFigure & { readonly other: AreaFigure } {
  const other = otherAreaUnit(uom)
  return { uom, quantity: new Dec(quantity.toString()).toFixed(QUANTITY_SCALE), other: { uom: other, quantity: areaIn(quantity, uom, other).toFixed(QUANTITY_SCALE) } }
}

/** Two numbers of leather stock: how many hides (or remnant pieces) and their area. */
export interface TwoNumbers {
  readonly hides: number
  readonly area: Decimal
  readonly uom: AreaUom
}

/** Σ of figures in one unit; a figure in another area unit is converted first, so totals never add m² to ft². */
export function addArea(into: TwoNumbers, hides: number, area: DecimalInput, uom: AreaUom): TwoNumbers {
  const value = uom === into.uom ? new Dec(area.toString()) : areaIn(area, uom, into.uom)
  return { hides: into.hides + hides, area: into.area.plus(value), uom: into.uom }
}

export const noArea = (uom: AreaUom): TwoNumbers => ({ hides: 0, area: ZERO, uom })

export type Language = 'it' | 'en'

const WORDS: Readonly<Record<Language, { readonly one: string; readonly many: string; readonly group: string; readonly point: string }>> = {
  it: { one: 'pelle', many: 'pelli', group: '.', point: ',' },
  en: { one: 'hide', many: 'hides', group: ',', point: '.' },
}

const PIECES: Readonly<Record<Language, { readonly one: string; readonly many: string }>> = {
  it: { one: 'pezzo', many: 'pezzi' },
  en: { one: 'piece', many: 'pieces' },
}

/** A decimal written for people: grouped by thousands, the language's decimal mark, exact (never through a float). */
function number(value: Decimal, decimals: number, language: Language): string {
  const text = value.toFixed(decimals, Dec.ROUND_HALF_UP)
  const negative = text.startsWith('-')
  const [whole, fraction] = (negative ? text.slice(1) : text).split('.')
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, WORDS[language].group)
  return `${negative ? '-' : ''}${grouped}${fraction ? `${WORDS[language].point}${fraction}` : ''}`
}

/**
 * The two numbers in words: "37 hides · 412.50 m² (4,440.3 ft²)" (it: "37 pelli · 412,50 m² (4.440,3 ft²)"); `pieces` for
 * remnants ("2 pieces · 8.00 ft² (0.7 m²)"). Two decimals in the unit of entry, one in the other.
 */
export function twoNumbersWords(figure: TwoNumbers, language: Language, counted: 'hides' | 'pieces' = 'hides'): string {
  const noun = counted === 'hides' ? WORDS[language] : PIECES[language]
  const other = otherAreaUnit(figure.uom)
  return `${figure.hides} ${figure.hides === 1 ? noun.one : noun.many} · ${number(figure.area, 2, language)} ${UNITS[figure.uom].symbol} (${number(areaIn(figure.area, figure.uom, other), 1, language)} ${UNITS[other].symbol})`
}
