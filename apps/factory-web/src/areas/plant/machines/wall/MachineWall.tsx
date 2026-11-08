'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { plantPlaces } from '../../_shared/api'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { isMachineEvent, plantCan, readProblem } from '../../_shared/model'
import type { Loaded } from '../../_shared/parts'
import { readWall, type WallAnswer } from '../depth/api'
import { WALL_FILTERS, type WallFilter } from '../depth/model'
import { WallTabView } from './view/WallTabView'

/**
 * `/w/<company>/plant/machines/wall?site=&show=` (SCR-150-wall, a new tab from Machines & tools ⋯ "Status wall (new tab)"):
 * the wall read once and again on every machine change (coalesced: a burst of reports reads it once), the status filter in
 * the address so a screen left open keeps it. Read-only.
 */
export function MachineWall() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => plantCan(session.permissions), [session.permissions])
  const siteId = params?.get('site') || null
  const asked = params?.get('show') ?? ''
  const [filter, setFilter] = useState<WallFilter>((WALL_FILTERS as readonly string[]).includes(asked) ? (asked as WallFilter) : 'ALL')
  const [loaded, setLoaded] = useState<Loaded<WallAnswer>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [siteCode, setSiteCode] = useState<string | null>(null)
  const turn = useRef(0)
  const load = useCallback(() => {
    if (!can.view) return
    const mine = ++turn.current
    readWall(api, siteId)
      .then((value) => {
        if (mine !== turn.current) return
        setLoaded({ status: 'ready', value })
        setAsOf(value.at)
      })
      .catch((error: unknown) => mine === turn.current && setLoaded(isApiError(error) && error.kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) }))
  }, [api, can.view, siteId])
  useEffect(() => {
    load()
  }, [load])
  useEffect(() => {
    if (!can.view || !siteId) return
    plantPlaces(api)
      .then((sites) => setSiteCode(sites.find((site) => site.id === siteId)?.code ?? null))
      .catch(() => setSiteCode(null))
  }, [api, can.view, siteId])
  const coalesced = useCoalesced(load, 1000)
  const live = useLive(
    (change) => {
      if (isMachineEvent(change.type)) coalesced()
    },
    load,
    can.view,
  )
  const choose = useCallback((next: WallFilter) => {
    setFilter(next)
    const url = new URL(window.location.href)
    if (next === 'ALL') url.searchParams.delete('show')
    else url.searchParams.set('show', next)
    window.history.replaceState(null, '', url.toString())
  }, [])
  return <WallTabView model={{ prefix, canView: can.view, siteCode, loaded, filter, live, asOf }} actions={{ onFilter: choose, onRetry: load }} />
}
