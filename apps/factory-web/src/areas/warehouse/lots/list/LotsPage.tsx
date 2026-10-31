'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { listLocations, listLots, type LotCounts, type LotRow } from '../../../_shared/stock/api'
import { csvOf, readProblem, stockCan, TIME_ZONE } from '../../../_shared/stock/model'
import { exactLot, LOT_CSV_COLUMNS, lotQuery, lotViewOf, type LotsListModel, type LotView, type SiteChoice } from '../model'
import { LotsMessages, useWords } from '../shared/parts'
import { dailyCan } from '../shared/daily'
import { useRelease } from '../release/useRelease'
import { useTraceFind } from '../trace/useTraceFind'
import { LotsListView } from './view/LotsListView'

/**
 * `/w/<company>/warehouse/lots` (SCR-201): the view (`?view=`, or the API's own `?onHold=true` `?quality=` `?crVi=`), the
 * search (`?q=`: a typed or scanned lot code; one exact hit opens the lot) and the site (`?site=`) in the address; the lots
 * 50 a page with "Show more"; the tiles' counts; live inventory.* and lot.* events behind "N updates · Show". B-W2a-64:
 * Release N lots (each lot's release check, then Compliance's release lot by lot) and the Trace dialog.
 */
export function LotsPage() {
  return (
    <LotsMessages>
      <LotsContainer />
    </LotsMessages>
  )
}

function LotsContainer() {
  const t = useWords()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => stockCan(session.permissions), [session.permissions])
  const daily = useMemo(() => dailyCan(session.permissions), [session.permissions])
  const view = lotViewOf(params, can)
  const q = params?.get('q') ?? ''
  const siteId = params?.get('site') ?? null

  const [rows, setRows] = useState<LotsListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<LotCounts | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const readId = useRef(0)
  const searched = useRef(false)

  const address = useCallback(
    (next: { view?: LotView; q?: string; site?: string | null }) => {
      const query = new URLSearchParams()
      query.set('view', next.view ?? view)
      const nextQ = next.q ?? q
      if (nextQ.trim()) query.set('q', nextQ.trim())
      const nextSite = next.site === undefined ? siteId : next.site
      if (nextSite) query.set('site', nextSite)
      return `${pathname}?${query.toString()}`
    },
    [pathname, view, q, siteId],
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
      const page = await listLots(api, lotQuery(view, q, siteId))
      if (id !== readId.current) return
      setRows({ items: page.lots, more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setCounts(page.counts)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      // A scanned or typed lot code that is the one hit opens its record (design R7).
      if (searched.current) {
        searched.current = false
        const hit = exactLot(q, page.lots)
        if (hit) router.push(`${prefix}/warehouse/lots/${encodeURIComponent(hit)}`)
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setCounts(null)
    }
  }, [api, can.stockView, view, q, siteId, prefix, router])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listLots(api, lotQuery(view, q, siteId, cursor))
      setRows((current) => ({ items: [...(current.items ?? []), ...page.lots.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, view, q, siteId])

  // Live: a move or a quality decision → the tiles follow at once (coalesced), the rows wait behind "N updates · Show".
  const refreshCounts = useCoalesced(() => {
    listLots(api, { ...lotQuery(view, q, siteId), limit: 1 })
      .then((page) => setCounts(page.counts))
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (change.type.startsWith('inventory.') || change.type.startsWith('lot.')) {
        setUpdates((count) => count + 1)
        refreshCounts()
      }
    },
    () => void load(),
    can.stockView,
  )

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = LOT_CSV_COLUMNS.map((column) => t(`lt.csv.${column}`))
      const lines = picked.map((row: LotRow) => [
        row.code,
        `${row.item.code} ${row.item.name}`,
        row.colour ? `${row.colour.code} ${row.colour.name}` : '',
        row.supplier?.name ?? '',
        row.supplierLotRef ?? '',
        row.dyeBatch ?? '',
        row.shade ?? '',
        row.receivedAt ?? '',
        row.receipt?.number ?? (row.opening ? t('lt.opening') : ''),
        t(`stock:quality.${row.qualityStatus}`),
        t(`stock:crVi.${row.crVi.status}`),
        row.crVi.valueMgKg ?? '',
        row.crVi.evidence ? t(`stock:evidence.${row.crVi.evidence}`) : '',
        row.documents,
        row.onHand,
        t(`stock:uom.${row.item.baseUom}`),
        row.hides,
        row.issuedTo,
      ])
      downloadText(`lots-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, t],
  )

  const release = useRelease(api, (count) => t('lt.rel.phraseWord', { count }), () => void load())
  const find = useTraceFind(api, prefix)

  const model: LotsListModel = { prefix, can, view, q, sites, siteId, rows, counts, asOf, live, updates, timeZone: TIME_ZONE, daily, release: release.model, find: find.model }

  return (
    <LotsListView
      model={model}
      actions={{
        onView: (next) => router.replace(address({ view: next })),
        onSearch: (next) => {
          searched.current = next.trim() !== ''
          router.replace(address({ q: next }))
        },
        onSite: (next) => router.replace(address({ site: next })),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/lots/${encodeURIComponent(id)}`),
        onExport: exportRows,
        onRelease: (ids) => release.open((rows.items ?? []).filter((row) => ids.includes(row.id))),
        release: release.actions,
        onTrace: find.open,
        find: find.actions,
      }}
    />
  )
}
