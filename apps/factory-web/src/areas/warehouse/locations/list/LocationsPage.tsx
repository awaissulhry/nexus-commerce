'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { archiveLocation, moveLocation, stockOverview, type Uom } from '../../../_shared/stock/api'
import { csvOf, readProblem, TIME_ZONE, unitTotals } from '../../../_shared/stock/model'
import { StockMessages } from '../../../_shared/stock/parts'
import { chosenSite, CSV_COLUMNS, listAddressOf, listQuery, LOCATIONS_NAMESPACES, locationsCan, locationWriteProblem, type ListAddress, type PlaceRow } from '../model'
import { LocationsView, type LocationsListModel } from './view/LocationsView'
// B-W2b-327: places with their label code and block, the default locations, Block / Unblock, Print labels, parties.
import { blockPlace, createPlace, listPlaces, placeDefaults, placeParties, unblockPlace, type DefaultView, type PlaceSite } from '../depth/api'
import { blockProblemOf } from '../depth/model'
import { DEPTH_WORDS } from '../depth/view/DepthDialogs'
import { usePrint } from '../depth/usePrint'
import { wallOf } from '../../stock/daily/model'

/**
 * `/w/<company>/warehouse/locations` (SCR-065): reads this company's sites with their places (`GET /inventory/locations`,
 * archived too with `?archived=1`) and the shown site's stock (`GET /inventory/stock?siteId=`, inventory.stock.view) to
 * say what lies in each place; creates, moves and archives places (inventory.locations.manage), each answer read back
 * into the tree. Live `inventory.moved` waits behind "N updates · Show" (rows never move under the reader).
 */
