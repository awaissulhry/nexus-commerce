'use client'

/**
 * W2-A (CC-16) — the one way a create screen handles a launch's answer: navigate away only when everything asked for is
 * live on Amazon AND the read-back agrees; otherwise hold the answer, so the screen shows the same `LaunchReceipt`
 * (what is live, what failed and why, what Amazon reports) with a Re-check of the campaigns Amazon holds.
 */
import { useCallback, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { needsReceipt, recheckIds, type LaunchAnswer, type LaunchResult } from './launch-receipt-model'
import type { LaunchVerification } from './LaunchReceipt'

export interface HeldLaunch {
  launch: LaunchResult | null
  verification: LaunchVerification | null
  ids: string[]
}

export function useLaunchReceipt(onAllGood: () => void) {
  const [held, setHeld] = useState<HeldLaunch | null>(null)
  const [rechecking, setRechecking] = useState(false)
  const [recheckError, setRecheckError] = useState('')

  /** Keep the answer when it needs the receipt (returns true: stay on the screen); false = all good, move on. */
  const hold = useCallback((answer: LaunchAnswer): boolean => {
    if (!needsReceipt(answer)) return false
    setHeld({ launch: answer.launch ?? null, verification: (answer.verification as LaunchVerification | null | undefined) ?? null, ids: recheckIds(answer) })
    setRecheckError('')
    return true
  }, [])

  /** Read the launch back again (transient read failures are common); move on once everything is right. */
  const recheck = useCallback(async () => {
    if (!held?.ids.length || rechecking) return
    setRechecking(true); setRecheckError('')
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/launches/verify`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ campaignIds: held.ids }),
      })
      const j = (await r.json().catch(() => null)) as LaunchVerification | { error?: string } | null
      if (!r.ok || !j || !('entities' in j)) throw new Error((j as { error?: string } | null)?.error || 'The read-back failed.')
      if (j.ok && (!held.launch || held.launch.ok)) { setHeld(null); onAllGood() }
      else setHeld({ ...held, verification: j })
    } catch (e) { setRecheckError((e as Error).message) }
    finally { setRechecking(false) }
  }, [held, rechecking, onAllGood])

  /** Put the receipt away (a screen that stays, like the AI Advertising dashboard). */
  const clear = useCallback(() => { setHeld(null); setRecheckError('') }, [])

  return { held, hold, recheck, rechecking, recheckError, clear }
}
