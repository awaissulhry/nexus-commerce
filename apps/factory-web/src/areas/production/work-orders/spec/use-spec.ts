'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { createRequest, readCompare } from '../../../products/changes/api'
import { readProblem, writeProblem } from '../../../products/changes/model'
import type { WorkOrder } from '../../_shared/api'
import { readWorkOrderChanges, readWorkOrderSpec } from './api'
import { comparePair, EMPTY_DRAFT, isFrozen, raiseHeld, requestBody, specCan, type SpecActions, type SpecDialog, type SpecModel } from './model'

/**
 * The work order's spec against the master (B-W2b-220) and its change requests (B-W2b-226): once released, while the
 * Overview shows, it reads whether a newer spec is due and how it differs; Spec differences reads the compare of the work
 * order's revision against the released one (product.bom.view); Change request reads what is already cut and worked and the
 * requests about the work order (product.changes.view), and "Ask for approval" raises one (product.changes.request) —
 * OFFICE, about this work order and its frozen revision — for the product office to accept or reject. One key per try.
 */
export function useWorkOrderSpec({ api, workOrder, permissions, enabled }: { api: ApiClient; workOrder: WorkOrder | null; permissions: readonly string[]; enabled: boolean }): { model: SpecModel | undefined; actions: SpecActions } {
  const can = useMemo(() => specCan(permissions), [permissions])
  const [spec, setSpec] = useState<SpecModel['spec']>({ status: 'idle' })
  const [dialog, setDialog] = useState<SpecDialog | null>(null)
  const [compare, setCompare] = useState<SpecModel['compare']>(null)
  const [changes, setChanges] = useState<SpecModel['changes']>(null)
  const [draft, setDraft] = useState(EMPTY_DRAFT)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<SpecModel['problem']>(null)
  const [raised, setRaised] = useState<SpecModel['raised']>(null)
  const attempt = useRef<string | null>(null)

  const frozen = !!workOrder && isFrozen(workOrder)
  const key = workOrder ? `${workOrder.id}:${workOrder.status}:${workOrder.revision?.id ?? ''}` : null

  const loadSpec = useCallback(() => {
    if (!workOrder) return
    setSpec((current) => (current.status === 'ready' ? current : { status: 'loading' }))
    readWorkOrderSpec(api, workOrder.id)
      .then((value) => setSpec({ status: 'ready', value }))
      .catch((error: unknown) => setSpec({ status: 'error', problem: readProblem(error) }))
  }, [api, key])

  useEffect(() => {
    if (frozen && (enabled || dialog)) loadSpec()
  }, [frozen, enabled, key, loadSpec])

  const loadCompare = useCallback(() => {
    if (spec.status !== 'ready' || !can.compare) return
    const pair = comparePair(spec.value)
    if (!pair) {
      setCompare(null)
      return
    }
    setCompare({ status: 'loading' })
    readCompare(api, pair)
      .then((value) => setCompare({ status: 'ready', value }))
      .catch((error: unknown) => setCompare({ status: 'error', problem: readProblem(error) }))
  }, [api, spec, can.compare])

  const loadChanges = useCallback(() => {
    if (!workOrder || !can.changes) return
    setChanges((current) => (current?.status === 'ready' ? current : { status: 'loading' }))
    readWorkOrderChanges(api, workOrder.id)
      .then((value) => setChanges({ status: 'ready', value }))
      .catch((error: unknown) => setChanges({ status: 'error', problem: readProblem(error) }))
  }, [api, key, can.changes])

  useEffect(() => {
    if (dialog?.kind === 'diff') loadCompare()
  }, [dialog?.kind, spec.status === 'ready' ? spec.value : null])
  useEffect(() => {
    if (dialog?.kind === 'change') loadChanges()
  }, [dialog?.kind, loadChanges])

  const actions: SpecActions = {
    onOpen: (next) => {
      setProblem(null)
      setRaised(null)
      if (next.kind === 'change') attempt.current = null
      setDialog(next)
      if (spec.status === 'idle' && frozen) loadSpec()
    },
    onClose: () => {
      setDialog(null)
      setProblem(null)
    },
    onDraft: (patch) => {
      attempt.current = null
      setDraft((current) => ({ ...current, ...patch }))
    },
    onRetry: (part) => {
      if (part === 'spec') loadSpec()
      else if (part === 'compare') loadCompare()
      else loadChanges()
    },
    onRaise: () => {
      if (!workOrder || raiseHeld(draft, can, busy)) return
      // The same try keeps its key: a resend after a lost answer is the request it made the first time.
      attempt.current = attempt.current ?? newIdempotencyKey()
      setBusy(true)
      setProblem(null)
      createRequest(api, requestBody(draft, workOrder), attempt.current)
        .then((request) => {
          attempt.current = null
          setRaised({ id: request.id, number: request.number })
          setDraft(EMPTY_DRAFT)
          loadChanges()
        })
        .catch((error: unknown) => {
          const words = writeProblem(error)
          setProblem({ key: words.key, params: words.params, changes: true })
        })
        .finally(() => setBusy(false))
    },
  }

  const model: SpecModel | undefined = workOrder ? { can, spec, dialog, compare, changes: can.changes ? changes : null, draft, busy, problem, raised } : undefined
  return { model, actions }
}
