'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useConfirmFeedback } from '@nexus/ui/floor'
import { newIdempotencyKey } from '../../../lib/api/client'
import { readFromStore } from '../../../record-panels/store'
import { zxingCamera } from '../../camera'
import { useFloor } from '../../FloorApp'
import { useFloorKeys } from '../../keys'
import { readScan } from '../../scan/scan-model'
import type { TaskProblem } from '../shared/task-api'
import { ddtPdfLink, fetchKit, fetchKits, fetchRejectReasons, receiveBack, sendKit, type KitMode, type KitOrder, type KitRow, type RejectReason } from './api'
import {
  backHeld,
  bringBack,
  ddtHeld,
  dropBack,
  emptyBack,
  emptyDdt,
  emptyKit,
  kitHeld,
  receiveBody,
  rejectBack,
  scanBack,
  scanKit,
  sendBody,
  setReturn,
  toggleBundle,
  toggleLine,
  outOf,
  type BackDraft,
  type DdtDraft,
  type KitDraft,
  type KitsStage,
  type RejectKind,
} from './model'
import { KitsView, type KitsAction } from './view/KitsView'

/**
 * The live SCR-181 (`/floor/kits`): Send a kit or Receive back; the site's orders for it (or the one a scanned number names);
 * the kit ticked by scans or taps, the DDT's facts, ONE send with its Idempotency-Key (kept while the body is the same), then
 * the DDT's PDF read once from the store for the viewer and Print; or the bundles scanned back, rejections with their reason,
 * the material back, ONE receipt. Online only for the send and the receipt; the order is read again when the screen comes
 * back (the office may have changed it: no floor event for subcontract orders yet).
 */

const SEND_STATUSES = new Set(['ISSUED', 'AT_WORKSHOP', 'PARTLY_RECEIVED'])
const RECEIVE_STATUSES = new Set(['AT_WORKSHOP', 'PARTLY_RECEIVED'])

