'use client'

import { useCallback, useEffect, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { isStepUpCancelled } from '../../shared/step-up'
import { problemKey } from '../../shared/model'
import type { Read } from '../model'
import { stepUpDirty, stepUpWider, type StepUpDraft } from '../step-up/model'
import { useFreshCode } from '../step-up/fresh'
import { readSecuritySettings, saveSessionLengths, saveStepUpRules, type SecuritySettings } from './api'
import { lengthChanges, lengthErrors, lengthsOf, lengthsWider, settingsRefusal, type LengthsDraft } from './model'

export interface CardState<D> {
  /** The draft while something differs from what is in force; null: nothing typed. */
  draft: D | null
  busy: boolean
  /** A refusal or failure of the last save (a message key), and the fields it named (field → code). */
  problem: string | null
  fields: Record<string, string>
  notice: { key: string; tone: 'success' | 'warning' } | null
}
const IDLE = { draft: null, busy: false, problem: null, fields: {}, notice: null }

/**
 * Session lengths and Actions that ask for a fresh code (SCR-166, B-W2b-413): ONE read (`GET /auth/security-settings`,
 * security.view) feeds both cards; each card keeps its draft and saves alone at the version read (`PUT …/sessions`,
 * `PUT …/step-up`, security.settings.manage). A wider change opens the fresh-code dialog FIRST, then saves once; a stricter one
 * saves at once (a 403 `stepUp` is still caught). A 409 reads the settings again and says so.
 */
export function useSecuritySettings(api: ApiClient, canView: boolean) {
  const [read, setRead] = useState<Read<SecuritySettings>>(canView ? { state: 'loading' } : { state: 'no-right' })
  const [lengths, setLengths] = useState<CardState<LengthsDraft>>(IDLE)
  const [rules, setRules] = useState<CardState<StepUpDraft>>(IDLE)
  const fresh = useFreshCode(api)

  const load = useCallback(() => {
    if (!canView) return
    readSecuritySettings(api).then(
      (value) => setRead({ state: 'ok', value }),
      (error: unknown) => setRead({ state: 'failed', problem: problemKey(error) }),
    )
  }, [api, canView])
  useEffect(() => load(), [load])

  const settings = read.state === 'ok' ? read.value : null

  const saveLengths = async () => {
    if (!settings || !lengths.draft || lengths.busy) return
    const draft = lengths.draft
    if (Object.keys(lengthErrors(draft)).length > 0 || lengthChanges(settings, draft) === 0) return
    setLengths((current) => ({ ...current, busy: true, problem: null, fields: {}, notice: null }))
    try {
      const wider = lengthsWider(settings, draft)
      if (wider) await fresh.ensureFresh('lengths.freshSentence')
      const value = await fresh.guard('lengths.freshSentence', () => saveSessionLengths(api, { version: settings.version, ...draft }))
      setRead({ state: 'ok', value })
      setLengths({ ...IDLE, notice: { key: wider ? 'lengths.done.wider' : 'lengths.done.shorter', tone: 'success' } })
    } catch (error) {
      if (isStepUpCancelled(error)) return setLengths((current) => ({ ...current, busy: false }))
      const refusal = settingsRefusal(error)
      setLengths((current) => ({ ...current, busy: false, problem: refusal.notice, fields: refusal.fields }))
      if (refusal.notice === 'settings.problem.stale') load()
    }
  }

  const saveRules = async () => {
    if (!settings || !rules.draft || rules.busy || !stepUpDirty(settings, rules.draft)) return
    const draft = rules.draft
    setRules((current) => ({ ...current, busy: true, problem: null, fields: {}, notice: null }))
    try {
      const wider = stepUpWider(settings, draft)
      if (wider) await fresh.ensureFresh('fresh.freshSentence')
      const value = await fresh.guard('fresh.freshSentence', () => saveStepUpRules(api, { version: settings.version, ...draft }))
      setRead({ state: 'ok', value })
      setRules({ ...IDLE, notice: { key: wider ? 'fresh.done.wider' : 'fresh.done.stricter', tone: 'success' } })
    } catch (error) {
      if (isStepUpCancelled(error)) return setRules((current) => ({ ...current, busy: false }))
      const refusal = settingsRefusal(error)
      setRules((current) => ({ ...current, busy: false, problem: refusal.notice, fields: refusal.fields }))
      if (refusal.notice === 'settings.problem.stale') load()
    }
  }

  return {
    read,
    /** Reads the settings again without a skeleton (a live change). */
    refresh: load,
    lengths,
    rules,
    stepUp: fresh.stepUp,
    actions: {
      onRetry: () => {
        setRead({ state: 'loading' })
        load()
      },
      lengths: {
        onChange: (patch: Partial<LengthsDraft>) => settings && setLengths((current) => ({ ...current, draft: { ...(current.draft ?? lengthsOf(settings)), ...patch }, problem: null, notice: null })),
        onDiscard: () => setLengths(IDLE),
        onSave: () => void saveLengths(),
        onDismiss: () => setLengths((current) => ({ ...current, notice: null, problem: null })),
      },
      rules: {
        onChange: (next: StepUpDraft) => setRules((current) => ({ ...current, draft: next, problem: null, notice: null })),
        onDiscard: () => setRules(IDLE),
        onSave: () => void saveRules(),
        onDismiss: () => setRules((current) => ({ ...current, notice: null, problem: null })),
      },
      onStepUpSubmit: (code: string) => void fresh.submit(code),
      onStepUpClose: fresh.cancel,
    },
  }
}

export type SecuritySettingsState = ReturnType<typeof useSecuritySettings>
