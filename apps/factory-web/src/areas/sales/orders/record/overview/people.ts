import type { OrderProduction } from './api'

/**
 * F-OO-100 (order overview lane: one file per section) — People, its rules moved out of model.ts unchanged (F-SA-233: places
 * only, never an operator; Statuto art. 4).
 */

/** Where the order is made, as places only (a site · a line · a team by name, or an outside workshop) — never an operator. */
export function placeWords(place: NonNullable<OrderProduction['people']>['places'][number]): string {
  if (place.workshop) return place.workshop.name
  return [place.site?.name ?? place.site?.code, place.line?.name ?? place.line?.code, place.team?.name ?? place.team?.code].filter((part): part is string => !!part).join(' · ')
}
