'use client'

/**
 * GDS — bind single-key shortcuts to ONE grid (gap G8, the approvals grid, 2026-10-05).
 *
 *   const hostRef = useRef<HTMLDivElement>(null)
 *   const hints = useGridShortcuts(hostRef, [
 *     { key: 'a', label: 'Approve', run: () => approve(focusedRow()) },
 *     { key: 'r', label: 'Reject', run: () => reject(focusedRow()) },
 *     { key: 'Enter', label: 'Open', run: () => open(focusedRow()) },
 *   ])
 *   <div ref={hostRef}><GridCard …><NexusGrid suppressCellFocus={false} … /></GridCard></div>
 *
 * The keys work only while focus is inside `container`, and never while someone is typing, editing a cell, or in a
 * menu or a modal — the rules and their tests are in `gridShortcuts.ts`. Ctrl / ⌘ / Alt combinations are never taken.
 * A key that runs is `preventDefault`ed. The return value is the hint list the page shows (with `Kbd`).
 *
 * The grid must let a cell take focus (`suppressCellFocus={false}`) for a "focused row" to exist; which row a verb
 * acts on is the page's (`api.getFocusedCell()`), not this hook's.
 */
import { useEffect, useMemo, useRef, type RefObject } from 'react'

import { gridShortcutHints, matchGridShortcut, type GridShortcut, type GridShortcutHint } from './gridShortcuts'

export interface UseGridShortcutsOptions {
  /** Off while false (a drawer that owns the keys, a busy save). Default true. */
  enabled?: boolean
}

/** A modal that is open and does NOT contain the grid owns the keyboard, wherever focus is. */
function modalOutside(container: HTMLElement): boolean {
  if (typeof document === 'undefined') return false
  for (const modal of document.querySelectorAll('[aria-modal="true"], dialog[open]')) {
    if (!modal.contains(container)) return true
  }
  return false
}

export function useGridShortcuts(
  container: RefObject<HTMLElement | null>,
  shortcuts: readonly GridShortcut[],
  options: UseGridShortcutsOptions = {},
): GridShortcutHint[] {
  const enabled = options.enabled ?? true
  // The latest list without re-binding the listener on every render (pages pass inline arrays).
  const latest = useRef(shortcuts)
  latest.current = shortcuts

  useEffect(() => {
    const el = container.current
    if (!el || !enabled) return
    const onKeyDown = (event: KeyboardEvent) => {
      const hit = matchGridShortcut(event, el, latest.current, { modalOpen: modalOutside(el) })
      if (!hit) return
      event.preventDefault()
      hit.run(event)
    }
    el.addEventListener('keydown', onKeyDown)
    return () => el.removeEventListener('keydown', onKeyDown)
  }, [container, enabled])

  const signature = shortcuts.map((s) => `${s.key}\u0000${s.label}\u0000${String(s.disabled ?? '')}`).join('\u0001')
  // The hint list keeps its identity until a key, a label or a held state changes.
  return useMemo(() => gridShortcutHints(latest.current), [signature])
}