export function FloorKits() {
  const store = useFloor()
  const router = useRouter()
  const feedback = useConfirmFeedback()
  const { frame, onFrame } = store.frame('tile.kits', { showHome: true })
  const { me, api, online, sessionEnded } = store
  const may = { send: Boolean(me?.permissions.includes('purchasing.subcontract.kit')), receive: Boolean(me?.permissions.includes('purchasing.subcontract.receive')) }

  const [stage, setStage] = useState<KitsStage>('mode')
  const [mode, setMode] = useState<KitMode | null>(null)
  const [orders, setOrders] = useState<KitRow[] | null>(null)
  const [order, setOrder] = useState<KitOrder | null>(null)
  const [kit, setKit] = useState<KitDraft>(emptyKit())
  const [ddt, setDdt] = useState<DdtDraft>(emptyDdt())
  const [sent, setSent] = useState<{ number: string; pdf: Uint8Array | 'loading' | 'missing' | 'failed' } | null>(null)
  const [back, setBack] = useState<BackDraft>(emptyBack())
  const [reject, setReject] = useState<{ bundleId: string; kind: RejectKind; count: number | null; reason: string | null } | null>(null)
  const [material, setMaterial] = useState<{ lineId: string; quantity: number | null; toLocationId: string | null } | null>(null)
  const [reasons, setReasons] = useState<RejectReason[] | null>(null)
  const [received, setReceived] = useState<{ good: number; defective: number; scrapped: number; returned: number } | null>(null)
  const [busy, setBusy] = useState<'read' | 'send' | 'receive' | null>(null)
  const [problem, setProblem] = useState<{ problem: TaskProblem; code: string | null } | null>(null)
  const started = useRef(false)
  const writeKey = useRef<{ body: string; key: string } | null>(null)

  const fail = useCallback(
    (found: TaskProblem, code: string | null) => {
      if (found.kind === 'signedOut') return void sessionEnded()
      feedback(found.kind === 'offline' || found.kind === 'unavailable' ? 'warning' : 'error')
      setProblem({ problem: found, code })
    },
    [feedback, sessionEnded],
  )
  const refuse = useCallback((code: string, shown: string | null) => fail({ kind: 'refused', code, message: code, fix: null }, shown), [fail])

  const clearOrder = useCallback(() => {
    setOrder(null)
    setKit(emptyKit())
    setDdt(emptyDdt())
    setSent(null)
    setBack(emptyBack())
    setReject(null)
    setMaterial(null)
    setReceived(null)
    writeKey.current = null
  }, [])

  const loadOrders = useCallback(
    async (which: KitMode) => {
      setOrders(null)
      if (!navigator.onLine) return setOrders([])
      const answer = await fetchKits(api, which)
      if (!answer.ok) {
        setOrders([])
        return fail(answer.problem, null)
      }
      setOrders(answer.value.orders)
    },
    [api, fail],
  )

  const pickMode = useCallback(
    (which: KitMode) => {
      if ((which === 'send' && !may.send) || (which === 'receive' && !may.receive)) return void feedback('warning')
      clearOrder()
      setMode(which)
      setStage('pick')
      void loadOrders(which)
      if (which === 'receive' && reasons === null) void fetchRejectReasons(api).then((answer) => setReasons(answer.ok ? answer.value : []))
    },
    [api, clearOrder, feedback, loadOrders, may.receive, may.send, reasons],
  )

  const openOrder = useCallback(
    async (orderId: string, shown: string | null, which: KitMode) => {
      if (!navigator.onLine) return fail({ kind: 'offline' }, shown)
      setBusy('read')
      const answer = await fetchKit(api, orderId)
      setBusy(null)
      if (!answer.ok) return answer.problem.kind === 'notFound' ? refuse('NOT_FOUND', shown) : fail(answer.problem, shown)
      const value = answer.value
      if (which === 'send' && !SEND_STATUSES.has(value.status)) return refuse('NOT_SENDING', value.number)
      if (which === 'receive' && !RECEIVE_STATUSES.has(value.status)) return refuse('NOT_RECEIVING', value.number)
      feedback('success')
      clearOrder()
      setOrder(value)
      setStage(which === 'send' ? 'kit' : 'back')
    },
    [api, clearOrder, fail, feedback, refuse],
  )

  /** A scanned or typed subcontract order number on the pick step (any of this site's orders: its state is said in words). */
  const openCode = useCallback(
    async (code: string, which: KitMode) => {
      if (!navigator.onLine) return fail({ kind: 'offline' }, code)
      const answer = await fetchKits(api, which, code)
      if (!answer.ok) return fail(answer.problem, code)
      const found = answer.value.found
      if (!found) return refuse('NOT_FOUND', code)
      return openOrder(found.id, found.number, which)
    },
    [api, fail, openOrder, refuse],
  )

  const reread = useCallback(async () => {
    if (!order || !navigator.onLine) return
    const answer = await fetchKit(api, order.id)
    if (answer.ok) setOrder(answer.value)
  }, [api, order])

  const loadPdf = useCallback(
    async (orderId: string, ddtId: string, number: string) => {
      setSent({ number, pdf: 'loading' })
      const link = await ddtPdfLink(api, orderId, ddtId)
      if (!link.ok) return setSent({ number, pdf: link.problem.kind === 'notFound' ? 'missing' : 'failed' })
      try {
        setSent({ number, pdf: await readFromStore(link.value) })
      } catch {
        setSent({ number, pdf: 'failed' })
      }
    },
    [api],
  )

  const doSend = useCallback(async () => {
    if (!order || busy) return
    if (!navigator.onLine || kitHeld(order, kit) || ddtHeld(ddt)) return void feedback('warning')
    const body = sendBody(order, kit, ddt)
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    setBusy('send')
    const answer = await sendKit(api, order.id, body, writeKey.current.key)
    setBusy(null)
    if (!answer.ok) {
      if (answer.problem.kind === 'conflict') {
        await reread()
        setStage('kit')
        return refuse('CHANGED', order.number)
      }
      return fail(answer.problem, order.number)
    }
    feedback('success')
    writeKey.current = null
    setOrder(answer.value.order)
    setStage('sent')
    if (answer.value.ddt) {
      if (answer.value.ddt.pdf) void loadPdf(order.id, answer.value.ddt.id, answer.value.ddt.number)
      else setSent({ number: answer.value.ddt.number, pdf: 'missing' })
    }
  }, [api, busy, ddt, fail, feedback, kit, loadPdf, order, refuse, reread])

  const doReceive = useCallback(async () => {
    if (!order || busy) return
    if (!navigator.onLine || backHeld(order, back, (reasons?.length ?? 0) > 0)) return void feedback('warning')
    const body = receiveBody(order, back)
    const text = JSON.stringify(body)
    if (writeKey.current?.body !== text) writeKey.current = { body: text, key: newIdempotencyKey() }
    setBusy('receive')
    const answer = await receiveBack(api, order.id, body, writeKey.current.key)
    setBusy(null)
    if (!answer.ok) {
      if (answer.problem.kind === 'conflict') {
        await reread()
        return refuse('CHANGED', order.number)
      }
      return fail(answer.problem, order.number)
    }
    feedback('success')
    writeKey.current = null
    setOrder(answer.value.order)
    setBack(emptyBack())
    setReceived({ good: answer.value.receipt.good, defective: answer.value.receipt.defective, scrapped: answer.value.receipt.scrapped, returned: answer.value.receipt.returned })
    setStage('received')
  }, [api, back, busy, fail, feedback, order, reasons, refuse, reread])

  /** Prints the DDT: the PDF's bytes in a hidden frame and the browser's print (the viewer has no print of its own). */
  const print = useCallback(() => {
    if (!sent || !(sent.pdf instanceof Uint8Array)) return void feedback('warning')
    const url = URL.createObjectURL(new Blob([sent.pdf as BlobPart], { type: 'application/pdf' }))
    const frameEl = document.createElement('iframe')
    frameEl.style.position = 'fixed'
    frameEl.style.width = '0'
    frameEl.style.height = '0'
    frameEl.style.border = '0'
    frameEl.src = url
    frameEl.onload = () => {
      try {
        frameEl.contentWindow?.print()
      } catch {
        window.open(url, '_blank', 'noopener')
      }
      window.setTimeout(() => {
        frameEl.remove()
        URL.revokeObjectURL(url)
      }, 60_000)
    }
    document.body.appendChild(frameEl)
  }, [feedback, sent])

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
      if (stage === 'pick' && mode) return openCode(text, mode)
      if (stage === 'kit' && order) {
        const match = scanKit(order, text)
        if (match.kind === 'bundle') {
          feedback('success')
          return setKit((before) => (before.bundles.includes(match.bundleId) ? before : toggleBundle(before, match.bundleId)))
        }
        if (match.kind === 'line') {
          const line = order.kitLines.find((entry) => entry.id === match.lineId)!
          feedback('success')
          return setKit((before) => toggleLine(before, line, match.source))
        }
        return refuse(match.kind === 'sentBefore' ? 'SENT_BEFORE' : 'NOT_IN_KIT', text)
      }
      if (stage === 'back' && order && !reject && !material) {
        const match = scanBack(order, back, text)
        if (match.kind === 'bundle') {
          feedback('success')
          return setBack((before) => bringBack(order, before, match.bundleId))
        }
        if (match.kind === 'none') {
          // A code that is no bundle of the order: the workshop's delivery note number, kept for the receipt.
          feedback('success')
          return setBack((before) => ({ ...before, ddtNumber: text.slice(0, 40) }))
        }
        return refuse(match.kind === 'notOut' ? 'NOT_OUT' : 'ALL_BACK', match.code)
      }
      feedback('warning')
    },
    [back, feedback, material, me, mode, openCode, order, refuse, reject, stage, store],
  )

  // The task opens on its two tiles; one tile only: that mode at once. A code handed from Home is a subcontract order number.
  useEffect(() => {
    if (started.current || !me || (!may.send && !may.receive)) return
    started.current = true
    const code = store.takeScan()
    const only: KitMode | null = may.send && !may.receive ? 'send' : may.receive && !may.send ? 'receive' : null
    if (only) pickMode(only)
    if (code) void openCode(code, only ?? 'send')
  }, [may.receive, may.send, me, openCode, pickMode, store])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (stage === 'kit' || stage === 'back')) void reread()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [reread, stage])

  const next = () => {
    clearOrder()
    setProblem(null)
    if (mode) {
      setStage('pick')
      void loadOrders(mode)
    } else setStage('mode')
  }

  const onAction = (action: KitsAction) => {
    switch (action.type) {
      case 'mode':
        return pickMode(action.mode)
      case 'modes':
        clearOrder()
        setMode(null)
        return setStage('mode')
      case 'scan':
        return void onScan(action.code)
      case 'open':
        if (mode) void openOrder(action.orderId, orders?.find((row) => row.id === action.orderId)?.number ?? null, mode)
        return
      case 'line': {
        const line = order?.kitLines.find((entry) => entry.id === action.lineId)
        if (!line || line.sources.length === 0) return void feedback('warning')
        feedback('success')
        return setKit((before) => toggleLine(before, line))
      }
      case 'bundle':
        feedback('success')
        return setKit((before) => toggleBundle(before, action.bundleId))
      case 'toDdt':
        if (!order || kitHeld(order, kit)) return void feedback('warning')
        return setStage('ddt')
      case 'toKit':
        return setStage('kit')
      case 'transport':
        return setDdt((before) => ({ ...before, transportBy: action.by }))
      case 'packages':
        return setDdt((before) => ({ ...before, packages: Math.max(1, action.value ?? 1) }))
      case 'weight':
        return setDdt((before) => ({ ...before, grossWeightKg: action.value }))
      case 'appearance':
        return setDdt((before) => ({ ...before, appearance: action.appearance }))
      case 'send':
        return void doSend()
      case 'print':
        return print()
      case 'openReject': {
        const bundle = order?.bundles.find((entry) => entry.id === action.bundleId)
        if (!order || !bundle) return
        const entry = back.entries[bundle.id]
        if (!entry && outOf(order, bundle) === 0) return void feedback('warning')
        setMaterial(null)
        return setReject({ bundleId: bundle.id, kind: entry && entry.scrapped > 0 ? 'scrapped' : 'defective', count: entry ? entry.defective + entry.scrapped : null, reason: entry?.reason ?? null })
      }
      case 'rejectKind':
        return setReject((before) => (before ? { ...before, kind: action.kind } : before))
      case 'rejectCount':
        return setReject((before) => (before ? { ...before, count: action.value } : before))
      case 'rejectReason':
        return setReject((before) => (before ? { ...before, reason: action.reason } : before))
      case 'confirmReject': {
        if (!order || !reject || reject.count === null) return void feedback('warning')
        if (reject.count > 0 && (reasons?.length ?? 0) > 0 && !reject.reason) return void feedback('warning')
        feedback('success')
        setBack((before) => rejectBack(order, before, reject.bundleId, reject.count ?? 0, reject.kind, reject.reason))
        return setReject(null)
      }
      case 'dropBundle':
        feedback('success')
        setBack((before) => dropBack(before, action.bundleId))
        return setReject(null)
      case 'openMaterial': {
        const line = order?.kitLines.find((entry) => entry.id === action.lineId)
        if (!line) return
        setReject(null)
        const now = back.returns[line.id]
        return setMaterial({ lineId: line.id, quantity: now?.quantity ?? null, toLocationId: now?.toLocationId ?? line.from?.id ?? null })
      }
      case 'materialQuantity':
        return setMaterial((before) => (before ? { ...before, quantity: action.value } : before))
      case 'materialPlace':
        return setMaterial((before) => (before ? { ...before, toLocationId: action.locationId } : before))
      case 'confirmMaterial': {
        const line = order?.kitLines.find((entry) => entry.id === material?.lineId)
        if (!line || !material?.toLocationId) return void feedback('warning')
        feedback('success')
        setBack((before) => setReturn(before, line, material.quantity, material.toLocationId))
        return setMaterial(null)
      }
      case 'closePanel':
        setReject(null)
        return setMaterial(null)
      case 'clearDdt':
        return setBack((before) => ({ ...before, ddtNumber: null }))
      case 'receive':
        return void doReceive()
      case 'next':
        return next()
      case 'dismiss':
        return setProblem(null)
      case 'retry':
        setProblem(null)
        if (order) return void reread()
        if (mode) return void loadOrders(mode)
        return
    }
  }

  const panelOpen = Boolean(reject || material)
  useFloorKeys({
    enter: problem
      ? () => setProblem(null)
      : stage === 'kit'
        ? () => onAction({ type: 'toDdt' })
        : stage === 'ddt'
          ? () => onAction({ type: 'send' })
          : stage === 'back'
            ? panelOpen
              ? () => onAction({ type: reject ? 'confirmReject' : 'confirmMaterial' })
              : () => onAction({ type: 'receive' })
            : stage === 'sent' || stage === 'received'
              ? next
              : null,
    escape: problem
      ? () => setProblem(null)
      : panelOpen
        ? () => onAction({ type: 'closePanel' })
        : stage === 'ddt'
          ? () => setStage('kit')
          : stage === 'kit' || stage === 'back' || stage === 'sent' || stage === 'received'
            ? next
            : stage === 'pick'
              ? () => onAction({ type: 'modes' })
              : () => router.push('/floor'),
  })

  if (!me) return null
  const noPermission = !may.send && !may.receive
  return (
    <KitsView
      model={{
        frame,
        online,
        held: me.notice.blocksScans,
        stage: noPermission ? 'noPermission' : stage,
        may,
        mode,
        orders,
        order,
        kit,
        ddt,
        sent,
        back,
        reject,
        material,
        reasons,
        received,
        busy,
        problem,
      }}
      onFrame={onFrame}
      onAction={onAction}
      camera={zxingCamera}
    />
  )
}
