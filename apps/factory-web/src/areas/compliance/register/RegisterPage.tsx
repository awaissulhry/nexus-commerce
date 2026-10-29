'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, liveMatches, useLive } from '../../quality/_shared/hooks'
import { failedRead, problemKey, qualityCan, ready, reading, type Notice, type Read } from '../../quality/_shared/model'
import { createEntry, listEntries, listReporters, listStyles, previewTrace, type Entry, type PartyOption, type StyleOption, type Trace } from './api'
import {
  addressState,
  blankDraft,
  dayInstant,
  draftProblems,
  LIST_MAX,
  PAGE,
  registerCsv,
  romeToday,
  tileCounts,
  viewQuery,
  viewRows,
  type ListDialog,
  type NewEntryDraft,
  type RegisterFilters,
  type RegisterView,
  type TileCount,
  type TileId,
} from './model'
import { RegisterMessages } from './view/parts'
import { RegisterListView } from './view/RegisterListView'

/**
 * The PPE register's list container (`/w/<company>/compliance/register`, SCR-113): reads the view (`GET
 * /compliance/register` with its filters, 50 a page, a larger page on Show more up to the API's 500), the tiles (every OPEN
 * entry and every CLOSED one, counted with the list's own rules), adds an entry (with the trace preview first), exports
 * the view or the selection as CSV, and listens to the live stream: changes wait behind "N updates · Show" (rows never
 * move under the cursor). `?view=` keeps the view in the address; the API's own `?status=`, `?kind=`, `?risk=` are read
 * (Today links `?status=OPEN`); `?new=1` opens New entry.
 */
export function RegisterPage() {
  return (
    <RegisterMessages>
      <RegisterContainer />
    </RegisterMessages>
  )
}

const LIVE_TYPES = ['compliance.register_entry_']

function RegisterContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT('register')
  const can = useMemo(() => qualityCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  // The address is read once: later the page keeps it in step with the view (router.replace).
  const [initial] = useState(() => addressState(params))
  const [view, setView] = useState<RegisterView>(initial.view)
  const [filters, setFilters] = useState<RegisterFilters>(initial.filters)
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(PAGE)
  const [rows, setRows] = useState<Read<readonly Entry[]>>(reading())
  const [loadingMore, setLoadingMore] = useState(false)
  const [pageFull, setPageFull] = useState(false)
  const [tiles, setTiles] = useState<Partial<Record<TileId, TileCount | null>>>({})
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const wantsNew = params?.get('new') === '1' && can.registerManage
  const [dialog, setDialog] = useState<ListDialog | null>(wantsNew ? { kind: 'new' } : null)
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const [draft, setDraft] = useState<NewEntryDraft>(blankDraft(companyId))
  const [styles, setStyles] = useState<Read<readonly StyleOption[]> | null>(null)
  const [parties, setParties] = useState<Read<readonly PartyOption[]> | null>(null)
  const [trace, setTrace] = useState<Read<Trace> | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [showProblems, setShowProblems] = useState(false)
  const createKey = useRef<string | null>(null)
  const request = useRef<AbortController | null>(null)

  const load = useCallback(async () => {
    if (!can.registerView) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    try {
      const answer = await listEntries(api, viewQuery(view, filters, query, limit), controller.signal)
      if (controller.signal.aborted) return
      const shown = viewRows(view, answer)
      setRows(ready(shown))
      setPageFull(answer.length >= limit)
      setAsOf(new Date().toISOString())
      setUpdates(0)
      setSelected((current) => current.filter((id) => shown.some((row) => row.id === id)))
    } catch (error) {
      if ((error as { name?: string } | null)?.name === 'AbortError') return
      setRows(failedRead(problemKey(error)))
    } finally {
      setLoadingMore(false)
    }
  }, [api, can.registerView, view, filters, query, limit])

  const loadTiles = useCallback(async () => {
    if (!can.registerView) return
    const [open, closed] = await Promise.all([
      listEntries(api, { status: 'OPEN', limit: LIST_MAX }).catch(() => null),
      listEntries(api, { status: 'CLOSED', limit: LIST_MAX }).catch(() => null),
    ])
    setTiles(tileCounts(open, closed))
  }, [api, can.registerView])

  // The search waits for a pause in typing (250 ms); a view or filter change reads at once.
  useEffect(() => {
    const timer = setTimeout(() => void load(), query ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, query])
  useEffect(() => {
    void loadTiles()
  }, [loadTiles])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE_TYPES)) setUpdates((count) => count + 1)
    },
    () => {
      void load()
      void loadTiles()
    },
  )

  // New entry: the styles and the reporters, once, when the dialog opens (each only with its right).
  useEffect(() => {
    if (dialog?.kind !== 'new') return
    if (styles === null && session.permissions.includes('product.styles.view')) {
      setStyles(reading())
      listStyles(api)
        .then((list) => setStyles(ready(list)))
        .catch((error) => setStyles(failedRead(`quality:${problemKey(error)}`)))
    }
    if (parties === null && can.partiesView) {
      setParties(reading())
      listReporters(api)
        .then((list) => setParties(ready(list)))
        .catch((error) => setParties(failedRead(`quality:${problemKey(error)}`)))
    }
  }, [api, can.partiesView, dialog, parties, session.permissions, styles])

  const replaceAddress = (mutate: (search: URLSearchParams) => void) => {
    const search = new URLSearchParams(params?.toString() ?? '')
    mutate(search)
    const qs = search.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }

  const changeView = (next: RegisterView) => {
    setView(next)
    setLimit(PAGE)
    setRows(reading())
    setSelected([])
    replaceAddress((search) => {
      for (const name of ['status', 'risk', 'new']) search.delete(name)
      if (next === 'all') search.delete('view')
      else search.set('view', next)
    })
  }

  const changeFilters = (next: RegisterFilters) => {
    setFilters(next)
    setLimit(PAGE)
    setSelected([])
    replaceAddress((search) => {
      search.delete('new')
      if (next.kind) search.set('kind', next.kind)
      else search.delete('kind')
      if (next.risk) search.set('risk', next.risk)
      else search.delete('risk')
    })
  }

  const openDialog = (next: ListDialog | null) => {
    if (next === null) {
      setDialog(null)
      setDialogProblem(null)
      setShowProblems(false)
      setTrace(null)
      createKey.current = null
      if (params?.get('new')) replaceAddress((search) => search.delete('new'))
      return
    }
    if (next.kind === 'new') {
      setDraft(blankDraft(companyId))
      setTrace(null)
      setShowProblems(false)
      setDialogProblem(null)
    }
    setDialog(next)
  }

  const onDraft = (next: NewEntryDraft) => {
    // A change of what the entry concerns makes the preview stale.
    if (next.styleId !== draft.styleId || next.companyId !== draft.companyId || next.batchNumbers.join() !== draft.batchNumbers.join() || next.serials.join() !== draft.serials.join()) setTrace(null)
    setDraft(next)
    createKey.current = null
  }

  const onTrace = async () => {
    setTrace(reading())
    try {
      setTrace(ready(await previewTrace(api, draft)))
    } catch (error) {
      setTrace(failedRead(isApiError(error) && error.kind === 'invalid' ? 'new.traceRefused' : `quality:${problemKey(error)}`))
    }
  }

  const onCreate = async () => {
    if (draftProblems(draft).length > 0) {
      setShowProblems(true)
      return
    }
    setBusy(true)
    setDialogProblem(null)
    createKey.current ??= newIdempotencyKey()
    try {
      const entry = await createEntry(
        api,
        {
          companyId: draft.companyId,
          styleId: draft.styleId,
          batchNumbers: draft.batchNumbers,
          serials: draft.serials,
          kind: draft.kind,
          partyId: draft.partyId || null,
          reportedAt: dayInstant(draft.reportedOn, romeToday()) ?? null,
          description: draft.description.trim(),
          risk: draft.risk,
          actionTaken: draft.actionTaken.trim() || null,
        },
        createKey.current,
      )
      openDialog(null)
      router.push(`${prefix}/compliance/register/${encodeURIComponent(entry.id)}?created=1`)
    } catch (error) {
      setDialogProblem(isApiError(error) && error.kind === 'not_found' ? 'new.problem.noSeries' : isApiError(error) && error.kind === 'invalid' ? 'new.problem.refused' : `quality:${problemKey(error)}`)
      createKey.current = null
    } finally {
      setBusy(false)
    }
  }

  const onExport = (list: readonly Entry[]) => {
    const day = new Date().toISOString().slice(0, 10)
    downloadText(t('csv.file', { day }), registerCsv(list, t))
    setNotice({ key: 'done.exported', tone: 'success', params: { count: list.length } })
  }

  const onCopy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(
      () => setNotice({ key: 'done.copied', tone: 'success', params: { reference: text } }),
      () => undefined,
    )
  }

  return (
    <RegisterListView
      model={{
        prefix,
        can,
        rows,
        view,
        filters,
        query,
        limit,
        tiles,
        asOf,
        live,
        updates,
        selected,
        notice,
        loadingMore,
        pageFull,
        dialog,
        newEntry: {
          draft,
          companies: session.companies.length > 1 ? session.companies : [],
          styles,
          parties,
          trace,
          busy,
          problem: dialogProblem,
          showProblems,
          today: romeToday(),
        },
      }}
      actions={{
        onQuery: (next) => {
          setQuery(next)
          setLimit(PAGE)
        },
        onView: changeView,
        onFilters: changeFilters,
        onClearAll: () => {
          setQuery('')
          changeFilters({})
          changeView('all')
        },
        onMore: () => {
          setLoadingMore(true)
          setLimit((current) => Math.min(LIST_MAX, current + PAGE))
        },
        onRetry: () => {
          setRows(reading())
          void load()
          void loadTiles()
        },
        onShowUpdates: () => {
          void load()
          void loadTiles()
        },
        onSelect: (ids) => setSelected(ids),
        onDialog: openDialog,
        onOpen: (row) => router.push(`${prefix}/compliance/register/${encodeURIComponent(row.id)}`),
        onExport,
        onCopy,
        onDismissNotice: () => setNotice(null),
        onDraft,
        onTrace: () => void onTrace(),
        onCreate: () => void onCreate(),
      }}
    />
  )
}
