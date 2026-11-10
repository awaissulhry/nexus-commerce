import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * A material's compliance profile (B-W2b-256; PRD-303, PRD-314; design compliance.tests › Material profiles and the material
 * record's Compliance tab), the pure part: what a person confirms on it (the composition, a leather's tannage, the country
 * it is made in), the innocuousness evidence a material of a PPE garment needs for the technical file (EN ISO 13688: pH,
 * chromium VI, azo amines, nickel release), and the gaps both leave. The evaluator (compliance/substances/evaluate) owns
 * the profile's state: a gap here only keeps a material that meets every rule INCOMPLETE, with the gap in its reason;
 * blocking stays the rules' (a failed test, a declaration above the limit).
 */

export const PROFILE_LIMITS = { note: 1000 } as const
export const ORIGIN_COUNTRY = /^[A-Z]{2}$/

/** EN ISO 13688 § 4.2 innocuousness: what a material of a PPE garment must show (the technical file holds the evidence). */
export const INNOCUOUSNESS_PARAMETERS = ['PH', 'CR_VI', 'AZO', 'NICKEL'] as const
export type InnocuousnessParameter = (typeof INNOCUOUSNESS_PARAMETERS)[number]

/** Which kinds of material each parameter is for: pH of leather and textiles, Cr VI of leather, azo amines of dyed leather and textiles, nickel of metal parts. */
export const INNOCUOUSNESS_KINDS: Readonly<Record<InnocuousnessParameter, readonly string[]>> = Object.freeze({
  PH: ['LEATHER', 'TEXTILE', 'LINING'],
  CR_VI: ['LEATHER'],
  AZO: ['LEATHER', 'TEXTILE', 'LINING', 'THREAD'],
  NICKEL: ['TRIM', 'HARDWARE'],
})
export const INNOCUOUSNESS_WORDS: Readonly<Record<InnocuousnessParameter, string>> = Object.freeze({
  PH: 'pH value',
  CR_VI: 'chromium VI',
  AZO: 'azo amines',
  NICKEL: 'nickel release',
})
/** The lab test of a parameter (pH has none: a lab report file of the profile shows it). */
export const INNOCUOUSNESS_TEST: Readonly<Record<InnocuousnessParameter, 'CR_VI' | 'AZO' | 'NICKEL' | null>> = Object.freeze({ PH: null, CR_VI: 'CR_VI', AZO: 'AZO', NICKEL: 'NICKEL' })

/** The newest current lab result of a test for the material (any of its lots). */
export interface ResultFact {
  readonly resultId: string
  readonly lotId: string
  readonly test: string
  readonly verdict: 'PASS' | 'FAIL'
  readonly testedOn: BusinessDate
}

/** A current evidence file of the profile (record type MaterialComplianceProfile): a lab report, a declaration, a certificate. */
export interface EvidenceFile {
  readonly fileId: string
  readonly name: string
  readonly category: string | null
  readonly expiresOn: BusinessDate | null
}

export type ParameterStatus = 'MET' | 'FAILED' | 'FILE' | 'MISSING'

export interface ParameterEvidence {
  readonly parameter: InnocuousnessParameter
  readonly status: ParameterStatus
  readonly result: ResultFact | null
  /** FILE: the profile's lab report files that may show it (a person checks the value on them). */
  readonly files: readonly string[]
  readonly words: string
}

export interface Innocuousness {
  /** A current BOM of a PPE style (in scope of Reg. (EU) 2016/425) uses the material. */
  readonly required: boolean
  /** The PPE styles that use it (codes). */
  readonly ppeStyles: readonly string[]
  /** The parameters its kind needs (none: nothing to show for this kind). */
  readonly parameters: readonly ParameterEvidence[]
  /** Every parameter met or shown by a lab report file. */
  readonly complete: boolean
}

const newest = (results: readonly ResultFact[], test: string): ResultFact | null =>
  [...results].filter((result) => result.test === test).sort((a, b) => b.testedOn.localeCompare(a.testedOn) || b.resultId.localeCompare(a.resultId))[0] ?? null

/** A lab report file of the profile that is in force (a test report, not expired). */
const reportFiles = (files: readonly EvidenceFile[], today: BusinessDate): EvidenceFile[] =>
  files.filter((file) => (file.category === null || file.category === 'TEST_REPORT') && (file.expiresOn === null || file.expiresOn >= today))

/**
 * The innocuousness evidence of a material (EN ISO 13688 § 4.2): per parameter its kind needs, the newest current lab result
 * of its lots (PASS met, FAIL failed), else a lab report file of the profile (FILE: a person reads the value on it; the
 * file carries no parameter of its own), else MISSING. Required only when a PPE style uses the material.
 */
