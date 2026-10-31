'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { downloadText, liveMatches, useLive } from '../_shared/hooks'
import { problemKey } from '../_shared/model'
import {
  acknowledgeComplaint,
  complaintCounts,
  complaintPeople,
  getComplaint,
  listComplaints,
  listContacts,
  listCustomers,
  listOrders,
  listPhotos,
  listReturns,
  listShipments,
  listStyles,
  logComplaint,
  photoAddress,
  previewComplaint,
  triageComplaint,
  uploadPhoto,
  type ComplaintCounts,
  type ComplaintPeople,
  type ComplaintRow,
  type SafetyAlert,
  type StyleOption,
} from './api'
import {
  addressOf,
  addressText,
  blankLogDraft,
  complaintsCan,
  complaintsCsv,
  isStale,
  logBody,
  logProblems,
  nextInQueue,
  PAGE,
  QUEUE,
  queryOf,
  raisesSafety,
  recordHref,
  refusalKey,
  romeToday,
  triageDraftOf,
  triageProblems,
  withPreview,
  type ComplaintsAddress,
} from './model'
import type { ComplaintsRows, LogModel, Notice, TriageModel } from './view-model'
import { ComplaintsMessages, useWords } from './view/parts'
import { ComplaintsView } from './view/ComplaintsView'

/**
 * `/w/<company>/quality/complaints` (SCR-113 W2a part): reads the view of the address (`GET /quality/complaints` with
 * the API's own filters, 50 a page, Show more by its cursor), the tiles and the safety banner (`…/counts`), and listens to
 * the live stream: a new or changed complaint waits behind "N updates · Show" (rows never move under the cursor) while
 * the tiles and the banner read at once. `?open=<id>` opens the triage DetailModal on the queue of new complaints;
 * `?new=1` Log complaint. Every write sends the complaint's version; a stale one reads the complaint again and says so.
 */
export function ComplaintsPage() {
  return (
    <ComplaintsMessages>
      <ComplaintsContainer />
    </ComplaintsMessages>
  )
}

const LIVE = ['complaint.']

function useOnline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' ? true : navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
}

