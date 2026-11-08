'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { useLive } from '../../_shared/hooks'
import {
  capaCounts,
  capaPeople,
  closeCapa,
  findCustomers,
  findSources,
  listCapas,
  moveCapa,
  newIdempotencyKey,
  openCapa,
  sourcePreview,
  type CapaCounts,
  type CapaRow,
  type CapaStatus,
  type Person,
} from '../api'
import { addressOf, addressText, capaCan, closeLinesOfRow, emptyNewDraft, HOME_ADDRESS, newBodyOf, readProblem, recordHref, refusalOf, todayOf, type CapaAddress, type SourcePick } from '../model'
import { CapaMessages, type CapaNotice } from '../parts'
import type { CloseDialogModel } from '../view/CloseCapaDialog'
import type { CapaListModel, ListDialog } from './view-model'
import { CapaListView } from './view/CapaListView'

/**
 * `/w/<company>/quality/capa` (SCR-146): the saved row (`?view=`), the search (`?q=`), the type and priority, table or board
 * (`?mode=board`), New CAPA (`?new=1`, from records with `&from=Nonconformance|Complaint&ids=`); the tiles; live CAPA changes
 * behind "N updates · Show" on the table (the tiles follow at once; the board reads its rows again). A board move is the
 * CAPA's own stage step with the version read; a drop on Closed opens the close (its checks and the closing words).
 */
