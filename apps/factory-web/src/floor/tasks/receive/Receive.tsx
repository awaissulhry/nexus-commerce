'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import { AsOfMemory, codeKey } from '../shared/as-of'
import type { TaskProblem } from '../shared/task-api'
import { fetchExpected, fetchOrder, fetchReceipt, postReceipt, printTags, retryTag, type ExpectedOrder, type FloorReceipt, type OrderToReceive, type ReceiptNote, type ReprintReason } from './api'
import {
  addHide,
  addLot,
  deliverySummary,
  emptyDelivery,
  entered,
  entryOf,
  formAfter,
  hideOfCode,
  hideProblem,
  lineIdAtBodyIndex,
  nextHideForm,
  num,
  quantityBounds,
  receiveBody,
  receives,
  setOver,
  setQuantity,
  tagsPending,
  undoHide,
  undoLot,
  type Delivery,
  type HideForm,
  type QuantityForm,
} from './model'
import { ReceiveView, type ReceiveAction, type ReceiveStage } from './view/ReceiveView'

/**
 * The live SCR-092 (`/floor/receive`): which delivery (a PO number scanned here or on Home, or a row of what the site
 * expects; a code that is no PO number is kept as the delivery note's), the order's lines, each line's step (hides one by
 * one, lots, a quantity), the summary, then ONE post of the whole delivery with its Idempotency-Key (kept while the body
 * is the same, so a lost answer is sent again, never applied twice). Receiving is online only (the receipt, its lots and
 * the hide tags are numbered by the office): offline the entries stay on screen and Finish is held with the reason. After
 * the post the tags' print state is read again every few seconds while a tag is on its way; Retry and Reprint are one
 * call each.
 */

// What the tablet read during the visit (offline it stays on screen with its time; nothing is stored).
const EXPECTED = new AsOfMemory<ExpectedOrder[]>(4)
const POLL_MS = 3_000
const POLL_TRIES = 40

