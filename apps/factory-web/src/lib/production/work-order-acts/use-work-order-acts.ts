'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../api/client'
import { getWorkOrder, updateWorkOrder, type WorkOrder } from '../../../areas/production/_shared/api'
import { readProblem as productionReadProblem, writeProblem as productionWriteProblem } from '../../../areas/production/_shared/model'
import { actsCanOf, fromProduction, reachesFloor, READING, versionOf, type ActsCan, type ActsRow, type InlineField, type MenuAct, type Part, type Phrase } from './model'
// ---- F-OP-114: Hold… / Lift… / Release… — the production lane's own helpers (never a copy) ----
import { newIdempotencyKey } from '../../api/client'
import { getReleaseCheck, releaseWorkOrder, type ReleaseCheck } from '../../../areas/production/_shared/api'
import type { PickerReason } from '../../../areas/_shared/reasons/api'
import { holdReasons, liftProductionHold, listProductionHolds, placeHold, placeProductionHold, type ProductionHolds } from '../../../areas/production/work-orders/daily/api'
import { dailyProblem, dailyReadProblem, type PlaceHoldInput } from '../../../areas/production/work-orders/daily/model'
import { fromWorkOrders, releaseProblemOf } from './model'
// ---- end F-OP-114
// ---- F-OP-115: Split… (the every-shift page's own hook), Close… · Reopen… (the close's own hook), Cancel… (with its cancel check) ----
import { cancelWorkOrder } from '../../../areas/production/_shared/api'
import { useSplit, type SplitActions, type SplitModel } from '../../../areas/production/work-orders/every-shift/use-split'
import { useClose, type CloseActions, type CloseModel } from '../../../areas/production/work-orders/close/use-close'
import { getWorkOrderCancelCheck, type WorkOrderCancelCheck } from './api'
// ---- end F-OP-115
// ---- F-OO-108: "Hold the whole order…" — the domain's ONE plan, the bulk place with every version read ----
import { orderHoldPlanOf, type OrderHoldPlan } from '@nexus/factory-domain/production/holds/rules'
import { placeProductionHolds } from '../../../areas/production/work-orders/daily/api'
import { orderHoldProblemOf, orderHoldWriteOf } from './model'
// ---- end F-OO-108

/** One row's in-place save: the cell that is saving, or why the last write was refused (said on the row). */
export interface RowSave {
  readonly field: InlineField | null
  readonly problem: Phrase | null
}

/** The dialog open from a row's ⋯: the work order it acts on, read afresh before anything is written. */
export interface ActsDialog {
  readonly kind: MenuAct
  readonly workOrderId: string
  readonly number: string
  /** The work order as `GET /production/work-orders/:id` answers now (its version, its note…). */
  readonly workOrder: Part<WorkOrder>
  readonly busy: boolean
  /** A refused write, said inside the dialog (what was typed stays). */
  readonly problem: Phrase | null
  // ---- F-OP-114 ----
  /** Hold…: the row's own hold right (a production hold) — the quality reasons come with quality.holds.place. */
  readonly holdRight?: boolean
  /** Lift…: the work order's plain holds (its standing one is lifted). */
  readonly holds?: Part<ProductionHolds>
  /** Release…: the release check (each condition in words), read again after a refusal. */
  readonly check?: Part<ReleaseCheck>
  // ---- end F-OP-114
  /** F-OP-115: Cancel…: what cancelling it would meet (its cut pieces refuse it in words; issued stock; at a workshop). */
  readonly cancelCheck?: Part<WorkOrderCancelCheck>
}

// ---- F-OO-108 (order overview §1.4; B-OO-005, F13, F16) ----
/**
 * "Hold the whole order…" open (the sales order's Overview): the domain's ONE plan — the work orders it holds, each with its version
 * read (the bulk place always sends them), and those it leaves out with why (a shared one: hold it on its page; one not reached:
 * counted) — and the made-to-measure units, each held on its own page (counted). One write; a refusal stays in the dialog.
 */
export interface OrderHoldDialog {
  /** The sales order's number (the notice names it). */
  readonly number: string
  readonly plan: OrderHoldPlan
  /** Its made-to-measure units (their work orders are held from their own pages): counted, said. */
  readonly units: number
  readonly busy: boolean
  readonly problem: Phrase | null
}
// ---- end F-OO-108

