'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { readProblem, type Phrase } from '../../../_shared/stock/model'
import { askSubstitute, substituteOptions, withdrawSubstitute, workOrderBomLines, type AskAnswer, type BomLineChoice, type SubstituteOptions, type Substitution } from './api'
import { askBodyOf, askHeld, askProblem, blankAsk, bomLinesOf, subCan, type AskDraft } from './model'

/**
 * B-W2b-320 — "Use a substitute" (container hook): THE dialog of Picking › a short line and of the work order's Materials ›
 * Substitute…. It reads the work order's BOM lines of the material (W1's pick read) when no line is named, then the line's
 * choices (`GET /inventory/substitutions/options`), asks (`POST /inventory/substitutions`, its own Idempotency-Key) and
 * withdraws a standing substitute (`POST …/:id/withdraw` at its version). After a write the line is read again and the
 * host is told (its pick list, tiles). The yes itself is another person's, in Home › Approvals.
 */

export interface SubstituteTarget {
  workOrderId: string
  number?: string | null
  /** The material of a short line (Picking); none: every BOM line of the work order (Materials › Substitute…). */
  material?: { itemId: string; itemColourId: string | null } | null
  bomLineId?: string | null
}

export interface Part<T> {
  value: T | null
  problem: string | null
}
const loading = { value: null, problem: null }

export interface SubstituteDialogModel {
  target: SubstituteTarget
  lines: Part<BomLineChoice[]> | null
  bomLineId: string | null
  options: Part<SubstituteOptions> | null
  draft: AskDraft | null
  busy: boolean
  problem: Phrase | null
  done: AskAnswer | null
  withdraw: { substitution: Substitution; reason: string } | null
}

export interface SubstituteActions {
  onClose?: () => void
  onRetry?: () => void
  onPickLine?: (bomLineId: string) => void
  onPickChoice?: (index: number) => void
  onDraft?: (patch: Partial<AskDraft>) => void
  onAsk?: () => void
  onAnother?: () => void
  onWithdraw?: (substitution: Substitution | null) => void
  onWithdrawReason?: (reason: string) => void
  onConfirmWithdraw?: () => void
}

export function useSubstitute(api: ApiClient, permissions: readonly string[], onChanged: () => void) {
  const can = useMemo(() => subCan(permissions), [permissions])
  const [dialog, setDialog] = useState<SubstituteDialogModel | null>(null)
  const changed = useRef(onChanged)
  changed.current = onChanged

  const readOptions = useCallback(
    async (workOrderId: string, bomLineId: string, keepDone = false) => {
      setDialog((current) => (current ? { ...current, bomLineId, options: current.options?.value && current.bomLineId === bomLineId ? current.options : loading, ...(keepDone ? {} : { done: null }) } : current))
      try {
        const options = await substituteOptions(api, workOrderId, bomLineId)
        setDialog((current) => (current && current.bomLineId === bomLineId ? { ...current, options: { value: options, problem: null }, draft: current.draft && current.done === null && keepDone ? current.draft : blankAsk(options) } : current))
      } catch (error) {
        setDialog((current) => (current && current.bomLineId === bomLineId ? { ...current, options: { value: null, problem: readProblem(error) } } : current))
      }
    },
    [api],
  )

  const readLines = useCallback(
    async (target: SubstituteTarget) => {
      try {
        const lines = bomLinesOf(await workOrderBomLines(api, target.workOrderId), target.material ?? null)
        setDialog((current) => (current ? { ...current, lines: { value: lines, problem: null } } : current))
        if (lines.length === 1) void readOptions(target.workOrderId, lines[0]!.bomLineId)
      } catch (error) {
        setDialog((current) => (current ? { ...current, lines: { value: null, problem: readProblem(error) } } : current))
      }
    },
    [api, readOptions],
  )

  const open = useCallback(
    (target: SubstituteTarget) => {
      setDialog({ target, lines: target.bomLineId ? null : loading, bomLineId: target.bomLineId ?? null, options: target.bomLineId ? loading : null, draft: null, busy: false, problem: null, done: null, withdraw: null })
      if (target.bomLineId) void readOptions(target.workOrderId, target.bomLineId)
      else void readLines(target)
    },
    [readOptions, readLines],
  )

  const ask = useCallback(async () => {
    const options = dialog?.options?.value
    if (!dialog || !options || !dialog.draft || askHeld(options, dialog.draft, can, dialog.busy)) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      const done = await askSubstitute(api, askBodyOf(options, dialog.draft))
      setDialog((current) => (current ? { ...current, busy: false, done } : current))
      changed.current()
      void readOptions(options.workOrder.id, options.line.id, true)
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: askProblem(error) } : current))
      void readOptions(options.workOrder.id, options.line.id, true)
    }
  }, [api, dialog, can, readOptions])

  const withdraw = useCallback(async () => {
    const options = dialog?.options?.value
    const pending = dialog?.withdraw
    if (!dialog || !options || !pending || !pending.reason.trim() || dialog.busy) return
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await withdrawSubstitute(api, pending.substitution, pending.reason.trim())
      setDialog((current) => (current ? { ...current, busy: false, withdraw: null } : current))
      changed.current()
      void readOptions(options.workOrder.id, options.line.id, true)
    } catch (error) {
      setDialog((current) => (current ? { ...current, busy: false, problem: askProblem(error) } : current))
    }
  }, [api, dialog, readOptions])

  const actions: SubstituteActions = {
    onClose: () => setDialog(null),
    onRetry: () => {
      if (!dialog) return
      if (dialog.bomLineId) void readOptions(dialog.target.workOrderId, dialog.bomLineId)
      else void readLines(dialog.target)
    },
    onPickLine: (bomLineId) => dialog && void readOptions(dialog.target.workOrderId, bomLineId),
    onPickChoice: (index) => setDialog((current) => (current?.draft ? { ...current, draft: { ...current.draft, choice: index, lotId: null }, problem: null } : current)),
    onDraft: (patch) => setDialog((current) => (current?.draft ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onAsk: () => void ask(),
    onAnother: () => setDialog((current) => (current?.options?.value ? { ...current, done: null, draft: blankAsk(current.options.value), problem: null } : current)),
    onWithdraw: (substitution) => setDialog((current) => (current ? { ...current, withdraw: substitution ? { substitution, reason: '' } : null, problem: null } : current)),
    onWithdrawReason: (reason) => setDialog((current) => (current?.withdraw ? { ...current, withdraw: { ...current.withdraw, reason } } : current)),
    onConfirmWithdraw: () => void withdraw(),
  }
  return { can, model: dialog, actions, open }
}
