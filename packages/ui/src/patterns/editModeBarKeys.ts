/**
 * EditModeBar keys — the pure rules (Reviews parts, 2026-10-26). No React, so Node tests cover them.
 *
 * ⌘S (or Ctrl+S) saves an editor that asked for the shortcut. Never with Alt or Shift held (those are other commands),
 * never while an input method is composing a character, and never when the save is held or busy — then the key does
 * nothing at all, and the browser's own "Save page" is still kept away.
 */

export interface SaveKeyEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
}

/** ⌘S or Ctrl+S, nothing else held. */
export function isSaveShortcut(e: SaveKeyEvent): boolean {
  if (e.isComposing || e.altKey || e.shiftKey) return false
  if (!(e.metaKey || e.ctrlKey)) return false
  return e.key === 's' || e.key === 'S'
}

/** What a save key does: `save`, `held` (swallowed: the save says why on its button), or `ignore` (not the shortcut). */
export function saveKeyAction(e: SaveKeyEvent, state: { held: boolean; busy: boolean }): 'save' | 'held' | 'ignore' {
  if (!isSaveShortcut(e)) return 'ignore'
  return state.held || state.busy ? 'held' : 'save'
}

/** Leaving the page asks first while there are unsaved changes. */
export function warnBeforeLeaving(count: number | null | undefined): boolean {
  return count != null && count > 0
}

/** Apple keyboards name the key ⌘; everyone else Ctrl. */
export function isMacPlatform(platform: string | null | undefined): boolean {
  return !!platform && /mac|iphone|ipad|ipod/i.test(platform)
}

export function saveShortcutWords(mac: boolean): string {
  return mac ? '⌘S' : 'Ctrl+S'
}
