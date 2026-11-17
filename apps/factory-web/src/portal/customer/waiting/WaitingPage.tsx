'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApprovalDecision } from '@nexus/factory-domain/approvals-out/kinds'
import { isApiError } from '../../../lib/api/errors'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale, useT } from '../../../lib/i18n/provider'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalTasks } from '../../shell/PortalShell'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { NotInAccessHere } from '../../supplier/orders/parts'
import { answerProblem, answerRefusal, isPdf, isPicture, neighbourOf, requestHeld } from '../home/model'
import type { ApproveDialogModel } from '../home/view/ApproveDialog'
import { answerApproval, approvalFileBytes, fetchApproval, fetchOpenItems, fetchWaiting, type ApprovalRead, type OpenItemsRead, type WaitingList } from './api'
import { answerQueue, NS, pendingOf, sendRefusal, UNDO_MS, waitingGroupsOf, waitingRowsOf, type PendingAnswer, type WaitingRow } from './model'
import { WaitingView, type WaitingViewModel } from './view/WaitingView'

/**
 * `/p/<party>/waiting` for a customer (F-PR-14; production plan §5; 06-tree B.3): reads what we ask the organisation (GET
 * /portal/approvals?state=OPEN), who asked (the frame's one task list) and, for a person who sees payments, what is still to pay
 * (the documents' open items); groups them; answers in the Approve pop-up of Home. A signed answer waits here 10 seconds (Undo),
 * then goes to us as ONE command (POST /portal/approvals/:id/answer); leaving the page sends what waits at once, closing the tab
 * asks first. Reads again on the live channel (a request asked or answered, a task changed).
 */
export function CustomerWaitingPage() {
  return (
    <WithMessages namespaces={[NS, 'portal-customer-home', 'portal', 'shell', 'ds-words']}>
      <WaitingRoute />
    </WithMessages>
  )
}

function WaitingRoute() {
  const frame = usePortalFrame()
  return frame.me.permissions.includes('portal.approvals.view') ? <WaitingContainer /> : <NotInAccessHere />
}

type Async<T> = { state: 'loading' | 'error' | 'ready'; value: T | null }
type DialogState = Omit<ApproveDialogModel, 'held' | 'position' | 'pending'> & { queue: string[] }
type Done = WaitingViewModel['done'][string]

function useOffline(): boolean {
  const [online, setOnline] = useState(true)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return !online
}

