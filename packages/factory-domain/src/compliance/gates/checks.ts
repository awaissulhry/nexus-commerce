import type { BusinessDate } from '../../core/time'
import type { GateResult } from '../cert-gate/gate'
import { ROLE_WORDS, type OperatorRole } from '../operators/rules'
import type { CheckResult, GateMarket } from './gate'

/**
 * The checks the gate computes (B-W2b-254; PRD-271's checklist "certificate covers every size sold there · DoC in the
 * market's language · user information in the language · PPE label with the market's languages · economic operator for
 * the market · GPSR data for non-PPE lines"), pure: the API reads the facts, these say PRESENT / MISSING / EXPIRING in
 * words with the record that proves it. A requirement's check key picks one (requirements/rules.ts CHECKS).
 */

/** A certificate that ends within this many days shows "Expiring" (it still passes every gate). */
export const EXPIRING_DAYS = 90
const DAY_MS = 24 * 60 * 60 * 1000

export function daysBetween(from: BusinessDate, to: BusinessDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)
}

const present = (message: string, facts: CheckResult['facts'], evidence: CheckResult['evidence'] = null): CheckResult => ({ state: 'PRESENT', message, fix: null, facts, evidence })
const missing = (message: string, fix: string, facts: CheckResult['facts']): CheckResult => ({ state: 'MISSING', message, fix, facts, evidence: null })

/** certificate.coverage: W1's certificate gate (QHS-051, MES-004) for one colourway and size on the day. */
export function certificateCoverageResult(result: GateResult, day: BusinessDate): CheckResult {
  if (result.outcome === 'not_required') return { state: 'NOT_NEEDED', message: result.message, fix: null, facts: { code: 'certificate.notRequired' }, evidence: null }
  if (result.outcome === 'refused') {
    return missing(
      result.reasons.map((reason) => reason.message).join(' '),
      'register or renew the certificate and cover this colourway and size (Compliance › Certificates).',
      { code: 'certificate.missing', reasons: result.reasons.map((reason) => reason.code) },
    )
  }
  const { certificate } = result
  const evidence = { recordType: 'Certificate', recordId: certificate.id, label: certificate.number }
  const left = daysBetween(day, certificate.validTo)
  if (left <= EXPIRING_DAYS) {
    return {
      state: 'EXPIRING',
      message: `Certificate ${certificate.number} covers it until ${certificate.validTo} (${left} day(s) left).`,
      fix: 'start the renewal with the notified body (Compliance › Certificates › Renewal).',
      facts: { code: 'certificate.expiring', certificate: certificate.number, validTo: certificate.validTo, days: left },
      evidence,
    }
  }
  return present(`Certificate ${certificate.number} (${certificate.standard}) covers it until ${certificate.validTo}.`, { code: 'certificate.covered', certificate: certificate.number, validTo: certificate.validTo }, evidence)
}

/** certificate.gloveLevels: the covering certificate gives its EN 13594 level (B-W2b-255's performance levels). */
export function gloveLevelsResult(certificate: { readonly id: string; readonly number: string; readonly levels: Readonly<Record<string, string>> | null } | null): CheckResult {
  if (!certificate) return missing('No certificate covers it, so no glove levels are known.', 'cover the glove with its certificate first (Compliance › Certificates).', { code: 'gloveLevels.noCertificate' })
  if (!certificate.levels || !certificate.levels.level) {
    return missing(`Certificate ${certificate.number} gives no EN 13594 level.`, 'type the levels from the certificate (Compliance › Certificates › Performance levels).', { code: 'gloveLevels.missing', certificate: certificate.number })
  }
  const marking = `${certificate.levels.level}${certificate.levels.knuckle ?? ''}`
  return present(`Certificate ${certificate.number} gives level ${marking}.`, { code: 'gloveLevels.present', certificate: certificate.number, marking }, { recordType: 'Certificate', recordId: certificate.id, label: certificate.number })
}

export type DocumentKind = 'DECLARATION_OF_CONFORMITY' | 'USER_INFORMATION'

export interface IssuedDocument {
  readonly id: string
  readonly language: string
  readonly number: string | null
  readonly revision: number
  /** The market whose language pack it is; null: every market of its language. */
  readonly marketCode: string | null
}

const DOCUMENT_WORDS: Readonly<Record<DocumentKind, { readonly name: string; readonly field: 'docLanguages' | 'userInfoLanguages' }>> = {
  DECLARATION_OF_CONFORMITY: { name: 'Declaration of Conformity', field: 'docLanguages' },
  USER_INFORMATION: { name: 'user information', field: 'userInfoLanguages' },
}

