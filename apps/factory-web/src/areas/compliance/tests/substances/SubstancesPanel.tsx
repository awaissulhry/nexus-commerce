'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../../lib/api/client'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { useOfficeApi, useOfficeSession } from '../../../../lib/session/context'
import { csvLine, downloadText, liveMatches, useLive } from '../../../quality/_shared/hooks'
import { failedRead, problemKey, ready, reading, type Notice, type Read } from '../../../quality/_shared/model'
import { todayInRome, writeProblemKey } from '../declarations/model'
import { listProfiles } from '../profiles/api'
import { createPlan, createVersion, editPlan, listPlans, listRules, listSubstances, listVersions, loadStarter, switchPlan, switchRule, type PlansAnswer, type RulesAnswer, type SubstancesAnswer, type TestPlan, type VersionsAnswer } from './api'
import { DEPTH_NAMESPACE } from './frame/parts'
import type { PageFrame } from './frame/views'
import { blankPlan, blankVersion, planBodyOf, planChanges, planDraftOf, substancesAddressOf, substancesAddressText, substancesCan, substancesCsv, type PlanDraft, type SubstancesAddress, type SubstancesPart, type VersionDraft } from './model'
import type { MaterialChoice, PlanDialog, SwitchDialog } from './view-model'
import { SubstancesView } from './view/SubstancesView'

const EVENTS = ['compliance_substances.', 'compliance_material_tests.test_plan_changed']

/**
 * `?view=substances` of Compliance › Tests & substances (B-W2b-267 on B-W2b-250's and B-W2b-256's API): one part at a time
 * (`part=substances|rules|plans`), each its own read with the address's filters; the Candidate List versions beside the
 * substances; the dialogs open from the address (`switch=<id>`, `plan=<id>|new`, `version=new`) and write ONE command each
 * with its own Idempotency-Key, at the version read (a refusal is said in our words and the part is read again). Live:
 * `compliance_substances.*` and the plan rules' changes count as "N updates · Show".
 */
