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
// B-W2b-320: the W2b views (Depleted, Documents expiring) read B-W2b-313's list; a W1 view's rows get their W2b columns by id.
import { factsOf, listLotsDepth, type DepthCounts, type DepthFacts } from '../depth/api'
import { DEPTH_NAMESPACE, depthViewQuery, isDepthView } from '../depth/model'
import { useT } from '../../../../lib/i18n/provider'

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
  const [facts, setFacts] = useState<Record<string, DepthFacts> | null>(null)
  const [depthCounts, setDepthCounts] = useState<DepthCounts | null>(null)
  const td = useT(DEPTH_NAMESPACE)
  /** B-W2b-320: the W2b columns of these rows (a refused or older read leaves them out: the column says "—"). */
  const enrich = useCallback(
    async (ids: readonly string[], keep: boolean) => {
      if (ids.length === 0) {
        if (!keep) setFacts({})
        return
      }
      try {
        const page = await listLotsDepth(api, { ids, view: 'ALL', siteId, limit: 200 })
        const read = Object.fromEntries(page.lots.map((row) => [row.id, factsOf(row)]))
        setFacts((current) => (keep && current ? { ...current, ...read } : read))
        setDepthCounts(page.counts)
      } catch {
        if (!keep) setFacts(null)
      }
    },
    [api, siteId],
  )

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
      // B-W2b-320: a W2b view reads B-W2b-313's list (its rows are W1's rows with the W2b columns); the W1 tiles beside it.
      const depthView = isDepthView(view)
      const [page, depthPage] = await Promise.all([listLots(api, depthView ? { ...lotQuery('all', q, siteId), limit: 1 } : lotQuery(view, q, siteId)), depthView ? listLotsDepth(api, { ...depthViewQuery(view), siteId, q, limit: 50 }) : Promise.resolve(null)])
      if (id !== readId.current) return
      const shown: readonly LotRow[] = depthPage ? depthPage.lots : page.lots
      const next = depthPage ? depthPage.nextCursor : page.nextCursor
      setRows({ items: shown, more: next !== null, problem: null })
      setCursor(next)
      setCounts(page.counts)
      if (depthPage) {
        setFacts(Object.fromEntries(depthPage.lots.map((row) => [row.id, factsOf(row)])))
        setDepthCounts(depthPage.counts)
      } else void enrich(page.lots.map((row) => row.id), false)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      // A scanned or typed lot code that is the one hit opens its record (design R7).
      if (searched.current) {
        searched.current = false
        const hit = exactLot(q, shown)
        if (hit) router.push(`${prefix}/warehouse/lots/${encodeURIComponent(hit)}`)
      }
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setCounts(null)
    }
  }, [api, can.stockView, view, q, siteId, prefix, router, enrich])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      // B-W2b-320: a W2b view's next page comes from B-W2b-313's list (with its columns); a W1 view's gets them by id.
      const depthPage = isDepthView(view) ? await listLotsDepth(api, { ...depthViewQuery(view), siteId, q, cursor, limit: 50 }) : null
      const w1Page = depthPage ? null : await listLots(api, lotQuery(view, q, siteId, cursor))
      const lots: readonly LotRow[] = depthPage ? depthPage.lots : w1Page!.lots
      const next = depthPage ? depthPage.nextCursor : w1Page!.nextCursor
      setRows((current) => ({ items: [...(current.items ?? []), ...lots.filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: next !== null, problem: null }))
      setCursor(next)
      if (depthPage) setFacts((current) => ({ ...(current ?? {}), ...Object.fromEntries(depthPage.lots.map((row) => [row.id, factsOf(row)])) }))
      else void enrich(lots.map((row) => row.id), true)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, view, q, siteId, enrich])

  // Live: a move or a quality decision → the tiles follow at once (coalesced), the rows wait behind "N updates · Show".
  const refreshCounts = useCoalesced(() => {
    listLots(api, { ...lotQuery(isDepthView(view) ? 'all' : view, q, siteId), limit: 1 })
      .then((page) => setCounts(page.counts))
      .catch(() => undefined)
    listLotsDepth(api, { view: 'ALL', siteId, limit: 1 })
      .then((page) => setDepthCounts(page.counts))
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
      const header = [...LOT_CSV_COLUMNS.map((column) => t(`lt.csv.${column}`)), td('ld.csv.lifecycle')]
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
        facts?.[row.id] ? td(`ld.life.state.${facts[row.id]!.lifecycle}`) : '',
      ])
      downloadText(`lots-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, t, td, facts],
  )

  const release = useRelease(api, (count) => t('lt.rel.phraseWord', { count }), () => void load())
  const find = useTraceFind(api, prefix)

  const model: LotsListModel = { prefix, can, view, q, sites, siteId, rows, counts, asOf, live, updates, timeZone: TIME_ZONE, daily, release: release.model, find: find.model, depth: { facts, counts: depthCounts } }

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
