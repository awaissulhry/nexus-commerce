/**
 * The keyboard model of `DetailPopover`, as a pure table — `apps/web` vitest is node-only, so the rule is
 * tested here and the component only applies it.
 *
 *  - Enter / Space on the TRIGGER is the trigger's own (a real `<button>`): it toggles the panel.
 *  - Inside an open panel: Esc closes it and RETURNS focus (to the trigger, or to what the caller named —
 *    the grid names the cell); Tab and Shift+Tab stay inside, wrapping at either end; every other key is
 *    the focused control's own.
 *  - A click outside closes without moving focus: the person clicked somewhere, and that is where they are.
 *  - Opening by click or keyboard moves focus to the panel's first action (the panel itself when it has
 *    none); opening by hover never moves focus — a pointer passing over a cell must not steal the caret.
 */
export type DetailPopoverKeyResult =
  | { action: 'close'; returnFocus: boolean }
  | { action: 'focus'; index: number }
  | { action: 'none' }

/** What can take focus inside the panel, in DOM order. */
export const DETAIL_POPOVER_FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * One keydown inside the open panel. `index` is the focused control's position among the focusables
 * (-1 = the panel itself has focus); `count` is how many focusables there are.
 */
export function detailPopoverKey(key: string, shift: boolean, index: number, count: number): DetailPopoverKeyResult {
  if (key === 'Escape') return { action: 'close', returnFocus: true }
  if (key !== 'Tab') return { action: 'none' }
  // Nothing to move between: keep focus on the panel rather than letting Tab walk out of it.
  if (count === 0) return { action: 'focus', index: -1 }
  if (shift) return index <= 0 ? { action: 'focus', index: count - 1 } : { action: 'none' }
  // From the panel itself (-1) or the last action, Tab goes to the first; in between it is the browser's.
  return index >= count - 1 || index < 0 ? { action: 'focus', index: 0 } : { action: 'none' }
}

/** Where focus goes when the panel opens. `-1` = the panel itself; `null` = do not move focus. */
export function detailPopoverOpenFocus(via: 'click' | 'keyboard' | 'hover', count: number): number | null {
  if (via === 'hover') return null
  return count > 0 ? 0 : -1
}

/** A pointer-down outside the trigger and the panel. */
export function detailPopoverClickAway(): DetailPopoverKeyResult {
  return { action: 'close', returnFocus: false }
}
