'use client'

import { useEffect, useRef } from 'react'
import { createWedgeReader } from '@nexus/ui/floor'

const TEXT = new Set(['text', 'search', 'email', 'number', 'tel', 'url', 'password'])
const isTextField = (element: Element | null) =>
  element instanceof HTMLTextAreaElement || (element instanceof HTMLInputElement && TEXT.has(element.type)) || (element instanceof HTMLElement && element.isContentEditable)

/**
 * A scanner's burst read while no scan field is on screen (design "scanRouter": ScanInput listens on every screen). The
 * Operation screen shows its scan field only on the scan step; on the card, the counts and the picker a hardware
 * scanner's code still arrives through the DS wedge rule (`createWedgeReader`: scanner-fast keys ending in Enter or Tab),
 * swallowed so it never presses a focused button, while a person's own key presses pass through untouched.
 */
export function useWedgeScans(onScan: (code: string) => void, enabled: boolean): void {
  const latest = useRef(onScan)
  latest.current = onScan
  useEffect(() => {
    if (!enabled) return
    const reader = createWedgeReader()
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      const active = document.activeElement
      if (event.ctrlKey || event.metaKey || event.altKey || isTextField(active) || active?.closest('[aria-modal="true"]')) {
        reader.reset()
        return
      }
      const step = reader.key(event.key, event.timeStamp || performance.now())
      if (step.kind === 'char' && step.burst) {
        event.preventDefault()
        event.stopPropagation()
      } else if (step.kind === 'scan') {
        event.preventDefault()
        event.stopPropagation()
        latest.current(step.code)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [enabled])
}