function WaitingContainer() {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const tasks = usePortalTasks()
  const t = useT(NS)
  const home = useT('portal-customer-home')
  const locale = useLocale()
  const offline = useOffline()
  const can = useCallback((permission: string) => frame.me.permissions.includes(permission), [frame.me.permissions])
  const seesPayments = can('portal.payments.view')
  const preview = frame.me.preview
  const mayApprove = can('portal.approve') || (frame.access ? frame.access.capabilities.includes('portal.approve') : false)
  const admins = (frame.access?.admins ?? []).map((admin) => admin.displayName)

  // ── reads ──
  const [list, setList] = useState<Async<WaitingList>>({ state: 'loading', value: null })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [payments, setPayments] = useState<OpenItemsRead | null>(null)
  const read = useCallback(() => {
    fetchWaiting(api)
      .then((value) => {
        setList({ state: 'ready', value })
        setAsOf(new Date().toISOString())
      })
      // A failed read is never drawn as empty: what was read stays, else the page says it failed.
      .catch(() => setList((current) => ({ state: current.value ? 'ready' : 'error', value: current.value })))
    if (seesPayments) fetchOpenItems(api).then(setPayments, () => setPayments(null))
  }, [api, seesPayments])
  useEffect(() => {
    read()
  }, [read])
  usePortalLive({
    onChange: (change) => {
      if (change.type.startsWith('approval_request.') || change.type.startsWith('partner_task.') || change.type === 'partner_notification.created' || change.type.startsWith('payment')) read()
    },
    onReconnect: read,
  })

  usePortalBand({ title: t('page.title'), status: asOf ? { label: t('page.updated', { time: formatTime(asOf, { locale }) }), tone: 'neutral' } : null })

  // ── the rows (and the ones answered here just now, kept with their words until the page is left) ──
  const [done, setDone] = useState<Record<string, Done>>({})
  const [answered, setAnswered] = useState<Record<string, WaitingRow>>({})
  const taskRows = useMemo(() => tasks.model.groups.flatMap((group) => group.rows), [tasks.model.groups])
  const rows = useMemo(() => {
    const now = Date.now()
    const own = waitingRowsOf({ approvals: list.value?.items ?? [], tasks: taskRows, payments, locale, prefix: frame.prefix, now })
    const kept = Object.values(answered).filter((row) => !own.some((entry) => entry.id === row.id))
    return [...own, ...kept]
  }, [list.value, taskRows, payments, locale, frame.prefix, answered])
  const groups = useMemo(() => waitingGroupsOf(rows), [rows])
  const queue = useMemo(() => answerQueue(groups).filter((id) => !done[id]), [groups, done])

  // ── the answer dialog (Home's Approve pop-up) ──
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [notice, setNotice] = useState<WaitingViewModel['notice']>(null)
  const filePicture = useRef<string | null>(null)
  const dropFile = () => {
    if (filePicture.current) URL.revokeObjectURL(filePicture.current)
    filePicture.current = null
  }
  useEffect(() => () => dropFile(), [])
  const readApproval = (requestId: string, order: string[]) => {
    dropFile()
    setDialog({ requestId, queue: order, state: 'loading', page: null, decision: null, comment: '', answer: 'idle', problem: null, field: null, file: null })
    fetchApproval(api, requestId)
      .then((page) => setDialog((current) => (current?.requestId === requestId ? { ...current, state: 'ready', page } : current)))
      // Not one of the party's, or no longer waiting: said neutrally ("no longer waits"), never more.
      .catch((error: unknown) => setDialog((current) => (current?.requestId === requestId ? { ...current, state: isApiError(error) && error.kind === 'not_found' ? 'gone' : 'error' } : current)))
  }
  const heldOf = (page: ApprovalRead | null, busy: boolean): string | null => {
    if (preview) return home('held.preview')
    if (!mayApprove) return admins.length > 0 ? home('held.mayApproveAsk', { admins: admins.join(', ') }) : home('held.mayApprove')
    if (offline) return home('held.offline')
    if (busy) return home('held.busy')
    if (!page) return home('held.reading')
    // Another colleague answers it, or the reader's buyer (a priced counter-offer): the API's own words name who.
    if (!page.may.answer && page.may.held) return page.may.held
    const own = requestHeld(page)
    return own ? home(own) : null
  }

  // ── the Undo window: an answer waits 10 seconds here, then goes to us ──
  const pendings = useRef<Map<string, { answer: PendingAnswer; timer: ReturnType<typeof setTimeout> }>>(new Map())
  const [pendingView, setPendingView] = useState<Record<string, { until: number; decision: ApprovalDecision }>>({})
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const send = useCallback(
    (requestId: string) => {
      const entry = pendings.current.get(requestId)
      if (!entry) return
      clearTimeout(entry.timer)
      pendings.current.delete(requestId)
      const { answer } = entry
      setPendingView((current) => {
        const next = { ...current }
        delete next[requestId]
        return next
      })
      setDone((current) => ({ ...current, [requestId]: { phase: 'sending', decision: answer.decision } }))
      setDialog((current) => (current?.requestId === requestId ? { ...current, answer: 'busy' } : current))
      answerApproval(api, requestId, { decision: answer.decision, answer: answer.answer, typedName: answer.typedName, version: answer.version })
        .then((page) => {
          setDone((current) => ({ ...current, [requestId]: { phase: 'sent', decision: answer.decision } }))
          const row = rowsRef.current.find((entry) => entry.id === requestId)
          if (row) setAnswered((current) => ({ ...current, [requestId]: row }))
          setDialog((current) => (current?.requestId === requestId ? { ...current, page, answer: 'done' } : current))
          frame.refreshTasks()
          read()
        })
        .catch((error: unknown) => {
          const kind = isApiError(error) ? error.kind : null
          setDone((current) => {
            const next = { ...current }
            delete next[requestId]
            return next
          })
          setNotice({ tone: 'danger', key: sendRefusal(kind) })
          setDialog((current) => (current?.requestId === requestId ? { ...current, answer: 'idle', problem: answerRefusal(kind).key, field: null, ...(kind === 'not_found' ? { state: 'gone' as const } : {}) } : current))
          read()
        })
    },
    [api, frame, read],
  )
  const sign = (typedName: string) => {
    const current = dialog
    if (!current?.page || current.answer === 'busy' || pendings.current.has(current.requestId) || heldOf(current.page, false)) return
    const problem = answerProblem(current.decision, current.comment)
    if (problem) return setDialog({ ...current, problem: problem.key, field: problem.field })
    const answer = pendingOf({ requestId: current.requestId, decision: current.decision as ApprovalDecision, answer: current.comment.trim() || null, typedName: typedName.trim(), version: current.page.request.version }, Date.now())
    const timer = setTimeout(() => send(answer.requestId), UNDO_MS)
    pendings.current.set(answer.requestId, { answer, timer })
    setPendingView((now) => ({ ...now, [answer.requestId]: { until: answer.sendAt, decision: answer.decision } }))
    setDone((now) => ({ ...now, [answer.requestId]: { phase: 'pending', decision: answer.decision } }))
    setDialog({ ...current, problem: null, field: null })
  }
  const undo = (requestId: string) => {
    const entry = pendings.current.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    pendings.current.delete(requestId)
    setPendingView((current) => {
      const next = { ...current }
      delete next[requestId]
      return next
    })
    setDone((current) => {
      const next = { ...current }
      delete next[requestId]
      return next
    })
    setNotice({ tone: 'info', key: 'notice.undone' })
  }
  // Leaving the page sends what waits at once (never lost); closing the tab asks first.
  const sendRef = useRef(send)
  sendRef.current = send
  useEffect(
    () => () => {
      for (const requestId of [...pendings.current.keys()]) sendRef.current(requestId)
    },
    [],
  )
  const waiting = Object.keys(pendingView).length > 0
  useEffect(() => {
    if (!waiting) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [waiting])

  const openFile = (fileId: string | null) => {
    dropFile()
    const page = dialog?.page
    if (!fileId || !page) {
      setDialog((current) => (current ? { ...current, file: null } : current))
      return
    }
    const file = page.files.find((entry) => entry.id === fileId)
    if (!file) return
    const pdf = isPdf(file.contentType)
    setDialog((current) => (current ? { ...current, file: { id: fileId, name: file.originalName, state: 'loading', src: null, pdf } } : current))
    approvalFileBytes(api, fileId)
      .then((bytes) => {
        const src = pdf ? bytes : isPicture(file.contentType) ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.contentType })) : null
        if (typeof src === 'string') filePicture.current = src
        setDialog((current) => (current?.file?.id === fileId ? { ...current, file: { ...current.file, state: src ? 'ready' : 'error', src } } : current))
      })
      .catch(() => setDialog((current) => (current?.file?.id === fileId ? { ...current, file: { ...current.file, state: 'error' } } : current)))
  }

  const dialogModel: ApproveDialogModel | null = dialog
    ? {
        ...dialog,
        held: heldOf(dialog.page, dialog.answer === 'busy'),
        position: dialog.queue.length > 1 && dialog.queue.includes(dialog.requestId) ? { index: dialog.queue.indexOf(dialog.requestId) + 1, count: dialog.queue.length } : null,
        pending: pendingView[dialog.requestId] ?? null,
      }
    : null

  return (
    <WaitingView
      model={{ state: list.state, groups, done, notice, dialog: dialogModel }}
      actions={{
        onOpen: (row) => readApproval(row.id, row.verb.act === 'answer' ? queue : [row.id]),
        onUndo: undo,
        onRetry: () => {
          setList({ state: 'loading', value: null })
          read()
        },
        onDismissNotice: () => setNotice(null),
        dialog: {
          onClose: () => {
            // A signed answer still waiting goes on its own time (the row keeps its Undo).
            dropFile()
            setDialog((current) => (current?.answer === 'busy' ? current : null))
          },
          onRetry: () => (dialog ? readApproval(dialog.requestId, dialog.queue) : undefined),
          onDecision: (decision) => setDialog((current) => (current ? { ...current, decision, problem: current.field === 'decision' ? null : current.problem, field: current.field === 'decision' ? null : current.field } : current)),
          onComment: (comment) => setDialog((current) => (current ? { ...current, comment, ...(current.field === 'comment' ? { problem: null, field: null } : {}) } : current)),
          onSign: sign,
          onUndo: () => (dialog ? undo(dialog.requestId) : undefined),
          onStep: (step) => {
            if (!dialog) return
            const next = neighbourOf(dialog.queue, dialog.requestId, step)
            if (next) readApproval(next, dialog.queue)
          },
          onOpenFile: openFile,
        },
      }}
    />
  )
}
