'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../api/client'
import { getWorkOrder, updateWorkOrder, type WorkOrder } from '../../../areas/production/_shared/api'
import { readProblem as productionReadProblem, writeProblem as productionWriteProblem } from '../../../areas/production/_shared/model'
import { actsCanOf, fromProduction, reachesFloor, READING, versionOf, type ActsCan, type ActsRow, type InlineField, type MenuAct, type Part, type Phrase } from './model'

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
}

export interface WorkOrderActsModel {
  readonly can: ActsCan
  /** Per work order id: its in-place save. */
  readonly saves: Readonly<Record<string, RowSave>>
  /** Per work order id: when a write of this page last reached its floor (the row says "Told the floor at hh:mm"). */
  readonly toldAt: Readonly<Record<string, string>>
  readonly dialog: ActsDialog | null
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

  const open = useCallback(
    (row: ActsRow, act: MenuAct) => {
      setDialog({ kind: act, workOrderId: row.id, number: row.number, workOrder: READING, busy: false, problem: null })
      readFor(row.id)
    },
    [readFor],
  )

  /** A dialog's write: busy while it goes, the dialog closed and the page told on success, the refusal kept in it otherwise. */
  const dialogWrite = useCallback(
    (run: (workOrder: WorkOrder) => Promise<Pick<WorkOrder, 'id' | 'version' | 'status'> | null>, after: { notice: Phrase | null; floor: boolean }) => {
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
          setDialog((now) => (now && now.workOrderId === current.workOrderId ? { ...now, busy: false, problem: fromProduction(productionWriteProblem(error)) } : now))
          readFor(current.workOrderId)
        })
    },
    [dialog, answered, told, readFor],
  )

  const actions: WorkOrderActsActions = {
    onDue: (row, day) => inline(row, 'due', { dueDate: day || null }),
    onPriority: (row, priority) => inline(row, 'priority', { priority }),
    onRush: (row, rush) => inline(row, 'rush', { rush }),
    onAct: open,
    onCloseDialog: () => setDialog((now) => (now?.busy ? now : null)),
    onRetryDialog: () => {
      if (dialog) readFor(dialog.workOrderId)
    },
    onSaveNote: (note) => dialogWrite((workOrder) => updateWorkOrder(api, workOrder.id, { version: workOrder.version, note: note.trim() || null }), { notice: { key: 'wo.note.saved', params: { number: dialog?.number ?? '' } }, floor: false }),
  }

  return { model: { can, saves, toldAt, dialog }, actions }
}
