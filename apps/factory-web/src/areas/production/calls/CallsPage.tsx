'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useCoalesced, useLive } from '../_shared/hooks'
import {
  callCounts,
  callsByHour,
  cancelCall,
  comeToCall,
  getCall,
  listCalls,
  listTypes,
  machinesAt,
  makeJob,
  nameOutcome,
  seeCall,
  solveCall,
  type Call,
  type CallCounts,
  type CallRecord,
} from './api'
import { addressOf, addressText, CALLS_NAMESPACE, CALLS_NAMESPACES, callsCanOf, isCallChange, readProblem, solveBody, typeLabel, writeProblem, type CallsAddress, type ChartBy, type Phrase } from './model'
import { CallsView, type CallDialog, type CallsModel } from './view/CallsView'

const TIME_ZONE = 'Europe/Rome'
const PAGE = 50

/**
 * `/w/<company>/production/calls?view=&tile=&kind=&q=&open=` (SCR-142): the calls of the top bar's site (all of the
 * person's sites when none is chosen) — the open calls oldest first, or the closed / every call newest first, 50 at a time
 * with "Show more" —, the tiles of the same scope, the day by the hour and "Who is called" of one site (the top bar's,
 * else the person's first), the call's DetailModal (`?open=`). Writes: Acknowledge (one or N), On my way, Done with a
 * resolution code (one or N), Cancel with a reason, Open a maintenance job (POST /plant/jobs, then the call's outcome),
 * each with the call's version and its own Idempotency-Key. Live `help_call.*`: the page reads again at once (new calls
 * join the end of the open list, oldest first) and a raised call is announced politely.
 */
export function CallsPage() {
  return (
    <WithMessages namespaces={CALLS_NAMESPACES}>
      <Container />
    </WithMessages>
  )
}

