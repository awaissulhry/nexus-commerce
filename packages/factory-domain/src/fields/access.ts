import { heldGrains, isGrain, type Grain } from '../auth/grains/grains'
import { can, holds, type Actor, type Permission } from '../core/permissions'
import { FIELD_CODE, type FieldFacts } from './rules'
import { FIELDS_PERSONAL_VIEW } from './permissions'

/**
 * Who sees a custom field (B-W2b-421; PLT-111; Owner rule: a custom field never holds money or a figure about a single
 * person unless its grain says so and the reader holds that grain; a partner or floor audience sees a field only when its
 * audience says so). One answer for every reader — the record form, the grid, a filter, an export, an import:
 *
 *   office    INTERNAL always; MONEY with the field's grain (money.<grain>); PERSONAL with fields.personal.view
 *   partner   only a field shown in the portal: INTERNAL, or a price with the price grain (a partner holds at most price)
 *   system    every field (the worker writes and reads for the people it acts for)
 *   floor, link, platform   none (no custom field reaches a tablet or a one-off link)
 *
 * The record itself is checked apart (its own view permission over its company, site and party).
 */
export function fieldSeenBy(actor: Actor, field: Pick<FieldFacts, 'audience' | 'grain' | 'shownInPortal'>): boolean {
  const grainHeld = (grain: Grain | null) => grain !== null && heldGrains(actor).has(grain)
  switch (actor.audience) {
    case 'system':
      return true
    case 'office':
      if (field.audience === 'INTERNAL') return true
      if (field.audience === 'MONEY') return grainHeld(field.grain)
      return holds(actor, FIELDS_PERSONAL_VIEW)
    case 'partner':
      if (!field.shownInPortal) return false
      return field.audience === 'INTERNAL' || (field.audience === 'MONEY' && field.grain === 'price' && grainHeld('price'))
    default:
      return false
  }
}

/**
 * A custom field's column id in a list frame and an export (`cf:<code>`; a money one `cf:<grain>:<code>`): the grain
 * travels in the id, so the export engine leaves a money column out — and says so in the file — for a person without
 * the grain, exactly as it does a built-in money column.
 */
export const columnIdOf = (field: Pick<FieldFacts, 'code' | 'audience' | 'grain'>): string => (field.audience === 'MONEY' && field.grain ? `cf:${field.grain}:${field.code}` : `cf:${field.code}`)

/** A column id back: the field's code and, for a money one, its grain; null when it is not a custom field's id. */
export function columnOf(id: string): { readonly code: string; readonly grain: Grain | null } | null {
  const parts = id.split(':')
  if (parts[0] !== 'cf') return null
  if (parts.length === 2 && FIELD_CODE.test(parts[1]!)) return { code: parts[1]!, grain: null }
  if (parts.length === 3 && isGrain(parts[1]) && FIELD_CODE.test(parts[2]!)) return { code: parts[2]!, grain: parts[1] }
  return null
}

/** The grain a column id names (the export engine strips by it), or undefined for a field that carries no money. */
export const grainOfColumn = (id: string): Grain | undefined => columnOf(id)?.grain ?? undefined

// ---- B-TH-056 (threads plan TH-4, WALL-G08 / SHEET-G06; surface W17, wall T17): a field for ONE customer ---------------------
/**
 * A custom field may be for one customer (CustomField.partyId, schema wave 7/9; null: every customer). Such a field:
 *
 *   - is on that customer's records only (its orders, quotes, the customer itself): never on another customer's, never on a
 *     record of no customer (`fieldOnRecord`);
 *   - is seen only by who reaches that customer (`fieldPartySeenBy`): the customer's own portal people; an office person whose
 *     roles reach the customer for the record type's view permission (a sales rep limited to customer A never sees customer B's
 *     fields, not even their names); the system;
 *   - is made only on a record type whose records name their customer (CUSTOMER_FIELD_RECORD_KEYS), and its customer never
 *     changes (the database's …_config_brand_fields_th_guards hold the same).
 * A field for every customer that the portal shows puts its NAME in every customer's portal: the admin preview says so
 * (`portalNoticeOf`, EVERY_CUSTOMER_NOTICE), so no customer's name or code reaches the others through a label.
 */

/** The record types (platform/fields records.ts keys) a field for one customer may be added to. */
export const CUSTOMER_FIELD_RECORD_KEYS = ['CUSTOMER', 'QUOTE', 'ORDER'] as const

/** May this reader see a field because of its customer (every customer's: yes)? `view` is the record type's view permission. */
export function fieldPartySeenBy(actor: Actor, field: { readonly partyId: string | null; readonly companyId: string | null }, view: Permission): boolean {
  if (field.partyId === null) return true
  switch (actor.audience) {
    case 'system':
      return true
    case 'office':
      return can(actor, view, { ...(field.companyId ? { companyId: field.companyId } : {}), partyId: field.partyId })
    case 'partner':
      return actor.partyId === field.partyId
    default:
      return false
  }
}

/** Is a field on a record of this customer (null: a record of no customer)? A field for every customer is on every record. */
export const fieldOnRecord = (field: { readonly partyId: string | null }, recordPartyId: string | null): boolean => field.partyId === null || field.partyId === recordPartyId

/** The admin's line for a field shown in the portal to every customer. */
export const EVERY_CUSTOMER_NOTICE: Readonly<{ it: string; en: string }> = Object.freeze({
  it: 'Ogni cliente vedrà il nome di questa colonna nel suo portale.',
  en: 'Every customer will see this column name in its portal.',
})

/** EVERY_CUSTOMER when a field for every customer is shown in the portal (its name reaches every customer); else null. */
export function portalNoticeOf(field: { readonly partyId: string | null; readonly shownInPortal: boolean }): 'EVERY_CUSTOMER' | null {
  return field.shownInPortal && field.partyId === null ? 'EVERY_CUSTOMER' : null
}

/** The values a picklist shows a customer: only the ones its record uses (the whole list may name other customers). */
export function optionsInUse<Option extends { readonly code: string }>(options: readonly Option[], used: ReadonlySet<string>): Option[] {
  return options.filter((option) => used.has(option.code))
}

/** The option codes a stored value uses (a select's code, a multi-select's codes; anything else none). */
export function codesOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === 'string')
  return []
}
// ---- end B-TH-056
