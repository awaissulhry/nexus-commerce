'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type { LineDraft } from '@nexus/ui/patterns/LineResponseList/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { dayIn } from '../../../lib/po-answer/quantities'
import { usePortalTasks } from '../../shell/PortalShell'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { orderBandOf } from './band'
import { confirmOrder, declineOrder, fetchNotices, fetchOrder, fetchRevisions, type AnswerEnd, type NoticeRow, type OrderPage, type PortalDeclineReason } from './api'
import { answerLines, lineRequestOf } from '../../../lib/po-answer/lines'
import { confirmAllBody, confirmBodyOf, declineHeld, NS, problemOf, recordHref, requestsAbout, reviewOf, seenKey, tabOf, type AnswerDraft, type AnswerProblem, type DeclineDraft, type RecordTab } from './model'
import { mayApprove, NotInAccessHere, useOffline } from './parts'
import { OrderRecordView, type AnswerDone, type OrderRecordViewModel } from './view/OrderRecordView'
import type { VersionModel } from './view/Dialogs'
import { useDsWords } from '../../../lib/i18n/ds-parts'
import { useOrderWords } from './words'

/**
 * `/p/<party>/orders/<id>?tab=…` for a supplier (B-W2b-179; design portal.supplier.orders rec "Purchase order"): reads the
 * order (GET /portal/purchase-orders/:id), fills the band (title, their reference first, the state, "Confirm all as asked",
 * the ⋯ with Decline, What changed, the PO PDF and Ask a question, the five tabs), keeps the answer being typed (guarded:
 * leaving asks first), sends it for the version shown with ONE Idempotency-Key per answer, and reads again on the live
 * channel's task events. The ship notices of the order come from B-W2b-182's list (portal.shipNotices.view).
 */
export function SupplierOrderPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <OrderContainer id={id} />
    </WithMessages>
  )
}

const EMPTY: AnswerDraft = { answers: {}, supplierRef: '', note: '' }
const DECLINE: DeclineDraft = { reason: 'NO_CAPACITY', note: '', tried: false }

type Dialog = { kind: 'confirmAll'; supplierRef: string } | { kind: 'decline'; draft: DeclineDraft } | { kind: 'version'; model: VersionModel } | null

function OrderContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const tasks = usePortalTasks()
  const router = useRouter()
  const search = useSearchParams()
  const words = useOrderWords()
  const { t, locale } = words
  const ds = useDsWords()
  const offline = useOffline()
  const tab = tabOf(search?.get('tab'))
  const highlight = search?.get('line') ?? null
  const allowed = frame.me.permissions.includes('portal.purchaseOrders.view')
  const canNotices = frame.me.permissions.includes('portal.shipNotices.view')
  const mayAnswerHere = mayApprove(frame)

  const [page, setPage] = useState<OrderPage | null>(null)
  const [state, setState] = useState<OrderRecordViewModel['state'] | 'forbidden'>('loading')
  const [draft, setDraft] = useState<AnswerDraft>(EMPTY)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<AnswerProblem | null>(null)
  const [done, setDone] = useState<AnswerDone | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [changesOpen, setChangesOpen] = useState(false)
  const [notices, setNotices] = useState<{ state: 'loading' | 'error' | 'noAccess' | 'ready'; items: NoticeRow[] }>({ state: canNotices ? 'loading' : 'noAccess', items: [] })
  const answerKey = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (answerKey.current?.body !== text) answerKey.current = { body: text, key: newIdempotencyKey() }
    return answerKey.current.key
  }

  const load = useCallback(async () => {
    try {
      const next = await fetchOrder(api, id)
      setPage(next)
      setState('ready')
      // A newer read keeps what was typed for the lines still open.
      setDraft((current) => ({ ...current, answers: Object.fromEntries(Object.entries(current.answers).filter(([lineId]) => next.lines.some((line) => line.id === lineId && !line.locked && !line.ended))) }))
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setState('missing')
      else if (isApiError(error) && error.kind === 'forbidden') setState('forbidden')
      else setState('error')
    }
  }, [api, id])

  const loadNotices = useCallback(async () => {
    if (!canNotices) return
    try {
      const read = await fetchNotices(api, id)
      setNotices({ state: 'ready', items: read.items })
    } catch (error) {
      setNotices({ state: isApiError(error) && error.kind === 'forbidden' ? 'noAccess' : 'error', items: [] })
    }
  }, [api, id, canNotices])

  useEffect(() => {
    if (!allowed) return
    void load()
    void loadNotices()
  }, [load, loadNotices, allowed])

  // "What changed in version N" opens by itself on the first visit after a revision (this device remembers the visit).
  useEffect(() => {
    if (!page?.changes) return
    const key = seenKey(page.order.id, page.changes.revision)
    try {
      if (!window.localStorage.getItem(key)) {
        setChangesOpen(true)
        window.localStorage.setItem(key, '1')
      }
    } catch {
      setChangesOpen(true)
    }
  }, [page?.order.id, page?.changes])

  usePortalLive({ onChange: (change) => (page?.live.events.includes(change.type) ? void load() : undefined), onReconnect: () => void load() }, allowed)

  const lines = useMemo(() => (page ? answerLines(page.lines) : []), [page])
  const requests = useMemo(() => (page ? lines.map((line) => lineRequestOf(line, words, page.answer.substitutes[line.id] ?? [])) : []), [page, lines, words])
  const dirty = !done && (Object.keys(draft.answers).length > 0 || draft.supplierRef.trim() !== '' || draft.note.trim() !== '')
  usePortalUnsaved(`po-answer:${id}`, { dirty, what: t('unsaved.answer') })

  const facts = { canAnswer: page?.answer.canAnswer ?? false, mayAnswer: (page?.answer.mayAnswer ?? true) && mayAnswerHere, preview: frame.me.preview, offline, busy }

  const answered = (end: AnswerEnd, supplierRef: string | null, summary: string | null) => {
    answerKey.current = null
    setPage(end)
    setDone({ outcome: end.outcome, summary, supplierRef })
    setDraft(EMPTY)
    setBusy(false)
    setDialog(null)
    frame.refreshTasks()
  }
  const refused = (error: unknown) => {
    setBusy(false)
    const next = problemOf(isApiError(error) ? error.kind : null)
    setProblem(next)
    if (next === 'changed') void load()
  }

  const send = () => {
    if (!page || busy) return
    const body = confirmBodyOf(page, draft, locale)
    const review = reviewOf(requests, draft.answers, locale)
    const summary = review.parts.map((part) => ds.lineResponseList.summary[part.key](part.count)).join(ds.lineResponseList.summaryJoin)
    setBusy(true)
    setProblem(null)
    confirmOrder(api, page.order.id, body, keyFor(body))
      .then((end) => answered(end, body.supplierRef ?? null, body.mode === 'BY_LINE' ? summary : null))
      .catch(refused)
  }

  const confirmAll = (supplierRef: string) => {
    if (!page || busy) return
    const body = confirmAllBody(page.order.version, supplierRef)
    setBusy(true)
    setProblem(null)
    confirmOrder(api, page.order.id, body, keyFor(body))
      .then((end) => answered(end, body.supplierRef ?? null, null))
      .catch(refused)
  }

  const declineSend = () => {
    if (!page || dialog?.kind !== 'decline') return
    const held = declineHeld(dialog.draft, facts)
    if (held) {
      setDialog({ kind: 'decline', draft: { ...dialog.draft, tried: true } })
      return
    }
    const body = { version: page.order.version, reason: dialog.draft.reason, note: dialog.draft.note.trim() || null }
    setBusy(true)
    setProblem(null)
    declineOrder(api, page.order.id, body, keyFor(body))
      .then((end) => answered(end, null, null))
      .catch(refused)
  }

  const openVersion = useCallback(
    (revision: number) => {
      if (!page) return
      if (page.changes && page.changes.revision === revision) {
        setDialog({ kind: 'version', model: { revision, state: 'ready', changes: page.changes } })
        return
      }
      setDialog({ kind: 'version', model: { revision, state: 'loading', changes: null } })
      fetchRevisions(api, page.order.id, locale)
        .then((read) => setDialog({ kind: 'version', model: { revision, state: 'ready', changes: read.revisions.find((entry) => entry.revision === revision) ?? null } }))
        .catch(() => setDialog({ kind: 'version', model: { revision, state: 'error', changes: null } }))
    },
    [api, page, locale],
  )

  const confirmHeld = !page ? null : frame.me.preview ? t('held.preview') : !page.answer.canAnswer ? t('held.answered') : !facts.mayAnswer ? t('held.mayAnswer') : offline ? t('held.offline') : busy ? t('held.busy') : null
  const ready = allowed && state === 'ready' && page
  usePortalBand(
    ready
      ? orderBandOf({
          t,
          locale,
          page,
          tab,
          prefix: frame.prefix,
          done: done !== null,
          confirmHeld,
          notices: notices.state === 'ready' ? notices.items.length : null,
          onConfirmAll: () => setDialog({ kind: 'confirmAll', supplierRef: draft.supplierRef }),
          onDecline: () => setDialog({ kind: 'decline', draft: DECLINE }),
          onVersion: openVersion,
        })
      : { title: state === 'missing' ? t('record.missing') : t('list.title'), back: { href: `${frame.prefix}/orders`, label: t('list.title') } },
  )

  // `c`: confirm all as asked (asks first).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' || event.metaKey || event.ctrlKey || event.altKey || !page?.answer.canAnswer || done) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.closest('[role="dialog"], [role="menu"]'))) return
      event.preventDefault()
      setDialog({ kind: 'confirmAll', supplierRef: draft.supplierRef })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [page, done, draft.supplierRef])

  if (!allowed || state === 'forbidden') return <NotInAccessHere />

  const orderRequests = requestsAbout(tasks.model.groups.flatMap((group) => group.rows), id).map((row) => ({ id: row.id, title: row.title, verb: row.verb, href: row.href }))
  const dialogModel: OrderRecordViewModel['dialog'] = !page || !dialog
    ? null
    : dialog.kind === 'confirmAll'
      ? { kind: 'confirmAll', model: { orders: [{ id: page.order.id, documentNumber: page.order.documentNumber, lines: page.lines, lineCount: page.lines.length }], supplierRef: dialog.supplierRef, person: frame.me.user.displayName, busy, heldReason: confirmHeld && !busy ? confirmHeld : busy ? t('held.busy') : null, problem } }
      : dialog.kind === 'decline'
        ? { kind: 'decline', model: { documentNumber: page.order.documentNumber, reasons: page.answer.declineReasons, draft: dialog.draft, busy, heldReason: declineHeld(dialog.draft, facts), problem } }
        : { kind: 'version', model: dialog.model }

  return (
    <OrderRecordView
      model={{
        state,
        page,
        tab,
        prefix: frame.prefix,
        today: dayIn(new Date()),
        highlight,
        draft,
        facts: { preview: frame.me.preview, offline },
        busy,
        problem,
        done,
        changesOpen,
        notices,
        requests: orderRequests,
        dialog: dialogModel,
      }}
      actions={{
        onAnswer: (lineId: string, answer: LineDraft | null) =>
          setDraft((current) => {
            const answers = { ...current.answers }
            if (answer && answer.kind !== 'AS_ASKED') answers[lineId] = answer
            else delete answers[lineId]
            return { ...current, answers }
          }),
        onAllAsAsked: () => setDraft((current) => ({ ...current, answers: {} })),
        onField: (field, value) => setDraft((current) => ({ ...current, [field]: value })),
        onSend: send,
        onDecline: () => setDialog({ kind: 'decline', draft: DECLINE }),
        onRetry: () => {
          setState('loading')
          void load()
        },
        onRetryNotices: () => {
          setNotices({ state: 'loading', items: [] })
          void loadNotices()
        },
        onChangesToggle: setChangesOpen,
        onTab: (next: RecordTab) => router.push(recordHref(frame.prefix, id, next)),
        dialog: {
          onRef: (value) => setDialog((current) => (current?.kind === 'confirmAll' ? { ...current, supplierRef: value } : current)),
          onConfirm: () => (dialog?.kind === 'confirmAll' ? confirmAll(dialog.supplierRef) : undefined),
          onDeclineDraft: (reason: PortalDeclineReason, note: string) => setDialog((current) => (current?.kind === 'decline' ? { kind: 'decline', draft: { ...current.draft, reason, note } } : current)),
          onDeclineSend: declineSend,
          onVersionRetry: () => (dialog?.kind === 'version' ? openVersion(dialog.model.revision) : undefined),
          onClose: () => (busy ? undefined : (setDialog(null), setProblem(null))),
        },
      }}
    >
      {tab === 'messages' && page ? <PortalThread type="PurchaseOrder" id={page.order.id} showRecord={false} /> : null}
    </OrderRecordView>
  )
}
