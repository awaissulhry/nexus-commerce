import { heldGrains, isGrain, type Grain } from '../auth/grains/grains'
import { holds, type Actor } from '../core/permissions'
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
