'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { eoriOf } from '@nexus/factory-domain/shipping/customs/rules'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useOfficeApi } from '../../../../lib/session/context'
import { isStepUpCancelled, useStepUp } from '../../../quality/_shared/hooks'
import { useLive } from '../../shipments/hooks'
import { failed, LOADING, ready, words, writeWords } from '../../shipments/queue/shared/depth'
import type { DispatchAbilities } from '../../shipments/pickup/dispatch'
import { readCustomsSettings, setEori, switchBrokerPack } from './api'
import { packSwitchHeld, saveHeld, type EoriModel } from './model'
import { EoriView } from './view/EoriView'

/**
 * Carriers & shipping › EORI (SCR-658; B-W2b-412 on B-W2b-409): reads `GET /shipping/companies/:id/customs` (again on
 * customs.settings_changed), saves the EORI with ONE `PUT …/eori` at the company's version, and switches the chosen site's
 * broker pack with ONE `PUT /shipping/sites/:id/broker-pack` (on: the fresh code on a 403 `stepUp`, then once more with the
 * same key).
 */
export function Eori({ companyId, siteId, can }: { companyId: string; siteId: string | null; can: Pick<DispatchAbilities, 'settingsManage'> }) {
  const api = useOfficeApi()
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [state, setState] = useState<Omit<EoriModel, 'stepUp' | 'siteId' | 'can'>>({ settings: LOADING, typed: null, confirm: null, busy: false, problem: null, done: null })
  const latest = useRef(state)
  latest.current = state
  const key = useRef<string | null>(null)

  const load = useCallback(
    async (quiet: boolean) => {
      if (!quiet) setState((current) => ({ ...current, settings: current.settings.state === 'ready' ? current.settings : LOADING }))
      try {
        const settings = await readCustomsSettings(api, companyId)
        setState((current) => ({ ...current, settings: ready(settings) }))
      } catch (error) {
        setState((current) => (quiet && current.settings.state === 'ready' ? current : { ...current, settings: failed(error) }))
      }
    },
    [api, companyId],
  )
  useEffect(() => {
    void load(false)
  }, [load])
  useLive(
    (change) => {
      if (change.type === 'customs.settings_changed') void load(true)
    },
    () => void load(true),
  )

  const fail = (error: unknown) => {
    if (isStepUpCancelled(error)) return setState((now) => ({ ...now, busy: false, problem: words('eori.stepUpCancelled') }))
    const problem = writeWords(error, 'eori.refusal', [])
    setState((now) => ({ ...now, busy: false, problem: problem.key === 'problem.write.invalid' ? words('eori.problem') : { key: problem.key, params: problem.params } }))
    if (problem.reload) void load(true)
  }

  const save = async () => {
    const current = latest.current
    if (current.settings.state !== 'ready' || current.busy) return
    const settings = current.settings.value
    const typed = current.typed ?? settings.company.eori ?? ''
    if (saveHeld(settings, typed, can, false)) return
    key.current ??= newIdempotencyKey()
    const eori = typed.trim() === '' ? null : (eoriOf(typed) ?? typed.trim())
    setState({ ...current, busy: true, problem: null })
    try {
      const answer = await setEori(api, companyId, { eori, version: settings.company.version }, key.current)
      key.current = null
      setState((now) => ({ ...now, busy: false, typed: null, settings: ready(answer.settings), done: words(eori ? 'eori.done.saved' : 'eori.done.cleared', { eori: answer.settings.company.eori ?? '' }) }))
    } catch (error) {
      fail(error)
    }
  }

  const flip = async () => {
    const current = latest.current
    if (current.settings.state !== 'ready' || current.busy || !current.confirm) return
    const site = current.settings.value.sites.find((entry) => entry.siteId === siteId)
    if (!site || site.version === null || packSwitchHeld(site, can, false)) return
    const on = current.confirm === 'on'
    key.current ??= newIdempotencyKey()
    const idempotencyKey = key.current
    const version = site.version
    setState({ ...current, busy: true, problem: null })
    try {
      const answer = await guard('eori.stepUp', () => switchBrokerPack(api, site.siteId, { on, version }, idempotencyKey))
      key.current = null
      setState((now) => ({ ...now, busy: false, confirm: null, settings: ready(answer.settings), done: words(on ? 'eori.done.packOn' : 'eori.done.packOff', { site: site.code }) }))
    } catch (error) {
      fail(error)
    }
  }

  return (
    <EoriView
      model={{ ...state, siteId, can, stepUp }}
      actions={{
        onType: (typed) => {
          key.current = null
          setState((current) => ({ ...current, typed, problem: null, done: null }))
        },
        onSave: () => void save(),
        onConfirm: (confirm) => {
          if (latest.current.busy) return
          key.current = null
          setState((current) => ({ ...current, confirm, problem: null }))
        },
        onSwitch: () => void flip(),
        onRetry: () => void load(false),
        onDismiss: () => setState((current) => ({ ...current, done: null, problem: null })),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
      }}
    />
  )
}
