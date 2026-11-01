import { maskSmallGroups, TOO_FEW_WORDS } from '../privacy/groups'

/**
 * Who is in now (B-W2b-33's clock events; B-W2b-37; MES-233; design people.attendance "Who is in now": counts per area
 * and line, last update time; the roll call new tab), pure. A person is in when their latest counted clock event at the
 * site leaves them in (in, or on a break: still in the building) and the clock-in is younger than 13 hours. Their line:
 * a running loan's line, else their home line, else the line of the tablet they clocked in on; their area: the line's.
 *
 * Counts per site, area and line are group figures: a group under the company's minimum size shows no count (ANA-075;
 * Statuto dei Lavoratori art. 4): "Too few people to show without identifying them". The names are the roll call's,
 * opened on purpose (an evacuation, D.Lgs. 81/2008 art. 43) and recorded.
 */

export interface PersonIn {
  readonly employeeId: string
  readonly lineId: string | null
  readonly areaId: string | null
  readonly onBreak: boolean
}

export interface PlaceNames {
  readonly lines: ReadonlyMap<string, { readonly code: string; readonly name: string; readonly areaId: string | null }>
  readonly areas: ReadonlyMap<string, { readonly code: string; readonly name: string }>
}

export interface PresenceLine {
  readonly lineId: string | null
  readonly code: string | null
  readonly name: string | null
  /** People in now (null: too few to show). */
  readonly people: number | null
  readonly tooFew: boolean
}

export interface PresenceArea {
  readonly areaId: string | null
  readonly code: string | null
  readonly name: string | null
  readonly people: number | null
  readonly tooFew: boolean
  readonly lines: PresenceLine[]
}

export interface Presence {
  readonly people: number | null
  readonly tooFew: boolean
  readonly areas: PresenceArea[]
  /** How many groups were hidden (under the minimum). */
  readonly hidden: number
  readonly words: string | null
}

/** The counts per site, area and line, every group under the minimum emptied (sorted by area, then line code). */
export function presenceOf(people: readonly PersonIn[], names: PlaceNames, minimum: number): Presence {
  const byArea = new Map<string, Map<string, number>>()
  for (const person of people) {
    const areaKey = person.areaId ?? ''
    const lineKey = person.lineId ?? ''
    const lines = byArea.get(areaKey) ?? new Map<string, number>()
    lines.set(lineKey, (lines.get(lineKey) ?? 0) + 1)
    byArea.set(areaKey, lines)
  }
  let hidden = 0
  const mask = (count: number): { people: number | null; tooFew: boolean } => {
    const { rows, hidden: count0 } = maskSmallGroups([{ people: count, figures: {} }], minimum)
    hidden += count0
    return { people: rows[0]!.row.people ?? null, tooFew: rows[0]!.tooFew }
  }
  const areaOrder = (key: string) => (key === '' ? '~' : (names.areas.get(key)?.code ?? key))
  const areas = [...byArea.entries()]
    .sort((a, b) => areaOrder(a[0]).localeCompare(areaOrder(b[0])))
    .map(([areaKey, lines]) => {
      const area = areaKey ? names.areas.get(areaKey) : undefined
      const sum = [...lines.values()].reduce((a, b) => a + b, 0)
      const lineOrder = (key: string) => (key === '' ? '~' : (names.lines.get(key)?.code ?? key))
      return {
        areaId: areaKey || null,
        code: area?.code ?? null,
        name: area?.name ?? null,
        ...mask(sum),
        lines: [...lines.entries()]
          .sort((a, b) => lineOrder(a[0]).localeCompare(lineOrder(b[0])))
          .map(([lineKey, count]) => {
            const line = lineKey ? names.lines.get(lineKey) : undefined
            return { lineId: lineKey || null, code: line?.code ?? null, name: line?.name ?? null, ...mask(count) }
          }),
      }
    })
  const site = mask(people.length)
  return { ...site, areas, hidden, words: hidden > 0 ? TOO_FEW_WORDS : null }
}

export const ROLL_CALL_WORDS =
  'The roll call lists the people clocked in now, for an evacuation (D.Lgs. 81/2008 art. 43). This opening is recorded; print it or keep it on a phone only while it is needed.'
