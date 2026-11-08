'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { WithMessages } from '../../../record-panels/i18n'
import { usePortalApi, usePortalBand, usePortalFrame, usePortalLive, usePortalUnsaved } from '../../shell/frame'
import { NotInAccessHere, useOffline } from '../orders/parts'
import { cancelNotice, createNotice, fetchNotice, fetchShippable, fileContent, readSheet, sendNotice, setPackingList, updateNotice, type NoticePage, type ShippableRead } from './api'
import { newBandOf, noticeBandOf } from './band'
import {
  cancelHeld,
  hasLeather,
  issueKeysOf,
  linesBody,
  linesChanged,
  linesDraftOf,
  linesHeld,
  listHref,
  noticeHref,
  NS,
  problemOf,
  sendHeld,
  shipLinesOf,
  STEPS,
  stepOf,
  termsBody,
  termsChanged,
  termsDraftOf,
  termsHeld,
  writeHeld,
  type LinesDraft,
  type Problem,
  type Step,
  type TermsDraft,
} from './model'
import { AnnounceView, type AnnounceViewModel, type SheetState } from './view/AnnounceView'
import { CancelDialog, type CancelModel } from './view/Dialogs'
import { NoticeView } from './view/NoticeView'
import { useDeliveryWords } from './words'

/**
 * `/p/<party>/deliveries/new?po=<id>` and `/p/<party>/deliveries/<id>?step=…` for a supplier (B-W2b-186; design
 * portal.supplier.asn sub-page `announce`, sec:asn-grid "Row → ship notice view; editable until received"): a new notice from
 * one of our confirmed orders, a draft on its four steps, a SENT notice as it stands or being changed, the cancel. Each step
 * writes what it holds at its version with ONE Idempotency-Key per body (step 1 creates the draft, step 2 reads the sheet
 * first and keeps it on the second call, step 3 the terms, step 4 sends); a refusal is said in the page's words; the live
 * channel re-reads the notice (typed work is never overwritten: "it changed, read it again").
 */
export function SupplierNoticePage({ id }: { id: string | null }) {
  return (
    <WithMessages namespaces={[NS, 'ds-words']}>
      <NoticeContainer id={id} />
    </WithMessages>
  )
}

type Load = 'loading' | 'error' | 'missing' | 'ready' | 'forbidden'
type CancelState = Omit<CancelModel, 'heldReason'>

const blank = (value: string): string | null => (value.trim() === '' ? null : value.trim())

