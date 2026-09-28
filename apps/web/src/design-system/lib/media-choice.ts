/**
 * Media choices — the one shape behind every picker that shows a picture beside its words.
 *
 * Sheet pop-up editor rebuild (docs/sheet-popup-editor/PLAN-2026-09-27.md §4.1). The Owner asked for pop-ups that
 * work "exactly like the Shopify editor": a colour entry shows its swatch, an icon entry its icon, a product its
 * photo, and every list can be searched, ticked, ordered and cleared. The metaobject picker, the product picker,
 * the chip field and the variation-theme values all take this shape, so the rules below exist once.
 *
 * Pure logic, no React: the web's Vitest runs in Node without a DOM, so everything worth a test lives here.
 */
import { groupOptions } from './group-options'
import { searchOptions } from './option-search'

export interface MediaChoice {
  /** Stable identity — a Shopify gid, an option code, a product id. Never the label: labels repeat. */
  value: string
  /** What the row and the chip say. Search ranks against it. */
  label: string
  /** A second line: the handle, the entry type, a SKU. Searched too, never shown on a chip. */
  detail?: string
  /** A picture URL. Absent, empty or null ⇒ no picture slot at all (rule UI.5: no empty image boxes). */
  image?: string | null
  /** A `#RRGGBB` colour, drawn as a swatch when there is no picture. */
  swatch?: string | null
  /** Heading the row sits under. Groups render in first-seen order. */
  group?: string
  /** Cannot be picked, and says so through `heldReason` when it can. */
  disabled?: boolean
  /** Reachable and announced, never toggled — the reason is shown on the row. */
  heldReason?: string
}

export type MediaMarkKind = 'image' | 'swatch' | 'none'

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/** True for `#RGB` / `#RRGGBB`. Anything else is not drawn — a wrong colour is worse than none. */
export const isHexColour = (value: string | null | undefined): value is string => typeof value === 'string' && HEX.test(value.trim())

/** A picture wins over a swatch; neither ⇒ `none`, and the caller renders no slot. */
export function mediaMarkKind(choice: Pick<MediaChoice, 'image' | 'swatch'>): MediaMarkKind {
  if (typeof choice.image === 'string' && choice.image.trim()) return 'image'
  if (isHexColour(choice.swatch)) return 'swatch'
  return 'none'
}

/** Does ANY choice in the list carry a picture or swatch? A list with none renders no slot column at all. */
export const anyMedia = (choices: readonly Pick<MediaChoice, 'image' | 'swatch'>[]): boolean => choices.some(c => mediaMarkKind(c) !== 'none')

/**
 * Filter and rank for a LOCAL list (every entry is in memory). A remote list — a server search, 40 per page —
 * arrives already filtered and is shown as given; ranking it here would reorder a page the server paged.
 */
export function filterChoices<T extends MediaChoice>(query: string, choices: readonly T[]): T[] {
  return searchOptions(query, choices, c => (c.detail ? `${c.label} ${c.detail}` : c.label))
}

export interface ChoiceGroup<T> { name: string; choices: T[] }

/**
 * Group for rendering AND return the flat order the groups render in — the keyboard walks the flat list, so it must
 * be the order the eye sees (the same reason `groupOptions` returns both).
 */
export function groupChoices<T extends MediaChoice>(choices: readonly T[], groupOrder?: readonly string[]): { groups: ChoiceGroup<T>[]; flat: T[] } {
  const grouped = groupOptions(choices)
  if (!grouped) return { groups: [{ name: '', choices: choices.slice() }], flat: choices.slice() }
  let groups = grouped.groups.map(g => ({ name: g.name, choices: g.options }))
  /* A search ranks rows, and first-seen grouping would then let the best match drag its whole group to the top
     ("Default entries" above the store's own). `groupOrder` — the groups of the UNFILTERED list — pins them. */
  if (groupOrder) {
    const rank = (name: string) => { const i = groupOrder.indexOf(name); return i < 0 ? groupOrder.length : i }
    groups = groups.slice().sort((a, b) => rank(a.name) - rank(b.name))
  }
  return { groups, flat: groups.flatMap(g => g.choices) }
}

/** The groups of a list, in first-seen order — pass it to `groupChoices` when that list is shown filtered. */
export function groupOrderOf(choices: readonly Pick<MediaChoice, 'group'>[]): string[] {
  const order: string[] = []
  for (const c of choices) { const g = c.group ?? ''; if (!order.includes(g)) order.push(g) }
  return order
}