function Container() {
  const t = useT(CALLS_NAMESPACE)
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = pathname.replace(/\/production\/calls\/?$/, '')
  const can = useMemo(() => callsCanOf(session.permissions), [session.permissions])
  const address = addressOf(params)
  const siteId = scope.siteId
  const chartSite = useMemo(() => {
    const site = scope.site ?? scope.sites[0] ?? session.sites[0] ?? null
    return site ? { id: site.id, name: site.name } : null
  }, [scope.site, scope.sites, session.sites])

  const [rows, setRows] = useState<CallsModel['rows']>({ items: null, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [counts, setCounts] = useState<CallCounts | null>(null)
  const [day, setDay] = useState<CallsModel['day']>(null)
  const [types, setTypes] = useState<CallsModel['types']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState<string | null>(null)
  const [chartOpen, setChartOpen] = useState(true)
  const [chartBy, setChartBy] = useState<ChartBy>('kind')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<CallsModel['notice']>(null)
  const [detail, setDetail] = useState<CallsModel['detail']>(null)
  const [dialog, setDialog] = useState<CallDialog | null>(null)
  const readId = useRef(0)
  const dialogKey = useRef<string>(newIdempotencyKey())

  const go = useCallback((next: Partial<CallsAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`), [router, pathname, address])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const [page, tiles] = await Promise.all([listCalls(api, { siteId, view: address.view, tile: address.tile, kind: address.kind, limit: PAGE }), callCounts(api, siteId)])
      if (id !== readId.current) return
      setRows({ items: page.calls, problem: null })
      setCursor(page.nextCursor)
      setCounts(tiles)
      setAsOf(new Date().toISOString())
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, problem: readProblem(error) })
    }
  }, [api, can.view, siteId, address.view, address.tile, address.kind])

  const loadSite = useCallback(async () => {
    if (!can.view || !chartSite) return
    const [hours, kinds] = await Promise.allSettled([callsByHour(api, chartSite.id), listTypes(api, chartSite.id)])
    setDay(hours.status === 'fulfilled' ? { status: 'ready', value: hours.value } : { status: 'error', problem: readProblem(hours.reason) })
    setTypes(kinds.status === 'fulfilled' ? { status: 'ready', value: kinds.value } : { status: 'error', problem: readProblem(kinds.reason) })
  }, [api, can.view, chartSite])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    setDay(chartSite ? { status: 'loading' } : null)
    setTypes(chartSite ? { status: 'loading' } : null)
    void loadSite()
  }, [loadSite, chartSite])

  // The call open in its DetailModal follows the address (`?open=`).
  const readDetail = useCallback(
    async (id: string, quiet = false) => {
      if (!quiet) setDetail({ id, loaded: { status: 'loading' } })
      try {
        const value = await getCall(api, id)
        setDetail((current) => (current && current.id !== id ? current : { id, loaded: { status: 'ready', value } }))
      } catch (error) {
        setDetail((current) => (current && current.id !== id ? current : { id, loaded: isApiError(error) && error.kind === 'not_found' ? { status: 'notFound' } : { status: 'error', problem: readProblem(error) } }))
      }
    },
    [api],
  )
  useEffect(() => {
    if (!address.open) {
      setDetail(null)
      return
    }
    if (detail?.id !== address.open) void readDetail(address.open)
  }, [address.open, readDetail])

  const refresh = useCoalesced(() => {
    void load()
    void loadSite()
    if (address.open) void readDetail(address.open, true)
  }, 600)
  const live = useLive(
    (change) => {
      if (!isCallChange(change.type)) return
      if (change.type === 'help_call.raised') {
        const kind = typeof change.fields.kind === 'string' ? change.fields.kind : 'OTHER'
        setAnnouncement(t('announce.raised', { kind: t(`kind.${kind}`) }))
      }
      refresh()
    },
    () => refresh(),
    can.view,
  )

  // ---- writes -------------------------------------------------------------------------------------------------------------

  /** The freshest copy of a call this page holds (the open record's version wins over the list's). */
  const callOf = useCallback(
    (id: string): Call | CallRecord | null => {
      if (detail?.id === id && detail.loaded.status === 'ready') return detail.loaded.value.call
      return (rows.items ?? []).find((row) => row.id === id) ?? null
    },
    [detail, rows.items],
  )

  const took = useCallback((call: CallRecord) => {
    setRows((current) => (current.items ? { ...current, items: current.items.map((row) => (row.id === call.id ? call : row)) } : current))
    setDetail((current) => (current && current.id === call.id && current.loaded.status === 'ready' ? { id: call.id, loaded: { status: 'ready', value: { ...current.loaded.value, call } } } : current))
  }, [])

  /** Runs one write per call (each its own key); the calls refused are counted and the first refusal said. */
  const each = useCallback(
    async (ids: readonly string[], write: (call: Call | CallRecord) => Promise<{ call: CallRecord }>): Promise<{ done: number; refused: number; first: Phrase | null }> => {
      let done = 0
      let refused = 0
      let first: Phrase | null = null
      for (const id of ids) {
        const call = callOf(id)
        if (!call) continue
        try {
          const answer = await write(call)
          took(answer.call)
          done += 1
        } catch (error) {
          refused += 1
          first = first ?? writeProblem(error)
        }
      }
      return { done, refused, first }
    },
    [callOf, took],
  )

  const finish = useCallback(
    (result: { done: number; refused: number; first: Phrase | null }, doneKey: string) => {
      if (result.refused === 0) setNotice({ tone: 'success', words: { key: doneKey, params: { count: result.done } } })
      else if (result.done === 0) setNotice({ tone: 'danger', words: result.first ?? { key: 'problem.write' } })
      else setNotice({ tone: 'info', words: { key: 'notice.partly', params: { done: result.done, refused: result.refused } } })
      void load()
      void loadSite()
    },
    [load, loadSite],
  )

  const acknowledge = useCallback(
    (ids: readonly string[]) => {
      if (busy || ids.length === 0) return
      setBusy(true)
      setNotice(null)
      void each(ids, (call) => seeCall(api, call))
        .then((result) => finish(result, 'notice.acked'))
        .finally(() => setBusy(false))
    },
    [api, busy, each, finish],
  )

  const coming = useCallback(
    (id: string) => {
      if (busy) return
      setBusy(true)
      setNotice(null)
      void each([id], (call) => comeToCall(api, call))
        .then((result) => finish(result, 'notice.coming'))
        .finally(() => setBusy(false))
    },
    [api, busy, each, finish],
  )

  // One key per opened dialog (a write sent again after a lost answer is answered from its receipt); typing keeps it.
  const dialogOpenKind = useRef<string | null>(null)
  const openDialog = useCallback((next: CallDialog | null) => {
    if (next && dialogOpenKind.current !== next.kind) dialogKey.current = newIdempotencyKey()
    dialogOpenKind.current = next ? next.kind : null
    setDialog(next)
  }, [])

  const solve = useCallback(() => {
    if (busy || dialog?.kind !== 'solve') return
    const current = dialog
    setBusy(true)
    const base = dialogKey.current
    void each(current.ids, (call) => solveCall(api, call, solveBody(current.draft), `${base}:${call.id}`))
      .then((result) => {
        if (current.ids.length === 1 && result.refused === 1) {
          setDialog({ ...current, problem: result.first })
          return
        }
        openDialog(null)
        finish(result, 'notice.solved')
      })
      .finally(() => setBusy(false))
  }, [api, busy, dialog, each, finish, openDialog])

  const cancel = useCallback(() => {
    if (busy || dialog?.kind !== 'cancel') return
    const current = dialog
    setBusy(true)
    void each([current.id], (call) => cancelCall(api, call, current.reason.trim(), dialogKey.current))
      .then((result) => {
        if (result.refused === 1) {
          setDialog({ ...current, problem: result.first })
          return
        }
        openDialog(null)
        finish(result, 'notice.cancelled')
      })
      .finally(() => setBusy(false))
  }, [api, busy, dialog, each, finish, openDialog])

  const jobOpen = useCallback(
    (id: string) => {
      const call = callOf(id)
      if (!call) return
      const words = t(call.line ? 'job.prefill' : 'job.prefillNoLine', { type: typeLabel(call.type, locale), station: call.station.code, line: call.line?.code ?? '' })
      const problem = call.note ? `${words} ${call.note}` : words
      openDialog({ kind: 'job', id, machines: { status: 'loading' }, draft: { machineId: '', priority: 'P2', problem }, problem: null })
      machinesAt(api, call.siteId, call.station.id)
        .then((machines) => setDialog((current) => (current?.kind === 'job' && current.id === id ? { ...current, machines: { status: 'ready', value: machines }, draft: { ...current.draft, machineId: machines.length === 1 ? machines[0]!.id : current.draft.machineId } } : current)))
        .catch((error: unknown) => setDialog((current) => (current?.kind === 'job' && current.id === id ? { ...current, machines: { status: 'error', problem: readProblem(error) } } : current)))
    },
    [api, callOf, locale, openDialog, t],
  )

  const job = useCallback(async () => {
    if (busy || dialog?.kind !== 'job') return
    const current = dialog
    const call = callOf(current.id)
    if (!call) return
    setBusy(true)
    try {
      const made = await makeJob(api, { machineId: current.draft.machineId, type: 'CORRECTIVE', problem: current.draft.problem.trim(), priority: current.draft.priority }, dialogKey.current)
      const answer = await nameOutcome(api, call, { recordType: 'MaintenanceJob', recordId: made.id }, `${dialogKey.current}:outcome`)
      took(answer.call)
      openDialog(null)
      setNotice({ tone: 'success', words: { key: 'notice.job', params: { number: made.number } }, link: { href: `${prefix}/plant/jobs/${made.id}`, words: { key: 'notice.openJob', params: { number: made.number } } } })
    } catch (error) {
      setDialog({ ...current, problem: writeProblem(error) })
    } finally {
      setBusy(false)
    }
  }, [api, busy, callOf, dialog, openDialog, prefix, took])

  const model: CallsModel = {
    prefix,
    can,
    address,
    timeZone: TIME_ZONE,
    rows,
    hasMore: cursor !== null,
    loadingMore,
    counts,
    site: chartSite,
    day,
    types,
    asOf,
    live,
    announcement,
    chartOpen,
    chartBy,
    busy,
    notice,
    detail,
    dialog,
  }

  return (
    <CallsView
      model={model}
      actions={{
        onAddress: (next) => {
          setNotice(null)
          go(next)
        },
        onMore: () => {
          if (!cursor || loadingMore) return
          setLoadingMore(true)
          listCalls(api, { siteId, view: address.view, tile: address.tile, kind: address.kind, cursor, limit: PAGE })
            .then((page) => {
              setRows((current) => ({ items: [...(current.items ?? []), ...page.calls.filter((call) => !(current.items ?? []).some((row) => row.id === call.id))], problem: null }))
              setCursor(page.nextCursor)
            })
            .catch((error: unknown) => setNotice({ tone: 'danger', words: { key: readProblem(error) } }))
            .finally(() => setLoadingMore(false))
        },
        onRetry: () => {
          void load()
          void loadSite()
        },
        onChart: setChartOpen,
        onChartBy: setChartBy,
        onAcknowledge: acknowledge,
        onComing: coming,
        onDialog: openDialog,
        onSolveOpen: (ids) => openDialog({ kind: 'solve', ids, draft: { code: '', note: '' }, problem: null }),
        onJobOpen: jobOpen,
        onSolve: solve,
        onCancel: cancel,
        onJob: () => void job(),
        onRetryDetail: () => {
          if (address.open) void readDetail(address.open)
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
