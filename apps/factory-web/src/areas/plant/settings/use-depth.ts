'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useUnsavedGuard } from '../../people/settings/use-unsaved-guard'
import { isStepUpCancelled, useLive, useStepUp } from '../_shared/hooks'
import {
  addRule,
  changeRule,
  createCheckType,
  orderRules,
  previewRouting,
  readCheckTypes,
  readEmployees,
  readIncidentRules,
  readLock,
  readRouting,
  readTeams,
  removeRule,
  saveLock,
  updateCheckType,
  type CheckType,
  type CheckTypesRead,
  type EmployeePick,
  type LockRead,
  type RoutingRead,
  type RoutingRule,
  type TeamPick,
} from './depth-api'
import {
  blankRule,
  blankType,
  depthProblemOf,
  depthReadProblem,
  lockBody,
  lockChangeCount,
  lockDraftOf,
  lockHeld,
  orderBody,
  ruleAddBody,
  ruleChanges,
  ruleDraftOf,
  ruleHeld,
  ruleOrderAfter,
  typeChanges,
  typeCreateBody,
  typeDraftOf,
  typeHeld,
  typeRowsOf,
  type LockDraft,
  type RuleDraft,
  type TypeDraft,
  type TypeRows,
} from './depth-model'
import type { DepthActions, DepthDialog, DepthModel, DepthNotice, Pickers, Section, SiteChoice } from './depth-view-model'

const OWN_MS = 5000
const LIVE_TYPES = new Set(['plant_settings.changed', 'machine_check_type.changed'])

/** The rights the screen asks itself (each read's `canManage` says the rest). */
function canOf(permissions: readonly string[]) {
  const held = new Set(permissions)
  return { people: held.has('people.view'), audit: held.has('audit.read'), incidents: held.has('safety.incidents.view'), view: held.has('plant.view') }
}

const failed = (error: unknown) => ({ status: 'error' as const, problem: depthReadProblem(error) })

/**
 * The container of Plant settings' W2b sections (SCR-241, B-W2b-141): the site (the top bar's; else `?site=`; else the
 * first), each section's read on its own (routing and lock per site, the check types and the incident rules once), every
 * write as one call with the version read and its Idempotency-Key (the same key when the lock is sent again after the
 * fresh code), the dialogs from the address (`?rule=<id>|new`, `?type=<id>|new`: record links open them), live
 * plant_settings.changed / machine_check_type.changed from someone else → "Changed by someone else · Reload", the save
 * status and the leave guard of the lock card. `extraSaving`: the symptoms' cells are saving (the band says so too).
 */
