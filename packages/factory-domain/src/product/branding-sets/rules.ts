import type { Issue } from '../../core/errors'
import { PACKAGING_PER, PACKAGING_RULE_KEY, type PackagingPer } from '../../compliance/label-artwork/rules'

/**
 * A private-label customer's branding set (B-W2b-247; PRD-045; design products.colours sec:colours.branding,
 * pop:colours.branding): the brand's logos, its label artwork, how its garments are packed and tagged (packaging rules) and
 * its brand colours, which its styles' labels, hang tags, packaging and tech packs use (B-W2b-259's label lines, B-W2b-230's
 * tech pack read the ACTIVE set of the style's company and brand). Pure: what a set may be — B-W2b-206's
 * BrandingSet_check and factory_packaging_rules_problem said first, in words — and what a change of it does.
 *
 * One ACTIVE set per company and brand: a new set for a brand that has one archives the old one in the same command (the
 * partial unique BrandingSet_one_active_per_brand). Its files are files of the set (StoredFile recordType "BrandingSet",
 * recordId the set): a logo is a picture (PHOTO), label artwork a picture or a document. Archived, never deleted.
 */

export const BRANDING_LIMITS = Object.freeze({ code: 60, name: 200, note: 2000, rules: 50, ruleText: 500, files: 30, colours: 30, reason: 500 })

/** The file roles of a set and the file kinds each takes (B-W2b-206's guard). */
export const BRANDING_FILE_ROLES = ['LOGO', 'ARTWORK'] as const
export type BrandingFileRole = (typeof BRANDING_FILE_ROLES)[number]
export const FILE_KINDS_OF_ROLE: Readonly<Record<BrandingFileRole, readonly string[]>> = Object.freeze({ LOGO: ['PHOTO'], ARTWORK: ['PHOTO', 'DOCUMENT', 'ATTACHMENT'] })

/**
 * The pictures a screen draws (a logo, a picture of artwork): B-W2b-236's JPEG, PNG and WebP (served through the API, never
 * an SVG drawn inline); any other artwork file opens as a document.
 */
export { isPictureType as isDrawnPicture } from '../images/rules'

export { PACKAGING_PER, PACKAGING_RULE_KEY }
export type { PackagingPer }

/** A packaging rule as the office writes it: a key, words, and (all three or none) a material, a quantity and what it is per. */
export interface PackagingRuleDraft {
  readonly key: string
  readonly text: string
  readonly itemId?: string | null | undefined
  readonly quantity?: string | null | undefined
  readonly per?: PackagingPer | null | undefined
}

/** A rule as stored (BrandingSet.packagingRules): the three parts only when there is a material. */
export interface StoredPackagingRule {
  readonly key: string
  readonly text: string
  readonly itemId?: string
  readonly quantity?: string
  readonly per?: PackagingPer
}

