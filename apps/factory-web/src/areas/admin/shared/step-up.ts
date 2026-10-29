'use client'

import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { STEP_UP_CLOSED, stepUpProblem, type StepUpModel } from './model'

/** The person closed the code dialog: the change was not made. */
export class StepUpCancelled extends Error {
  override name = 'StepUpCancelled'
}

export const isStepUpCancelled = (error: unknown): error is StepUpCancelled => error instanceof StepUpCancelled

/**
 * The rule, without React: run `work`; on a 403 that asks for a step-up, wait until `askForCode` resolves (the person
 * typed a code the API took) and run `work` once more. Any other error, and a refusal of the code dialog, goes up.
 */
export async function runWithStepUp<T>(work: () => Promise<T>, askForCode: () => Promise<void>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (!isApiError(error) || error.kind !== 'step_up') throw error
    await askForCode()
    return work()
  }
}

/**
 * A change that raises rights (users, roles, badges, PINs: A1 §3.10) runs as asked; when the API answers 403 with the
 * issue path `stepUp`, the step-up dialog opens, the code goes to `POST /auth/office/step-up` (5 minutes on this
 * session), and the change runs once more. Asked at the moment of the action, never at page load (00 §3.8). Closing
 * the dialog rejects with StepUpCancelled.
 */
export function useStepUp(api: ApiClient) {
  const [stepUp, setStepUp] = useState<StepUpModel>(STEP_UP_CLOSED)
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)

  const guard = useCallback(
    <T,>(sentence: string, work: () => Promise<T>): Promise<T> =>
      runWithStepUp(
        work,
        () =>
          new Promise<void>((resolve, reject) => {
            waiting.current = { resolve, reject }
            setStepUp({ open: true, busy: false, sentence, problem: null })
          }),
      ),
    [],
  )

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
