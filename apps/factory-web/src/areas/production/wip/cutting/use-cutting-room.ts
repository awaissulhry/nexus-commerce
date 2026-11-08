'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useOfficeScope } from '../../../../shell/scope/scope-context'
import { useCoalesced } from '../../_shared/hooks'
import { readProblem } from '../../_shared/model'
import { getCutboard, type Cutboard } from './api'
import { CUTBOARD_LIVE_MS, cutboardLiveTouches } from './model'

/** The section's read: one board per site of the top bar's scope, or why it failed; neither while the first read runs. */
export interface CuttingRead {
  readonly value: readonly Cutboard[] | null
  readonly problem: string | null
}

/**
 * Floor now's Cutting room reads (B-W2b-130): one GET /production/cutboard per site of the top bar's scope (all the person's sites
 * when none is picked; a site the person may not read the cutting room at is left out, as the API refuses it). A person without
 * production.cutting.view never reads it. Live: cut orders, tickets, lays, the fabric used and the cut log re-read it at most every
 * 5 seconds.
 */
export function useCuttingRoom(api: ApiClient, can: boolean) {
  const scope = useOfficeScope()
  const siteIds = useMemo(() => (scope.siteId ? [scope.siteId] : scope.sites.map((site) => site.id)), [scope.siteId, scope.sites])
  const key = siteIds.join(',')
  const [state, setState] = useState<CuttingRead>({ value: null, problem: null })

  const load = useCallback(() => {
    if (!can) return
    const asked: readonly (string | null)[] = siteIds.length ? siteIds : [null]
    Promise.allSettled(asked.map((siteId) => getCutboard(api, siteId))).then((answers) => {
      const boards = answers.flatMap((answer) => (answer.status === 'fulfilled' ? [answer.value] : []))
      const failed = answers.find((answer): answer is PromiseRejectedResult => answer.status === 'rejected')
      if (boards.length === 0 && failed) setState({ value: null, problem: readProblem(failed.reason) })
      else setState({ value: boards, problem: null })
    })
  }, [api, can, siteIds])

  useEffect(() => {
    load()
    // `key`: the same sites in a new array read nothing again.
  }, [key, can])

  const reread = useCoalesced(load, CUTBOARD_LIVE_MS)
  const onLive = useCallback(
    (change: { type: string }) => {
      if (can && cutboardLiveTouches(change)) reread()
    },
    [can, reread],
  )

  return { state, load, onLive }
}
