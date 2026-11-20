import type { OrderProduction, People } from './api'
import type { ProductionState } from './model'

/**
 * F-OO-100 (order overview lane: one file per section) — People, its rules moved out of model.ts unchanged (F-SA-233: places
 * only, never an operator; Statuto art. 4).
 */

/** Where the order is made, as places only (a site · a line · a team by name, or an outside workshop) — never an operator. */
export function placeWords(place: NonNullable<OrderProduction['people']>['places'][number]): string {
  if (place.workshop) return place.workshop.name
  return [place.site?.name ?? place.site?.code, place.line?.name ?? place.line?.code, place.team?.name ?? place.team?.code].filter((part): part is string => !!part).join(' · ')
}

// ---- F-OO-131 (order overview lane; 10-design §3): People as one aligned list — what the card draws from the read --------------
/**
 * The People card's state: still read; the read failed (only this card says so, with Try again — never an empty card); the people
 * part withheld (no workorders.view: the card's one sentence and its Followers head); or read. The API sends `people: null` only for
 * a part it did not keep for this reader (production-read.ts), so null is said as withheld too — never "Not set" for a fact not read.
 */
export type PeopleView =
  | { readonly status: 'loading' }
  | { readonly status: 'failed'; readonly problem: string }
  | { readonly status: 'withheld' }
  | { readonly status: 'ready'; readonly people: People }

export function peopleViewOf(state: ProductionState | null | undefined): PeopleView {
  if (!state || state.status === 'loading') return { status: 'loading' }
  if (state.status === 'failed') return { status: 'failed', problem: state.problem }
  const people = state.read.people ?? null
  if (!people || state.read.withheld.includes('people')) return { status: 'withheld' }
  return { status: 'ready', people }
}
// ---- end F-OO-131
