'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { downloadText, useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { listLocations, type SiteLocations } from '../../../_shared/stock/api'
import { csvOf } from '../../../_shared/stock/model'
import { countSheets, countTiles, createCount, findMaterials, listCounts, lotsOf, type CountRow, type CountTiles, type NewCountBody } from '../api'
import { addressOf, addressText, COUNT_CSV_COLUMNS, countProblem, countsCan, isCountEvent, readProblem, TIME_ZONE, viewQuery, yearEndChoices, type CountsAddress } from '../model'
import { CountsMessages, scopeText, useWords } from '../parts'
import type { CountsListModel, NewCountDraft, NewCountModel, Notice, PlaceChoice, SiteChoice } from '../view-model'
import { openPdf } from '../papers'
import { CountsListView } from './view/CountsListView'

/**
 * `/w/<company>/warehouse/counts` (SCR-132): the saved row (`?view=`), the search (`?q=`) and the site (`?site=`) in the
 * address, `?new=1` the New count dialog; the counts 50 a page with "Show more"; the tiles; live count events behind
 * "N updates · Show" (the tiles follow at once). New count creates through `POST /inventory/stock-counts` and opens the
 * count. Export N writes the selected rows as CSV; row ⋯ prints the count sheets (a PDF in a new tab).
 */
export function CountsPage() {
  return (
    <CountsMessages>
      <CountsContainer />
    </CountsMessages>
  )
}

const PAGE = 50

function placesOf(site: SiteLocations | undefined): PlaceChoice[] | null {
  if (!site) return null
  return site.locations.filter((location) => location.status === 'ACTIVE').map((location) => ({ id: location.id, code: location.code, name: location.name, depth: location.depth }))
}

