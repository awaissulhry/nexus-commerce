/**
 * DS floor kit — the size buttons' rules (gap G6, SCR-094, 090): pick one size to count, each button showing what is
 * still to do in that size (A2 §3.1 "size buttons for counting per size").
 *
 * - One size at a time, or none. A held size (`heldReason`: not in this order, blocked) cannot be picked; it stays
 *   focusable and says why.
 * - A size with nothing left (`remaining` 0) is done — drawn with a tick — and can still be picked (a recount, an extra).
 * - Keyboard as a radio group: one Tab stop (the picked size, else the first size that can be picked); arrows move and
 *   pick, wrapping; Home / End go to the ends. Moving onto a held size focuses it without picking it.
 */

export interface SizeButton {
  /** The size's id (the app's variant or size code). */
  id: string
  /** What is printed on the button ("52", "XL"). */
  label: string
  /** Pieces still to do in this size. Left out: no count shown. */
  remaining?: number
  /** A short line under the count ("di 24"). */
  hint?: string
  /** Why this size cannot be picked now. Set: held (focusable, announced, inert). */
  heldReason?: string | null
}

export type SizeState = 'open' | 'done' | 'held'

export function sizeState(size: SizeButton): SizeState {
  if (size.heldReason) return 'held'
  if (size.remaining != null && size.remaining <= 0) return 'done'
  return 'open'
}

export const sizeCanPick = (size: SizeButton): boolean => !size.heldReason

/** A press: the size picked, or the current one kept when the pressed size is held. */
export function sizePress(sizes: readonly SizeButton[], current: string | null, id: string): string | null {
  const size = sizes.find((s) => s.id === id)
  return size && sizeCanPick(size) ? id : current
}

/** The one Tab stop: the picked size if it is there, else the first that can be picked, else the first. */
export function sizeTabStop(sizes: readonly SizeButton[], value: string | null): string | null {
  if (value != null && sizes.some((s) => s.id === value)) return value
  return (sizes.find(sizeCanPick) ?? sizes[0])?.id ?? null
}

export type SizeNavKey = 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp' | 'Home' | 'End'

export const isSizeNavKey = (key: string): key is SizeNavKey =>
  key === 'ArrowRight' || key === 'ArrowDown' || key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home' || key === 'End'

/**
 * Where an arrow, Home or End moves focus from `from`, with wrap (`dir` = the reading direction: arrows swap in
 * right-to-left). Returns the id to focus; whether it is also picked is `sizeCanPick`.
 */
export function sizeKeyTarget(sizes: readonly SizeButton[], from: string | null, key: SizeNavKey, dir: 'ltr' | 'rtl' = 'ltr'): string | null {
  if (!sizes.length) return null
  if (key === 'Home') return sizes[0].id
  if (key === 'End') return sizes[sizes.length - 1].id
  const i = Math.max(0, sizes.findIndex((s) => s.id === from))
  const forward = key === 'ArrowDown' || (key === 'ArrowRight') === (dir === 'ltr')
  const next = (i + (forward ? 1 : -1) + sizes.length) % sizes.length
  return sizes[next].id
}

/** Sum of what is left across sizes (a total line for the app). Sizes with no count add nothing. */
export function sizeRemainingTotal(sizes: readonly SizeButton[]): number {
  return sizes.reduce((sum, s) => sum + Math.max(0, s.remaining ?? 0), 0)
}
