'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { formatTime } from '../../../../lib/i18n/format'
import { useLocale } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { companyPrefix } from '../../../../lib/session/session'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { useLiveBus } from '../../../../shell/live/use-live'
import {
  approverOptions,
  cancelOrder,
  listRequests,
  readCompare,
  readDrift,
  readOrder,
  readRequest,
  readStyle,
  releaseOrder,
  setApprovers,
  setOrderRequests,
  setWorkInProgress,
  startDraftRevision,
  submitOrder,
  updateOrder,
  updateRequest,
  uploadRequestPhoto,
  type OrderView,
  type RequestView,
} from '../api'
import {
  approversOf,
  changesCan,
  fieldOfPath,
  orderChanges,
  orderDraftOf,
  readProblem,
  recordTabOf,
  requestChanges,
  requestDraftOf,
  rowOfOrder,
  rowOfRequest,
  wipBody,
  wipLinesOf,
  writeProblem,
  type Notice,
  type Phrase,
  type RecordKind,
} from '../model'
import { useDecide } from '../use-decide'
import type { ChangeRecordModel, Loaded, RecordDialog } from './view-model'
import { ChangeRecordView } from './view/ChangeRecordView'

const LIVE_TYPES = ['change_request.', 'change_order.'] as const

/**
 * `/w/<company>/products/changes/requests/<id>` and `/…/orders/<id>` `?tab=change|impact|approvals|affected|activity` (the
 * change's record, also opened in a new tab by ⌘-click on a row). It reads the record, then each tab's part on its own (the
 * style's revisions for a request's revision; a change order's redline, the drift, the approver picker, the requests it may
 * carry) and does what the view asks — every write with the version read and one Idempotency-Key per attempt. Live
 * change_request.* / change_order.* of this record read it again (while a tab holds unsaved work: the "changed elsewhere"
 * banner instead).
 */