export interface WorkOrderActsModel {
  readonly can: ActsCan
  /** Per work order id: its in-place save. */
  readonly saves: Readonly<Record<string, RowSave>>
  /** Per work order id: when a write of this page last reached its floor (the row says "Told the floor at hh:mm"). */
  readonly toldAt: Readonly<Record<string, string>>
  readonly dialog: ActsDialog | null
  /** F-OP-114: the HOLD and PRODUCTION_HOLD reasons (read once, when Hold… first opens; null while read or not asked). */
  readonly reasons: PickerReason[] | null
  // ---- F-OP-115 ----
  /** Split…: the every-shift page's split (its preview as the person types); null: not open. */
  readonly split: SplitModel | null
  /** Close… · Reopen…: the close's own model (its check, its dialog); drawn with CloseParts. */
  readonly close: CloseModel
  // ---- end F-OP-115
  /** F-OO-108: "Hold the whole order…" while open (its plan, the write); absent / null: closed. */
  readonly holdOrder?: OrderHoldDialog | null
}

export interface WorkOrderActsActions {
  onDue?: (row: ActsRow, day: string | null) => void
  onPriority?: (row: ActsRow, priority: number) => void
  onRush?: (row: ActsRow, rush: boolean) => void
  /** A row ⋯ act: its dialog opens on the work order read afresh. */
  onAct?: (row: ActsRow, act: MenuAct) => void
  onCloseDialog?: () => void
  onRetryDialog?: () => void
  onSaveNote?: (note: string) => void
  // ---- F-OP-114 ----
  onPlaceHold?: (input: PlaceHoldInput) => void
  onLiftHold?: (input: { holdId: string; version: number; reason: string }) => void
  onRelease?: (overrideReason: string | null) => void
  // ---- end F-OP-114
  // ---- F-OP-115 ----
  onCancelWorkOrder?: (reason: string) => void
  split?: SplitActions
  close?: CloseActions
  // ---- end F-OP-115
  // ---- F-OO-108: "Hold the whole order…" — open it on the plan, place the holds (all or none, every version sent), close it ----
  onHoldOrder?: (input: { readonly number: string; readonly plan: OrderHoldPlan; readonly units: number }) => void
  onPlaceOrderHold?: (input: PlaceHoldInput) => void
  onCloseOrderHold?: () => void
  // ---- end F-OO-108
}

/** What the page says after a write (its one banner), and whether the order's production read is read again. */
export interface ActsWritten {
  readonly notice: Phrase | null
}

/**
 * F-OP-113 (10-order-page §5.2; N-5): the work-order acts of a page that is not the work order's own — the sales order's Production
 * tab. Mounted by the container (use-production-acts), never by a view. In place: Due, Priority and Rush, each one PATCH with the
 * version the row carries (B6) or the newer one a write here answered, its cell marked while it saves, a refusal said on the row.
 * Row ⋯: the dialog opens on the work order read afresh (`GET /production/work-orders/:id`) and writes with that version. After a
 * write that reaches the floor the row says when it was told (never who read it). `onWritten` reads the order's production again.
 */
