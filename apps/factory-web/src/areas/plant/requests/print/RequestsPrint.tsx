'use client'

import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { listRequests, plantPlaces, type MaintenanceRequest } from '../../_shared/api'
import { readProblem } from '../../_shared/model'
import { RequestsPrintView } from './view/RequestsPrintView'

/**
 * `/w/<company>/plant/requests/print?site=` (SCR-148 tab:print): the open requests of the site (every site the person's
 * plant.view reaches without one), read once, drawn for paper.
 */
export function RequestsPrint() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const siteId = params?.get('site') || null
  const [at] = useState(() => new Date().toISOString())
  const [site, setSite] = useState<string | null>(null)
  const [requests, setRequests] = useState<{ value: MaintenanceRequest[] | null; problem: string | null }>({ value: null, problem: null })
  useEffect(() => {
    let live = true
    listRequests(api, { open: true, siteId, limit: 200 })
      .then((answer) => live && setRequests({ value: answer.requests, problem: null }))
      .catch((error: unknown) => live && setRequests({ value: null, problem: readProblem(error) }))
    if (siteId)
      plantPlaces(api)
        .then((sites) => {
          const found = sites.find((entry) => entry.id === siteId)
          if (live && found) setSite(`${found.code} · ${found.name}`)
        })
        .catch(() => undefined)
    return () => {
      live = false
    }
  }, [api, siteId])
  const model = useMemo(() => ({ person: session.user.displayName, site, at, requests }), [session.user.displayName, site, at, requests])
  return <RequestsPrintView model={model} />
}
