'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import {
  createOrder,
  createRequest,
  findStyles,
  listOrders,
  listParties,
  listReleased,
  listRequests,
  listRounds,
  listWaitingSmv,
  readStyle,
  uploadRequestPhoto,
  type ReleasedList,
} from './api'
import {
  addressOf,
  addressText,
  emptyNewOrder,
  emptyNewRequest,
  fieldOfPath,
  HOME_ADDRESS,
  listsOf,
  newOrderBody,
  newRequestBody,
  readProblem,
  recordHref,
  rowOfSmv,
  rowsOf,
  changesCan,
  writeProblem,
  type ChangesRead,
  type ListAddress,
  type Notice,
} from './model'
import { ChangesMessages } from './parts'
import { ChangesListView } from './view/ChangesListView'
import type { DecideModel } from './view/DecideDialog'
import type { NewOrderModel } from './view/NewOrderDialog'
import type { NewRequestModel } from './view/NewRequestDialog'
import { useDecide } from './use-decide'

/**
 * `/w/<company>/products/changes` (SCR-117): change requests, change orders and the SMV changes waiting from Operations as one
 * list (`?tile=` the saved rows — the four tiles are four of them —, `?kind=`, `?style=`, `?q=`), or the versions released
 * (`?view=released`). New change request (`c`, `?new=1&style=`) raises one and opens it, photos sent after; New change order
 * (`?newOrder=1&style=&request=`) writes a draft and opens it. Approve change (`?decide=<kind>:<id>`, a row's Approve /
 * Reject) reads the record, its redline and impact, then decides it at the version read (J / K walk the list). Live
 * change_request.* / change_order.* / smv_version.* / style.revision_released: "N updates · Show" (rows never move under
 * the cursor); the tiles read again with the list.
 */
export function ChangesPage() {
  return (
    <ChangesMessages>
      <Container />
    </ChangesMessages>
  )
}

const LIVE_TYPES = ['change_request.', 'change_order.', 'smv_version.', 'style.revision_released'] as const
const LIMIT = 100

