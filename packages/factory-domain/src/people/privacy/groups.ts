import type { Issue } from '../../core/errors'

/**
 * The minimum group size for people data (B-W2b-27; feature ANA-075 "any view of people's time or output hides groups
 * smaller than the minimum unless a per-person purpose is allowed"; Statuto dei Lavoratori art. 4; GDPR art. 5(1)(c)
 * minimisation; Owner answer W1 "worker names only inside one record, never as a filter, group or total").
 *
 *   minimum         the company's PeopleSettings.minimumGroupSize (3 or more: the database's floor; the design's default
 *                   3). A group (a team, a line, a shift, a day) with fewer people never shows its figures: the cell
 *                   says "Too few people to show without identifying them"; an unknown headcount counts as too few.
 *   no person key   a list, filter, group or total of people figures never splits or filters by a person
 *                   (`personKeyProblems`): one person's figures are read one record at a time, through the legal gate
 *                   and the figure rules (figures.ts), never as a row of a list.
 *   lowering it     shows smaller groups: a widening, so it asks for a fresh code (the API); raising never asks.
 */

/** The database's floor (PeopleSettings check) and the design's default. */
export const MINIMUM_GROUP_FLOOR = 3
export const DEFAULT_MINIMUM_GROUP = 3
/** A sane ceiling for the setting (a group of 50 already hides most teams). */
export const MINIMUM_GROUP_CEILING = 50

export const TOO_FEW_WORDS = 'Too few people to show without identifying them'

export function minimumGroupProblems(value: unknown, at = 'body/minimumGroupSize'): Issue[] {
  if (typeof value !== 'number' || !Number.isInteger(value)) return [{ path: at, message: 'Give the minimum group size as a whole number of people.' }]
  if (value < MINIMUM_GROUP_FLOOR) return [{ path: at, message: `A group of fewer than ${MINIMUM_GROUP_FLOOR} people is never shown: one person's figures would be easy to work out (Statuto dei Lavoratori art. 4).` }]
  if (value > MINIMUM_GROUP_CEILING) return [{ path: at, message: `Keep the minimum group size to ${MINIMUM_GROUP_CEILING} people at most.` }]
  return []
}

/** The minimum a company's settings give (the default while it has none; never below the floor). */
export const minimumGroupOf = (settings: { readonly minimumGroupSize: number } | null | undefined): number =>
  Math.max(MINIMUM_GROUP_FLOOR, settings?.minimumGroupSize ?? DEFAULT_MINIMUM_GROUP)

/** A group's figures may show: it has at least the minimum number of people (an unknown headcount never shows). */
export const groupShown = (people: number | null | undefined, minimum: number): boolean =>
  typeof people === 'number' && Number.isInteger(people) && people >= Math.max(MINIMUM_GROUP_FLOOR, minimum)

export type GroupChange = 'WIDEN' | 'NARROW' | 'NONE'

/** Lowering the minimum shows smaller groups (WIDEN, a step-up); raising it never asks. */
export const minimumGroupChangeOf = (from: number, to: number): GroupChange => (from === to ? 'NONE' : to < from ? 'WIDEN' : 'NARROW')

/** A group row of people figures: its headcount and its figures (by key). */
export interface GroupRow {
  readonly people: number | null | undefined
  readonly figures: Readonly<Record<string, unknown>>
}

export interface MaskedGroupRow<Row extends GroupRow> {
  readonly row: Row
  /** true: the group is under the minimum; its figures were emptied and the words say why. */
  readonly tooFew: boolean
  readonly words: string | null
}

/**
 * Empties the figures of every group under the minimum (ANA-075), before anything leaves the API. The headcount of a
 * hidden group is emptied too: "2 people, 140 pieces" would tell. Counts how many groups were hidden.
 */
export function maskSmallGroups<Row extends GroupRow>(rows: readonly Row[], minimum: number): { readonly rows: MaskedGroupRow<Row>[]; readonly hidden: number } {
  let hidden = 0
  const out = rows.map((row) => {
    if (groupShown(row.people, minimum)) return { row, tooFew: false, words: null }
    hidden += 1
    const emptied = { ...row, people: null, figures: Object.fromEntries(Object.keys(row.figures).map((key) => [key, null])) }
    return { row: emptied as Row, tooFew: true, words: TOO_FEW_WORDS }
  })
  return { rows: out, hidden }
}

/**
 * The keys that name ONE person: a list, filter, group or total of people figures never uses them (Owner answer W1;
 * MES-249 "boards show line totals"). A person's own record opens through the figure rules instead.
 */
export const PERSON_KEYS: readonly string[] = Object.freeze(['employeeId', 'workerId', 'userId', 'personId', 'operatorId', 'createdById', 'actorId'])

/** Refuses a person key in the group-by, the filters or the sort of a people figures read. */
export function personKeyProblems(input: { readonly groupBy?: readonly string[]; readonly filters?: readonly string[]; readonly sort?: readonly string[] }): Issue[] {
  const problems: Issue[] = []
  for (const [part, keys] of [['groupBy', input.groupBy], ['filters', input.filters], ['sort', input.sort]] as const) {
    for (const key of keys ?? []) {
      if (PERSON_KEYS.includes(key)) {
        problems.push({ path: `query/${part}/${key}`, message: "People figures are shown per line, team or shift, never per person: one person's figures open one record at a time, where the site's legal gate and your role allow it." })
      }
    }
  }
  return problems
}
