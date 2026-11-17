import type { ReactNode } from 'react'

/**
 * B-TH-241 (threads plan TH-4, SHEET-G08; features SHEET.overall-F02 group by customer, -F03 totals per group and a grand total,
 * -F11 totals open their rows): the group rows of the ONE list frame, pure. A list that asks (`ListFrame.groups`) gets one header
 * row per group — its name and its figures, both the LIST's (the server's totals for the whole group, never summed here from the
 * rows the screen has loaded) — its rows under it, a "Show more of …" row while the group has more to read, a reading or failed
 * row while its rows are read, and a grand total pinned under the grid. A list that asks nothing draws exactly as before.
 */

export interface ListGroup {
  /** The group's key: the value `keyOf` gives its rows. */
  readonly key: string
  /** The group's name in words (the toggle says "Show / Hide <name>"). */
  readonly name: string
  /** The header's name as drawn (a link to the group's own list: its door). */
  readonly label: ReactNode
  /** The header's figures for the whole group, from the server (each a door); null while they are read ("—"). */
  readonly summary: ReactNode | null
  /** Its rows are being read, or the read failed (with its retry). */
  readonly state?: { readonly kind: 'reading' } | { readonly kind: 'failed'; readonly words: string; readonly onRetry: () => void } | null
  /** More of the group's rows to read: the row "Show more of <name>". */
  readonly more?: { readonly label: string; readonly onMore: () => void } | null
}

export interface ListGroups<T> {
  /** The group of a row. */
  readonly keyOf: (row: T) => string
  /** The groups in their order (a group with no loaded row still has its header: its figures are the server's). */
  readonly groups: readonly ListGroup[]
  /** The keys folded shut. */
  readonly collapsed: readonly string[]
  readonly onToggle: (key: string) => void
  /** The grand total, pinned under the grid (the server's figures for the whole view; doors). */
  readonly total?: ReactNode | null
}

/** A row of the grid that is no row of the list: a group's header, its "Show more", its reading or failed line. */
export interface GroupMarker {
  readonly fwGroup: 'header' | 'more' | 'state'
  readonly key: string
}

export const isGroupMarker = (value: unknown): value is GroupMarker => typeof value === 'object' && value !== null && 'fwGroup' in value && typeof (value as { fwGroup: unknown }).fwGroup === 'string'

/** A marker's row id (never an id of the list's rows). */
export const markerId = (marker: GroupMarker): string => `fw-group:${marker.fwGroup}:${marker.key}`

/**
 * The grid's rows of a grouped list: each group's header, then — unless it is folded — its loaded rows in the list's order, then its
 * reading or failed line, else its "Show more" line. A loaded row of no group follows at the end (never hidden).
 */
export function groupedRows<T>(rows: readonly T[], groups: Pick<ListGroups<T>, 'keyOf' | 'groups' | 'collapsed'>): Array<T | GroupMarker> {
  const folded = new Set(groups.collapsed)
  const byKey = new Map<string, T[]>()
  for (const row of rows) {
    const key = groups.keyOf(row)
    const list = byKey.get(key)
    if (list) list.push(row)
    else byKey.set(key, [row])
  }
  const out: Array<T | GroupMarker> = []
  const known = new Set<string>()
  for (const group of groups.groups) {
    known.add(group.key)
    out.push({ fwGroup: 'header', key: group.key })
    if (folded.has(group.key)) continue
    out.push(...(byKey.get(group.key) ?? []))
    if (group.state) out.push({ fwGroup: 'state', key: group.key })
    else if (group.more) out.push({ fwGroup: 'more', key: group.key })
  }
  for (const [key, list] of byKey) if (!known.has(key)) out.push(...list)
  return out
}

/** Folded by default: every group when there are more than this many (SHEET.overall-F02 ">10 customers: collapsed by default"). */
export const OPEN_GROUPS_AT_MOST = 10

/** The groups folded when the list opens: none up to ten, else all. */
export const initiallyCollapsed = (keys: readonly string[]): string[] => (keys.length > OPEN_GROUPS_AT_MOST ? [...keys] : [])

/** One key in or out of the folded ones. */
export const toggleGroup = (collapsed: readonly string[], key: string): string[] => (collapsed.includes(key) ? collapsed.filter((entry) => entry !== key) : [...collapsed, key])
