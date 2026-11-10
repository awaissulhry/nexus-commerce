import { Decimal } from 'decimal.js'
import type { Issue } from '../../core/errors'
import { normalisedWords, officialName, readFibre } from '../../compliance/textile-rules/fibres'
import { MATERIAL_APPROVALS, type MaterialApproval } from '../bom-structure/rules'
import type { ItemKind } from '../materials/rules'
import { decimalText } from '../units/units'

/**
 * Materials in depth (B-W2b-238; design products.materials Properties & grades, Compliance › Approval status, Where used),
 * pure. apps/factory-api's modules/product/materials-depth checks every write against these rules BEFORE it writes, so a
 * refusal is a 400 in words, never B-W2b-206's `Item_w2b4_depth` trigger (which holds the same rules for every login).
 *
 *   properties   (PRD-029) the typed properties of its kind, decimals as strings:
 *                textiles (TEXTILE, LINING, MEMBRANE, PADDING): weight g/m² (weightGsm), width cm (widthCm), construction
 *                protectors (PROTECTOR): standard ("EN 1621-1:2012"), type ("shoulder"), level "1" | "2", size
 *                trims and hardware (TRIM, HARDWARE): material, finish, size, nickel free (true | false)
 *                texts 1 to 100 characters on one line; any other kind has none (leather's are W1's columns, the rest
 *                "Other attributes")
 *   composition  (PRD-033) W1's fibres adding up to exactly 100 % (product/materials rules); here each fibre is read against
 *                Reg. (EU) 1007/2011 Annex I (B-W2b-208's list), so the label the composition feeds says official names
 *   approval     (PRD-035) PENDING (in development) · APPROVED · CONDITIONAL (approved on a condition) · BLOCKED (not to be
 *                used: no new BOM line takes it, no revision naming it is released; a released BOM keeps it); who and when
 *                with every decision; a condition and a block say why (1 to 1000 characters, one line)
 *   where used   (PRD-036) every BOM line and alternate of every revision that names it, with the revision's open work
 *                orders; "used" in the list = named by a DRAFT or RELEASED revision (an OBSOLETE one is history)
 */

export { MATERIAL_APPROVALS, type MaterialApproval }

// ---- properties of its kind (PRD-029) -------------------------------------------------------------------------------------

export const PROPERTY_SHAPES = ['TEXTILE', 'PROTECTOR', 'TRIM'] as const
export type PropertyShape = (typeof PROPERTY_SHAPES)[number]

/** Which typed properties a kind has (null: none). The database's factory_item_properties_problem, kind by kind. */
export const SHAPE_OF_KIND: Readonly<Partial<Record<ItemKind, PropertyShape>>> = Object.freeze({
  TEXTILE: 'TEXTILE',
  LINING: 'TEXTILE',
  MEMBRANE: 'TEXTILE',
  PADDING: 'TEXTILE',
  PROTECTOR: 'PROTECTOR',
  TRIM: 'TRIM',
  HARDWARE: 'TRIM',
})

export const shapeOf = (kind: string): PropertyShape | null => SHAPE_OF_KIND[kind as ItemKind] ?? null

export const PROPERTY_KEYS: Readonly<Record<PropertyShape, readonly PropertyKey[]>> = Object.freeze({
  TEXTILE: ['weightGsm', 'widthCm', 'construction'],
  PROTECTOR: ['standard', 'type', 'level', 'size'],
  TRIM: ['material', 'finish', 'size', 'nickelFree'],
})

export type PropertyKey = 'weightGsm' | 'widthCm' | 'construction' | 'standard' | 'type' | 'level' | 'size' | 'material' | 'finish' | 'nickelFree'
export const DECIMAL_PROPERTIES: readonly PropertyKey[] = ['weightGsm', 'widthCm']
export const PROPERTY_TEXT_MAX = 100

/** EN 1621 performance levels of an impact protector. */
export const PROTECTOR_LEVELS = ['1', '2'] as const

/** What the screens offer to pick from; any other text of 1 to 100 characters is kept as typed. */
export const PROPERTY_SUGGESTIONS: Readonly<Partial<Record<PropertyKey, readonly string[]>>> = Object.freeze({
  construction: ['woven', 'knitted', 'non-woven', 'mesh', '2-layer laminate', '3-layer laminate'],
  standard: ['EN 1621-1:2012', 'EN 1621-2:2014', 'EN 1621-3:2018', 'EN 1621-4:2013'],
  type: ['shoulder', 'elbow', 'hip', 'knee', 'back', 'chest'],
})