function Container() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const prefix = companyPrefix(session.company?.code ?? '')
  const companyId = session.company?.id ?? null
  const me = session.user.id
  const can = useMemo(() => changesCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const go = useCallback((next: Partial<ListAddress>) => router.replace(`${pathname}${addressText({ ...address, ...next })}`, { scroll: false }), [router, pathname, address])

  // ---- the three reads (and the released versions) --------------------------------------------------------------------------
  const [read, setRead] = useState<ChangesRead | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [released, setReleased] = useState<ReleasedList | null>(null)
  const [releasedProblem, setReleasedProblem] = useState<string | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dismissed, setDismissed] = useState<readonly string[]>([])
  const readId = useRef(0)
  const filters = useMemo(() => ({ styleId: address.style, q: address.q }), [address.style, address.q])
  const lists = useMemo(() => listsOf({ ...HOME_ADDRESS, tile: address.tile, kind: address.kind }), [address.tile, address.kind])

  const load = useCallback(async () => {
    if (!can.view) return
    const id = ++readId.current
    setProblem(null)
    try {
      // Each list is read under these rows, else once for its tiles only (limit 1).
      const [requests, orders, smv] = await Promise.all([
        listRequests(api, { ...(lists.requests ?? { tile: 'ALL' }), ...filters }, lists.requests ? LIMIT : 1),
        listOrders(api, { ...(lists.orders ?? { tile: 'ALL' }), ...filters }, lists.orders ? LIMIT : 1),
        can.smvView
          ? listWaitingSmv(api)
              .then((answer) => ({ value: { rows: answer.versions, count: answer.count }, failed: false }))
              .catch(() => ({ value: null, failed: true }))
          : Promise.resolve({ value: null, failed: false }),
      ])
      if (id !== readId.current) return
      setRead({ requests: lists.requests ? requests : { ...requests, rows: [], complete: true }, orders: lists.orders ? orders : { ...orders, rows: [], complete: true }, smv: smv.value, smvFailed: smv.failed })
      setAsOf(new Date().toISOString())
      setUpdates(0)
    } catch (error) {
      if (id === readId.current) setProblem(readProblem(error))
    }
  }, [api, can.view, can.smvView, lists, filters])

  const loadReleased = useCallback(async () => {
    if (!can.view || address.view !== 'released') return
    setReleasedProblem(null)
    try {
      setReleased(await listReleased(api, filters))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setReleasedProblem(readProblem(error))
    }
  }, [api, can.view, address.view, filters])

  useEffect(() => {
    setRead(null)
    void load()
  }, [load])
  useEffect(() => {
    setReleased(null)
    void loadReleased()
  }, [loadReleased])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!LIVE_TYPES.some((type) => change.type.startsWith(type))) return
        setUpdates((count) => count + 1)
      },
      onReconnect: () => {
        void load()
        void loadReleased()
      },
    },
    can.view,
  )
  const offline = live === 'offline'
  const rows = useMemo(() => (read ? rowsOf(read, address) : []), [read, address])

  // ---- New change request ------------------------------------------------------------------------------------------------------
  const [newRequest, setNewRequest] = useState<NewRequestModel | null>(null)
  const newKey = useRef<string | null>(null)
  const newRequestRef = useRef<NewRequestModel | null>(null)
  newRequestRef.current = newRequest
  const findRequestStyles = useCallback(
    (q: string) => {
      setNewRequest((now) => (now ? { ...now, styles: { q, items: null, problem: null } } : now))
      findStyles(api, q)
        .then((items) => setNewRequest((now) => (now ? { ...now, styles: { q, items, problem: null } } : now)))
        .catch((error: unknown) => setNewRequest((now) => (now ? { ...now, styles: { q, items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const readRounds = useCallback(
    (styleId: string) => {
      setNewRequest((now) => (now ? { ...now, rounds: { items: null, problem: null } } : now))
      listRounds(api, styleId)
        .then((items) => setNewRequest((now) => (now && now.draft.styleId === styleId ? { ...now, rounds: { items, problem: null } } : now)))
        .catch((error: unknown) => setNewRequest((now) => (now ? { ...now, rounds: { items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const pickRequestStyle = useCallback(
    (styleId: string | null) => {
      setNewRequest((now) => (now ? { ...now, draft: { ...now.draft, styleId, revisionId: '', sampleRoundId: null }, style: { item: null, reading: !!styleId, problem: null }, rounds: null } : now))
      if (!styleId) return
      readStyle(api, styleId)
        .then((item) => setNewRequest((now) => (now && now.draft.styleId === styleId ? { ...now, style: { item, reading: false, problem: null } } : now)))
        .catch((error: unknown) => setNewRequest((now) => (now ? { ...now, style: { item: null, reading: false, problem: readProblem(error) } } : now)))
      if (newRequestRef.current?.draft.source === 'SAMPLE' && can.samples) readRounds(styleId)
    },
    [api, can.samples, readRounds],
  )
  const styleTerm = address.style
  useEffect(() => {
    if (!address.isNew || !can.view) {
      setNewRequest(null)
      return
    }
    newKey.current = null
    setNewRequest({ draft: emptyNewRequest(styleTerm), styles: { q: '', items: null, problem: null }, style: { item: null, reading: !!styleTerm, problem: null }, parties: null, rounds: null, busy: false, notice: null, lines: [], offline: false })
    if (can.styles) findRequestStyles('')
    else setNewRequest((now) => (now ? { ...now, styles: { q: '', items: [], problem: 'problem.forbidden' } } : now))
    if (styleTerm)
      readStyle(api, styleTerm)
        .then((item) => setNewRequest((now) => (now ? { ...now, style: { item, reading: false, problem: null } } : now)))
        .catch((error: unknown) => setNewRequest((now) => (now ? { ...now, style: { item: null, reading: false, problem: readProblem(error) } } : now)))
    // The dialog opens once per `?new=1` (with the studio's style).
  }, [address.isNew, styleTerm, can.view, can.styles, api, findRequestStyles])

  const draftRequest = useCallback(
    (patch: Partial<NewRequestModel['draft']>) => {
      setNewRequest((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now))
      const source = patch.source
      if (source === 'CUSTOMER' || source === 'SUPPLIER') {
        setNewRequest((now) => (now ? { ...now, parties: { items: null, problem: null } } : now))
        listParties(api, source, companyId)
          .then((items) => setNewRequest((now) => (now && now.draft.source === source ? { ...now, parties: { items, problem: null } } : now)))
          .catch((error: unknown) => setNewRequest((now) => (now ? { ...now, parties: { items: [], problem: readProblem(error) } } : now)))
      }
      const styleId = newRequestRef.current?.draft.styleId
      if (source === 'SAMPLE' && styleId) readRounds(styleId)
    },
    [api, companyId, readRounds],
  )

  const submitRequest = useCallback(async () => {
    const now = newRequestRef.current
    if (!now || now.busy || !now.style.item) return
    setNewRequest({ ...now, busy: true, notice: null, lines: [] })
    newKey.current ??= newIdempotencyKey()
    try {
      const request = await createRequest(api, newRequestBody(now.draft, now.style.item, companyId), newKey.current)
      newKey.current = null
      let failedPhotos = 0
      for (const photo of now.draft.photos) {
        try {
          await uploadRequestPhoto(api, { id: request.id, companyId: request.companyId }, photo)
        } catch {
          failedPhotos++
        }
      }
      setNewRequest(null)
      router.push(`${recordHref(prefix, 'request', request.id)}${failedPhotos > 0 ? `?photosFailed=${failedPhotos}` : ''}`)
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) newKey.current = null
      setNewRequest((value) => (value ? { ...value, busy: false, notice: { ...refused, tone: 'danger' }, lines: [...new Set(refused.paths.map(fieldOfPath))].map((key) => ({ key })) } : value))
    }
  }, [api, companyId, router, prefix])

  // ---- New change order ----------------------------------------------------------------------------------------------------------
  const [newOrder, setNewOrder] = useState<NewOrderModel | null>(null)
  const orderKey = useRef<string | null>(null)
  const newOrderRef = useRef<NewOrderModel | null>(null)
  newOrderRef.current = newOrder
  const findOrderStyles = useCallback(
    (q: string) => {
      setNewOrder((now) => (now ? { ...now, styles: { q, items: null, problem: null } } : now))
      findStyles(api, q)
        .then((items) => setNewOrder((now) => (now ? { ...now, styles: { q, items, problem: null } } : now)))
        .catch((error: unknown) => setNewOrder((now) => (now ? { ...now, styles: { q, items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const readOrderStyle = useCallback(
    (styleId: string) => {
      readStyle(api, styleId)
        .then((item) => setNewOrder((now) => (now && now.draft.styleId === styleId ? { ...now, style: { item, reading: false, problem: null } } : now)))
        .catch((error: unknown) => setNewOrder((now) => (now ? { ...now, style: { item: null, reading: false, problem: readProblem(error) } } : now)))
      listRequests(api, { tile: 'ALL', styleId }, 200)
        .then((answer) => setNewOrder((now) => (now && now.draft.styleId === styleId ? { ...now, requests: { items: answer.rows, problem: null } } : now)))
        .catch((error: unknown) => setNewOrder((now) => (now ? { ...now, requests: { items: [], problem: readProblem(error) } } : now)))
    },
    [api],
  )
  const requestTerm = address.request
  useEffect(() => {
    if (!address.newOrder || !can.view) {
      setNewOrder(null)
      return
    }
    orderKey.current = null
    setNewOrder({ draft: emptyNewOrder(styleTerm, requestTerm ? [requestTerm] : []), styles: { q: '', items: null, problem: null }, style: { item: null, reading: !!styleTerm, problem: null }, requests: styleTerm ? { items: null, problem: null } : null, busy: false, notice: null, lines: [], offline: false })
    if (can.styles) findOrderStyles('')
    else setNewOrder((now) => (now ? { ...now, styles: { q: '', items: [], problem: 'problem.forbidden' } } : now))
    if (styleTerm) readOrderStyle(styleTerm)
  }, [address.newOrder, styleTerm, requestTerm, can.view, can.styles, findOrderStyles, readOrderStyle])

  const submitOrder = useCallback(async () => {
    const now = newOrderRef.current
    if (!now || now.busy || !now.style.item) return
    setNewOrder({ ...now, busy: true, notice: null, lines: [] })
    orderKey.current ??= newIdempotencyKey()
    try {
      const order = await createOrder(api, newOrderBody(now.draft, now.style.item, companyId), orderKey.current)
      orderKey.current = null
      setNewOrder(null)
      router.push(recordHref(prefix, 'order', order.id))
    } catch (error) {
      const refused = writeProblem(error)
      if (!refused.stale) orderKey.current = null
      setNewOrder((value) => (value ? { ...value, busy: false, notice: { ...refused, tone: 'danger' }, lines: [...new Set(refused.paths.map(fieldOfPath))].map((key) => ({ key })) } : value))
    }
  }, [api, companyId, router, prefix])

  // ---- Approve change ---------------------------------------------------------------------------------------------------------------
  const { decide, setDecide, open: openDecide, submit: submitDecide } = useDecide(
    api,
    can,
    me,
    (receipt) => {
      setNotice({ ...receipt, tone: 'success' })
      go({ decide: null })
      void load()
    },
    (failed) => {
      setNotice({ key: failed, tone: 'danger' })
      go({ decide: null })
    },
  )
  const decideRef = useRef<DecideModel | null>(null)
  decideRef.current = decide
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const decideTerm = address.decide
  const readOnce = read !== null
  useEffect(() => {
    if (!decideTerm || !can.view) {
      setDecide(null)
      return
    }
    if (decideRef.current?.row.id === decideTerm && !decideRef.current.problem) return
    // An SMV change is found in the list read; a change request or order by its record.
    if (!readOnce) return
    const known = rowsRef.current.find((row) => row.id === decideTerm) ?? null
    const waiting = decideTerm.startsWith('smv:') && !known ? (read?.smv?.rows.find((one) => `smv:${one.proposal.id}` === decideTerm) ?? null) : null
    void openDecide(decideTerm, known ?? (waiting ? rowOfSmv(waiting) : null), rowsRef.current.map((row) => row.id))
  }, [decideTerm, can.view, openDecide, setDecide, readOnce, read])

  return (
    <ChangesListView
      model={{
        prefix,
        me,
        can,
        address,
        read,
        problem,
        released,
        releasedProblem,
        asOf,
        live,
        updates,
        notice,
        dismissed,
        newRequest: newRequest ? { ...newRequest, offline } : null,
        newOrder: newOrder ? { ...newOrder, offline } : null,
        decide: decide ? { ...decide, offline, holds: offline ? { APPROVED: { key: 'held.offline' }, REJECTED: { key: 'held.offline' }, IN_REVIEW: { key: 'held.offline' } } : decide.holds } : null,
      }}
      actions={{
        onAddress: (patch) => go(patch),
        onClearFilters: () => go({ ...HOME_ADDRESS, view: address.view }),
        onRetry: () => {
          void load()
          void loadReleased()
        },
        onShowUpdates: () => void load(),
        onOpen: (row) => router.push(row.kind === 'smv' ? `${prefix}/products/operations/${encodeURIComponent(row.smv.operation.id)}` : recordHref(prefix, row.kind, row.recordId)),
        onNew: () => go({ isNew: true }),
        onNewOrder: () => go({ newOrder: true }),
        newRequest: {
          onDraft: draftRequest,
          onFindStyles: findRequestStyles,
          onPickStyle: pickRequestStyle,
          onSubmit: () => void submitRequest(),
          onClose: () => {
            setNewRequest(null)
            go({ isNew: false })
          },
        },
        newOrder: {
          onDraft: (patch) => setNewOrder((now) => (now ? { ...now, draft: { ...now.draft, ...patch } } : now)),
          onFindStyles: findOrderStyles,
          onPickStyle: (styleId) => {
            setNewOrder((now) => (now ? { ...now, draft: { ...now.draft, styleId, requestIds: [] }, style: { item: null, reading: !!styleId, problem: null }, requests: styleId ? { items: null, problem: null } : null } : now))
            if (styleId) readOrderStyle(styleId)
          },
          onSubmit: () => void submitOrder(),
          onClose: () => {
            setNewOrder(null)
            go({ newOrder: false, request: null })
          },
        },
        onDecide: (row) => go({ decide: row.id }),
        decide: {
          onReason: (reason) => setDecide((now) => (now ? { ...now, reason } : now)),
          onDecide: (choice) => void submitDecide(choice),
          onGo: (rowId) => go({ decide: rowId }),
          onClose: () => go({ decide: null }),
          onRetry: () => decide && void openDecide(decide.row.id, decide.row, decide.ids),
        },
        onCopy: (numbers) => {
          void navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ key: 'list.copied', params: { count: numbers.length }, tone: 'success' }))
            .catch(() => undefined)
        },
        onDismissNotice: () => setNotice(null),
        onDismissPageNotice: (id) => setDismissed((now) => [...now, id]),
      }}
    />
  )
}
