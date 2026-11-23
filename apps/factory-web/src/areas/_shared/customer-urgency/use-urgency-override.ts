'use client'

import { useRef, useState } from 'react'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { setBackUrgency, unlockUrgency } from './api'
import { urgencyOutcomeOf, urgencyProblemOf, type Phrase, type UrgencyDialog, type UrgencyOutcome, type UrgencyOverrideActions, type UrgencyOverrideModel } from './model'

/**
 * The host's step-up guard (its page's ONE step-up modal): asks a fresh code when the API wants one, then runs the write again with
 * the same key. The sentence is a key of the host's own step-up catalogue.
 */
export type UrgencyGuard = <T>(sentence: string, work: () => Promise<T>) => Promise<T>

/** The person closed the code dialog (every step-up hook rejects with an error of this name): nothing was written, nothing is said. */
const stepUpCancelled = (error: unknown): boolean => error instanceof Error && error.name === 'StepUpCancelled'

/**
 * F-CW-302 — the urgency window's state and its ONE write, MOVED as they are from the work order's Customer card hook (F-PR-05b):
 * Set to regular, Lock, Unlock (production.brand.override; the host's step-up asks a fresh code; no second person). After a write
 * the host is told what was done per order (`onDone`: it reads again and says its notice); a refused write is said in the dialog and
 * the host reads again (`onRefused`).
 */
export function useUrgencyOverride(api: ApiClient, guard: UrgencyGuard, onDone: (outcome: UrgencyOutcome) => void, onRefused?: () => void): { model: UrgencyOverrideModel; actions: Required<UrgencyOverrideActions> } {
  const [dialog, setDialog] = useState<UrgencyDialog | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<Phrase | null>(null)
  const [outcome, setOutcome] = useState<UrgencyOutcome | null>(null)
  const doneRef = useRef(onDone)
  doneRef.current = onDone
  const refusedRef = useRef(onRefused)
  refusedRef.current = onRefused

  const actions: Required<UrgencyOverrideActions> = {
    onDialog: (next) => {
      setProblem(null)
      setDialog(next)
    },
    onUrgency: (input) => {
      if (busy) return
      setBusy(true)
      setProblem(null)
      const orderIds = input.orders.map((order) => order.id)
      const idempotencyKey = newIdempotencyKey()
      guard('stepUp.urgencySentence', () => (input.act === 'unlock' ? unlockUrgency(api, { orderIds }, idempotencyKey) : setBackUrgency(api, { orderIds, reason: input.reason.trim(), lock: input.act === 'lock' || input.lock }, idempotencyKey)))
        .then((answer) => {
          const done = urgencyOutcomeOf(input.act, answer, input.orders)
          setOutcome(done)
          setDialog(null)
          doneRef.current(done)
        })
        .catch((error: unknown) => {
          if (!stepUpCancelled(error)) {
            setProblem(urgencyProblemOf(error))
            refusedRef.current?.()
          }
        })
        .finally(() => setBusy(false))
    },
    onDismissOutcome: () => setOutcome(null),
  }
  return { model: { dialog, busy, problem, outcome }, actions }
}
