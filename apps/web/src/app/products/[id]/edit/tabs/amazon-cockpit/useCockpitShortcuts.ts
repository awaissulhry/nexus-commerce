'use client'

// AC.13 — Cockpit-scoped keyboard shortcuts.
//
// Layered on top of the editor-level useEditorShortcuts (DSP.9 —
// Cmd+S / Cmd+Shift+S / Esc). The cockpit adds:
//
//   • Cmd+Shift+P / Ctrl+Shift+P — jump to PublishCard.
//   • 1..9                       — jump to the Nth jump-target on the
//                                   cockpit (publish / autofill /
//                                   variations / identifiers / etc.).
//   • Alt+1..9 is owned by the chip strip (AC.3 useMarketSwitch) and
//     unaffected by this hook.
//
// All shortcuts ignore when the focused element is editable
// (input/textarea/select/contentEditable). Prevents stealing Alt+
// accent / numeric typing.

import { useEffect } from 'react'
import { announce } from '../../_shared/announce/useAnnounce'
import type { JumpTarget } from './health/computeHealthScore'

// Numeric-jump order. Stable so 1 always = publish even when the
// card layout grows; new targets append at the end. 9 is the last
// directly bindable (10+ would need a modifier).
const NUMERIC_JUMP_ORDER: JumpTarget[] = [
  'publish',
  'autofill',
  'variations',
  'identifiers',
  'category',
  'images',
  'aplus',
  'pricing',
  'suppression',
]

interface Options {
  enabled: boolean
  onJumpTo: (target: JumpTarget) => void
}

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  const tag = t.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  if (t.isContentEditable) return true
  return false
}

export function useCockpitShortcuts({ enabled, onJumpTo }: Options): void {
  useEffect(() => {
    if (!enabled) return
    function onKey(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return

      const mod = e.metaKey || e.ctrlKey

      // Cmd+Shift+P → publish
      if (mod && e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        onJumpTo('publish')
        announce('Jumped to Publish flow')
        return
      }

      // 1..9 → jump-target by index. Bare digits only — modifiers
      // mean some other shortcut (Alt+N is market switch).
      if (!mod && !e.altKey && !e.shiftKey) {
        const digit = parseInt(e.key, 10)
        if (Number.isInteger(digit) && digit >= 1 && digit <= 9) {
          const target = NUMERIC_JUMP_ORDER[digit - 1]
          if (target) {
            e.preventDefault()
            onJumpTo(target)
            announce(`Jumped to ${target}`)
          }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [enabled, onJumpTo])
}
