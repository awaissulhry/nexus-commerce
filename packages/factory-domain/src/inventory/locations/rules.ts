import type { Issue } from '../../core/errors'

/**
 * The locations of a site (SCM-176, SCM-177, SCM-178; A2 SCR-065), pure: a tree inside the site (warehouse → zone →
 * bin, the goods-in dock, the quarantine shelf, a line-side rack), each with a short code unique on the site, printed on
 * the bin label and scanned. A location is archived, never deleted, and only once it is empty (every stock key's
 * balance there is 0) and has no active location inside it; an archived location takes no stock and nothing is put
 * inside it. The …_supply_guards trigger holds the same (and refuses a parent that would make a cycle).
 */

// W2a wave 3 (factory-db inventory.prisma): SUBCONTRACTOR, our stock at an outside workshop; the location names its party.
// W2a wave 5: FINISHED_GOODS, finished garments ready to ship (a production receipt puts them there or inside one).
export const LOCATION_KINDS = ['WAREHOUSE', 'ZONE', 'BIN', 'RECEIVING', 'QUARANTINE', 'PRODUCTION', 'SHIPPING', 'SUBCONTRACTOR', 'FINISHED_GOODS'] as const
export type LocationKind = (typeof LOCATION_KINDS)[number]

export const LOCATION_STATUSES = ['ACTIVE', 'ARCHIVED'] as const
export type LocationStatus = (typeof LOCATION_STATUSES)[number]

/** A code as scanned and printed: upper-case letters, digits, dot, dash, underscore; 1 to 40, starting with a letter or digit. */
export const LOCATION_CODE = /^[A-Z0-9][A-Z0-9._-]{0,39}$/

/** A typed code as stored: trimmed, upper case. */
export const normalizeLocationCode = (code: string): string => code.trim().toUpperCase()

/** The problems of a location's fields (paths `code`, `name`). */
export function locationProblems(fields: { readonly code?: string; readonly name?: string }): Issue[] {
  const problems: Issue[] = []
  if (fields.code !== undefined && !LOCATION_CODE.test(fields.code)) {
    problems.push({ path: 'code', message: 'Expected 1 to 40 upper-case letters, digits, dots, dashes or underscores (a bin label code).' })
  }
  if (fields.name !== undefined && (fields.name.trim().length < 1 || fields.name.trim().length > 120)) {
    problems.push({ path: 'name', message: 'Expected 1 to 120 characters.' })
  }
  return problems
}

/** A location as the tree reads it. */
export interface TreeLocation {
  readonly id: string
  readonly parentId: string | null
  readonly code: string
}

/** True when putting `locationId` inside `parentId` would make it sit inside itself. */
export function wouldCycle(locationId: string, parentId: string | null, locations: readonly TreeLocation[]): boolean {
  if (parentId === null) return false
  const parentOf = new Map(locations.map((location) => [location.id, location.parentId]))
  const seen = new Set<string>()
  let current: string | null | undefined = parentId
  while (current) {
    if (current === locationId) return true
    if (seen.has(current)) return true
    seen.add(current)
    current = parentOf.get(current)
  }
  return false
}

/** A location placed in its tree: its depth (0 at the top) and its path of codes from the top. */
export type Placed<Location extends TreeLocation> = Location & { readonly depth: number; readonly path: readonly string[] }

/**
 * The locations of one site in tree order (depth first, children by code), each with its depth and path. A location
 * whose parent is not in the list sits at the top.
 */
export function locationTree<Location extends TreeLocation>(locations: readonly Location[]): Placed<Location>[] {
  const ids = new Set(locations.map((location) => location.id))
  const children = new Map<string | null, Location[]>()
  for (const location of locations) {
    const parent = location.parentId !== null && ids.has(location.parentId) ? location.parentId : null
    children.set(parent, [...(children.get(parent) ?? []), location])
  }
  for (const list of children.values()) list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const placed: Placed<Location>[] = []
  const visit = (parent: string | null, depth: number, path: readonly string[]) => {
    for (const location of children.get(parent) ?? []) {
      const own = [...path, location.code]
      placed.push({ ...location, depth, path: own })
      if (depth < 64) visit(location.id, depth + 1, own)
    }
  }
  visit(null, 0, [])
  return placed
}

/** Why a location cannot be archived now, or []. */
export function archiveProblems(facts: { readonly status: LocationStatus; readonly holdsStock: boolean; readonly activeChildren: number }): string[] {
  const problems: string[] = []
  if (facts.status === 'ARCHIVED') problems.push('The location is archived already.')
  if (facts.holdsStock) problems.push('The location still holds stock; move it out (or adjust it) before archiving the location.')
  if (facts.activeChildren > 0) problems.push(`${facts.activeChildren} active location(s) sit inside it; archive or move them first.`)
  return problems
}
