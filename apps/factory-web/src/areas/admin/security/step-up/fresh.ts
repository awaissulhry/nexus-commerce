'use client'

import { useCallback, useRef, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { STEP_UP_CLOSED, stepUpProblem, type StepUpModel } from '../../shared/model'
import { runWithStepUp, StepUpCancelled } from '../../shared/step-up'

const meSession = z.object({ session: z.object({ stepUpUntil: z.string().nullable().optional() }) })
const proved = z.object({ stepUpUntil: z.string() })

/** A fresh code still counts for at least 20 s more (the write goes out at once). */
export const stillFresh = (stepUpUntil: string | null | undefined, now: number): boolean => !!stepUpUntil && Date.parse(stepUpUntil) > now + 20_000

/**
 * A fresh code FIRST for a change known to ask one (B-W2b-413: Lead decision 11-14 "a step-up action opens the StepUpModal
 * first"): `ensureFresh(sentence)` reads this session (`GET /auth/office/me` session.stepUpUntil) and, without a fresh code,
 * opens the code dialog and waits until the API took one, so the write is sent once. `guard` still catches a 403 `stepUp`
 * (a code that ran out meanwhile, a change the screen thought narrower) and retries once after the code. Closing the dialog
 * rejects with StepUpCancelled. The dialog's words are the caller's (a message key of its own catalogue).
 */
export function useFreshCode(api: ApiClient) {
  const [stepUp, setStepUp] = useState<StepUpModel>(STEP_UP_CLOSED)
  const waiting = useRef<{ resolve: () => void; reject: (error: unknown) => void } | null>(null)

  const ask = useCallback(
    (sentence: string) =>
      new Promise<void>((resolve, reject) => {
        waiting.current = { resolve, reject }
        setStepUp({ open: true, busy: false, sentence, problem: null })
      }),
    [],
  )

  const ensureFresh = useCallback(
    async (sentence: string): Promise<void> => {
      let fresh = false
      try {
        fresh = stillFresh((await api.get('/auth/office/me', { schema: meSession })).session.stepUpUntil, Date.now())
      } catch {
        fresh = false
      }
      if (!fresh) await ask(sentence)
    },
    [api, ask],
  )

  const guard = useCallback(<T,>(sentence: string, work: () => Promise<T>): Promise<T> => runWithStepUp(work, () => ask(sentence)), [ask])

  const submit = useCallback(
    async (code: string) => {
      setStepUp((current) => ({ ...current, busy: true, problem: null }))
      try {
        await api.post('/auth/office/step-up', { body: { code }, schema: proved })
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

  return { stepUp, ensureFresh, guard, submit, cancel }
}