export function ChangeRecord({ kind, id }: { kind: RecordKind; id: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const params = useSearchParams()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const can = useMemo(() => changesCan(session.permissions), [session.permissions])
  const tab = recordTabOf(params)
  const photosFailedTerm = Number(params.get('photosFailed') ?? 0) || 0

  const [loaded, setLoaded] = useState<Loaded>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [lines, setLines] = useState<readonly Phrase[]>([])
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState<string | null>(null)
  const order = loaded.status === 'ready' ? (loaded.order ?? null) : null
  const request = loaded.status === 'ready' ? (loaded.request ?? null) : null
  const orderRef = useRef<OrderView | null>(null)
  orderRef.current = order
  const requestRef = useRef<RequestView | null>(null)
  requestRef.current = request

  const say = useCallback((phrase: Phrase, tone: Notice['tone'], places: readonly Phrase[] = []) => {
    setNotice({ ...phrase, tone })
    setLines(places)
  }, [])
  const refused = useCallback(
    (error: unknown) => {
      const problem = writeProblem(error)
      say(problem, 'danger', [...new Set(problem.paths.map(fieldOfPath))].map((key) => ({ key })))
      if (problem.stale) setStale(formatTime(new Date().toISOString(), { locale }))
      return problem
    },
    [say, locale],
  )
  const ready = useCallback((value: OrderView | RequestView) => {
    setLoaded(kind === 'order' ? { status: 'ready', order: value as OrderView } : { status: 'ready', request: value as RequestView })
    setAsOf(new Date().toISOString())
    setStale(null)
  }, [kind])

  const load = useCallback(async () => {
    if (!can.view) return
    try {
      ready(kind === 'order' ? await readOrder(api, id) : await readRequest(api, id))
    } catch (error) {
      const problem = isApiError(error) ? error.kind : null
      setLoaded(problem === 'not_found' ? { status: 'notFound' } : problem === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
    }
  }, [api, can.view, kind, id, ready])
  useEffect(() => {
    setLoaded({ status: 'loading' })
    void load()
  }, [load])

  // ---- a request: the Change tab, the style's revisions, photos ------------------------------------------------------------------
  const [requestDraft, setRequestDraft] = useState<ChangeRecordModel['request']['draft']>(null)
  const [requestSaving, setRequestSaving] = useState(false)
  const [style, setStyle] = useState<ChangeRecordModel['request']['style']>({ value: null, problem: null })
  const [photos, setPhotos] = useState({ busy: false, failed: photosFailedTerm })
  const requestStyleId = request?.style.id ?? null
  useEffect(() => {
    if (!requestStyleId || !can.styles || !can.request) return
    const controller = new AbortController()
    readStyle(api, requestStyleId, controller.signal)
      .then((value) => setStyle({ value, problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setStyle({ value: null, problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, requestStyleId, can.styles, can.request])

  const saveRequest = useCallback(async () => {
    const now = requestRef.current
    if (!now || !requestDraft || requestSaving) return
    const changes = requestChanges(now, requestDraft)
    if (!changes.body) return
    setRequestSaving(true)
    try {
      ready(await updateRequest(api, now.id, changes.body))
      setRequestDraft(null)
      say({ key: 'record.saved' }, 'success')
    } catch (error) {
      refused(error)
    } finally {
      setRequestSaving(false)
    }
  }, [api, requestDraft, requestSaving, ready, say, refused])

  const addPhotos = useCallback(
    async (files: File[]) => {
      const now = requestRef.current
      if (!now || files.length === 0) return
      setPhotos({ busy: true, failed: 0 })
      let failed = 0
      for (const file of files) {
        try {
          await uploadRequestPhoto(api, { id: now.id, companyId: now.companyId }, file)
        } catch {
          failed++
        }
      }
      setPhotos({ busy: false, failed })
      if (failed < files.length) say({ key: 'photos.added', params: { count: files.length - failed } }, 'success')
      void load()
    },
    [api, load, say],
  )

  // ---- a change order: the Change tab, the redline, the drift ---------------------------------------------------------------------
  const [orderDraft, setOrderDraft] = useState<ChangeRecordModel['order']['draft']>(null)
  const [orderSaving, setOrderSaving] = useState(false)
  const [redline, setRedline] = useState<ChangeRecordModel['order']['redline']>(null)
  const [drift, setDrift] = useState<ChangeRecordModel['order']['drift']>(null)
  // The redline is read again when the order moves (its version) or proposes another revision.
  const compareKey = order ? `${order.compare?.from ?? ''}:${order.compare?.to ?? ''}:${order.version}` : null
  const readRedline = useCallback(() => {
    const now = orderRef.current
    if (!now) return
    if (!now.compare) {
      setRedline({ compare: null, problem: null, none: true })
      return
    }
    if (!can.bom) {
      setRedline(null)
      return
    }
    setRedline({ compare: null, problem: null })
    readCompare(api, now.compare)
      .then((value) => setRedline({ compare: value, problem: null }))
      .catch((error: unknown) => setRedline({ compare: null, problem: readProblem(error) }))
  }, [api, can.bom])
  useEffect(() => {
    if (kind === 'order' && tab === 'change' && compareKey !== null) readRedline()
  }, [kind, tab, readRedline, compareKey])
  const orderStyleId = order?.style.id ?? null
  const readDriftNow = useCallback(() => {
    if (!orderStyleId || !can.bom) return
    setDrift({ value: null, problem: null })
    readDrift(api, orderStyleId)
      .then((value) => setDrift({ value, problem: null }))
      .catch((error: unknown) => setDrift({ value: null, problem: readProblem(error) }))
  }, [api, orderStyleId, can.bom])
  useEffect(() => {
    if (kind === 'order' && (tab === 'impact' || tab === 'affected')) readDriftNow()
  }, [kind, tab, readDriftNow])

  const saveOrder = useCallback(async () => {
    const now = orderRef.current
    if (!now || !orderDraft || orderSaving) return
    const changes = orderChanges(now, orderDraft)
    if (!changes.body) return
    setOrderSaving(true)
    try {
      ready(await updateOrder(api, now.id, changes.body))
      setOrderDraft(null)
      say({ key: 'record.saved' }, 'success')
    } catch (error) {
      refused(error)
    } finally {
      setOrderSaving(false)
    }
  }, [api, orderDraft, orderSaving, ready, say, refused])

  /** One write of the change order at the version read: the answer is the record. */
  const orderWrite = useCallback(
    async (write: (order: OrderView, key: string) => Promise<OrderView>, receipt: Phrase): Promise<boolean> => {
      const now = orderRef.current
      if (!now) return false
      setBusy(true)
      try {
        ready(await write(now, newIdempotencyKey()))
        say(receipt, 'success')
        return true
      } catch (error) {
        refused(error)
        return false
      } finally {
        setBusy(false)
      }
    },
    [ready, say, refused],
  )

  // ---- work in progress, approvers, the requests carried ---------------------------------------------------------------------------
  const [wip, setWip] = useState<ChangeRecordModel['wip']>({ lines: null, saving: false })
  const [approvers, setApproversDraft] = useState<ChangeRecordModel['approvers']>({ lines: null, options: null, pick: '', saving: false })
  const [carried, setCarried] = useState<ChangeRecordModel['carried']>({ ids: null, options: null, saving: false })

  // ---- the dialogs ------------------------------------------------------------------------------------------------------------------
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const submitDialog = useCallback(async () => {
    const now = orderRef.current
    if (!now || !dialog || dialog.busy) return
    setDialog({ ...dialog, busy: true, notice: null })
    const key = newIdempotencyKey()
    try {
      if (dialog.kind === 'cancel') {
        ready(await cancelOrder(api, now.id, { version: now.version, reason: dialog.reason.trim() }, key))
        say({ key: 'record.cancelled', params: { number: now.number } }, 'success')
      } else if (dialog.kind === 'release') {
        ready(await releaseOrder(api, now.id, { version: now.version, ...(dialog.changeNote.trim() ? { changeNote: dialog.changeNote.trim() } : {}) }, key))
        say({ key: 'record.released', params: { number: now.number, revision: now.toRevision?.revision ?? 0 } }, 'success')
      } else {
        const value = await startDraftRevision(api, now.id, { version: now.version, ...(dialog.changeNote.trim() ? { changeNote: dialog.changeNote.trim() } : {}) }, key)
        ready(value)
        say({ key: 'record.draftStarted', params: { revision: value.toRevision?.revision ?? 0 } }, 'success')
      }
      setDialog(null)
    } catch (error) {
      const problem = writeProblem(error)
      setDialog((value) => (value ? { ...value, busy: false, notice: { ...problem, tone: 'danger' } } : value))
      if (problem.stale) void load()
    }
  }, [api, dialog, ready, say, load])

  // ---- Approve change (this record) -------------------------------------------------------------------------------------------------
  const { decide, setDecide, open: openDecide, submit: submitDecide } = useDecide(
    api,
    can,
    me,
    (receipt) => {
      say(receipt, 'success')
      setDecide(null)
      void load()
    },
    (failed) => say({ key: failed }, 'danger'),
  )
  const openOwnDecide = useCallback(() => {
    const row = order ? rowOfOrder(order) : request ? rowOfRequest(request) : null
    if (row) void openDecide(row.id, row, [row.id])
  }, [order, request, openDecide])

  // ---- live ---------------------------------------------------------------------------------------------------------------------
  const unsaved = requestDraft !== null || orderDraft !== null || wip.lines !== null || approvers.lines !== null || carried.ids !== null
  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!LIVE_TYPES.some((type) => change.type.startsWith(type))) return
        const fields = change.fields as Record<string, unknown>
        if (fields.changeRequestId !== id && fields.changeOrderId !== id) return
        if (unsaved) setStale(formatTime(new Date().toISOString(), { locale }))
        else void load()
      },
      onReconnect: () => void load(),
    },
    can.view,
  )
  const offline = live === 'offline'

  const panels =
    loaded.status === 'ready' && can.thread ? (
      <RecordPanels
        record={{ type: kind === 'order' ? 'ChangeOrder' : 'ChangeRequest', id, companyId: (order ?? request)!.companyId, siteId: request?.siteId ?? null }}
        title={`${order?.number ?? request?.number ?? ''} · ${(order ?? request)!.style.code}`}
      />
    ) : null

  return (
    <ChangeRecordView
      model={{
        prefix,
        me,
        can,
        kind,
        tab,
        loaded,
        asOf,
        live,
        stale,
        notice,
        lines,
        busy,
        request: { draft: requestDraft, style, saving: requestSaving, photos },
        order: { draft: orderDraft, saving: orderSaving, redline, drift },
        wip,
        approvers,
        carried,
        dialog,
        decide: decide ? { ...decide, offline, holds: offline ? { APPROVED: { key: 'held.offline' }, REJECTED: { key: 'held.offline' }, IN_REVIEW: { key: 'held.offline' } } : decide.holds } : null,
      }}
      panels={panels}
      actions={{
        onRetry: () => void load(),
        onReload: () => {
          setRequestDraft(null)
          setOrderDraft(null)
          setWip({ lines: null, saving: false })
          setApproversDraft((now) => ({ ...now, lines: null }))
          setCarried((now) => ({ ...now, ids: null }))
          void load()
        },
        onDismissNotice: () => {
          setNotice(null)
          setLines([])
        },
        onCopy: () => {
          const number = order?.number ?? request?.number
          if (!number) return
          void navigator.clipboard
            ?.writeText(number)
            .then(() => say({ key: 'record.copied', params: { number } }, 'success'))
            .catch(() => undefined)
        },
        onRequestDraft: (patch) => setRequestDraft((now) => (request ? { ...(now ?? requestDraftOf(request)), ...patch } : now)),
        onRequestDiscard: () => setRequestDraft(null),
        onRequestSave: () => void saveRequest(),
        onPhotos: (files) => void addPhotos(files),
        onDecide: openOwnDecide,
        decide: {
          onReason: (reason) => setDecide((now) => (now ? { ...now, reason } : now)),
          onDecide: (choice) => void submitDecide(choice),
          onClose: () => setDecide(null),
          onRetry: openOwnDecide,
        },
        onOrderDraft: (patch) => setOrderDraft((now) => (order ? { ...(now ?? orderDraftOf(order)), ...patch } : now)),
        onOrderDiscard: () => setOrderDraft(null),
        onOrderSave: () => void saveOrder(),
        onUseAsNote: (note) => setOrderDraft((now) => (order ? { ...(now ?? orderDraftOf(order)), description: note } : now)),
        onRedlineRetry: readRedline,
        onDriftRetry: readDriftNow,
        onSubmit: () => void orderWrite((now, key) => submitOrder(api, now.id, now.version, key), { key: 'record.submitted' }),
        onDisposition: (workOrderId, disposition) => setWip((now) => (order ? { ...now, lines: (now.lines ?? wipLinesOf(order)).map((line) => (line.workOrderId === workOrderId ? { ...line, disposition } : line)) } : now)),
        onWipDiscard: () => setWip({ lines: null, saving: false }),
        onWipSave: () => {
          const drafted = wip.lines
          if (!drafted) return
          setWip((now) => ({ ...now, saving: true }))
          void orderWrite((now, key) => setWorkInProgress(api, now.id, { version: now.version, lines: wipBody(drafted) }, key), { key: 'record.wipSaved' }).then((ok) => setWip((now) => (ok ? { lines: null, saving: false } : { ...now, saving: false })))
        },
        onApproversEdit: () => {
          if (!order) return
          setApproversDraft({ lines: approversOf(order), options: { value: null, problem: null }, pick: '', saving: false })
          approverOptions(api, order.id)
            .then((value) => setApproversDraft((now) => ({ ...now, options: { value, problem: null } })))
            .catch((error: unknown) => setApproversDraft((now) => ({ ...now, options: { value: null, problem: readProblem(error) } })))
        },
        onApproverPick: (userId) => setApproversDraft((now) => ({ ...now, pick: userId })),
        onApproverAdd: () =>
          setApproversDraft((now) => {
            const person = now.options?.value?.people.find((one) => one.id === now.pick)
            if (!person || !now.lines) return now
            return { ...now, pick: '', lines: [...now.lines, { userId: person.id, name: person.name, required: true, decided: false }] }
          }),
        onApproverRequired: (userId, required) => setApproversDraft((now) => ({ ...now, lines: now.lines?.map((line) => (line.userId === userId ? { ...line, required } : line)) ?? null })),
        onApproverRemove: (userId) => setApproversDraft((now) => ({ ...now, lines: now.lines?.filter((line) => line.userId !== userId || line.decided) ?? null })),
        onApproversDiscard: () => setApproversDraft({ lines: null, options: null, pick: '', saving: false }),
        onApproversSave: () => {
          const drafted = approvers.lines
          if (!drafted) return
          setApproversDraft((now) => ({ ...now, saving: true }))
          void orderWrite((now, key) => setApprovers(api, now.id, { version: now.version, approvers: drafted.map((line) => ({ userId: line.userId, required: line.required })) }, key), { key: 'record.approversSaved' }).then((ok) =>
            setApproversDraft((now) => (ok ? { lines: null, options: null, pick: '', saving: false } : { ...now, saving: false })),
          )
        },
        onCarriedEdit: () => {
          if (!order) return
          setCarried({ ids: order.requestsList.map((one) => one.id), options: { value: null, problem: null }, saving: false })
          listRequests(api, { tile: 'ALL', styleId: order.style.id }, 200)
            .then((answer) => setCarried((now) => ({ ...now, options: { value: answer.rows, problem: null } })))
            .catch((error: unknown) => setCarried((now) => ({ ...now, options: { value: [], problem: readProblem(error) } })))
        },
        onCarriedToggle: (requestId, on) => setCarried((now) => ({ ...now, ids: now.ids ? (on ? [...now.ids, requestId] : now.ids.filter((one) => one !== requestId)) : now.ids })),
        onCarriedDiscard: () => setCarried({ ids: null, options: null, saving: false }),
        onCarriedSave: () => {
          const drafted = carried.ids
          if (!drafted) return
          setCarried((now) => ({ ...now, saving: true }))
          void orderWrite((now, key) => setOrderRequests(api, now.id, { version: now.version, requestIds: [...drafted] }, key), { key: 'record.requestsSaved' }).then((ok) =>
            setCarried((now) => (ok ? { ids: null, options: null, saving: false } : { ...now, saving: false })),
          )
        },
        onDialog: setDialog,
        onDialogPatch: (patch) => setDialog((now) => (now ? ({ ...now, ...patch } as RecordDialog) : now)),
        onDialogSubmit: () => void submitDialog(),
      }}
    />
  )
}
