import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/**
 * pg-w1 (portal grid plan D8; 18-lead-settles Z16 P1, P2) — a part measures its OWN room (the width its root really has, at any screen,
 * beside a dock or not), never the window: a ResizeObserver on the root, the width turned into what the part needs (the Work tab: how
 * many of its extra columns join; the portal's list: which columns the room holds). The customer page's Work tab measured it this
 * way (F-CW-103; its useWorkRoom calls this part now). `of` should be a stable function (a module's own): a new one measures again.
 * Until it is measured: `initial`.
 */
export function useRoomWidth<V extends string | number | boolean | null>(of: (width: number) => V, initial: V): { readonly ref: RefObject<HTMLDivElement | null>; readonly value: V } {
  const ref = useRef<HTMLDivElement>(null)
  const [value, setValue] = useState<V>(initial)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const measure = () => setValue(of(node.getBoundingClientRect().width))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [of])
  return { ref, value }
}
