'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { hasUnsent } from './model'

/**
 * The composer's leave guard (B-TH-211; T5's "Leave with unsent text?"): while the box holds words or files, closing the
 * tab or reloading asks the browser's own question, and `ask(leave)` opens the in-app confirm before an in-app move (another
 * record, the list, a tab). Stay keeps everything; Discard runs the move. Nothing is fetched or stored here.
 *
 *   const guard = useLeaveGuard({ text, files: tray.length })
 *   <a onClick={(event) => { if (guard.ask(() => router.push(href))) event.preventDefault() }} …>
 *   {guard.asking && <LeaveConfirm files={tray.length} onStay={guard.stay} onDiscard={guard.discard} />}
 */
export function useLeaveGuard(draft: { readonly text: string; readonly files?: number }) {
  const unsent = hasUnsent(draft)
  const [asking, setAsking] = useState(false)
  const pending = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (!unsent) return
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Older browsers need a value; the browser shows its own words, never ours.
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [unsent])

  /** True when the move waits for the person's answer (the caller stops it); false when nothing would be lost. */
  const ask = useCallback(
    (leave: () => void): boolean => {
      if (!unsent) return false
      pending.current = leave
      setAsking(true)
      return true
    },
    [unsent],
  )
  const stay = useCallback(() => {
    pending.current = null
    setAsking(false)
  }, [])
  const discard = useCallback(() => {
    const leave = pending.current
    pending.current = null
    setAsking(false)
    leave?.()
  }, [])
  return { unsent, asking, ask, stay, discard }
}
