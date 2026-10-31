'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { downloadLink } from '../../../../record-panels/api'
import { WithMessages } from '../../../../record-panels/i18n'
import { RecordPanels } from '../../../../record-panels/RecordPanels'
import { findMaterials, getMaterial } from '../../../_shared/buying/api'
import { useCoalesced, useLive, useThreadDock } from '../../../_shared/buying/hooks'
import { buyingCan, part, PART_LOADING, phrase, readProblem, todayIn, writeProblem, type Loaded, type Part, type Phrase } from '../../../_shared/buying/model'
import { parseCc } from '../../../_shared/document-send/model'
import type { DocumentSendModel } from '../../../_shared/document-send/model'
import {
  acceptProposal,
  addLine,
  cancelOrder,
  changeOrder,
  counterPropose,
  editLine,
  endLines,
  getReach,
  getReminders,
  getRevisions,
  moveConfirmBy,
  remind,
  getAnswer,
  getDocuments,
  getOrder,
  getSupplierView,
  previewBytes,
  previewHref,
  receiptsOf,
  refuseProposal,
  removeLine,
  sendCheck,
  sendNewLink,
  sendOrder,
  updateOrder,
  type OrderDocuments,
  type OrderReceipt,
  type OrderReminders,
  type OrderRevisions,
  type PurchaseOrder,
  type ReachAction,
  type SupplierAnswer,
} from '../api'
import { sendModelOf, tabOf, type LineDraft, type OrderDialog, type OrderRecordModel, type SendCheckState } from '../model'
import { isDailyDialog, type SendExtra } from '../daily-model'
import { detailsOf, OrderRecordView } from './view/OrderRecordView'
// B-W2a-81: the Invoices tab is Finance's (areas/finance/payables/po-tab).
import { PoInvoices } from '../../../finance/payables/po-tab/PoInvoices'

const TIME_ZONE = 'Europe/Rome'

/**
 * `/w/<company>/purchasing/orders/<id>` (SCR-059): loads the order (purchasing.view; prices only with the cost grain),
 * the supplier's answer, its receipts (inventory.stock.view) and documents, and does what the view asks, one write at a
 * time, each with the order's version as read (a 409 reads it again and says so). Send: the shared send dialog over
 * GET send-check (the PDF is made and frozen at the send: the Documents tab keeps it). Live: purchase_order.* and
 * inventory.receipt_* events of this order read it again; with a dialog open the page says it changed.
 */
export function OrderRecord({ orderId }: { orderId: string }) {
  return (
    <WithMessages namespaces={['buying', 'purchasing-orders', 'lists', 'records', 'send']}>
      <RecordContainer orderId={orderId} />
    </WithMessages>
  )
}

const NEW_LINE: LineDraft = {
  lineId: null,
  materialQuery: '',
  materials: null,
  material: null,
  materialProblem: null,
  itemColourId: '',
  quantity: '',
  uom: '',
  unitPrice: '',
  needDate: '',
  grade: '',
  thicknessMinMm: '',
  thicknessMaxMm: '',
  oneDyeBatch: true,
  areaTolerancePct: '',
  supplierArticleCode: '',
  supplierColourCode: '',
  note: '',
}

