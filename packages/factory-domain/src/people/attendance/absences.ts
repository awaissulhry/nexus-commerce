import type { Issue } from '../../core/errors'

/**
 * Absence codes (B-W2b-37; MES-228 absence justification codes; design people.settings "Absence codes" and its pop-up
 * "Absence code", people.attendance "Set absence code"), pure. A code is ours ("FER", "MAL"), with its name in Italian
 * (and English), a category, the labour consultant's code for the LUL calendar (D.L. 112/2008 art. 39; null until the
 * consultant gives it, GATE-PAYROLL), paid or not, and whether a document backs it. Never a diagnosis (GDPR art. 9): a
 * sickness absence is the code and, when needed, the certificate's protocol number, nothing else.
 */

export const ABSENCE_CATEGORIES = ['HOLIDAY', 'PERMIT', 'SICKNESS', 'INJURY', 'PARENTAL', 'LAW_104', 'UNION', 'STRIKE', 'UNPAID_LEAVE', 'OTHER'] as const
export type AbsenceCategory = (typeof ABSENCE_CATEGORIES)[number]

/** The categories whose detail is health or family data: a code and a document reference only, never a text. */
export const SENSITIVE_CATEGORIES: ReadonlySet<AbsenceCategory> = new Set(['SICKNESS', 'INJURY', 'PARENTAL', 'LAW_104'])

export const CODE_PATTERN = /^[A-Z][A-Z0-9]{0,7}$/
export const LUL_CODE_PATTERN = /^[A-Za-z0-9._-]{1,16}$/
/** A document's reference (a certificate's protocol number): letters, digits and . / - only, so no text can be typed into it. */
export const DOCUMENT_REF_PATTERN = /^[A-Za-z0-9./-]{1,40}$/

export interface AbsenceCodeInput {
  readonly code?: unknown
  readonly labelI18n?: unknown
  readonly category?: unknown
  readonly lulCode?: unknown
  readonly paid?: unknown
  readonly documentRequired?: unknown
}

/** Everything wrong with an absence code (a new one: `code` and `category` required). */
export function absenceCodeProblems(input: AbsenceCodeInput, creating: boolean, at = ''): Issue[] {
  const problems: Issue[] = []
  if (creating || input.code !== undefined) {
    if (typeof input.code !== 'string' || !CODE_PATTERN.test(input.code)) problems.push({ path: `${at}code`, message: 'A code of 1 to 8 capital letters and digits, starting with a letter ("FER", "MAL", "L104").' })
  }
  if (creating || input.labelI18n !== undefined) {
    const label = input.labelI18n as Record<string, unknown> | null
    const ok = label !== null && typeof label === 'object' && !Array.isArray(label) && typeof label.it === 'string' && label.it.trim() !== '' && Object.entries(label).every(([key, value]) => /^[a-z]{2}$/.test(key) && typeof value === 'string' && value.trim().length <= 80)
    if (!ok) problems.push({ path: `${at}labelI18n`, message: 'Give the name in Italian at least ({ "it": "Ferie", "en": "Holiday" }), up to 80 characters each.' })
  }
  if (creating || input.category !== undefined) {
    if (!(ABSENCE_CATEGORIES as readonly unknown[]).includes(input.category)) problems.push({ path: `${at}category`, message: 'Choose the category: holiday, permit, sickness, injury, parental leave, law 104 leave, union leave, strike, unpaid leave or other.' })
  }
  if (input.lulCode !== undefined && input.lulCode !== null && (typeof input.lulCode !== 'string' || !LUL_CODE_PATTERN.test(input.lulCode))) {
    problems.push({ path: `${at}lulCode`, message: "The labour consultant's LUL code: 1 to 16 letters, digits, dots, hyphens or underscores (or none until they give it)." })
  }
  if (creating && typeof input.paid !== 'boolean') problems.push({ path: `${at}paid`, message: 'Say whether the absence is paid.' })
  return problems
}

