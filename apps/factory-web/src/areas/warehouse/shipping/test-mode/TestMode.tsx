'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../../quality/_shared/hooks'
import { useLive } from '../../shipments/hooks'
import { failed, LOADING, ready, words, writeWords } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import { readTestModes, switchTestMode } from './api'
import { liveHeld, testHeld, TEST_MODE_REFUSALS, type TestModeModel } from './model'
import { TestModeView } from './view/TestModeView'

/**
 * Carriers & shipping › Test mode of the chosen site (SCR-656; B-W2b-412 on B-W2b-390): reads `GET /shipping/test-mode`
 * (again on shipping.test_mode_changed), switches with ONE `PUT …/sites/:id/test-mode` at the settings' version; going live
 * asks a fresh code on the API's 403 `stepUp` (the DS step-up dialog) and is sent once more with the same key.
 */
export function TestMode({ companyId, siteId, can, onChanged }: { companyId: string | null; siteId: string | null; can: Pick<DispatchAbilities, 'settingsManage'>; onChanged?: () => void }) {
  const api = useOfficeApi()
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [state, setState] = useState<Omit<TestModeModel, 'stepUp' | 'siteId' | 'can'>>({ sites: LOADING, confirm: null, busy: false, problem: null, done: null })
  const latest = useRef(state)
  latest.current = state
  const key = useRef<string | null>(null)

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setState((current) => ({ ...current, sites: current.sites.state === 'ready' ? current.sites : LOADING }))
      try {
        const sites = await readTestModes(api, companyId)
        setState((current) => ({ ...current, sites: ready(sites) }))
      } catch (error) {
        setState((current) => (quiet && current.sites.state === 'ready' ? current : { ...current, sites: failed(error) }))
      }
    },
    [api, companyId],
  )
  useEffect(() => {
    void load(false)
  }, [load])
  useLive(
    (change) => {
      if (change.type === 'shipping.test_mode_changed') void load(true)
    },
    () => void load(true),
  )

  const go = async () => {
    const current = latest.current
    if (current.busy || !current.confirm || current.sites.state !== 'ready') return
    const site = current.sites.value.find((entry) => entry.siteId === siteId)
    if (!site) return
    const live = current.confirm === 'live'
    if (live ? liveHeld(site, can, false) : testHeld(site, can, false)) return
    key.current ??= newIdempotencyKey()
    const idempotencyKey = key.current
    setState({ ...current, busy: true, problem: null })
    try {
      const answer = await guard('test.stepUp', () => switchTestMode(api, site.siteId, { testMode: !live, ...(site.version ? { version: site.version } : {}) }, idempotencyKey))
      key.current = null
      setState((now) => ({
        ...now,
        busy: false,
        confirm: null,
        done: live ? words('test.done.live', { site: site.code, count: answer.clearedTestLabels }) : words('test.done.test', { site: site.code }),
        sites: now.sites.state === 'ready' ? ready(now.sites.value.map((entry) => (entry.siteId === answer.site.siteId ? answer.site : entry))) : now.sites,
      }))
      onChanged?.()
    } catch (error) {
      if (isStepUpCancelled(error)) return setState((now) => ({ ...now, busy: false, problem: words('test.stepUpCancelled') }))
      const problem = writeWords(error, 'test.refusal', TEST_MODE_REFUSALS)
      setState((now) => ({ ...now, busy: false, problem: { key: problem.key, params: problem.params } }))
      if (problem.reload) void load(true)
    }
  }

  return (
    <TestModeView
      model={{ ...state, siteId, can, stepUp }}
      actions={{
        onConfirm: (confirm) => {
          if (latest.current.busy) return
          key.current = null
          setState((current) => ({ ...current, confirm, problem: null }))
        },
        onGo: () => void go(),
        onRetry: () => void load(false),
        onDismiss: () => setState((current) => ({ ...current, done: null, problem: null })),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
