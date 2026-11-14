'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, usePathname, useRouter, useSearchParams } from 'next/navigation'
import { RULE_KINDS } from '@nexus/factory-domain/alerts/kinds'
import { createTranslator, messagesFor } from '../../../lib/i18n/messages'
import { useLocale } from '../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLiveBus } from '../../../shell/live/use-live'
import { OFFICE_PAGES } from '../../../shell/nav/office-nav'
import { activateVersion, deleteDraft, draftVersion, editVersion, getKpi, installStandard, officeRoles, retireKpi, type KpiRecord, type OfficeRole } from './api'
import { download } from './files'
import { bodyOf, csvName, definitionsCsv, draftChanged, draftOf, formProblems, KPI_LIVE_EVENTS, kpiAddressOf, kpiHref, kpisCanOf, readProblem, versionsAtHand, writeProblem, type KpiAddress } from './model'
import { KpiView, type KpiConfirm, type KpiForm, type KpiModel } from './view/KpiView'

/**
 * `/w/<company>/home/kpis/<key>?tab=definition|used-in|history&period=&compare=` (SCR-470, a KPI): reads the KPI (GET
 * /insights/kpis/:key: its versions, where it is used, and its value in the address's company over the period kind asked,
 * 12 periods), reads again on the metric layer's live hints, and runs the owner's steps — a new version from the one in
 * force, the draft edited at its version, put in force, deleted, the KPI withdrawn, the standard KPIs installed — each one
 * command of the API (Idempotency-Key, version checked), refused in words. Without home.kpis.view nothing is read.
 */
