'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { archiveLocation, listLocations, moveLocation, stockOverview, updateLocation, type SiteLocations } from '../../../_shared/stock/api'
import { readProblem, TIME_ZONE } from '../../../_shared/stock/model'
import { StockMessages } from '../../../_shared/stock/parts'
import { LOCATIONS_NAMESPACES, locationsCan, locationWriteProblem, recordTabOf } from '../model'
import { LocationRecordView, type LocationRecordModel } from './view/LocationRecordView'

/**
 * `/w/<company>/warehouse/locations/<id>?tab=overview|stock&inside=1` (SCR-065, the Location record): reads the place's
 * site tree (`GET /inventory/locations?includeArchived=true`: the place, its parents and the places inside, any status)
 * and the site's stock (inventory.stock.view); saves the name and kind with the version read (409: someone saved
 * meanwhile → the typing stays behind Reload), moves and archives it. Live `inventory.moved` waits behind "N updates ·
 * Show".
 */
export function LocationRecord() {
  return (
    <StockMessages extra={LOCATIONS_NAMESPACES}>
      <Container />
    </StockMessages>
  )
}

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = useParams<{ id: string }>()
  const locationId = decodeURIComponent(route?.id ?? '')
  const prefix = pathname.replace(/\/warehouse\/locations\/[^/]+\/?$/, '')
  const can = useMemo(() => locationsCan(session.permissions), [session.permissions])
  const tab = recordTabOf(params?.get('tab'))
  const includeInside = params?.get('inside') === '1'
  const companyId = session.company?.id ?? null

  const [record, setRecord] = useState<LocationRecordModel['record']>({ status: 'loading' })
  const [stock, setStock] = useState<LocationRecordModel['stock']>({ value: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [notice, setNotice] = useState<LocationRecordModel['notice']>(null)
  const readId = useRef(0)

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const answer = await listLocations(api, { includeArchived: true })
      if (id !== readId.current) return
      const site: SiteLocations | undefined = answer.sites.find((entry) => (!companyId || entry.companyId === companyId) && entry.locations.some((location) => location.id === locationId))
      if (!site) {
        setRecord({ status: 'not_found' })
        return
      }
      setRecord({ status: 'ready', site })
      setAsOf(new Date().toISOString())
      setUpdates(0)
      if (can.stock) {
        try {
          setStock({ value: await stockOverview(api, { siteId: site.id }), problem: null })
        } catch (error) {
          setStock({ value: null, problem: readProblem(error) })
        }
      }
    } catch (error) {
      if (id !== readId.current) return
      setRecord(isApiError(error) && error.kind === 'not_found' ? { status: 'not_found' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, can.stock, companyId, locationId])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCoalesced(() => setUpdates((count) => count + 1), 800)
  const live = useLive(
    (change) => {
      if (change.type === 'inventory.moved') refresh()
    },
    () => void load(),
    can.view,
  )

  const location = record.status === 'ready' ? record.site.locations.find((entry) => entry.id === locationId) : undefined

  const model: LocationRecordModel = {
    prefix,
    can,
    locationId,
    record,
    stock,
    tab,
    includeInside,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    busy,
    conflict,
    savedAt,
    notice,
  }

  return (
    <LocationRecordView
      model={model}
      actions={{
        onSave: async (edit) => {
          if (!location) return { key: 'lc.problem.gone' }
          setBusy(true)
          try {
            await updateLocation(api, location.id, { version: location.version, name: edit.name, ...(edit.kind !== location.kind ? { kind: edit.kind } : {}) })
            setConflict(false)
            setSavedAt(new Date().toISOString())
            await load()
            return null
          } catch (error) {
            const refusal = locationWriteProblem(error)
            if (refusal.key === 'lc.problem.changed') {
              setConflict(true)
              return null
            }
            return refusal
          } finally {
            setBusy(false)
          }
        },
        onMove: async (target, parentId) => {
          try {
            const { location: moved } = await moveLocation(api, target.id, { version: target.version, parentId })
            setNotice({ tone: 'success', key: 'lc.done.moved', params: { code: moved.code, place: moved.path.slice(0, -1).join(' › ') || (record.status === 'ready' ? record.site.code : '') } })
            await load()
            return null
          } catch (error) {
            return locationWriteProblem(error)
          }
        },
        onArchive: async (target) => {
          try {
            const { location: archived } = await archiveLocation(api, target.id, target.version)
            setNotice({ tone: 'success', key: 'lc.done.archived', params: { code: archived.code } })
            await load()
            return null
          } catch (error) {
            return locationWriteProblem(error)
          }
        },
        onIncludeInside: (next) => router.replace(`${pathname}?tab=stock${next ? '&inside=1' : ''}`),
        onReload: () => {
          setConflict(false)
          void load()
        },
        onRetry: () => {
          setRecord({ status: 'loading' })
          void load()
        },
        onShowUpdates: () => void load(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
