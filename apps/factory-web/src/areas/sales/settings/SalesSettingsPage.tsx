'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { REASON_LIST_GROUPS } from '@nexus/factory-domain/reasons/lists'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { ReasonListsEditor } from '../../_shared/reasons/ReasonListsEditor'
import { liveMatches, useLive } from '../../quality/_shared/hooks'
import { problemKey } from '../../quality/_shared/model'
import { getReturnPolicy, getSalesSettings, listSeries, saveReturnPolicy, saveSalesSettings, type PolicyAnswer, type SalesSettings, type Series } from './api'
import { LIVE_TYPES, policyBody, policyDraftOf, policyProblems, quoteBody, quoteDraftOf, quoteProblems, refusalOf, settingsCan, type Scope } from './model'
import { SalesSettingsView, type Read, type SalesSettingsModel } from './view/SalesSettingsView'

/**
 * `/w/<company>/sales/settings` (SCR-235): reads the sales settings and the return policy of the scope (this company, or
 * the group-wide row: `?scope=group`), and this company's number series (numbering.view); one card is edited at a time
 * and applied explicitly at the row's version (both cards of the quote rules share the row: a save sends both). A
 * company that follows the group's settings gets its own with "Give this company its own settings" (a first save of its
 * quote rules with the values in force). Live `sales_settings.changed` / `return_policy.changed` from someone else →
 * "Changed by someone else · Reload". The reason lists are the shared editor (RETURN and CANCEL).
 */
export function SalesSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const can = useMemo(() => settingsCan(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const company = session.company
  const [scope, setScope] = useState<Scope>(company ? 'company' : 'group')
  const companyId = scope === 'company' ? (company?.id ?? null) : null
  const [settings, setSettings] = useState<Read<SalesSettings>>({ value: null, problem: null })
  const [policy, setPolicy] = useState<Read<PolicyAnswer>>({ value: null, problem: null })
  const [series, setSeries] = useState<Read<readonly Series[]> | null>(null)
  const [edit, setEdit] = useState<SalesSettingsModel['edit']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedAt, setChangedAt] = useState<string | null>(null)
  const [receipt, setReceipt] = useState<SalesSettingsModel['receipt']>(null)
  const [offline, setOffline] = useState(false)
  const saving = useRef(false)
  const editing = useRef(false)
  editing.current = edit !== null

  useEffect(() => {
    const update = () => setOffline(typeof navigator !== 'undefined' && navigator.onLine === false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const load = useCallback(async () => {
    const [settingsAnswer, policyAnswer] = await Promise.allSettled([can.quotesView ? getSalesSettings(api, companyId) : Promise.reject(new Error('no right')), can.returnsView ? getReturnPolicy(api, companyId) : Promise.reject(new Error('no right'))])
    setSettings(settingsAnswer.status === 'fulfilled' ? { value: settingsAnswer.value, problem: null } : { value: null, problem: can.quotesView ? `quality:${problemKey(settingsAnswer.reason)}` : null })
    setPolicy(policyAnswer.status === 'fulfilled' ? { value: policyAnswer.value, problem: null } : { value: null, problem: can.returnsView ? `quality:${problemKey(policyAnswer.reason)}` : null })
    setAsOf(new Date().toISOString())
    setChangedAt(null)
  }, [api, can.quotesView, can.returnsView, companyId])

  useEffect(() => {
    setSettings({ value: null, problem: null })
    setPolicy({ value: null, problem: null })
    setEdit(null)
    void load()
  }, [load])

  useEffect(() => {
    if (!can.numberingView || !company) return setSeries(null)
    setSeries({ value: null, problem: null })
    listSeries(api, company.id)
      .then((value) => setSeries({ value, problem: null }))
      .catch((error) => setSeries({ value: null, problem: `quality:${problemKey(error)}` }))
  }, [api, can.numberingView, company])

  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE_TYPES) || saving.current) return
      if (editing.current) setChangedAt(new Date().toISOString())
      else void load()
    },
    () => void load(),
  )

  const save = async () => {
    const current = edit
    if (!current || current.busy || !settings.value) return
    const problems = current.card === 'policy' ? policyProblems(current.policy) : quoteProblems(current.quote, can.margin)
    if (problems.length > 0) return setEdit({ ...current, showProblems: true })
    setEdit({ ...current, busy: true, problem: null })
    saving.current = true
    try {
      if (current.card === 'policy') {
        if (!policy.value) return
        await saveReturnPolicy(api, policyBody(current.policy, policy.value, scope, company?.id ?? ''))
      } else {
        await saveSalesSettings(api, quoteBody(current.quote, settings.value, scope, company?.id ?? ''))
      }
      setEdit(null)
      setReceipt({ tone: 'success', words: { key: `done.${current.card}` } })
      await load()
    } catch (error) {
      setEdit((open) => (open ? { ...open, busy: false, problem: refusalOf(error), showProblems: true } : open))
    } finally {
      saving.current = false
    }
  }

  const ownSettings = async () => {
    if (!settings.value || !company) return
    saving.current = true
    try {
      await saveSalesSettings(api, quoteBody(quoteDraftOf(settings.value, 'company'), { ...settings.value, company: null }, 'company', company.id))
      setReceipt({ tone: 'success', words: { key: 'done.own', params: { code: company.code } } })
      await load()
    } catch (error) {
      setReceipt({ tone: 'danger', words: refusalOf(error) })
    } finally {
      saving.current = false
    }
  }

  const model: SalesSettingsModel = {
    prefix,
    can,
    company: company ? { code: company.code, name: company.name } : null,
    scope,
    settings,
    policy,
    series: scope === 'company' ? series : null,
    edit,
    asOf,
    live,
    offline,
    changedAt,
    receipt,
  }

  return (
    <SalesSettingsView
      model={model}
      reasons={can.reasonsView ? <ReasonListsEditor lists={REASON_LIST_GROUPS.sales} /> : undefined}
      actions={{
        onScope: setScope,
        onEdit: (card) => {
          if (!card) return setEdit(null)
          if (!settings.value && card !== 'policy') return
          setEdit({
            card,
            quote: settings.value ? quoteDraftOf(settings.value, scope) : { marginFloorPct: '', discountLimitPct: '', validityDays: '', depositPct: '' },
            policy: policy.value ? policyDraftOf(policy.value, scope) : { windowDays: '', goodsDueDays: '', freightPaidBy: '', restockingFeePct: '', conditions: '' },
            busy: false,
            problem: null,
            showProblems: false,
          })
        },
        onQuoteDraft: (patch) => setEdit((open) => (open ? { ...open, quote: { ...open.quote, ...patch } } : open)),
        onPolicyDraft: (patch) => setEdit((open) => (open ? { ...open, policy: { ...open.policy, ...patch } } : open)),
        onSave: () => void save(),
        onOwnSettings: () => void ownSettings(),
        onReload: () => void load(),
        onRetry: () => void load(),
        onDismissReceipt: () => setReceipt(null),
      }}
    />
  )
}
