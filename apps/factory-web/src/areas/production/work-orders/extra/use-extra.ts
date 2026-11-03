'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import type { WorkOrder } from '../../_shared/api'
import type { Phrase } from '../../_shared/model'
import { addExtra, getExtraChoices, getExtras, type ExtraChoices, type ExtraReasonCode, type ExtraRecord } from './api'

/** The note's limits (the API's: a few words, required with Other). */
export const EXTRA_NOTE = { min: 3, max: 200 } as const

export interface ExtraDraft {
  operationId: string | null
  reasonCode: ExtraReasonCode | null
  note: string
}

export interface ExtraDialogModel {
  choices: ExtraChoices | null
  draft: ExtraDraft
  busy: boolean
  problem: Phrase | null
}

export interface ExtraModel {
  /** The work order takes one: RELEASED or IN_PROGRESS, and the person may add. */
  canAdd: boolean
  added: { value: ExtraRecord[] | null; problem: string | null }
  dialog: ExtraDialogModel | null
}

export interface ExtraActions {
  onOpen?: () => void
  onClose?: () => void
  onDraft?: (patch: Partial<ExtraDraft>) => void
  onAdd?: () => void
  onRetry?: () => void
}

const OPEN = ['RELEASED', 'IN_PROGRESS']
const phrase = (key: string, params?: Phrase['params']): Phrase => (params ? { key, params } : { key })

/** Why Add waits, as a message key, or null. */
export function extraHeld(dialog: ExtraDialogModel): string | null {
  if (dialog.busy) return 'held.busy'
  const { draft, choices } = dialog
  if (!draft.operationId) return 'extra.held.operation'
  if (!draft.reasonCode) return 'extra.held.reason'
  const tile = choices?.reasons.find((reason) => reason.code === draft.reasonCode)
  return tile?.needsNote && draft.note.trim().length < EXTRA_NOTE.min ? 'extra.held.note' : null
}

/** The list on the Operations tab, and the Add pop-up: its reads when it opens, the add under the dialog's own Idempotency-Key. */
export function useExtra(api: ApiClient, workOrder: WorkOrder | null, permitted: boolean, onAdded: (words: Phrase) => void): { model: ExtraModel; actions: ExtraActions } {
  const [added, setAdded] = useState<ExtraModel['added']>({ value: null, problem: null })
  const [dialog, setDialog] = useState<ExtraDialogModel | null>(null)
  const key = useRef(newIdempotencyKey())
  const released = workOrder !== null && workOrder.status !== 'DRAFT' && workOrder.status !== 'CANCELLED'
  const id = workOrder?.id ?? null

  const read = useCallback(() => {
    if (!id) return
    getExtras(api, id)
      .then((value) => setAdded({ value, problem: null }))
      .catch((error: unknown) => setAdded({ value: null, problem: isApiError(error) ? error.kind : 'unavailable' }))
  }, [api, id])

  useEffect(() => {
    if (released) read()
  }, [released, read])

  const actions: ExtraActions = {
    onRetry: read,
    onOpen: () => {
      if (!id) return
      key.current = newIdempotencyKey()
      setDialog({ choices: null, draft: { operationId: null, reasonCode: null, note: '' }, busy: false, problem: null })
      getExtraChoices(api, id)
        .then((choices) => setDialog((current) => (current ? { ...current, choices } : current)))
        .catch(() => setDialog((current) => (current ? { ...current, problem: phrase('extra.readFailed') } : current)))
    },
    onClose: () => setDialog(null),
    onDraft: (patch) => setDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
    onAdd: () => {
      if (!id || !dialog || extraHeld(dialog)) return
      const { draft } = dialog
      const note = draft.note.trim()
      setDialog({ ...dialog, busy: true, problem: null })
      addExtra(api, id, { operationId: draft.operationId!, reasonCode: draft.reasonCode!, ...(note.length >= EXTRA_NOTE.min ? { note } : {}) }, key.current)
        .then((answer) => {
          setDialog(null)
          onAdded(answer.pays === 'OFF_STANDARD' ? phrase('extra.addedNoRate', { seq: answer.seq ?? 0, name: answer.operation.name }) : phrase('extra.added', { seq: answer.seq ?? 0, name: answer.operation.name }))
          read()
        })
        .catch((error: unknown) => {
          const words = isApiError(error) && error.kind === 'conflict' ? phrase('extra.refused', { words: error.message }) : phrase('extra.failed')
          setDialog((current) => (current ? { ...current, busy: false, problem: words } : current))
        })
    },
  }
  return { model: { canAdd: permitted && workOrder !== null && OPEN.includes(workOrder.status), added, dialog }, actions }
}