function NoticeContainer({ id }: { id: string | null }) {
  const frame = usePortalFrame()
  const api = usePortalApi()
  const router = useRouter()
  const search = useSearchParams()
  const words = useDeliveryWords()
  const { t, locale } = words
  const offline = useOffline()
  const po = search?.get('po') ?? null
  const stepParam = stepOf(search?.get('step'))
  const isNew = id === null
  const allowed = frame.me.permissions.includes('portal.shipNotices.view')

  const [load, setLoad] = useState<Load>('loading')
  const [page, setPage] = useState<NoticePage | null>(null)
  const [shippable, setShippable] = useState<ShippableRead | null>(null)
  const [linesDraft, setLinesDraft] = useState<LinesDraft>({})
  const [terms, setTerms] = useState<TermsDraft>(termsDraftOf(null))
  const [sendNote, setSendNote] = useState('')
  const [sheet, setSheet] = useState<SheetState>({ state: 'idle' })
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<{ problem: Problem; issues: readonly string[] } | null>(null)
  const [done, setDone] = useState<AnnounceViewModel['done']>(null)
  const [stale, setStale] = useState(false)
  const [dialog, setDialog] = useState<CancelState | null>(null)
  const sheetContent = useRef<{ fileName: string; content: string } | null>(null)
  const keys = useRef<Map<string, string>>(new Map())
  /** One Idempotency-Key per write and body: a retry of the same body sends the same key. */
  const keyFor = (name: string, body: unknown) => {
    const text = `${name}:${JSON.stringify(body)}`
    let key = keys.current.get(text)
    if (!key) {
      key = newIdempotencyKey()
      keys.current.set(text, key)
    }
    return key
  }

  // The order's lines (their open quantity, need date and asks) and the notice as read.
  const orderId = page?.notice.purchaseOrder.id ?? po
  const order = useMemo(() => {
    if (page) return { id: page.notice.purchaseOrder.id, number: page.notice.purchaseOrder.number }
    const found = po ? shippable?.orders.find((entry) => entry.id === po) : undefined
    return found ? { id: found.id, number: found.documentNumber } : null
  }, [page, po, shippable])
  const choices = useMemo(() => shippable?.orders.find((entry) => entry.id === orderId)?.lines ?? [], [shippable, orderId])
  const lines = useMemo(() => shipLinesOf({ choices, notice: page?.notice ?? null, addable: page?.addable ?? [] }), [choices, page])

  /** The drafts start from what the notice holds (after each read and each write). */
  const startFrom = useCallback(
    (next: NoticePage | null, nextChoices: ShippableRead | null, orderOf: string | null) => {
      const own = nextChoices?.orders.find((entry) => entry.id === orderOf)?.lines ?? []
      setLinesDraft(linesDraftOf(shipLinesOf({ choices: own, notice: next?.notice ?? null, addable: next?.addable ?? [] }), next?.notice ?? null, locale))
      setTerms(termsDraftOf(next?.notice ?? null))
      setSendNote(next?.notice.note ?? '')
    },
    [locale],
  )

  const read = useCallback(async () => {
    try {
      if (id === null) {
        const next = await fetchShippable(api, null)
        setShippable(next)
        setPage(null)
        startFrom(null, next, po)
      } else {
        const next = await fetchNotice(api, id)
        // The order's open lines: their need dates and asks (a read the page can do without).
        const own = await fetchShippable(api, next.notice.purchaseOrder.id).catch(() => null)
        setShippable(own)
        setPage(next)
        startFrom(next, own, next.notice.purchaseOrder.id)
      }
      setStale(false)
      setLoad('ready')
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setLoad('missing')
      else if (isApiError(error) && error.kind === 'forbidden') setLoad('forbidden')
      else setLoad('error')
    }
  }, [api, id, po, startFrom])

  useEffect(() => {
    if (!allowed) return
    void read()
  }, [read, allowed])

  const notice = page?.notice ?? null
  const draft = notice?.status === 'DRAFT'
  const changing = notice?.status === 'SENT' && stepParam !== null && (page?.canEdit ?? false)
  const stepping = done !== null || isNew || draft || changing
  const step: Step = isNew ? 'lines' : (stepParam ?? 'lines')
  const facts = { mayWrite: page?.mayWrite ?? shippable?.mayWrite ?? true, preview: frame.me.preview, offline, busy }

  const body = useMemo(() => linesBody(lines, linesDraft, locale), [lines, linesDraft, locale])
  const linesDirty = isNew ? body.length > 0 : notice !== null && notice.status !== 'RECEIVED' && notice.status !== 'CANCELLED' && linesChanged(body, notice)
  const termsDirty = !isNew && notice !== null && (draft || changing) && termsChanged(terms, notice)
  const dirty = done === null && (linesDirty || termsDirty || sheet.state === 'read')
  usePortalUnsaved(`asn:${id ?? 'new'}`, { dirty, what: isNew || draft ? t('unsaved.notice') : t('unsaved.change') })

  // Live: a change of this notice (our receipt, a cancel elsewhere, a colleague's change) re-reads it; typed work stays.
  usePortalLive(
    {
      onChange: (change) => {
        if (!page || !page.live.events.includes(change.type) || change.fields.shipNoticeId !== page.notice.id) return
        void fetchNotice(api, page.notice.id)
          .then((next) => {
            if (next.notice.version === page.notice.version && next.notice.state === page.notice.state) return
            if (dirty) setStale(true)
            else {
              setPage(next)
              startFrom(next, shippable, next.notice.purchaseOrder.id)
            }
          })
          .catch(() => undefined)
      },
      onReconnect: () => (dirty ? undefined : void read()),
    },
    allowed && !isNew,
  )

  const goStep = (next: Step, noticeId = notice?.id) => {
    if (!noticeId) return
    setProblem(null)
    router.push(noticeHref(frame.prefix, noticeId, next), { scroll: false })
  }

  const refused = (error: unknown) => {
    setBusy(false)
    const kind = isApiError(error) ? error.kind : null
    setProblem({ problem: problemOf(kind), issues: isApiError(error) && kind === 'invalid' ? issueKeysOf(error.issues) : [] })
    if (kind === 'conflict') setStale(true)
  }

  const wrote = (next: NoticePage) => {
    setPage(next)
    startFrom(next, shippable, next.notice.purchaseOrder.id)
    setBusy(false)
    setProblem(null)
    setStale(false)
  }

  /** Saves the step's typed work (lines, terms) when it changed and may go; true when the page may move on. */
  const saveStep = async (): Promise<boolean> => {
    if (step === 'lines') {
      if (linesHeld(linesDraft, locale, facts)) return false
      if (isNew) {
        if (!order) return false
        setBusy(true)
        try {
          const created = await createNotice(api, { purchaseOrderId: order.id, lines: body }, keyFor('create', { order: order.id, body }))
          setBusy(false)
          // The draft's own address: its steps go on there.
          router.replace(noticeHref(frame.prefix, created.notice.id, hasLeather(created.notice) ? 'packing' : 'transport'))
        } catch (error) {
          refused(error)
        }
        return false
      }
      if (!notice || !linesChanged(body, notice)) return true
      setBusy(true)
      try {
        wrote(await updateNotice(api, notice.id, { version: notice.version, lines: body }, keyFor('lines', { version: notice.version, body })))
        return true
      } catch (error) {
        refused(error)
        return false
      }
    }
    if (step === 'transport') {
      if (!notice || termsHeld(terms, facts)) return false
      if (!termsChanged(terms, notice)) return true
      setBusy(true)
      const values = termsBody(terms)
      try {
        wrote(await updateNotice(api, notice.id, { version: notice.version, ...values }, keyFor('terms', { version: notice.version, values })))
        return true
      } catch (error) {
        refused(error)
        return false
      }
    }
    return true
  }

  const next = async () => {
    if (busy) return
    if (step === 'review') {
      if (!page || !notice || changing) return
      if (sendHeld(page, sendNote, facts)) return
      setBusy(true)
      const values = { version: notice.version, note: blank(sendNote) }
      try {
        const sent = await sendNotice(api, notice.id, values, keyFor('send', values))
        wrote(sent)
        setDone({ id: sent.notice.id, number: sent.notice.number ?? '', expectedDate: sent.notice.expectedDate, site: sent.site?.name ?? null })
        frame.refreshTasks()
      } catch (error) {
        refused(error)
      }
      return
    }
    if (step === 'packing') {
      goStep('transport')
      return
    }
    if (await saveStep()) goStep(STEPS[STEPS.indexOf(step) + 1]!)
  }

  /** Another step (the stepper, ← →, Back, a "Fix" link): the step's typed work is saved first when it may go. */
  const moveTo = async (target: Step) => {
    if (busy || target === step || !notice) return
    const typed = (step === 'lines' && linesDirty) || (step === 'transport' && termsDirty)
    const held = step === 'lines' ? linesHeld(linesDraft, locale, facts) : step === 'transport' ? termsHeld(terms, facts) : null
    if (typed && held === null) {
      if (!(await saveStep())) return
    }
    goStep(target)
  }

  // ── the packing list ───────────────────────────────────────────────────────────────────────────────────────────────
  const readFile = async (file: File) => {
    if (!notice || writeHeld(facts)) return
    setProblem(null)
    setSheet({ state: 'reading', fileName: file.name })
    try {
      const content = await fileContent(file)
      sheetContent.current = { fileName: file.name, content }
      const values = { version: notice.version, fileName: file.name, content, numberFormat: locale, apply: false }
      const answer = await readSheet(api, notice.id, values, keyFor('sheet', { version: notice.version, fileName: file.name, size: content.length, apply: false }))
      setSheet({ state: 'read', fileName: file.name, read: answer, keeping: false })
    } catch (error) {
      const kind = isApiError(error) ? error.kind : null
      setSheet({ state: 'failed', fileName: file.name, problem: problemOf(kind), issues: isApiError(error) && kind === 'invalid' ? issueKeysOf(error.issues) : [] })
    }
  }

  const keepSheet = async () => {
    if (!notice || sheet.state !== 'read' || sheet.keeping || !sheetContent.current || writeHeld(facts)) return
    if (sheet.read.unreadable > 0) return
    const { fileName, content } = sheetContent.current
    setSheet({ ...sheet, keeping: true })
    try {
      const values = { version: notice.version, fileName, content, numberFormat: locale, apply: true }
      const answer = await readSheet(api, notice.id, values, keyFor('sheet', { version: notice.version, fileName, size: content.length, apply: true }))
      if (answer.applied && answer.page) {
        wrote(answer.page)
        setSheet({ state: 'idle' })
        sheetContent.current = null
      } else setSheet({ state: 'read', fileName, read: answer, keeping: false })
    } catch (error) {
      setSheet({ ...sheet, keeping: false })
      refused(error)
    }
  }

  const removeList = async () => {
    if (!notice || writeHeld(facts) || busy) return
    setBusy(true)
    const values = { version: notice.version, rows: [] }
    try {
      wrote(await setPackingList(api, notice.id, values, keyFor('remove', values)))
      setSheet({ state: 'idle' })
    } catch (error) {
      refused(error)
    }
  }

  // ── cancel ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const openCancel = () => {
    if (!notice) return
    setDialog({ target: { id: notice.id, number: notice.number, status: notice.status, version: notice.version, orderNumber: notice.purchaseOrder.number }, reason: '', busy: false, problem: null })
  }
  const confirmCancel = async () => {
    if (!dialog || dialog.busy || cancelHeld(dialog.target, dialog.reason, facts)) return
    const values = { version: dialog.target.version, reason: blank(dialog.reason) }
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const answer = await cancelNotice(api, dialog.target.id, values, keyFor('cancel', values))
      setDialog(null)
      if (answer.removed) router.push(listHref(frame.prefix))
      else if (answer.page) {
        wrote(answer.page)
        router.replace(noticeHref(frame.prefix, answer.page.notice.id))
      }
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: problemOf(isApiError(error) ? error.kind : null) } : current))
    }
  }

  const held = writeHeld({ ...facts, busy: false })
  usePortalBand(
    !allowed || load === 'forbidden'
      ? { title: t('list.title') }
      : isNew && !page
        ? newBandOf({ t, locale, prefix: frame.prefix, order })
        : page
          ? noticeBandOf({ t, locale, prefix: frame.prefix, page, stepping: stepping && done === null, changeHeld: held ? t(held) : null, onCancel: openCancel })
          : { title: t('announce.title'), back: { href: listHref(frame.prefix), label: t('list.title') } },
  )

  if (!allowed || load === 'forbidden') return <NotInAccessHere />

  const cancelModel: CancelModel | null = dialog ? { ...dialog, heldReason: cancelHeld(dialog.target, dialog.reason, { ...facts, busy: dialog.busy }) } : null
  const dialogActions = {
    onReason: (reason: string) => setDialog((current) => (current ? { ...current, reason, problem: null } : current)),
    onConfirm: () => void confirmCancel(),
    onClose: () => setDialog((current) => (current?.busy ? current : null)),
  }

  if (!stepping && page) {
    return <NoticeView model={{ state: load === 'ready' ? 'ready' : load === 'missing' ? 'missing' : load === 'error' ? 'error' : 'loading', page, prefix: frame.prefix, dialog: cancelModel, problem: problem?.problem ?? null }} actions={{ onRetry: () => void read(), dialog: dialogActions }} />
  }

  const model: AnnounceViewModel = {
    state: load,
    prefix: frame.prefix,
    orders: isNew && !order ? (shippable?.orders ?? []) : null,
    order,
    step,
    changing,
    page,
    lines,
    linesDraft,
    terms,
    sendNote,
    sheet,
    facts,
    problem: isNew && po && !order && load === 'ready' ? { problem: 'notShippable', issues: [] } : problem,
    done,
    stale,
  }
  return (
    <>
      <AnnounceView
        model={model}
        actions={{
          onLine: (lineId, patch) => setLinesDraft((current) => ({ ...current, [lineId]: { ...(current[lineId] ?? { include: false, quantity: '', dyeBatch: '', supplierLot: '' }), ...patch } })),
          onTerm: (field, value) => setTerms((current) => ({ ...current, [field]: value })),
          onSendNote: setSendNote,
          onStep: (target) => void moveTo(target),
          onNext: () => void next(),
          onBack: () => void moveTo(STEPS[Math.max(0, STEPS.indexOf(step) - 1)]!),
          onFile: (file) => void readFile(file),
          onKeepSheet: () => void keepSheet(),
          onOtherFile: () => {
            sheetContent.current = null
            setSheet({ state: 'idle' })
          },
          onRemoveList: () => void removeList(),
          onRetry: () => {
            setLoad('loading')
            void read()
          },
          onReload: () => void read(),
        }}
      />
      {cancelModel ? <CancelDialog model={cancelModel} actions={dialogActions} /> : null}
    </>
  )
}
