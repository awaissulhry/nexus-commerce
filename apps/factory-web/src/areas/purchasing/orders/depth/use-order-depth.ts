'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isApiError } from '../../../../lib/api/errors'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { isStepUpCancelled, useStepUp } from '../../../admin/shared/step-up'
import { part, PART_LOADING, phrase, readProblem, writeProblem, type Part, type Phrase } from '../../../_shared/buying/model'
import type { PurchaseOrder } from '../api'
import {
  askOverride,
  clearSchedule,
  decideOverride,
  duplicateOrder,
  getApproval,
  getClosures,
  getCompliance,
  getDemand,
  getDepth,
  getLineKinds,
  putLineKind,
  putRate,
  putSchedule,
  recordSupplierDate,
  withdrawApproval,
  withdrawOverride,
  type Compliance,
  type LineKinds,
  type OrderApproval,
  type OrderDemand,
  type OrderDepth,
  type SupplierClosures,
  OVERRIDE_REASON,
} from './api'
import { depthCanOf, kindBody, scheduleBody, supplierDateBody, typedDecimal, type DepthDialog, type OrderDepthActions, type OrderDepthModel } from './model'
import { useChase } from './use-chase'

/**
 * The container of the PO studio's depth parts (B-W2b-333): reads the order in depth, its lines by kind, the compliance
 * gate, the demand of each line and the send's approval whenever the order (or its version) changes — every write bumps
 * it — and the supplier's closures on the Delivery schedule tab (parties.view); runs each write with the order's version
 * and one Idempotency-Key per dialog (a retry of the same dialog is the same request), a 409 reads again; the decider's yes
 * asks a fresh authenticator code (the API's 403 `stepUp`). After a write the page reads the order again (`onChanged`).
 */
