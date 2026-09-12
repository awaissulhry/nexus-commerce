'use client'
import { useLayoutEffect, useState, type RefObject } from 'react'

/** Re-measure when a late band, toolbar or parent changes the sheet's available space. */
export function useGridHostTop(ref: RefObject<HTMLElement | null>, enabled: boolean): number {
  const [top, setTop] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || !enabled) return
    const measure = () => setTop(Math.round(element.getBoundingClientRect().top + window.scrollY))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(document.body)
    observer.observe(element)
    if (element.parentElement) observer.observe(element.parentElement)
    window.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure) }
  }, [ref, enabled])
  return top
}
