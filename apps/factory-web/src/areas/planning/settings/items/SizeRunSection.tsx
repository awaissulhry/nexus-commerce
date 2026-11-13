'use client'

import { useCallback, useEffect, useState } from 'react'
import type { SizeRunRule } from '@nexus/factory-domain/planning/planned-orders/rules'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { isApiError } from '../../../../lib/api/errors'
import { useOfficeApi } from '../../../../lib/session/context'
import { useLive } from '../../../_shared/buying/hooks'
import { editSiteSettings, getSiteSettings, type PlanningSettings } from '../api'
import type { TabHost } from '../model'
import { sizeRunOf, sizeRunPlan, textOfGroups, type RuleWords } from './model'
import { SizeRunView, type SizeRunModel } from './view/SizeRunView'

/** A refused size-run save in this part's words. */
function refusal(error: unknown): RuleWords {
  if (!isApiError(error)) return { key: 'items.problem.write' }
  if (error.kind === 'conflict') return { key: 'items.problem.conflict' }
  if (error.kind === 'forbidden' || error.kind === 'step_up') return { key: 'items.held.settings' }
  if (error.kind === 'invalid') return { key: 'items.sizeRun.problem.refused' }
  if (error.kind === 'unavailable') return { key: 'items.problem.unknown' }
  return { key: 'items.problem.write' }
}

/**
 * B-W2b-335 — the site's size-run rule above Item parameters: reads the site's settings (GET /planning/settings/:siteId),
 * Change… writes the rule and its groups (PATCH with the version read; planning.settings.manage), and a change made
 * elsewhere (planning.settings_changed of this site) reads it again.
 */
export function SizeRunSection({ host }: { host: TabHost }) {
  const api = useOfficeApi()
  const siteId = host.site.id
  const [load, setLoad] = useState<SizeRunModel['load']>({ status: 'loading' })
  const [settings, setSettings] = useState<PlanningSettings | null>(null)
  const [dialog, setDialog] = useState<SizeRunModel['dialog']>(null)
  const [notice, setNotice] = useState<RuleWords | null>(null)

  const read = useCallback(async () => {
    try {
      const answer = await getSiteSettings(api, siteId)
      setSettings(answer.settings)
      setLoad({ status: 'ready' })
    } catch {
      setLoad({ status: 'error', problem: 'items.sizeRun.failed' })
    }
  }, [api, siteId])
  useEffect(() => {
    setLoad({ status: 'loading' })
    void read()
  }, [read])
  useLive(
    (change) => {
      if (change.type === 'planning.settings_changed' && change.fields.siteId === siteId && !dialog?.busy) void read()
    },
    () => void read(),
  )

  const values = sizeRunOf(settings)
  const model: SizeRunModel = { load, values, canManage: host.can.manageSettings, dialog, notice }
  return (
    <SizeRunView
      model={model}
      actions={{
        onOpen: () => setDialog({ rule: values.sizeRunRule, text: textOfGroups(values.sizeGroups), busy: false, problem: null }),
        onRule: (rule: SizeRunRule) => setDialog((current) => (current ? { ...current, rule, problem: null } : current)),
        onText: (text) => setDialog((current) => (current ? { ...current, text, problem: null } : current)),
        onClose: () => setDialog((current) => (current?.busy ? current : null)),
        onRetry: () => {
          setLoad({ status: 'loading' })
          void read()
        },
        onDismissNotice: () => setNotice(null),
        onSave: () => {
          if (!dialog || dialog.busy) return
          const plan = sizeRunPlan(values, dialog.rule, dialog.text)
          if (plan.kind !== 'write') return
          setDialog({ ...dialog, busy: true, problem: null })
          editSiteSettings(api, siteId, { ...(settings?.version != null ? { version: settings.version } : {}), ...plan.body }, newIdempotencyKey())
            .then((answer) => {
              setSettings(answer.settings)
              setDialog(null)
              setNotice({ key: answer.settings.sizeRunRule === 'SIZE_GROUPS' ? 'items.sizeRun.savedGroups' : 'items.sizeRun.savedOne', params: { count: answer.settings.sizeGroups?.length ?? 0 } })
              host.onStatus({ kind: 'saved', at: new Date().toISOString() })
            })
            .catch((error: unknown) => {
              setDialog((current) => (current ? { ...current, busy: false, problem: refusal(error) } : current))
              if (isApiError(error) && error.kind === 'conflict') void read()
            })
        },
      }}
    />
  )
}