export function KpiPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const route = useParams<{ key: string }>()
  const locale = useLocale()
  const key = decodeURIComponent(route.key)
  const prefix = pathname.replace(/\/home\/kpis\/[^/]+\/?$/, '')
  const can = useMemo(() => kpisCanOf(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null
  const address = useMemo(() => kpiAddressOf(params), [params])
  const [record, setRecord] = useState<KpiModel['record']>({ value: null, problem: null, reading: false })
  const [form, setForm] = useState<KpiForm | null>(null)
  const [roles, setRoles] = useState<{ value: readonly OfficeRole[] | null; problem: string | null }>({ value: null, problem: null })
  const [confirm, setConfirm] = useState<KpiConfirm | null>(null)
  const [busy, setBusy] = useState<KpiConfirm | null>(null)
  const [result, setResult] = useState<KpiModel['result']>(null)
  const asked = useRef('')

  const readKey = `${key}|${companyId ?? ''}|${address.period ?? ''}`
  const load = useCallback(async () => {
    if (!can.view) return
    asked.current = readKey
    setRecord((current) => ({ ...current, reading: true }))
    try {
      const value = await getKpi(api, key, { companyId, period: address.period })
      if (asked.current === readKey) setRecord({ value, problem: null, reading: false })
    } catch (error) {
      if (asked.current === readKey) setRecord((current) => ({ value: current.value, problem: readProblem(error), reading: false }))
    }
  }, [api, can.view, key, companyId, address.period, readKey])

  useEffect(() => {
    void load()
  }, [load])

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const later = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void load(), 1000)
  }, [load])
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])
  useLiveBus({ onChange: (change) => (KPI_LIVE_EVENTS.includes(change.type) ? later() : undefined), onReconnect: later }, can.view && form === null)

  const loadRoles = useCallback(async () => {
    if (!can.roles || roles.value) return
    try {
      setRoles({ value: await officeRoles(api), problem: null })
    } catch (error) {
      setRoles({ value: null, problem: readProblem(error) })
    }
  }, [api, can.roles, roles.value])

  const open = (mode: 'new' | 'edit') => {
    const value = record.value
    if (!value || !can.manage) return
    const hand = versionsAtHand(value)
    const base = mode === 'edit' ? hand.draft : hand.base
    if (!base) return
    const draft = draftOf(base, mode)
    setResult(null)
    setForm({ mode, base, draft, problems: formProblems(draft, base, value.calculation, mode), shown: false, busy: false, refusal: null })
    void loadRoles()
  }

  const save = async () => {
    const value = record.value
    if (!form || !value || form.busy) return
    const problems = formProblems(form.draft, form.base, value.calculation, form.mode)
    if (Object.keys(problems).length > 0) {
      setForm({ ...form, problems, shown: true })
      return
    }
    if (form.mode === 'new' && !draftChanged(form.draft, form.base) && !value.measuresDiffer) {
      setForm({ ...form, problems, shown: true, refusal: 'form.nothingChanged' })
      return
    }
    setForm({ ...form, problems, shown: true, busy: true, refusal: null })
    try {
      const body = bodyOf(form.draft, form.base, value.calculation, form.mode)
      const written =
        form.mode === 'new'
          ? await draftVersion(api, value.key, { ...body, basedOnId: form.base.id, changeNote: body.changeNote ?? form.draft.changeNote.trim() })
          : await editVersion(api, form.base.id, { ...body, version: form.base.version })
      setForm(null)
      setResult({ tone: 'success', key: form.mode === 'new' ? 'done.drafted' : 'done.edited', params: { version: written.kpiVersion } })
      await load()
    } catch (error) {
      const problem = writeProblem(error)
      setForm((current) => (current ? { ...current, busy: false, refusal: problem.field ? null : problem.key, problems: problem.field ? { ...current.problems, [problem.field]: problem.key } : current.problems } : current))
    }
  }

  const run = async (which: KpiConfirm, value: KpiRecord) => {
    const hand = versionsAtHand(value)
    setConfirm(null)
    setBusy(which)
    setResult(null)
    try {
      if (which === 'activate' && hand.draft) {
        const written = await activateVersion(api, hand.draft)
        setResult({ tone: 'success', key: 'done.activated', params: { version: written.kpiVersion } })
      } else if (which === 'delete' && hand.draft) {
        await deleteDraft(api, hand.draft)
        setResult({ tone: 'success', key: 'done.deleted', params: { version: hand.draft.kpiVersion } })
      } else if (which === 'retire' && hand.inForce) {
        const written = await retireKpi(api, value.key, hand.inForce)
        setResult({ tone: 'success', key: 'done.retired', params: { version: written.kpiVersion, count: written.usesRemoved } })
      } else if (which === 'install') {
        const answer = await installStandard(api)
        setResult({ tone: 'success', key: 'done.installed', params: { count: answer.installed.length } })
      }
      await load()
    } catch (error) {
      setResult({ tone: 'danger', key: writeProblem(error).key })
    } finally {
      setBusy(null)
    }
  }

  const exportOne = () => {
    const value = record.value
    if (!value) return
    const t = createTranslator(locale, messagesFor(locale, ['home-kpis'])['home-kpis'] ?? {})
    download(definitionsCsv([value], t, locale), csvName(value.key, new Date().toISOString().slice(0, 10)))
  }

  return (
    <KpiView
      model={{ can, prefix, key, address, record, built: OFFICE_PAGES, withCompany: companyId !== null, ruleKinds: RULE_KINDS, form, roles, confirm, busy, result }}
      actions={{
        onAddress: (next: KpiAddress) => router.replace(kpiHref(prefix, key, next), { scroll: false }),
        onRetry: () => void load(),
        onExport: exportOne,
        onOpen: (href) => router.push(`${prefix}${href}`),
        onNewVersion: () => open('new'),
        onEditDraft: () => open('edit'),
        onForm: (draft) => setForm((current) => (current && record.value ? { ...current, draft, refusal: null, problems: formProblems(draft, current.base, record.value.calculation, current.mode) } : current)),
        onFormSave: () => void save(),
        onFormCancel: () => setForm(null),
        onAsk: (which) => {
          if (!can.manage || busy) return
          setResult(null)
          setConfirm(which)
        },
        onConfirm: () => {
          if (confirm && record.value) void run(confirm, record.value)
        },
        onCancelConfirm: () => setConfirm(null),
        onDismissResult: () => setResult(null),
      }}
    />
  )
}