/** The typed properties of a material, as stored in Item.properties (decimals as strings). */
export interface MaterialProperties {
  readonly weightGsm?: string
  readonly widthCm?: string
  readonly construction?: string
  readonly standard?: string
  readonly type?: string
  readonly level?: string
  readonly size?: string
  readonly material?: string
  readonly finish?: string
  readonly nickelFree?: boolean
}

const DECIMAL = /^[0-9]{1,8}(\.[0-9]{1,4})?$/
const MAX_DECIMAL = new Decimal(99_999_999)
const CONTROL = /[\u0000-\u001f\u007f]/

const KIND_WORDS: Readonly<Record<PropertyShape, string>> = { TEXTILE: 'a textile', PROTECTOR: 'a protector', TRIM: 'a trim or hardware' }
const KEY_WORDS: Readonly<Record<PropertyKey, string>> = {
  weightGsm: 'weight (g/m²)',
  widthCm: 'width (cm)',
  construction: 'construction',
  standard: 'standard',
  type: 'type',
  level: 'level',
  size: 'size',
  material: 'material',
  finish: 'finish',
  nickelFree: 'nickel free',
}

/** A decimal above 0 with at most 8 digits and 4 decimals (no float), or why not. */
export function propertyDecimalProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !DECIMAL.test(value) || new Decimal(value).lte(0) || new Decimal(value).gt(MAX_DECIMAL)) {
    return 'Expected a number above 0 with at most 8 digits and 4 decimals.'
  }
  return null
}

/** Every rule a material's typed properties break, each at `properties/<key>` (null: no properties, always fine). */
export function propertiesProblems(kind: string, properties: unknown): Issue[] {
  if (properties === null || properties === undefined) return []
  if (typeof properties !== 'object' || Array.isArray(properties)) return [{ path: 'properties', message: 'The properties are an object of its kind’s fields.' }]
  const shape = shapeOf(kind)
  const issues: Issue[] = []
  for (const [key, value] of Object.entries(properties as Record<string, unknown>)) {
    const at = `properties/${key}`
    if (!shape) {
      issues.push({ path: at, message: `A ${kind.toLowerCase()} material has no typed properties: write it under Other attributes.` })
      continue
    }
    if (!(PROPERTY_KEYS[shape] as readonly string[]).includes(key)) {
      issues.push({ path: at, message: `${capital(KIND_WORDS[shape])} material has no "${key}": it takes ${PROPERTY_KEYS[shape].map((name) => KEY_WORDS[name]).join(', ')}.` })
      continue
    }
    if ((DECIMAL_PROPERTIES as readonly string[]).includes(key)) {
      const problem = propertyDecimalProblem(value)
      if (problem) issues.push({ path: at, message: problem })
    } else if (key === 'level') {
      if (typeof value !== 'string' || !(PROTECTOR_LEVELS as readonly string[]).includes(value)) issues.push({ path: at, message: 'The EN 1621 level is 1 or 2.' })
    } else if (key === 'nickelFree') {
      if (typeof value !== 'boolean') issues.push({ path: at, message: 'Nickel free is yes or no.' })
    } else if (typeof value !== 'string' || value.trim() === '' || value !== value.trim() || value.length > PROPERTY_TEXT_MAX || CONTROL.test(value)) {
      issues.push({ path: at, message: `Expected one line of 1 to ${PROPERTY_TEXT_MAX} characters, without leading or trailing spaces.` })
    }
  }
  return issues
}

const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1)

/**
 * The properties as stored: texts trimmed, decimals in their plain form ("180.50" → "180.5"), what was left empty dropped;
 * null when nothing is left. Values it cannot read are kept as they came, for propertiesProblems to name.
 */
export function normaliseProperties(properties: Readonly<Record<string, unknown>> | null | undefined): MaterialProperties | null {
  if (properties === null || properties === undefined) return null
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string') {
      const text = value.trim()
      if (text === '') continue
      kept[key] = (DECIMAL_PROPERTIES as readonly string[]).includes(key) && DECIMAL.test(text) ? decimalText(text) : text
    } else kept[key] = value
  }
  return Object.keys(kept).length === 0 ? null : (kept as MaterialProperties)
}

