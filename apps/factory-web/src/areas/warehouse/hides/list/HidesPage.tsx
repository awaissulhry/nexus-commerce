'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { listHides, listLocations, type HideRow, type HidesPage as HidesAnswer } from '../../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import type { SiteChoice } from '../../lots/model'
import { LotsMessages, useWords } from '../../lots/shared/parts'
import { exactHide, filtersOf, HIDE_CSV_COLUMNS, hideQuery, hideViewOf, type HideFilters, type HidesListModel, type HideView } from '../model'
import { usePrintTags } from '../print/usePrintTags'
import { HidesListView } from './view/HidesListView'

/**
 * `/w/<company>/warehouse/hides` (SCR-200): the view (`?view=`, or the API's own `?state=` `?quality=` `?inStock=`), the
 * search (`?q=`: a typed or scanned tag; one exact hit opens the hide), the site (`?site=`) and the narrowing filters
 * (`?lot=` `?grade=` `?shade=` `?location=`) in the address; the hides 50 a page with "Show more", the tiles and the
 * filter's two numbers; live inventory.* and production.cut_* events behind "N updates · Show"; Print N tags.
 */
export function HidesPage() {
  return (
    <LotsMessages>
      <HidesContainer />
    </LotsMessages>
  )
}

const FILTER_PARAM: Readonly<Record<keyof HideFilters, string>> = { lotId: 'lot', grade: 'grade', shade: 'shade', locationId: 'location' }

function HidesContainer() {
  const t = useWords()
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const view = hideViewOf(params)
  const q = params?.get('q') ?? ''
  const siteId = params?.get('site') ?? null
  const filters = useMemo(() => filtersOf(params), [params])

  const [rows, setRows] = useState<HidesListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<HidesAnswer['counts'] | null>(null)
  const [matching, setMatching] = useState<HidesAnswer['matching'] | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const readId = useRef(0)
  const searched = useRef(false)
  const rowsRef = useRef<readonly HideRow[]>([])
  rowsRef.current = rows.items ?? []

  const address = useCallback(
    (next: { view?: HideView; q?: string; site?: string | null; drop?: keyof HideFilters }) => {
      const query = new URLSearchParams()
      query.set('view', next.view ?? view)
      const nextQ = next.q ?? q
      if (nextQ.trim()) query.set('q', nextQ.trim())
      const nextSite = next.site === undefined ? siteId : next.site
      if (nextSite) query.set('site', nextSite)
      for (const [name, value] of Object.entries(filters) as [keyof HideFilters, string | null][]) if (value && name !== next.drop) query.set(FILTER_PARAM[name], value)
      return `${pathname}?${query.toString()}`
    },
    [pathname, view, q, siteId, filters],
  )

  useEffect(() => {
    if (!can.locationsView) return
    listLocations(api, {})
      .then((answer) => setSites(answer.sites.filter((site) => !session.company || site.companyId === session.company.id).map((site) => ({ id: site.id, code: site.code, name: site.name }))))
      .catch(() => setSites([]))
  }, [api, can.locationsView, session.company])

  const load = useCallback(async () => {
    if (!can.stockView) return
    const id = ++readId.current
    try {
      const page = await listHides(api, hideQuery(view, q, siteId, filters))
      if (id !== readId.current) return
      setRows({ items: page.hides, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setCounts(page.counts)
      setMatching(page.matching)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      if (searched.current) {
        searched.current = false
        const hit = exactHide(q, page.hides)
        if (hit) router.push(`${prefix}/warehouse/hides/${encodeURIComponent(hit)}`)
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setCounts(null)
      setMatching(null)
    }
  }, [api, can.stockView, view, q, siteId, filters, prefix, router])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listHides(api, hideQuery(view, q, siteId, filters, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.hides.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, view, q, siteId, filters])

  // Live: a move or a cut → the tiles follow (coalesced), the rows wait behind "N updates · Show".
  const refreshCounts = useCoalesced(() => {
    listHides(api, { ...hideQuery(view, q, siteId, filters), limit: 1 })
      .then((page) => {
        setCounts(page.counts)
        setMatching(page.matching)
      })
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (change.type.startsWith('inventory.') || change.type.startsWith('production.cut')) {
        setUpdates((count) => count + 1)
        refreshCounts()
      }
    },
    () => void load(),
    can.stockView,
  )

  const unitWord = useCallback((uom: HideRow['areaUom']) => t(`stock:uom.${uom}`), [t])
  const hidesOf = useCallback((ids: readonly string[]) => rowsRef.current.filter((row) => ids.includes(row.id)), [])
  const print = usePrintTags(api, locale, unitWord, hidesOf)

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = HIDE_CSV_COLUMNS.map((column) => t(`hd.csv.${column}`))
      const lines = picked.map((row) => [
        row.code,
        row.supplierCode ?? '',
        `${row.item.code} ${row.item.name}`,
        row.colour ? `${row.colour.code} ${row.colour.name}` : '',
        row.lot.code,
        t(`stock:quality.${row.lot.qualityStatus}`),
        row.lot.dyeBatch ?? '',
        row.shade ?? row.lot.shade ?? '',
        row.grade ?? '',
        row.area,
        t(`stock:uom.${row.areaUom}`),
        row.baseArea,
        row.left,
        t(`stock:uom.${row.item.baseUom}`),
        t(`stock:hideState.${row.state}`),
        row.location?.code ?? '',
        row.thicknessMm ?? '',
        row.defects ?? '',
        row.receivedAt ?? '',
      ])
      downloadText(`hides-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, t],
  )

  const model: HidesListModel = { prefix, can, view, q, filters, sites, siteId, rows, counts, matching, asOf, live, updates, timeZone: TIME_ZONE, print: print.dialog }

  return (
    <HidesListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => {
          searched.current = next.trim() !== ''
          router.replace(address({ q: next }))
        },
        onSite: (next) => router.replace(address({ site: next })),
        onClearFilter: (name) => router.replace(address({ drop: name })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/hides/${encodeURIComponent(id)}`),
        onExport: exportRows,
        print: print.actions,
      }}
    />
  )
}
