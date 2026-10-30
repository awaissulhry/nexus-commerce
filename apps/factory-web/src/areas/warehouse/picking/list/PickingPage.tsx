'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useCoalesced, useLive } from '../../../_shared/buying/hooks'
import { phrase, readProblem, writeProblem } from '../../../_shared/stock/model'
import { createPickLists, listPickLists, pickListSheets, type CreateResult, type PickRow, type PickSheet, type PickTiles } from '../api'
import { addressOf, addressText, createChoices, isPickingEvent, pickingCan, printHref, TIME_ZONE, type PickingAddress } from '../model'
import { PickingMessages } from '../parts'
import type { CreateModel, Notice, PickingListModel, SiteChoice } from '../view-model'
import { PickingListView } from './view/PickingListView'

/**
 * `/w/<company>/warehouse/picking` (SCR-237): the saved row (`?view=`), the search (`?q=`) and the site (`?site=`) in the
 * address, `?open=<work order>` the pick list dialog, `?new=1` Create pick lists; rows 50 a page with "Show more"; the
 * tiles; live issues, reservations, holds and purchase order changes behind "N updates · Show" (the tiles follow at once).
 * Print opens the paper of the selection (or of the rows shown, at most 20) in a new tab.
 */
export function PickingPage() {
  return (
    <PickingMessages>
      <PickingContainer />
    </PickingMessages>
  )
}

const PAGE = 50

function PickingContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => pickingCan(session.permissions), [session.permissions])
  const address = addressOf(params)
  const { view, q, siteId } = address

  const [rows, setRows] = useState<PickingListModel['rows']>({ items: null, more: false, total: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [tiles, setTiles] = useState<PickTiles | null>(null)
  const [sites, setSites] = useState<SiteChoice[]>([])
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)

  const go = useCallback((next: Partial<PickingAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listPickLists(api, { siteId, view, q, limit: PAGE })
      if (id !== readId.current) return
      setRows({ items: page.rows, more: page.nextCursor !== null, total: page.total, problem: null })
      setCursor(page.nextCursor)
      setTiles(page.tiles)
      setSites(page.sites)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, total: null, problem: readProblem(error) })
      setTiles(null)
    }
  }, [api, can.view, siteId, view, q])

  useEffect(() => {
    setRows({ items: null, more: false, total: null, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor) return
    try {
      const page = await listPickLists(api, { siteId, view, q, cursor, limit: PAGE })
      setRows((current) => ({ items: [...(current.items ?? []), ...page.rows.filter((row) => !current.items?.some((seen) => seen.workOrder.id === row.workOrder.id))], more: page.nextCursor !== null, total: page.total, problem: null }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, more: false, problem: current.items ? null : readProblem(error) }))
    }
  }, [api, cursor, siteId, view, q])

  const refreshTiles = useCoalesced(() => {
    listPickLists(api, { siteId, view: 'all', q, limit: 1 })
      .then((page) => setTiles(page.tiles))
      .catch(() => undefined)
  }, 1500)

  // ---- the pick list dialog (`?open=`) ---------------------------------------------------------------------------------------
  const [sheet, setSheet] = useState<{ id: string; sheet: PickSheet | null; problem: string | null } | null>(null)
  const openId = address.open
  const readSheet = useCallback(
    (id: string) => {
      setSheet((current) => ({ id, sheet: current?.id === id ? current.sheet : null, problem: null }))
      pickListSheets(api, [id])
        .then((answer) => setSheet((current) => (current?.id === id ? { id, sheet: answer.sheets[0] ?? null, problem: answer.sheets[0] ? null : 'problem.gone' } : current)))
        .catch((error: unknown) => setSheet((current) => (current?.id === id ? { id, sheet: null, problem: readProblem(error) } : current)))
    },
    [api],
  )
  useEffect(() => {
    if (!can.view || !openId) {
      setSheet(null)
      return
    }
    readSheet(openId)
  }, [can.view, openId, readSheet])

  const live = useLive(
    (change) => {
      if (!isPickingEvent(change.type)) return
      setUpdates((count) => count + 1)
      refreshTiles()
      if (openId) readSheet(openId)
    },
    () => void load(),
    can.view,
  )

  // ---- Create pick lists (`?new=1`) ------------------------------------------------------------------------------------------
  const [create, setCreate] = useState<Omit<CreateModel, 'sites'> | null>(null)
  const creating = address.create && can.view
  const readChoices = useCallback(
    (site: string | null) => {
      setCreate((current) => (current ? { ...current, siteId: site, choices: { items: null, problem: null }, picked: [] } : current))
      listPickLists(api, { siteId: site, view: 'toCreate', limit: 200 })
        .then((page) => setCreate((current) => (current && current.siteId === site ? { ...current, choices: { items: createChoices(page.rows), problem: null } } : current)))
        .catch((error: unknown) => setCreate((current) => (current && current.siteId === site ? { ...current, choices: { items: null, problem: readProblem(error) } } : current)))
    },
    [api],
  )
  useEffect(() => {
    if (!creating) {
      setCreate(null)
      return
    }
    if (create) return
    setCreate({ siteId, choices: { items: null, problem: null }, picked: [], busy: false, results: null, problem: null })
    readChoices(siteId)
  }, [creating, create, siteId, readChoices])

  const confirmCreate = useCallback(async () => {
    if (!create || create.busy || create.picked.length === 0) return
    // In the order shown: by cut date (the work order cut first is served first); one call per site of the rows ticked.
    const order = (create.choices.items ?? []).filter((row: PickRow) => create.picked.includes(row.workOrder.id))
    const bySite = new Map<string, string[]>()
    for (const row of order) bySite.set(row.workOrder.siteId, [...(bySite.get(row.workOrder.siteId) ?? []), row.workOrder.id])
    setCreate({ ...create, busy: true, problem: null })
    const results: CreateResult[] = []
    try {
      for (const [site, ids] of bySite) results.push(...(await createPickLists(api, site, ids)).results)
      const created = results.filter((result) => result.outcome === 'CREATED').length
      setCreate((current) => (current ? { ...current, busy: false, results } : current))
      setNotice({ tone: created > 0 ? 'success' : 'warning', words: phrase('create.notice', { created, count: results.length }) })
      void load()
    } catch (error) {
      setCreate((current) => (current ? { ...current, busy: false, results: results.length > 0 ? results : null, problem: writeProblem(error) } : current))
      if (results.length > 0) void load()
    }
  }, [api, create, load])

  const print = useCallback(
    (ids: readonly string[]) => {
      if (ids.length === 0) return
      window.open(printHref(prefix, ids), '_blank', 'noopener')
    },
    [prefix],
  )

  const model: PickingListModel = {
    prefix,
    can,
    address,
    sites,
    rows,
    tiles,
    asOf,
    live,
    updates,
    timeZone: TIME_ZONE,
    sheet: sheet ? { id: sheet.id, ids: (rows.items ?? []).map((row) => row.workOrder.id), sheet: sheet.sheet, problem: sheet.problem } : null,
    create: create ? { ...create, sites } : null,
    notice,
  }

  return (
    <PickingListView
      model={model}
      actions={{
        onView: (next) => go({ view: next }),
        onSearch: (next) => go({ q: next }),
        onSite: (next) => go({ siteId: next }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onOpen: (id) => go({ open: id }),
        onRetrySheet: () => openId && readSheet(openId),
        onPrint: print,
        onCreate: () => go({ create: true, open: null }),
        onCloseCreate: () => go({ create: false }),
        onCreateSite: (site) => readChoices(site),
        onPick: (ids) => setCreate((current) => (current ? { ...current, picked: ids } : current)),
        onConfirmCreate: () => void confirmCreate(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