export function innocuousness(input: {
  readonly kind: string
  readonly ppeStyles: readonly string[]
  readonly results: readonly ResultFact[]
  readonly files: readonly EvidenceFile[]
  readonly today: BusinessDate
}): Innocuousness {
  const reports = reportFiles(input.files, input.today)
  const parameters = INNOCUOUSNESS_PARAMETERS.filter((parameter) => INNOCUOUSNESS_KINDS[parameter].includes(input.kind)).map((parameter): ParameterEvidence => {
    const test = INNOCUOUSNESS_TEST[parameter]
    const result = test ? newest(input.results, test) : null
    const what = INNOCUOUSNESS_WORDS[parameter]
    if (result?.verdict === 'FAIL') return { parameter, status: 'FAILED', result, files: [], words: `${capital(what)}: the test of ${result.testedOn} failed.` }
    if (result?.verdict === 'PASS') return { parameter, status: 'MET', result, files: [], words: `${capital(what)}: passed on ${result.testedOn}.` }
    if (reports.length > 0) return { parameter, status: 'FILE', result: null, files: reports.map((file) => file.fileId), words: `${capital(what)}: shown by the profile's lab report${reports.length > 1 ? 's' : ''} (${reports.map((file) => file.name).join(', ')}): check the value on ${reports.length > 1 ? 'them' : 'it'}.` }
    return { parameter, status: 'MISSING', result: null, files: [], words: `${capital(what)}: no lab result of its lots and no lab report on the profile.` }
  })
  return {
    required: input.ppeStyles.length > 0,
    ppeStyles: [...input.ppeStyles],
    parameters,
    complete: parameters.every((entry) => entry.status === 'MET' || entry.status === 'FILE'),
  }
}

function capital(words: string): string {
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/**
 * What the profile still lacks beyond the rules, in words (each one keeps a material that meets its rules INCOMPLETE):
 * the composition not confirmed against the evidence, a leather's tannage not confirmed against the tannery's declaration,
 * and, for a material of a PPE garment, innocuousness evidence missing or failed.
 */
export function profileGaps(input: {
  readonly kind: string
  readonly compositionConfirmed: boolean
  readonly tannageConfirmed: boolean
  readonly innocuousness: Innocuousness
}): string[] {
  const gaps: string[] = []
  if (!input.compositionConfirmed) gaps.push('Composition: not confirmed against the evidence yet.')
  if (input.kind === 'LEATHER' && !input.tannageConfirmed) gaps.push("Tannage: not confirmed against the tannery's declaration yet.")
  if (input.innocuousness.required) {
    const open = input.innocuousness.parameters.filter((entry) => entry.status === 'MISSING' || entry.status === 'FAILED')
    if (open.length > 0) gaps.push(`EN ISO 13688 innocuousness (PPE ${input.innocuousness.ppeStyles.join(', ')}): ${open.map((entry) => entry.words).join(' ')}`)
  }
  return gaps
}

export interface ProfileEdit {
  readonly compositionConfirmed?: boolean | undefined
  readonly tannageConfirmed?: boolean | undefined
  readonly originCountry?: string | null | undefined
  readonly note?: string | null | undefined
}

const CONTROL_BUT_LINES = /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** What is wrong with a profile edit (every problem at once; `body/…`). */
export function profileEditProblems(edit: ProfileEdit, kind: string, at = 'body'): Issue[] {
  const problems: Issue[] = []
  if (edit.compositionConfirmed === undefined && edit.tannageConfirmed === undefined && edit.originCountry === undefined && edit.note === undefined) {
    problems.push({ path: at, message: 'Nothing to change: confirm the composition or the tannage, or give the origin or a note.' })
  }
  if (edit.tannageConfirmed === true && kind !== 'LEATHER') problems.push({ path: `${at}/tannageConfirmed`, message: `A tannage is confirmed only for a leather (this material is ${kind}).` })
  if (edit.originCountry !== undefined && edit.originCountry !== null && !ORIGIN_COUNTRY.test(edit.originCountry)) problems.push({ path: `${at}/originCountry`, message: 'The country by its ISO code: two capitals ("IT").' })
  if (edit.note !== undefined && edit.note !== null && (edit.note.trim() === '' || edit.note.length > PROFILE_LIMITS.note || CONTROL_BUT_LINES.test(edit.note))) {
    problems.push({ path: `${at}/note`, message: `Up to ${PROFILE_LIMITS.note} characters (null clears it).` })
  }
  return problems
}
