import { hsCodeProblem, netMassProblem, normaliseHsCode, originProblem } from '@nexus/factory-domain/product/styles/customs'
import type { StylePatch, StyleView } from '../api'
import { decimalInput, editText } from '../model'

/**
 * A style's customs and origin data on the Overview's identity card (W2a, PRD-018; design products.styles
 * style.ov.identity "Customs: HS code, origin"), pure: what the person types, how it is checked before the save (the
 * domain's own rules — factory-domain product/styles/customs — in this app's words), and what the PATCH sends. The
 * Intrastat return and the export papers (B-W2a-39) read these three fields.
 */

export interface CustomsDraft {
  /** As typed: "4203 10 00", "4203.10.00" or digits. */
  hsCode: string
  /** ISO 3166-1 alpha-2, '' = not on record. */
  originCountry: string
  /** As typed, either decimal sign: "1,85". */
  netMassKg: string
}

export const customsDraftOf = (style: Pick<StyleView, 'hsCode' | 'originCountry' | 'netMassKg'>, locale: 'it' | 'en'): CustomsDraft => ({
  hsCode: style.hsCode ?? '',
  originCountry: style.originCountry ?? '',
  netMassKg: editText(style.netMassKg, locale),
})

export type CustomsField = keyof CustomsDraft

/** Each field's problem (a message key of `products`), or none. */
export function customsErrors(draft: CustomsDraft): Partial<Record<CustomsField, string>> {
  const errors: Partial<Record<CustomsField, string>> = {}
  const hs = normaliseHsCode(draft.hsCode.trim())
  if (hs !== '') {
    const problem = hsCodeProblem(hs)
    if (problem) errors.hsCode = /^Chapter/.test(problem) ? 'customs.problem.chapter' : 'customs.problem.hsCode'
  }
  if (draft.originCountry !== '' && originProblem(draft.originCountry)) errors.originCountry = draft.originCountry === 'EU' ? 'customs.problem.eu' : 'customs.problem.origin'
  if (draft.netMassKg.trim() !== '') {
    const mass = decimalInput(draft.netMassKg, 3)
    if (mass === undefined || mass === null || netMassProblem(mass)) errors.netMassKg = 'customs.problem.netMass'
  }
  return errors
}

/** The customs part of the PATCH: only what changed, cleared fields as null. */
export function customsPatch(style: Pick<StyleView, 'hsCode' | 'originCountry' | 'netMassKg'>, draft: CustomsDraft): Pick<StylePatch, 'hsCode' | 'originCountry' | 'netMassKg'> {
  const patch: Pick<StylePatch, 'hsCode' | 'originCountry' | 'netMassKg'> = {}
  const hs = normaliseHsCode(draft.hsCode.trim())
  if ((hs || null) !== style.hsCode) patch.hsCode = hs || null
  const origin = draft.originCountry || null
  if (origin !== style.originCountry) patch.originCountry = origin
  const mass = draft.netMassKg.trim() === '' ? null : decimalInput(draft.netMassKg, 3)
  if (mass !== undefined) {
    const same = mass === null ? style.netMassKg === null : style.netMassKg !== null && Number(mass) === Number(style.netMassKg)
    if (!same) patch.netMassKg = mass
  }
  return patch
}

/** "42031000" → "4203 10 00" (the way customs papers print it). */
export function hsCodeText(code: string | null): string {
  if (!code) return '—'
  const groups = [code.slice(0, 4), code.slice(4, 6), code.slice(6, 8), code.slice(8, 10)].filter(Boolean)
  return groups.join(' ')
}

/** The API refused one of the customs fields (`hsCode`, `body/originCountry` …). */
export const refusedCustoms = (refused: readonly string[], field: CustomsField): boolean => refused.some((path) => path.replace(/^body[./]/, '') === field)