export function CapaPage() {
  return (
    <CapaMessages>
      <Container />
    </CapaMessages>
  )
}

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => capaCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<CapaAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])
  const [opened] = useState(() => new Date().toISOString())
  const today = todayOf(opened)

  // ---- rows and tiles ----------------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<CapaListModel['rows']>({ items: null, more: false, problem: null })
  const [people, setPeople] = useState<readonly Person[] | null>(null)
  const [counts, setCounts] = useState<CapaCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<CapaNotice | null>(null)
  const cursor = useRef<string | null>(null)
  const readId = useRef(0)
  const query = useMemo(() => ({ view: address.view, type: address.mode === 'board' ? null : address.type, priority: address.priority, q: address.q }), [address.view, address.type, address.priority, address.q, address.mode])

  const readCounts = useCallback(() => {
    capaCounts(api)
      .then(setCounts)
      .catch(() => setCounts(null))
  }, [api])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    readCounts()
    try {
      const page = await listCapas(api, query, null)
      if (id !== readId.current) return
      cursor.current = page.nextCursor
      setRows({ items: page.capas, more: page.nextCursor !== null, problem: null })
      setPeople(page.people)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      setRows({ items: null, more: false, problem: readProblem(error) })
    }
  }, [api, can.view, query, readCounts])

  useEffect(() => {
    setRows({ items: null, more: false, problem: null })
    void load()
  }, [load])

  const more = useCallback(async () => {
    if (!cursor.current) return
    try {
      const page = await listCapas(api, query, cursor.current)
      cursor.current = page.nextCursor
      setRows((now) => ({ items: [...(now.items ?? []), ...page.capas.filter((row) => !now.items?.some((seen) => seen.id === row.id))], more: page.nextCursor !== null, problem: null }))
      setPeople((now) => [...(now ?? []), ...page.people.filter((person) => !now?.some((seen) => seen.id === person.id))])
    } catch (error) {
      setNotice({ say: { key: readProblem(error) }, tone: 'danger' })
    }
  }, [api, query])

  const later = useRef<ReturnType<typeof setTimeout> | null>(null)
  const soon = useCallback((work: () => void) => {
    if (later.current) clearTimeout(later.current)
    later.current = setTimeout(work, 800)
  }, [])
  useEffect(() => () => void (later.current && clearTimeout(later.current)), [])
  const live = useLive(
    (change) => {
      if (!change.type.startsWith('capa.')) return
      if (address.mode === 'board') soon(() => void load())
      else {
        setUpdates((count) => count + 1)
        soon(readCounts)
      }
    },
    () => void load(),
  )
  const offline = live === 'offline'

  // ---- New CAPA (the band's primary, `c`, or opened from records by address) ----------------------------------------------
  const [dialog, setDialog] = useState<ListDialog | null>(null)
  const openKey = useRef<string | null>(null)
  const fromKey = address.isNew && address.from ? `${address.from.recordType}:${address.from.ids.join(',')}` : ''
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setDialog(null)
      return
    }
    openKey.current = null
    const from = address.from
    setDialog({ kind: 'new', draft: emptyNewDraft(today, me), people: null, found: { q: '', items: null, problem: null }, customers: { items: null, problem: null }, from: from ? { reading: true, problem: null } : null, busy: false, notice: null })
    if (companyId)
      capaPeople(api, companyId, null)
        .then((found) => setDialog((now) => (now ? { ...now, people: found } : now)))
        .catch(() => setDialog((now) => (now ? { ...now, people: 'failed' } : now)))
    if (from)
      sourcePreview(api, from.recordType, from.ids)
        .then((preview) => {
          const sources: SourcePick[] = preview.records.map((record) => ({ recordType: record.recordType, recordId: record.recordId, number: record.number, title: record.title, companyId: record.companyId, held: record.problem ? record.problem.path.replace(/^held\//, '') : null }))
          const first = preview.records[0]
          setDialog((now) => (now ? { ...now, from: { reading: false, problem: null }, draft: { ...now.draft, sources, title: now.draft.title || (first?.title ?? first?.number ?? '') } } : now))
        })
        .catch((error: unknown) => setDialog((now) => (now ? { ...now, from: { reading: false, problem: readProblem(error) } } : now)))
    // The dialog opens once per address (`?new=1` and its records).
  }, [address.isNew, fromKey, can.view, api, companyId, me, today])

  const submitNew = useCallback(async () => {
    if (!dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, notice: null })
    openKey.current ??= newIdempotencyKey()
    try {
      const record = await openCapa(api, newBodyOf(dialog.draft, companyId, me), openKey.current)
      openKey.current = null
      setDialog(null)
      router.push(recordHref(prefix, record.capa.id))
    } catch (error) {
      const refusal = refusalOf(error)
      setDialog((now) => (now ? { ...now, busy: false, notice: { say: refusal.say, tone: 'danger', lines: refusal.lines } } : now))
    }
  }, [dialog, api, companyId, me, router, prefix])

  const findTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onFindSources = useCallback(
    (q: string) => {
      setDialog((now) => (now ? { ...now, found: { q, items: null, problem: null } } : now))
      findSources(api, q, can)
        .then((items) => setDialog((now) => (now ? { ...now, found: { q, items, problem: null } } : now)))
        .catch((error: unknown) => setDialog((now) => (now ? { ...now, found: { q, items: null, problem: readProblem(error) } } : now)))
    },
    [api, can],
  )
  const onFindCustomers = useCallback(
    (q: string) => {
      if (!can.partiesView) return
      if (findTimer.current) clearTimeout(findTimer.current)
      findTimer.current = setTimeout(() => {
        findCustomers(api, q)
          .then((items) => setDialog((now) => (now ? { ...now, customers: { items, problem: null } } : now)))
          .catch((error: unknown) => setDialog((now) => (now ? { ...now, customers: { items: null, problem: readProblem(error) } } : now)))
      }, 150)
    },
    [api, can.partiesView],
  )

  // ---- board moves and the close ---------------------------------------------------------------------------------------------
  const [moving, setMoving] = useState<string | null>(null)
  const [close, setClose] = useState<CloseDialogModel | null>(null)
  const closeKey = useRef<string | null>(null)
  const boardMove = useCallback(
    async (row: CapaRow, lane: string): Promise<boolean> => {
      if (lane === row.status) return false
      if (lane === 'CLOSED') {
        closeKey.current = null
        setClose({ capaId: row.id, number: row.number, type: row.type, version: row.version, lines: closeLinesOfRow(row), note: '', busy: false, notice: null, offline, canClose: can.manage })
        return false
      }
      setMoving(row.id)
      try {
        const record = await moveCapa(api, row.id, { version: row.version, to: lane as CapaStatus })
        setNotice({ say: { key: 'board.moved', params: { number: record.capa.number, stage: record.capa.status } }, tone: 'success' })
        void load()
        return true
      } catch (error) {
        const refusal = refusalOf(error)
        setNotice({ say: refusal.stale ? refusal.say : { key: 'board.notMoved', params: { number: row.number } }, tone: 'danger', lines: refusal.lines })
        if (refusal.stale) void load()
        return false
      } finally {
        setMoving(null)
      }
    },
    [api, load, offline, can.manage],
  )
  const submitClose = useCallback(async () => {
    if (!close || close.busy) return
    setClose({ ...close, busy: true, notice: null })
    closeKey.current ??= newIdempotencyKey()
    try {
      const record = await closeCapa(api, close.capaId, { version: close.version, note: close.note.trim() }, closeKey.current)
      closeKey.current = null
      setClose(null)
      setNotice({ say: { key: 'close.done', params: { number: record.capa.number } }, tone: 'success' })
      void load()
    } catch (error) {
      closeKey.current = null
      const refusal = refusalOf(error)
      setClose((now) => (now ? { ...now, busy: false, notice: { say: refusal.say, tone: 'danger', lines: refusal.lines } } : now))
      if (refusal.stale) void load()
    }
  }, [close, api, load])

  const model: CapaListModel = {
    prefix,
    me,
    companyId,
    today,
    can,
    address,
    rows,
    counts,
    people,
    asOf,
    live,
    updates,
    notice,
    moving,
    dialog,
    close: close ? { ...close, offline } : null,
  }

  return (
    <CapaListView
      model={model}
      actions={{
        onView: (view) => go({ view }),
        onSearch: (q) => go({ q }),
        onType: (type) => go({ type }),
        onPriority: (priority) => go({ priority }),
        onMode: (mode) => go({ mode }),
        onClearFilters: () => go({ ...HOME_ADDRESS, mode: address.mode }),
        onRetry: () => void load(),
        onShowUpdates: () => void load(),
        onMore: () => void more(),
        onOpen: (id) => router.push(recordHref(prefix, id)),
        onNew: () => go({ isNew: true, from: null }),
        onDialogClose: () => {
          setDialog(null)
          go({ isNew: false, from: null })
        },
        onNewDraft: (patch) => setDialog((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
        onFindSources,
        onPickSource: (choice) =>
          setDialog((now) =>
            now && !now.draft.sources.some((source) => source.recordId === choice.recordId)
              ? { ...now, draft: { ...now.draft, sources: [...now.draft.sources, { ...choice, held: null }], title: now.draft.title || choice.title } }
              : now,
          ),
        onDropSource: (recordId) => setDialog((now) => (now ? { ...now, draft: { ...now.draft, sources: now.draft.sources.filter((source) => source.recordId !== recordId) } } : now)),
        onFindCustomers,
        onSubmitNew: () => void submitNew(),
        onBoardMove: boardMove,
        close: {
          onNote: (note) => setClose((now) => (now ? { ...now, note } : now)),
          onCancel: () => setClose(null),
          onSubmit: () => void submitClose(),
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ say: { key: 'list.copied', params: { count: numbers.length } }, tone: 'success' }))
            .catch(() => undefined)
        },
        onPrint: () => window.print(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}

