'use client'

import { useEffect, useRef, useState } from 'react'
import { useOfficeApi } from '../../../../lib/session/context'
import { checkMaterial, type DuplicateCandidate, type MaterialCheck } from './api'

/**
 * The check on create (B-W2b-427; design materials.new "Duplicate warning"): the materials a new one looks like while it
 * is typed, 400 ms after the last change, the call before it cancelled. Kept apart from the page parts so a create
 * dialog loads only this. (New customer and New supplier check on leaving the VAT number and name fields: their list
 * container calls checkParty.)
 */

/** Waits this long after the last change before a check on create runs. */
const CHECK_DELAY_MS = 400

function useDebouncedCheck<Probe>(probe: Probe | null, run: (probe: Probe, signal: AbortSignal) => Promise<DuplicateCandidate[]>): DuplicateCandidate[] | null {
  const [found, setFound] = useState<DuplicateCandidate[] | null>(null)
  const key = probe ? JSON.stringify(probe) : ''
  const latest = useRef(run)
  latest.current = run
  useEffect(() => {
    if (!probe) {
      setFound(null)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      latest.current(probe, controller.signal).then(
        (next) => setFound(next),
        () => undefined,
      )
    }, CHECK_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // The probe's content is the dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return found
}

/** The materials a new material looks like, while it is typed (null: nothing worth checking yet). */
export function useMaterialDuplicates(probe: MaterialCheck | null): DuplicateCandidate[] | null {
  const api = useOfficeApi()
  const worth = probe && ((probe.code ?? '').trim().length >= 3 || (probe.name ?? '').trim().length >= 4 || (probe.supplierArticleCode ?? '').trim().length >= 3) ? probe : null
  return useDebouncedCheck(worth, (body, signal) => checkMaterial(api, body, signal))
}
