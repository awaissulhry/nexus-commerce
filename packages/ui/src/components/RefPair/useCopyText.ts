'use client'

/**
 * useCopyText (B-W2b-155) — copy a reference to the clipboard and say what happened: `copied` holds the value just copied
 * for a moment (the button shows a tick and a polite region says "Copied"), `failed` when the browser refused (no
 * permission, not a secure page) so the part can say to copy it by hand. Shared by RefPair and EndState.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** How long the "Copied" mark stays. */
export const COPIED_FOR_MS = 2000

export type CopyState = { value: string; outcome: 'copied' | 'failed' } | null

export function useCopyText(): { state: CopyState; copy: (value: string) => Promise<void> } {
  const [state, setState] = useState<CopyState>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
  }, [])
  const copy = useCallback(async (value: string) => {
    if (timer.current) clearTimeout(timer.current)
    let outcome: 'copied' | 'failed' = 'failed'
    try {
      const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
      if (clip) {
        await clip.writeText(value)
        outcome = 'copied'
      }
    } catch {
      outcome = 'failed'
    }
    setState({ value, outcome })
    timer.current = setTimeout(() => setState(null), COPIED_FOR_MS)
  }, [])
  return { state, copy }
}
