/**
 * GDS — single-key shortcuts for a grid, as a pure filter (gap G8, the approvals grid, 2026-10-05).
 *
 * A queue is worked from the keyboard: A approves the focused row, R rejects it, Enter opens it, Esc closes the
 * drawer. A single letter is only safe where nobody is typing, so this decides — for one keydown — whether a shortcut
 * may run. Pure and DOM-free (structural types), so every refusal below is a test, not a hope; `useGridShortcuts`
 * binds it to the page.
 *
 * A key is REFUSED when:
 *  - Ctrl, ⌘ or Alt is held (those belong to the browser and the OS), or an IME is composing;
 *  - an earlier handler already took it (`defaultPrevented` — AG's own navigation, an editor, a menu);
 *  - focus is outside the grid container, or a modal is open that the grid is not inside;
 *  - focus is in a text field, a select, a contenteditable, a combobox or an open cell editor;
 *  - focus is in a menu, listbox or dialog INSIDE the grid (a ⋯ menu that is open);
 *  - it is Enter or Space on a control that activates on those keys (a button, a link, a checkbox) — the control's
 *    own meaning wins;
 *  - it is an auto-repeat of a held key and the shortcut did not ask for repeats: holding A must not approve row
 *    after row.
 */

export interface GridShortcut {
  /** One key: a letter or symbol (`a`, `r`, `x`, `?`), or `Enter`, `Escape`, `Space`. Letters match either case. */
  key: string
  /** What it does, for the hint: "Approve". */
  label: string
  run: (event: KeyboardEvent) => void
  /** Listed in the hint but not bound. A string is the reason, shown with the hint. */
  disabled?: boolean | string
  /** Also run on auto-repeat (a held key) — for moving, never for a verb. Default false. */
  repeat?: boolean
}

/** One line of the hint a page shows ("A Approve · R Reject · Enter Open"). */
export interface GridShortcutHint {
  key: string
  /** The key as printed on a `Kbd`: "A", "Enter", "Esc", "Space". */
  keyLabel: string
  label: string
  disabled: boolean
  reason?: string
}

/** The little of an element this filter reads. */
export interface ShortcutElement {
  closest(selector: string): ShortcutElement | null
  isContentEditable?: boolean
}

export interface ShortcutContainer {
  contains(node: unknown): boolean
}

export interface ShortcutKeyEvent {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  repeat?: boolean
  isComposing?: boolean
  defaultPrevented: boolean
  target: unknown
}

/** Where a typed letter is text, not a command. Checkboxes, radios and buttons are not text entry. */
export const TEXT_ENTRY_SELECTOR = [
  'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]', '[role="searchbox"]', '[role="combobox"]', '[role="spinbutton"]',
  'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="image"]):not([type="file"]):not([type="color"]):not([type="range"])',
].join(', ')

/** An AG cell editor that is open (an inline one; a popup editor sits outside the container and is refused there). */
export const CELL_EDITOR_SELECTOR = '.ag-cell-inline-editing, .ag-cell-editor, .ag-popup-editor, .ag-cell-edit-wrapper'

/** Something open on top of the rows that owns the keyboard while focused. */
export const OVERLAY_SELECTOR = '[role="menu"], [role="menubar"], [role="listbox"], [role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog'

/** Controls whose own meaning of Enter / Space wins over a shortcut. */
export const ACTIVATES_ON_ENTER_SELECTOR = [
  'button', 'a[href]', 'summary', 'input[type="checkbox"]', 'input[type="radio"]',
  '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="switch"]', '[role="menuitem"]', '[role="option"]', '[role="tab"]',
].join(', ')

/** One spelling per key: a letter in lower case; " " and "Spacebar" are Space; "Esc" is Escape. */
export function shortcutKey(key: string): string {
  if (key === ' ' || key === 'Spacebar') return 'Space'
  if (key === 'Esc') return 'Escape'
  return key.length === 1 ? key.toLowerCase() : key
}

/** The key as a `Kbd` prints it. */
export function shortcutKeyLabel(key: string): string {
  const k = shortcutKey(key)
  if (k === 'Escape') return 'Esc'
  return k.length === 1 ? k.toUpperCase() : k
}

const isElement = (v: unknown): v is ShortcutElement => !!v && typeof (v as ShortcutElement).closest === 'function'

export interface MatchOptions {
  /** A modal dialog is open somewhere on the page and the grid is not inside it. */
  modalOpen?: boolean
}

/** The shortcut this keydown may run, or null. Never runs anything itself. */
export function matchGridShortcut<S extends Pick<GridShortcut, 'key' | 'disabled' | 'repeat'>>(
  event: ShortcutKeyEvent,
  container: ShortcutContainer | null | undefined,
  shortcuts: readonly S[],
  options: MatchOptions = {},
): S | null {
  if (!container || event.defaultPrevented || event.isComposing) return null
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  const target = event.target
  if (!isElement(target) || !container.contains(target)) return null
  if (options.modalOpen) return null
  if (target.isContentEditable || target.closest(TEXT_ENTRY_SELECTOR)) return null
  if (target.closest(CELL_EDITOR_SELECTOR)) return null
  const overlay = target.closest(OVERLAY_SELECTOR)
  // A dialog AROUND the grid (a grid in a modal drawer) is the grid's host, not something open on top of it.
  if (overlay && container.contains(overlay)) return null
  const key = shortcutKey(event.key)
  const hit = shortcuts.find((s) => !s.disabled && shortcutKey(s.key) === key)
  if (!hit) return null
  if ((key === 'Enter' || key === 'Space') && target.closest(ACTIVATES_ON_ENTER_SELECTOR)) return null
  if (event.repeat && !hit.repeat) return null
  return hit
}

/** The hint list, in the page's order — disabled shortcuts included, with their reason. */
export function gridShortcutHints(shortcuts: readonly Pick<GridShortcut, 'key' | 'label' | 'disabled'>[]): GridShortcutHint[] {
  return shortcuts.map((s) => ({
    key: shortcutKey(s.key),
    keyLabel: shortcutKeyLabel(s.key),
    label: s.label,
    disabled: !!s.disabled,
    ...(typeof s.disabled === 'string' && s.disabled.trim() ? { reason: s.disabled } : {}),
  }))
}
