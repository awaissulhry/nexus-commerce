/**
 * When a press or a key closes a Modal or a Drawer — as pure rules, because `apps/web` vitest is node-only: the rules
 * are tested here and the components only apply them.
 */

/**
 * A backdrop closes its dialog only for a press that STARTS and ENDS on the backdrop itself.
 *
 * The browser sends `click` to the nearest element that holds both the press and the release. A drag that starts in
 * the dialog and is let go over the dimmed area — a column resize, a text selection, a fill-handle drag — therefore
 * clicks the BACKDROP, and closing on that click threw the dialog away mid-task (the Publish review closed while a
 * column was resized, 2026-10-12). Only a press that began on the backdrop is a request to close.
 */
export function createBackdropPress() {
  let downOnBackdrop = false
  let upOnBackdrop = false
  return {
    down(onBackdrop: boolean) { downOnBackdrop = onBackdrop; upOnBackdrop = false },
    up(onBackdrop: boolean) { upOnBackdrop = onBackdrop },
    /** Read on the backdrop's `click`; the press is used up either way. */
    clickCloses(onBackdrop: boolean): boolean {
      const closes = onBackdrop && downOnBackdrop && upOnBackdrop
      downOnBackdrop = false
      upOnBackdrop = false
      return closes
    },
  }
}

/** A grid's own popups (column menu, filter, right-click menu, popup editor) and a cell being edited. */
export const GRID_OWNED_ESCAPE = '.ag-popup, .ag-popup-editor, .ag-cell-inline-editing'

/**
 * Esc that starts inside a grid's own popup or in a cell being edited belongs to the GRID: AG closes that one thing,
 * and the dialog or drawer around the grid stays open.
 *
 * Read in the CAPTURE phase. By the bubble phase AG has already stopped editing and taken the editor out of the
 * page, and AG never marks its Esc as handled (no `preventDefault`), so `defaultPrevented` cannot tell.
 */
export function escapeBelongsToGrid(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null
  return typeof element?.closest === 'function' && element.closest(GRID_OWNED_ESCAPE) != null
}

/** Watches the document's keydowns in the capture phase; `owns(event)` is true for an Esc that started in a grid's own UI. */
export function watchGridEscape(doc: Document): { owns: (event: KeyboardEvent) => boolean; stop: () => void } {
  const owned = new WeakSet<KeyboardEvent>()
  const onCapture = (event: KeyboardEvent) => { if (event.key === 'Escape' && escapeBelongsToGrid(event.target)) owned.add(event) }
  doc.addEventListener('keydown', onCapture, true)
  return { owns: (event) => owned.has(event), stop: () => doc.removeEventListener('keydown', onCapture, true) }
}
