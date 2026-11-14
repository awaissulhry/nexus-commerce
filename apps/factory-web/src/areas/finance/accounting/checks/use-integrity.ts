'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { useCoalesced, useLive } from '../../_shared/hooks'
import { readProblem, writeProblem, type WriteProblem } from '../model'
import { getIntegrity, runIntegrity, type IntegrityAnswer } from './api'
import { integrityTouches, runHeld } from './model'

export interface IntegrityModel {
  readonly value: IntegrityAnswer | null
  readonly problem: string | null
  readonly running: boolean
  readonly runProblem: WriteProblem | null
}

export interface IntegrityActions {
  onRetry?: () => void
  onRun?: () => void
}

export const INTEGRITY_IDLE: IntegrityModel = Object.freeze({ value: null, problem: null, running: false, runProblem: null })

/**
 * B-W2b-426 — the integrity checks on 2 · Checks: read when the step first shows (GET /accounting/integrity), read again
 * when a run ends anywhere (live `integrity_checks.ran`, nightly or by a person), and "Run the checks now" (POST …/run,
 * accounting.export; the answer replaces what is shown). Nothing is read while the step is not on screen.
 */
export function useIntegrity(api: ApiClient, companyId: string | null, enabled: boolean): { model: IntegrityModel; actions: IntegrityActions } {
  const [model, setModel] = useState<IntegrityModel>(INTEGRITY_IDLE)
  const turn = useRef(0)
  const read = useCallback(async () => {
    if (!enabled || !companyId) return
    const mine = ++turn.current
    try {
      const value = await getIntegrity(api, companyId)
      if (mine === turn.current) setModel((now) => ({ ...now, value, problem: null }))
    } catch (error) {
      if (mine === turn.current) setModel((now) => ({ ...now, value: null, problem: readProblem(error) }))
    }
  }, [api, companyId, enabled])

  useEffect(() => {
    if (enabled && !model.value && !model.problem) void read()
  }, [enabled, read, model.value, model.problem])

  const reread = useCoalesced(() => void read(), 1500)
  useLive(
    (change) => {
      if (integrityTouches(change)) reread()
    },
    () => void read(),
    enabled,
  )

  const actions: IntegrityActions = {
    onRetry: () => {
      setModel(INTEGRITY_IDLE)
      void read()
    },
    onRun: () => {
      if (!companyId || runHeld(model.value?.can ?? { run: false }, model.running)) return
      setModel((now) => ({ ...now, running: true, runProblem: null }))
      ++turn.current
      runIntegrity(api, companyId)
        .then((value) => setModel({ value, problem: null, running: false, runProblem: null }))
        .catch((error: unknown) => setModel((now) => ({ ...now, running: false, runProblem: writeProblem(error) })))
    },
  }
  return { model, actions }
}
