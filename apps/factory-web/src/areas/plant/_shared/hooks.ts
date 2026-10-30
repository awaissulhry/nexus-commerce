'use client'

import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { STEP_UP_CLOSED, type StepUpState } from './parts'

export { downloadText, useCoalesced, useLive, type LiveState } from '../../_shared/buying/hooks'

/** The person closed the code dialog: the signing act was not made. */
export class StepUpCancelled extends Error {
  override name = 'StepUpCancelled'
}

export const isStepUpCancelled = (error: unknown): error is StepUpCancelled => error instanceof StepUpCancelled

/** The words of a refused code: wrong or used, too many tries, or no answer. */
export function stepUpProblem(error: unknown): string {
  if (!isApiError(error)) return 'stepUp.problem.unavailable'
  if (error.kind === 'rate_limited') return 'stepUp.problem.locked'
  if (error.kind === 'invalid' || error.kind === 'forbidden' || error.kind === 'signed_out') return 'stepUp.problem.wrong'
  return 'stepUp.problem.unavailable'
}

/**
 * A machine signed safe again is a signing act (Owner answer H1; D.Lgs. 81/2008 art. 71): the API asks the office for a
 * fresh authenticator code AFTER every other check (a refused sign-safe never asks for the code). The act runs as asked;
 * on a 403 `stepUp` the DS step-up dialog opens, the code goes to `POST /auth/office/step-up` (5 minutes on this
 * session), and the act runs once more with the same Idempotency-Key. Asked at the moment of the act, never at load.
 */
export function useStepUp(api: ApiClient) {
  const [stepUp, setStepUp] = useState<StepUpState>(STEP_UP_CLOSED)
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)

  const guard = useCallback(async <T>(sentence: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'step_up') throw error
      await new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject }
        setStepUp({ open: true, busy: false, sentence, problem: null })
      })
      return work()
    }
  }, [])

  const submit = useCallback(
    async (code: string) => {
      setStepUp((current) => ({ ...current, busy: true, problem: null }))
      try {
        await api.post('/auth/office/step-up', { body: { code }, schema: z.object({ stepUpUntil: z.string() }) })
        setStepUp(STEP_UP_CLOSED)
        waiting.current?.resolve()
        waiting.current = null
      } catch (error) {
        setStepUp((current) => ({ ...current, busy: false, problem: stepUpProblem(error) }))
      }
    },
    [api],
  )

  const cancel = useCallback(() => {
    setStepUp(STEP_UP_CLOSED)
    waiting.current?.reject(new StepUpCancelled())
    waiting.current = null
  }, [])

  return { stepUp, guard, submitStepUp: submit, cancelStepUp: cancel }
}
