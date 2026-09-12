'use client'

/**
 * PES.7 — fetching the two things a publish decision needs, and nothing more.
 *
 * Preflight (`/amazon-images/validate`) and the server's gate (`/listings/publish-readiness`) are
 * separate calls with separate failure modes, so they are held separately: a preflight that has not
 * answered must not be mistaken for a clean one, and a gate that has not answered must not be
 * mistaken for a closed one. `buildPublishPlan` treats each `null` as UNKNOWN and refuses to offer
 * a submission it cannot describe.
 *
 * Nothing is fetched until the operator opens the publish panel. Preflight walks every ASIN's
 * resolved plan; running it on every visit to the images tab would cost that for the many visits
 * that are not about publishing.
 */
import { useCallback, useMemo, useState } from 'react'

import { apiGet, routes, type ApiResult } from '../../api'
import type { PublishReadiness, PublishReadinessByChannel, ValidationResult } from './publishPlan'

interface RawValidation extends Omit<ValidationResult, 'blockedAsins'> { blockedAsins: string[] }
export interface PublishGate {
  readiness: PublishReadiness | null
  validation: ValidationResult | null
  loading: boolean
  /** Whichever call refused, in the server's words. */
  error: string | null
  refresh(): Promise<void>
}

export function usePublishGate(args: {
  productId: string
  market: string | null
  activeAxis: string | null
  write<T>(subject: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>>
}): PublishGate {
  const { productId, market, activeAxis } = args
  const [readiness, setReadiness] = useState<PublishReadiness | null>(null)
  const [validation, setValidation] = useState<ValidationResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!market) {
      setError('Choose a market before running preflight — Amazon validates per marketplace.')
      return
    }
    setLoading(true)
    setError(null)
    // Both are reads. They are independent, so one failing must not hide the other's answer.
    const [gate, pre] = await Promise.all([
      apiGet<PublishReadinessByChannel>(routes.publishReadiness()),
      apiGet<RawValidation>(routes.amazonValidate(productId, market, activeAxis)),
    ])
    if (gate.ok && gate.data?.amazon) setReadiness(gate.data.amazon)
    if (pre.ok && pre.data) {
      setValidation({
        hardFails: pre.data.hardFails ?? [],
        softWarnings: pre.data.softWarnings ?? [],
        blockedAsins: pre.data.blockedAsins ?? [],
        summary: pre.data.summary ?? { totalAsins: 0, asinsWithIssues: 0, asinsBlocked: 0 },
      })
    }
    // Say which one refused. "Preflight failed" when it was the gate that failed would send the
    // operator to the wrong place.
    const problems: string[] = []
    if (!gate.ok) problems.push(`Publish settings: ${gate.message}`)
    if (!pre.ok) problems.push(`Preflight: ${pre.message}`)
    setError(problems.length ? problems.join(' · ') : null)
    setLoading(false)
  }, [activeAxis, market, productId])

  // Memoised: a fresh object here breaks any consumer that correctly lists it as a
  // dependency — the memo never caches, and reads as though it does (PES ruling #156).
  return useMemo(
    () => ({ readiness, validation, loading, error, refresh }),
    [readiness, validation, loading, error, refresh],
  )
}
