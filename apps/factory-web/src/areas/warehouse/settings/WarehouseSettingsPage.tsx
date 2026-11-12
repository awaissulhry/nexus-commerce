'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { newIdempotencyKey } from '../../../lib/api/client'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLive } from '../../_shared/buying/hooks'
import { isStepUpCancelled, useStepUp } from '../../quality/_shared/hooks'
import {
  fetchRules,
  readChanges,
  readCrVi,
  readDefaults,
  readRules,
  readSeparation,
  readSites,
  saveAdjustmentApproval,
  saveLowStockAlerts,
  savePostingDates,
  saveSeparation,
  setDefault,
  type AuditEntry,
  type DefaultRow,
  type RulesView,
  type SeparationView,
} from './api'
import {
  addressOf,
  adminRuleHref,
  amountDraftOf,
  amountLoosens,
  amountValueOf,
  bodyCompany,
  cardChangedOf,
  cellKey,
  daysDraftOf,
  daysLoosens,
  daysValueOf,
  defaultsChangedOf,
  defaultWrites,
  dirtyCards,
  failed,
  LIVE_EVENTS,
  queryOf,
  reading,
  readProblemOf,
  ready,
  rowIdOf,
  rowVersion,
  savedCell,
  separationBody,
  separationDraftOf,
  separationLoosens,
  siteOf,
  sitesOfScope,
  writeProblemOf,
  type Address,
  type AlertsDraft,
  type AmountDraft,
  type CellKey,
  type DaysDraft,
  type DefaultPurpose,
  type DefaultsDraft,
  type DirtyCard,
  type HeldItemKind,
  type Notice,
  type Read,
  type SeparationDraft,
} from './model'
import type { Reasons, SettingsCan, WarehouseSettingsModel } from './view-model'
import { WarehouseSettingsView } from './view/WarehouseSettingsView'

const NO_REASONS: Reasons = { separation: '', posting: '', adjust: '' }
type ReasonCard = keyof Reasons

/**
 * The Warehouse rules container (`/w/<company>/warehouse/settings`, SCR-258, B-W2b-355): reads the scope's rules (posting
 * dates, the adjustment value, low-stock alerts; B-W2b-314) and separation switches (B-W2b-299) — in company scope also every
 * company's, for what the company follows —, the sites with their places and a site's default places (B-W2b-289;
 * inventory.locations.view), the STOCK_ADJUSTMENT approval rules (approvals.view), the Cr VI evidence rule in force
 * (quality.lots.view) and who changed what (audit.read). Keeps the address (`?scope=all`, `?site=<id>`). Each card saves on its
 * own at the version read; a loosening save sends the reason and, on the API's 403 step-up, asks a fresh code (the DS dialog)
 * and sends again under the same Idempotency-Key. Listens to the live stream (a change elsewhere reads the card again, or says
 * so while this page holds unsaved changes there).
 */
