import { useEffect, useRef, type RefObject } from 'react'

type AnyRef = RefObject<HTMLElement | null>

/**
 * Close-on-outside-click. Attaches a `mousedown` listener while `active` and fires `onAway` when
 * the click lands outside EVERY ref given.
 *
 * 🔴 It takes a LIST because the popovers portal to `<body>`. A portaled panel is not a DOM
 * descendant of its trigger, so a single-ref version treats clicking an option as an outside
 * click and closes the panel before the option's own handler runs — the control looks like it
 * ignores you. Pass both the wrapper and the panel.
 *
 * `onAway` and the ref list are read through a ref, so an inline arrow or an inline array at the
 * call site no longer re-subscribes the document listener on every render.
 */
export function useClickAway<T extends HTMLElement>(
  ref: RefObject<T | null> | AnyRef[],
  onAway: () => void,
  active = true,
) {
  const latest = useRef<{ refs: AnyRef[]; onAway: () => void }>({ refs: [], onAway })
  latest.current = { refs: Array.isArray(ref) ? ref : [ref as AnyRef], onAway }

  useEffect(() => {
    if (!active) return
    const onDoc = (e: MouseEvent) => {
      const target = e.target as Node
      for (const r of latest.current.refs) {
        if (r.current?.contains(target)) return
      }
      latest.current.onAway()
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [active])
}