function CountsContainer() {
  const t = useWords()
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => countsCan(session.permissions), [session.permissions])
  const address = addressOf(params)
  const { view, q, siteId } = address

  const [rows, setRows] = useState<CountsListModel['rows']>({ items: null, more: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<CountTiles | null>(null)
  const [trees, setTrees] = useState<SiteLocations[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)

  const go = useCallback((next: Partial<CountsAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  useEffect(() => {
    if (!can.locations) return
    listLocations(api, {})
      .then((answer) => setTrees(answer.sites.filter((site) => !session.company || site.companyId === session.company.id)))
      .catch(() => setTrees([]))
  }, [api, can.locations, session.company])
  const sites: SiteChoice[] = useMemo(() => trees.map((site) => ({ id: site.id, code: site.code, name: site.name })), [trees])

  const { query, keep } = useMemo(() => viewQuery(view), [view])
  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const [page, counted] = await Promise.all([listCounts(api, { ...query, q, siteId, limit: PAGE }), countTiles(api, siteId)])
      if (id !== readId.current) return
      setRows({ items: page.counts.filter(keep), more: page.nextCursor !== null, problem: null })
      setCursor(page.nextCursor)
      setTiles(counted)
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
      setTiles(null)
    }
  }, [api, can.view, query, keep, q, siteId])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listCounts(api, { ...query, q, siteId, cursor, limit: PAGE })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.counts.filter(keep).filter((row) => !current.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, query, keep, q, siteId])

  const refreshTiles = useCoalesced(() => {
    countTiles(api, siteId)
      .then(setTiles)
      .catch(() => undefined)
  }, 1000)
  const live = useLive(
    (change) => {
      if (isCountEvent(change.type)) {
        setUpdates((count) => count + 1)
        refreshTiles()
      }
    },
    () => void load(),
    can.view,
  )

  // ---- New count ------------------------------------------------------------------------------------------------------------

  const years = useMemo(() => yearEndChoices(new Date()), [])
  const blank = useCallback(
    (): NewCountDraft => ({ siteId: siteId ?? (sites.length === 1 ? sites[0]!.id : null), kind: 'CYCLE', year: years.preset, locationId: null, item: null, lotId: null, itemKind: null, team: '', note: '', start: true }),
    [siteId, sites, years.preset],
  )
  const [draft, setDraft] = useState<NewCountDraft | null>(null)
  const [found, setFound] = useState<NewCountModel['found']>(null)
  const [searching, setSearching] = useState(false)
  const [lots, setLots] = useState<NewCountModel['lots']>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<NewCountModel['problem']>(null)
  const open = address.isNew && can.view

  useEffect(() => {
    if (open && draft === null) setDraft(blank())
    if (!open && draft !== null) {
      setDraft(null)
      setFound(null)
      setLots(null)
      setProblem(null)
    }
  }, [open, draft, blank])
  // One site only: it is chosen as soon as the sites are known.
  useEffect(() => {
    if (draft && !draft.siteId && sites.length === 1) setDraft({ ...draft, siteId: sites[0]!.id })
  }, [draft, sites])

  const itemId = draft?.item?.id ?? null
  const draftSite = draft?.siteId ?? null
  useEffect(() => {
    setLots(null)
    if (!itemId || !draftSite || !can.stock) return
    const controller = new AbortController()
    lotsOf(api, draftSite, itemId, controller.signal)
      .then(setLots)
      .catch(() => setLots([]))
    return () => controller.abort()
  }, [api, itemId, draftSite, can.stock])

  const find = useCallback(
    (text: string) => {
      if (!can.materials || text.trim().length < 2) {
        setFound(null)
        return
      }
      setSearching(true)
      findMaterials(api, text)
        .then(setFound)
        .catch(() => setFound([]))
        .finally(() => setSearching(false))
    },
    [api, can.materials],
  )

  const create = useCallback(async () => {
    if (!draft || !draft.siteId || busy) return
    const body: NewCountBody = {
      siteId: draft.siteId,
      kind: draft.kind,
      ...(draft.locationId ? { locationId: draft.locationId } : {}),
      ...(draft.item ? { itemId: draft.item.id } : {}),
      ...(draft.item && draft.lotId ? { lotId: draft.lotId } : {}),
      ...(draft.itemKind ? { itemKind: draft.itemKind } : {}),
      ...(draft.kind === 'YEAR_END' ? { inventoryDate: `${draft.year}-12-31` } : {}),
      ...(draft.team.trim() ? { countTeam: draft.team.trim() } : {}),
      ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
      ...(draft.start ? { start: true } : {}),
    }
    setBusy(true)
    setProblem(null)
    try {
      const count = await createCount(api, body)
      router.push(`${prefix}/warehouse/counts/${encodeURIComponent(count.id)}`)
    } catch (error) {
      setProblem(countProblem(error))
    } finally {
      setBusy(false)
    }
  }, [api, draft, busy, router, prefix])

  const newCount: NewCountModel | null = open && draft ? { draft, places: placesOf(trees.find((site) => site.id === draft.siteId)), found, searching, lots, years: years.years, now: new Date().toISOString(), busy, problem } : null

  // ---- Export, sheets ---------------------------------------------------------------------------------------------------------

  const exportRows = useCallback(
    (ids: readonly string[]) => {
      const picked = (rows.items ?? []).filter((row) => ids.includes(row.id))
      const header = COUNT_CSV_COLUMNS.map((column) => t(`csv.${column}`))
      const lines = picked.map((row: CountRow) => [
        row.number,
        t(`kind.${row.kind}`),
        t(`status.${row.status}`),
        row.site.code,
        scopeText(t, row.scope),
        row.inventoryDate ?? '',
        row.countTeam ?? '',
        row.lines.counted,
        row.lines.all,
        row.lines.differing,
        can.cost && row.differenceAmount !== undefined && row.differenceAmount !== null ? (row.differenceAmount / 100).toFixed(2) : '',
        can.cost ? row.currency : '',
        row.startedAt ?? '',
        row.submittedAt ?? '',
        row.appliedAt ?? '',
        row.signedOffAt ?? '',
      ])
      downloadText(`counts-${new Date().toISOString().slice(0, 10)}.csv`, csvOf(header, lines))
    },
    [rows.items, t, can.cost],
  )

  const sheets = useCallback(
    (id: string, expected: boolean) => {
      void openPdf(() => countSheets(api, id, expected, locale === 'en' ? 'en' : 'it'), `count-sheets-${id}.pdf`).catch((error: unknown) => setNotice({ tone: 'danger', words: countProblem(error) }))
    },
    [api, locale],
  )

  const model: CountsListModel = { prefix, can, view, q, sites, siteId, rows, tiles, asOf, live, updates, timeZone: TIME_ZONE, newCount, notice }

  return (
    <CountsListView
      model={model}
      actions={{
        onView: (next) => go({ view: next }),
        onSearch: (next) => go({ q: next }),
        onSite: (next) => go({ siteId: next }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => router.push(`${prefix}/warehouse/counts/${encodeURIComponent(id)}`),
        onNew: () => go({ isNew: true }),
        onClose: () => go({ isNew: false }),
        onDraft: (patch) => setDraft((current) => (current ? { ...current, ...patch } : current)),
        onFind: find,
        onCreate: () => void create(),
        onExport: exportRows,
        onSheets: sheets,
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