export type PickMode = 'multi' | 'single'

/**
 * Tick or untick one value.
 *
 * `multi`: a new pick goes to the END (the order the operator picked in is the order Shopify stores a list in);
 * a picked value comes out. `max` refuses a pick past the cap and returns the SAME array, so the caller can tell
 * nothing changed. `single`: the value replaces the pick; picking the current value again keeps it (Shopify's
 * "Change" list does the same — clearing is its own button).
 */
export function toggleChoice(selected: readonly string[], value: string, mode: PickMode, max?: number | null): readonly string[] {
  if (mode === 'single') return selected.length === 1 && selected[0] === value ? selected : [value]
  if (selected.includes(value)) return selected.filter(v => v !== value)
  if (max != null && selected.length >= max) return selected
  return [...selected, value]
}

/** Move one value; out-of-range or same-place moves return the SAME array (nothing to report). */
export function moveChoice(values: readonly string[], from: number, to: number): readonly string[] {
  if (from === to || from < 0 || to < 0 || from >= values.length || to >= values.length) return values
  const next = values.slice()
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

/** Remove one value; absent ⇒ the SAME array. */
export function removeChoice(values: readonly string[], value: string): readonly string[] {
  return values.includes(value) ? values.filter(v => v !== value) : values
}

/**
 * The picker's new selection when it closes with Done: values that were picked before keep their place, newly
 * picked ones follow in the order they were ticked, unticked ones drop out. A picker that re-sorted the list on
 * Done would silently reorder a list the operator ordered by hand.
 */
export function mergeSelection(before: readonly string[], picked: readonly string[]): string[] {
  const keep = before.filter(v => picked.includes(v))
  return [...keep, ...picked.filter(v => !before.includes(v))]
}

/** "1 product selected" / "3 products selected" / "No products selected". */
export function selectionSummary(count: number, noun: { one: string; other: string }): string {
  if (count === 0) return `No ${noun.other} selected`
  return `${count} ${count === 1 ? noun.one : noun.other} selected`
}

export type ListKey = 'ArrowDown' | 'ArrowUp' | 'Home' | 'End' | 'PageDown' | 'PageUp'

/**
 * Where the highlight goes on a list key. Clamped, never wrapped: a wrap from the last row to the first looks like
 * the list jumped. Rows that are `disabled` are skipped; held rows are not (they must stay readable).
 */
export function nextActiveIndex(choices: readonly Pick<MediaChoice, 'disabled'>[], current: number, key: ListKey, page = 8): number {
  const n = choices.length
  if (n === 0) return -1
  const usable = (i: number) => !choices[i]?.disabled
  const seek = (start: number, step: 1 | -1): number => {
    for (let i = start; i >= 0 && i < n; i += step) if (usable(i)) return i
    return -1
  }
  const from = Math.min(Math.max(current, -1), n)
  let target: number
  switch (key) {
    case 'Home': target = seek(0, 1); break
    case 'End': target = seek(n - 1, -1); break
    case 'ArrowDown': target = seek(from + 1, 1); break
    case 'ArrowUp': target = from <= 0 ? seek(0, 1) : seek(from - 1, -1); break
    /* A page lands on the row a page away; if that row is disabled it keeps going the SAME way, and only turns back
       when the list ends there. */
    case 'PageDown': { const at = Math.min(n - 1, from + page); target = seek(at, 1); if (target === -1) target = seek(at, -1); break }
    case 'PageUp': { const at = Math.max(0, from - page); target = seek(at, -1); if (target === -1) target = seek(at, 1); break }
  }
  return target === -1 ? (usable(current) ? current : seek(0, 1)) : target
}

/**
 * Resolve picked values to choices for display. A value no known choice carries (a reference whose name has not
 * loaded, or an entry deleted in the store) is still SHOWN — as its raw value, marked `unknown` — never dropped:
 * dropping it would let the next save delete a value the operator never saw.
 */
export function resolveChosen(values: readonly string[], known: ReadonlyMap<string, MediaChoice> | readonly MediaChoice[]): Array<MediaChoice & { unknown?: true }> {
  const map = Array.isArray(known) ? new Map(known.map(c => [c.value, c])) : known as ReadonlyMap<string, MediaChoice>
  return values.map(v => map.get(v) ?? { value: v, label: v, unknown: true as const })
}