/** A document reference as kept: a certificate's protocol number, never its content. */
export function documentRefProblems(value: unknown, required: boolean, at = 'documentRef'): Issue[] {
  if (value === undefined || value === null || value === '') {
    return required ? [{ path: at, message: "This code needs the backing document's reference (a certificate's protocol number): only the number, never what it says." }] : []
  }
  if (typeof value !== 'string' || !DOCUMENT_REF_PATTERN.test(value)) return [{ path: at, message: "Only the document's reference: up to 40 letters, digits, dots, slashes or hyphens (a protocol number), never a description." }]
  return []
}

export interface StandardCode {
  readonly code: string
  readonly category: AbsenceCategory
  readonly paid: boolean
  readonly documentRequired: boolean
  readonly it: string
  readonly en: string
}

/**
 * "Start from the standard list" (design people.settings, the empty state): the absence codes an Italian factory uses,
 * with no LUL code (the labour consultant gives theirs, GATE-PAYROLL). A code the tenant has already is left as it is.
 */
export const STANDARD_ABSENCE_CODES: readonly StandardCode[] = Object.freeze([
  { code: 'FER', category: 'HOLIDAY', paid: true, documentRequired: false, it: 'Ferie', en: 'Holiday' },
  { code: 'ROL', category: 'PERMIT', paid: true, documentRequired: false, it: 'Permesso (ROL)', en: 'Leave of hours (ROL)' },
  { code: 'EXF', category: 'PERMIT', paid: true, documentRequired: false, it: 'Ex festività', en: 'Former public holiday leave' },
  { code: 'PER', category: 'PERMIT', paid: true, documentRequired: false, it: 'Permesso retribuito', en: 'Paid leave' },
  { code: 'MAL', category: 'SICKNESS', paid: true, documentRequired: true, it: 'Malattia', en: 'Sickness' },
  { code: 'INF', category: 'INJURY', paid: true, documentRequired: true, it: 'Infortunio', en: 'Injury at work' },
  { code: 'MAT', category: 'PARENTAL', paid: true, documentRequired: true, it: 'Congedo di maternità', en: 'Maternity leave' },
  { code: 'PAT', category: 'PARENTAL', paid: true, documentRequired: true, it: 'Congedo di paternità', en: 'Paternity leave' },
  { code: 'CPA', category: 'PARENTAL', paid: true, documentRequired: true, it: 'Congedo parentale', en: 'Parental leave' },
  { code: 'L104', category: 'LAW_104', paid: true, documentRequired: true, it: 'Permesso legge 104', en: 'Law 104 leave' },
  { code: 'SIN', category: 'UNION', paid: true, documentRequired: false, it: 'Permesso sindacale', en: 'Union leave' },
  { code: 'ASS', category: 'UNION', paid: true, documentRequired: false, it: 'Assemblea', en: "Workers' assembly" },
  { code: 'SCI', category: 'STRIKE', paid: false, documentRequired: false, it: 'Sciopero', en: 'Strike' },
  { code: 'ASP', category: 'UNPAID_LEAVE', paid: false, documentRequired: false, it: 'Aspettativa non retribuita', en: 'Unpaid leave' },
  { code: 'LUT', category: 'OTHER', paid: true, documentRequired: false, it: 'Permesso per lutto', en: 'Bereavement leave' },
  { code: 'MTR', category: 'OTHER', paid: true, documentRequired: false, it: 'Congedo matrimoniale', en: 'Marriage leave' },
  { code: 'DON', category: 'OTHER', paid: true, documentRequired: true, it: 'Donazione di sangue', en: 'Blood donation' },
])

/** The codes of the standard list a tenant does not have yet. */
export const missingStandardCodes = (have: Iterable<string>): StandardCode[] => {
  const known = new Set(have)
  return STANDARD_ABSENCE_CODES.filter((entry) => !known.has(entry.code))
}

/** A day's absences in a list: whether every planned day off work has its code (never the code itself). */
export const ABSENCE_STATES = ['NONE', 'CODED', 'MISSING'] as const
export type AbsenceState = (typeof ABSENCE_STATES)[number]
