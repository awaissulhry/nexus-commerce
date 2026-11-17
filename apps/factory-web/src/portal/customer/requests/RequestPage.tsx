'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PartnerMessage } from '@nexus/ui/patterns/PartnerThread/index'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive } from '../../shell/frame'
import { PortalThread } from '../../shell/thread/PortalThread'
import { useOffline } from '../orders/hooks'
import { NotInAccess } from '../orders/view/parts'
import { fetchRequest, type RequestView } from './api'
import { NS, questionOf, stateLinks, stateTone, yourNumberText, type ThreadLine } from './model'
// ---- B-TH-282 (files) and B-TH-291 (withdraw)
import { newIdempotencyKey } from '../../../lib/api/client'
import { issuePath } from '../../../lib/api/errors'
import { useT } from '../../../lib/i18n/provider'
import { COMPOSE_NS } from '../../../lib/request-compose/model'
import { fetchRequestsOpen, withdrawRequest } from './api'
import { filesDoorOf, withdrawProblemKey } from './model'
import { useRequestFiles } from './use-request-files'
import { RequestRecordView } from './view/RequestView'
import { useRequestWords } from './words'

/**
 * `/p/<party>/orders/requests/<id>` — the customer's request (B-TH-222, B-TH-303; threads plan X-P-CUS-REQ): GET
 * /portal/inquiries/:id (another customer's id answers 404: the neutral "not one of yours" page, W37), the band ("Your request
 * 7", back to Orders & requests, their PO, the true state), the state line, and the request's thread through the portal's
 * PortalThread on the DS PartnerThread (two sides, no office-note kind by type, PR-15; read and posted only through the
 * partner thread routes, W08). It reads again on the live channel's request events (ours only: the channel names the party)
 * and when the connection comes back; Answer puts the cursor in the message box.
 */
export function CustomerRequestRecordPage({ id }: { id: string }) {
  return (
    <WithMessages namespaces={[NS, 'portal-orders', 'ds-words', COMPOSE_NS]}>
      <RequestContainer id={id} />
    </WithMessages>
  )
}

