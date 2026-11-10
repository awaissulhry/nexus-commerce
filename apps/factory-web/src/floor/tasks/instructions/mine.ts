'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../lib/api/client'
import { fetchMine, type MineAnswer } from './api'
import { keepMine, keptMine } from './memory'

/**
 * The person's own instructions (B-W2b-214 `GET /production/instructions/floor/mine`): the published versions waiting for their
 * Seen. My work's "New instructions N" (FI9:02) and Spec & instructions' "New for you" read it on view, when the network comes
 * back and every 30 s while the screen is in view (no live rule reaches a tablet for a tenant-wide instruction: B-W2b-214's gap).
 * A failed read keeps what this tablet read for this person (memory only); another person never sees it.
 */

export const MINE_REREAD_MS = 30_000

export interface MineRead {
  readonly mine: MineAnswer | null
  /** Shown from this tablet (the read failed): as of when. */
  readonly asOf: string | null
}

export function useMine(input: { readonly api: ApiClient; readonly online: boolean; readonly workerId: string | null; readonly allowed: boolean; readonly onSignedOut?: () => void }): MineRead {
  const { api, online, workerId, allowed } = input
  // The caller's 401 handler may be a new function on every render: read through a ref, so the beat is not restarted by it.
  const signedOut = useRef(input.onSignedOut)
  signedOut.current = input.onSignedOut
  const [read, setRead] = useState<MineRead>(() => {
    const kept = workerId ? keptMine(workerId) : null
    return { mine: kept?.value ?? null, asOf: kept ? kept.asOf : null }
  })

  const again = useCallback(async () => {
    if (!allowed || !workerId) return
    const answer = await fetchMine(api)
    if (answer.ok) {
      keepMine(workerId, answer.value)
      setRead({ mine: answer.value, asOf: null })
      return
    }
    if (answer.problem.kind === 'signedOut') return signedOut.current?.()
    const kept = keptMine(workerId)
    setRead({ mine: kept?.value ?? null, asOf: kept?.asOf ?? null })
  }, [allowed, api, workerId])

  // Another person on the tablet: their own, never the last person's.
  useEffect(() => {
    const kept = workerId ? keptMine(workerId) : null
    setRead({ mine: kept?.value ?? null, asOf: kept ? kept.asOf : null })
  }, [workerId])

  useEffect(() => {
    if (!online) return
    void again()
    const tick = () => {
      if (document.visibilityState === 'visible') void again()
    }
    const timer = window.setInterval(tick, MINE_REREAD_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [online, again])

  return read
}
