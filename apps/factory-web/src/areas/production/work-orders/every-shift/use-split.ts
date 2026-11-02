'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import type { WorkOrder } from '../../_shared/api'
import type { Phrase } from '../../_shared/model'
import { previewSplit, splitWorkOrder, type SplitPreview } from './api'
import { overCells, splitAskOf, splitProblem, type SplitDraft } from './model'

export interface SplitModel {
  draft: SplitDraft
  preview: SplitPreview | null
  reading: boolean
  busy: boolean
  problem: Phrase | null
}

export interface SplitActions {
  onDraft?: (patch: Partial<SplitDraft>) => void
  onSplit?: () => void
  onClose?: () => void
}

const WAIT_MS = 300

/**
 * The Split dialog's side (wo-split): the API's preview as the person types (one read after a pause, the older answers
 * dropped), then the split with the version read and the dialog's own Idempotency-Key. Done: the new work order opens.
 */
export function useSplit(api: ApiClient, workOrder: WorkOrder | null, onDone: (child: WorkOrder) => void): { model: SplitModel | null; open: () => void; actions: SplitActions } {
  const [model, setModel] = useState<SplitModel | null>(null)
  const key = useRef(newIdempotencyKey())
  const turn = useRef(0)
  const askText = model && workOrder ? JSON.stringify(splitAskOf(workOrder.cells, model.draft.moves)) : ''
  useEffect(() => {
    if (!workOrder || !model) return
    const asks = splitAskOf(workOrder.cells, model.draft.moves)
    const mine = ++turn.current
    if (asks.length === 0 || overCells(workOrder.cells, model.draft.moves).length > 0) {
      setModel((current) => (current ? { ...current, preview: null, reading: false } : current))
      return
    }
    setModel((current) => (current ? { ...current, reading: true } : current))
    const timer = setTimeout(() => {
      previewSplit(api, workOrder.id, asks)
        .then((preview) => mine === turn.current && setModel((current) => (current ? { ...current, preview, reading: false, problem: null } : current)))
        .catch((error: unknown) => mine === turn.current && setModel((current) => (current ? { ...current, preview: null, reading: false, problem: splitProblem(error) } : current)))
    }, WAIT_MS)
    return () => clearTimeout(timer)
  }, [api, workOrder?.id, askText])

  const open = useCallback(() => {
    if (!workOrder) return
    key.current = newIdempotencyKey()
    setModel({ draft: { moves: {}, dueDate: workOrder.dueDate ?? '', priority: String(workOrder.priority), rush: workOrder.rush ?? false, note: '' }, preview: null, reading: false, busy: false, problem: null })
  }, [workOrder])

  const actions: SplitActions = {
    onDraft: (patch) => setModel((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
    onClose: () => setModel(null),
    onSplit: () => {
      if (!workOrder || !model || model.busy) return
      setModel({ ...model, busy: true, problem: null })
      const { draft } = model
      splitWorkOrder(api, workOrder.id, { version: workOrder.version, cells: splitAskOf(workOrder.cells, draft.moves), dueDate: draft.dueDate || null, priority: Number(draft.priority), rush: draft.rush, note: draft.note.trim() || null }, key.current)
        .then((answer) => {
          setModel(null)
          onDone(answer.workOrder)
        })
        .catch((error: unknown) => setModel((current) => (current ? { ...current, busy: false, problem: splitProblem(error) } : current)))
    },
  }
  return { model, open, actions }
}
