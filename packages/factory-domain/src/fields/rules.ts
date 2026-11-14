import { GRAINS, isGrain, type Grain } from '../auth/grains/grains'
import type { Issue } from '../core/errors'
import { REASON_COLOURS, REASON_ICONS } from '../reasons/rules'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115; design admin.fields), pure. The API (platform/fields) says
 * these rules in words BEFORE the database's guards (…_config_templates_w2b_guards, B-W2b-379) would refuse the same:
 *
 *   - a field's code is lower-case letters, digits and underscores from a letter (1-40), once per record type in the
 *     tenant; its type, list, linked record type, company and code never change (a new field instead);
 *   - labels in Italian and English, one line of 1-80 characters each; a section key like a code; order 0-9999;
 *   - a unit only on a NUMBER (one line, 1-20 characters);
 *   - "visible to": INTERNAL (every office person who reads the record), MONEY (only people holding the field's grain:
 *     a MONEY field is always MONEY-visible, and a NUMBER may be one, a margin %), PERSONAL (only fields.personal.view);
 *     the grain exactly with MONEY;
 *   - shown in the portal: only an INTERNAL field or a price (MONEY with the price grain), never personal data, a cost or
 *     pay;
 *   - a picklist exactly on SELECT and MULTI_SELECT, a linked record type exactly on LINK;
 *   - a list's code like a field's; a value's code upper-case (`FULL_GRAIN`), once per list, never changes; its colour one
 *     of the design system's swatches, its icon one of its tag icons (the ColorSwatchPicker's and IconPicker's closed
 *     sets, as the reason lists use), its description up to 500 characters; values are deactivated, never deleted.
 */

export const FIELD_TYPES = ['TEXT', 'NUMBER', 'MONEY', 'DATE', 'SELECT', 'MULTI_SELECT', 'PERSON', 'LINK', 'FILE', 'YES_NO'] as const
export type FieldType = (typeof FIELD_TYPES)[number]

export const FIELD_AUDIENCES = ['INTERNAL', 'MONEY', 'PERSONAL'] as const
export type FieldAudience = (typeof FIELD_AUDIENCES)[number]

export const FIELD_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type FieldStatus = (typeof FIELD_STATUSES)[number]

/** The types that pick from a list. */
export const PICKING_TYPES: readonly FieldType[] = ['SELECT', 'MULTI_SELECT']

export const FIELD_CODE = /^[a-z][a-z0-9_]{0,39}$/
export const OPTION_CODE = /^[A-Z0-9][A-Z0-9_]{0,39}$/

export const FIELD_LIMITS = Object.freeze({
  label: 80,
  unit: 20,
  sortOrder: 9999,
  text: 4000,
  multi: 100,
  description: 500,
  /** Active fields of one record type (a form stays a form). */
  perRecordType: 200,
  /** Values of one list. */
  perList: 200,
  /** Rows of one batch read (a grid page) or values of one write. */
  perRequest: 200,
  /** Clauses of one filter term. */
  clauses: 10,
})

export const OPTION_COLOURS = REASON_COLOURS
export const OPTION_ICONS = REASON_ICONS

/** The facts of a field the rules read (a row of CustomField, or a draft complete with them). */
export interface FieldFacts {
  readonly code: string
  readonly type: FieldType
  readonly audience: FieldAudience
  readonly grain: Grain | null
  readonly shownInPortal: boolean
}

/** What a new field brings (every fact) or a change of one (only what changes; type, code, list and link never). */
export interface FieldDraft {
  readonly code?: string | undefined
  readonly type?: FieldType | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  readonly section?: string | undefined
  readonly sortOrder?: number | undefined
  readonly required?: boolean | undefined
  readonly unit?: string | null | undefined
  readonly audience?: FieldAudience | undefined
  readonly grain?: string | null | undefined
  readonly shownInPortal?: boolean | undefined
  readonly picklistId?: string | null | undefined
  readonly linkTo?: string | null | undefined
}

const ONE_LINE = /^[^\r\n\t]*$/

