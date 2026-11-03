'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { isStepUpCancelled, liveMatches, useLive, useStepUp } from '../_shared/hooks'
import { failedRead, reading, ready, type Notice, type Read } from '../_shared/model'
import {
  addStarterRules,
  createAlertRule,
  deleteAlertRule,
  editAlertRule,
  findCustomers,
  readAlertRules,
  readRules,
  saveDuties,
  saveResults,
  testAlertRule,
  type AlertRule,
  type AlertRules,
  type Customer,
  type Rules,
} from './api'
import {
  addressOf,
  dutiesBody,
  dutiesChanges,
  dutiesDraftOf,
  dutiesLooseningsOf,
  LIVE_EVENTS,
  removedCustomers,
  problemOf,
  queryOf,
  readProblemOf,
  resultsBody,
  resultsChanges,
  resultsDraftOf,
  resultsProblem,
  ruleBody,
  ruleDraftOf,
  ruleEdit,
  ruleProblems,
  type Address,
  type DutiesDraft,
  type ResultsDraft,
  type RuleDraft,
} from './model'
import { RulesView, type RulesModel } from './view/RulesView'

/**
 * The Quality rules container (`/w/<company>/quality/settings`, SCR-260): reads the scope's rules and every company's (what
 * a company follows), and the alert rules; keeps the address (`?scope=all`, `?rule=<id>|new`); saves each card at the
 * version read (a looser rule: the confirm with the reason, then the fresh code through the step-up dialog); keeps the
 * alert rules one write each (the list's switch, the dialog, a test to me, remove, the starter rules); listens to the live
 * stream (a change elsewhere re-reads, or says so when this page holds unsaved changes).
 */
