import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Metric } from '@nexus/ui/components'

/**
 * F-CQ-B (band consistency, Owner 2026-11-23; band/plan.md B1–B11) — the customer page's band, pure: what each tab hands the ONE
 * band part (CustomerBand.tsx) and how its groups become the design system's own tiles. The Work tab and Quotes & incoming draw
 * their groups with the SAME parts as Sales › Orders (`MetricStrip size="sm"` filter tiles, `FilterChip`s): same doors, same
 * counts, same words; only the look is shared. No React here, so Node tests hold it.
 */

/** One group of the band: a tile (live) or a quiet chip (closed), its count a door. */
export interface BandTile {
  /** The host's own id (a phase, a group): handed back on a press. */
  readonly id: string
  /** The group's words. */
  readonly label: string
  /** The count (null: not read — the value says "—"). */
  readonly count: number | null
  /** The number as drawn: the host's own node (it carries the host's pin class, e.g. `fw-cwb-num`). */
  readonly value: ReactNode
  /** The tip, said in words (today's tip). */
  readonly title?: string
  /** What the group holds (the groups' window says it under the group's words). */
  readonly note?: string
  /** The window row's mark (Work's phase marks); never drawn in a tile. */
  readonly icon?: LucideIcon
  /** A door: a press shows its records (pressed again: everything). Without one: a plain count, no focus stop. */
  readonly door: boolean
  /** The door the page shows now. */
  readonly pressed: boolean
  /** It waits on us: the tile's status dot (the warning token) when > 0, the words in its tip — never colour alone (B5). */
  readonly ours?: boolean
}

/** One fact of the chips row (Work's "What waits"): a `FilterChip` with its count. */
export interface BandChipItem {
  readonly id: string
  readonly label: string
  /** Its number ("—" while read). */
  readonly count: ReactNode
  /** The tip (the fact's group, e.g. "Waiting on us"). */
  readonly title?: string
  /** A toggle (a view of the list): pressed or not. Absent: not a toggle. */
  readonly pressed?: boolean
  /** Its press opens a window. */
  readonly dialog?: boolean
  /** Its read failed: these words (its tip and its name); it wears "!" and its press reads it again. */
  readonly failed?: string
  /** A thin rule before it: the first of its group (after the first group). */
  readonly rule?: boolean
  /** Its press; absent: a plain fact (no focus stop). */
  readonly onPress?: () => void
}

/** The phone: below this room (px, the band's OWN width — a container query, never the window) the groups fold into one button. */
export const BAND_FOLD_BELOW = 720

/** "Waits on us": the design system's warning token on the tile's status dot. */
export const OURS_ACCENT = 'var(--nds-warning)'

/** The groups as the design system's tiles: a door is a filter tile (a button, `aria-pressed`), a count without one a plain tile. */
export function metricsOf(tiles: readonly BandTile[], onPick?: (id: string) => void): Metric[] {
  return tiles.map((tile): Metric => {
    const base = {
      label: tile.label,
      value: tile.value,
      ...(tile.title ? { title: tile.title } : {}),
      ...(tile.ours && (tile.count ?? 0) > 0 ? { accent: OURS_ACCENT } : {}),
    }
    return tile.door ? { ...base, onClick: () => onPick?.(tile.id), active: tile.pressed } : base
  })
}

/** What the phone's ONE button says: the group shown (its words and number), else everything with its number. */
export interface BandFold {
  /** The group shown; null: everything. */
  readonly id: string | null
  readonly label: string
  readonly value: ReactNode
}

export function foldOf(tiles: readonly BandTile[], everything: { readonly label: string; readonly value: ReactNode }): BandFold {
  const shown = tiles.find((tile) => tile.pressed) ?? null
  return shown ? { id: shown.id, label: shown.label, value: shown.value } : { id: null, label: everything.label, value: everything.value }
}
