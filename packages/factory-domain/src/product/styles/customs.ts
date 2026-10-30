import type { Issue } from '../../core/errors'
import { fitsDecimal } from '../../core/money'
import { isCountryCode } from '../../parties/geo'
import { decimalOf, decimalText } from '../units/units'

/**
 * A style's customs and origin data (feature PRD-018; W2a), pure: what an export declaration and the Intrastat return
 * (Reg. (EU) 2019/2152, Reg. (EU) 2020/1197 Annex V; LOG-098, B-W2a-39) need of every garment of the style:
 *
 *   hsCode         the commodity code: the HS heading (6 digits), the EU Combined Nomenclature code (8 digits, what
 *                  Intrastat asks) or the TARIC code (10 digits). Typed with dots or spaces ("4203.10.00") it is kept
 *                  as digits only; its first two digits are an HS chapter (01 to 97; 77 is reserved and never used).
 *   originCountry  the country of (non-preferential) origin, ISO 3166-1 alpha-2 ("IT"); never "EU".
 *   netMassKg      the net mass of one garment in kilograms, above 0, at most 3 decimals (Decimal(10,3)).
 *
 * Each is optional (null: not on record); the Intrastat step flags a shipped style without them. The database's
 * Style_customs_guard holds the same formats.
 */

export const NET_MASS_PRECISION = 10
export const NET_MASS_SCALE = 3

/** HS 6, CN 8 or TARIC 10 digits. */
export const HS_CODE = /^\d{6}(?:\d{2}(?:\d{2})?)?$/
export const HS_CODE_RULE = 'the commodity code of 6 (HS), 8 (CN) or 10 (TARIC) digits'

export interface CustomsFields {
  readonly hsCode: string | null
  readonly originCountry: string | null
  /** Kilograms per garment, a plain decimal string ("1.85"). */
  readonly netMassKg: string | null
}

/** A typed commodity code as stored: dots, spaces and dashes taken out ("4203 10 00" → "42031000"). */
export const normaliseHsCode = (value: string): string => value.replace(/[\s.\-]/g, '')

/** A typed origin as stored: trimmed, upper case. */
export const normaliseOrigin = (value: string): string => value.trim().toUpperCase()

/** A typed net mass as stored: plain decimal text without trailing zeros. */
export const normaliseNetMass = (value: string): string => (/^\d+(?:\.\d+)?$/.test(value.trim()) ? decimalText(value.trim()) : value.trim())

export function hsCodeProblem(value: string): string | null {
  if (!HS_CODE.test(value)) return `Expected ${HS_CODE_RULE}.`
  const chapter = Number(value.slice(0, 2))
  if (chapter < 1 || chapter > 97 || chapter === 77) return `Chapter ${value.slice(0, 2)} is not a chapter of the Harmonized System (01 to 97, without 77).`
  return null
}

export function originProblem(value: string): string | null {
  if (value === 'EU') return 'Name the country of origin (ISO 3166-1, like IT), not the EU.'
  return isCountryCode(value) ? null : 'Expected a country code of ISO 3166-1 (two letters, like IT).'
}

export function netMassProblem(value: string): string | null {
  if (!/^\d+(?:\.\d+)?$/.test(value) || !fitsDecimal(value, NET_MASS_PRECISION, NET_MASS_SCALE)) {
    return `Expected kilograms with at most ${NET_MASS_PRECISION - NET_MASS_SCALE} digits and ${NET_MASS_SCALE} decimals.`
  }
  return decimalOf(value, 'netMassKg').gt(0) ? null : 'The net mass of one garment is above 0 kg.'
}

/** The customs fields as stored. */
export function normaliseCustoms(fields: CustomsFields): CustomsFields {
  const text = (value: string | null, normalise: (typed: string) => string): string | null => {
    if (value === null) return null
    const stored = normalise(value)
    return stored === '' ? null : stored
  }
  return { hsCode: text(fields.hsCode, normaliseHsCode), originCountry: text(fields.originCountry, normaliseOrigin), netMassKg: text(fields.netMassKg, normaliseNetMass) }
}

/** Every format the customs fields break (paths are the field names). */
export function customsProblems(fields: CustomsFields): Issue[] {
  const issues: Issue[] = []
  const hs = fields.hsCode === null ? null : hsCodeProblem(fields.hsCode)
  if (hs) issues.push({ path: 'hsCode', message: hs })
  const origin = fields.originCountry === null ? null : originProblem(fields.originCountry)
  if (origin) issues.push({ path: 'originCountry', message: origin })
  const mass = fields.netMassKg === null ? null : netMassProblem(fields.netMassKg)
  if (mass) issues.push({ path: 'netMassKg', message: mass })
  return issues
}

/** What a shipment's customs papers still lack of this style (for the style page and the Intrastat step). */
export function customsMissing(fields: CustomsFields): ('hsCode' | 'originCountry' | 'netMassKg')[] {
  return (['hsCode', 'originCountry', 'netMassKg'] as const).filter((field) => fields[field] === null)
}