/** The keys whose values differ (a key added, changed or removed). */
export function changedProperties(before: MaterialProperties | null, after: MaterialProperties | null): PropertyKey[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])
  return [...keys].filter((key) => (before as Record<string, unknown> | null)?.[key] !== (after as Record<string, unknown> | null)?.[key]).sort() as PropertyKey[]
}

/**
 * A kind change of a material with typed properties (W1's PATCH, its import): refused in words while the properties do not
 * fit the new kind (the database would refuse it with a bare check violation), so nothing typed is lost silently.
 */
export function kindChangeProblem(code: string, properties: unknown, nextKind: string): string | null {
  if (properties === null || properties === undefined) return null
  if (propertiesProblems(nextKind, properties).length === 0) return null
  return `Material ${code} has typed properties of its kind: clear them on Properties & grades before it becomes a ${nextKind.toLowerCase()} material.`
}

/** The typed weight a textile's composition is weighed with (B-W2b-208): grams per m² and, when known, the width in cm. */
export function typedWeight(properties: unknown): { readonly gsm: string; readonly widthCm: string | null } | null {
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) return null
  const { weightGsm, widthCm } = properties as Record<string, unknown>
  if (propertyDecimalProblem(weightGsm) !== null) return null
  return { gsm: weightGsm as string, widthCm: propertyDecimalProblem(widthCm) === null ? (widthCm as string) : null }
}

// ---- the approval (PRD-035) -----------------------------------------------------------------------------------------------

export const APPROVAL_NOTE_MAX = 1000
/** The decisions that need why (the database refuses them without a note). */
export const APPROVALS_WITH_NOTE: readonly MaterialApproval[] = ['CONDITIONAL', 'BLOCKED']
/** A material a BOM may be released with (B-W2b-223's isApproved): APPROVED or CONDITIONAL. */
export const isUsable = (approval: MaterialApproval): boolean => approval === 'APPROVED' || approval === 'CONDITIONAL'

/** The note as stored: trimmed; '' is none. */
export const noteOf = (note: string | null | undefined): string | null => (note === null || note === undefined || note.trim() === '' ? null : note.trim())

/** Every rule a decision breaks, at `body/<field>`. */
export function approvalProblems(approval: MaterialApproval, note: string | null): Issue[] {
  if (note !== null && (note.length > APPROVAL_NOTE_MAX || CONTROL.test(note))) {
    return [{ path: 'body/note', message: `Why is one line of at most ${APPROVAL_NOTE_MAX} characters.` }]
  }
  if (APPROVALS_WITH_NOTE.includes(approval) && note === null) {
    return [{ path: 'body/note', message: approval === 'BLOCKED' ? 'Say why the material is blocked (the people who use it read it).' : 'Say the condition it is approved on (the people who use it read it).' }]
  }
  return []
}

/** What the people choosing materials read for each decision (English: the API's sentences; the screens say their own). */
export const APPROVAL_WORDS: Readonly<Record<MaterialApproval, string>> = Object.freeze({
  PENDING: 'in development: not reviewed yet',
  APPROVED: 'approved for use',
  CONDITIONAL: 'approved on a condition',
  BLOCKED: 'blocked: not to be used',
})

/** What a decision does to where the material is used (the confirmation and the audit row say it). */
export interface ApprovalReach {
  /** Draft revisions whose BOM names it (as a line or an alternate): a block holds their release. */
  readonly draftRevisions: number
  /** Released revisions whose BOM names it: a block leaves them as they are (a released BOM is frozen). */
  readonly releasedRevisions: number
  /** Open work orders of those released revisions: they go on. */
  readonly openWorkOrders: number
}

/** The consequences of moving to `next` in words (empty: nothing to say). */
export function approvalConsequences(next: MaterialApproval, reach: ApprovalReach): string[] {
  if (next !== 'BLOCKED') return []
  const words: string[] = ['No new BOM line takes it.']
  if (reach.draftRevisions > 0) words.push(`${reach.draftRevisions} draft revision(s) naming it cannot be released until it is replaced or approved again.`)
  if (reach.releasedRevisions > 0) words.push(`${reach.releasedRevisions} released revision(s) keep it as they are${reach.openWorkOrders > 0 ? `, and their ${reach.openWorkOrders} open work order(s) go on` : ''}.`)
  return words
}

