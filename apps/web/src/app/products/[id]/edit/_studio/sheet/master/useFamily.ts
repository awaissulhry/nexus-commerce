'use client'

/**
 * PES.2 / F1 — the family read.
 *
 * `GET /api/pim/family/:productId` — role, parent, children, siblings. Its own call rather than a
 * field on the sheet read: the sheet is scoped to a FAMILY and already has the rows, but it cannot
 * say what role the product plays or name the axes, and asking PES.5 to widen their contract for
 * one bar would be a change to a shape three lanes now consume.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

import { getBackendUrl } from '@/lib/backend-url'

import type { FamilyResponse } from './family'

export function useFamily(productId: string) {
  const [family, setFamily] = useState<FamilyResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)
  const req = useRef(0)

  useEffect(() => {
    if (!productId) return
    const mine = ++req.current
    let cancelled = false
    setLoading(true)
    setError(null)
    fetch(`${getBackendUrl()}/api/pim/family/${encodeURIComponent(productId)}`, { credentials: 'include', cache: 'no-store' })
      .then(async (res) => {
        const body = await res.json().catch(() => null)
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`)
        return body as FamilyResponse
      })
      .then((body) => { if (!cancelled && mine === req.current) setFamily(body) })
      .catch((e: unknown) => { if (!cancelled && mine === req.current) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (!cancelled && mine === req.current) setLoading(false) })
    return () => { cancelled = true }
  }, [productId, nonce])

  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { family, loading, error, reload }
}
