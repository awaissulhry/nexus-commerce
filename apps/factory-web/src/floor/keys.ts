'use client'

import { useEffect, useRef } from 'react'

/**
 * The floor's keys (design "Keyboard"): Enter = the screen's main action, Esc = Back. No letter shortcuts: a scanner
 * types letters. A key that a control takes itself is left to it: focus on a button, a link, a field or the PIN pad
 * (Enter presses the button; the scan field ends a code with it), an open dialog (it answers its own Esc), a key the
 * scan field's listener swallowed (a scanner's burst ends with Enter). Esc in the scan field is Back. `enterFromScan`
 * (B-W2b-67, the clock: the scan field on screen and a main action): Enter in the EMPTY scan field presses the main action;
 * a code in it stays the field's (a scanner's Enter is prevented there, so a badge never presses the main action too).
 */
export function useFloorKeys(keys: { enter?: (() => void) | null; escape?: (() => void) | null; enterFromScan?: boolean }): void {
  const latest = useRef(keys)
  latest.current = keys
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return
      const active = document.activeElement
      // The scan field keeps the focus on every floor screen; it takes Enter (the end of a code), not Esc.
      const scanField = active instanceof HTMLInputElement && active.classList.contains('nds-floor-scan-input')
      if (active?.closest('[aria-modal="true"]')) return
      const emptyScan = scanField && event.key === 'Enter' && latest.current.enterFromScan === true && active.value === ''
      if (!(scanField && event.key === 'Escape') && !emptyScan && active?.closest('button, a[href], input, textarea, select, [role="group"][tabindex]')) return
      const run = event.key === 'Enter' ? latest.current.enter : latest.current.escape
      if (!run) return
      event.preventDefault()
      run()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])
}