export function useOrderDepth(input: { api: ApiClient; orderId: string; order: PurchaseOrder | null; permissions: readonly string[]; prefix: string; tab: string; today: string; onChanged: () => void; onNotice: (words: Phrase) => void }) {
  const { api, orderId, order, permissions, prefix, tab, today, onChanged, onNotice } = input
  const router = useRouter()
  const can = useMemo(() => depthCanOf(permissions), [permissions])
  const [depth, setDepth] = useState<Part<OrderDepth>>(PART_LOADING)
  const [kinds, setKinds] = useState<Part<LineKinds>>(PART_LOADING)
  const [compliance, setCompliance] = useState<Part<Compliance>>(PART_LOADING)
  const [demand, setDemand] = useState<Part<OrderDemand>>(PART_LOADING)
  const [approval, setApproval] = useState<Part<OrderApproval>>(PART_LOADING)
  const [closures, setClosures] = useState<Part<SupplierClosures> | null>(can.parties ? PART_LOADING : null)
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [busy, setBusy] = useState(false)
  const [month, setMonth] = useState<string | undefined>(undefined)
  const key = useRef(newIdempotencyKey())
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const read = useCallback(() => {
    const keep = <T,>(set: (value: Part<T>) => void) => [(value: T) => set(part(value)), (error: unknown) => set({ value: null, problem: readProblem(error) })] as const
    void getDepth(api, orderId).then(...keep(setDepth))
    void getLineKinds(api, orderId).then(...keep(setKinds))
    void getCompliance(api, orderId).then(...keep(setCompliance))
    void getDemand(api, orderId).then(...keep(setDemand))
    void getApproval(api, orderId).then(...keep(setApproval))
  }, [api, orderId])

  // Every write bumps the order's version: the depth parts follow it (and a live change read by the page).
  const version = order?.version ?? null
  useEffect(() => {
    if (version !== null) read()
  }, [read, version, order?.status])

  const partyId = order?.partyId ?? null
  useEffect(() => {
    if (!can.parties || !partyId || tab !== 'schedule') return
    getClosures(api, partyId)
      .then((value) => setClosures(part(value)))
      .catch((error: unknown) => setClosures({ value: null, problem: readProblem(error) }))
  }, [api, can.parties, partyId, tab])

  const dialogRef = useRef<DepthDialog | null>(null)
  dialogRef.current = dialog
  const openDialog = useCallback((next: DepthDialog | null) => {
    if (next && (!dialogRef.current || dialogRef.current.kind !== next.kind)) key.current = newIdempotencyKey()
    setProblem(null)
    setDialog(next)
  }, [])

  /** One write: the dialog closes, the notice says it, the page reads the order again (its version moved). */
  const write = useCallback(
    async (run: () => Promise<unknown>, success: Phrase, pathWords?: Parameters<typeof writeProblem>[1], movesNoVersion = false) => {
      if (busy) return false
      setBusy(true)
      setProblem(null)
      try {
        await run()
        setDialog(null)
        onNotice(success)
        // The order is read again; its new version re-reads the parts. An override's request or decision moves no version.
        onChanged()
        if (movesNoVersion) read()
        return true
      } catch (error) {
        if (isStepUpCancelled(error)) return false
        setProblem(writeProblem(error, pathWords))
        if (isApiError(error) && error.kind === 'conflict') {
          onChanged()
          read()
        }
        key.current = newIdempotencyKey()
        return false
      } finally {
        setBusy(false)
      }
    },
    [busy, onChanged, onNotice, read],
  )

  const v = () => order?.version ?? 1
  const words: Parameters<typeof writeProblem>[1] = (paths, info) => {
    if (paths.some((path) => path.includes('deliveries') && path.includes('needDate'))) return phrase(`${DEPTH_PREFIX}schedule.refused.day`)
    if (paths.some((path) => path.includes('deliveries'))) return phrase(`${DEPTH_PREFIX}schedule.refused.sum`)
    if (paths.some((path) => path.includes('reason'))) return dialogRef.current?.kind === 'override' ? phrase(`${DEPTH_PREFIX}override.held.reason`, { count: OVERRIDE_REASON.min }) : phrase(`${DEPTH_PREFIX}date.held.reason`)
    if (paths.some((path) => path.includes('rateAtOrder'))) return phrase(`${DEPTH_PREFIX}rate.held.bad`)
    if (paths.some((path) => path.includes('rolls'))) return phrase(`${DEPTH_PREFIX}kind.refused.rolls`)
    if (paths.some((path) => path.includes('certificateId'))) return phrase(`${DEPTH_PREFIX}kind.refused.certificate`)
    if (paths.some((path) => path.includes('variantCode'))) return phrase(`${DEPTH_PREFIX}kind.refused.variant`)
    if (paths.some((path) => path.includes('lineIds'))) return phrase(`${DEPTH_PREFIX}duplicate.refused.lines`)
    if (paths.some((path) => path.includes('needDate'))) return phrase(`${DEPTH_PREFIX}duplicate.held.past`)
    if (paths.some((path) => path.includes('words'))) return phrase(`${DEPTH_PREFIX}decide.held.words`)
    if (info.code === 'refusal/OWN_REQUEST') return phrase(`${DEPTH_PREFIX}decide.held.own`)
    if (info.code === 'refusal/STALE') return phrase(`${DEPTH_PREFIX}decide.held.stale`)
    if (info.kind === 'conflict') return phrase(`${DEPTH_PREFIX}refused.changed`)
    return null
  }

  const actions: OrderDepthActions = {
    onDialog: openDialog,
    onRetry: read,
    onMonth: setMonth,
    onSaveSchedule: () => {
      if (dialog?.kind !== 'schedule') return
      const { lineId, rows } = dialog
      void write(() => putSchedule(api, orderId, lineId, { version: v(), deliveries: scheduleBody(rows) }, key.current), phrase(`${DEPTH_PREFIX}notice.scheduled`, { count: rows.length }), words)
    },
    onClearSchedule: () => {
      if (dialog?.kind !== 'clearSchedule') return
      const { lineId } = dialog
      void write(() => clearSchedule(api, orderId, lineId, v(), key.current), phrase(`${DEPTH_PREFIX}notice.cleared`), words)
    },
    onSupplierDate: () => {
      if (dialog?.kind !== 'supplierDate') return
      const draft = dialog.draft
      void write(() => recordSupplierDate(api, orderId, draft.lineId, supplierDateBody(draft, v()), key.current), phrase(draft.mode === 'FIRST' ? `${DEPTH_PREFIX}notice.dateFirst` : `${DEPTH_PREFIX}notice.dateMoved`), words)
    },
    onRate: () => {
      if (dialog?.kind !== 'rate') return
      const rate = dialog.rate.trim() ? typedDecimal(dialog.rate) : null
      void write(() => putRate(api, orderId, v(), rate, key.current), phrase(`${DEPTH_PREFIX}notice.rate`), words)
    },
    onLineKind: () => {
      if (dialog?.kind !== 'lineKind' || !kinds.value) return
      const line = kinds.value.lines.find((entry) => entry.id === dialog.draft.lineId)
      if (!line) return
      const body = kindBody(line, dialog.draft, v())
      if (Object.keys(body).length === 1) {
        setDialog(null)
        return
      }
      void write(() => putLineKind(api, orderId, line.id, body, key.current), phrase(`${DEPTH_PREFIX}notice.kind`, { seq: line.seq }), words)
    },
    onAskOverride: () => {
      if (dialog?.kind !== 'override') return
      const reason = dialog.reason.trim()
      void write(() => askOverride(api, orderId, { version: v(), reason }, key.current), phrase(`${DEPTH_PREFIX}notice.overrideAsked`), words, true)
    },
    onDecide: () => {
      if (dialog?.kind !== 'decide') return
      const { decision } = dialog
      const text = dialog.words.trim() || null
      const run = () => decideOverride(api, orderId, { decision, ...(text ? { words: text } : {}) }, key.current)
      void write(() => (decision === 'APPROVED' ? guard(`${DEPTH_PREFIX}stepUp.decide`, run) : run()), phrase(decision === 'APPROVED' ? `${DEPTH_PREFIX}notice.overrideApproved` : `${DEPTH_PREFIX}notice.overrideRejected`), words, true)
    },
    onWithdrawOverride: () => void write(() => withdrawOverride(api, orderId, key.current), phrase(`${DEPTH_PREFIX}notice.overrideWithdrawn`), words, true),
    onWithdrawApproval: () => {
      if (dialog?.kind !== 'withdrawApproval') return
      const note = dialog.note.trim() || null
      void write(() => withdrawApproval(api, orderId, { version: v(), ...(note ? { note } : {}) }, key.current), phrase(`${DEPTH_PREFIX}notice.approvalWithdrawn`), words)
    },
    onDuplicate: () => {
      if (dialog?.kind !== 'duplicate' || !order) return
      const { lineIds, needDate } = dialog.draft
      const every = order.lines.filter((line) => line.ended?.kind !== 'CANCELLED').map((line) => line.id)
      const all = every.length === lineIds.length && every.every((id) => lineIds.includes(id))
      if (busy) return
      setBusy(true)
      setProblem(null)
      duplicateOrder(api, orderId, { ...(all ? {} : { lineIds: [...lineIds] }), ...(needDate ? { needDate } : {}) }, key.current)
        .then((copy) => {
          setDialog(null)
          router.push(`${prefix}/purchasing/orders/${copy.order.id}?tab=lines&copiedFrom=${encodeURIComponent(copy.copiedFrom.number)}`)
        })
        .catch((error: unknown) => {
          setProblem(writeProblem(error, words))
          key.current = newIdempotencyKey()
        })
        .finally(() => setBusy(false))
    },
    stepUp: { onSubmit: (code) => void submitStepUp(code), onClose: cancelStepUp },
  }

  const chase = useChase({
    api,
    onSent: (to) => {
      onNotice(phrase(`${DEPTH_PREFIX}notice.chased`, { to }))
      onChanged()
    },
  })
  actions.chase = { ...chase.actions, onOpen: () => order && chase.open({ orderId: order.id, number: order.number, supplier: order.supplier.name }) }

  const model: OrderDepthModel = {
    can,
    depth,
    kinds,
    compliance,
    demand,
    approval,
    closures,
    dialog,
    problem,
    busy,
    chase: chase.model,
    stepUp: { ...stepUp, sentence: stepUp.sentence.startsWith(DEPTH_PREFIX) ? stepUp.sentence : `${DEPTH_PREFIX}stepUp.decide` },
    today,
    ...(month ? { month } : {}),
  }
  return { model, actions, reload: read }
}

/** Phrases of this step's catalogue carry its prefix where the record's buying words are the default. */
export const DEPTH_PREFIX = 'purchasing-orders-depth:'