export function useWorkOrderActs(api: ApiClient, permissions: readonly string[], onWritten: (written: ActsWritten) => void): { model: WorkOrderActsModel; actions: WorkOrderActsActions } {
  const can = useMemo(() => actsCanOf(permissions), [permissions])
  const [saves, setSaves] = useState<Record<string, RowSave>>({})
  const [toldAt, setToldAt] = useState<Record<string, string>>({})
  const [dialog, setDialog] = useState<ActsDialog | null>(null)
  const [reasons, setReasons] = useState<PickerReason[] | null>(null) // F-OP-114
  const [holdOrder, setHoldOrder] = useState<OrderHoldDialog | null>(null) // F-OO-108
  /** The newest version a write of this page answered, per work order (a second edit before the read comes again sends it). */
  const known = useRef<Record<string, number>>({})
  const turn = useRef(0)
  const written = useRef(onWritten)
  written.current = onWritten

  const told = useCallback((workOrderId: string) => setToldAt((now) => ({ ...now, [workOrderId]: new Date().toISOString() })), [])
  const answered = useCallback((workOrder: Pick<WorkOrder, 'id' | 'version'>) => {
    known.current = { ...known.current, [workOrder.id]: Math.max(known.current[workOrder.id] ?? 0, workOrder.version) }
  }, [])

  /** One in-place write: the cell saving, then the answer's version kept, the floor's time when it reaches the floor. */
  const inline = useCallback(
    (row: ActsRow, field: InlineField, body: { dueDate?: string | null; priority?: number; rush?: boolean }) => {
      if (row.version === undefined) return
      setSaves((now) => ({ ...now, [row.id]: { field, problem: null } }))
      updateWorkOrder(api, row.id, { version: versionOf(row, known.current), ...body })
        .then((next) => {
          answered(next)
          setSaves((now) => ({ ...now, [row.id]: { field: null, problem: null } }))
          if (reachesFloor(field, next.status)) told(row.id)
          written.current({ notice: null })
        })
        .catch((error: unknown) => {
          setSaves((now) => ({ ...now, [row.id]: { field: null, problem: fromProduction(productionWriteProblem(error)) } }))
          // A refused write (someone changed it meanwhile): the row shows what is stored now.
          written.current({ notice: null })
        })
    },
    [api, answered, told],
  )

  /** The dialog's work order, read afresh (a newer read wins; an older answer is dropped). */
  const readFor = useCallback(
    (workOrderId: string) => {
      const mine = ++turn.current
      setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, workOrder: now.workOrder.value ? now.workOrder : READING } : now))
      getWorkOrder(api, workOrderId)
        .then((value) => {
          if (mine !== turn.current) return
          answered(value)
          setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, workOrder: { value, problem: null } } : now))
        })
        .catch((error: unknown) => mine === turn.current && setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, workOrder: { value: null, problem: productionReadProblem(error) } } : now)))
    },
    [api, answered],
  )

  // ---- F-OP-114: the dialog's own reads — the holds of Lift…, the release check of Release…, the reasons of Hold… (once) ----
  const readHolds = useCallback(
    (workOrderId: string) => {
      setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, holds: READING } : now))
      listProductionHolds(api, workOrderId)
        .then((value) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, holds: { value, problem: null } } : now)))
        .catch((error: unknown) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, holds: { value: null, problem: dailyReadProblem(error) } } : now)))
    },
    [api],
  )
  const readCheck = useCallback(
    (workOrderId: string) => {
      setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, check: now.check?.value ? now.check : READING } : now))
      getReleaseCheck(api, workOrderId)
        .then((value) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, check: { value, problem: null } } : now)))
        .catch((error: unknown) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, check: { value: null, problem: productionReadProblem(error) } } : now)))
    },
    [api],
  )
  // F-OP-115: Cancel…'s check (the cut pieces, the issued stock, the workshops).
  const readCancelCheck = useCallback(
    (workOrderId: string) => {
      setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, cancelCheck: READING } : now))
      getWorkOrderCancelCheck(api, workOrderId)
        .then((value) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, cancelCheck: { value, problem: null } } : now)))
        .catch((error: unknown) => setDialog((now) => (now && now.workOrderId === workOrderId ? { ...now, cancelCheck: { value: null, problem: productionReadProblem(error) } } : now)))
    },
    [api],
  )
  const reasonsAsked = useRef(false)
  const readReasons = useCallback(() => {
    if (reasonsAsked.current) return
    reasonsAsked.current = true
    holdReasons(api)
      .then(setReasons)
      .catch((error: unknown) => {
        // Said in the dialog; the next Hold… asks again.
        reasonsAsked.current = false
        setDialog((now) => (now && now.kind === 'hold' ? { ...now, problem: fromWorkOrders({ key: dailyReadProblem(error) }) } : now))
        setHoldOrder((now) => (now ? { ...now, problem: fromWorkOrders({ key: dailyReadProblem(error) }) } : now)) // F-OO-108
      })
  }, [api])
  // ---- end F-OP-114

  const open = useCallback(
    (row: ActsRow, act: MenuAct) => {
      setDialog({ kind: act, workOrderId: row.id, number: row.number, workOrder: READING, busy: false, problem: null, ...(act === 'hold' ? { holdRight: row.rights?.hold ?? false } : {}) })
      readFor(row.id)
      // ---- F-OP-114 ----
      if (act === 'lift') readHolds(row.id)
      if (act === 'release') readCheck(row.id)
      if (act === 'hold') readReasons()
      // ---- end F-OP-114
      if (act === 'cancel') readCancelCheck(row.id) // F-OP-115
    },
    [readFor, readHolds, readCheck, readReasons, readCancelCheck],
  )

  /** A dialog's write: busy while it goes, the dialog closed and the page told on success, the refusal kept in it otherwise. */
  const dialogWrite = useCallback(
    (run: (workOrder: WorkOrder) => Promise<Pick<WorkOrder, 'id' | 'version'> | null>, after: { notice: Phrase | null; floor: boolean }, problemOf: (error: unknown) => Phrase = (error) => fromProduction(productionWriteProblem(error))) => {
      const current = dialog
      const workOrder = current?.workOrder.value
      if (!current || !workOrder || current.busy) return
      setDialog({ ...current, busy: true, problem: null })
      run(workOrder)
        .then((next) => {
          if (next) answered(next)
          setDialog(null)
          if (after.floor) told(current.workOrderId)
          written.current({ notice: after.notice })
        })
        .catch((error: unknown) => {
          setDialog((now) => (now && now.workOrderId === current.workOrderId ? { ...now, busy: false, problem: problemOf(error) } : now))
          readFor(current.workOrderId)
          // F-OP-114: what changed since it was read shows again (the release check, the holds).
          if (current.kind === 'release') readCheck(current.workOrderId)
          if (current.kind === 'lift') readHolds(current.workOrderId)
          if (current.kind === 'cancel') readCancelCheck(current.workOrderId) // F-OP-115: cut meanwhile? its words show
        })
    },
    [dialog, answered, told, readFor, readCheck, readHolds, readCancelCheck],
  )

  // ---- F-OP-115: Split… and Close… · Reopen… — the production lane's own hooks, on the work order read afresh ----
  const current = useRef(dialog)
  current.current = dialog
  const splitTarget = dialog?.kind === 'split' ? dialog.workOrder.value : null
  const split = useSplit(api, splitTarget, (child) => {
    const parent = current.current?.number ?? ''
    setDialog(null)
    written.current({ notice: { key: 'wo.notice.split', params: { number: parent, child: child.number } } })
  })
  const splitOpened = useRef<string | null>(null)
  useEffect(() => {
    if (!splitTarget) {
      splitOpened.current = null
      return
    }
    if (splitOpened.current === splitTarget.id) return
    splitOpened.current = splitTarget.id
    split.open()
  }, [splitTarget, split.open])
  const closeTarget = dialog && (dialog.kind === 'close' || dialog.kind === 'reopen') ? dialog.workOrder.value : null
  const close = useClose(api, closeTarget, permissions, (next) => {
    answered(next)
    const asked = current.current
    setDialog(null)
    written.current({ notice: { key: asked?.kind === 'reopen' ? 'wo.notice.reopened' : 'wo.notice.closed', params: { number: asked?.number ?? next.number } } })
  })
  const closeOpened = useRef<string | null>(null)
  const closeKind = dialog?.kind
  useEffect(() => {
    if (!closeTarget) {
      closeOpened.current = null
      return
    }
    const key = `${closeKind}:${closeTarget.id}`
    if (closeOpened.current === key) return
    closeOpened.current = key
    if (closeKind === 'reopen') close.actions.onOpenReopen?.()
    else close.actions.onOpen?.()
  }, [closeTarget, closeKind, close.actions])
  // ---- end F-OP-115

  // ---- F-OO-108: after a refusal, the work orders the plan holds are read afresh (their versions, their states) and the plan made
  // again by the domain's own rule — what is held already or done since is left out with why; the next Put on hold sends the new versions.
  const replan = useCallback(
    (open: OrderHoldDialog) => {
      Promise.all(open.plan.ids.map((id) => getWorkOrder(api, id)))
        .then((rows) => {
          for (const row of rows) answered(row)
          const fresh = orderHoldPlanOf({ workOrders: rows.map((row) => ({ id: row.id, number: row.number, status: row.status, version: row.version, sharedWithOtherCustomers: false, rights: { hold: true } })) })
          setHoldOrder((now) => (now ? { ...now, plan: { ...fresh, left: [...now.plan.left, ...fresh.left], notReached: now.plan.notReached } } : now))
        })
        .catch(() => undefined)
    },
    [api, answered],
  )
  // ---- end F-OO-108

  const actions: WorkOrderActsActions = {
    onDue: (row, day) => inline(row, 'due', { dueDate: day || null }),
    onPriority: (row, priority) => inline(row, 'priority', { priority }),
    onRush: (row, rush) => inline(row, 'rush', { rush }),
    onAct: open,
    onCloseDialog: () => setDialog((now) => (now?.busy ? now : null)),
    onRetryDialog: () => {
      if (!dialog) return
      readFor(dialog.workOrderId)
      // F-OP-114: + the dialog's own read that failed (the holds, the release check).
      if (dialog.kind === 'lift' && dialog.holds?.problem) readHolds(dialog.workOrderId)
      if (dialog.kind === 'release' && dialog.check?.problem) readCheck(dialog.workOrderId)
      if (dialog.kind === 'cancel' && dialog.cancelCheck?.problem) readCancelCheck(dialog.workOrderId) // F-OP-115
    },
    onSaveNote: (note) => dialogWrite((workOrder) => updateWorkOrder(api, workOrder.id, { version: workOrder.version, note: note.trim() || null }), { notice: { key: 'wo.note.saved', params: { number: dialog?.number ?? '' } }, floor: false }),
    // ---- F-OP-114: the kind the picked reason decides — a production hold (B-PR-21, with the version) or a quality hold ----
    onPlaceHold: (input) => {
      const key = newIdempotencyKey()
      dialogWrite(
        async (workOrder) => {
          if (input.kind === 'PRODUCTION') return (await placeProductionHold(api, workOrder.id, { reasonCode: input.reasonCode, note: input.reasonNote, brandWords: input.customerWords, version: workOrder.version }, key)).workOrder
          await placeHold(api, { workOrderIds: [workOrder.id], reasonCode: input.reasonCode, reasonNote: input.reasonNote }, key)
          return null
        },
        { notice: { key: 'wo.notice.held', params: { number: dialog?.number ?? '' } }, floor: true },
        (error) => fromWorkOrders(dailyProblem(error)),
      )
    },
    onLiftHold: (input) => {
      const key = newIdempotencyKey()
      dialogWrite(async (workOrder) => (await liftProductionHold(api, workOrder.id, input.holdId, { version: input.version, reason: input.reason }, key)).workOrder, { notice: { key: 'wo.notice.lifted', params: { number: dialog?.number ?? '' } }, floor: true }, (error) => fromWorkOrders(dailyProblem(error)))
    },
    onRelease: (overrideReason) =>
      dialogWrite(
        async (workOrder) => {
          const released = await releaseWorkOrder(api, workOrder.id, { version: workOrder.version, ...(overrideReason ? { materialOverride: { reason: overrideReason } } : {}) })
          return released
        },
        { notice: { key: 'wo.notice.released', params: { number: dialog?.number ?? '' } }, floor: true },
        releaseProblemOf,
      ),
    // ---- end F-OP-114
    // ---- F-OP-115 ----
    onCancelWorkOrder: (reason) => {
      // A released or started one: the floor stops it (its tablets follow); a draft never reached the floor.
      const floor = (dialog?.workOrder.value?.status ?? 'DRAFT') !== 'DRAFT'
      dialogWrite((workOrder) => cancelWorkOrder(api, workOrder.id, workOrder.version, reason.trim()), { notice: { key: 'wo.notice.cancelled', params: { number: dialog?.number ?? '' } }, floor })
    },
    split: {
      ...split.actions,
      onClose: () => {
        if (split.model?.busy) return
        split.actions.onClose?.()
        setDialog(null)
      },
    },
    close: {
      ...close.actions,
      onCancel: () => {
        if (close.model.busy) return
        close.actions.onCancel?.()
        setDialog(null)
      },
    },
    // ---- end F-OP-115
    // ---- F-OO-108: "Hold the whole order…" — the ONE Hold dialog on the plan's work orders; a production reason: one hold per work
    // order with every version read (B-OO-005: a stale one refuses them all, naming it); a quality reason: one quality hold over them.
    onHoldOrder: (input) => {
      setHoldOrder({ number: input.number, plan: input.plan, units: input.units, busy: false, problem: null })
      readReasons()
    },
    onPlaceOrderHold: (input) => {
      const open = holdOrder
      if (!open || open.busy || open.plan.ids.length === 0) return
      const key = newIdempotencyKey()
      const ids = [...open.plan.ids]
      setHoldOrder({ ...open, busy: true, problem: null })
      const write = orderHoldWriteOf(open.plan, input)
      const place = write.route === 'production' ? placeProductionHolds(api, write.body, key) : placeHold(api, write.body, key)
      place
        .then(() => {
          setHoldOrder(null)
          for (const id of ids) told(id)
          written.current({ notice: { key: 'where.hold.notice', params: { count: ids.length, number: open.number } } })
        })
        .catch((error: unknown) => {
          setHoldOrder((now) => (now ? { ...now, busy: false, problem: orderHoldProblemOf(error, open.plan) } : now))
          replan(open)
          written.current({ notice: null })
        })
    },
    onCloseOrderHold: () => setHoldOrder((now) => (now?.busy ? now : null)),
    // ---- end F-OO-108
  }

  return { model: { can, saves, toldAt, dialog, reasons /* F-OP-114 */, split: split.model, close: close.model /* F-OP-115 */, holdOrder /* F-OO-108 */ }, actions }
}
