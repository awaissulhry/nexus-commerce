'use client'

import { createElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { formatTime } from '../../../lib/i18n/format'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { companyPrefix } from '../../../lib/session/session'
import { setThreadStatus } from '../../../record-panels/api'
import { readThreadPage } from '../../_shared/record-thread/api'
import { useLiveBus } from '../../../shell/live/use-live'
import {
  askInfo,
  assignInquiry,
  declineInquiry,
  fileAddress,
  findStyles,
  listAssignees,
  listContacts,
  listCustomers,
  loseInquiry,
  messageCustomer,
  quoteInquiry,
  // B-TH-228
  listScales,
  orderInquiry,
  styleDraftInquiry,
  readInquiry,
  readStyle,
  resumeInquiry,
  updateInquiry,
  type ContactOption,
  type InquiryView,
  type PartyOption,
  type StyleOption,
} from './api'
import {
  emptyDecline,
  fieldLines,
  // B-TH-228
  orderBodyOf,
  orderDonePhrase,
  orderDraftOf,
  styleDraftBodyOf,
  styleDraftOf,
  inquiriesCan,
  leftOutPhrases,
  messageReach,
  quotePreview,
  readProblem,
  requestChanges,
  requestDraftOf,
  toggleTechPack,
  writeProblem,
  type Loaded,
  type Notice,
  type RecordTab,
  type RequestDraft,
} from './model'
import type { InquiryRecordActions, InquiryRecordModel, RecordDialog, RecordVerb } from './record-model'
import type { StyleRead } from './view/LinesEditor'
// B-TH-217 / B-TH-218: the request's thread (RecordThread v1) with Ask for info.
import { RequestThread, type AskInfo, type AskSend } from './pane/RequestThread'

export interface UseInquiryOptions {
  /** The inquiry to show; null: none open (the hook then reads nothing). */
  readonly inquiryId: string | null
  readonly tab: RecordTab
  readonly onTab: (tab: RecordTab) => void
  /** A decision closed it (quoted, declined, lost): the list moves to the next inquiry. */
  readonly onDecided?: (inquiryId: string) => void
  /** Anything changed it (a save, a verb): the list reads again. */
  readonly onChanged?: () => void
  /** A row's verb to open once the inquiry is read (the list's ⋯ and keys); told back when done. */
  readonly pendingVerb?: RecordVerb | null
  readonly onPendingDone?: () => void
}

const LIVE = 'inquiry.'

/**
 * ONE container for an inquiry (B-W2b-322): the DetailModal on the list and the full page in a new tab share it. It reads
 * the record, keeps the Request draft (and the tech pack) until Apply (one PATCH at the version read), reads the pickers it
 * needs (customers for a prospect's match, the customer's contacts, the styles and each picked style's sizes and
 * colourways), runs the verbs (Make quote, Assign, Ask for more information, The customer answered, Take it off, Decline
 * with its optional message through the thread, Mark as lost), each one command at the version read with one
 * Idempotency-Key per attempt, and follows live `inquiry.*` changes (read again; while a draft is open: "changed since").
 */
export interface InquiryRecordExtras {
  /** The request's thread (RecordThread v1), for the pane's and the full page's main column. */
  readonly thread: ReactNode
  /** B-TH-217 (pane-head-F03): someone else changed the request while it was open — when (the pane says so, with Next). */
  readonly handled: string | null
  /** "Close thread…" (threads.manage): the confirm is open, and its refusal. */
  readonly closing: { readonly problem: string | null } | null
  readonly onCloseThread: () => void
  readonly onConfirmClose: () => void
  readonly onCancelClose: () => void
}

export function useInquiry(options: UseInquiryOptions): { model: InquiryRecordModel; actions: InquiryRecordActions; asOf: string | null } & InquiryRecordExtras {
  const { inquiryId, tab, onTab, onDecided, onChanged, pendingVerb, onPendingDone } = options
  const api = useOfficeApi()
  const session = useOfficeSession()
  const locale = useLocale()
  const prefix = companyPrefix(session.company?.code ?? '')
  const me = session.user.id
  const can = useMemo(() => inquiriesCan(session.permissions), [session.permissions])

  const [loaded, setLoaded] = useState<Loaded<InquiryView>>({ status: 'loading' })
  const [asOf, setAsOf] = useState<string | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [stale, setStale] = useState<string | null>(null)
  const [draft, setDraft] = useState<RequestDraft | null>(null)
  const [saving, setSaving] = useState(false)
  const [dialog, setDialog] = useState<RecordDialog | null>(null)
  const [pictures, setPictures] = useState(false)
  // B-TH-217: a live change this page did not make (another person handled the request meanwhile).
  const [handled, setHandled] = useState<string | null>(null)
  const ownWrite = useRef(0)
  const view = loaded.status === 'ready' ? loaded.value : null
  const viewRef = useRef<InquiryView | null>(null)
  viewRef.current = view
  const draftRef = useRef<RequestDraft | null>(null)
  draftRef.current = draft
  const keyRef = useRef<string | null>(null)
  const readId = useRef(0)
  const told = useRef({ onDecided, onChanged, onPendingDone })
  told.current = { onDecided, onChanged, onPendingDone }

  const load = useCallback(
    async (quiet = false) => {
      if (!can.view || !inquiryId) return
      const id = ++readId.current
      if (!quiet) setLoaded({ status: 'loading' })
      try {
        const value = await readInquiry(api, inquiryId)
        if (id !== readId.current) return
        setLoaded({ status: 'ready', value })
        setAsOf(new Date().toISOString())
        setStale(null)
      } catch (error) {
        if (id !== readId.current) return
        const kind = isApiError(error) ? error.kind : null
        setLoaded(kind === 'not_found' ? { status: 'notFound' } : kind === 'forbidden' ? { status: 'forbidden' } : { status: 'error', problem: readProblem(error) })
      }
    },
    [api, can.view, inquiryId],
  )

  useEffect(() => {
    setDraft(null)
    setDialog(null)
    setNotice(null)
    setPictures(false)
    setStale(null)
    setHandled(null)
    setAsk(null)
    keyRef.current = null
    void load()
  }, [load])

  const live = useLiveBus(
    {
      onChange: (change) => {
        if (!change.type.startsWith(LIVE) || !inquiryId || change.fields.inquiryId !== inquiryId) return
        const someoneElse = Date.now() - ownWrite.current > 4000
        if (someoneElse) setHandled(formatTime(new Date().toISOString(), { locale }))
        if (draftRef.current || saving || busy || dialog?.busy) setStale(formatTime(new Date().toISOString(), { locale }))
        else void load(true)
      },
      onReconnect: () => {
        if (!draftRef.current) void load(true)
      },
    },
    can.view && !!inquiryId,
  )

  // ---- the pickers: customers (a prospect's match), contacts, styles and their sizes -------------------------------------------
  const editable = !!view && can.manage && view.actions.edit.allowed
  const [customers, setCustomers] = useState<{ items: PartyOption[] | null; problem: string | null } | null>(null)
  const needCustomers = editable && !!view?.prospect && can.parties
  useEffect(() => {
    if (!needCustomers) return setCustomers(null)
    const controller = new AbortController()
    setCustomers({ items: null, problem: null })
    listCustomers(api, session.company?.id ?? null, controller.signal)
      .then((items) => setCustomers({ items, problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setCustomers({ items: null, problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, needCustomers, session.company?.id])

  const contactParty = view?.party?.id ?? draft?.matchPartyId ?? null
  const [contacts, setContacts] = useState<{ items: ContactOption[] | null; problem: string | null } | null>(null)
  useEffect(() => {
    if (!contactParty || !can.parties || !can.manage) return setContacts(null)
    const controller = new AbortController()
    setContacts({ items: null, problem: null })
    listContacts(api, contactParty, controller.signal)
      .then((items) => setContacts({ items, problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setContacts({ items: null, problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, contactParty, can.parties, can.manage])

  const [styles, setStyles] = useState<{ items: StyleOption[] | null; problem: string | null } | null>(null)
  useEffect(() => {
    if (!editable || !can.styles) return setStyles(null)
    const controller = new AbortController()
    setStyles({ items: null, problem: null })
    findStyles(api, '', controller.signal)
      .then((items) => setStyles({ items, problem: null }))
      .catch((error: unknown) => !controller.signal.aborted && setStyles({ items: [], problem: readProblem(error) }))
    return () => controller.abort()
  }, [api, editable, can.styles])

  const [details, setDetails] = useState<Record<string, StyleRead>>({})
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
  const styleIds = view && editable ? [...new Set(view.lines.map((line) => line.style?.id).filter((id): id is string => !!id))].join(',') : ''
  useEffect(() => {
    for (const styleId of styleIds.split(',').filter(Boolean)) readDetail(styleId)
  }, [styleIds, readDetail])

  // ---- the Request's Apply --------------------------------------------------------------------------------------------------
  const refused = useCallback((error: unknown, number?: string) => {
    const problem = writeProblem(error, number)
    setNotice({ key: problem.key, params: problem.params, tone: 'danger', lines: fieldLines(problem.paths) })
    return problem
  }, [])

  const save = useCallback(async () => {
    const now = viewRef.current
    const typed = draftRef.current
    if (!now || !typed || saving) return
    const changes = requestChanges(now, typed, can)
    if (!changes.body || changes.problem) return
    setSaving(true)
    ownWrite.current = Date.now()
    keyRef.current ??= newIdempotencyKey()
    try {
      const value = await updateInquiry(api, now.id, changes.body, keyRef.current)
      keyRef.current = null
      setLoaded({ status: 'ready', value })
      setDraft(null)
      setAsOf(new Date().toISOString())
      setStale(null)
      setNotice({ key: 'request.saved', params: { number: value.number }, tone: 'success' })
      told.current.onChanged?.()
    } catch (error) {
      const problem = refused(error, now.number)
      if (!problem.stale) keyRef.current = null
      else {
        keyRef.current = null
        setStale(formatTime(new Date().toISOString(), { locale }))
      }
    } finally {
      setSaving(false)
    }
  }, [api, can, saving, refused, locale])

  // ---- the verbs --------------------------------------------------------------------------------------------------------------
  const verbKey = useRef<string | null>(null)
  const after = useCallback((value: InquiryView, done: Notice, decided: boolean) => {
    verbKey.current = null
    ownWrite.current = Date.now()
    setLoaded({ status: 'ready', value })
    setAsOf(new Date().toISOString())
    setDialog(null)
    setStale(null)
    setNotice(done)
    told.current.onChanged?.()
    if (decided) told.current.onDecided?.(value.id)
  }, [])

  const readPeople = useCallback(
    (now: InquiryView) => {
      setDialog({ kind: 'assign', people: { status: 'loading' }, busy: false, notice: null })
      listAssignees(api, now.companyId, now.party?.id ?? null)
        .then((value) => setDialog((open) => (open?.kind === 'assign' ? { ...open, people: { status: 'ready', value } } : open)))
        .catch((error: unknown) => setDialog((open) => (open?.kind === 'assign' ? { ...open, people: { status: 'error', problem: readProblem(error) } } : open)))
    },
    [api],
  )

  const runSimple = useCallback(
    async (verb: 'resume' | 'unassign') => {
      const now = viewRef.current
      if (!now || busy) return
      setBusy(true)
      ownWrite.current = Date.now()
      verbKey.current ??= newIdempotencyKey()
      try {
        const value = verb === 'resume' ? await resumeInquiry(api, now.id, now.version, verbKey.current) : await assignInquiry(api, now.id, { version: now.version, assigneeId: null }, verbKey.current)
        after(value, { key: `done.${verb}`, params: { number: value.number }, tone: 'success' }, false)
      } catch (error) {
        verbKey.current = null
        const problem = refused(error, now.number)
        if (problem.stale) void load(true)
      } finally {
        setBusy(false)
      }
    },
    [api, busy, after, refused, load],
  )

  // ---- B-TH-218: Ask for info — the thread's box becomes the reply with the question; the send is the request's own ask-info ----
  const [ask, setAsk] = useState<AskInfo | null>(null)
  const askKey = useRef<string | null>(null)
  const sendAsk = useCallback(
    async (send: AskSend): Promise<boolean> => {
      const now = viewRef.current
      if (!now) return false
      ownWrite.current = Date.now()
      askKey.current ??= newIdempotencyKey()
      try {
        const portal = now.source === 'PORTAL'
        const message = { body: send.body, ...(send.subject.trim() ? { subject: send.subject.trim() } : {}), ...(!portal && send.to.length > 0 ? { to: [...send.to] } : {}), ...(send.sendOutside ? { sendOutside: true } : {}) }
        const value = await askInfo(api, now.id, now.version, askKey.current, message)
        askKey.current = null
        setAsk(null)
        after(value, { key: portal ? 'done.askInfoPortal' : 'done.askInfoMail', params: { number: value.number, customer: value.party?.name ?? value.fromWords }, tone: 'success' }, false)
        return true
      } catch (error) {
        const problem = refused(error, now.number)
        if (!problem.stale) askKey.current = null
        else {
          askKey.current = null
          void load(true)
        }
        return false
      }
    },
    [api, after, refused, load],
  )

  const onVerb = useCallback(
    (verb: RecordVerb) => {
      const now = viewRef.current
      if (!now) return
      verbKey.current = null
      setNotice(null)
      if (verb === 'assign') readPeople(now)
      else if (verb === 'decline') setDialog({ kind: 'decline', draft: emptyDecline, busy: false, notice: null })
      else if (verb === 'lost') setDialog({ kind: 'lost', note: '', busy: false, notice: null })
      else if (verb === 'quote') setDialog({ kind: 'quote', customerRef: '', busy: false, notice: null })
      // ---- B-TH-228: Make order (the request's lines, prices, date and PO), Make style draft (the scales of the request's company)
      else if (verb === 'order') setDialog({ kind: 'order', draft: orderDraftOf(now, can), busy: false, notice: null })
      else if (verb === 'styleDraft') {
        setDialog({ kind: 'styleDraft', draft: styleDraftOf(now), scales: { status: 'loading' }, busy: false, notice: null })
        listScales(api, now.companyId)
          .then((value) => setDialog((open) => (open?.kind === 'styleDraft' ? { ...open, scales: { status: 'ready', value } } : open)))
          .catch((error: unknown) => setDialog((open) => (open?.kind === 'styleDraft' ? { ...open, scales: { status: 'error', problem: readProblem(error) } } : open)))
      }
      // ---- end B-TH-228
      else if (verb === 'askInfo') {
        // B-TH-218: the box switches to the reply with the question; the pane says where it goes.
        setAsk({ token: Date.now(), question: '', portal: now.source === 'PORTAL' })
        setNotice({ key: now.source === 'PORTAL' ? 'pane.ask.portal' : 'pane.ask.mail', params: { customer: now.party?.name ?? now.fromWords }, tone: 'info' })
      }
      else void runSimple(verb)
    },
    [readPeople, runSimple, can, api],
  )

  // A row's verb from the list, once the inquiry is read.
  useEffect(() => {
    if (!pendingVerb || !view || view.id !== inquiryId) return
    onVerb(pendingVerb)
    told.current.onPendingDone?.()
  }, [pendingVerb, view, inquiryId, onVerb])

  const assign = useCallback(
    async (assigneeId: string | null) => {
      const now = viewRef.current
      if (!now || dialog?.kind !== 'assign' || dialog.busy) return
      const people = dialog.people.status === 'ready' ? dialog.people.value.people : []
      setDialog({ ...dialog, busy: true, notice: null })
      ownWrite.current = Date.now()
      verbKey.current ??= newIdempotencyKey()
      try {
        const value = await assignInquiry(api, now.id, { version: now.version, assigneeId }, verbKey.current)
        const person = people.find((one) => one.id === assigneeId)
        after(value, assigneeId === null ? { key: 'done.unassign', params: { number: value.number }, tone: 'success' } : { key: person?.me ? 'done.assignMe' : 'done.assign', params: { number: value.number, name: person?.name ?? '' }, tone: 'success' }, false)
      } catch (error) {
        verbKey.current = null
        const problem = writeProblem(error, now.number)
        setDialog((open) => (open?.kind === 'assign' ? { ...open, busy: false, notice: { key: problem.key, params: problem.params, tone: 'danger', lines: fieldLines(problem.paths) } } : open))
        if (problem.stale) void load(true)
      }
    },
    [api, dialog, after, load],
  )

  const submitDialog = useCallback(async () => {
    const now = viewRef.current
    if (!now || !dialog || dialog.busy || dialog.kind === 'assign') return
    setDialog({ ...dialog, busy: true, notice: null })
    ownWrite.current = Date.now()
    verbKey.current ??= newIdempotencyKey()
    try {
      if (dialog.kind === 'decline') {
        if (!dialog.draft.reason) return
        const note = dialog.draft.note.trim()
        const value = await declineInquiry(api, now.id, { version: now.version, reason: dialog.draft.reason, ...(note ? { note } : {}) }, verbKey.current)
        const message = dialog.draft.message.trim()
        const reach = messageReach(now, can)
        let sent: 'none' | 'sent' | 'failed' = 'none'
        if (message && reach.to) {
          try {
            await messageCustomer(api, now.id, { to: reach.to, subject: `${now.number}`, body: message })
            sent = 'sent'
          } catch {
            sent = 'failed'
          }
        }
        after(value, { key: 'done.decline', params: { number: value.number, reason: `decline.${dialog.draft.reason}` }, tone: sent === 'failed' ? 'warning' : 'success', lines: sent === 'sent' ? [{ key: 'done.messageSent', params: { to: reach.to ?? '' } }] : sent === 'failed' ? [{ key: 'done.messageFailed' }] : [] }, true)
      } else if (dialog.kind === 'lost') {
        const value = await loseInquiry(api, now.id, { version: now.version, note: dialog.note.trim() }, verbKey.current)
        after(value, { key: 'done.lost', params: { number: value.number }, tone: 'success' }, true)
      } else if (dialog.kind === 'order') {
        // ---- B-TH-228: the order's own state in words (never "confirmed" while it waits), the files carried and those that were not.
        const made = await orderInquiry(api, now.id, orderBodyOf(now, dialog.draft, can), verbKey.current)
        const carried = made.files.carried.length
        after(
          made.inquiry,
          {
            ...orderDonePhrase(made, made.inquiry.number),
            tone: made.order.status === 'CONFIRMED' && made.files.notCarried.length === 0 ? 'success' : 'warning',
            link: can.ordersView ? { href: `${prefix}/sales/orders/${encodeURIComponent(made.order.id)}`, label: { key: 'done.openOrder', params: { order: made.order.number } } } : null,
            lines: [...(carried > 0 ? [{ key: 'done.filesCarried', params: { count: carried } }] : []), ...made.files.notCarried.map((file) => ({ key: 'done.fileNotCarried', params: { name: file.name, reason: file.reason } }))],
          },
          true,
        )
      } else if (dialog.kind === 'styleDraft') {
        // ---- B-TH-228: the draft opens in a new tab from the receipt; the request stays open (and in the list).
        const made = await styleDraftInquiry(api, now.id, styleDraftBodyOf(now, dialog.draft), verbKey.current)
        after(
          made.inquiry,
          {
            key: 'done.styleDraft',
            params: { style: made.style.code, number: made.inquiry.number },
            tone: made.files.notCarried.length === 0 ? 'success' : 'warning',
            link: can.styles ? { href: `${prefix}/products/styles/${encodeURIComponent(made.style.id)}`, label: { key: 'done.openStyle', params: { style: made.style.code } } } : null,
            lines: [...(made.files.carried.length > 0 ? [{ key: 'done.filesCarried', params: { count: made.files.carried.length } }] : []), ...made.files.notCarried.map((file) => ({ key: 'done.fileNotCarried', params: { name: file.name, reason: file.reason } }))],
          },
          false,
        )
        // ---- end B-TH-228
      } else {
        const ref = dialog.customerRef.trim()
        const preview = quotePreview(now)
        const made = await quoteInquiry(api, now.id, { version: now.version, ...(ref ? { customerRef: ref } : {}) }, verbKey.current)
        const leftOut = leftOutPhrases(made.leftOut, preview)
        after(
          made.inquiry,
          {
            key: made.warnings.length > 0 ? 'done.quoteWarnings' : 'done.quote',
            params: { quote: made.quote.number, number: made.inquiry.number, count: made.warnings.length },
            tone: leftOut.length > 0 || made.warnings.length > 0 ? 'warning' : 'success',
            link: can.quotesView ? { href: `${prefix}/sales/quotes/${encodeURIComponent(made.quote.id)}`, label: { key: 'done.openQuote', params: { quote: made.quote.number } } } : null,
            lines: leftOut,
          },
          true,
        )
      }
    } catch (error) {
      verbKey.current = null
      const problem = writeProblem(error, now.number)
      setDialog((open) => (open && open.kind !== 'assign' ? { ...open, busy: false, notice: { key: problem.key, params: problem.params, tone: 'danger', lines: fieldLines(problem.paths) } } : open))
      if (problem.stale) void load(true)
    }
  }, [api, dialog, after, can, prefix, load])

  const model: InquiryRecordModel = {
    prefix,
    me,
    can,
    live,
    loaded,
    tab,
    draft,
    saving,
    busy,
    customers,
    contacts,
    styles,
    details,
    stale,
    notice,
    dialog,
    pictures,
  }

  const withDraft = (change: (now: RequestDraft) => RequestDraft) =>
    setDraft((typed) => {
      const now = viewRef.current
      if (!now) return typed
      return change(typed ?? requestDraftOf(now))
    })

  const actions: InquiryRecordActions = {
    onTab,
    onDraft: (patch) => withDraft((now) => ({ ...now, ...patch })),
    onLines: (lines) => withDraft((now) => ({ ...now, lines })),
    onStyle: readDetail,
    onMatch: (partyId) => withDraft((now) => ({ ...now, matchPartyId: partyId, contactId: null })),
    onTechPack: (fileId, on) => withDraft((now) => toggleTechPack(now, fileId, on)),
    onSave: () => void save(),
    onDiscard: () => setDraft(null),
    onRetry: () => void load(),
    onReload: () => {
      setDraft(null)
      void load(true)
    },
    onPictures: () => setPictures(true),
    onVerb,
    onOpenFile: (fileId) => {
      fileAddress(api, fileId)
        .then((url) => window.open(url, '_blank', 'noopener,noreferrer'))
        .catch((error: unknown) => setNotice({ key: readProblem(error), tone: 'danger' }))
    },
    onCopy: () => {
      const now = viewRef.current
      if (!now) return
      void navigator.clipboard
        ?.writeText(now.number)
        .then(() => setNotice({ key: 'record.copied', params: { number: now.number }, tone: 'success' }))
        .catch(() => undefined)
    },
    onDismissNotice: () => setNotice(null),
    dialog: {
      onAssign: (assigneeId) => void assign(assigneeId),
      onRetryPeople: () => viewRef.current && readPeople(viewRef.current),
      onDecline: (patch) => setDialog((open) => (open?.kind === 'decline' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
      onLostNote: (note) => setDialog((open) => (open?.kind === 'lost' ? { ...open, note } : open)),
      onRef: (customerRef) => setDialog((open) => (open?.kind === 'quote' ? { ...open, customerRef } : open)),
      // B-TH-228
      onOrderDraft: (patch) => setDialog((open) => (open?.kind === 'order' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
      onStyleDraft: (patch) => setDialog((open) => (open?.kind === 'styleDraft' ? { ...open, draft: { ...open.draft, ...patch } } : open)),
      onSubmit: () => void submitDialog(),
      onClose: () => {
        verbKey.current = null
        setDialog(null)
      },
    },
  }

  const record = view ? { type: 'Inquiry', id: view.id, companyId: view.companyId, siteId: null } : null
  const title = view ? `${view.number} · ${view.party ? view.party.name : view.fromWords}` : ''
  const thread: ReactNode =
    record && view && can.thread
      ? createElement(RequestThread, {
          key: `t-${record.id}`,
          host: {
            record,
            title,
            recordLabel: view.number,
            party: view.party ? { id: view.party.id, name: view.party.name } : null,
            prospect: view.party ? null : { name: view.fromWords },
            recordHref: `${prefix}/sales/incoming/${encodeURIComponent(view.id)}`,
          },
          ask,
          onAsk: sendAsk,
        })
      : null

  // ---- B-TH-217: "Close thread…" (threads.manage; never the pane: × and Esc close it) ----
  const [closing, setClosing] = useState<{ problem: string | null } | null>(null)
  const confirmClose = async () => {
    if (!record) return
    try {
      const page = await readThreadPage(api, { type: record.type, id: record.id }, null)
      if (!page.thread) throw new Error('no thread')
      await setThreadStatus(api, { type: record.type, id: record.id }, 'CLOSED', page.thread.version)
      setClosing(null)
      setNotice({ key: 'pane.threadClosed', params: { number: view?.number ?? '' }, tone: 'success' })
    } catch (error) {
      if (isApiError(error) && error.status === 409) setClosing({ problem: 'close.conflict' })
      else {
        setClosing(null)
        setNotice({ key: readProblem(error), tone: 'danger' })
      }
    }
  }

  return {
    model,
    actions,
    asOf,
    thread,
    handled,
    closing,
    onCloseThread: () => setClosing({ problem: null }),
    onConfirmClose: () => void confirmClose(),
    onCancelClose: () => setClosing(null),
  }
}
