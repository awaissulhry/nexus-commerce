/**
 * The rules of `SelectableCardGroup` (B-W2b-09; the pressable line card of Production › Reports, B-W2a-38) — pure,
 * tested in Node.
 *
 * A `single` group is a radio group: one Tab stop (the picked card, else the first that may be picked), arrows move AND
 * pick (WAI-ARIA radio group), held cards are skipped by the arrows but still reachable by pointer to hear why. A
 * `multiple` group is a set of toggles: each card its own Tab stop, Space / Enter toggles.
 */
export interface CardOption {
  id: string
  /** Why this card cannot be picked now; null when it can. */
  held?: string | null
}

export type CardMoveKey = 'ArrowDown' | 'ArrowRight' | 'ArrowUp' | 'ArrowLeft' | 'Home' | 'End'
export const CARD_MOVE_KEYS: readonly CardMoveKey[] = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']

/** The card that holds the group's one Tab stop in a single group. */
export function cardTabStop(options: readonly CardOption[], selected: string | null | undefined): string | null {
  if (selected && options.some((option) => option.id === selected)) return selected
  return options.find((option) => !option.held)?.id ?? options[0]?.id ?? null
}

/** Where an arrow key goes from `from` in a single group (wraps, skips held cards); null when nowhere. */
export function cardMove(options: readonly CardOption[], from: string, key: CardMoveKey, rtl = false): string | null {
  const open = options.filter((option) => !option.held)
  if (open.length === 0) return null
  if (key === 'Home') return open[0]!.id
  if (key === 'End') return open[open.length - 1]!.id
  // Down always goes forward; right goes forward left-to-right, left goes forward right-to-left.
  const forward = key === 'ArrowDown' || (key === 'ArrowRight' && !rtl) || (key === 'ArrowLeft' && rtl)
  const index = open.findIndex((option) => option.id === from)
  if (index < 0) return open[0]!.id
  const next = (index + (forward ? 1 : -1) + open.length) % open.length
  return open[next]!.id
}

/** The next set after toggling `id` in a multiple group (a held card never changes). */
export function cardToggle(selected: readonly string[], id: string, options: readonly CardOption[]): string[] {
  const option = options.find((entry) => entry.id === id)
  if (!option || option.held) return [...selected]
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
}
