'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { businessDate, businessDayRange } from '@nexus/factory-domain/core/time'
import { formatDateTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { WithMessages } from '../../../record-panels/i18n'
import { downloadText, useCoalesced, useLive } from '../../_shared/buying/hooks'
import { listPlanningSites, type PlanningSite } from '../board/api'
import { runPlan } from '../mrp/api'
import { acknowledgeExceptions, getException, KINDS, listExceptions, resolveException, snoozeException, type ExceptionList, type PlanningException } from './api'
import { acknowledgeable, apiQueryOf, controlsOf, csvOfRows, exceptionsCan, NAMESPACE, noteProblem, queryOf, readProblemOf, refusalOf, type ExceptionsControls } from './model'
import type { ExceptionsDialog, ExceptionsModel, ExceptionsNotice, Loaded } from './view-model'
import { ExceptionsView } from './view/ExceptionsView'

/**
 * `/w/<company>/planning/exceptions` (SCR-125; Planning › Exceptions, planning.view): the company's planning sites
 * (`?site=`, else the first), the site's exception queue as the saved view asks it (`?view=` `?kind=` `?q=`; pages of 50
 * with Show more), the tiles and the latest run, and the detail (`?open=`, read fresh). Writes one at a time, each with
 * the row's version: acknowledge (one or many), snooze (until a time or the next run), resolve with a note; Run plan now.
 * Live: a run that finished waits behind "1 update · Show"; a change by someone else reads the queue again quietly.
 */
export function ExceptionsPage() {
  return (
    <WithMessages namespaces={[NAMESPACE, 'buying', 'lists']}>
      <ExceptionsContainer />
    </WithMessages>
  )
}

function ExceptionsContainer() {
  const t = useT(NAMESPACE)
  const units = useT('buying')
  const locale = useLocale()
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const query = params?.toString() ?? ''
  const controls = useMemo(() => controlsOf(new URLSearchParams(query), KINDS), [query])
  const prefix = pathname.replace(/\/planning\/exceptions\/?$/, '')
  const can = useMemo(() => exceptionsCan(session.permissions), [session.permissions])

  const [sites, setSites] = useState<Loaded<PlanningSite[]>>({ status: 'loading' })
  const [list, setList] = useState<Loaded<ExceptionList>>({ status: 'loading' })
  const [rows, setRows] = useState<PlanningException[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [updates, setUpdates] = useState(0)
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState<string[]>([])
  const [notice, setNotice] = useState<ExceptionsNotice | null>(null)
  const [detail, setDetail] = useState<ExceptionsModel['detail']>(null)
  const [dialog, setDialog] = useState<ExceptionsDialog | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const readId = useRef(0)
  const rowsRef = useRef<PlanningException[]>([])
  rowsRef.current = rows
  const controlsRef = useRef(controls)
  controlsRef.current = controls

  const site = sites.status === 'ready' ? (sites.value.find((entry) => entry.id === controls.site) ?? sites.value[0] ?? null) : null
  const siteId = site?.id ?? null
  const timeZone = site?.timeZone ?? 'Europe/Rome'
  const endOfToday = useMemo(() => businessDayRange(businessDate(new Date(now), timeZone), timeZone).end.toISOString(), [now, timeZone])

  const setControls = useCallback(
    (next: Partial<ExceptionsControls>) => {
      const qs = queryOf({ ...controlsRef.current, ...next })
      router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
    },
    [router, pathname],
  )

  useEffect(() => {
    if (!can.view) return
    let gone = false
    listPlanningSites(api, session.company?.id ?? null)
      .then((value) => !gone && setSites({ status: 'ready', value }))
      .catch((error: unknown) => {
        if (gone) return
        setSites({ status: 'error', problem: readProblemOf(error) })
        setList({ status: 'error', problem: readProblemOf(error) })
      })
    return () => {
      gone = true
    }
  }, [api, can.view, session.company?.id])

  const load = useCallback(async () => {
    if (!siteId) {
      if (sites.status === 'ready') setList({ status: 'error', problem: 'error.noSite' })
      return
    }
    const id = ++readId.current
    try {
      const value = await listExceptions(api, siteId, apiQueryOf(controls.view, controls.kind))
      if (id !== readId.current) return
      setList({ status: 'ready', value })
      setRows(value.exceptions)
      setCursor(value.nextCursor)
      setUpdates(0)
      setNow(Date.now())
    } catch (error) {
      if (id !== readId.current) return
      setList({ status: 'error', problem: readProblemOf(error) })
    }
  }, [api, siteId, sites.status, controls.view, controls.kind])

  useEffect(() => {
    if (sites.status !== 'ready') return
    setList({ status: 'loading' })
    setRows([])
    void load()
  }, [load, sites.status])

  const more = useCallback(async () => {
    if (!siteId || !cursor || loadingMore) return
    setLoadingMore(true)
    try {
      const value = await listExceptions(api, siteId, { ...apiQueryOf(controls.view, controls.kind), cursor })
      setRows((current) => [...current, ...value.exceptions.filter((row) => !current.some((entry) => entry.id === row.id))])
      setCursor(value.nextCursor)
    } catch (error) {
      setNotice({ tone: 'danger', key: readProblemOf(error) })
    } finally {
      setLoadingMore(false)
    }
  }, [api, siteId, cursor, loadingMore, controls.view, controls.kind])

  // Live: a run of this site finished (the queue changes under the person: "1 update · Show"); someone acknowledged,
  // snoozed or resolved (read again quietly: only the rows' words change).
  const reread = useCoalesced(() => void load(), 800)
  const live = useLive(
    (change) => {
      const own = change.fields.siteId === undefined || change.fields.siteId === siteId
      if (!own) return
      if (change.type === 'planning.run_finished' || change.type === 'planning.exceptions_found') setUpdates((count) => count + 1)
      else if (change.type === 'planning.exceptions_changed') reread()
    },
    () => void load(),
    can.view,
  )

  // The detail: `?open=` reads the exception fresh (the row shows at once meanwhile).
  useEffect(() => {
    const id = controls.open
    if (!id) {
      setDetail(null)
      return
    }
    let gone = false
    const known = rowsRef.current.find((row) => row.id === id)
    setDetail({ id, loaded: known ? { status: 'ready', value: known } : { status: 'loading' } })
    getException(api, id)
      .then((value) => !gone && setDetail({ id, loaded: { status: 'ready', value } }))
      .catch((error: unknown) => !gone && !known && setDetail({ id, loaded: { status: 'error', problem: readProblemOf(error) } }))
    return () => {
      gone = true
    }
  }, [api, controls.open])

  /** A row (and the open detail) as the API answered it after a write. */
  const take = useCallback((answered: readonly PlanningException[]) => {
    setRows((current) => current.map((row) => answered.find((entry) => entry.id === row.id) ?? row))
    setDetail((current) => {
      const fresh = current ? answered.find((entry) => entry.id === current.id) : undefined
      return current && fresh ? { id: current.id, loaded: { status: 'ready', value: fresh } } : current
    })
  }, [])

  const rowOf = (id: string): PlanningException | undefined => {
    const open = detail?.loaded.status === 'ready' && detail.id === id ? detail.loaded.value : undefined
    return open ?? rowsRef.current.find((row) => row.id === id)
  }

  const acknowledge = useCallback(
    async (ids: string[]) => {
      const refs = acknowledgeable(ids.map((id) => rowOf(id)).filter((row): row is PlanningException => !!row)).map((row) => ({ id: row.id, version: row.version }))
      if (refs.length === 0 || busy.length > 0) return
      setBusy(refs.map((ref) => ref.id))
      setNotice(null)
      try {
        const answered = await acknowledgeExceptions(api, refs)
        take(answered)
        setNotice({ tone: 'success', key: 'notice.acknowledged', params: { count: answered.length } })
        reread()
      } catch (error) {
        setNotice({ tone: 'danger', key: refusalOf(error) })
        void load()
      } finally {
        setBusy([])
      }
    },
    // rowOf reads the rows' ref and the open detail.
    [api, busy.length, take, reread, load, detail],
  )

  const snooze = useCallback(
    async (until: string | null): Promise<boolean> => {
      if (dialog?.kind !== 'snooze') return false
      const row = rowOf(dialog.id)
      if (!row) return false
      setBusy([row.id])
      try {
        const answered = await snoozeException(api, row.id, row.version, until)
        take([answered])
        setNotice({ tone: 'success', key: until ? 'notice.snoozed' : 'notice.snoozedRun', params: until ? { date: formatDateTime(until, { locale, timeZone }) } : undefined })
        reread()
        return true
      } catch (error) {
        setNotice({ tone: 'danger', key: refusalOf(error) })
        void load()
        return true
      } finally {
        setBusy([])
      }
    },
    [api, dialog, take, reread, load, locale, timeZone, detail],
  )

  const resolve = useCallback(async () => {
    if (dialog?.kind !== 'resolve' || dialog.busy) return
    const row = rowOf(dialog.id)
    if (!row) return
    const problem = noteProblem(dialog.note)
    if (problem) {
      setDialog({ ...dialog, problem })
      return
    }
    setDialog({ ...dialog, busy: true, problem: null })
    setBusy([row.id])
    try {
      const answered = await resolveException(api, row.id, row.version, dialog.note)
      take([answered])
      setDialog(null)
      setNotice({ tone: 'success', key: 'notice.resolved' })
      reread()
    } catch (error) {
      setDialog({ ...dialog, busy: false, problem: refusalOf(error) })
      void load()
    } finally {
      setBusy([])
    }
  }, [api, dialog, take, reread, load, detail])

  const run = useCallback(async () => {
    if (!siteId || running) return
    setRunning(true)
    setNotice(null)
    try {
      await runPlan(api, siteId)
      setNotice({ tone: 'success', key: 'notice.ran' })
      await load()
    } catch (error) {
      setNotice({ tone: 'danger', key: refusalOf(error) === 'refusal.changed' ? 'notice.runBusy' : refusalOf(error) })
    } finally {
      setRunning(false)
    }
  }, [api, siteId, running, load])

  const model: ExceptionsModel = {
    prefix,
    can,
    sites,
    siteId,
    controls,
    list,
    rows,
    more: cursor !== null,
    loadingMore,
    endOfToday,
    live,
    updates,
    running,
    busy,
    notice,
    detail,
    dialog,
    now,
    timeZone,
  }

  return (
    <ExceptionsView
      model={model}
      actions={{
        onSite: (next) => setControls({ site: next, open: null }),
        onView: (view) => setControls({ view, open: null }),
        onKind: (kind) => setControls({ kind, open: null }),
        onSearch: (q) => setControls({ q }),
        onRetry: () => void load(),
        onMore: () => void more(),
        onShowUpdates: () => void load(),
        onRun: () => void run(),
        onOpen: (id) => setControls({ open: id }),
        onAcknowledge: (ids) => void acknowledge(ids),
        onSnooze: (id) => {
          setNow(Date.now())
          setDialog({ kind: 'snooze', id })
        },
        onSnoozeConfirm: snooze,
        onResolve: (id) => setDialog({ kind: 'resolve', id, note: '', busy: false, problem: null }),
        onResolveNote: (note) => setDialog((current) => (current?.kind === 'resolve' ? { ...current, note, problem: null } : current)),
        onResolveConfirm: () => void resolve(),
        onExport: (ids) => {
          const picked = rowsRef.current.filter((row) => ids.includes(row.id))
          downloadText(`planning-exceptions-${new Date().toISOString().slice(0, 10)}.csv`, csvOfRows(picked, { t, unit: (uom) => units(`uom.${uom}`), locale, timeZone }))
        },
        onKeys: () => setDialog({ kind: 'keys' }),
        onCloseDialog: () => setDialog(null),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