function labelProblems(draft: { readonly labelIt?: string | undefined; readonly labelEn?: string | undefined }, problems: Issue[]): void {
  for (const field of ['labelIt', 'labelEn'] as const) {
    const value = draft[field]
    if (value === undefined) continue
    const text = value.trim()
    if (text === '') problems.push({ path: field, message: field === 'labelIt' ? 'Give the label in Italian.' : 'Give the label in English.' })
    else if (text.length > FIELD_LIMITS.label) problems.push({ path: field, message: `At most ${FIELD_LIMITS.label} characters.` })
    else if (!ONE_LINE.test(text)) problems.push({ path: field, message: 'One line, without tabs.' })
  }
}

/**
 * The problems of a field: a new one (`current` absent: every fact given) or a change of one (`current` = the field as it
 * is; the draft only what changes). Each at its body field.
 */
export function fieldProblems(draft: FieldDraft, current?: FieldFacts & { readonly unit: string | null }): Issue[] {
  const problems: Issue[] = []
  if (current === undefined) {
    if (draft.code === undefined || !FIELD_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A code is lower-case letters, digits and underscores, from a letter, up to 40 characters (heat_number).' })
    if (draft.type === undefined || !(FIELD_TYPES as readonly string[]).includes(draft.type)) problems.push({ path: 'type', message: 'Pick one of the field types.' })
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Give the label in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Give the label in English.' })
  } else {
    for (const fixed of ['code', 'type', 'picklistId', 'linkTo'] as const) {
      if (draft[fixed] !== undefined) problems.push({ path: fixed, message: 'A field keeps its code, type, list and linked record type: add a new field instead.' })
    }
  }
  labelProblems(draft, problems)
  if (draft.section !== undefined && !FIELD_CODE.test(draft.section)) problems.push({ path: 'section', message: 'A section is lower-case letters, digits and underscores, from a letter, up to 40 characters (custom).' })
  if (draft.sortOrder !== undefined && (!Number.isSafeInteger(draft.sortOrder) || draft.sortOrder < 0 || draft.sortOrder > FIELD_LIMITS.sortOrder)) {
    problems.push({ path: 'sortOrder', message: `A place from 0 to ${FIELD_LIMITS.sortOrder}.` })
  }
  const type = current?.type ?? draft.type
  const unit = draft.unit === undefined ? (current?.unit ?? null) : draft.unit
  if (unit !== null) {
    if (type !== 'NUMBER') problems.push({ path: 'unit', message: 'Only a number has a unit.' })
    else if (unit.trim() === '' || unit.trim().length > FIELD_LIMITS.unit || !ONE_LINE.test(unit)) problems.push({ path: 'unit', message: `A unit is one line of 1 to ${FIELD_LIMITS.unit} characters (mm, kg).` })
  }
  const audience = draft.audience ?? current?.audience ?? (type === 'MONEY' ? 'MONEY' : 'INTERNAL')
  const grain = draft.grain === undefined ? (current?.grain ?? null) : draft.grain
  if (draft.audience !== undefined && !(FIELD_AUDIENCES as readonly string[]).includes(draft.audience)) problems.push({ path: 'audience', message: 'Pick who sees it: everyone in the office, people with a money right, or people who may read personal data.' })
  if (type === 'MONEY' && audience !== 'MONEY') problems.push({ path: 'audience', message: 'A money field is seen only by people with its grain.' })
  if (audience === 'MONEY' && (grain === null || !isGrain(grain))) problems.push({ path: 'grain', message: `Say which money it is: ${GRAINS.join(', ')}.` })
  if (audience !== 'MONEY' && grain !== null) problems.push({ path: 'grain', message: 'Only a field seen by people with a money right has a grain.' })
  const portal = draft.shownInPortal ?? current?.shownInPortal ?? false
  if (portal && !(audience === 'INTERNAL' || (audience === 'MONEY' && grain === 'price'))) {
    problems.push({ path: 'shownInPortal', message: 'The portal shows only a field everyone in the office sees, or a price: never personal data, a cost or pay.' })
  }
  if (current === undefined && type !== undefined) {
    const picks = PICKING_TYPES.includes(type)
    if (picks && !draft.picklistId) problems.push({ path: 'picklistId', message: 'A select field picks from a list: choose the list.' })
    if (!picks && draft.picklistId) problems.push({ path: 'picklistId', message: 'Only a select or multi-select field picks from a list.' })
    if (type === 'LINK' && !draft.linkTo) problems.push({ path: 'linkTo', message: 'Say which kind of record it links to.' })
    if (type !== 'LINK' && draft.linkTo) problems.push({ path: 'linkTo', message: 'Only a link field links to a record.' })
  }
  return problems
}

/** The field as a person may change it: the facts after the draft applies (for the visibility checks of a change). */
export function factsAfter(current: FieldFacts, draft: FieldDraft): FieldFacts {
  const audience = draft.audience ?? current.audience
  const grain = draft.grain === undefined ? current.grain : (draft.grain as Grain | null)
  return { code: current.code, type: current.type, audience, grain: audience === 'MONEY' ? grain : null, shownInPortal: draft.shownInPortal ?? current.shownInPortal }
}

// ---- picklists ------------------------------------------------------------------------------------------------------

export interface PicklistDraft {
  readonly code?: string | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
}

export function picklistProblems(draft: PicklistDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating) {
    if (draft.code === undefined || !FIELD_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A list code is lower-case letters, digits and underscores, from a letter, up to 40 characters (lining_type).' })
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Give the name in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Give the name in English.' })
  } else if (draft.code !== undefined) problems.push({ path: 'code', message: 'A list keeps its code: records keep its values.' })
  labelProblems(draft, problems)
  return problems
}

export interface OptionDraft {
  readonly code?: string | undefined
  readonly labelIt?: string | undefined
  readonly labelEn?: string | undefined
  readonly colour?: string | null | undefined
  readonly icon?: string | null | undefined
  readonly description?: string | null | undefined
}

export function optionProblems(draft: OptionDraft, creating: boolean): Issue[] {
  const problems: Issue[] = []
  if (creating) {
    if (draft.code === undefined || !OPTION_CODE.test(draft.code)) problems.push({ path: 'code', message: 'A value code is upper-case letters, digits and underscores, up to 40 characters (FULL_GRAIN).' })
    if (draft.labelIt === undefined) problems.push({ path: 'labelIt', message: 'Give the label in Italian.' })
    if (draft.labelEn === undefined) problems.push({ path: 'labelEn', message: 'Give the label in English.' })
  } else if (draft.code !== undefined) problems.push({ path: 'code', message: 'A value keeps its code: records keep it.' })
  labelProblems(draft, problems)
  if (draft.colour !== undefined && draft.colour !== null && !(OPTION_COLOURS as readonly string[]).includes(draft.colour.toLowerCase())) problems.push({ path: 'colour', message: 'Pick one of the colours offered.' })
  if (draft.icon !== undefined && draft.icon !== null && !(OPTION_ICONS as readonly string[]).includes(draft.icon)) problems.push({ path: 'icon', message: 'Pick one of the icons offered.' })
  if (draft.description !== undefined && draft.description !== null && draft.description.trim().length > FIELD_LIMITS.description) {
    problems.push({ path: 'description', message: `At most ${FIELD_LIMITS.description} characters.` })
  }
  return problems
}

// ---- order ----------------------------------------------------------------------------------------------------------

/** An order names every id of the group once (fields of a section, values of a list). */
export function orderProblems(all: readonly string[], sent: readonly string[]): Issue[] {
  const problems: Issue[] = []
  if (new Set(sent).size !== sent.length) problems.push({ path: 'ids', message: 'Each one once.' })
  const known = new Set(all)
  sent.forEach((id, index) => {
    if (!known.has(id)) problems.push({ path: `ids/${index}`, message: 'Not of this group.' })
  })
  if (sent.length !== all.length) problems.push({ path: 'ids', message: 'Name every one of the group, in the new order.' })
  return problems
}

/** Places 10, 20, 30 … in the order given. */
export const placesOf = (ids: readonly string[]): Map<string, number> => new Map(ids.map((id, index) => [id, (index + 1) * 10]))

/** The next place at the end of a group. */
export const nextPlace = (places: readonly number[]): number => Math.min(FIELD_LIMITS.sortOrder, places.length === 0 ? 10 : Math.max(...places) + 10)
