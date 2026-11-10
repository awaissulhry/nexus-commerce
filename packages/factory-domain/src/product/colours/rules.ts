import type { Issue } from '../../core/errors'
import { MATERIAL_CODE, MATERIAL_CODE_RULE, normaliseCode } from '../materials/rules'

/**
 * The colour library (B-W2b-247; PRD-041; design products.colours, SCR-118): one list of the company's colours for leather,
 * textile and thread, each with our code, its name (it / en), the system its reference is in (Pantone, RAL, NCS or our
 * own swatch), the reference, a family for the filters, the hex a screen draws, and a photo. Material colours
 * (ItemColour.colourId), colourways (Colourway.colourId) and the brands' branding sets (BrandingSet.brandColourIds) name
 * them. Pure: what a colour may be (the database's Colour_system_check said first, in words), how a typed value is
 * read, the saved views of the list and the notices it shows.
 */

export const COLOUR_SYSTEMS = ['PANTONE', 'RAL', 'NCS', 'OWN'] as const
export type ColourSystem = (typeof COLOUR_SYSTEMS)[number]

/** The systems whose reference is required (OWN: our own swatch, a reference of our own optional). */
export const REFERENCE_REQUIRED: readonly ColourSystem[] = ['PANTONE', 'RAL', 'NCS']

/** The list's saved views (design sec:colours.grid savedRows: Active; Unused; Archived; All). */
export const COLOUR_VIEWS = ['active', 'unused', 'archived', 'all'] as const
export type ColourView = (typeof COLOUR_VIEWS)[number]

export const COLOUR_LIMITS = Object.freeze({ name: 120, reference: 40, family: 40, reason: 500 })

export const COLOUR_CODE = MATERIAL_CODE
export const COLOUR_CODE_RULE = MATERIAL_CODE_RULE

/** A colour as the screen draws it: "#RRGGBB", upper case. */
export const HEX = /^#[0-9A-F]{6}$/

/** The languages a colour's name is kept in besides its own name. */
export const COLOUR_LOCALES = ['it', 'en'] as const
export type ColourLocale = (typeof COLOUR_LOCALES)[number]

// ---- reading what was typed ---------------------------------------------------------------------------------------------

/**
 * A hex as typed: "#1a1a1a", "1A1A1A", "#abc" (three digits doubled) → "#1A1A1A". Empty → null (no hex). Anything else →
 * undefined (not a hex).
 */