function RecordContainer({ orderId }: { orderId: string }) {
  const t = useT('buying')
  const td = useT('purchasing-orders')
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const tab = tabOf(params?.get('tab'))
  const prefix = pathname.replace(/\/purchasing\/orders\/[^/]+\/?$/, '')
  const can = useMemo(() => buyingCan(session.permissions), [session.permissions])

  const [order, setOrder] = useState<Loaded<PurchaseOrder>>({ status: 'loading' })
  const current = useRef<PurchaseOrder | null>(null)
  const [answer, setAnswer] = useState<Part<SupplierAnswer>>(PART_LOADING)
  const [receipts, setReceipts] = useState<Part<OrderReceipt[]> | null>(can.stockView ? PART_LOADING : null)
  const [documents, setDocuments] = useState<Part<OrderDocuments>>(PART_LOADING)
  // B-W2a-69: the revisions (in the person's language: the draft's change words) and the reminders.
  const locale = useLocale()
  const [revisions, setRevisions] = useState<Part<OrderRevisions>>(PART_LOADING)
  const [reminders, setReminders] = useState<Part<OrderReminders>>(PART_LOADING)
  const [sendExtra, setSendExtra] = useState<SendExtra>({ confirmBy: '', changeNote: '' })
  /** One Idempotency-Key per daily dialog (a retry of the same dialog is the same request). */
  const dailyKey = useRef<string>(newIdempotencyKey())
  const [dialog, setDialog] = useState<OrderDialog | null>(null)
  const dialogRef = useRef<OrderDialog | null>(null)
  dialogRef.current = dialog
  const [dialogProblem, setDialogProblem] = useState<Phrase | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<OrderRecordModel['notice']>(null)
  const [changed, setChanged] = useState<{ at: string } | null>(null)
  const [check, setCheck] = useState<SendCheckState>({ status: 'loading' })
  const [fields, setFields] = useState({ cc: '', subject: '', message: '' })
  const [sending, setSending] = useState(false)
  const [sendProblem, setSendProblem] = useState<string | null>(null)
  const [sendResult, setSendResult] = useState<DocumentSendModel['result']>(null)
  const [preview, setPreview] = useState<{ src: Uint8Array | null; problem: string | null }>({ src: null, problem: null })
  const sendKey = useRef<string | null>(null)
  const { dockOpen, toggleDock } = useThreadDock('PurchaseOrder')
  const today = todayIn(TIME_ZONE)

  const setValue = useCallback((next: PurchaseOrder) => {
    current.current = next
    setOrder({ status: 'ready', value: next })
  }, [])

  const loadParts = useCallback(() => {
    getAnswer(api, orderId)
      .then((value) => setAnswer(part(value)))
      .catch((error: unknown) => setAnswer({ value: null, problem: readProblem(error) }))
    getDocuments(api, orderId)
      .then((value) => setDocuments(part(value)))
      .catch((error: unknown) => setDocuments({ value: null, problem: readProblem(error) }))
    getRevisions(api, orderId, locale)
      .then((value) => setRevisions(part(value)))
      .catch((error: unknown) => setRevisions({ value: null, problem: readProblem(error) }))
    getReminders(api, orderId)
      .then((value) => setReminders(part(value)))
      .catch((error: unknown) => setReminders({ value: null, problem: readProblem(error) }))
    if (can.stockView)
      receiptsOf(api, orderId)
        .then((value) => setReceipts(part(value)))
        .catch((error: unknown) => setReceipts({ value: null, problem: readProblem(error) }))
  }, [api, orderId, can.stockView, locale])

  const load = useCallback(async () => {
    try {
      const next = await getOrder(api, orderId)
      setValue(next)
      setChanged(null)
      loadParts()
    } catch (error) {
      if (isApiError(error) && error.kind === 'not_found') setOrder({ status: 'not_found' })
      else if (isApiError(error) && error.kind === 'forbidden') setOrder({ status: 'forbidden' })
      else setOrder({ status: 'error', problem: readProblem(error) })
    }
  }, [api, orderId, setValue, loadParts])

  useEffect(() => {
    void load()
  }, [load])

  // Live: this order's events (and receipts against it) read it again; a dialog open → "changed · Reload".
  const reread = useCoalesced(() => void load(), 700)
  const live = useLive(
    (change) => {
      const mine = change.fields.purchaseOrderId === orderId
      if (!mine || !(change.type.startsWith('purchase_order.') || change.type.startsWith('inventory.receipt_'))) return
      if (dialogRef.current && dialogRef.current.kind !== 'supplierView') setChanged({ at: new Date().toISOString() })
      else reread()
    },
    () => void load(),
  )

  const version = () => current.current?.version ?? 1

  /** One write; the order it answers replaces the page's, then the parts are read again. */
  const write = useCallback(
    async (run: () => Promise<PurchaseOrder | null>, success: Phrase | null, pathWords?: Parameters<typeof writeProblem>[1]) => {
      if (busy) return false
      setBusy(true)
      setNotice(null)
      setDialogProblem(null)
      try {
        const next = await run()
        if (next) setValue(next)
        setDialog(null)
        if (success) setNotice({ tone: 'success', words: success })
        loadParts()
        return true
      } catch (error) {
        const words = writeProblem(error, pathWords)
        if (dialogRef.current) setDialogProblem(words)
        else setNotice({ tone: 'danger', words })
        if (isApiError(error) && error.kind === 'conflict') void load()
        return false
      } finally {
        setBusy(false)
      }
    },
    [busy, load, loadParts, setValue],
  )

  // ---- the send dialog ---------------------------------------------------------------------------------------------------

  const openSend = useCallback(() => {
    setDialog({ kind: 'send' })
    setSendExtra({ confirmBy: '', changeNote: '' })
    setSendResult(null)
    setSendProblem(null)
    sendKey.current = newIdempotencyKey()
    setCheck({ status: 'loading' })
    setPreview({ src: null, problem: can.cost ? null : t('po.send.previewNeedsCost') })
    sendCheck(api, orderId)
      .then((value) => {
        setCheck({ status: 'ready', value })
        setFields((current) => ({ ...current, subject: current.subject || value.subject }))
        // The PDF as it would leave, in the supplier's language (it prints the prices: only with the cost grain).
        if (can.cost)
          previewBytes(api, orderId, value.language)
            .then((src) => setPreview({ src, problem: null }))
            .catch((error: unknown) => setPreview({ src: null, problem: t(isApiError(error) && error.kind === 'conflict' ? 'po.send.previewNeeds' : readProblem(error)) }))
      })
      .catch((error: unknown) => setCheck({ status: 'error', problem: t(readProblem(error)) }))
  }, [api, orderId, t, can.cost])

  const send = useCallback(async () => {
    const loaded = current.current
    if (!loaded || sending || check.status !== 'ready') return
    setSending(true)
    setSendProblem(null)
    try {
      const cc = parseCc(fields.cc).valid
      // B-W2a-69: the confirm-by chosen (else the API's default: 48 h, longer by the supplier's closed days) and a later revision's note.
      const confirmBy = sendExtra.confirmBy && sendExtra.confirmBy !== check.value.confirmBy ? sendExtra.confirmBy : null
      const changeNote = loaded.revision > 1 && sendExtra.changeNote.trim() ? sendExtra.changeNote.trim() : null
      const answer = await sendOrder(
        api,
        orderId,
        { version: loaded.version, ...(cc.length ? { cc } : {}), subject: fields.subject.trim() || null, message: fields.message.trim() || null, ...(confirmBy ? { confirmBy } : {}), ...(changeNote ? { changeNote } : {}) },
        sendKey.current ?? newIdempotencyKey(),
      )
      setValue(answer.order)
      setSendResult({ delivery: answer.delivery, to: answer.sent.to, at: answer.sent.sentAt, linkUntil: answer.sent.link.expiresAt })
      loadParts()
    } catch (error) {
      const words = writeProblem(error, (paths, info) => (paths.some((path) => path.includes('confirmBy')) ? phrase('purchasing-orders:send.confirmByRefused') : info.kind === 'conflict' ? phrase('po.send.refused') : null))
      setSendProblem(words.key.startsWith('purchasing-orders:') ? td(words.key.slice('purchasing-orders:'.length), words.params) : t(words.key, words.params))
      sendKey.current = newIdempotencyKey()
      if (isApiError(error) && error.kind === 'conflict') {
        void load()
        sendCheck(api, orderId)
          .then((value) => setCheck({ status: 'ready', value }))
          .catch(() => undefined)
      }
    } finally {
      setSending(false)
    }
  }, [api, orderId, sending, check, fields, sendExtra, setValue, loadParts, load, t, td])

  const recordHref = `${prefix}/purchasing/orders/${orderId}`
  const sendModel: DocumentSendModel | null =
    dialog?.kind === 'send' && order.status === 'ready'
      ? sendModelOf(
          {
            order: order.value,
            check,
            fields,
            sending,
            problem: sendProblem,
            result: sendResult,
            canSend: can.poSend,
            recordHref,
            timeZone: TIME_ZONE,
            preview: { src: preview.src, problem: preview.problem, openHref: can.cost && check.status === 'ready' ? previewHref(orderId, check.value.language) : null },
          },
          t,
        )
      : null

  // ---- lines -------------------------------------------------------------------------------------------------------------

  const searchMaterials = useCallback(
    (text: string) => {
      setDialog((open) => (open?.kind === 'line' ? { kind: 'line', draft: { ...open.draft, materialQuery: text, materials: null, materialProblem: null } } : open))
      findMaterials(api, text)
        .then((materials) => setDialog((open) => (open?.kind === 'line' && open.draft.materialQuery === text ? { kind: 'line', draft: { ...open.draft, materials } } : open)))
        .catch((error: unknown) => setDialog((open) => (open?.kind === 'line' && open.draft.materialQuery === text ? { kind: 'line', draft: { ...open.draft, materials: [], materialProblem: readProblem(error) } } : open)))
    },
    [api],
  )

  const pickMaterial = useCallback(
    async (id: string | null) => {
      if (!id) {
        setDialog((open) => (open?.kind === 'line' ? { kind: 'line', draft: { ...open.draft, material: null, itemColourId: '' } } : open))
        return
      }
      try {
        const material = await getMaterial(api, id)
        setDialog((open) =>
          open?.kind === 'line'
            ? {
                kind: 'line',
                draft: {
                  ...open.draft,
                  material,
                  uom: material.purchaseUom,
                  itemColourId: material.colours.filter((colour) => colour.status === 'ACTIVE').length === 1 ? material.colours.find((colour) => colour.status === 'ACTIVE')!.id : '',
                  oneDyeBatch: material.kind === 'LEATHER',
                  needDate: open.draft.needDate || current.current?.requestedDate || '',
                },
              }
            : open,
        )
      } catch (error) {
        setDialog((open) => (open?.kind === 'line' ? { kind: 'line', draft: { ...open.draft, materialProblem: readProblem(error) } } : open))
      }
    },
    [api],
  )

  const editLineDialog = useCallback(
    async (lineId: string) => {
      const line = current.current?.lines.find((entry) => entry.id === lineId)
      if (!line) return
      const draft: LineDraft = {
        ...NEW_LINE,
        lineId,
        materials: [],
        itemColourId: line.itemColourId ?? '',
        quantity: line.quantity.replace(/\.?0+$/, ''),
        uom: line.uom,
        unitPrice: line.unitPrice ? line.unitPrice.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : '',
        needDate: line.needDate,
        grade: line.grade ?? '',
        thicknessMinMm: line.thicknessMinMm ?? '',
        thicknessMaxMm: line.thicknessMaxMm ?? '',
        oneDyeBatch: line.oneDyeBatch,
        areaTolerancePct: line.areaTolerancePct ?? '',
        supplierArticleCode: line.supplierArticleCode ?? '',
        supplierColourCode: line.supplierColourCode ?? '',
        note: line.note ?? '',
      }
      setDialogProblem(null)
      setDialog({ kind: 'line', draft })
      try {
        const material = await getMaterial(api, line.itemId)
        setDialog((open) => (open?.kind === 'line' && open.draft.lineId === lineId ? { kind: 'line', draft: { ...open.draft, material } } : open))
      } catch (error) {
        setDialog((open) => (open?.kind === 'line' ? { kind: 'line', draft: { ...open.draft, materialProblem: readProblem(error) } } : open))
      }
    },
    [api],
  )

  const saveLine = useCallback(async () => {
    if (dialog?.kind !== 'line' || !dialog.draft.material) return
    const draft = dialog.draft
    const material = draft.material!
    const leather = material.kind === 'LEATHER'
    const text = (value: string) => (value.trim() ? value.trim() : null)
    const fields = {
      uom: draft.uom || undefined,
      ...(can.cost && draft.unitPrice.trim() ? { unitPrice: draft.unitPrice.trim() } : {}),
      supplierArticleCode: text(draft.supplierArticleCode),
      supplierColourCode: text(draft.supplierColourCode),
      note: text(draft.note),
      ...(leather ? { grade: text(draft.grade), thicknessMinMm: text(draft.thicknessMinMm), thicknessMaxMm: text(draft.thicknessMaxMm), oneDyeBatch: draft.oneDyeBatch, areaTolerancePct: text(draft.areaTolerancePct) } : {}),
    }
    const pathWords: Parameters<typeof writeProblem>[1] = (paths) => {
      if (paths.some((path) => path.includes('quantity'))) return phrase('po.lineForm.badQuantity')
      if (paths.some((path) => path.includes('needDate'))) return phrase('po.lineForm.badDate')
      if (paths.some((path) => path.includes('thickness') || path.includes('Tolerance') || path.includes('grade') || path.includes('oneDyeBatch'))) return phrase('po.lineForm.badLeather')
      if (paths.some((path) => path.includes('unitPrice'))) return phrase('po.lineForm.badPrice')
      return null
    }
    if (draft.lineId) {
      await write(() => editLine(api, orderId, draft.lineId!, version(), { ...fields, quantity: draft.quantity.trim(), needDate: draft.needDate }), phrase('po.notice.lineSaved'), pathWords)
    } else {
      await write(() => addLine(api, orderId, version(), { itemId: material.id, quantity: draft.quantity.trim(), needDate: draft.needDate, ...(draft.itemColourId ? { itemColourId: draft.itemColourId } : {}), ...fields }), phrase('po.notice.lineAdded'), pathWords)
    }
  }, [api, can.cost, dialog, orderId, write])

  const removeLines = useCallback(async () => {
    if (dialog?.kind !== 'removeLines') return
    const ids = dialog.lineIds
    await write(
      async () => {
        let latest: PurchaseOrder | null = current.current
        for (const id of ids) {
          latest = await removeLine(api, orderId, id, latest?.version ?? version())
          current.current = latest
        }
        return latest
      },
      phrase('po.notice.linesRemoved', { count: ids.length }),
      (_paths, info) => (info.kind === 'conflict' ? phrase('po.remove.planRefused') : null),
    )
  }, [api, dialog, orderId, write])

  // ---- header, link, cancel, proposal ---------------------------------------------------------------------------------------

  const saveDetails = useCallback(async () => {
    if (dialog?.kind !== 'details' || !current.current) return
    const draft = dialog.draft
    const before = detailsOf(current.current)
    const text = (value: string) => (value.trim() ? value.trim() : null)
    const draftOrder = current.current.status === 'DRAFT'
    const fields = {
      ...(draftOrder && draft.requestedDate !== before.requestedDate ? { requestedDate: draft.requestedDate || null } : {}),
      ...(draftOrder && draft.incoterms !== before.incoterms ? { incoterms: text(draft.incoterms) } : {}),
      ...(draftOrder && draft.paymentTerms !== before.paymentTerms ? { paymentTerms: text(draft.paymentTerms) } : {}),
      ...(draftOrder && draft.note !== before.note ? { note: text(draft.note) } : {}),
      ...(draft.internalNote !== before.internalNote ? { internalNote: text(draft.internalNote) } : {}),
    }
    if (Object.keys(fields).length === 0) {
      setDialog(null)
      return
    }
    await write(() => updateOrder(api, orderId, version(), fields), phrase('po.notice.detailsSaved'))
  }, [api, dialog, orderId, write])

  const newLink = useCallback(async () => {
    const message = dialog?.kind === 'newLink' ? dialog.message : ''
    await write(
      async () => (await sendNewLink(api, orderId, { version: version(), message: message.trim() || null })).order,
      phrase('po.notice.linkSent', { email: current.current?.contact?.email ?? '' }),
      (_paths, info) => (info.kind === 'conflict' ? phrase('po.newLink.refused') : null),
    )
  }, [api, dialog, orderId, write])

  // ---- B-W2a-69: the changes after the send ---------------------------------------------------------------------------------

  /** The reach of a cancel or a close short, read into the open dialog (never drawn as allowed before it is there). */
  const readReach = useCallback(
    (action: ReachAction, lineIds: string[]) => {
      getReach(api, orderId, action, lineIds)
        .then((value) =>
          setDialog((open) => (open && (open.kind === 'cancelOrder' || open.kind === 'endLines') ? { ...open, reach: { status: 'ready', value } } : open)),
        )
        .catch((error: unknown) => setDialog((open) => (open && (open.kind === 'cancelOrder' || open.kind === 'endLines') ? { ...open, reach: { status: 'error', problem: readProblem(error) } } : open)))
    },
    [api, orderId],
  )

  const openDaily = useCallback((next: OrderDialog) => {
    dailyKey.current = newIdempotencyKey()
    setDialogProblem(null)
    setDialog(next)
  }, [])

  const openCancel = useCallback(() => {
    openDaily({ kind: 'cancelOrder', reason: '', message: '', reach: { status: 'loading' } })
    readReach('CANCEL_ORDER', [])
  }, [openDaily, readReach])

  const openEnd = useCallback(
    (action: 'CANCEL_LINES' | 'CLOSE_SHORT', lineIds: string[]) => {
      openDaily({ kind: 'endLines', action, lineIds, reason: '', message: '', reach: { status: 'loading' } })
      readReach(action, lineIds)
    },
    [openDaily, readReach],
  )

  const dailyRefusal: Parameters<typeof writeProblem>[1] = (paths, info) => {
    if (paths.some((path) => path.includes('confirmBy'))) return phrase('purchasing-orders:confirmBy.refused')
    if (paths.some((path) => path.startsWith('body/reason'))) return phrase('po.cancel.reasonNeeded')
    if (info.kind === 'conflict') return phrase('purchasing-orders:refused.changed')
    return null
  }

  const confirmCancel = useCallback(async () => {
    if (dialog?.kind !== 'cancelOrder') return
    const { reason, message } = dialog
    await write(
      async () => (await cancelOrder(api, orderId, { version: version(), reason: reason.trim(), message: message.trim() || null })).order,
      phrase(current.current?.status === 'DRAFT' ? 'po.notice.cancelledDraft' : 'po.notice.cancelled'),
      dailyRefusal,
    )
  }, [api, dialog, orderId, write])

  const confirmEnd = useCallback(async () => {
    if (dialog?.kind !== 'endLines') return
    const { action, lineIds, reason, message } = dialog
    const count = lineIds.length
    await write(
      async () => (await endLines(api, orderId, action === 'CLOSE_SHORT' ? 'close-short' : 'cancel', { version: version(), lineIds, reason: reason.trim(), message: message.trim() || null }, dailyKey.current)).order,
      phrase(action === 'CLOSE_SHORT' ? 'purchasing-orders:notice.closedShort' : 'purchasing-orders:notice.linesCancelled', { count }),
      dailyRefusal,
    )
  }, [api, dialog, orderId, write])

  const startChange = useCallback(async () => {
    if (dialog?.kind !== 'change' && dialog?.kind !== 'counter') return
    const counter = dialog.kind === 'counter'
    const note = dialog.note.trim() || null
    await write(
      async () => (counter ? (await counterPropose(api, orderId, { version: version(), note }, dailyKey.current)).order : (await changeOrder(api, orderId, { version: version(), note }, dailyKey.current)).order),
      phrase(counter ? 'purchasing-orders:notice.countered' : 'purchasing-orders:notice.changed', { revision: (current.current?.revision ?? 1) + 1 }),
      dailyRefusal,
    )
    router.replace(`${recordHref}?tab=lines`)
  }, [api, dialog, orderId, write, router, recordHref])

  const moveDeadline = useCallback(async () => {
    if (dialog?.kind !== 'confirmBy' || !dialog.confirmBy) return
    const confirmBy = dialog.confirmBy
    await write(async () => moveConfirmBy(api, orderId, version(), confirmBy), phrase('purchasing-orders:notice.confirmByMoved'), dailyRefusal)
  }, [api, dialog, orderId, write])

  const remindNow = useCallback(async () => {
    if (dialog?.kind !== 'remind') return
    const message = dialog.message.trim() || null
    await write(async () => (await remind(api, orderId, { version: version(), message }, dailyKey.current)).order, phrase('purchasing-orders:notice.reminded', { email: current.current?.contact?.email ?? '' }), dailyRefusal)
  }, [api, dialog, orderId, write])

  const accept = useCallback(async () => {
    if (dialog?.kind !== 'accept') return
    const message = dialog.message
    await write(async () => (await acceptProposal(api, orderId, version(), message)).order, phrase('po.notice.accepted'), (_paths, info) => (info.kind === 'conflict' ? phrase('po.review.refused') : null))
  }, [api, dialog, orderId, write])

  const refuse = useCallback(async () => {
    if (dialog?.kind !== 'refuse') return
    const note = dialog.note
    await write(async () => (await refuseProposal(api, orderId, version(), note)).order, phrase('po.notice.refused'), (_paths, info) => (info.kind === 'conflict' ? phrase('po.review.refused') : null))
  }, [api, dialog, orderId, write])

  const openSupplierView = useCallback(() => {
    setDialog({ kind: 'supplierView', view: { status: 'loading' } })
    getSupplierView(api, orderId)
      .then((view) => setDialog((open) => (open?.kind === 'supplierView' ? { kind: 'supplierView', view: { status: 'ready', value: view } } : open)))
      .catch((error: unknown) => setDialog((open) => (open?.kind === 'supplierView' ? { kind: 'supplierView', view: { status: 'error', problem: readProblem(error) } } : open)))
  }, [api, orderId])

  const download = useCallback(
    async (fileId: string) => {
      try {
        const answer = await downloadLink(api, fileId)
        window.open(answer.download.url, '_blank', 'noopener')
      } catch (error) {
        setNotice({ tone: 'danger', words: phrase(readProblem(error)) })
      }
    },
    [api],
  )

  // ?tab=lines&edit=details (a send check's Fix link): the details dialog, once the order is there; ?cancel=1 (the list's
  // row verb Cancel): the cancel dialog with its reach.
  useEffect(() => {
    if (params?.get('edit') === 'details' && order.status === 'ready' && !dialog) setDialog({ kind: 'details', draft: detailsOf(order.value) })
    if (params?.get('cancel') === '1' && order.status === 'ready' && !dialog) openCancel()
  }, [params, order.status])

  const model: OrderRecordModel = {
    prefix,
    can,
    tab,
    order,
    answer,
    receipts,
    documents,
    revisions,
    reminders,
    sendExtra: dialog?.kind === 'send' ? sendExtra : null,
    sendFacts: dialog?.kind === 'send' && check.status === 'ready' ? { confirmBy: check.value.confirmBy ?? null, changes: check.value.changes ?? null } : null,
    now: new Date().toISOString(),
    send: sendModel,
    previewHref: can.cost && order.status === 'ready' && order.value.status === 'DRAFT' ? previewHref(orderId) : null,
    live,
    dockOpen,
    changed,
    notice,
    busy,
    dialog,
    dialogProblem,
    timeZone: TIME_ZONE,
    today,
  }

  const panels =
    order.status === 'ready' && (tab === 'activity' || dockOpen) ? (
      <RecordPanels record={{ type: 'PurchaseOrder', id: order.value.id, companyId: order.value.companyId, siteId: order.value.siteId }} title={order.value.number} party={{ id: order.value.partyId, name: order.value.supplier.name, emails: order.value.contact?.email ? [order.value.contact.email] : [] }} />
    ) : null

  return (
    <OrderRecordView
      model={model}
      panels={panels}
      invoices={order.status === 'ready' && session.permissions.includes('payables.view') ? <PoInvoices orderId={order.value.id} prefix={prefix} /> : null}
      actions={{
        onRetry: () => void load(),
        onReload: () => void load(),
        onDock: toggleDock,
        onDialog: (next) => {
          setDialogProblem(null)
          if (next?.kind === 'send') openSend()
          else setDialog(next)
          if (next === null && (params?.get('edit') || params?.get('cancel'))) router.replace(`${recordHref}?tab=${tab}`)
          if (next && isDailyDialog(next) && (!dialog || dialog.kind !== next.kind)) dailyKey.current = newIdempotencyKey()
          if (next?.kind === 'review' && !answer.value) loadParts()
        },
        onDismissNotice: () => setNotice(null),
        onSend: {
          onField: (field, value) => setFields((current) => ({ ...current, [field]: value })),
          onSend: () => void send(),
          onRetryChecks: openSend,
          onNewLink: () => setDialog({ kind: 'newLink', message: '' }),
        },
        onNewLink: () => void newLink(),
        onAccept: () => void accept(),
        onRefuse: () => void refuse(),
        onSaveDetails: () => void saveDetails(),
        onDetails: (draft) => setDialog({ kind: 'details', draft }),
        line: {
          onChange: (draft) => setDialog({ kind: 'line', draft }),
          onMaterialQuery: searchMaterials,
          onMaterial: (id) => void pickMaterial(id),
          onSave: () => void saveLine(),
        },
        onRemoveLines: () => void removeLines(),
        onEditLine: (lineId) => void editLineDialog(lineId),
        onAddLine: () => {
          setDialogProblem(null)
          setDialog({ kind: 'line', draft: { ...NEW_LINE } })
          searchMaterials('')
        },
        onSupplierView: openSupplierView,
        onDownload: (fileId) => void download(fileId),
        onRetryPart: () => loadParts(),
        daily: {
          onSendExtra: setSendExtra,
          onChange: () => void startChange(),
          onCounter: () => void startChange(),
          onCancelOrder: openCancel,
          onConfirmCancel: () => void confirmCancel(),
          onEndLines: openEnd,
          onConfirmEnd: () => void confirmEnd(),
          onConfirmBy: () => void moveDeadline(),
          onRemind: () => void remindNow(),
          onOpenRevision: (fileId) => void download(fileId),
        },
      }}
    />
  )
}

