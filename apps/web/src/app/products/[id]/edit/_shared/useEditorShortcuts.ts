/**
 * DSP.9 — Editor keyboard shortcuts.
 *
 * Globally registered on the product editor surface so operators can
 * drive Save / Save & Publish / Discard from the keyboard. Matches
 * the Salesforce/Airtable density preference (memory
 * visibility_over_minimalism) and the DSP.0 spec.
 *
 *   Cmd+S / Ctrl+S         → Save All (page scope)
 *   Cmd+Shift+S / Ctrl+Shift+S → Save & Publish (uses default channel
 *                            via the supplied callback; that callback
 *                            decides what "default" means when there
 *                            isn't a remembered choice)
 *   Esc                    → Discard (with the scope-aware confirm
 *                            handled at the call site)
 *
 * The Cmd+S browser default ("save page as…") is suppressed via
 * event.preventDefault() — this is intentional and matches user
 * expectation across modern editor apps (Notion, Figma, Linear).
 *
 * Esc only fires when no other interactive element claims it first.
 * The hook listens on the bubble phase so modals / menus / inputs
 * that handle Esc themselves (closing themselves) consume the event
 * before this listener sees it.
 */

import { useEffect } from 'react'

export interface EditorShortcutsOptions {
  /** Toggle the hook entirely. Pass false when the editor page is
   *  unmounted or in a read-only mode. */
  enabled: boolean
  /** Cmd+S / Ctrl+S handler. Should call the header's Save All. */
  onSave: () => void
  /** Cmd+Shift+S / Ctrl+Shift+S handler. May be undefined on
   *  surfaces without a Publish surface (rare on the editor). */
  onSaveAndPublish?: () => void
  /** Esc handler. Should call the header's Discard which then
   *  presents the DSP.3 scope-aware confirm modal. */
  onDiscard: () => void
}

export function useEditorShortcuts({
  enabled,
  onSave,
  onSaveAndPublish,
  onDiscard,
}: EditorShortcutsOptions): void {
  useEffect(() => {
    if (!enabled) return

    function onKeyDown(e: KeyboardEvent) {
      // Cmd on macOS, Ctrl elsewhere. Modern browsers map both to
      // metaKey/ctrlKey respectively; checking both means a single
      // shortcut covers every platform without sniffing UA.
      const mod = e.metaKey || e.ctrlKey
      if (!mod) {
        if (e.key === 'Escape') {
          // Esc only fires when no focused element handles it first
          // (modals/menus/inputs typically do). The bubble-phase
          // listener below sees only "unclaimed" Esc presses.
          onDiscard()
        }
        return
      }

      // Cmd+S variants — letter check is case-insensitive because
      // Shift changes key to 'S' (uppercase).
      const key = e.key.toLowerCase()
      if (key !== 's') return

      // Suppress browser's "Save page as…" dialog in every case.
      e.preventDefault()

      if (e.shiftKey) {
        if (onSaveAndPublish) onSaveAndPublish()
      } else {
        onSave()
      }
    }

    // Bubble phase so modals/menus consume Esc first.
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled, onSave, onSaveAndPublish, onDiscard])
}