export function WarehouseSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can: SettingsCan = useMemo(() => {
    const held = new Set(session.permissions)
    return {
      view: held.has('inventory.stock.view') || held.has('inventory.rules.manage'),
      rules: held.has('inventory.rules.manage'),
      locations: held.has('inventory.locations.view'),
      locationsManage: held.has('inventory.locations.manage'),
      cost: held.has('money.cost'),
      approvals: held.has('approvals.view'),
      approvalsManage: held.has('approvals.rules.manage'),
      crVi: held.has('quality.lots.view'),
      audit: held.has('audit.read'),
    }
  }, [session.permissions])
  const address = addressOf(params)
  const companyId = session.company?.id ?? null
  const scopeCompany = bodyCompany(address.scope, companyId)
  const prefix = companyPrefix(session.company?.code ?? '')
  const rowId = rowIdOf(address.scope, companyId, session.tenant.id)

  const [rules, setRules] = useState<Read<RulesView>>(reading())
  const [tenantRules, setTenantRules] = useState<RulesView | null>(null)
  const [separation, setSeparation] = useState<Read<SeparationView>>(reading())
  const [tenantSeparation, setTenantSeparation] = useState<SeparationView | null>(null)
  const [separationDraft, setSeparationDraft] = useState<SeparationDraft | null>(null)
  const [daysDraft, setDaysDraft] = useState<DaysDraft | null>(null)
  const [amountDraft, setAmountDraft] = useState<AmountDraft | null>(null)
  const [alertsDraft, setAlertsDraft] = useState<AlertsDraft | undefined>(undefined)
  const [reasons, setReasons] = useState<Reasons>(NO_REASONS)
  const [reasonAsked, setReasonAsked] = useState<readonly ReasonCard[]>([])
  const [sites, setSites] = useState<WarehouseSettingsModel['sites']>(can.locations ? reading() : null)
  const [defaults, setDefaults] = useState<WarehouseSettingsModel['defaults']>(can.locations ? reading() : null)
  const [defaultsDraft, setDefaultsDraft] = useState<DefaultsDraft>({})
  const [addedKinds, setAddedKinds] = useState<readonly HeldItemKind[]>([])
  const [approvalRules, setApprovalRules] = useState<WarehouseSettingsModel['approvalRules']>(can.approvals ? reading() : null)
  const [crVi, setCrVi] = useState<WarehouseSettingsModel['crVi']>(can.crVi ? reading() : null)
  const [audit, setAudit] = useState<{ rules: AuditEntry[] | null; defaults: AuditEntry[] | null }>({ rules: null, defaults: null })
  const [busy, setBusy] = useState<WarehouseSettingsModel['busy']>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [lastFailed, setLastFailed] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const writeAddress = useCallback((next: Address) => router.replace(`${pathname}${queryOf(next)}`, { scroll: false }), [pathname, router])

  // ---- reads ----
  /** The scope's rules (and, for a company, every company's); `keep`: the drafts stay as typed (a refused save). */
  const loadRules = useCallback(
    async (keep = false) => {
      try {
        const [view, tenant] = await Promise.all([readRules(api, scopeCompany), scopeCompany ? readRules(api, null).catch(() => null) : Promise.resolve(null)])
        setRules(ready(view))
        setTenantRules(tenant)
        if (!keep) {
          setDaysDraft(daysDraftOf(view, address.scope))
          setAmountDraft(amountDraftOf(view, address.scope))
          setAlertsDraft(view.lowStockAlerts.own)
        }
        setAsOf(new Date().toISOString())
      } catch (error) {
        setRules(failed(readProblemOf(error)))
      }
    },
    [address.scope, api, scopeCompany],
  )

  const loadSeparation = useCallback(
    async (keep = false) => {
      try {
        const [view, tenant] = await Promise.all([readSeparation(api, scopeCompany), scopeCompany ? readSeparation(api, null).catch(() => null) : Promise.resolve(null)])
        setSeparation(ready(view))
        setTenantSeparation(tenant)
        if (!keep) setSeparationDraft(separationDraftOf(view))
      } catch (error) {
        setSeparation(failed(readProblemOf(error)))
      }
    },
    [api, scopeCompany],
  )

  const loadSites = useCallback(async () => {
    if (!can.locations) return
    try {
      setSites(ready(await readSites(api)))
    } catch (error) {
      setSites(failed(readProblemOf(error)))
    }
  }, [api, can.locations])

  const scopeSites = sites?.value ? sitesOfScope(sites.value, address.scope, companyId) : null
  const site = scopeSites ? siteOf(scopeSites, address) : null
  const siteId = site?.id ?? null

  const loadDefaults = useCallback(
    async (keep = false): Promise<DefaultRow[] | null> => {
      if (!can.locations || !siteId) return null
      try {
        const rows = await readDefaults(api, siteId)
        setDefaults(ready(rows))
        if (!keep) setDefaultsDraft({})
        return rows
      } catch (error) {
        setDefaults(failed(readProblemOf(error)))
        return null
      }
    },
    [api, can.locations, siteId],
  )

  const loadApprovals = useCallback(async () => {
    if (!can.approvals) return
    try {
      setApprovalRules(ready(await fetchRules(api)))
    } catch (error) {
      setApprovalRules(failed(readProblemOf(error)))
    }
  }, [api, can.approvals])

  const loadCrVi = useCallback(async () => {
    if (!can.crVi) return
    try {
      setCrVi(ready(await readCrVi(api, scopeCompany)))
    } catch (error) {
      setCrVi(failed(readProblemOf(error)))
    }
  }, [api, can.crVi, scopeCompany])

  const loadAudit = useCallback(async () => {
    if (!can.audit) return
    const [rulesAudit, defaultsAudit] = await Promise.all([
      rowId ? readChanges(api, { recordType: 'InventorySettings', recordId: rowId, action: 'inventory.rules.save', limit: 50 }).catch(() => null) : Promise.resolve(null),
      siteId ? readChanges(api, { recordType: 'DefaultLocation', siteId, limit: 1 }).catch(() => null) : Promise.resolve(null),
    ])
    setAudit({ rules: rulesAudit, defaults: defaultsAudit })
  }, [api, can.audit, rowId, siteId])

  const loadAll = useCallback(async () => {
    setChangedElsewhere(false)
    setReasons(NO_REASONS)
    setReasonAsked([])
    await Promise.all([loadRules(), loadSeparation(), loadSites(), loadApprovals(), loadCrVi()])
  }, [loadApprovals, loadCrVi, loadRules, loadSeparation, loadSites])

  useEffect(() => {
    setRules(reading())
    setSeparation(reading())
    setSeparationDraft(null)
    setDaysDraft(null)
    setAmountDraft(null)
    setAlertsDraft(undefined)
    if (can.crVi) setCrVi(reading())
    void loadAll()
    // The scope reads everything again (the address's company and its drafts).
  }, [loadAll])

  useEffect(() => {
    setAddedKinds([])
    setDefaultsDraft({})
    if (siteId) {
      setDefaults(reading())
      void loadDefaults()
    }
  }, [siteId, loadDefaults])

  useEffect(() => {
    void loadAudit()
  }, [loadAudit])

  // ---- what is unsaved ----
  const draftState = { rules, separation, separationDraft, daysDraft, amountDraft, alertsDraft, defaults, defaultsDraft }
  const dirty = dirtyCards(draftState)
  const dirtyRef = useRef<readonly DirtyCard[]>(dirty)
  dirtyRef.current = dirty

  const live = useLive(
    (change) => {
      if (!(LIVE_EVENTS as readonly string[]).includes(change.type)) return
      if (change.type === 'approval.rule_changed') return void loadApprovals()
      if (change.type === 'quality.settings_changed') return void loadCrVi()
      const held = dirtyRef.current
      if (change.type === 'inventory.default_location_changed') {
        if (held.includes('defaults')) return void setChangedElsewhere(true)
        void loadDefaults()
        void loadAudit()
        return
      }
      if (held.some((card) => card !== 'defaults')) return void setChangedElsewhere(true)
      void loadRules()
      void loadSeparation()
      void loadAudit()
    },
    () => {
      if (dirtyRef.current.length === 0) {
        void loadAll()
        void loadDefaults()
      } else {
        void loadApprovals()
        void loadCrVi()
      }
    },
  )

  // ---- writes ----
  const wrote = useCallback(() => {
    setSavedAt(new Date().toISOString())
    setLastFailed(false)
  }, [])

  const forgetReason = useCallback((card: ReasonCard) => {
    setReasons((current) => ({ ...current, [card]: '' }))
    setReasonAsked((current) => current.filter((entry) => entry !== card))
  }, [])

  /** A refused rules save: its words, the reason field when the API asked for it, the rules read again when they moved. */
  const refusedRules = useCallback(
    (error: unknown, card: ReasonCard | null) => {
      if (isStepUpCancelled(error)) {
        setNotice({ key: 'stepUp.cancelled', tone: 'warning' })
        return
      }
      const problem = writeProblemOf(error, address.scope)
      setLastFailed(true)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reason && card) setReasonAsked((current) => (current.includes(card) ? current : [...current, card]))
      if (problem.reload) {
        void loadRules(true)
        void loadSeparation(true)
      }
    },
    [address.scope, loadRules, loadSeparation],
  )

  const version = rowVersion(rules.value, separation.value)

  const applySeparation = useCallback(async () => {
    const view = separation.value
    if (!view || !separationDraft) return
    const loosening = separationLoosens(view, separationDraft, address.scope, tenantSeparation).length > 0
    const body = separationBody(view, separationDraft, address.scope, companyId, version, reasons.separation)
    const key = newIdempotencyKey()
    setBusy('separation')
    try {
      const answer = await guard('stepUp.sentence.separation', () => saveSeparation(api, body, key))
      setSeparation(ready(answer.rules))
      setSeparationDraft(separationDraftOf(answer.rules))
      forgetReason('separation')
      wrote()
      setNotice({ key: answer.loosened.length > 0 || loosening ? 'done.separationOff' : 'done.separation', tone: 'success' })
      void loadRules(true)
      void loadAudit()
    } catch (error) {
      refusedRules(error, 'separation')
    } finally {
      setBusy(null)
    }
  }, [address.scope, api, companyId, forgetReason, guard, loadAudit, loadRules, reasons.separation, refusedRules, separation.value, separationDraft, tenantSeparation, version, wrote])

  /** Posting dates, the adjustment value, low-stock alerts: one PUT each at the row's version. */
  const applyRule = useCallback(
    async (card: 'posting' | 'adjust' | 'alerts') => {
      const view = rules.value
      if (!view) return
      const scope = { companyId: scopeCompany, version }
      const key = newIdempotencyKey()
      setBusy(card)
      try {
        let answer: { rules: RulesView; loosened: boolean }
        if (card === 'posting' && daysDraft) {
          const loosens = daysLoosens(view, daysDraft, address.scope, tenantRules)
          const reason = reasons.posting.trim()
          answer = await guard('stepUp.sentence.posting', () => savePostingDates(api, { ...scope, backDatingDays: daysValueOf(daysDraft), ...(loosens || reason ? { reason } : {}) }, key))
        } else if (card === 'adjust' && amountDraft) {
          const loosens = amountLoosens(view, amountDraft, address.scope, tenantRules)
          const reason = reasons.adjust.trim()
          answer = await guard('stepUp.sentence.adjust', () => saveAdjustmentApproval(api, { ...scope, amount: amountValueOf(amountDraft, view.adjustmentApproval.currency), ...(loosens || reason ? { reason } : {}) }, key))
        } else if (card === 'alerts' && alertsDraft !== undefined) {
          answer = await saveLowStockAlerts(api, { ...scope, on: alertsDraft }, key)
        } else {
          return
        }
        setRules(ready(answer.rules))
        if (card === 'posting') setDaysDraft(daysDraftOf(answer.rules, address.scope))
        if (card === 'adjust') setAmountDraft(amountDraftOf(answer.rules, address.scope))
        if (card === 'alerts') setAlertsDraft(answer.rules.lowStockAlerts.own)
        if (card !== 'alerts') forgetReason(card)
        wrote()
        setNotice({ key: `done.${card}${answer.loosened ? 'Loosened' : ''}`, tone: 'success' })
        void loadSeparation(true)
        void loadAudit()
      } catch (error) {
        refusedRules(error, card === 'alerts' ? null : card)
      } finally {
        setBusy(null)
      }
    },
    [address.scope, alertsDraft, amountDraft, api, daysDraft, forgetReason, guard, loadAudit, loadSeparation, reasons.adjust, reasons.posting, refusedRules, rules.value, scopeCompany, tenantRules, version, wrote],
  )

  /** The default places: one PUT per changed cell, each at the version read; a refused cell stays typed. */
  const applyDefaults = useCallback(async () => {
    const rows = defaults?.value
    if (!rows || !siteId) return
    const writes = defaultWrites(rows, defaultsDraft, siteId)
    if (writes.length === 0) return
    setBusy('defaults')
    let done = 0
    let last: unknown = null
    const kept: Partial<Record<CellKey, string | null>> = {}
    for (const write of writes) {
      try {
        await setDefault(api, write, newIdempotencyKey())
        done += 1
      } catch (error) {
        last = error
        const key = cellKey(write.purpose, write.itemKind)
        kept[key] = defaultsDraft[key] ?? null
      }
    }
    setBusy(null)
    if (done > 0) wrote()
    if (last) {
      const problem = writeProblemOf(last, address.scope)
      setLastFailed(true)
      setNotice(done > 0 ? { key: 'done.defaultsSome', tone: 'warning', params: { count: done, total: writes.length } } : { key: problem.key, tone: 'danger' })
    } else {
      setNotice({ key: 'done.defaults', tone: 'success', params: { count: done } })
    }
    await loadDefaults(true)
    setDefaultsDraft(kept)
    void loadAudit()
  }, [address.scope, api, defaults?.value, defaultsDraft, loadAudit, loadDefaults, siteId, wrote])

  const discard = useCallback(
    (card: DirtyCard) => {
      if (card === 'separation' && separation.value) setSeparationDraft(separationDraftOf(separation.value))
      if (card === 'posting' && rules.value) setDaysDraft(daysDraftOf(rules.value, address.scope))
      if (card === 'adjust' && rules.value) setAmountDraft(amountDraftOf(rules.value, address.scope))
      if (card === 'alerts' && rules.value) setAlertsDraft(rules.value.lowStockAlerts.own)
      if (card === 'defaults') {
        setDefaultsDraft({})
        setAddedKinds([])
      }
      if (card === 'separation' || card === 'posting' || card === 'adjust') forgetReason(card)
    },
    [address.scope, forgetReason, rules.value, separation.value],
  )

  const setCell = useCallback(
    (key: CellKey, locationId: string | null) => {
      const rows = defaults?.value ?? []
      const [purpose, kind] = key.split(':') as [DefaultPurpose, string]
      const saved = savedCell(rows, purpose, kind === '*' ? null : (kind as HeldItemKind))?.location.id ?? null
      setDefaultsDraft((current) => {
        const next: Partial<Record<CellKey, string | null>> = { ...current }
        if (locationId === saved) delete next[key]
        else next[key] = locationId
        return next
      })
    },
    [defaults?.value],
  )

  const save: SaveStatusState = busy ? { kind: 'saving' } : dirty.length > 0 ? { kind: 'unsaved', count: dirty.length } : lastFailed ? { kind: 'failed', count: 1 } : savedAt ? { kind: 'saved', at: savedAt } : { kind: 'idle' }

  const model: WarehouseSettingsModel = {
    prefix,
    address,
    companyId,
    companyName: session.company?.name ?? session.company?.code ?? '',
    can,
    rules,
    tenantRules,
    separation,
    tenantSeparation,
    separationDraft,
    daysDraft,
    amountDraft,
    alertsDraft,
    reasons,
    reasonAsked,
    sites,
    defaults,
    defaultsDraft,
    addedKinds,
    approvalRules,
    crVi,
    changed: {
      separation: cardChangedOf('SEPARATION_OF_DUTIES', separation.value, audit.rules),
      posting: cardChangedOf('POSTING_DATES', rules.value, audit.rules),
      adjust: cardChangedOf('ADJUSTMENT_APPROVAL', rules.value, audit.rules),
      alerts: cardChangedOf('LOW_STOCK_ALERTS', rules.value, audit.rules),
      defaults: defaults?.value ? defaultsChangedOf(defaults.value, audit.defaults) : null,
    },
    rowId,
    busy,
    save,
    notice,
    live,
    asOf,
    changedElsewhere,
    keysOpen,
    stepUp,
  }

  return (
    <WarehouseSettingsView
      model={model}
      actions={{
        onScope: (scope) => writeAddress({ scope, site: null }),
        onSite: (id) => writeAddress({ ...address, site: id }),
        onSeparation: setSeparationDraft,
        onDays: setDaysDraft,
        onAmount: setAmountDraft,
        onAlerts: setAlertsDraft,
        onReason: (card, reason) => setReasons((current) => ({ ...current, [card]: reason })),
        onDiscard: discard,
        onApply: (card) => {
          if (card === 'separation') void applySeparation()
          else if (card === 'defaults') void applyDefaults()
          else void applyRule(card)
        },
        onCell: setCell,
        onAddKind: (kind) => setAddedKinds((current) => (current.includes(kind) ? current : [...current, kind])),
        onOpenRule: (ruleId) => router.push(adminRuleHref(prefix, ruleId)),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onRetry: () => void loadAll(),
        onRetryRules: () => {
          setRules(reading())
          void loadRules()
        },
        onRetrySeparation: () => {
          setSeparation(reading())
          void loadSeparation()
        },
        onRetrySites: () => {
          setSites(reading())
          void loadSites()
        },
        onRetryDefaults: () => {
          setDefaults(reading())
          void loadDefaults()
        },
        onRetryApprovals: () => {
          setApprovalRules(reading())
          void loadApprovals()
        },
        onRetryCrVi: () => {
          setCrVi(reading())
          void loadCrVi()
        },
        onReload: () => {
          void loadAll()
          void loadDefaults()
          void loadAudit()
        },
        onDismissNotice: () => setNotice(null),
        onKeys: () => setKeysOpen(true),
        onKeysClose: () => setKeysOpen(false),
      }}
    />
  )
}