export function RulesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const permissions = useMemo(() => new Set(session.permissions), [session.permissions])
  const canView = permissions.has('quality.rules.view')
  const address = addressOf(params)
  const companyId = session.company?.id ?? null
  const scopeCompany = address.scope === 'company' ? companyId : null
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const [rules, setRules] = useState<Read<Rules>>(reading())
  const [tenant, setTenant] = useState<Read<Rules>>(reading())
  const [alerts, setAlerts] = useState<Read<AlertRules>>(reading())
  const [duties, setDuties] = useState<DutiesDraft | null>(null)
  const [results, setResults] = useState<ResultsDraft | null>(null)
  const [customers, setCustomers] = useState<Read<Customer[]> | null>(null)
  const [busy, setBusy] = useState<RulesModel['busy']>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loosen, setLoosen] = useState<RulesModel['loosen']>(null)
  const [ruleDialog, setRuleDialog] = useState<RulesModel['ruleDialog']>(null)
  const [remove, setRemove] = useState<RulesModel['remove']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const createKey = useRef<string | null>(null)

  const writeAddress = useCallback((next: Address) => router.replace(`${pathname}${queryOf(next)}`, { scroll: false }), [pathname, router])

  // ---- reads ----
  const loadRules = useCallback(async () => {
    if (!canView) return
    try {
      const [scoped, all] = await Promise.all([readRules(api, scopeCompany), scopeCompany ? readRules(api, null) : Promise.resolve(null)])
      setRules(ready(scoped))
      setTenant(ready(all ?? scoped))
      setDuties(dutiesDraftOf(scoped))
      setResults(resultsDraftOf(scoped))
      setAsOf(new Date().toISOString())
      setChangedElsewhere(false)
    } catch (error) {
      setRules(failedRead(readProblemOf(error)))
      setTenant(failedRead(readProblemOf(error)))
    }
  }, [api, canView, scopeCompany])
  const loadAlerts = useCallback(async () => {
    if (!canView) return
    try {
      setAlerts(ready(await readAlertRules(api, scopeCompany)))
    } catch (error) {
      setAlerts(failedRead(readProblemOf(error)))
    }
  }, [api, canView, scopeCompany])
  useEffect(() => {
    setRules(reading())
    setAlerts(reading())
    setSelected([])
    void loadRules()
    void loadAlerts()
  }, [loadRules, loadAlerts])

  const dirty = !!(rules.value && duties && results && (dutiesChanges(rules.value, duties) > 0 || resultsChanges(rules.value, results) > 0))
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const versionRef = useRef<string | null>(null)
  versionRef.current = rules.value ? `${rules.value.version}:${tenant.value?.version ?? ''}` : null
  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE_EVENTS)) return
      if (change.type === 'quality.alert_rule_changed' || change.type === 'quality.alert_fired') {
        void loadAlerts()
        return
      }
      if (!dirtyRef.current) {
        void loadRules()
        return
      }
      // Unsaved changes here: say so only when the row really moved past what this page read (our own save's event does not).
      Promise.all([readRules(api, scopeCompany), scopeCompany ? readRules(api, null) : Promise.resolve(null)])
        .then(([scoped, all]) => `${scoped.version}:${(all ?? scoped).version}` !== versionRef.current && setChangedElsewhere(true))
        .catch(() => undefined)
    },
    () => {
      if (!dirtyRef.current) void loadRules()
      void loadAlerts()
    },
  )

  // ---- the rule dialog follows the address ----
  useEffect(() => {
    if (!address.rule || !alerts.value) {
      if (!address.rule) setRuleDialog(null)
      return
    }
    if (ruleDialog && (ruleDialog.draft.id ?? 'new') === address.rule) return
    const rule = address.rule === 'new' ? null : (alerts.value.rules.find((entry) => entry.id === address.rule) ?? null)
    if (address.rule !== 'new' && !rule) {
      setNotice({ key: 'problem.ruleGone', tone: 'warning' })
      writeAddress({ ...address, rule: null })
      return
    }
    createKey.current = null
    const defaults = { companyId: alerts.value.places.everywhere ? null : (alerts.value.places.companies[0]?.id ?? scopeCompany), roleId: null }
    setRuleDialog({ draft: ruleDraftOf(rule, defaults), problem: null, shown: false })
    // Only the address and the read open it.
  }, [address.rule, alerts.value])

  // ---- who may sign what ----
  const sendDuties = useCallback(
    async (reason: string | null, loosens: boolean) => {
      if (!rules.value || !duties) return
      setBusy('duties')
      const key = newIdempotencyKey()
      try {
        const run = () => saveDuties(api, dutiesBody(rules.value!, duties, reason), key)
        const answer = loosens ? await guard('stepUp.loosen', run) : await run()
        setRules(ready(answer.rules))
        if (!scopeCompany) setTenant(ready(answer.rules))
        setDuties(dutiesDraftOf(answer.rules))
        setLoosen(null)
        setNotice({ key: answer.loosened.length > 0 ? 'done.dutiesLoosened' : 'done.duties', tone: 'success' })
        setAsOf(new Date().toISOString())
      } catch (error) {
        if (isStepUpCancelled(error)) return
        const problem = problemOf(error)
        setNotice({ key: problem, tone: 'danger' })
        if (problem === 'problem.stale' || problem === 'problem.changedMeanwhile') {
          setLoosen(null)
          void loadRules()
        }
      } finally {
        setBusy(null)
      }
    },
    [api, duties, guard, loadRules, rules.value, scopeCompany],
  )

  const applyDuties = useCallback(() => {
    if (!rules.value || !duties) return
    const codes = dutiesLooseningsOf(rules.value, tenant.value, duties)
    if (codes.length > 0) setLoosen({ reason: '', codes, removed: removedCustomers(rules.value, duties) })
    else void sendDuties(null, false)
  }, [duties, rules.value, sendDuties, tenant.value])

  // ---- result rules ----
  const applyResults = useCallback(async () => {
    if (!rules.value || !results || resultsProblem(results)) return
    setBusy('results')
    try {
      const answer = await saveResults(api, resultsBody(rules.value, results), newIdempotencyKey())
      setRules(ready(answer.rules))
      if (!scopeCompany) setTenant(ready(answer.rules))
      setResults(resultsDraftOf(answer.rules))
      setNotice({ key: 'done.results', tone: 'success' })
    } catch (error) {
      const problem = problemOf(error)
      setNotice({ key: problem, tone: 'danger' })
      if (problem === 'problem.stale') void loadRules()
    } finally {
      setBusy(null)
    }
  }, [api, loadRules, results, rules.value, scopeCompany])

  // ---- alert rules ----
  const withRule = (rule: AlertRule) => setAlerts((current) => (current.value ? ready({ ...current.value, rules: current.value.rules.map((entry) => (entry.id === rule.id ? rule : entry)) }) : current))

  const saveRule = useCallback(async () => {
    if (!ruleDialog || !alerts.value) return
    const draft = ruleDialog.draft
    const problems = ruleProblems(draft)
    if (Object.keys(problems).length > 0) {
      setRuleDialog({ ...ruleDialog, shown: true })
      return
    }
    setBusy('alerts')
    try {
      if (draft.id) {
        const rule = alerts.value.rules.find((entry) => entry.id === draft.id)
        if (!rule) return
        const edit = ruleEdit(rule, draft)
        if (Object.keys(edit).length > 0) withRule((await editAlertRule(api, rule.id, rule.version, edit, newIdempotencyKey())).rule)
        setNotice({ key: 'done.ruleSaved', tone: 'success' })
      } else {
        createKey.current ??= newIdempotencyKey()
        await createAlertRule(api, ruleBody(draft), createKey.current)
        createKey.current = null
        setNotice({ key: 'done.ruleAdded', tone: 'success' })
      }
      setRuleDialog(null)
      writeAddress({ ...address, rule: null })
      await loadAlerts()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const problem = problemOf(error)
      setRuleDialog({ ...ruleDialog, problem, shown: true })
      if (problem === 'problem.stale') void loadAlerts()
    } finally {
      setBusy(null)
    }
  }, [address, alerts.value, api, loadAlerts, ruleDialog, writeAddress])

  const setEnabled = useCallback(
    async (targets: readonly AlertRule[], enabled: boolean) => {
      const changing = targets.filter((rule) => rule.enabled !== enabled)
      if (changing.length === 0) return
      setBusy('alerts')
      let done = 0
      const refused: string[] = []
      for (const rule of changing) {
        try {
          withRule((await editAlertRule(api, rule.id, rule.version, { enabled }, newIdempotencyKey())).rule)
          done += 1
        } catch (error) {
          refused.push(problemOf(error))
        }
      }
      setBusy(null)
      setNotice({ key: enabled ? 'done.switchedOn' : 'done.switchedOff', params: { count: done }, tone: refused.length > 0 ? 'warning' : 'success' })
      if (refused.includes('problem.stale')) void loadAlerts()
    },
    [api, loadAlerts],
  )

  const confirmRemove = useCallback(async () => {
    if (!remove || !alerts.value) return
    setBusy('alerts')
    let done = 0
    for (const id of remove.ids) {
      const rule = alerts.value.rules.find((entry) => entry.id === id)
      if (!rule) continue
      try {
        await deleteAlertRule(api, rule.id, rule.version, newIdempotencyKey())
        done += 1
      } catch {
        // Said in the notice's count; the list is read again.
      }
    }
    setBusy(null)
    setRemove(null)
    setSelected([])
    setNotice({ key: 'done.removed', params: { count: done }, tone: done === remove.ids.length ? 'success' : 'warning' })
    await loadAlerts()
  }, [alerts.value, api, loadAlerts, remove])

  const test = useCallback(
    async (rule: AlertRule) => {
      setBusy('alerts')
      try {
        await testAlertRule(api, rule.id, newIdempotencyKey())
        setNotice({ key: 'done.tested', tone: 'success' })
      } catch (error) {
        setNotice({ key: problemOf(error), tone: 'danger' })
      } finally {
        setBusy(null)
      }
    },
    [api],
  )

  const starter = useCallback(async () => {
    setBusy('alerts')
    try {
      const answer = await addStarterRules(api, newIdempotencyKey())
      setNotice({ key: 'done.starter', params: { count: answer.added.length }, tone: 'success' })
      await loadAlerts()
    } catch (error) {
      setNotice({ key: problemOf(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [api, loadAlerts])

  const pickCustomers = useCallback(async () => {
    setCustomers(reading())
    try {
      setCustomers(ready(await findCustomers(api, '')))
    } catch (error) {
      setCustomers(failedRead(readProblemOf(error)))
    }
  }, [api])

  const model: RulesModel = {
    prefix: companyPrefix(session.company?.code ?? ''),
    address,
    companyName: session.company?.name ?? session.company?.code ?? '',
    canView,
    rules,
    tenant,
    alerts,
    duties,
    results,
    customers,
    canPickCustomers: permissions.has('parties.view'),
    busy,
    selected,
    notice,
    loosen,
    ruleDialog,
    remove,
    stepUp,
    live,
    asOf,
    changedElsewhere,
    keysOpen,
  }

  return (
    <RulesView
      model={model}
      actions={{
        onScope: (scope) => writeAddress({ scope, rule: null }),
        onDuties: setDuties,
        onDiscardDuties: () => rules.value && setDuties(dutiesDraftOf(rules.value)),
        onApplyDuties: applyDuties,
        onLoosenReason: (reason) => loosen && setLoosen({ ...loosen, reason }),
        onLoosenConfirm: () => loosen && void sendDuties(loosen.reason.trim(), true),
        onLoosenCancel: () => setLoosen(null),
        onResults: setResults,
        onDiscardResults: () => rules.value && setResults(resultsDraftOf(rules.value)),
        onApplyResults: () => void applyResults(),
        onPickCustomers: () => void pickCustomers(),
        onSelect: (ids) => setSelected([...ids]),
        onRuleOpen: (id) => writeAddress({ ...address, rule: id }),
        onRuleDraft: (draft: RuleDraft) => ruleDialog && setRuleDialog({ ...ruleDialog, draft, problem: null }),
        onRuleSave: () => void saveRule(),
        onRuleClose: () => {
          setRuleDialog(null)
          writeAddress({ ...address, rule: null })
        },
        onRuleEnabled: (rule, enabled) => void setEnabled([rule], enabled),
        onRuleTest: (rule) => void test(rule),
        onRuleRemove: (ids) => ids.length > 0 && setRemove({ ids: [...ids] }),
        onConfirmRemove: () => void confirmRemove(),
        onCancelRemove: () => setRemove(null),
        onBulkEnabled: (enabled) => void setEnabled((alerts.value?.rules ?? []).filter((rule) => selected.includes(rule.id)), enabled),
        onStarter: () => void starter(),
        onRetryAlerts: () => void loadAlerts(),
        onKeys: () => setKeysOpen(true),
        onKeysClose: () => setKeysOpen(false),
        onStepUp: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onReload: () => {
          void loadRules()
          void loadAlerts()
        },
        onRetry: () => void loadRules(),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
