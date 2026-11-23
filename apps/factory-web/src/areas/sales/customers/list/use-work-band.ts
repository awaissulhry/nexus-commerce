'use client'

import { useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useLiveBus } from '../../../../shell/live/use-live'
import type { PartyQuery, PartyWorkBand } from '../../../parties/_shared/api'
import { problemKey } from '../../../parties/_shared/model'
import { readWorkBand } from './api'
import { workTouchedBy } from './model'
import { WORK_REREAD_MS } from './use-customers-work'

/** The band: read (null while it reads), or its problem. */
export interface WorkBandRead {
  readonly band: PartyWorkBand | null
  readonly problem: string | null
}

/**
 * F-CL-201 (13-backend §8.6, settle T5): the band — ONE `GET /parties?<the list's terms>&limit=1&band=true` on load, on a change of
 * the list's terms (view, search, chips: never its own door, its order or its page), and after a live change (coalesced). Only with
 * orders.view (`enabled`).
 */
export function useWorkBand(api: ApiClient, terms: PartyQuery, enabled: boolean): WorkBandRead {
  const [read, setRead] = useState<WorkBandRead>({ band: null, problem: null })
  const [tick, setTick] = useState(0)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useLiveBus(
    {
      onChange: (change) => {
        if (!workTouchedBy(change.type) && !change.type.startsWith('party.')) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => setTick((count) => count + 1), WORK_REREAD_MS)
      },
      onReconnect: () => setTick((count) => count + 1),
    },
    enabled,
  )
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  const key = JSON.stringify(terms)
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    readWorkBand(api, JSON.parse(key) as PartyQuery, abort.signal).then(
      (band) => !abort.signal.aborted && setRead({ band, problem: null }),
      (error: unknown) => !abort.signal.aborted && setRead({ band: null, problem: problemKey(error) }),
    )
    return () => abort.abort()
  }, [api, enabled, key, tick])
  return read
}
