'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { placeHolds } from '../holds/api'
import { bulkProblem, holdable, HOLD_REFUSALS, type BulkHoldModel } from '../holds/model'
import { useCoalesced, useLive } from '../hooks'
import { atRisk as readAtRisk, openProblems, searchShipments, shipToday, type AtRisk, type ProblemList, type SearchPage, type ShipToday } from './api'
import { gridOf, isSearch, searchStatusOf, type QueueDepthActions, type QueueDepthModel } from './model'
import { failed, LOADING, ready, writeWords, type DepthAbilities, type Read } from './shared/depth'

/**
 * The shipments list in depth (SCR-590 / SCR-591), used by the W1 page: reads At risk (`GET /shipping/queue/at-risk`: the
 * sites the reader sees, their at-risk rows, the orders not planned), Ship today of the chosen site (`?site=`, else the first;
 * `GET /shipping/queue/today`), the open tracking problems (`GET /shipping/tracking-problems?open=true`: the Exceptions tile
 * and view) and, while a term is typed, the search (`GET /shipping/queue/search`, any status, 50 a page). Live: a shipment or
 * shipping event reads them again (coalesced). Hold N (the selection row) = ONE `POST /shipping/holds`.
 */
export function useShipmentsDepth({ rows, q, carrier, site, companySites, prefix, can, onSite, onCarrier, onOpen, onPlan, onExport }: {
  rows: string
  q: string
  carrier: string | null
  site: string | null
  /** The current company's sites the person reaches (the session's): Ship today offers only those (none known: every site At risk read). */
  companySites: readonly string[]
  prefix: string
  can: DepthAbilities
  onSite: (siteId: string) => void
  onCarrier: (carrier: string | null) => void
  onOpen: (id: string) => void
  onPlan: (salesOrderId: string) => void
  onExport: QueueDepthActions['onExport']
}): { model: QueueDepthModel; actions: QueueDepthActions } {
  const api = useOfficeApi()
  const [risk, setRisk] = useState<Read<AtRisk>>(LOADING)
  const [today, setToday] = useState<Read<ShipToday>>(LOADING)
  const [exceptions, setExceptions] = useState<Read<ProblemList>>(LOADING)
  const [search, setSearch] = useState<Read<SearchPage> | null>(null)
  const [hold, setHold] = useState<BulkHoldModel | null>(null)
  const holdRef = useRef(hold)
  holdRef.current = hold
  const holdKey = useRef<string | null>(null)
  const readId = useRef(0)
  const read = risk.state === 'ready' ? risk.value.sites : null
  const sites = read && companySites.length > 0 ? read.filter((entry) => companySites.includes(entry.siteId)) : read
  const siteId = site && sites?.some((entry) => entry.siteId === site) ? site : (sites?.[0]?.siteId ?? null)
  const searching = isSearch(q)
  const status = searchStatusOf(rows)

  const loadToday = useCallback(
    async (id: string | null, quiet: boolean) => {
      if (!id) return
      if (!quiet) setToday(LOADING)
      try {
        setToday(ready(await shipToday(api, id)))
      } catch (error) {
        setToday((state) => (quiet && state.state === 'ready' ? state : failed(error)))
      }
    },
    [api],
  )

  const loadSearch = useCallback(
    async (cursor: string | null) => {
      if (!searching) return setSearch(null)
      const id = ++readId.current
      if (!cursor) setSearch(LOADING)
      try {
        const page = await searchShipments(api, { q: q.trim(), status, cursor })
        if (id !== readId.current) return
        setSearch((state) => (cursor && state?.state === 'ready' ? ready({ ...page, shipments: [...state.value.shipments, ...page.shipments.filter((row) => !state.value.shipments.some((seen) => seen.id === row.id))] }) : ready(page)))
      } catch (error) {
        if (id === readId.current) setSearch(failed(error))
      }
    },
    [api, q, status, searching],
  )

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setRisk((state) => (state.state === 'ready' ? state : LOADING))
      readAtRisk(api, null)
        .then((value) => setRisk(ready(value)))
        .catch((error: unknown) => setRisk((state) => (quiet && state.state === 'ready' ? state : failed(error))))
      openProblems(api)
        .then((value) => setExceptions(ready(value)))
        .catch((error: unknown) => setExceptions((state) => (quiet && state.state === 'ready' ? state : failed(error))))
    },
    [api],
  )

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    void loadToday(siteId, false)
  }, [loadToday, siteId])

  useEffect(() => {
    void loadSearch(null)
  }, [loadSearch])

  const reread = useCoalesced(() => {
    void load(true)
    void loadToday(siteId, true)
    if (searching) void loadSearch(null)
  }, 900)
  useLive(
    (change) => {
      if (change.type.startsWith('shipment.') || change.type === 'shipping.cut_offs_saved' || change.type === 'shipping.carton_packed') reread()
    },
    () => reread(),
  )

  const actions = useMemo<QueueDepthActions>(
    () => ({
      onSite,
      onCarrier,
      onOpen,
      onPlan,
      onExport,
      onRetry: () => {
        void load()
        void loadToday(siteId, false)
        if (searching) void loadSearch(null)
      },
      onSearchMore: () => {
        if (search?.state === 'ready' && search.value.nextCursor) void loadSearch(search.value.nextCursor)
      },
      onHold: (picked) => {
        holdKey.current = newIdempotencyKey()
        setHold({ picked: picked.map((row) => ({ id: row.id, number: row.number, status: row.status })), reason: null, text: '', busy: false, problem: null, outcome: null })
      },
      onHoldReason: (reason) => setHold((state) => (state ? { ...state, reason, problem: null } : state)),
      onHoldText: (text) => setHold((state) => (state ? { ...state, text, problem: null } : state)),
      onHoldClose: () => setHold((state) => (state?.busy ? state : null)),
      onHoldGo: () => {
        const state = holdRef.current
        if (!state || state.busy || state.outcome || bulkProblem(state) || !state.reason) return
        const text = state.text.trim()
        const shipmentIds = state.picked.filter((row) => holdable(row.status)).map((row) => row.id)
        setHold({ ...state, busy: true, problem: null })
        placeHolds(api, { shipmentIds, reason: state.reason, words: text === '' ? null : text }, holdKey.current ?? newIdempotencyKey())
          .then((outcome) => {
            holdKey.current = null
            setHold((current) => (current ? { ...current, busy: false, outcome } : current))
            reread()
          })
          .catch((error: unknown) => {
            const problem = writeWords(error, 'holds.refusal', HOLD_REFUSALS)
            setHold((current) => (current ? { ...current, busy: false, problem: { key: problem.key, params: problem.params } } : current))
          })
      },
    }),
    [api, load, loadToday, loadSearch, search, siteId, searching, reread, onSite, onCarrier, onOpen, onPlan, onExport],
  )

  const model: QueueDepthModel = {
    grid: gridOf(rows, q),
    sites,
    siteId,
    today,
    atRisk: risk,
    exceptions,
    search,
    searchMore: search?.state === 'ready' && search.value.nextCursor !== null,
    carrier,
    hold,
    mayHold: can.holdsManage,
    mayManage: can.manage,
    viewOrders: can.viewOrders,
    prefix,
  }
  return { model, actions }
}