function ComplaintsContainer() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useWords()
  const can = useMemo(() => complaintsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? session.companies[0]?.id ?? ''
  const me = session.user.id
  const address = useMemo(() => addressOf(params), [params])
  const offline = !useOnline()
  const today = romeToday()

  const go = useCallback((patch: Partial<ComplaintsAddress>) => router.replace(`${pathname}${addressText({ ...address, ...patch })}`, { scroll: false }), [router, pathname, address])

  // ---- the list and the tiles ----------------------------------------------------------------------------------------------
  const [rows, setRows] = useState<ComplaintsRows>({ items: null, people: [], more: false, loadingMore: false, problem: null })
  const [cursor, setCursor] = useState<string | null>(null)
  const [counts, setCounts] = useState<ComplaintCounts | null>(null)
  const [countsFailed, setCountsFailed] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const readId = useRef(0)
  const shown = useRef(false)
  shown.current = rows.items !== null
  const listKey = JSON.stringify(queryOf({ ...address, open: null, log: false }, PAGE))

  const loadCounts = useCallback(async () => {
    if (!can.view) return
    try {
      setCounts(await complaintCounts(api))
      setCountsFailed(false)
    } catch {
      setCountsFailed(true)
    }
  }, [api, can.view])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    try {
      const page = await listComplaints(api, JSON.parse(listKey))
      if (id !== readId.current) return
      setRows({ items: page.complaints, people: page.people, more: page.nextCursor !== null, loadingMore: false, problem: null })
      setCursor(page.nextCursor)
      setAsOf(page.asOf)
      setUpdates(0)
    } catch (error) {
      if (id !== readId.current) return
      // A later read that fails keeps the rows on screen with their time, and says so; a first one says what failed.
      setRows((current) => ({ ...current, loadingMore: false, problem: current.items ? null : problemKey(error) }))
      if (shown.current) setNotice({ tone: 'warning', words: { key: 'notice.readFailed' } })
    }
  }, [api, can.view, listKey])

  // The search waits for a pause in typing (250 ms); a tile or filter reads at once.
  useEffect(() => {
    const timer = setTimeout(() => void load(), address.q ? 250 : 0)
    return () => clearTimeout(timer)
  }, [load, address.q])
  useEffect(() => {
    void loadCounts()
  }, [loadCounts])

  const more = useCallback(async () => {
    if (!cursor) return
    setRows((current) => ({ ...current, loadingMore: true }))
    try {
      const page = await listComplaints(api, { ...JSON.parse(listKey), cursor })
      setRows((current) => ({
        items: [...(current.items ?? []), ...page.complaints.filter((row) => !current.items?.some((seen) => seen.id === row.id))],
        people: [...current.people, ...page.people.filter((person) => !current.people.some((seen) => seen.id === person.id))],
        more: page.nextCursor !== null,
        loadingMore: false,
        problem: null,
      }))
      setCursor(page.nextCursor)
    } catch (error) {
      setRows((current) => ({ ...current, loadingMore: false }))
      setNotice({ tone: 'danger', words: { key: refusalKey(error) } })
    }
  }, [api, cursor, listKey])

  // ---- triage ----------------------------------------------------------------------------------------------------------------
  const [triage, setTriage] = useState<TriageModel | null>(null)
  const [queue, setQueue] = useState<readonly string[]>([])
  const [people, setPeople] = useState<{ value: ComplaintPeople | null; problem: string | null } | null>(null)
  const [styles, setStyles] = useState<readonly StyleOption[] | null | undefined>(undefined)
  const triageRead = useRef(0)
  const triageKey = useRef<string | null>(null)

  const ensurePeople = useCallback(() => {
    if (people !== null || !companyId) return
    setPeople({ value: null, problem: null })
    complaintPeople(api, companyId)
      .then((value) => setPeople({ value, problem: null }))
      .catch((error) => setPeople({ value: null, problem: refusalKey(error) }))
  }, [api, companyId, people])

  const ensureStyles = useCallback(() => {
    if (styles !== undefined) return
    if (!can.stylesView) {
      setStyles(null)
      return
    }
    setStyles(null)
    listStyles(api)
      .then((list) => setStyles(list))
      .catch(() => setStyles(null))
  }, [api, can.stylesView, styles])

  const loadTriage = useCallback(
    async (id: string) => {
      const read = ++triageRead.current
      triageKey.current = null
      setTriage((current) => ({
        queue: current?.queue ?? [],
        id,
        loaded: { status: 'loading' },
        photos: [],
        draft: current?.id === id ? current.draft : { category: null, severity: null, ownerId: '', answerDueOn: '', styleId: '', risk: 'ASSESSING', note: '' },
        people: null,
        peopleProblem: null,
        styles: null,
        showProblems: false,
        busy: false,
        problem: null,
        confirmSafety: false,
        today,
        offline,
      }))
      try {
        const complaint = await getComplaint(api, id)
        if (read !== triageRead.current) return
        setTriage((current) => (current && current.id === id ? { ...current, loaded: { status: 'ready', value: complaint }, draft: triageDraftOf(complaint, me, null) } : current))
        if (can.filesRead) {
          const photos = await listPhotos(api, id).catch(() => [])
          if (read !== triageRead.current) return
          setTriage((current) => (current && current.id === id ? { ...current, photos: photos.map((photo) => ({ id: photo.id, name: photo.originalName, src: null })) } : current))
          for (const photo of photos) {
            photoAddress(api, photo.id)
              .then((src) => setTriage((current) => (current && current.id === id ? { ...current, photos: current.photos.map((entry) => (entry.id === photo.id ? { ...entry, src } : entry)) } : current)))
              .catch(() => undefined)
          }
        }
      } catch (error) {
        if (read !== triageRead.current) return
        const status = isApiError(error) && error.kind === 'not_found' ? 'notFound' : isApiError(error) && error.kind === 'forbidden' ? 'forbidden' : 'error'
        setTriage((current) => (current && current.id === id ? { ...current, loaded: status === 'error' ? { status, problem: problemKey(error) } : { status } } : current))
      }
    },
    [api, can.filesRead, me, offline, today],
  )

  useEffect(() => {
    if (!address.open || !can.view) {
      triageRead.current += 1
      setTriage(null)
      return
    }
    ensurePeople()
    ensureStyles()
    void loadTriage(address.open)
  }, [address.open, can.view, ensurePeople, ensureStyles, loadTriage])

  // The people and the styles reach the open triage when they are read; the owner defaults to me when I may be one.
  const triageModel: TriageModel | null = triage
    ? {
        ...triage,
        queue: queue.length > 0 ? queue : [triage.id],
        people: people?.value ?? null,
        peopleProblem: people?.problem ?? null,
        styles: styles ?? null,
        offline,
      }
    : null
  useEffect(() => {
    const owners = people?.value?.owners
    if (!owners) return
    setTriage((current) => {
      if (!current || current.loaded.status !== 'ready' || current.draft.ownerId) return current
      const fresh = triageDraftOf(current.loaded.value, me, owners)
      return fresh.ownerId ? { ...current, draft: { ...current.draft, ownerId: fresh.ownerId } } : current
    })
  }, [people, me, triage?.id, triage?.loaded.status])

  const startTriage = useCallback(
    async (ids?: readonly string[]) => {
      if (!can.manage) return
      let list = ids ?? null
      if (!list) {
        try {
          const page = await listComplaints(api, { view: 'new', limit: QUEUE })
          list = page.complaints.map((row) => row.id)
        } catch (error) {
          setNotice({ tone: 'danger', words: { key: refusalKey(error) } })
          return
        }
      }
      if (list.length === 0) {
        setNotice({ tone: 'info', words: { key: 'notice.nothingToTriage' } })
        return
      }
      setQueue(list)
      go({ open: list[0]!, log: false })
    },
    [api, can.manage, go],
  )

  const saveTriage = useCallback(
    async (confirmed: boolean) => {
      if (!triage || triage.loaded.status !== 'ready' || triage.busy) return
      const complaint = triage.loaded.value
      if (triageProblems(triage.draft, complaint).length > 0) {
        setTriage({ ...triage, showProblems: true })
        return
      }
      if (!confirmed && raisesSafety(triage.draft, complaint)) {
        setTriage({ ...triage, confirmSafety: true, problem: null })
        return
      }
      setTriage({ ...triage, busy: true, problem: null })
      triageKey.current ??= newIdempotencyKey()
      const draft = triage.draft
      try {
        const answer = await triageComplaint(
          api,
          complaint,
          {
            category: draft.category!,
            severity: draft.severity!,
            ownerId: draft.ownerId,
            answerDueOn: draft.answerDueOn,
            ...(!complaint.style && draft.styleId ? { styleId: draft.styleId } : {}),
            ...(raisesSafety(draft, complaint) ? { risk: draft.risk } : {}),
            ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
          },
          triageKey.current,
        )
        triageKey.current = null
        setNotice({
          tone: answer.safetyRaised ? 'warning' : 'success',
          words: answer.safetyRaised ? { key: 'done.safetyRaised', params: { number: answer.complaint.number, reference: answer.register?.reference ?? '—' } } : { key: 'done.triaged', params: { number: answer.complaint.number } },
        })
        void load()
        void loadCounts()
        const ids = queue.length > 0 ? queue : [complaint.id]
        const next = nextInQueue(ids, complaint.id)
        const rest = ids.filter((id) => id !== complaint.id)
        setQueue(rest)
        go({ open: next && rest.includes(next) ? next : null })
      } catch (error) {
        triageKey.current = null
        if (isStale(error)) {
          await loadTriage(complaint.id)
          setTriage((current) => (current ? { ...current, problem: 'refusal.conflict', draft } : current))
          return
        }
        setTriage((current) => (current ? { ...current, busy: false, confirmSafety: false, problem: refusalKey(error) } : current))
      }
    },
    [api, triage, queue, go, load, loadCounts, loadTriage],
  )

  // ---- live ---------------------------------------------------------------------------------------------------------------------
  const refreshCounts = useRef(loadCounts)
  refreshCounts.current = loadCounts
  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE)) return
      void refreshCounts.current()
      setUpdates((count) => count + 1)
    },
    () => {
      void load()
      void loadCounts()
    },
  )

  // ---- log ------------------------------------------------------------------------------------------------------------------------
  const [log, setLog] = useState<LogModel | null>(null)
  const logKey = useRef<string | null>(null)
  const previewRead = useRef(0)
  useEffect(() => {
    if (!address.log || !can.log) {
      setLog(null)
      return
    }
    logKey.current = null
    setLog({
      draft: blankLogDraft(today),
      customers: { items: null, problem: can.partiesView ? null : 'log.customerNoRight' },
      contacts: null,
      orders: null,
      shipments: null,
      returns: null,
      styles: null,
      preview: null,
      previewing: false,
      showProblems: false,
      busy: false,
      problem: null,
      today,
      canPhotos: can.filesUpload,
    })
    if (can.partiesView) {
      listCustomers(api)
        .then((items) => setLog((current) => (current ? { ...current, customers: { items, problem: null } } : current)))
        .catch((error) => setLog((current) => (current ? { ...current, customers: { items: null, problem: refusalKey(error) } } : current)))
    }
    if (can.stylesView) {
      listStyles(api)
        .then((items) => setLog((current) => (current ? { ...current, styles: items } : current)))
        .catch(() => undefined)
    }
    // Opened once per ?new=1: the person's rights and the day do not change while it is open.
  }, [address.log, api])

  // The customer's contacts, orders, shipments and returns when the customer changes (each with its own right).
  const logParty = log?.draft.partyId ?? ''
  useEffect(() => {
    if (!logParty) {
      setLog((current) => (current ? { ...current, contacts: null, orders: null, shipments: null, returns: null } : current))
      return
    }
    const controller = new AbortController()
    const fill = <K extends 'contacts' | 'orders' | 'shipments' | 'returns'>(key: K, allowed: boolean, read: () => Promise<NonNullable<LogModel[K]>>) => {
      if (!allowed) return
      read()
        .then((items) => setLog((current) => (current && current.draft.partyId === logParty ? { ...current, [key]: items } : current)))
        .catch(() => setLog((current) => (current && current.draft.partyId === logParty ? { ...current, [key]: null } : current)))
    }
    fill('contacts', can.partiesView, () => listContacts(api, logParty, controller.signal))
    fill('orders', can.ordersView, () => listOrders(api, logParty, controller.signal))
    fill('shipments', can.shippingView, () => listShipments(api, logParty, controller.signal))
    fill('returns', can.returnsView, () => listReturns(api, logParty, controller.signal))
    return () => controller.abort()
  }, [api, logParty, can.partiesView, can.ordersView, can.shippingView, can.returnsView])

  const lookUp = useCallback(async () => {
    if (!log) return
    const read = ++previewRead.current
    setLog({ ...log, previewing: true })
    try {
      const body = logBody({ ...log.draft, description: log.draft.description || ' ' }, companyId, today)
      const preview = await previewComplaint(api, {
        companyId,
        ...(body.partyId ? { partyId: body.partyId } : {}),
        ...(body.serial ? { serial: body.serial } : {}),
        ...(body.salesOrderId ? { salesOrderId: body.salesOrderId } : {}),
        ...(body.shipmentId ? { shipmentId: body.shipmentId } : {}),
        ...(body.styleId ? { styleId: body.styleId } : {}),
        ...(body.batchNumber ? { batchNumber: body.batchNumber } : {}),
      })
      if (read !== previewRead.current) return
      setLog((current) => (current ? { ...current, preview, previewing: false, draft: withPreview(current.draft, preview) } : current))
    } catch (error) {
      if (read !== previewRead.current) return
      setLog((current) => (current ? { ...current, previewing: false, problem: refusalKey(error) } : current))
    }
  }, [api, companyId, log, today])

  const submitLog = useCallback(async () => {
    if (!log || log.busy) return
    if (logProblems(log.draft, today).length > 0) {
      setLog({ ...log, showProblems: true })
      return
    }
    setLog({ ...log, busy: true, problem: null })
    logKey.current ??= newIdempotencyKey()
    try {
      const answer = await logComplaint(api, logBody(log.draft, companyId, today), logKey.current)
      const complaint = answer.complaint
      let failed = 0
      for (const photo of log.draft.photos) {
        try {
          await uploadPhoto(api, complaint, photo)
        } catch {
          failed += 1
        }
      }
      logKey.current = null
      setLog(null)
      setNotice({ tone: failed > 0 ? 'warning' : 'success', words: { key: 'done.logged', params: { number: complaint.number } }, detail: failed > 0 ? { key: 'done.photosFailed', params: { count: failed } } : null })
      void load()
      void loadCounts()
      if (can.manage) {
        setQueue([complaint.id])
        go({ log: false, open: complaint.id })
      } else router.push(recordHref(prefix, complaint.id))
    } catch (error) {
      logKey.current = null
      setLog((current) => (current ? { ...current, busy: false, problem: refusalKey(error) } : current))
    }
  }, [api, can.manage, companyId, go, load, loadCounts, log, prefix, router, today])

  // ---- acknowledge -----------------------------------------------------------------------------------------------------------
  const [acknowledge, setAcknowledge] = useState<{ alert: SafetyAlert; busy: boolean; problem: string | null } | null>(null)
  const confirmAcknowledge = useCallback(
    async (note: string | null) => {
      if (!acknowledge || acknowledge.busy) return
      setAcknowledge({ ...acknowledge, busy: true, problem: null })
      try {
        const complaint = await acknowledgeComplaint(api, { id: acknowledge.alert.id, version: acknowledge.alert.version }, note)
        setAcknowledge(null)
        setNotice({ tone: 'success', words: { key: 'done.acknowledged', params: { number: complaint.number } } })
        void loadCounts()
        void load()
      } catch (error) {
        if (isStale(error)) void loadCounts()
        setAcknowledge((current) => (current ? { ...current, busy: false, problem: refusalKey(error) } : current))
      }
    },
    [acknowledge, api, load, loadCounts],
  )

  const exportRows = useCallback(
    (list: readonly ComplaintRow[]) => {
      downloadText(t('csv.file', { day: today }), complaintsCsv(list, rows.people, t, can.price))
      setNotice({ tone: 'success', words: { key: 'done.exported', params: { count: list.length } } })
    },
    [t, today, rows.people, can.price],
  )

  return (
    <ComplaintsView
      model={{
        prefix,
        can,
        address,
        rows,
        counts,
        countsFailed,
        asOf,
        live,
        offline,
        updates,
        today,
        notice,
        triage: triageModel,
        log,
        acknowledge,
      }}
      actions={{
        onAddress: (patch) => go({ ...patch, open: null }),
        onClearFilters: () => go({ view: 'open', q: '', category: null, severity: null, mine: false, partyId: null, salesOrderId: null, shipmentId: null, returnId: null, open: null }),
        onRetry: () => {
          setRows({ items: null, people: [], more: false, loadingMore: false, problem: null })
          void load()
          void loadCounts()
        },
        onMore: () => void more(),
        onShowUpdates: () => {
          void load()
          void loadCounts()
        },
        onOpen: (row) => {
          if (row.status === 'NEW' && can.manage) {
            setQueue((rows.items ?? []).filter((entry) => entry.status === 'NEW').map((entry) => entry.id))
            go({ open: row.id })
          } else router.push(recordHref(prefix, row.id))
        },
        onStartTriage: (ids) => void startTriage(ids),
        onLog: () => go({ log: true, open: null }),
        onAcknowledge: (alert) => setAcknowledge({ alert, busy: false, problem: null }),
        onAcknowledgeConfirm: (note) => void confirmAcknowledge(note),
        onAcknowledgeClose: () => setAcknowledge(null),
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ tone: 'success', words: { key: 'done.copied', params: { text } } }),
            () => undefined,
          )
        },
        onExport: exportRows,
        onDismissNotice: () => setNotice(null),
        onTriageGo: (id) => go({ open: id }),
        onTriageClose: () => {
          setQueue([])
          go({ open: null })
        },
        onTriageRetry: () => address.open && void loadTriage(address.open),
        onTriageDraft: (patch) => {
          triageKey.current = null
          setTriage((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current))
        },
        onTriageSave: () => void saveTriage(false),
        onTriageConfirmSafety: () => void saveTriage(true),
        onTriageCancelSafety: () => setTriage((current) => (current ? { ...current, confirmSafety: false } : current)),
        onLogDraft: (patch) => {
          logKey.current = null
          setLog((current) => (current ? { ...current, draft: { ...current.draft, ...patch }, ...(patch.serial !== undefined || patch.partyId !== undefined ? { preview: patch.partyId !== undefined ? null : current.preview } : {}) } : current))
        },
        onLogLookUp: () => void lookUp(),
        onLogSubmit: () => void submitLog(),
        onLogClose: () => go({ log: false }),
      }}
    />
  )
}
