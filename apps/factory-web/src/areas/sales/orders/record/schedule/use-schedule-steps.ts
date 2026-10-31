'use client'

import { useCallback, useMemo, useState } from 'react'
import type { ApiClient } from '../../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../../lib/api/client'
import { isApiError, issuePath } from '../../../../../lib/api/errors'
import type { Milestone } from '../../api'
import type { Phrase } from '../../model'
import { invoiceStep, openStep } from './api'
import { stepAbilitiesOf } from './model'
import type { ScheduleStepsActions, ScheduleStepsModel } from './view/StepVerbs'

/** A refusal of a step verb in words (the API's English is never drawn): moved meanwhile, refused by state, no right. */
function stepProblem(error: unknown): Phrase {
  if (!isApiError(error)) return { key: 'schedule.verbs.problem.write' }
  if (error.kind === 'conflict') return { key: error.issues.map(issuePath).some((path) => path.includes('version')) ? 'schedule.verbs.problem.moved' : 'schedule.verbs.problem.state' }
  if (error.kind === 'invalid') return { key: 'schedule.verbs.problem.day' }
  if (error.kind === 'forbidden') return { key: 'schedule.verbs.problem.forbidden' }
  return { key: 'schedule.verbs.problem.write' }
}

/**
 * The schedule card's verbs for the order studio (B-W2a-80): open a before-shipping step for payment, invoice a paid step
 * (its TD02 draft opens in Finance). Each write once, with its own Idempotency-Key; the schedule is read again after.
 */
export function useScheduleSteps(input: { api: ApiClient; orderId: string; permissions: readonly string[]; reload: () => void; onNotice: (words: Phrase, tone: 'success' | 'danger') => void; onInvoiced: (invoiceId: string) => void }) {
  const { api, orderId, permissions, reload, onNotice, onInvoiced } = input
  const can = useMemo(() => stepAbilitiesOf(permissions), [permissions])
  const [opening, setOpening] = useState<Milestone | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)

  const run = useCallback(
    async (work: () => Promise<void>, inDialog: boolean) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      try {
        await work()
      } catch (error) {
        const words = stepProblem(error)
        if (inDialog) setProblem(words)
        else onNotice(words, 'danger')
        reload()
      } finally {
        setBusy(false)
      }
    },
    [busy, onNotice, reload],
  )

  const model: ScheduleStepsModel = { can, opening, busy, problem }
  const actions: ScheduleStepsActions = {
    onOpen: (step) => {
      setOpening(step)
      setProblem(null)
    },
    onConfirmOpen: (step, dueDate) => {
      const key = newIdempotencyKey()
      void run(async () => {
        await openStep(api, orderId, step, dueDate, key)
        setOpening(null)
        onNotice({ key: 'schedule.verbs.opened' }, 'success')
        reload()
      }, opening !== null)
    },
    onInvoice: (step) => {
      const key = newIdempotencyKey()
      void run(async () => {
        const { invoiceId } = await invoiceStep(api, step.id, key)
        onInvoiced(invoiceId)
      }, false)
    },
  }
  return { model, actions }
}