function RequestContainer({ id }: { id: string }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const words = useRequestWords()
  const { t, locale, time } = words
  const offline = useOffline()
  const allowed = frame.kinds.includes('CUSTOMER') && frame.me.permissions.includes('portal.salesOrders.view')
  const [request, setRequest] = useState<RequestView | null>(null)
  const [state, setState] = useState<'loading' | 'error' | 'missing' | 'ready'>('loading')
  const [loadedAt, setLoadedAt] = useState<string | null>(null)
  const [messages, setMessages] = useState<ThreadLine[]>([])
  const box = useRef<HTMLDivElement>(null)
  const backHref = `${frame.prefix}/orders`
  // ---- B-TH-282: the files' gate (the API's words while uploads from outside are closed) and the files being sent.
  const tc = useT(COMPOSE_NS)
  const mayOrder = frame.me.permissions.includes('portal.orderRequests.manage')
  const [gate, setGate] = useState<{ open: boolean; words: string | null } | null>(null)
  const fileWords = useMemo(() => ({ network: tc('files.failed.network'), store: tc('files.failed.store'), refused: tc('files.failed.refused') }), [tc])
  const files = useRequestFiles(api, fileWords)
  useEffect(() => {
    if (!allowed || !mayOrder) return
    const abort = new AbortController()
    fetchRequestsOpen(api, abort.signal)
      .then((answer) => setGate(answer.files ?? { open: false, words: null }))
      .catch(() => setGate(null))
    return () => abort.abort()
  }, [api, allowed, mayOrder])
  // ---- B-TH-291: Withdraw's question (one key per question: a retry after a lost answer withdraws once).
  const [withdrawing, setWithdrawing] = useState<{ busy: boolean; problem: string | null } | null>(null)
  const withdrawKey = useRef<string | null>(null)
  // ---- end B-TH-282 / B-TH-291

  const load = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await fetchRequest(api, id, signal)
        setRequest(next)
        setLoadedAt(new Date().toISOString())
        setState('ready')
      } catch (error) {
        if ((error as { name?: string } | null)?.name === 'AbortError') return
        // Another customer's request, one that no longer exists, or an address that names none: the same neutral words.
        setState(isApiError(error) && (error.kind === 'not_found' || error.kind === 'invalid') ? 'missing' : 'error')
      }
    },
    [api, id],
  )
  useEffect(() => {
    if (!allowed) return
    const abort = new AbortController()
    void load(abort.signal)
    return () => abort.abort()
  }, [allowed, load])

  // Our answer, a quote sent, the resume after their reply: the request's events of this party only (the live channel's rule).
  usePortalLive({
    onChange: (change) => {
      if (change.type.startsWith('inquiry.') || change.type === 'partner_notification.created') void load()
    },
    onReconnect: () => void load(),
  }, allowed)

  const onMessages = useCallback((read: readonly PartnerMessage[]) => {
    setMessages(read.map((message) => ({ id: message.id, side: message.side, body: message.body, at: message.at })))
  }, [])

  const yours = request ? yourNumberText(request.yourNumber, locale) : null
  usePortalBand(
    !allowed
      ? { title: t('titleNone') }
      : {
          title: state === 'missing' ? t('missing.title') : request?.yourNumber ? t('title', { seq: request.yourNumber.seq }) : t('titleNone'),
          back: { href: backHref, label: t('back') },
          refs: request?.customerRef ? { theirs: request.customerRef, ours: null } : null,
          status: request ? { label: request.state.words[locale], tone: stateTone(request.state.code) } : null,
          ask: state === 'missing' ? null : { type: 'Inquiry', id, label: yours },
        },
  )

  if (!allowed) return <NotInAccess admins={(frame.access?.admins ?? []).map((admin) => admin.displayName)} homeHref={frame.prefix} />

  const question = request ? questionOf(request.state.code, messages) : null

  // ---- B-TH-291: withdraw at the version read; refused in the API's words (another customer's request is not found: W37).
  const withdraw = async () => {
    if (!request || request.version === undefined || withdrawing?.busy) return
    withdrawKey.current ??= newIdempotencyKey()
    setWithdrawing({ busy: true, problem: null })
    try {
      const next = await withdrawRequest(api, id, request.version, withdrawKey.current)
      withdrawKey.current = null
      setRequest(next)
      setWithdrawing(null)
      frame.refreshTasks()
    } catch (error) {
      const refusal = isApiError(error) ? error.issues.find((issue) => issuePath(issue).replace(/\./g, '/').startsWith('refusal/')) : undefined
      if (isApiError(error) && error.kind !== 'unavailable') withdrawKey.current = null
      setWithdrawing({ busy: false, problem: refusal?.message ?? t(withdrawProblemKey(isApiError(error) ? error.kind : null)) })
      if (isApiError(error) && (error.kind === 'conflict' || error.kind === 'not_found')) void load()
    }
  }
  const door = request ? filesDoorOf(request.state.code) : 'request'
  // ---- end B-TH-291
  return (
    <div ref={box}>
      <RequestRecordView
        model={{
          state,
          request,
          links: request ? stateLinks(request, frame.prefix, locale, t) : { order: null, quote: null },
          question: question ? { body: question.body, at: question.at } : null,
          offlineSince: offline && loadedAt ? time(loadedAt) : null,
          backHref,
          // B-TH-282: "Add files" for who sends requests; the API's sentence while uploads from outside are closed.
          files: request && mayOrder && gate ? { open: gate.open, closedWords: gate.words, held: files.held, leftOut: files.leftOut, when: 'send', readOnly: frame.me.preview || offline, heldReason: frame.me.preview ? tc('held.preview') : offline ? t('files.offline') : null } : null,
          // B-TH-291
          withdraw: request?.withdraw ?? null,
          withdrawing,
        }}
        actions={{
          onAnswer: () => {
            const area = box.current?.querySelector<HTMLTextAreaElement>('.fw-preq-main textarea')
            area?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            area?.focus()
          },
          onRetry: () => {
            setState('loading')
            void load()
          },
          // ---- B-TH-282
          files: {
            onDrop: files.add,
            onSheet: files.sheet,
            onRemove: files.remove,
            onRetry: () => void files.send(id, door),
            onSend: () => void files.send(id, door),
          },
          // ---- B-TH-291
          onWithdraw: () => setWithdrawing({ busy: false, problem: null }),
          onWithdrawConfirm: () => void withdraw(),
          onWithdrawCancel: () => {
            withdrawKey.current = null
            setWithdrawing(null)
          },
        }}
        thread={state === 'missing' ? null : <PortalThread type="Inquiry" id={id} title={t('thread.title')} showRecord={false} onMissing={() => setState('missing')} onMessages={onMessages} />}
      />
    </div>
  )
}