export function LocationsPage() {
  return (
    <StockMessages extra={[...LOCATIONS_NAMESPACES, DEPTH_WORDS]}>
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
  const t = useT('warehouse-locations')
  const stockWords = useT('stock')
  const locale = useLocale()
  const prefix = pathname.replace(/\/warehouse\/locations\/?$/, '')
  const can = useMemo(() => locationsCan(session.permissions), [session.permissions])
  const address = listAddressOf(params)
  const companyId = session.company?.id ?? null

  const [sites, setSites] = useState<LocationsListModel['sites']>({ status: 'loading' })
  const [stock, setStock] = useState<LocationsListModel['stock']>({ value: null, problem: null })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<LocationsListModel['notice']>(null)
  const [defaults, setDefaults] = useState<DefaultView[] | null>(null)
  const [parties, setParties] = useState<LocationsListModel['parties']>(null)
  const readId = useRef(0)

  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${listQuery({ ...address, ...next })}`), [router, pathname, address])

  const loadStock = useCallback(
    async (siteId: string | null) => {
      // B-W2b-327: what each place is the default for (SCM-179; a failed read leaves the column "—").
      if (siteId)
        placeDefaults(api, siteId)
          .then((answer) => setDefaults(answer.defaults))
          .catch(() => setDefaults(null))
      if (!can.stock || !siteId) return
      try {
        const value = await stockOverview(api, { siteId })
        setStock({ value, problem: null })
      } catch (error) {
        setStock({ value: null, problem: readProblem(error) })
      }
    },
    [api, can.stock],
  )

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const answer = await listPlaces(api, { includeArchived: address.archived })
      if (id !== readId.current) return
      const items = answer.sites.filter((site) => !companyId || site.companyId === companyId)
      setSites({ status: 'ready', items })
      setAsOf(new Date().toISOString())
      setUpdates(0)
      await loadStock(chosenSite(items, address.siteId)?.id ?? null)
    } catch (error) {
      if (id !== readId.current) return
      setSites({ status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, address.archived, address.siteId, companyId, loadStock])

  useEffect(() => {
    void load()
  }, [load])

  const site = (sites.status === 'ready' ? chosenSite(sites.items, address.siteId) : null) as PlaceSite | null

  const refresh = useCoalesced(() => setUpdates((count) => count + 1), 800)
  const live = useLive(
    (change) => {
      if (change.type === 'inventory.moved') refresh()
      // B-W2b-327: a block, a label code or a default changed: the tree reads again behind "N updates · Show".
      if (change.type === 'inventory.location_blocked' || change.type === 'inventory.location_label_changed' || change.type === 'inventory.default_location_changed') refresh()
    },
    () => void load(),
    can.view,
  )

  const exportRows = useCallback(
    (rows: readonly PlaceRow[]) => {
      const header = CSV_COLUMNS.map((column) => t(`lc.csv.${column}`))
      const unit = (uom: Uom) => stockWords(`uom.${uom}`)
      const lines = rows.map((row) => [
        row.location.code,
        row.location.name,
        stockWords(`locationKind.${row.location.kind}`),
        stockWords(`locationStatus.${row.location.status}`),
        row.location.path.join(' > '),
        row.inside,
        row.stock?.lines ?? '',
        row.stock?.hides ?? '',
        row.stock ? unitTotals(row.stock.quantities, unit, locale) : '',
      ])
      downloadText(`locations-${site?.code ?? 'site'}-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [t, stockWords, site?.code, locale],
  )

  // One write at a time; each answer is read back into the tree (the API's own placement of the place).
  const afterWrite = useCallback(
    async (key: string, params: Record<string, string>) => {
      setNotice({ tone: 'success', key, params })
      await load()
    },
    [load],
  )

  const print = usePrint(api, { printLabels: session.permissions.includes('print.labels') && session.permissions.includes('print.view'), printView: session.permissions.includes('print.view'), manage: can.manage }, () => void load())

  const model: LocationsListModel = {
    prefix,
    can,
    sites,
    site,
    address,
    stock,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    notice,
    defaults,
    print: print.model,
    today: wallOf(Date.now(), TIME_ZONE).day,
    parties,
    permissions: session.permissions,
  }

  return (
    <LocationsView
      model={model}
      printActions={print.actions}
      actions={{
        onSite: (siteId) => go({ siteId }),
        onArchived: (show) => go({ archived: show }),
        onSearch: (q) => go({ q }),
        onRetry: () => {
          setSites({ status: 'loading' })
          void load()
        },
        onShowUpdates: () => void load(),
        onOpen: (location) => router.push(`${prefix}/warehouse/locations/${encodeURIComponent(location.id)}`),
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onCreate: async (form) => {
          if (!site) return { key: 'lc.problem.write' }
          try {
            const { location } = await createPlace(api, { siteId: site.id, parentId: form.parentId, code: form.code, name: form.name, kind: form.kind, ...(form.partyId ? { partyId: form.partyId } : {}) })
            await afterWrite('lc.done.created', { code: location.code })
            return null
          } catch (error) {
            return locationWriteProblem(error)
          }
        },
        onMove: async (location, parentId) => {
          try {
            const { location: moved } = await moveLocation(api, location.id, { version: location.version, parentId })
            await afterWrite('lc.done.moved', { code: moved.code, place: moved.path.slice(0, -1).join(' › ') || site?.code || '' })
            return null
          } catch (error) {
            return locationWriteProblem(error)
          }
        },
        onArchive: async (location) => {
          try {
            const { location: archived } = await archiveLocation(api, location.id, location.version)
            await afterWrite('lc.done.archived', { code: archived.code })
            return null
          } catch (error) {
            return locationWriteProblem(error)
          }
        },
        // B-W2b-327: Block / Unblock (one command each, the version read), Print labels, the parties of a new place.
        onBlock: async (place, draft) => {
          try {
            await blockPlace(api, place.id, { version: place.version, reason: draft.reason as Exclude<typeof draft.reason, ''>, note: draft.note.trim() || null, until: draft.until || null }, newIdempotencyKey())
            setNotice({ tone: 'success', key: 'wd.loc.done.blocked', params: { code: place.code } })
            await load()
            return null
          } catch (error) {
            return blockProblemOf(error)
          }
        },
        onUnblock: async (place) => {
          try {
            await unblockPlace(api, place.id, place.version, newIdempotencyKey())
            setNotice({ tone: 'success', key: 'wd.loc.done.unblocked', params: { code: place.code } })
            await load()
            return null
          } catch (error) {
            return blockProblemOf(error)
          }
        },
        onPrint: (places) => {
          if (!site || places.length === 0) return
          print.open(places, site.id, site.code, locale === 'en' ? 'en' : 'it')
        },
        onParties: (roles) => {
          setParties({ status: 'loading' })
          placeParties(api, roles)
            .then((value) => setParties({ status: 'ready', value }))
            .catch((error: unknown) => setParties({ status: 'error', problem: readProblem(error) }))
        },
      }}
    />
  )
}

