import type { Issue } from '../../core/errors'
import { TANNAGES } from '../../product/materials/rules'
import { Dec } from '../../tax/decimal'

/**
 * A lot's attributes, typed per material kind (B-W2b-313; SCM-185: "Per lot: article, colour, thickness range, finish,
 * tannage (chrome, vegetable, chrome-free), grade, origin; searchable"; design warehouse.lots lt-facts "W2b attributes:
 * thickness range, finish, tannage, grade, origin"). Pure; the same rules as the database's factory_lot_attributes_problem
 * (…_warehouse_depth_w2b_guards), so the API answers in words at `body/attributes/<key>` before the trigger would refuse:
 *
 *   LEATHER                              thicknessMinMm, thicknessMaxMm (decimal strings above 0, at most 20 mm, min ≤ max),
 *                                        finish, tannage (CHROME, VEGETABLE, CHROME_FREE, COMBINATION), gradeMix
 *                                        { "<grade code>": "<percent>" } (each above 0, all at most 100), origin
 *   TEXTILE, LINING, MEMBRANE, PADDING   widthCm, weightGsm (decimal strings above 0), origin
 *   any other kind                       origin
 *
 * Words are 1 to 100 characters on one line. Decimals are at most 8 digits with 4 decimals. {} means nothing recorded.
 */

export const LEATHER_ATTRIBUTES = ['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'origin'] as const
export const FABRIC_ATTRIBUTES = ['widthCm', 'weightGsm', 'origin'] as const
export const OTHER_ATTRIBUTES = ['origin'] as const
export const ATTRIBUTE_KEYS = ['thicknessMinMm', 'thicknessMaxMm', 'finish', 'tannage', 'gradeMix', 'widthCm', 'weightGsm', 'origin'] as const
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number]

export const FABRIC_KINDS = ['TEXTILE', 'LINING', 'MEMBRANE', 'PADDING'] as const

export const ATTRIBUTE_LIMITS = Object.freeze({ words: 100, thicknessMm: 20, fabric: 100_000, percent: 100, grades: 20 })

/** The attributes a lot of this material kind may carry, in the form's order. */
export function attributeKeysFor(itemKind: string): readonly AttributeKey[] {
  if (itemKind === 'LEATHER') return LEATHER_ATTRIBUTES
  if ((FABRIC_KINDS as readonly string[]).includes(itemKind)) return FABRIC_ATTRIBUTES
  return OTHER_ATTRIBUTES
}

/** What a lot's attributes are: strings, and the grade mix as grade code → percent. */
export type LotAttributes = Partial<Record<Exclude<AttributeKey, 'gradeMix'>, string>> & { readonly gradeMix?: Readonly<Record<string, string>> }

const DECIMAL = /^[0-9]{1,8}(\.[0-9]{1,4})?$/
const GRADE_CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/
// Control characters: none (one line).
const CONTROL = /[\u0000-\u001f\u007f]/

const decimalOk = (value: unknown, max: number): value is string => typeof value === 'string' && DECIMAL.test(value) && new Dec(value).greaterThan(0) && new Dec(value).lessThanOrEqualTo(max)
const wordsOk = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= ATTRIBUTE_LIMITS.words && !CONTROL.test(value)

/**
 * Why the attributes do not fit the kind (each problem at `<path>/<key>`), or none. `attributes` is the whole object the
 * lot will carry (after a change is merged).
 */
export function attributesProblems(itemKind: string, attributes: unknown, path = 'attributes'): Issue[] {
  if (attributes === null || typeof attributes !== 'object' || Array.isArray(attributes)) return [{ path, message: "Give the lot's attributes as an object ({} for none)." }]
  const allowed = attributeKeysFor(itemKind)
  const problems: Issue[] = []
  const entries = attributes as Record<string, unknown>
  for (const [key, value] of Object.entries(entries)) {
    const at = `${path}/${key}`
    if (!(allowed as readonly string[]).includes(key)) {
      problems.push({ path: at, message: `Not an attribute of a lot of ${itemKind.toLowerCase()}: it takes ${allowed.join(', ')}.` })
      continue
    }
    switch (key as AttributeKey) {
      case 'thicknessMinMm':
      case 'thicknessMaxMm':
        if (!decimalOk(value, ATTRIBUTE_LIMITS.thicknessMm)) problems.push({ path: at, message: 'A thickness in mm above 0 and at most 20, as a decimal (1.2).' })
        break
      case 'widthCm':
      case 'weightGsm':
        if (!decimalOk(value, ATTRIBUTE_LIMITS.fabric)) problems.push({ path: at, message: key === 'widthCm' ? 'A width in cm above 0, as a decimal (140).' : 'A weight in g/m² above 0, as a decimal (85).' })
        break
      case 'finish':
      case 'origin':
        if (!wordsOk(value)) problems.push({ path: at, message: 'Words of 1 to 100 characters on one line.' })
        break
      case 'tannage':
        if (typeof value !== 'string' || !(TANNAGES as readonly string[]).includes(value)) problems.push({ path: at, message: `The tannage is one of ${TANNAGES.join(', ')}.` })
        break
      case 'gradeMix':
        problems.push(...gradeMixProblems(value, at))
        break
    }
  }
  const min = entries.thicknessMinMm
  const max = entries.thicknessMaxMm
  if (decimalOk(min, ATTRIBUTE_LIMITS.thicknessMm) && decimalOk(max, ATTRIBUTE_LIMITS.thicknessMm) && new Dec(min).greaterThan(max)) {
    problems.push({ path: `${path}/thicknessMinMm`, message: `The thinnest (${min} mm) is above the thickest (${max} mm).` })
  }
  return problems
}

function gradeMixProblems(value: unknown, at: string): Issue[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length === 0) {
    return [{ path: at, message: 'The grade mix names at least one grade with its share: { "A": "60", "B": "40" }.' }]
  }
  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > ATTRIBUTE_LIMITS.grades) return [{ path: at, message: `At most ${ATTRIBUTE_LIMITS.grades} grades.` }]
  const problems: Issue[] = []
  let total = new Dec(0)
  for (const [code, share] of entries) {
    if (!GRADE_CODE.test(code)) problems.push({ path: `${at}/${code}`, message: 'A grade code of letters and digits (A, B, 1).' })
    else if (!decimalOk(share, ATTRIBUTE_LIMITS.percent)) problems.push({ path: `${at}/${code}`, message: 'A share in percent above 0 and at most 100, as a decimal.' })
    else total = total.plus(share)
  }
  if (problems.length === 0 && total.greaterThan(ATTRIBUTE_LIMITS.percent)) problems.push({ path: at, message: `The grade mix adds up to ${total.toString()} %; at most 100.` })
  return problems
}

/**
 * A change merged into the lot's attributes: a key set to a value replaces it, a key set to null removes it, a key left
 * out stays. Words are trimmed; decimals are kept as typed (the database compares them as numbers).
 */
export function mergeAttributes(current: Readonly<Record<string, unknown>>, change: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(change)) {
    if (value === null) delete next[key]
    else next[key] = typeof value === 'string' ? value.trim() : value
  }
  return next
}

/** The keys whose value differs between two attribute objects (the event's and the audit's list). */
export function changedAttributes(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  return [...keys].filter((key) => JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null)).sort()
}
