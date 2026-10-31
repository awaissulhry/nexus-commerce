/**
 * FloorNamePicker's rules (B-W2b-28, design part FloorNamePicker): sign in without a badge, forgot-badge clocking,
 * training sign-off — name tiles with initials, a letter strip to jump, recent people first, no keyboard.
 *
 * - **Recent first**: the people who worked on this tablet lately (`recentIds`, in that order) come first, then
 *   everyone A–Z (a recent person is in both: someone looking under their letter still finds themselves).
 * - **A–Z**: sorted by `sortName` (or the name) with the page language's collation, accents and case ignored. The
 *   letter is the first letter without its accent ("Élodie" → E); a name in another script keeps its own first letter;
 *   anything else is "#".
 * - **The strip** shows every letter A–Z, plus any other letter a name starts with; a letter with no names is held
 *   (it says so), never hidden — the strip never moves under a finger.
 * - **Arrows** move between tiles: ← → to the previous / next, ↑ ↓ to the nearest tile in the row above / below
 *   (rows read from where the tiles are drawn), Home / End to the first / last.
 */

export interface FloorPerson {
  id: string
  /** As shown on the tile ("Maria Rossi"). */
  name: string
  /** Sorted and lettered by this when set ("Rossi Maria"). */
  sortName?: string
  /** Default: the first letters of the first and last word of `name`. */
  initials?: string
  /** A second line (team, station). Never a figure about the person. */
  detail?: string
  /** Why this person cannot be picked here. Set: held (focusable, says why, inert). */
  heldReason?: string | null
}

export const LATIN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')

/** The letter a name is filed under. */
export function nameLetter(name: string): string {
  const first = Array.from(name.trim().normalize('NFKD').replace(/\p{M}+/gu, ''))[0]
  if (!first) return '#'
  const upper = first.toLocaleUpperCase()
  return /\p{L}/u.test(upper) ? upper : '#'
}

export interface NameGroups {
  recent: FloorPerson[]
  letters: { letter: string; people: FloorPerson[] }[]
}

/** The recent group (in `recentIds` order, only people in the list) and every person by letter, A–Z. */
export function nameGroups(people: readonly FloorPerson[], recentIds: readonly string[] = [], locale = 'en'): NameGroups {
  const byId = new Map(people.map((p) => [p.id, p]))
  const seen = new Set<string>()
  const recent: FloorPerson[] = []
  for (const id of recentIds) {
    const p = byId.get(id)
    if (p && !seen.has(id)) {
      seen.add(id)
      recent.push(p)
    }
  }
  const collator = new Intl.Collator(locale, { sensitivity: 'base', numeric: true })
  const key = (p: FloorPerson) => p.sortName ?? p.name
  const sorted = [...people].sort((a, b) => collator.compare(key(a), key(b)) || a.id.localeCompare(b.id))
  const letters: NameGroups['letters'] = []
  for (const p of sorted) {
    const letter = nameLetter(key(p))
    const last = letters[letters.length - 1]
    if (last && last.letter === letter) last.people.push(p)
    else {
      const found = letters.find((g) => g.letter === letter)
      if (found) found.people.push(p)
      else letters.push({ letter, people: [p] })
    }
  }
  // Latin letters first in A–Z order, then other scripts, then '#'.
  const rank = (l: string) => (l === '#' ? 2 : LATIN_LETTERS.includes(l) ? 0 : 1)
  letters.sort((a, b) => rank(a.letter) - rank(b.letter) || collator.compare(a.letter, b.letter))
  return { recent, letters }
}

/** The strip: A–Z always, plus any other letter a name starts with, each with how many names it has. */
export function letterStrip(groups: NameGroups): { letter: string; count: number }[] {
  const count = new Map(groups.letters.map((g) => [g.letter, g.people.length]))
  const extra = groups.letters.map((g) => g.letter).filter((l) => !LATIN_LETTERS.includes(l))
  return [...LATIN_LETTERS, ...extra].map((letter) => ({ letter, count: count.get(letter) ?? 0 }))
}

export type GridKey = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown' | 'Home' | 'End'

export const isGridKey = (key: string): key is GridKey =>
  key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'

export interface TileRect {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The tile an arrow moves to, from where the tiles are drawn (in DOM order). Rows are tiles whose tops are within 4 px.
 * ↑ ↓ go to the tile in the row above / below whose centre is nearest; at the first / last row focus stays.
 */
export function gridMove(rects: readonly TileRect[], index: number, key: GridKey): number {
  const n = rects.length
  if (n === 0) return -1
  const at = Math.min(Math.max(index, 0), n - 1)
  if (key === 'Home') return 0
  if (key === 'End') return n - 1
  if (key === 'ArrowLeft') return Math.max(0, at - 1)
  if (key === 'ArrowRight') return Math.min(n - 1, at + 1)
  const tops: number[] = []
  for (const r of rects) if (!tops.some((t) => Math.abs(t - r.top) <= 4)) tops.push(r.top)
  tops.sort((a, b) => a - b)
  const rowOf = (r: TileRect) => tops.findIndex((t) => Math.abs(t - r.top) <= 4)
  const row = rowOf(rects[at])
  const target = key === 'ArrowUp' ? row - 1 : row + 1
  if (target < 0 || target >= tops.length) return at
  const centre = rects[at].left + rects[at].width / 2
  let best = at
  let bestDistance = Infinity
  rects.forEach((r, i) => {
    if (rowOf(r) !== target) return
    const d = Math.abs(r.left + r.width / 2 - centre)
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  })
  return best
}