export function FloorReceive() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.receive', { showHome: true })
  const { me, api, online, sessionEnded, locale } = store
  const siteId = me?.site.id ?? ''
  const may = Boolean(me?.permissions.includes('inventory.receive'))

  const [stage, setStage] = useState<ReceiveStage>('scan')
  const [expected, setExpected] = useState<ExpectedOrder[] | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [ddtCode, setDdtCode] = useState<string | null>(null)
  const [order, setOrder] = useState<OrderToReceive | null>(null)
  const [delivery, setDelivery] = useState<Delivery | null>(null)
  const [lineId, setLineId] = useState<string | null>(null)
  const [hideForm, setHideForm] = useState<HideForm | null>(null)
  const [quantityForm, setQuantityForm] = useState<QuantityForm | null>(null)
  const [holdAsk, setHoldAsk] = useState(false)
  const [leaveAsk, setLeaveAsk] = useState(false)
  const [busy, setBusy] = useState<'post' | 'tags' | 'retry' | 'read' | null>(null)
  const [posted, setPosted] = useState<{
    receipt: FloorReceipt
    notes: ReceiptNote[]
  } | null>(null)
  const [selectedHideId, setSelectedHideId] = useState<string | null>(null)
  const [reprintAsk, setReprintAsk] = useState(false)
  const [problem, setProblem] = useState<{
    problem: TaskProblem
    code: string | null
  } | null>(null)
  const [refusedSeq, setRefusedSeq] = useState<number | null>(null)
  const started = useRef(false)
  // The post's key, kept while the body sent is the same (a retry of a lost answer is answered, never posted twice).
  const postKey = useRef<{ body: string; key: string } | null>(null)

  const fail = useCallback(
    (found: TaskProblem, code: string | null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )
  const refuse = useCallback((code: string, shown: string | null) => fail({ kind: 'refused', code, message: code, fix: null }, shown), [fail])

  const loadExpected = useCallback(async () => {
    if (!navigator.onLine) {
      const kept = EXPECTED.get(siteId)
      setExpected(kept?.value ?? [])
      setAsOf(kept?.asOf ?? null)
      return
    }
    setExpected(null)
    const answer = await fetchExpected(api)
    if (!answer.ok) {
      const kept = EXPECTED.get(siteId)
      setExpected(kept?.value ?? [])
      setAsOf(kept?.asOf ?? null)
      if (!kept || (answer.problem.kind !== 'offline' && answer.problem.kind !== 'unavailable')) fail(answer.problem, null)
      return
    }
    EXPECTED.keep(siteId, answer.value.orders)
    setExpected(answer.value.orders)
    setAsOf(null)
  }, [api, fail, siteId])

  const openLine = useCallback((current: OrderToReceive, now: Delivery, id: string) => {
    const line = current.lines.find((entry) => entry.id === id)
    if (!line) return
    const entry = entryOf(now, id)
    setHoldAsk(false)
    setLineId(id)
    if (line.item.tracking === 'HIDE') {
      setHideForm(formAfter(line, entry))
      setQuantityForm(null)
    } else {
      const bounds = quantityBounds(line)
      const already = line.item.tracking === 'LOT' ? null : entry.quantity
      const left = line.item.tracking === 'LOT' ? Math.max(0, num(line.open) - entry.lots.reduce((sum, lot) => sum + (lot.quantity ?? 0), 0)) : bounds.suggested
      setQuantityForm({
        quantity: already ?? (left > 0 ? Number(left.toFixed(bounds.decimals)) : null),
        supplierLotRef: null,
        hold: null,
      })
      setHideForm(null)
    }
    setStage('line')
  }, [])

  const openOrder = useCallback(
    async (orderId: string, number: string | null, ddt: string | null) => {
      if (!navigator.onLine) return fail({ kind: 'offline' }, number)
      setBusy('read')
      const answer = await fetchOrder(api, orderId)
      setBusy(null)
      if (!answer.ok) return fail(answer.problem, number)
      const current = answer.value
      if (current.refusal || !receives(current.order.status)) return refuse(receives(current.order.status) ? 'NOT_RECEIVING' : `STATUS_${current.order.status}`, current.order.number)
      const fresh = emptyDelivery(current, ddt)
      feedback('success')
      setOrder(current)
      setDelivery(fresh)
      setPosted(null)
      setRefusedSeq(null)
      postKey.current = null
      // One line: its step opens at once (design "one line opens directly").
      if (current.lines.length === 1) return openLine(current, fresh, current.lines[0]!.id)
      setStage('lines')
    },
    [api, fail, feedback, openLine, refuse],
  )

  /** A scanned or typed code on the first step: our PO number opens it; anything else is the delivery note's number. */
  const openCode = useCallback(
    async (code: string) => {
      if (!navigator.onLine) {
        const row = EXPECTED.get(siteId)?.value.find((entry) => codeKey(entry.number) === codeKey(code))
        return fail({ kind: 'offline' }, row?.number ?? code)
      }
      const answer = await fetchExpected(api, code)
      if (!answer.ok) return fail(answer.problem, code)
      const row = answer.value.orders[0]
      if (row) return openOrder(row.id, row.number, ddtCode)
      const found = answer.value.found
      if (found) return refuse(receives(found.status) ? 'NOT_RECEIVING' : `STATUS_${found.status}`, found.number)
      feedback('warning')
      setDdtCode(code.trim())
    },
    [api, ddtCode, fail, feedback, openOrder, refuse, siteId],
  )

  const refreshReceipt = useCallback(
    async (receiptId: string) => {
      const answer = await fetchReceipt(api, receiptId)
      if (answer.ok) setPosted((current) => (current && current.receipt.id === receiptId ? { ...current, receipt: answer.value } : current))
    },
    [api],
  )

  const post = useCallback(async () => {
    if (!order || !delivery || busy) return
    if (!navigator.onLine) return void feedback('warning')
    const summary = deliverySummary(order, delivery)
    if (summary.lines.length === 0 || summary.needReason.length > 0) return void feedback('warning')
    const body = receiveBody(order, delivery, {
      printerId: order.printer?.id ?? null,
      language: locale === 'en' ? 'en' : 'it',
    })
    const text = JSON.stringify(body)
    if (postKey.current?.body !== text) postKey.current = { body: text, key: newIdempotencyKey() }
    setBusy('post')
    setRefusedSeq(null)
    const answer = await postReceipt(api, order.order.id, body, postKey.current.key)
    setBusy(null)
    if (answer.ok) {
      feedback('success')
      setPosted({ receipt: answer.value.receipt, notes: answer.value.notes })
      setSelectedHideId(answer.value.receipt.hides[0]?.id ?? null)
      setReprintAsk(false)
      setStage('done')
      return
    }
    const failed = answer.problem
    if (failed.kind === 'over') {
      feedback('warning')
      const first = lineIdAtBodyIndex(order, delivery, failed.lines[0] ?? -1)
      setRefusedSeq(order.lines.find((line) => line.id === first)?.seq ?? null)
      return
    }
    const found = failed.problem
    if (found.kind === 'conflict' || found.kind === 'refused') {
      // Read the order again: cancelled or closed meanwhile (its state's words), else it changed (its new version).
      const again = await fetchOrder(api, order.order.id)
      if (again.ok) {
        if (again.value.refusal || !receives(again.value.order.status)) {
          setOrder(again.value)
          return refuse(receives(again.value.order.status) ? 'NOT_RECEIVING' : `STATUS_${again.value.order.status}`, again.value.order.number)
        }
        if (again.value.order.version !== delivery.version) {
          setOrder(again.value)
          setDelivery({ ...delivery, version: again.value.order.version })
          return refuse('ORDER_CHANGED', again.value.order.number)
        }
      }
      return fail(found, order.order.number)
    }
    if (found.kind === 'invalid' && failed.lineIndex !== null) {
      const id = lineIdAtBodyIndex(order, delivery, failed.lineIndex)
      setRefusedSeq(order.lines.find((line) => line.id === id)?.seq ?? null)
      return refuse('LINE_REFUSED', order.order.number)
    }
    return fail(found, order.order.number)
  }, [api, busy, delivery, fail, feedback, locale, order, refuse])

  const reprint = useCallback(
    async (reason: ReprintReason, all: boolean) => {
      if (!posted || busy) return
      setBusy('tags')
      const answer = await printTags(api, posted.receipt.id, {
        ...(all || !selectedHideId ? {} : { hideIds: [selectedHideId] }),
        ...(posted.receipt.tags.printer ? { printerId: posted.receipt.tags.printer.id } : {}),
        language: locale === 'en' ? 'en' : 'it',
        reason,
      })
      setBusy(null)
      if (!answer.ok) return fail(answer.problem, null)
      feedback('success')
      setReprintAsk(false)
      setPosted({ ...posted, receipt: answer.value })
    },
    [api, busy, fail, feedback, locale, posted, selectedHideId],
  )

  const retry = useCallback(
    async (hideId: string) => {
      const job = posted?.receipt.tags.jobs.find((entry) => entry.hideId === hideId)
      if (!posted || !job?.jobId || job.version === null || busy) return
      setBusy('retry')
      const answer = await retryTag(api, job.jobId, job.version)
      setBusy(null)
      if (!answer.ok) return fail(answer.problem, job.code)
      feedback('success')
      await refreshReceipt(posted.receipt.id)
    },
    [api, busy, fail, feedback, posted, refreshReceipt],
  )

  const next = useCallback(() => {
    setStage('scan')
    setOrder(null)
    setDelivery(null)
    setLineId(null)
    setPosted(null)
    setDdtCode(null)
    setReprintAsk(false)
    setLeaveAsk(false)
    setRefusedSeq(null)
    postKey.current = null
    void loadExpected()
  }, [loadExpected])

  const onScan = useCallback(
    async (code: string) => {
      if (!me) return
      const read = readScan(code, me.scanTag)
      if (read.kind === 'badge') {
        const refused = await store.switchTo(read.code)
        if (refused) refuse('BADGE', null)
        return
      }
      setProblem(null)
      const text = read.code.trim()
      if (stage === 'scan') return openCode(text)
      if (stage === 'lines' && delivery) {
        feedback('success')
        return setDelivery({ ...delivery, ddtNumber: text })
      }
      if (stage === 'line' && hideForm) {
        feedback('success')
        return setHideForm({
          ...hideForm,
          [hideForm.text]: text,
          text: 'supplierCode',
        })
      }
      if (stage === 'line' && quantityForm && order?.lines.find((line) => line.id === lineId)?.item.tracking === 'LOT') {
        feedback('success')
        return setQuantityForm({ ...quantityForm, supplierLotRef: text })
      }
      if (stage === 'done' && posted) {
        const hideId = hideOfCode(posted.receipt, text)
        feedback(hideId ? 'success' : 'warning')
        if (hideId) setSelectedHideId(hideId)
        return
      }
      feedback('warning')
    },
    [delivery, feedback, hideForm, lineId, me, openCode, order, posted, quantityForm, refuse, stage, store],
  )

  const saveHide = () => {
    if (!order || !delivery || !hideForm || !lineId || hideProblem(hideForm)) return void feedback('warning')
    const line = order.lines.find((entry) => entry.id === lineId)
    if (!line) return
    feedback('success')
    setDelivery(addHide(delivery, line, hideForm))
    setHideForm(nextHideForm(hideForm))
    setHoldAsk(false)
  }

  const saveQuantity = () => {
    if (!order || !delivery || !quantityForm || !lineId) return
    const line = order.lines.find((entry) => entry.id === lineId)
    if (!line || quantityForm.quantity === null || !(quantityForm.quantity > 0)) return void feedback('warning')
    feedback('success')
    setDelivery(line.item.tracking === 'LOT' ? addLot(delivery, lineId, quantityForm) : setQuantity(delivery, lineId, quantityForm.quantity))
    setHoldAsk(false)
    setStage('lines')
  }

  const hasEntries = Boolean(order && delivery && order.lines.some((line) => entered(delivery.entries[line.id])))

  // A code handed from Home opens its order; else what the site expects.
  useEffect(() => {
    if (started.current || !me || !may) return
    started.current = true
    const code = store.takeScan()
    void loadExpected()
    if (code) void openCode(code)
  }, [loadExpected, may, me, openCode, store])

  // Back online on the first step: what is expected is read again (it was this tablet's copy).
  useEffect(() => {
    if (!online || !asOf || !may || stage !== 'scan') return
    void loadExpected()
    // Only the network coming back reads again.
  }, [online])

  // The tags on their way to the printer: the receipt is read again every few seconds until they are done.
  const receiptId = posted?.receipt.id ?? null
  const pending = posted ? tagsPending(posted.receipt) : false
  useEffect(() => {
    if (stage !== 'done' || !receiptId || !pending) return
    let tries = 0
    const timer = window.setInterval(() => {
      tries += 1
      if (tries > POLL_TRIES) return window.clearInterval(timer)
      void refreshReceipt(receiptId)
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [pending, receiptId, refreshReceipt, stage])

  const onAction = (action: ReceiveAction) => {
    switch (action.type) {
      case 'scan':
        return void onScan(action.code)
      case 'open':
        setProblem(null)
        return void openOrder(action.orderId, expected?.find((row) => row.id === action.orderId)?.number ?? null, ddtCode)
      case 'clearDdt':
        return setDdtCode(null)
      case 'line':
        if (order && delivery) openLine(order, delivery, action.lineId)
        return
      case 'lines':
        setHoldAsk(false)
        return setStage('lines')
      case 'area':
        return setHideForm((form) => (form ? { ...form, area: action.value } : form))
      case 'thickness':
        return setHideForm((form) => (form ? { ...form, thicknessMm: action.value } : form))
      case 'pad':
        return setHideForm((form) => (form ? { ...form, pad: action.pad } : form))
      case 'text':
        return setHideForm((form) => (form ? { ...form, text: action.target } : form))
      case 'grade':
        return setHideForm((form) =>
          form
            ? {
                ...form,
                grade: form.grade === action.grade ? null : action.grade,
              }
            : form,
        )
      case 'defect':
        return setHideForm((form) =>
          form
            ? {
                ...form,
                defects: form.defects.includes(action.code) ? form.defects.filter((code) => code !== action.code) : [...form.defects, action.code],
              }
            : form,
        )
      case 'holdAsk':
        return setHoldAsk((open) => !open)
      case 'hold':
        setHoldAsk(false)
        if (hideForm) return setHideForm({ ...hideForm, hold: action.hold })
        return setQuantityForm((form) => (form ? { ...form, hold: action.hold } : form))
      case 'saveHide':
        return saveHide()
      case 'undoHide':
        if (!delivery || !lineId || !order) return
        {
          const after = undoHide(delivery, lineId)
          const line = order.lines.find((entry) => entry.id === lineId)
          setDelivery(after)
          if (line && hideForm)
            setHideForm({
              ...formAfter(line, entryOf(after, lineId)),
              area: hideForm.area,
            })
        }
        return
      case 'quantity':
        return setQuantityForm((form) => (form ? { ...form, quantity: action.value } : form))
      case 'saveQuantity':
        return saveQuantity()
      case 'undoLot':
        if (delivery && lineId) setDelivery(undoLot(delivery, lineId))
        return
      case 'finish':
        if (!hasEntries || order?.refusal) return void feedback('warning')
        return setStage('finish')
      case 'over':
        if (delivery) setDelivery(setOver(delivery, action.lineId, action.over))
        return
      case 'post':
        return void post()
      case 'tag':
        setReprintAsk(false)
        return setSelectedHideId(action.hideId)
      case 'retryTag':
        return void retry(action.hideId)
      case 'reprintAsk':
        return setReprintAsk((open) => !open)
      case 'reprint':
        return void reprint(action.reason, false)
      case 'printAll':
        return void reprint('NOT_PRINTED', true)
      case 'next':
        return next()
      case 'leave':
        if (hasEntries) return setLeaveAsk(true)
        return next()
      case 'leaveConfirm':
        return next()
      case 'leaveCancel':
        return setLeaveAsk(false)
      case 'back':
        return setStage(order ? 'lines' : 'scan')
      case 'dismiss':
        return setProblem(null)
      case 'retry':
        setProblem(null)
        if (order && stage !== 'scan') return void openOrder(order.order.id, order.order.number, delivery?.ddtNumber ?? null)
        return void loadExpected()
    }
  }

  const tracking = order?.lines.find((line) => line.id === lineId)?.item.tracking
  // A refusal of the order itself (cancelled, received, closed …): the way on is the next delivery.
  const closedProblem = problem?.problem.kind === 'refused' && (problem.problem.code.startsWith('STATUS_') || problem.problem.code === 'NOT_RECEIVING')
  const onProblem = closedProblem ? next : () => onAction({ type: 'dismiss' })
  useFloorKeys({
    enter: problem
      ? onProblem
      : leaveAsk
        ? null
        : stage === 'line'
          ? tracking === 'HIDE'
            ? saveHide
            : saveQuantity
          : stage === 'lines'
            ? () => onAction({ type: 'finish' })
            : stage === 'finish'
              ? () => void post()
              : stage === 'done'
                ? next
                : null,
    escape: problem
      ? onProblem
      : leaveAsk
        ? () => setLeaveAsk(false)
        : stage === 'line' || stage === 'finish'
          ? () => onAction({ type: 'lines' })
          : stage === 'lines'
            ? () => onAction({ type: 'leave' })
            : stage === 'done'
              ? next
              : () => router.push('/floor'),
  })

  if (!me) return null
  return (
    <ReceiveView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        stage: may ? stage : 'noPermission',
        expected,
        asOf,
        ddtCode,
        order,
        delivery,
        lineId,
        hideForm,
        quantityForm,
        holdAsk,
        leaveAsk,
        busy,
        posted,
        selectedHideId,
        reprintAsk,
        problem,
        refusedSeq,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
