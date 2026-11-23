import type { ColDef } from '@nexus/ui/grid'

/**
 * F-CQ-104 (customer page › Quotes & incoming, 10-design §4.1, §5; settle C15): a list's columns by ITS OWN room — the width the
 * host measured on its root (a ResizeObserver), never the window. A tier ADDS columns, never stretches them; the chips cell takes the
 * rest. Pure: both lists of the tab read it (the Quotes list and the Incoming list), only on a host that hands them a room.
 *
 *   tier  list room      what it adds (each list names its own columns)
 *   S     < 720          ONE card (the list frame's cards on a phone)
 *   M−    720–839        the base row; the date folds under the chips (today's 40 % dock: 779)
 *   M     840–1199       + the date column (the dock a third at 1440: 863; 1920 with the dock: 1185)
 *   L     1200–1599      + the list's wider facts (1440 without the dock: 1314)
 *   XL    ≥ 1600         + the widest facts (1920 without the dock: 1794)
 */
export const ROOM_TIERS = ['S', 'M-', 'M', 'L', 'XL'] as const
export type RoomTier = (typeof ROOM_TIERS)[number]

/** Where each tier starts, in CSS pixels of the list's own room. */
export const ROOM_EDGES = Object.freeze({ 'M-': 720, M: 840, L: 1200, XL: 1600 } as const)

/** The tier of a measured room; null while nothing is measured (the host draws its default, M). */
export function roomTier(room: number | null | undefined): RoomTier | null {
  if (room === null || room === undefined || !Number.isFinite(room) || room <= 0) return null
  if (room < ROOM_EDGES['M-']) return 'S'
  if (room < ROOM_EDGES.M) return 'M-'
  if (room < ROOM_EDGES.L) return 'M'
  if (room < ROOM_EDGES.XL) return 'L'
  return 'XL'
}

/** The tier a host draws: the measured one, else M (the dock a third: the room the tab has at 1440). */
export const hostTier = (room: number | null | undefined): RoomTier => roomTier(room) ?? 'M'

/** The tier reaches `wanted` (or more). */
export const reaches = (tier: RoomTier, wanted: RoomTier): boolean => ROOM_TIERS.indexOf(tier) >= ROOM_TIERS.indexOf(wanted)

/** Under 840 px of list room the date folds under the chips (M− and the card). */
export const datesFold = (tier: RoomTier): boolean => !reaches(tier, 'M')

/**
 * A column the room leaves out: hidden, and in Customise an opt-in choice (ColDef `context.optIn`, the list tools' rule) named
 * "… (from a wider list)" — so "In view · N of M" counts only what the list really shows (P0-B5) and a person may still show it.
 * A column the room shows is returned as it is.
 */
export function byRoom<T>(column: ColDef<T>, shown: boolean, toolLabel: string | null = null): ColDef<T> {
  // cq fx2 W-02: a shown column says so (`hide: false`) — without it the grid kept the hidden state it had when the room grew live
  // (the dock closed: Valid until, Updated, Pieces stayed away) and Customise counted columns it did not draw. The layout still hides
  // a column Customise hid (applyLayout, after this).
  if (shown) return { ...column, hide: false }
  const context = (column.context as Record<string, unknown> | undefined) ?? {}
  return { ...column, hide: true, context: { ...context, optIn: true, ...(toolLabel ? { toolLabel } : {}) } }
}