const CONTROL = /[\u0000-\u001f\u007f]/
const textOk = (value: string, max: number): boolean => value.trim() !== '' && value.length <= max && !CONTROL.test(value)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** A decimal string above 0, at most 8 digits and 4 decimals (the database's factory_styles_decimal_ok). */
const DECIMAL = /^[0-9]{1,8}(\.[0-9]{1,4})?$/
export const quantityOk = (value: string): boolean => DECIMAL.test(value) && /[1-9]/.test(value)

/** A key as typed: trimmed, lower case, spaces as dashes ("Hang Tag" → "hang-tag"). */
export const normaliseRuleKey = (value: string): string => value.trim().toLowerCase().replace(/[\s_]+/g, '-')

/** A quantity as typed: "1,5" → "1.5", trimmed; empty → null. */
export function normaliseQuantity(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const text = value.trim().replace(',', '.')
  return text === '' ? null : text
}

/** A rule as stored from what was typed: key and text trimmed; the three parts kept only when a material is named. */
export function storedRule(rule: PackagingRuleDraft): StoredPackagingRule {
  const key = normaliseRuleKey(rule.key)
  const text = rule.text.trim()
  const quantity = normaliseQuantity(rule.quantity)
  if (!rule.itemId && !quantity && !rule.per) return { key, text }
  return { key, text, ...(rule.itemId ? { itemId: rule.itemId } : {}), ...(quantity ? { quantity } : {}), ...(rule.per ? { per: rule.per } : {}) }
}

/** Why the packaging rules cannot be kept (at `at`/<index>/<field>): at most 50, each key once, words, all three or none. */
export function packagingRuleProblems(rules: readonly StoredPackagingRule[], at = 'body/packagingRules'): Issue[] {
  const issues: Issue[] = []
  if (rules.length > BRANDING_LIMITS.rules) issues.push({ path: at, message: `A set holds at most ${BRANDING_LIMITS.rules} packaging rules.` })
  const seen = new Set<string>()
  rules.forEach((rule, index) => {
    const path = `${at}/${index}`
    if (!PACKAGING_RULE_KEY.test(rule.key)) issues.push({ path: `${path}/key`, message: 'A key is 1 to 40 lower-case letters, digits and dashes (for example hang-tag).' })
    else if (seen.has(rule.key)) issues.push({ path: `${path}/key`, message: `The key ${rule.key} is used once in a set.` })
    seen.add(rule.key)
    if (!textOk(rule.text, BRANDING_LIMITS.ruleText)) issues.push({ path: `${path}/text`, message: `Say the rule in 1 to ${BRANDING_LIMITS.ruleText} characters on one line.` })
    const parts = [rule.itemId, rule.quantity, rule.per].filter((part) => part !== undefined).length
    if (parts !== 0 && parts !== 3) {
      const missing = rule.itemId === undefined ? 'itemId' : rule.quantity === undefined ? 'quantity' : 'per'
      issues.push({ path: `${path}/${missing}`, message: 'A rule with a material names the material, the quantity and what it is per (garment, pack or carton) — all three, or none for a rule in words.' })
    }
    if (rule.itemId !== undefined && !UUID.test(rule.itemId)) issues.push({ path: `${path}/itemId`, message: 'Pick a material of the library.' })
    if (rule.quantity !== undefined && !quantityOk(rule.quantity)) issues.push({ path: `${path}/quantity`, message: 'A quantity above 0 with at most 4 decimals.' })
    if (rule.per !== undefined && !(PACKAGING_PER as readonly string[]).includes(rule.per)) issues.push({ path: `${path}/per`, message: 'Per garment, pack or carton.' })
  })
  return issues
}

export interface SetFields {
  readonly code: string
  readonly name: string
  readonly note: string | null
}

/** A set's code as typed: trimmed, upper case. */
export const normaliseSetCode = (value: string): string => value.trim().toUpperCase()

/** Why a set's code, name or note cannot be kept (the database's words first). */
export function setProblems(set: SetFields, at = 'body/'): Issue[] {
  const issues: Issue[] = []
  if (!textOk(set.code, BRANDING_LIMITS.code) || /\s/.test(set.code)) issues.push({ path: `${at}code`, message: `A code is 1 to ${BRANDING_LIMITS.code} characters without spaces.` })
  if (!textOk(set.name, BRANDING_LIMITS.name)) issues.push({ path: `${at}name`, message: `Name the set (1 to ${BRANDING_LIMITS.name} characters on one line).` })
  if (set.note !== null && (set.note.trim() === '' || set.note.length > BRANDING_LIMITS.note)) issues.push({ path: `${at}note`, message: `A note is up to ${BRANDING_LIMITS.note} characters.` })
  return issues
}

/** Why a list of ids cannot be kept: each once, at most `max`. */
export function idListProblems(ids: readonly string[], path: string, max: number): Issue[] {
  if (ids.length > max) return [{ path, message: `At most ${max}.` }]
  if (new Set(ids).size !== ids.length) return [{ path, message: 'Each is named once.' }]
  return []
}

/**
 * A change of a set's file list that names files it does not hold: a list of the set is reordered or shortened here; a file
 * is added through its own route (it is checked as a file of the set first).
 */
export function unknownFiles(next: readonly string[], held: readonly string[]): string[] {
  const kept = new Set(held)
  return next.filter((id) => !kept.has(id))
}

/** Why a set cannot change now (archived), or null. */
export const archivedSetRefusal = (code: string): string => `Branding set ${code} is archived: restore it before changing it.`

/** What restoring a set does when its brand has another active set: refused, naming it (archive that one first). */
export const otherActiveRefusal = (code: string, other: string): string => `Branding set ${code} cannot be in use beside ${other}: a brand has one set in use per company. Archive ${other} first.`
