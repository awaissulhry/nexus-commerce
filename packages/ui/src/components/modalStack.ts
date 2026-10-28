/**
 * The rules of stacked dialogs, kept pure so they are tested in Node (`apps/web` vitest has no DOM). `Modal.tsx`
 * applies them to its backdrops (bid page polish round 2, 2026-10-10: a review opens ABOVE a row's detail modal).
 *
 *  - One shared stack, in the order the dialogs opened. The last one is on top: it alone answers Esc and Tab, and
 *    everything else on the page (the dialogs under it included) is inert.
 *  - When the top one closes, the one under it is the top again.
 *  - Focus goes back to where it was when the dialog opened (audit M10: it went to <body> after a review closed).
 *    In order: the host's `returnFocusTo`, then the element that opened the dialog, then — when that element is gone
 *    (a re-rendered grid cell, a button the save removed) — the dialog that is now on top, so the focus stays in the
 *    detail under a review rather than dropping to the page's start. The first one that can take focus wins.
 */

export interface LayerStack<T> {
  /** Open: put it on top. Opening one that is already open moves it to the top. */
  push(layer: T): void
  /** Close: take it out, wherever it sits. */
  remove(layer: T): void
  top(): T | undefined
  isTop(layer: T): boolean
  has(layer: T): boolean
  size(): number
  /** Bottom first. */
  layers(): readonly T[]
}

export function createLayerStack<T>(): LayerStack<T> {
  const items: T[] = []
  return {
    push(layer) {
      const at = items.indexOf(layer)
      if (at >= 0) items.splice(at, 1)
      items.push(layer)
    },
    remove(layer) {
      const at = items.indexOf(layer)
      if (at >= 0) items.splice(at, 1)
    },
    top: () => items[items.length - 1],
    isTop: (layer) => items.length > 0 && items[items.length - 1] === layer,
    has: (layer) => items.includes(layer),
    size: () => items.length,
    layers: () => items.slice(),
  }
}

/** Where the focus may go when a dialog closes. A function is read at close time (a grid cell that was re-rendered). */
export type ReturnFocusTarget<T> = T | null | undefined | (() => T | null | undefined)

/**
 * The places to try, best first, without repeats or blanks: the host's choice, the opener, the dialog now on top.
 * The caller focuses the first one that can take focus.
 */
export function returnFocusOrder<T>(args: { override?: ReturnFocusTarget<T>; opener?: T | null; below?: T | null }): T[] {
  const chosen = typeof args.override === 'function' ? (args.override as () => T | null | undefined)() : args.override
  const out: T[] = []
  for (const candidate of [chosen, args.opener, args.below]) {
    if (candidate == null || out.includes(candidate)) continue
    out.push(candidate)
  }
  return out
}

/**
 * Who answers a key: only the dialog on top of the stack, and not while another kind of modal surface (a drawer, a
 * builder) that opened after it covers it, nor when someone already handled the key.
 */
export function ownsKeys<T>(stack: LayerStack<T>, layer: T, opts: { coveredByOther?: boolean; handled?: boolean } = {}): boolean {
  return stack.isTop(layer) && !opts.coveredByOther && !opts.handled
}
