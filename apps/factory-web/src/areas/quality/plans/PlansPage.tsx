'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { liveMatches, STEP_UP_CLOSED, useLive } from '../_shared/hooks'
import { failedRead, reading, ready, type Notice, type Read } from '../_shared/model'
import {
  addStarter,
  assignProfile,
  calculate,
  createPlan,
  createProfile,
  createRule,
  deleteRule,
  editProfile,
  editRule,
  endAssignment,
  orderRules,
  pickRecords,
  previewRule,
  readAssignments,
  readPlans,
  readProfiles,
  readRules,
  readStarter,
  type AqlPlanView,
  type Assignment,
  type PickOption,
  type PlansAnswer,
  type ProfilesAnswer,
  type RulesAnswer,
  type Starter,
} from './api'
import {
  addressOf,
  codeOf,
  editProfileBody,
  NEW_PLAN,
  newPlanProblems,
  newProfile,
  newRule,
  planHref,
  problemOf,
  profileChanges,
  profileDraftOf,
  profilePlan,
  profilesProblems,
  queryOf,
  ruleBody,
  ruleDraftOf,
  ruleProblems,
  rulesChanges,
  rulesPlan,
  plansCan,
  type NewPlanDraft,
  type PlansAddress,
  type ProfileDraft,
  type RuleDraft,
} from './model'
import { useChipSearch } from './use-chip-search'
import { PlansView, type PlansModel } from './view/PlansView'
import { rulePlans } from './view/TriggersTab'

const LIVE_EVENTS = ['inspection_plan.', 'quality.aql_profile_changed', 'quality.aql_assignment_changed', 'inspection_trigger.changed'] as const

/**
 * The Inspection plans & AQL container (`/w/<company>/quality/plans?tab=plans|aql|triggers|calculator`, SCR-077): reads
 * what each tab the person may see shows (the plans of the address's company with the address's filters, the AQL
 * profiles, the rules, the calculator's answer), keeps the address, holds each tab's draft (the profiles' and the rules'
 * EditModeBar) and saves it as the API's writes in order, and listens to the live stream (a change elsewhere re-reads;
 * a tab with unsaved changes keeps them and says so).
 */
