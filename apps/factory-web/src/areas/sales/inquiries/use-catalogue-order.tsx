'use client'

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { useLiveBus } from '../../../shell/live/use-live'
import { OfficeRecordThread } from '../../_shared/record-thread/OfficeRecordThread'
import { acceptCatalogueOrder, readCatalogueOrder, refuseCatalogueOrder, type CatalogueRecord } from './api'
import { acceptBodyOf, acceptDone, acceptDraftOf, type CatalogueActions, type CatalogueDialog, type CatalogueModel } from './catalogue-model'
import { fieldLines, inquiriesCan, readProblem, writeProblem, type Loaded, type Notice } from './model'

/**
 * B-TH-233 (threads plan TH-3; B-TH-040, pane-actions-F13): ONE container for a catalogue order beside the Incoming list — it reads
 * GET /sales/order-requests/:id, follows live `portal_order_request.*` changes (someone else decided it meanwhile: said, with Next),
 * runs Accept as order / Accept as quote / Refuse (one command at the version read, one Idempotency-Key per attempt), and gives the
 * catalogue order's thread (RecordThread v1 through the office container, record type PortalOrderRequest). The view draws its model.
 */

export function useCatalogueOrder(options: { readonly requestId: string | null; /** Its company (from the Incoming row; the thread's files and mentions are the company's). */ readonly companyId?: string | null; readonly onDecided?: (requestId: string) => void; readonly onChanged?: () => void }): { model: CatalogueModel; actions: CatalogueActions; thread: ReactNode } {
  const { requestId } = options
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])
  const mayRead = !!can.ordersView
  const [loaded, setLoaded] = useState<Loaded<CatalogueRecord>>({ status: 'loading' })
  const [notice, setNotice] = useState<Notice | null>(null)
  const [dialog, setDialog] = useState<CatalogueDialog | null>(null)
  const [handled, setHandled] = useState<string | null>(null)
  const readId = useRef(0)
  const keyRef = useRef<string | null>(null)
  const ownWrite = useRef(0)
  const told = useRef(options)
  told.current = options
  const record = loaded.status === 'ready' ? loaded.value : null
  const recordRef = useRef<CatalogueRecord | null>(null)
  recordRef.current = record

  const load = useCallback(
    async (quiet = false) => {
      if (!requestId || !mayRead) return
      const id = ++readId.current
      if (!quiet) setLoaded({ status: 'loading' })
      try {
        const value = await readCatalogueOrder(api, requestId)
        if (id === readId.current) setLoaded({ status: 'ready', value })
      } catch (error) {
        if (id !== readId.current) return
        // A catalogue order of another customer, or one this reader may not see, is "not found" (never "it exists").
        const kind = isApiError(error) ? error.kind : null
        setLoaded(kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
      }
    },
    [api, requestId, mayRead],
  )

  useEffect(() => {
    setDialog(null)
    setNotice(null)
    setHandled(null)
    keyRef.current = null
    if (!mayRead) setLoaded({ status: 'forbidden' })
    else void load()
  }, [load, mayRead])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!change.type.startsWith('portal_order_request.') || !requestId || change.fields.requestId !== requestId) return
        if (Date.now() - ownWrite.current > 4000) setHandled(formatTime(new Date().toISOString(), { locale }))
        void load(true)
      },
      onReconnect: () => void load(true),
    },
    mayRead && !!requestId,
  )
  const offline = live === 'offline'

  const refused = (error: unknown, number: string) => {
    keyRef.current = null
    const problem = writeProblem(error, number)
    setDialog((open) => (open ? { ...open, busy: false, notice: { key: problem.key, params: problem.params, tone: 'danger', lines: fieldLines(problem.paths) } } : open))
    if (problem.stale) void load(true)
  }

  const submit = async () => {
    const now = recordRef.current
    if (!now || !dialog || dialog.busy) return
    const number = now.request.number ?? ''
    setDialog({ ...dialog, busy: true, notice: null })
    ownWrite.current = Date.now()
    keyRef.current ??= newIdempotencyKey()
    try {
      if (dialog.kind === 'accept') {
        const answer = await acceptCatalogueOrder(api, now.request.id, acceptBodyOf(now, dialog.draft, can), keyRef.current)
        const done = acceptDone(answer.made, number)
        const href = answer.made.as === 'ORDER' && answer.made.salesOrderId && can.ordersView ? `${prefix}/sales/orders/${encodeURIComponent(answer.made.salesOrderId)}` : answer.made.as === 'QUOTE' && answer.made.quoteId && can.quotesView ? `${prefix}/sales/quotes/${encodeURIComponent(answer.made.quoteId)}` : null
        setLoaded({ status: 'ready', value: { request: answer.request, may: answer.may } })
        setNotice({ ...done.phrase, tone: done.lines.length > 0 ? 'warning' : 'success', link: href ? { href, label: { key: 'catalogue.done.open', params: { made: answer.made.number } } } : null, lines: done.lines })
      } else {
        const value = await refuseCatalogueOrder(api, now.request.id, { version: now.request.version, reason: dialog.reason.trim() }, keyRef.current)
        setLoaded({ status: 'ready', value })
        setNotice({ key: 'catalogue.done.refused', params: { number }, tone: 'success' })
      }
      keyRef.current = null
      setDialog(null)
      told.current.onChanged?.()
      told.current.onDecided?.(now.request.id)
    } catch (error) {
      refused(error, number)
    }
  }

  const model: CatalogueModel = { prefix, can, offline, loaded, notice, dialog, handled }
  const actions: CatalogueActions = {
    onRetry: () => void load(),
    onReload: () => {
      setHandled(null)
      void load(true)
    },
    onAccept: (as) => {
      const now = recordRef.current
      if (!now) return
      keyRef.current = null
      setNotice(null)
      setDialog({ kind: 'accept', draft: acceptDraftOf(now, as, can), busy: false, notice: null })
    },
    onRefuse: () => {
      keyRef.current = null
      setNotice(null)
      setDialog({ kind: 'refuse', reason: '', busy: false, notice: null })
    },
    onDraft: (patch) => setDialog((open) => (open?.kind === 'accept' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
    onPrice: (lineId, price) => setDialog((open) => (open?.kind === 'accept' ? { ...open, draft: { ...open.draft, prices: { ...open.draft.prices, [lineId]: price } } } : open)),
    onReason: (reason) => setDialog((open) => (open?.kind === 'refuse' ? { ...open, reason } : open)),
    onSubmit: () => void submit(),
    onCloseDialog: () => {
      keyRef.current = null
      setDialog(null)
    },
    onDismissNotice: () => setNotice(null),
  }

  // The catalogue order's thread: shared with its customer only (B-TH-040's resolver: company + customer, once SENT).
  const thread: ReactNode =
    record && can.thread
      ? createElement(OfficeRecordThread, {
          key: `c-${record.request.id}`,
          record: { type: 'PortalOrderRequest', id: record.request.id, companyId: options.companyId ?? null, siteId: null },
          partyRole: 'customer',
          title: `${record.request.number ?? ''} · ${record.request.party.name}`,
          recordLabel: record.request.number ?? '',
          party: { id: record.request.party.id, name: record.request.party.name },
          recordHref: `${prefix}/sales/incoming?catalogue=${encodeURIComponent(record.request.id)}`,
        })
      : null

  return { model, actions, thread }
}