// ---- the fibres of its composition (PRD-033) -----------------------------------------------------------------------------

export const FIBRE_FINDINGS = ['NOT_OFFICIAL', 'TRADE_MARK', 'NOT_TEXTILE', 'UNKNOWN'] as const
export type FibreFinding = (typeof FIBRE_FINDINGS)[number]

/** One fibre of the composition as the label reads it. */
export interface FibreReadingView {
  readonly fibre: string
  readonly percent: string
  /** The Annex I fibre it is (its English official name), else null. */
  readonly annexFibre: string | null
  /** Its official names on file (Italian is missing where the wording is not certain); null: not an Annex I fibre. */
  readonly official: { readonly it: string | null; readonly en: string | null } | null
  /** What the label must change (null: the typed name is an official one). */
  readonly finding: FibreFinding | null
  readonly message: string | null
}

/** Each fibre read against Reg. (EU) 1007/2011 Annex I: an official name, another word for one, a trade mark, leather, unknown. */
export function fibreReadings(composition: readonly { readonly fibre: string; readonly percent: string }[] | null): FibreReadingView[] {
  return (composition ?? []).map((share) => {
    const reading = readFibre(share.fibre)
    if (reading.kind === 'NOT_TEXTILE') {
      return { fibre: share.fibre, percent: share.percent, annexFibre: null, official: null, finding: 'NOT_TEXTILE', message: `${share.fibre} is not a textile fibre: leave it out of the composition and mark the material as of animal origin (the label's phrase, art. 12).` }
    }
    if (reading.kind === 'UNKNOWN') {
      return { fibre: share.fibre, percent: share.percent, annexFibre: null, official: null, finding: 'UNKNOWN', message: `${share.fibre} is not a fibre name this check knows: check it against Reg. (EU) 1007/2011 Annex I.` }
    }
    const { fibre } = reading
    const official = { it: officialName(fibre, 'it'), en: officialName(fibre, 'en') }
    const typed = normalisedWords(share.fibre)
    const isOfficial = Object.values(fibre.names).some((name) => normalisedWords(name) === typed)
    if (reading.brand) {
      return { fibre: share.fibre, percent: share.percent, annexFibre: fibre.key, official, finding: 'TRADE_MARK', message: `${share.fibre} is a trade mark: the label says ${fibre.key} (art. 5), the mark may only follow it.` }
    }
    if (!isOfficial) {
      return { fibre: share.fibre, percent: share.percent, annexFibre: fibre.key, official, finding: 'NOT_OFFICIAL', message: `${share.fibre} is not the official name: the label says ${fibre.key}.` }
    }
    return { fibre: share.fibre, percent: share.percent, annexFibre: fibre.key, official, finding: null, message: null }
  })
}

// ---- where used (PRD-036) ---------------------------------------------------------------------------------------------------

/** The revisions a material counts as used by (the list's Used in, the "Not used in any BOM" tile). */
export const CURRENT_REVISION_STATES = ['DRAFT', 'RELEASED'] as const
export const WHERE_USED_ROLES = ['LINE', 'ALTERNATE'] as const
export type WhereUsedRole = (typeof WHERE_USED_ROLES)[number]
/** Rows one answer carries (newest revisions first); `more` says when there were more. */
export const WHERE_USED_LIMIT = 500
const REVISION_ORDER: Readonly<Record<string, number>> = { DRAFT: 0, RELEASED: 1, OBSOLETE: 2 }

/** Where-used rows in reading order: current revisions first (draft, released, obsolete), by style code, newest revision, line. */
export function whereUsedOrder<T extends { readonly style: { readonly code: string }; readonly revision: { readonly revision: number; readonly status: string }; readonly seq: number; readonly role: WhereUsedRole }>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (REVISION_ORDER[a.revision.status] ?? 3) - (REVISION_ORDER[b.revision.status] ?? 3) ||
      (a.style.code < b.style.code ? -1 : a.style.code > b.style.code ? 1 : 0) ||
      b.revision.revision - a.revision.revision ||
      a.seq - b.seq ||
      (a.role === b.role ? 0 : a.role === 'LINE' ? -1 : 1),
  )
}