export function useDepth(extraSaving = false): { depth: DepthModel; actions: DepthActions } {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can = useMemo(() => canOf(session.permissions), [session.permissions])
  const prefix = pathname.replace(/\/plant\/settings\/?$/, '')

  // ---- the site ------------------------------------------------------------------------------------------------------------
  const sites: SiteChoice[] = useMemo(() => scope.sites.map((site) => ({ id: site.id, name: site.name, ...(site.code ? { code: site.code } : {}) })), [scope.sites])
  const asked = params.get('site')
  const site: SiteChoice | null = scope.site ? (sites.find((entry) => entry.id === scope.site!.id) ?? null) : (sites.find((entry) => entry.id === asked) ?? sites[0] ?? null)
  const siteId = site?.id ?? null
  const siteFromTopBar = !!scope.site && !scope.fixed

  // ---- state ---------------------------------------------------------------------------------------------------------------
  const [routingRead, setRoutingRead] = useState<Section<RoutingRead>>({ status: 'loading' })
  const [routingBusy, setRoutingBusy] = useState(false)
  const [preview, setPreview] = useState<DepthModel['routing']['preview']>({ classId: null, read: { status: 'idle' } })
  const [lockRead, setLockRead] = useState<Section<LockRead>>({ status: 'loading' })
  const [lockDraft, setLockDraft] = useState<LockDraft | null>(null)
  const [lockBusy, setLockBusy] = useState(false)
  const [lockProblem, setLockProblem] = useState<DepthModel['lock']['problem']>(null)
  const [typesRead, setTypesRead] = useState<Section<CheckTypesRead>>({ status: 'loading' })
  const [typeRows, setTypeRows] = useState<TypeRows>(typeRowsOf(params.get('types')))
  const [typesBusy, setTypesBusy] = useState(false)
  const [incidents, setIncidents] = useState<DepthModel['incidents']>(can.incidents ? { status: 'loading' } : { status: 'forbidden' })
  const [dialog, setDialog] = useState<DepthDialog | null>(null)
  const [notice, setNotice] = useState<DepthNotice | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [saving, setSaving] = useState(0)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [lastFailed, setLastFailed] = useState(false)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const ownUntil = useRef(0)
  const latest = useRef({ routingRead, typesRead, lockRead, dialog })
  latest.current = { routingRead, typesRead, lockRead, dialog }
  const pickerCache = useRef(new Map<string, { teams: TeamPick[]; employees: EmployeePick[] }>())
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
    return attempt.current.key
  }

  /** A write of ours: its live message is ours; the band says Saving… until it ends. */
  const write = async <T,>(work: () => Promise<T>): Promise<T> => {
    ownUntil.current = Date.now() + OWN_MS
    setSaving((count) => count + 1)
    try {
      const answer = await work()
      ownUntil.current = Date.now() + OWN_MS
      setSavedAt(new Date().toISOString())
      setLastFailed(false)
      return answer
    } catch (error) {
      if (!isStepUpCancelled(error)) setLastFailed(true)
      throw error
    } finally {
      setSaving((count) => count - 1)
    }
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------
  const readRoutingNow = useCallback(async () => {
    if (!siteId || !can.view) return
    try {
      setRoutingRead({ status: 'ready', value: await readRouting(api, siteId) })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setRoutingRead(failed(error))
    }
  }, [api, siteId, can.view])

  const readLockNow = useCallback(async () => {
    if (!siteId || !can.view) return
    try {
      setLockRead({ status: 'ready', value: await readLock(api, siteId) })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setLockRead(failed(error))
    }
  }, [api, siteId, can.view])

  const readTypesNow = useCallback(async () => {
    if (!can.view) return
    try {
      setTypesRead({ status: 'ready', value: await readCheckTypes(api) })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setTypesRead(failed(error))
    }
  }, [api, can.view])

  const readIncidentsNow = useCallback(async () => {
    if (!can.incidents) return setIncidents({ status: 'forbidden' })
    try {
      setIncidents({ status: 'ready', value: await readIncidentRules(api) })
    } catch (error) {
      setIncidents(failed(error))
    }
  }, [api, can.incidents])

  useEffect(() => {
    setRoutingRead({ status: 'loading' })
    setLockRead({ status: 'loading' })
    setLockDraft(null)
    setLockProblem(null)
    setPreview({ classId: null, read: { status: 'idle' } })
    void readRoutingNow()
    void readLockNow()
  }, [readRoutingNow, readLockNow])
  useEffect(() => void readTypesNow(), [readTypesNow])
  useEffect(() => void readIncidentsNow(), [readIncidentsNow])

  const live = useLive(
    (change) => {
      if (!LIVE_TYPES.has(change.type) || Date.now() < ownUntil.current) return
      if (change.type === 'plant_settings.changed' && String(change.fields.siteId ?? '') !== siteId) return
      setChangedElsewhere(true)
    },
    () => {
      void readRoutingNow()
      void readLockNow()
      void readTypesNow()
    },
    can.view,
  )

  const reload = () => {
    setChangedElsewhere(false)
    void readRoutingNow()
    void readLockNow()
    void readTypesNow()
    void readIncidentsNow()
  }

  // ---- the address opens a dialog (record links) ----------------------------------------------------------------------------
  const opened = useRef<string | null>(null)
  const dropTerm = useCallback(
    (name: 'rule' | 'type') => {
      if (!params.get(name)) return
      const next = new URLSearchParams(params.toString())
      next.delete(name)
      const text = next.toString()
      router.replace(`${pathname}${text ? `?${text}` : ''}`, { scroll: false })
    },
    [params, pathname, router],
  )

  // ---- pickers -------------------------------------------------------------------------------------------------------------
  const loadPickers = useCallback(
    async (forSite: string) => {
      if (!can.people) return
      const cached = pickerCache.current.get(forSite)
      const put = (pickers: Pickers) => setDialog((current) => (current?.kind === 'rule' ? { ...current, pickers } : current))
      if (cached) return put({ status: 'ready', value: cached })
      try {
        const [teams, employees] = await Promise.all([readTeams(api, forSite), readEmployees(api)])
        pickerCache.current.set(forSite, { teams, employees })
        put({ status: 'ready', value: { teams, employees } })
      } catch (error) {
        put(failed(error))
      }
    },
    [api, can.people],
  )

  const openRule = useCallback(
    (draft: RuleDraft) => {
      attempt.current = null
      const pickers: Pickers = can.people ? (siteId && pickerCache.current.get(siteId) ? { status: 'ready', value: pickerCache.current.get(siteId)! } : { status: 'loading' }) : { status: 'forbidden' }
      setDialog({ kind: 'rule', draft, busy: false, problem: null, pickers })
      if (siteId && pickers.status === 'loading') void loadPickers(siteId)
    },
    [can.people, siteId, loadPickers],
  )

  useEffect(() => {
    const rule = params.get('rule')
    const type = params.get('type')
    // The address no longer names a dialog: the next `?rule=` / `?type=` opens again.
    if (!rule && !type) {
      opened.current = null
      return
    }
    const key = `${rule ?? ''}|${type ?? ''}`
    if (opened.current === key) return
    if (rule && routingRead.status === 'ready') {
      const found = rule === 'new' ? null : routingRead.value.rules.find((entry) => entry.id === rule)
      if (rule === 'new' || found) {
        opened.current = key
        openRule(found ? ruleDraftOf(found) : blankRule())
      } else {
        opened.current = key
        setNotice({ tone: 'warning', key: 'notice.ruleGone' })
        dropTerm('rule')
      }
    }
    if (type && typesRead.status === 'ready') {
      const found = type === 'new' ? null : typesRead.value.types.find((entry) => entry.id === type)
      opened.current = key
      if (type === 'new' || found) {
        attempt.current = null
        setDialog({ kind: 'type', draft: found ? typeDraftOf(found) : blankType(typesRead.value.leastRetentionYears), busy: false, problem: null })
      } else {
        setNotice({ tone: 'warning', key: 'notice.typeGone' })
        dropTerm('type')
      }
    }
  }, [params, routingRead, typesRead, openRule, dropTerm])

  const closeDialog = (next: DepthDialog | null) => {
    setDialog(next)
    if (next === null) {
      // A refused change left in a dialog is gone with it: the band no longer counts it as not saved.
      setLastFailed(false)
      // `opened` keeps the address's key until the address drops it, so the dialog is not opened again meanwhile.
      dropTerm('rule')
      dropTerm('type')
    }
  }

  // ---- routing writes ------------------------------------------------------------------------------------------------------
  const putRules = (rules: RoutingRule[]) => setRoutingRead((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, rules } } : current))
  const rulesNow = (): RoutingRule[] => (latest.current.routingRead.status === 'ready' ? latest.current.routingRead.value.rules : [])

  const saveRule = () => {
    const open = latest.current.dialog
    if (open?.kind !== 'rule' || !siteId || open.busy || ruleHeld(open.draft, false)) return
    const rule = open.draft.id ? rulesNow().find((entry) => entry.id === open.draft.id) : null
    const body = rule ? { ...ruleChanges(rule, open.draft), version: rule.version } : ruleAddBody(siteId, open.draft)
    setDialog({ ...open, busy: true, problem: null })
    const key = keyFor(body)
    write(() => (rule ? changeRule(api, rule.id, body as Parameters<typeof changeRule>[2], key) : addRule(api, body as Parameters<typeof addRule>[1], key)))
      .then((rules) => {
        attempt.current = null
        putRules(rules)
        closeDialog(null)
        setNotice({ tone: 'success', key: rule ? 'done.ruleSaved' : 'done.ruleAdded', params: { place: rule ? rules.findIndex((entry) => entry.id === rule.id) + 1 : rules.length } })
      })
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'rule' ? { ...current, busy: false, problem: depthProblemOf(error) } : current)))
  }

  /** Rules removed one by one, each at its newest version (each answer gives every rule back). */
  const removeMany = async (ids: readonly string[]) => {
    let deleted = 0
    let switched = 0
    for (const id of ids) {
      const rule = rulesNow().find((entry) => entry.id === id)
      if (!rule) continue
      const answer = await write(() => removeRule(api, rule.id, rule.version, newIdempotencyKey()))
      putRules(answer.rules)
      latest.current = { ...latest.current, routingRead: { status: 'ready', value: { ...(latest.current.routingRead as { value: RoutingRead }).value, rules: answer.rules } } }
      if (answer.outcome === 'DELETED') deleted += 1
      else switched += 1
    }
    return { deleted, switched }
  }

  const confirmRemove = () => {
    const open = latest.current.dialog
    if (!open || (open.kind !== 'rule' && open.kind !== 'removeRules') || open.busy) return
    const ids = open.kind === 'rule' ? (open.draft.id ? [open.draft.id] : []) : open.ids
    if (ids.length === 0) return
    setDialog({ ...open, busy: true, problem: null })
    setRoutingBusy(true)
    removeMany(ids)
      .then(({ deleted, switched }) => {
        closeDialog(null)
        setNotice({ tone: 'success', key: 'done.rulesRemoved', params: { deleted, switched } })
      })
      .catch((error: unknown) => {
        setDialog((current) => (current && (current.kind === 'rule' || current.kind === 'removeRules') ? { ...current, busy: false, problem: depthProblemOf(error) } : current))
        void readRoutingNow()
      })
      .finally(() => setRoutingBusy(false))
  }

  const switchRules = (ids: readonly string[], active: boolean) => {
    const chosen = rulesNow().filter((rule) => ids.includes(rule.id) && rule.active !== active)
    if (chosen.length === 0) return
    setRoutingBusy(true)
    void (async () => {
      let done = 0
      try {
        for (const { id } of chosen) {
          const rule = rulesNow().find((entry) => entry.id === id)!
          const rules = await write(() => changeRule(api, rule.id, { version: rule.version, active }, newIdempotencyKey()))
          putRules(rules)
          latest.current = { ...latest.current, routingRead: { status: 'ready', value: { ...(latest.current.routingRead as { value: RoutingRead }).value, rules } } }
          done += 1
        }
        setNotice({ tone: 'success', key: active ? 'done.rulesOn' : 'done.rulesOff', params: { count: done } })
      } catch (error) {
        // Stopped at the first refusal: what was done stays, the rest is read again (never shown as done).
        setNotice(done === 0 ? { tone: 'danger', ...depthProblemOf(error) } : { tone: 'danger', key: 'done.rulesPartly', params: { count: done, of: chosen.length } })
        void readRoutingNow()
      } finally {
        setRoutingBusy(false)
      }
    })()
  }

  const moveRules = (ids: readonly string[], delta: -1 | 1) => {
    const rules = rulesNow()
    const order = ruleOrderAfter(rules, ids, delta)
    if (!order || !siteId) return
    setRoutingBusy(true)
    write(() => orderRules(api, siteId, orderBody(rules, order), newIdempotencyKey()))
      .then(putRules)
      .catch((error: unknown) => {
        setNotice({ tone: 'danger', ...depthProblemOf(error) })
        void readRoutingNow()
      })
      .finally(() => setRoutingBusy(false))
  }

  const previewClass = (classId: string | null) => {
    if (!classId || !siteId) return setPreview({ classId: null, read: { status: 'idle' } })
    setPreview({ classId, read: { status: 'loading' } })
    previewRouting(api, siteId, classId)
      .then((value) => setPreview((current) => (current.classId === classId ? { classId, read: { status: 'ready', value } } : current)))
      .catch((error: unknown) => setPreview((current) => (current.classId === classId ? { classId, read: failed(error) } : current)))
  }

  // ---- the lock --------------------------------------------------------------------------------------------------------------
  const lockValue = lockRead.status === 'ready' ? lockRead.value : null
  const lockDirty = !!lockValue && !!lockDraft && lockChangeCount(lockDraftOf(lockValue), lockDraft) > 0

  const saveLockCard = async (): Promise<boolean> => {
    const read = latest.current.lockRead
    if (read.status !== 'ready' || !lockDraft || !siteId || lockHeld(lockDraft, lockBusy)) return false
    const body = lockBody(siteId, read.value, lockDraft)
    setLockBusy(true)
    setLockProblem(null)
    try {
      const key = keyFor(body)
      const answer = await write(() => guard('stepUp.lock', () => saveLock(api, body, key)))
      attempt.current = null
      setLockRead({ status: 'ready', value: answer })
      setLockDraft(null)
      setNotice({ tone: 'success', key: 'done.lock', params: { site: site?.name ?? '' } })
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) setLockProblem(depthProblemOf(error))
      return false
    } finally {
      setLockBusy(false)
    }
  }

  const unsaved = useUnsavedGuard(lockDirty)
  const [leaveBusy, setLeaveBusy] = useState(false)

  // ---- check types ---------------------------------------------------------------------------------------------------------
  const typesNow = (): CheckType[] => (latest.current.typesRead.status === 'ready' ? latest.current.typesRead.value.types : [])
  const putType = (type: CheckType) =>
    setTypesRead((current) => {
      if (current.status !== 'ready') return current
      const exists = current.value.types.some((entry) => entry.id === type.id)
      const types = exists ? current.value.types.map((entry) => (entry.id === type.id ? type : entry)) : [...current.value.types, type]
      const next = { status: 'ready' as const, value: { ...current.value, types } }
      latest.current = { ...latest.current, typesRead: next }
      return next
    })

  const saveType = () => {
    const open = latest.current.dialog
    const read = latest.current.typesRead
    if (open?.kind !== 'type' || read.status !== 'ready' || open.busy) return
    if (typeHeld(open.draft, read.value.types.map((entry) => entry.code), read.value.leastRetentionYears, false)) return
    const type = open.draft.id ? typesNow().find((entry) => entry.id === open.draft.id) : null
    setDialog({ ...open, busy: true, problem: null })
    const body = type ? { ...typeChanges(type, open.draft), version: type.version } : typeCreateBody(open.draft)
    const key = keyFor(body)
    write(() => (type ? updateCheckType(api, type.id, body as Parameters<typeof updateCheckType>[2], key) : createCheckType(api, body as Parameters<typeof createCheckType>[1], key)))
      .then((saved) => {
        attempt.current = null
        putType(saved)
        closeDialog(null)
        setNotice({ tone: 'success', key: type ? 'done.typeSaved' : 'done.typeAdded', params: { code: saved.code } })
      })
      .catch((error: unknown) => setDialog((current) => (current?.kind === 'type' ? { ...current, busy: false, problem: depthProblemOf(error) } : current)))
  }

  const confirmTypeState = () => {
    const open = latest.current.dialog
    if (open?.kind !== 'typeState' || open.busy) return
    const chosen = typesNow().filter((type) => open.ids.includes(type.id) && type.active !== open.active)
    if (chosen.length === 0) return
    setDialog({ ...open, busy: true, problem: null })
    setTypesBusy(true)
    void (async () => {
      let done = 0
      try {
        for (const { id } of chosen) {
          const type = typesNow().find((entry) => entry.id === id)!
          putType(await write(() => updateCheckType(api, type.id, { version: type.version, active: open.active }, newIdempotencyKey())))
          done += 1
        }
        closeDialog(null)
        setNotice({ tone: 'success', key: open.active ? 'done.typesRestored' : 'done.typesRetired', params: { count: done, codes: chosen.map((type) => type.code).join(', ') } })
      } catch (error) {
        setDialog((current) => (current?.kind === 'typeState' ? { ...current, busy: false, problem: depthProblemOf(error) } : current))
        void readTypesNow()
      } finally {
        setTypesBusy(false)
      }
    })()
  }

  // ---- the model -----------------------------------------------------------------------------------------------------------
  const save: SaveStatusState = saving > 0 || extraSaving ? { kind: 'saving' } : lockDirty ? { kind: 'unsaved' } : lastFailed ? { kind: 'failed', count: 1 } : savedAt ? { kind: 'saved', at: savedAt } : { kind: 'idle' }

  const depth: DepthModel = {
    can: { people: can.people, audit: can.audit, incidents: can.incidents },
    site,
    sites,
    siteFromTopBar,
    live,
    asOf,
    save,
    changedElsewhere,
    notice,
    routing: { read: siteId ? routingRead : { status: 'ready', value: { siteId: '', rules: [], canManage: false } }, busy: routingBusy, preview },
    lock: { read: lockRead, draft: lockDraft, busy: lockBusy, problem: lockProblem },
    checks: { read: typesRead, rows: typeRows, busy: typesBusy },
    incidents,
    dialog,
    stepUp,
    leaving: unsaved.pending ? { busy: leaveBusy } : null,
    historyHref: `${prefix}/plant/settings/history`,
  }

  const actions: DepthActions = {
    onSite: (id) => {
      const next = new URLSearchParams(params.toString())
      next.set('site', id)
      router.replace(`${pathname}?${next.toString()}`, { scroll: false })
    },
    onReload: reload,
    onDismissNotice: () => setNotice(null),
    onDialog: closeDialog,
    onRoutingRetry: () => {
      setRoutingRead({ status: 'loading' })
      void readRoutingNow()
    },
    onRuleNew: () => openRule(blankRule()),
    onRuleOpen: (rule) => openRule(ruleDraftOf(rule)),
    onRuleSwitch: switchRules,
    onRuleMove: moveRules,
    onRuleRemoveMany: (ids) => setDialog({ kind: 'removeRules', ids, busy: false, problem: null }),
    onPreviewClass: previewClass,
    onRuleDraft: (patch) => setDialog((current) => (current?.kind === 'rule' ? { ...current, draft: { ...current.draft, ...patch }, problem: null } : current)),
    onRuleSave: saveRule,
    onRuleRemove: (ask) => setDialog((current) => (current?.kind === 'rule' ? { ...current, confirmRemove: ask, problem: null } : current)),
    onRemoveConfirm: confirmRemove,
    onLockRetry: () => {
      setLockRead({ status: 'loading' })
      void readLockNow()
    },
    onLockDraft: (patch) => {
      if (!lockValue) return
      setLockProblem(null)
      setLockDraft((current) => ({ ...(current ?? lockDraftOf(lockValue)), ...patch }))
    },
    onLockSave: () => void saveLockCard(),
    onLockDiscard: () => {
      setLockDraft(null)
      setLockProblem(null)
      setLastFailed(false)
    },
    onChecksRetry: () => {
      setTypesRead({ status: 'loading' })
      void readTypesNow()
    },
    onTypeRows: setTypeRows,
    onTypeNew: () => {
      const read = latest.current.typesRead
      if (read.status !== 'ready') return
      attempt.current = null
      setDialog({ kind: 'type', draft: blankType(read.value.leastRetentionYears), busy: false, problem: null })
    },
    onTypeOpen: (type) => {
      attempt.current = null
      setDialog({ kind: 'type', draft: typeDraftOf(type), busy: false, problem: null })
    },
    onTypeDraft: (patch) => setDialog((current) => (current?.kind === 'type' ? { ...current, draft: { ...current.draft, ...patch } as TypeDraft, problem: null } : current)),
    onTypeSave: saveType,
    onTypeState: (ids, active) => setDialog({ kind: 'typeState', ids, active, busy: false, problem: null }),
    onTypeStateConfirm: confirmTypeState,
    onIncidentsRetry: () => {
      setIncidents({ status: 'loading' })
      void readIncidentsNow()
    },
    onStepUpSubmit: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
    onLeaveStay: unsaved.stay,
    onLeaveDiscard: () => {
      const to = unsaved.pending
      setLockDraft(null)
      unsaved.stay()
      if (to) router.push(to)
    },
    onLeaveSave: () => {
      const to = unsaved.pending
      setLeaveBusy(true)
      void saveLockCard().then((saved) => {
        setLeaveBusy(false)
        unsaved.stay()
        if (to && saved) router.push(to)
      })
    },
  }

  return { depth, actions }
}