export function PlansPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can = useMemo(() => plansCan(session.permissions), [session.permissions])
  const address = useMemo(() => addressOf(params), [params])
  const companyId = session.company?.id ?? null
  const prefix = companyPrefix(session.company?.code ?? '')

  const [plans, setPlans] = useState<Read<PlansAnswer>>(reading())
  const [selected, setSelected] = useState<readonly string[]>([])
  const [starter, setStarter] = useState<Read<Starter[]> | null>(null)
  const [newPlan, setNewPlan] = useState<PlansModel['newPlan']>(null)
  const [profiles, setProfiles] = useState<Read<ProfilesAnswer>>(reading())
  const [profileDrafts, setProfileDrafts] = useState<readonly ProfileDraft[] | null>(null)
  const [assignments, setAssignments] = useState<PlansModel['assignments']>(null)
  const [rules, setRules] = useState<Read<RulesAnswer>>(reading())
  const [ruleDrafts, setRuleDrafts] = useState<readonly RuleDraft[] | null>(null)
  const [ruleDialog, setRuleDialog] = useState<PlansModel['ruleDialog']>(null)
  const { search: chipSearch, onSearch: searchChips, clear: clearChipSearch } = useChipSearch(api)
  const [calc, setCalc] = useState<Read<{ profile: { code: string; name: string } | null; plan: AqlPlanView }>>(reading())
  const [busy, setBusy] = useState<PlansModel['busy']>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [keysOpen, setKeysOpen] = useState(false)
  const [calcTry, setCalcTry] = useState(0)
  const counter = useRef(0)
  const createKey = useRef<string | null>(null)

  const writeAddress = useCallback((next: PlansAddress) => router.replace(`${pathname}${queryOf(next)}`, { scroll: false }), [pathname, router])

  // ---- reads ----
  const loadPlans = useCallback(async () => {
    if (!can.view || !companyId) return
    try {
      setPlans(ready(await readPlans(api, { companyId, stage: address.stage, status: address.status, q: address.q })))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setPlans(failedRead(problemOf(error)))
    }
  }, [api, can.view, companyId, address.stage, address.status, address.q])
  const loadStarter = useCallback(async () => {
    if (!can.view || !companyId) return
    setStarter(reading())
    try {
      setStarter(ready((await readStarter(api, companyId)).plans))
    } catch (error) {
      setStarter(failedRead(problemOf(error)))
    }
  }, [api, can.view, companyId])
  const loadProfiles = useCallback(
    async (keepDrafts = false) => {
      if (!can.aqlView || !companyId) return null
      try {
        const answer = await readProfiles(api, companyId)
        setProfiles(ready(answer))
        if (!keepDrafts) setProfileDrafts(answer.profiles.map(profileDraftOf))
        return answer
      } catch (error) {
        setProfiles(failedRead(problemOf(error)))
        return null
      }
    },
    [api, can.aqlView, companyId],
  )
  const loadRules = useCallback(
    async (keepDrafts = false) => {
      if (!can.triggersView || !companyId) return null
      try {
        const answer = await readRules(api, companyId)
        setRules(ready(answer))
        if (!keepDrafts) setRuleDrafts(answer.rules.map(ruleDraftOf))
        return answer
      } catch (error) {
        setRules(failedRead(problemOf(error)))
        return null
      }
    },
    [api, can.triggersView, companyId],
  )
  useEffect(() => {
    setPlans(reading())
    void loadPlans()
  }, [loadPlans])
  useEffect(() => {
    void loadProfiles()
    void loadRules()
  }, [loadProfiles, loadRules])
  // The starter set: for the empty list's offer and New plan's "Start from".
  useEffect(() => {
    if (starter === null && (address.newPlan || (plans.value && plans.value.plans.length === 0))) void loadStarter()
  }, [address.newPlan, plans.value, starter, loadStarter])

  // ---- the calculator (debounced; nothing saved) ----
  const calcKey = JSON.stringify(address.calc)
  useEffect(() => {
    if (address.tab !== 'calculator' || !can.aqlView) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      setCalc(reading())
      calculate(api, { lotSize: address.calc.lot, profileId: address.calc.profile, level: address.calc.level, aqlMajor: address.calc.major, aqlMinor: address.calc.minor }, controller.signal)
        .then((answer) => setCalc(ready(answer)))
        .catch((error: unknown) => !controller.signal.aborted && setCalc(failedRead(problemOf(error))))
    }, 250)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // calcKey stands for the calculator's asks; calcTry for Try again.
  }, [api, address.tab, can.aqlView, calcKey, calcTry])

  // ---- dirty drafts and the live stream ----
  const profilesDirty = !!(profiles.value && profileDrafts && profileChanges(profilePlan(profiles.value.profiles, profileDrafts)) > 0)
  const rulesDirty = !!(rules.value && ruleDrafts && rulesChanges(rulesPlan(rules.value.rules, ruleDrafts)) > 0)
  const dirty = useRef({ profiles: profilesDirty, rules: rulesDirty })
  dirty.current = { profiles: profilesDirty, rules: rulesDirty }
  const live = useLive(
    (change) => {
      if (!liveMatches(change, LIVE_EVENTS)) return
      if (change.type.startsWith('inspection_plan.')) void loadPlans()
      if (change.type.startsWith('quality.aql_')) {
        void loadProfiles(dirty.current.profiles)
        if (dirty.current.profiles) setNotice({ key: 'live.profilesChanged', tone: 'warning' })
      }
      if (change.type === 'inspection_trigger.changed') {
        void loadRules(dirty.current.rules)
        if (dirty.current.rules) setNotice({ key: 'live.rulesChanged', tone: 'warning' })
      }
    },
    () => {
      void loadPlans()
      void loadProfiles(dirty.current.profiles)
      void loadRules(dirty.current.rules)
    },
  )

  // ---- New plan follows the address (`?new=1`, `?copy=<version>`) ----
  useEffect(() => {
    if (!address.newPlan) {
      setNewPlan(null)
      return
    }
    if (newPlan) return
    createKey.current = null
    const copyRow = address.copy ? plans.value?.plans.find((row) => row.approved?.id === address.copy || row.draft?.id === address.copy) : null
    const draft: NewPlanDraft = copyRow ? { ...NEW_PLAN, stage: copyRow.stage, start: 'COPY', copyVersionId: address.copy!, name: '', code: '' } : NEW_PLAN
    setNewPlan({ draft, shown: false, problem: null })
    // The address and the plans' read open it.
  }, [address.newPlan, address.copy, plans.value])

  const createNewPlan = useCallback(async () => {
    if (!newPlan || !companyId) return
    const draft = newPlan.draft
    const taken = new Set((plans.value?.plans ?? []).map((row) => row.code))
    if (newPlanProblems(draft, taken).length > 0) {
      setNewPlan({ ...newPlan, shown: true })
      return
    }
    setBusy('newPlan')
    createKey.current ??= newIdempotencyKey()
    try {
      const record = await createPlan(
        api,
        {
          companyId,
          code: codeOf(draft.code.trim()),
          stage: draft.stage,
          name: draft.name.trim(),
          ownerId: draft.owner === 'ME' ? session.user.id : null,
          startFrom: draft.start === 'STARTER' ? { kind: 'STARTER', code: draft.starterCode } : draft.start === 'COPY' ? { kind: 'COPY', versionId: draft.copyVersionId } : { kind: 'BLANK' },
        },
        createKey.current,
      )
      createKey.current = null
      setNewPlan(null)
      router.push(planHref(prefix, record.plan.id))
    } catch (error) {
      setNewPlan({ ...newPlan, shown: true, problem: problemOf(error) })
    } finally {
      setBusy(null)
    }
  }, [api, companyId, newPlan, plans.value, prefix, router, session.user.id])

  const addStarterSet = useCallback(async () => {
    if (!companyId) return
    setBusy('starter')
    try {
      const answer = await addStarter(api, { companyId, language: locale === 'it' ? 'it' : 'en' }, newIdempotencyKey())
      setNotice({ key: 'done.starter', params: { count: answer.added.length }, tone: 'success' })
      setStarter(null)
      await loadPlans()
    } catch (error) {
      setNotice({ key: problemOf(error), tone: 'danger' })
    } finally {
      setBusy(null)
    }
  }, [api, companyId, loadPlans, locale])

  // ---- AQL profiles: ONE save (creates and the default first, then each change at the version read again) ----
  const applyProfiles = useCallback(async () => {
    if (!profiles.value || !profileDrafts || !companyId || profilesProblems(profileDrafts).length > 0) return
    const plan = profilePlan(profiles.value.profiles, profileDrafts)
    setBusy('aql')
    let done = 0
    try {
      for (const draft of plan.creates) {
        await createProfile(
          api,
          { companyId, code: draft.code.trim().toUpperCase(), name: draft.name.trim(), inspectionLevel: draft.level, aqlMajor: draft.major, aqlMinor: draft.minor, isDefault: plan.defaultTo === draft.key, note: draft.note.trim() || null },
          newIdempotencyKey(),
        )
        done += 1
      }
      const existingDefault = plan.defaultTo && !plan.creates.some((draft) => draft.key === plan.defaultTo) ? plan.defaultTo : null
      if (existingDefault) {
        const profile = profiles.value.profiles.find((entry) => entry.id === existingDefault)
        if (profile) {
          await editProfile(api, profile.id, { version: profile.version, isDefault: true }, newIdempotencyKey())
          done += 1
        }
      }
      // The default's change moves other rows' versions: read again, then change what still differs.
      const fresh = (await readProfiles(api, companyId)).profiles
      for (const draft of profileDrafts.filter((entry) => entry.id !== null)) {
        const profile = fresh.find((entry) => entry.id === draft.id)
        if (!profile) continue
        const body = editProfileBody(profile, { ...draft, isDefault: profile.isDefault })
        if (Object.keys(body).length <= 1) continue
        await editProfile(api, profile.id, body as never, newIdempotencyKey())
        done += 1
      }
      setNotice({ key: 'done.profiles', params: { count: done }, tone: 'success' })
      await loadProfiles()
    } catch (error) {
      setNotice({ key: problemOf(error) === 'problem.conflict' ? 'problem.profileRefused' : problemOf(error), params: { count: done }, tone: 'danger' })
      await loadProfiles(true)
    } finally {
      setBusy(null)
    }
  }, [api, companyId, loadProfiles, profileDrafts, profiles.value])

  // ---- where a profile applies (`?profile=<id>`), each assignment one write ----
  useEffect(() => {
    if (!address.profile || !can.aqlView) {
      setAssignments(null)
      return
    }
    const profileId = address.profile
    setAssignments({ profileId, read: reading(), customer: null, style: null, customers: null, styles: null, problem: null })
    readAssignments(api, profileId)
      .then((answer) => setAssignments((current) => (current?.profileId === profileId ? { ...current, read: ready(answer.assignments) } : current)))
      .catch((error: unknown) => setAssignments((current) => (current?.profileId === profileId ? { ...current, read: failedRead<Assignment[]>(problemOf(error)) } : current)))
  }, [address.profile, api, can.aqlView])

  const assignTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const assignSearch = useCallback(
    (kind: 'CUSTOMER' | 'STYLE', q: string) => {
      if (assignTimer.current) clearTimeout(assignTimer.current)
      const field = kind === 'CUSTOMER' ? 'customers' : 'styles'
      setAssignments((current) => (current ? { ...current, [field]: reading<PickOption[]>() } : current))
      assignTimer.current = setTimeout(() => {
        pickRecords(api, kind, q)
          .then((options) => setAssignments((current) => (current ? { ...current, [field]: ready(options) } : current)))
          .catch((error: unknown) => setAssignments((current) => (current ? { ...current, [field]: failedRead<PickOption[]>(problemOf(error)) } : current)))
      }, 250)
    },
    [api],
  )

  const assign = useCallback(async () => {
    if (!assignments || (!assignments.customer && !assignments.style)) return
    setBusy('assign')
    try {
      await assignProfile(api, { profileId: assignments.profileId, customerId: assignments.customer?.id ?? null, styleId: assignments.style?.id ?? null }, newIdempotencyKey())
      const answer = await readAssignments(api, assignments.profileId)
      setAssignments({ ...assignments, read: ready(answer.assignments), customer: null, style: null, problem: null })
      setNotice({ key: 'done.assigned', tone: 'success' })
      await loadProfiles(dirty.current.profiles)
    } catch (error) {
      setAssignments({ ...assignments, problem: problemOf(error) === 'problem.conflict' ? 'problem.assignSame' : problemOf(error) })
    } finally {
      setBusy(null)
    }
  }, [api, assignments, loadProfiles])

  const endOne = useCallback(
    async (assignmentId: string) => {
      const row = assignments?.read.value?.find((entry) => entry.id === assignmentId)
      if (!assignments || !row) return
      setBusy('assign')
      try {
        await endAssignment(api, row.id, row.version, newIdempotencyKey())
        const answer = await readAssignments(api, assignments.profileId)
        setAssignments({ ...assignments, read: ready(answer.assignments), problem: null })
        setNotice({ key: 'done.ended', tone: 'success' })
        await loadProfiles(dirty.current.profiles)
      } catch (error) {
        setAssignments({ ...assignments, problem: problemOf(error) })
      } finally {
        setBusy(null)
      }
    },
    [api, assignments, loadProfiles],
  )

  // ---- rules: the dialog follows the address (`?rule=<key>|new`); ONE save for the whole list ----
  useEffect(() => {
    if (!address.rule || !ruleDrafts || !rules.value) {
      if (!address.rule) setRuleDialog(null)
      return
    }
    if (ruleDialog && (ruleDialog.draft.key === address.rule || (address.rule === 'new' && ruleDialog.draft.id === null))) return
    if (address.rule === 'new') {
      counter.current += 1
      const event = rules.value.events.find((entry) => entry.available)?.event ?? 'GOODS_RECEIPT'
      const info = rules.value.events.find((entry) => entry.event === event)
      const plan = rulePlans({ plans, rules }).find((entry) => info?.stages.includes(entry.stage))
      setRuleDialog({ draft: { ...newRule(counter.current, event, plan?.id ?? ''), frequency: info?.frequencies[0]?.frequency ?? 'EVERY_LOT' }, shown: false, preview: null })
      return
    }
    const draft = ruleDrafts.find((entry) => entry.key === address.rule)
    if (!draft) {
      writeAddress({ ...address, rule: null })
      return
    }
    setRuleDialog({ draft, shown: false, preview: null })
    // The address and the drafts open it.
  }, [address.rule, ruleDrafts, rules.value])

  const ruleDone = useCallback(() => {
    if (!ruleDialog || !rules.value || !ruleDrafts) return
    const facts = rules.value.events.map((entry) => ({ event: entry.event, available: entry.available, stages: entry.stages, frequencies: entry.frequencies.map((item) => item.frequency), chipKinds: entry.chipKinds }))
    if (ruleProblems(ruleDialog.draft, facts, rulePlans({ plans, rules })).length > 0) {
      setRuleDialog({ ...ruleDialog, shown: true })
      return
    }
    const draft = ruleDialog.draft
    setRuleDrafts(ruleDrafts.some((entry) => entry.key === draft.key) ? ruleDrafts.map((entry) => (entry.key === draft.key ? draft : entry)) : [...ruleDrafts, draft])
    setRuleDialog(null)
    clearChipSearch()
    writeAddress({ ...address, rule: null })
  }, [address, plans, ruleDialog, ruleDrafts, rules, writeAddress])

  const rulePreview = useCallback(async () => {
    if (!ruleDialog || !companyId || !ruleDrafts) return
    const draft = ruleDialog.draft
    setRuleDialog({ ...ruleDialog, preview: reading() })
    const at = ruleDrafts.findIndex((entry) => entry.key === draft.key)
    try {
      // The preview takes the rule as it would stand, on or off alike (its body has no `active`).
      const { active: _active, ...rule } = ruleBody(draft)
      const answer = await previewRule(api, { ...rule, companyId, ...(draft.id ? { triggerId: draft.id } : {}), position: at === -1 ? ruleDrafts.length + 1 : at + 1 })
      setRuleDialog((current) => (current && current.draft.key === draft.key ? { ...current, preview: ready(answer.preview) } : current))
    } catch (error) {
      setRuleDialog((current) => (current && current.draft.key === draft.key ? { ...current, preview: failedRead(problemOf(error)) } : current))
    }
  }, [api, companyId, ruleDialog, ruleDrafts])

  const applyRules = useCallback(async () => {
    if (!rules.value || !ruleDrafts || !companyId) return
    const plan = rulesPlan(rules.value.rules, ruleDrafts)
    setBusy('triggers')
    let done = 0
    try {
      for (const rule of plan.deletes) {
        await deleteRule(api, rule.id, rule.version, newIdempotencyKey())
        done += 1
      }
      for (const edit of plan.edits) {
        const before = ruleBody(ruleDraftOf(edit.rule))
        const after = ruleBody(edit.draft)
        const body = Object.fromEntries(Object.entries(after).filter(([field, value]) => JSON.stringify(value) !== JSON.stringify(before[field as keyof typeof before])))
        await editRule(api, edit.rule.id, { version: edit.rule.version, ...body }, newIdempotencyKey())
        done += 1
      }
      const ids = new Map<string, string>()
      for (const draft of plan.creates) {
        const answer = await createRule(api, { ...ruleBody(draft), companyId }, newIdempotencyKey())
        ids.set(draft.key, answer.rule.id)
        done += 1
      }
      if (plan.reordered || plan.creates.length > 0) {
        const order = ruleDrafts.map((draft) => draft.id ?? ids.get(draft.key)).filter((id): id is string => !!id)
        await orderRules(api, { companyId, order }, newIdempotencyKey())
      }
      setNotice({ key: 'done.rules', params: { count: rulesChanges(plan) }, tone: 'success' })
      await loadRules()
    } catch (error) {
      setNotice({ key: problemOf(error), params: { count: done }, tone: 'danger' })
      await loadRules(done === 0)
    } finally {
      setBusy(null)
    }
  }, [api, companyId, loadRules, ruleDrafts, rules.value])

  const model: PlansModel = {
    prefix,
    companyId,
    can,
    address,
    live,
    asOf,
    notice,
    plans,
    selected,
    starter,
    newPlan,
    profiles,
    profileDrafts,
    assignments,
    rules,
    ruleDrafts,
    ruleDialog,
    chipSearch,
    calc,
    busy,
    stepUp: STEP_UP_CLOSED,
    keysOpen,
  }

  return (
    <PlansView
      model={model}
      actions={{
        onReload: () => {
          void loadPlans()
          void loadProfiles(profilesDirty)
          void loadRules(rulesDirty)
        },
        onDismissNotice: () => setNotice(null),
        onKeys: () => setKeysOpen(true),
        onKeysClose: () => setKeysOpen(false),
        // Plans
        onNewPlan: () => writeAddress({ ...address, tab: 'plans', newPlan: true, copy: null }),
        onCopyPlan: (versionId) => writeAddress({ ...address, tab: 'plans', newPlan: true, copy: versionId }),
        onStarter: () => void addStarterSet(),
        onStage: (stage) => writeAddress({ ...address, stage }),
        onStatus: (status) => writeAddress({ ...address, status }),
        onSearch: (q) => writeAddress({ ...address, q }),
        onClearFilters: () => writeAddress({ ...address, stage: '', status: '', q: '' }),
        onSelect: (ids) => setSelected([...ids]),
        onOpenPlan: (planId) => router.push(planHref(prefix, planId)),
        onRetryPlans: () => {
          setPlans(reading())
          void loadPlans()
        },
        onNewPlanDraft: (draft) => newPlan && setNewPlan({ ...newPlan, draft, problem: null }),
        onNewPlanCreate: () => void createNewPlan(),
        onNewPlanClose: () => {
          setNewPlan(null)
          writeAddress({ ...address, newPlan: false, copy: null })
        },
        // AQL profiles
        onProfiles: (drafts) => setProfileDrafts(drafts),
        onAddProfile: () => {
          counter.current += 1
          setProfileDrafts([...(profileDrafts ?? []), newProfile(counter.current, (profileDrafts ?? []).length === 0)])
        },
        onDiscardProfiles: () => profiles.value && setProfileDrafts(profiles.value.profiles.map(profileDraftOf)),
        onApplyProfiles: () => void applyProfiles(),
        onRetryProfiles: () => {
          setProfiles(reading())
          void loadProfiles()
        },
        onOpenAssignments: (profileId) => writeAddress({ ...address, profile: profileId }),
        onCloseAssignments: () => writeAddress({ ...address, profile: null }),
        onAssignSearch: assignSearch,
        onAssignPick: (kind, option) => assignments && setAssignments({ ...assignments, [kind === 'CUSTOMER' ? 'customer' : 'style']: option, problem: null }),
        onAssign: () => void assign(),
        onEndAssignment: (id) => void endOne(id),
        // Rules
        onRules: (drafts) => setRuleDrafts(drafts),
        onDiscardRules: () => rules.value && setRuleDrafts(rules.value.rules.map(ruleDraftOf)),
        onApplyRules: () => void applyRules(),
        onRetryRules: () => {
          setRules(reading())
          void loadRules()
        },
        onRuleOpen: (key) => writeAddress({ ...address, rule: key }),
        onRuleDraft: (draft) => ruleDialog && setRuleDialog({ ...ruleDialog, draft, preview: null }),
        onRuleDone: ruleDone,
        onRuleClose: () => {
          setRuleDialog(null)
          clearChipSearch()
          writeAddress({ ...address, rule: null })
        },
        onRulePreview: () => void rulePreview(),
        onChipSearch: searchChips,
        // Calculator
        onCalc: (calcAsk) => writeAddress({ ...address, calc: calcAsk }),
        onRetryCalc: () => setCalcTry((n) => n + 1),
      }}
    />
  )
}