export function normaliseHex(text: string | null | undefined): string | null | undefined {
  if (text === null || text === undefined) return null
  const value = text.trim().replace(/^#/, '').toUpperCase()
  if (value === '') return null
  if (/^[0-9A-F]{3}$/.test(value)) return `#${value.split('').map((digit) => `${digit}${digit}`).join('')}`
  if (/^[0-9A-F]{6}$/.test(value)) return `#${value}`
  return undefined
}

/**
 * A reference as typed, in its system's usual form: spaces collapsed; RAL "9005" or "ral 9005" → "RAL 9005"; NCS "s
 * 9000-n" → "S 9000-N"; Pantone's suffix in capitals ("18-1662 tcx" → "18-1662 TCX"). Empty → null.
 */
export function normaliseReference(system: ColourSystem | null, text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const value = text.trim().replace(/\s+/g, ' ')
  if (value === '') return null
  if (system === 'RAL') {
    const digits = /^(?:RAL\s?)?(\d{4})$/i.exec(value)
    return digits ? `RAL ${digits[1]}` : value.replace(/^ral\b/i, 'RAL')
  }
  if (system === 'NCS') return value.toUpperCase()
  if (system === 'PANTONE') return value.replace(/^pantone\s+/i, '').replace(/\b(tcx|tpx|tpg|tn|c|u)$/i, (suffix) => suffix.toUpperCase())
  return value
}

/** A family as typed: trimmed, spaces collapsed, lower case ("Dark Blue " → "dark blue"). Empty → null. */
export function normaliseFamily(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null
  const value = text.trim().replace(/\s+/g, ' ').toLowerCase()
  return value === '' ? null : value
}

/** A name per language as typed: trimmed; empty names left out. */
export function normaliseNames(names: Partial<Record<ColourLocale, string | null | undefined>> | null | undefined): Partial<Record<ColourLocale, string>> {
  const out: Partial<Record<ColourLocale, string>> = {}
  for (const locale of COLOUR_LOCALES) {
    const value = names?.[locale]?.trim()
    if (value) out[locale] = value
  }
  return out
}

/** An example reference per system, for a field's hint (made-up values are fine: these are the systems' own formats). */
export const REFERENCE_EXAMPLES: Readonly<Record<ColourSystem, string>> = Object.freeze({ PANTONE: '19-4052 TCX', RAL: 'RAL 9005', NCS: 'S 9000-N', OWN: 'NX-BLU-02' })

// ---- what a colour may be -----------------------------------------------------------------------------------------------

export interface ColourFields {
  readonly code: string
  readonly name: string
  readonly names: Partial<Record<ColourLocale, string>>
  readonly system: ColourSystem | null
  readonly reference: string | null
  readonly family: string | null
  /** null: none; undefined: what was typed is no hex. */
  readonly hex: string | null | undefined
}

const CONTROL = /[\u0000-\u001f\u007f]/

/** A one-line text of 1 to `max` characters (the database's factory_styles_text_ok). */
const textOk = (value: string, max: number): boolean => value.trim() !== '' && value.length <= max && !CONTROL.test(value)

/**
 * Why a colour cannot be kept, per field (`at` + the field): the code (the material code's rule), the name and its it/en
 * names, the hex, and the database's Colour_system_check said first — a reference only with its system, one for Pantone,
 * RAL and NCS, the reference and the family 1 to 40 characters on one line.
 */
export function colourProblems(colour: ColourFields, at = 'body/'): Issue[] {
  const issues: Issue[] = []
  if (!COLOUR_CODE.test(colour.code)) issues.push({ path: `${at}code`, message: `Expected ${COLOUR_CODE_RULE}.` })
  if (!textOk(colour.name, COLOUR_LIMITS.name)) issues.push({ path: `${at}name`, message: `Name the colour (1 to ${COLOUR_LIMITS.name} characters on one line).` })
  for (const locale of COLOUR_LOCALES) {
    const name = colour.names[locale]
    if (name !== undefined && !textOk(name, COLOUR_LIMITS.name)) issues.push({ path: `${at}names/${locale}`, message: `A name is 1 to ${COLOUR_LIMITS.name} characters on one line.` })
  }
  if (colour.hex === undefined) issues.push({ path: `${at}hex`, message: 'Expected a hex colour such as #1A1A1A.' })
  if (colour.reference !== null && colour.system === null) issues.push({ path: `${at}reference`, message: 'Say which colour system the reference is in.' })
  if (colour.system !== null && REFERENCE_REQUIRED.includes(colour.system) && colour.reference === null) {
    issues.push({ path: `${at}reference`, message: `A ${colour.system} colour needs its ${colour.system} reference (for example ${REFERENCE_EXAMPLES[colour.system]}).` })
  }
  if (colour.reference !== null && !textOk(colour.reference, COLOUR_LIMITS.reference)) issues.push({ path: `${at}reference`, message: `A reference is 1 to ${COLOUR_LIMITS.reference} characters on one line.` })
  if (colour.family !== null && !textOk(colour.family, COLOUR_LIMITS.family)) issues.push({ path: `${at}family`, message: `A family is 1 to ${COLOUR_LIMITS.family} characters on one line.` })
  return issues
}

/** A colour as typed → its fields as kept (code upper case, names trimmed, reference in its system's form). */
export function normaliseColour(typed: {
  readonly code: string
  readonly name: string
  readonly names?: Partial<Record<ColourLocale, string | null | undefined>> | null | undefined
  readonly system?: ColourSystem | null | undefined
  readonly reference?: string | null | undefined
  readonly family?: string | null | undefined
  readonly hex?: string | null | undefined
}): ColourFields {
  const system = typed.system ?? null
  return {
    code: normaliseCode(typed.code),
    name: typed.name.trim(),
    names: normaliseNames(typed.names),
    system,
    reference: normaliseReference(system, typed.reference),
    family: normaliseFamily(typed.family),
    hex: normaliseHex(typed.hex),
  }
}

// ---- use ---------------------------------------------------------------------------------------------------------------

/** What names a colour: the counts the list shows (null: not in the reader's role) and whether anything in the tenant does. */
export interface ColourUse {
  readonly materialColours: number | null
  readonly colourways: number | null
  readonly brandingSets: number | null
  /** Anything in the tenant names it (also what the reader cannot see). */
  readonly inUse: boolean
}

/** A colour nobody names: the "Unused" view and tile (archive candidates). */
export const isUnused = (use: Pick<ColourUse, 'inUse'>): boolean => !use.inUse

/**
 * Why a colour cannot be archived or restored now, or null. Archiving a colour in use is allowed: what names it keeps it
 * (a colourway, a material colour, a branding set), no new one can pick it.
 */
export function statusRefusal(status: 'ACTIVE' | 'ARCHIVED', to: 'ACTIVE' | 'ARCHIVED', code: string): string | null {
  if (status === to) return to === 'ARCHIVED' ? `Colour ${code} is archived already.` : `Colour ${code} is in use already.`
  return null
}

/** A change of an archived colour other than its restore is refused (restore it first). */
export const archivedRefusal = (code: string): string => `Colour ${code} is archived: restore it before changing it.`

// ---- the list's notices (design sec:colours.notices) -------------------------------------------------------------------

/**
 * The notices of the page, the most serious first; the screen shows one Banner and "N more notices" for the rest. A
 * dismissal is kept by the notice's key AND its value, so the same fact with a new value shows again.
 *
 *   IGNORED_FILTER     a filter of the address the API could not apply (an unknown system or family), named
 *   BRANDS_WITHOUT_SET private-label brands with active styles and no active branding set (the data the page lacks)
 *   NO_HEX             colours in use without a hex: drawn as a striped swatch on every screen
 */
export const NOTICE_KINDS = ['IGNORED_FILTER', 'BRANDS_WITHOUT_SET', 'NO_HEX'] as const
export type NoticeKind = (typeof NOTICE_KINDS)[number]
export type NoticeTone = 'danger' | 'warning' | 'info'

export interface ColourNotice {
  readonly kind: NoticeKind
  readonly tone: NoticeTone
  /** How many rows it is about, or the ignored filter's value. */
  readonly value: string
  readonly count: number
}

const TONE_RANK: Readonly<Record<NoticeTone, number>> = { danger: 0, warning: 1, info: 2 }

/** The page's notices from its facts, the most serious first (tone, then the kind's order); none with a zero count. */
export function noticesOf(facts: { readonly ignored: readonly string[]; readonly brandsWithoutSet: number; readonly noHex: number }): ColourNotice[] {
  const notices: ColourNotice[] = [
    ...facts.ignored.map((value): ColourNotice => ({ kind: 'IGNORED_FILTER', tone: 'warning', value, count: 1 })),
    ...(facts.brandsWithoutSet > 0 ? [{ kind: 'BRANDS_WITHOUT_SET', tone: 'warning', value: String(facts.brandsWithoutSet), count: facts.brandsWithoutSet } as const] : []),
    ...(facts.noHex > 0 ? [{ kind: 'NO_HEX', tone: 'info', value: String(facts.noHex), count: facts.noHex } as const] : []),
  ]
  return notices.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || NOTICE_KINDS.indexOf(a.kind) - NOTICE_KINDS.indexOf(b.kind))
}

/** The key a dismissal is kept under: the kind and its value (a new value shows the notice again). */
export const noticeKey = (notice: Pick<ColourNotice, 'kind' | 'value'>): string => `${notice.kind}:${notice.value}`

/** The notices still to show after the dismissed ones. */
export const shownNotices = (notices: readonly ColourNotice[], dismissed: ReadonlySet<string>): ColourNotice[] => notices.filter((notice) => !dismissed.has(noticeKey(notice)))
