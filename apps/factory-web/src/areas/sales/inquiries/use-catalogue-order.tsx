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
// ---- F-CP-157: the accept's line map — the styles a line may be made into, a picked style's colourways ----
import { findStyles, readStyle } from './api'
import { intoOf, linesToMap, mapStylesOf, MAP_INTO_MAX, type MapInto } from './catalogue-model'
import type { StyleRead } from './view/LinesEditor'
// ---- end F-CP-157
import { fieldLines, inquiriesCan, readProblem, writeProblem, type Loaded, type Notice } from './model'

/** F-CP-157: the styles a line may be made into, as read for the window. */
type CatalogueDialogStyles = NonNullable<NonNullable<Extract<CatalogueDialog, { kind: 'accept' }>['styles']>['items']>

/**
 * B-TH-233 (threads plan TH-3; B-TH-040, pane-actions-F13): ONE container for a catalogue order beside the Incoming list — it reads
 * GET /sales/order-requests/:id, follows live `portal_order_request.*` changes (someone else decided it meanwhile: said, with Next),
 * runs Accept as order / Accept as quote / Refuse (one command at the version read, one Idempotency-Key per attempt), and gives the
 * catalogue order's thread (RecordThread v1 through the office container, record type PortalOrderRequest). The view draws its model.
 */

// F-CP-107 (customer page plan D10): `draft` — the customer's portal draft read on its customer page, read only (its title; Accept and
// Refuse held: "The customer is still writing it"); its changes read again quietly (no "someone else handled it": it is theirs).
export function useCatalogueOrder(options: { readonly requestId: string | null; /** Its company (from the Incoming row; the thread's files and mentions are the company's). */ readonly companyId?: string | null; readonly onDecided?: (requestId: string) => void; readonly onChanged?: () => void; readonly draft?: { readonly title: string } | null; /** F-CQ-204: a row's verb to open once it is read (Accept as order / quote, Refuse); told back when done. */ readonly pending?: 'order' | 'quote' | 'refuse' | null; readonly onPendingDone?: () => void }): { model: CatalogueModel; actions: CatalogueActions; thread: ReactNode } {
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
        // F-CP-107: a draft's own changes are the customer's writing, not someone handling it.
        if (Date.now() - ownWrite.current > 4000 && !told.current.draft) setHandled(formatTime(new Date().toISOString(), { locale }))
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
        setNotice({ ...done.phrase, tone: done.warn /* F-CP-157: logos carried are no warning */ ? 'warning' : 'success', link: href ? { href, label: { key: 'catalogue.done.open', params: { made: answer.made.number } } } : null, lines: done.lines })
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

  // ---- F-CP-157 (customer page plan C5; the API's B-CP-077): the accept window maps each described / made-to-measure line to the style
  // line(s) it is made into — the styles read once when such a window opens (product.styles.view; the open range and THIS customer's own
  // label only: never another customer's), each picked (or hinted) style's colourways and sizes read once.
  const [styles, setStyles] = useState<{ readonly items: CatalogueDialogStyles | null; readonly problem: string | null } | null>(null)
  const [details, setDetails] = useState<Readonly<Record<string, StyleRead>>>({})
  const detailsRef = useRef(details)
  detailsRef.current = details
  const readDetail = useCallback(
    (styleId: string) => {
      if (!can.styles || detailsRef.current[styleId]?.status === 'ready' || detailsRef.current[styleId]?.status === 'loading') return
      setDetails((now) => ({ ...now, [styleId]: { status: 'loading' } }))
      readStyle(api, styleId)
        .then((value) => setDetails((now) => ({ ...now, [styleId]: { status: 'ready', value } })))
        .catch(() => setDetails((now) => ({ ...now, [styleId]: { status: 'error' } })))
    },
    [api, can.styles],
  )
  const mapping = dialog?.kind === 'accept' && !!record && linesToMap(record).length > 0
  const partyId = record?.request.party.id ?? null
  useEffect(() => {
    if (!mapping || !partyId) return
    if (!can.styles) return setStyles(null)
    const controller = new AbortController()
    setStyles({ items: null, problem: null })
    findStyles(api, '', controller.signal)
      .then((items) => setStyles({ items: mapStylesOf(items, partyId), problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setStyles({ items: [], problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, mapping, partyId, can.styles])
  // The styles the window already names (the lines' own hints, the picks) have their colourways read.
  const named = dialog?.kind === 'accept' ? [...new Set(Object.values(dialog.draft.map ?? {}).flatMap((into) => into.map((one) => one.styleId).filter((id): id is string => !!id)))].join(',') : ''
  useEffect(() => {
    for (const styleId of named.split(',').filter(Boolean)) readDetail(styleId)
  }, [named, readDetail])
  const changeMap = (lineId: string, change: (into: readonly MapInto[]) => readonly MapInto[]) =>
    setDialog((open) => (open?.kind === 'accept' ? { ...open, draft: { ...open.draft, map: { ...(open.draft.map ?? {}), [lineId]: change(open.draft.map?.[lineId] ?? []) } } } : open))
  const shownDialog: CatalogueDialog | null = dialog?.kind === 'accept' && mapping ? { ...dialog, styles: can.styles ? styles : null, details } : dialog
  // ---- end F-CP-157
  const model: CatalogueModel = { prefix, can, offline, loaded, notice, dialog: shownDialog /* F-CP-157 */, handled, draft: options.draft ?? null /* F-CP-107 */ }
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
    // ---- F-CP-157: the line map (a change keeps the other lines; a new style line up to 20; a style picked: its colourways read)
    onMapInto: (lineId, key, patch) => changeMap(lineId, (into) => into.map((one) => (one.key === key ? { ...one, ...patch, ...(patch.styleId !== undefined && patch.styleId !== one.styleId ? { colourwayId: null } : {}) } : one))),
    onMapAdd: (lineId) => changeMap(lineId, (into) => (into.length >= MAP_INTO_MAX ? into : [...into, intoOf(null)])),
    onMapRemove: (lineId, key) => changeMap(lineId, (into) => (into.length <= 1 ? [intoOf(null)] : into.filter((one) => one.key !== key))),
    onMapStyle: readDetail,
    // ---- end F-CP-157
    onSubmit: () => void submit(),
    onCloseDialog: () => {
      keyRef.current = null
      setDialog(null)
    },
    onDismissNotice: () => setNotice(null),
  }

  // ---- F-CQ-204: a row's verb, once the portal order is read (the useInquiry pattern): its own window opens, then it is told back.
  const pending = options.pending ?? null
  useEffect(() => {
    if (!pending || !record || record.request.id !== requestId) return
    if (pending === 'refuse') actions.onRefuse?.()
    else actions.onAccept?.(pending === 'order' ? 'ORDER' : 'QUOTE')
    told.current.onPendingDone?.()
    // `actions` is rebuilt each render; the record and the verb decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, record, requestId])
  // ---- end F-CQ-204

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
