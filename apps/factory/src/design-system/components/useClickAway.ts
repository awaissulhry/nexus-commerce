import { useEffect, type RefObject } from 'react'

/**
 * Close-on-outside-click. Attaches a `mousedown` listener while `active` and
 * fires `onAway` when the click lands outside `ref`. Shared by the dropdown
 * components (the H10 `useClickAway` promoted out of FilterDropdown).
 */
export function useClickAway<T extends HTMLElement>(ref: RefObject<T | null>, onAway: () => void, active = true) {
  useEffect(() => {
    if (!active) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [ref, onAway, active])
}