export function SubstancesPanel({ frame }: { frame: PageFrame }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const t = useT(DEPTH_NAMESPACE)
  const locale = useLocale()
  const can = useMemo(() => substancesCan(session.permissions), [session.permissions])
  const address = useMemo(() => substancesAddressOf(params), [params])
  const prefix = pathname.replace(/\/compliance\/tests\/?$/, '')
  const today = useMemo(() => todayInRome(), [])

  const [substances, setSubstances] = useState<Read<SubstancesAnswer>>(reading())
  const [rules, setRules] = useState<Read<RulesAnswer>>(reading())
  const [versions, setVersions] = useState<Read<VersionsAnswer>>(reading())
  const [plans, setPlans] = useState<Read<PlansAnswer>>(reading())
  const [materials, setMaterials] = useState<Read<readonly MaterialChoice[]>>(reading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [updates, setUpdates] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [planDraft, setPlanDraft] = useState<PlanDraft | null>(null)
  const [versionDraft, setVersionDraft] = useState<VersionDraft | null>(null)
  const [starterConfirm, setStarterConfirm] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const turn = useRef(0)

  useEffect(() => {
    const update = () => setOnline(typeof navigator === 'undefined' || navigator.onLine !== false)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  const go = useCallback((change: Partial<SubstancesAddress>) => router.replace(`${pathname}${substancesAddressText({ ...address, ...change })}`, { scroll: false }), [router, pathname, address])
  const { part, list, q, all } = address
  const status = all ? ('ALL' as const) : null

  const read = useCallback(async () => {
    if (!can.view) return
    const mine = ++turn.current
    const done = (at: string) => {
      if (mine !== turn.current) return false
      setAsOf(at)
      setUpdates(0)
      return true
    }
    if (part === 'substances') {
      listVersions(api).then((value) => mine === turn.current && setVersions(ready(value)), (error: unknown) => mine === turn.current && setVersions(failedRead(problemKey(error))))
      try {
        const value = await listSubstances(api, { list, status, q })
        if (done(value.asOf)) setSubstances(ready(value))
      } catch (error) {
        if (mine === turn.current) setSubstances(failedRead(problemKey(error)))
      }
    } else if (part === 'rules') {
      try {
        const value = await listRules(api, { q, status })
        if (done(value.asOf)) setRules(ready(value))
      } catch (error) {
        if (mine === turn.current) setRules(failedRead(problemKey(error)))
      }
    } else {
      listRules(api, {}).then((value) => setRules(ready(value)), () => undefined)
      try {
        const value = await listPlans(api, { status })
        if (done(value.asOf)) setPlans(ready(value))
      } catch (error) {
        if (mine === turn.current) setPlans(failedRead(problemKey(error)))
      }
    }
  }, [api, can.view, part, list, status, q])
  useEffect(() => {
    setSelected([])
    const timer = setTimeout(() => void read(), q ? 250 : 0)
    return () => clearTimeout(timer)
  }, [read, q])
  const readRef = useRef(read)
  readRef.current = read
  const live = useLive(
    (change) => {
      if (can.view && liveMatches(change, EVENTS)) setUpdates((count) => count + 1)
    },
    () => void readRef.current(),
  )

  // ---- dialogs from the address -----------------------------------------------------------------------------------------
  const planId = address.plan
  const planRow = planId && planId !== 'new' ? (plans.value?.plans.find((plan) => plan.id === planId) ?? null) : null
  useEffect(() => {
    setDialogProblem(null)
    if (!planId) return setPlanDraft(null)
    if (planId === 'new') return setPlanDraft(blankPlan())
    if (planRow) setPlanDraft(planDraftOf(planRow))
  }, [planId, planRow])
  useEffect(() => {
    if (!planDraft || planDraft.scope !== 'MATERIAL' || materials.value !== null) return
    listProfiles(api, {}).then(
      (answer) => setMaterials(ready(answer.profiles.map((row) => ({ id: row.material.id, code: row.material.code, name: row.material.name, kind: row.material.kind })))),
      (error: unknown) => setMaterials(failedRead(problemKey(error))),
    )
  }, [api, planDraft, materials.value])
  useEffect(() => {
    setDialogProblem(null)
    setVersionDraft(address.version ? blankVersion(today) : null)
  }, [address.version, today])
  useEffect(() => {
    setReason('')
    setDialogProblem(null)
  }, [address.switchId])

  const switchDialog: SwitchDialog | null = address.switchId && (part === 'rules' || part === 'plans') ? { id: address.switchId, kind: part === 'rules' ? 'rule' : 'plan', reason } : null
  const planDialog: PlanDialog | null = planId && planDraft ? { id: planId, draft: planDraft } : null
  const closeDialog = () => go({ switchId: null, plan: null, version: false })

  const write = async (verb: string, work: () => Promise<unknown>, success: Notice, close = true) => {
    setBusy(true)
    setDialogProblem(null)
    try {
      await work()
      setNotice(success)
      if (close) closeDialog()
      void read()
      return true
    } catch (error) {
      setDialogProblem(writeProblemKey(verb, error))
      void read()
      return false
    } finally {
      setBusy(false)
    }
  }

  const switchConfirm = async () => {
    if (!switchDialog) return
    if (switchDialog.kind === 'rule') {
      const rule = rules.value?.rules.find((row) => row.id === switchDialog.id)
      if (!rule) return
      await write('switch', () => switchRule(api, rule, !rule.switchedOn, reason, newIdempotencyKey()), { key: rule.switchedOn ? 'done.switchedOff' : 'done.switchedOn', params: { name: rule.key }, tone: 'success' })
    } else {
      const plan = plans.value?.plans.find((row) => row.id === switchDialog.id)
      if (!plan) return
      await write('switch', () => switchPlan(api, plan, !plan.switchedOn, reason, newIdempotencyKey()), { key: plan.switchedOn ? 'done.switchedOff' : 'done.switchedOn', params: { name: t(`test.${plan.test}`) }, tone: 'success' })
    }
  }
  const planSave = async () => {
    if (!planDialog) return
    const draft = planDialog.draft
    if (planDialog.id === 'new') {
      await write('plan', () => createPlan(api, { ...planBodyOf(draft), companyId: null, switchedOn: draft.switchedOn, offReason: draft.switchedOn ? null : draft.offReason.trim() }, newIdempotencyKey()), { key: 'done.planCreated', params: { test: t(`test.${draft.test}`) }, tone: 'success' })
    } else if (planRow) {
      await write('plan', () => editPlan(api, planRow, planChanges(planRow, draft), newIdempotencyKey()), { key: 'done.planSaved', params: { test: t(`test.${draft.test}`) }, tone: 'success' })
    }
  }
  const archivePlan = async (plan: TestPlan) => {
    const archive = plan.status === 'ACTIVE'
    const ok = await write('plan', () => editPlan(api, plan, { status: archive ? 'ARCHIVED' : 'ACTIVE' }, newIdempotencyKey()), { key: archive ? 'done.planArchived' : 'done.planRestored', params: { test: t(`test.${plan.test}`) }, tone: 'success' }, false)
    if (!ok) setNotice({ key: 'problem.plan.failed', tone: 'danger' })
  }
  const versionSave = async () => {
    if (!versionDraft) return
    await write(
      'version',
      () => createVersion(api, { publishedOn: versionDraft.publishedOn, entryCount: Number(versionDraft.entryCount), source: versionDraft.source.trim(), sourceUrl: versionDraft.sourceUrl.trim() || null, note: versionDraft.note.trim() || null }, newIdempotencyKey()),
      { key: 'done.versionAdded', params: { count: Number(versionDraft.entryCount) }, tone: 'success' },
    )
  }
  const starter = async () => {
    setBusy(true)
    setDialogProblem(null)
    try {
      const answer = await loadStarter(api, newIdempotencyKey())
      setStarterConfirm(false)
      setNotice({ key: 'done.starter', params: { substances: answer.substances.added, rules: answer.rules.added }, tone: 'success' })
      void read()
    } catch (error) {
      setDialogProblem(writeProblemKey('starter', error))
    } finally {
      setBusy(false)
    }
  }
  const exportRows = (which: SubstancesPart, ids: readonly string[] | null) => {
    const pick = <T extends { id: string }>(rows: readonly T[]) => (ids ? rows.filter((row) => ids.includes(row.id)) : rows)
    let table: string[][]
    if (which === 'substances') table = substancesCsv(pick(substances.value?.substances ?? []), t, locale)
    else if (which === 'rules')
      table = [
        ['csv.key', 'csv.rule', 'csv.limit', 'csv.law', 'csv.switch', 'csv.offReason'].map((key) => t(key)),
        ...pick(rules.value?.rules ?? []).map((rule) => [rule.key, t(`ruleCode.${rule.code}`), rule.limitValue ?? '', rule.legalReference, t(rule.switchedOn ? 'switch.on' : 'switch.off'), rule.offReason ?? '']),
      ]
    else
      table = [
        ['csv.test', 'csv.what', 'csv.frequency', 'csv.market', 'csv.key', 'csv.switch', 'csv.offReason'].map((key) => t(key)),
        ...pick(plans.value?.plans ?? []).map((plan) => [t(`test.${plan.test}`), plan.item ? `${plan.item.code} · ${plan.item.name}` : t(`materialKind.${plan.itemKind ?? 'LEATHER'}`), t(`frequency.${plan.frequency}`), plan.marketCode ?? '', plan.substanceRule?.key ?? '', t(plan.switchedOn ? 'switch.on' : 'switch.off'), plan.offReason ?? '']),
      ]
    downloadText(`${which}-${today}.csv`, table.map(csvLine).join('\r\n'))
    setNotice({ key: 'done.exported', params: { count: table.length - 1 }, tone: 'success' })
  }

  return (
    <SubstancesView
      model={{ prefix, can, online, today, frame, address, substances, rules, versions, plans, materials, asOf, live, updates, selected, notice, busy, switchDialog, planDialog, versionDraft, starterConfirm, keysOpen, dialogProblem }}
      actions={{
        onAddress: (change) => {
          if (change.part !== undefined && change.part !== part) setSelected([])
          go(change)
        },
        onRetry: () => void read(),
        onShowUpdates: () => void read(),
        onSelect: (ids) => setSelected([...ids]),
        onExport: exportRows,
        onStarter: (open) => {
          setDialogProblem(null)
          setStarterConfirm(open)
        },
        onStarterConfirm: () => void starter(),
        onKeys: setKeysOpen,
        onDismissNotice: () => setNotice(null),
        onSwitchReason: setReason,
        onSwitchConfirm: () => void switchConfirm(),
        onCloseDialog: closeDialog,
        onPlanChange: setPlanDraft,
        onPlanSave: () => void planSave(),
        onArchivePlan: (plan) => void archivePlan(plan),
        onVersionChange: setVersionDraft,
        onVersionSave: () => void versionSave(),
      }}
    />
  )
}
