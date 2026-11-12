import type { Issue } from '../../core/errors'
import type { LocationKind } from '../locations/rules'
import { DEFAULT_PURPOSES, kindWords, LOCATION_KIND_PROFILES, mayHold, type DefaultPurpose, type HeldItemKind } from './kinds'

/**
 * Default locations (B-W2b-289; SCM-179; design warehouse.settings › Default locations: "a small table: material type ×
 * purpose → location"), pure. A site names, per kind of material and purpose (receiving, quality, issue, return,
 * put-away), the place a command uses when the person names none; a row without a kind is the site's fallback for every
 * kind that has no row of its own. One active row per site, kind and purpose (the database's partial unique indexes); a
 * changed default keeps the earlier one inactive.
 *
 * Which place a command takes (`resolveDefault`): the kind's own default when every kind it moves has the same one; else
 * the fallback, when it may hold every one of those kinds; else none (the command's own rule from before W2b applies:
 * the site's one goods-in dock, its one quarantine place, the place named). The commands that read it: receiving (the
 * receipt's place), a hold's move to quarantine and a customer return's quarantine (quality), an issue (the default
 * place is taken from first), a return from a work order (its place when none is named); put-away is B-W2b-292's
 * suggestion.
 */

export { DEFAULT_PURPOSES, type DefaultPurpose }

/** One default as the resolver reads it. */
export interface DefaultRow {
  readonly itemKind: HeldItemKind | null
  readonly locationId: string
  readonly location: { readonly code: string; readonly kind: LocationKind; readonly status: string }
}

/** The place of a purpose for these kinds of material, or null (see above). Empty kinds: the fallback only. */
export function resolveDefault(rows: readonly DefaultRow[], itemKinds: readonly HeldItemKind[]): DefaultRow | null {
  const usable = rows.filter((row) => row.location.status === 'ACTIVE')
  const kinds = [...new Set(itemKinds)]
  if (kinds.length > 0) {
    const own = kinds.map((kind) => usable.find((row) => row.itemKind === kind) ?? null)
    if (own.every((row) => row !== null) && new Set(own.map((row) => row!.locationId)).size === 1) return own[0]!
  }
  const fallback = usable.find((row) => row.itemKind === null) ?? null
  if (fallback && kinds.every((kind) => mayHold(fallback.location.kind, kind))) return fallback
  return null
}

/**
 * Why this place cannot be the default (path `locationId`): an active place of the site, of a kind that serves the
 * purpose (a quality place for quality, a line-side or store place for an issue …), and that holds the kind of material
 * (finished garments only where they may lie). A fallback may be any place that serves the purpose: the resolver skips
 * it for a kind it does not hold.
 */
export function defaultProblems(purpose: DefaultPurpose, itemKind: HeldItemKind | null, place: { readonly code: string; readonly kind: LocationKind; readonly status: string; readonly siteId: string } | null, siteId: string): Issue[] {
  if (!place || place.siteId !== siteId) return [{ path: 'locationId', message: 'Not a location of this site.' }]
  if (place.status !== 'ACTIVE') return [{ path: 'locationId', message: `Location ${place.code} is archived.` }]
  const profile = LOCATION_KIND_PROFILES[place.kind]
  if (!profile.purposes.includes(purpose)) {
    const fits = (Object.keys(LOCATION_KIND_PROFILES) as LocationKind[]).filter((kind) => LOCATION_KIND_PROFILES[kind].purposes.includes(purpose)).map(kindWords)
    return [{ path: 'locationId', message: `Location ${place.code} is a ${kindWords(place.kind)}; a ${PURPOSE_WORDS[purpose]} default is a ${fits.join(', ')}.` }]
  }
  if (itemKind !== null && !mayHold(place.kind, itemKind)) return [{ path: 'locationId', message: `Location ${place.code} is a ${kindWords(place.kind)}: it does not hold ${itemKind === 'FINISHED' ? 'finished garments' : 'materials'}.` }]
  return []
}

const PURPOSE_WORDS: Readonly<Record<DefaultPurpose, string>> = Object.freeze({ RECEIVING: 'receiving', QUALITY: 'quality', ISSUE: 'issue', RETURN: 'return', PUT_AWAY: 'put-away' })
export const purposeWords = (purpose: DefaultPurpose): string => PURPOSE_WORDS[purpose]