/** doc.languages / userInfo.languages: an ISSUED document of the style in every language the market needs. */
export function documentLanguagesResult(kind: DocumentKind, market: GateMarket, issued: readonly IssuedDocument[]): CheckResult {
  const words = DOCUMENT_WORDS[kind]
  const needed = market[words.field]
  if (needed.length === 0) return { state: 'NOT_NEEDED', message: `${market.name} names no language for the ${words.name}.`, fix: null, facts: { code: 'documents.noLanguage', market: market.code }, evidence: null }
  const usable = issued.filter((document) => document.marketCode === null || document.marketCode === market.code)
  const lacking = needed.filter((language) => !usable.some((document) => document.language === language))
  if (lacking.length > 0) {
    return missing(
      `The ${words.name} has no issued ${lacking.join(', ')} version for ${market.name}.`,
      `issue the ${words.name} in ${lacking.join(', ')} (Compliance › Declarations & instructions).`,
      { code: kind === 'DECLARATION_OF_CONFORMITY' ? 'doc.missing' : 'userInfo.missing', market: market.code, languages: lacking },
    )
  }
  const first = usable.find((document) => document.language === needed[0])!
  return present(`The ${words.name} is issued in ${needed.join(', ')}.`, { code: kind === 'DECLARATION_OF_CONFORMITY' ? 'doc.present' : 'userInfo.present', market: market.code, languages: [...needed] }, {
    recordType: 'ComplianceDocument',
    recordId: first.id,
    label: first.number ?? `${words.name} ${first.language} r${first.revision}`,
  })
}

/** label.languages: the garment label template prints every language the market needs. */
export function labelLanguagesResult(template: { readonly id: string; readonly code: string; readonly revision: number; readonly languages: readonly string[] } | null, market: GateMarket): CheckResult {
  if (market.labelLanguages.length === 0) return { state: 'NOT_NEEDED', message: `${market.name} names no label language.`, fix: null, facts: { code: 'label.noLanguage', market: market.code }, evidence: null }
  if (!template) return missing('No garment label template is set.', 'set one on the style revision (Products › Labels).', { code: 'label.none', market: market.code })
  const lacking = market.labelLanguages.filter((language) => !template.languages.includes(language))
  if (lacking.length > 0) {
    return missing(
      `Label ${template.code} v${template.revision} prints ${template.languages.join(', ') || 'no language'}; ${market.name} needs ${lacking.join(', ')}.`,
      `add ${lacking.join(', ')} to a new revision of the label (Compliance › Labels & marking).`,
      { code: 'label.languageMissing', market: market.code, languages: lacking, label: template.code },
    )
  }
  return present(`Label ${template.code} v${template.revision} prints ${market.labelLanguages.join(', ')}.`, { code: 'label.languages', market: market.code, label: template.code }, { recordType: 'LabelTemplate', recordId: template.id, label: `${template.code} v${template.revision}` })
}

/** operator.role: an economic operator of the role is named for the style (and the market, when one is asked). */
export function operatorResult(role: OperatorRole, found: { readonly id: string; readonly printedName: string } | null, market: GateMarket | null): CheckResult {
  const where = market ? ` for ${market.name}` : ''
  if (!found) {
    return missing(`No ${ROLE_WORDS[role].en} is named${where}.`, `name the ${ROLE_WORDS[role].en} (Compliance › Rules & markets › Operators).`, { code: 'operator.missing', role, market: market?.code ?? null })
  }
  return present(`${found.printedName} is the ${ROLE_WORDS[role].en}${where}.`, { code: 'operator.present', role, market: market?.code ?? null }, { recordType: 'EconomicOperatorRole', recordId: found.id, label: found.printedName })
}

/** The EU member states (ISO 3166-1 alpha-2; Greece as GR and EL): a manufacturer established there is the product's EU operator itself. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set(['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'EL', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE'])

/**
 * operator.role for the MANUFACTURER when no operator row names one (Reg. (EU) 2019/1020 art. 4(2)(a): a manufacturer
 * established in the Union is the economic operator): the brand that sells the style under its own name (Owner Q3), else
 * our company, from its own name and country. Missing only when that maker is established outside the EU.
 */
export function manufacturerFallbackResult(maker: { readonly recordType: 'Party' | 'Company'; readonly id: string; readonly name: string; readonly country: string | null } | null, market: GateMarket | null): CheckResult {
  if (!maker) return operatorResult('MANUFACTURER', null, market)
  const country = maker.country?.toUpperCase() ?? null
  if (!country || !EU_COUNTRIES.has(country)) {
    return missing(
      `${maker.name} makes it from ${country ?? 'an unknown country'}, outside the EU, and no manufacturer, importer or authorised representative is named.`,
      'name the EU operator (Compliance › Rules & markets › Operators).',
      { code: 'operator.outsideEu', role: 'MANUFACTURER', country },
    )
  }
  return present(`${maker.name} (${country}) is the manufacturer, established in the EU (no operator row: its own name and address).`, { code: 'operator.maker', role: 'MANUFACTURER', country }, { recordType: maker.recordType, recordId: maker.id, label: maker.name })
}

/** gpsr.contact: the label prints the GPSR contact (a consumer product that is not PPE; Reg. (EU) 2023/988 art. 9(6)). */
export function gpsrContactResult(template: { readonly id: string; readonly code: string; readonly revision: number; readonly gpsrContact: string | null } | null): CheckResult {
  if (!template) return missing('No label template is set, so no GPSR contact is printed.', 'set a label template with the GPSR contact (Compliance › Labels & marking).', { code: 'gpsr.noLabel' })
  if (!template.gpsrContact) return missing(`Label ${template.code} v${template.revision} prints no GPSR contact.`, 'add the maker\'s postal and electronic address to a new revision of the label.', { code: 'gpsr.missing', label: template.code })
  return present(`Label ${template.code} v${template.revision} prints the GPSR contact.`, { code: 'gpsr.present', label: template.code }, { recordType: 'LabelTemplate', recordId: template.id, label: `${template.code} v${template.revision}` })
}
