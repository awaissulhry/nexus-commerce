'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { SaveStatusState } from '@nexus/ui/components/SaveStatus/index'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLive } from '../../_shared/buying/hooks'
import { isStepUpCancelled, useStepUp } from '../../quality/_shared/hooks'
import {
  createTolerance,
  fetchKinds,
  fetchRules,
  listMaterials,
  listSuppliers,
  listTolerances,
  moveTolerance,
  readBuyerAlerts,
  readChanges,
  readReminders,
  switchReminders,
  updateTolerance,
  type AuditEntry,
  type Tolerance,
} from './api'
import {
  addressOf,
  adminRuleHref,
  defaultChanges,
  defaultDraftOf,
  defaultProblems,
  defaultWrite,
  draftCreateBody,
  draftProblems,
  draftUpdateBody,
  failed,
  LIVE_EVENTS,
  movable,
  ownDefaultOf,
  poRulesOf,
  queryOf,
  reading,
  readProblemOf,
  ready,
  rulesChangedOf,
  rowsOfScope,
  switchBody,
  switchChangedOf,
  toleranceDraftOf,
  tolerancesChangedOf,
  writeProblemOf,
  type Address,
  type DefaultDraft,
  type Notice,
  type Read,
} from './model'
import type { DialogState, PurchasingSettingsModel, SettingsCan } from './view-model'
import { PurchasingSettingsView } from './view/PurchasingSettingsView'

/**
 * The Purchasing settings container (`/w/<company>/purchasing/settings`, SCR-256, B-W2b-354): reads the PO approval rules
 * and what they may check (approvals.view), the delivery tolerances, the Owner's reminder switch and the buyer's alert
 * (alerts.view), and who changed what (audit.read); keeps the address (`?scope=all`, `?status=`, `?tolerance=<id>|new`);
 * saves the default and each exception at the version read (one write each; the bulk moves one by one); switches the
 * reminders (ON asks a fresh code: the API's step-up, the DS dialog); listens to the live stream (a change elsewhere reads
 * the card again, or says so while this page holds unsaved changes).
 */
export function PurchasingSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const can: SettingsCan = useMemo(() => {
    const held = new Set(session.permissions)
    return {
      view: held.has('purchasing.view'),
      approvals: held.has('approvals.view'),
      rulesManage: held.has('approvals.rules.manage'),
      tolerances: held.has('purchasing.tolerances.manage'),
      alerts: held.has('alerts.view'),
      audit: held.has('audit.read'),
      suppliers: held.has('parties.view'),
      materials: held.has('product.materials.view'),
    }
  }, [session.permissions])
  const address = addressOf(params)
  const companyId = session.company?.id ?? null
  const scopeCompany = address.scope === 'company' ? companyId : null
  const prefix = companyPrefix(session.company?.code ?? '')

  const [rules, setRules] = useState<PurchasingSettingsModel['rules']>(can.approvals ? reading() : null)
  const [kinds, setKinds] = useState<PurchasingSettingsModel['kinds']>(can.approvals ? reading() : null)
  const [tolerances, setTolerances] = useState<Read<Tolerance[]>>(reading())
  const [defaultDraft, setDefaultDraft] = useState<DefaultDraft | null>(null)
  const [selected, setSelected] = useState<readonly string[]>([])
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [suppliers, setSuppliers] = useState<PurchasingSettingsModel['suppliers']>(null)
  const [materials, setMaterials] = useState<PurchasingSettingsModel['materials']>(null)
  const [reminders, setReminders] = useState<PurchasingSettingsModel['reminders']>(reading())
  const [reminderDraft, setReminderDraft] = useState<boolean | null>(null)
  const [alerts, setAlerts] = useState<PurchasingSettingsModel['alerts']>(can.alerts ? reading() : null)
  const [audit, setAudit] = useState<{ tolerances: AuditEntry[] | null; settings: AuditEntry[] | null }>({ tolerances: null, settings: null })
  const [busy, setBusy] = useState<PurchasingSettingsModel['busy']>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [lastFailed, setLastFailed] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const createKey = useRef<string | null>(null)

  const writeAddress = useCallback((next: Address) => router.replace(`${pathname}${queryOf(next)}`, { scroll: false }), [pathname, router])

  // ---- reads ----
  const loadRules = useCallback(async () => {
    if (!can.approvals) return
    try {
      const [answer, kindAnswer] = await Promise.all([fetchRules(api), fetchKinds(api).catch(() => null)])
      setRules(ready(answer))
      setKinds(kindAnswer ? ready(kindAnswer) : failed('problem.read.internal'))
    } catch (error) {
      setRules(failed(readProblemOf(error)))
    }
  }, [api, can.approvals])

  const loadTolerances = useCallback(async (): Promise<Tolerance[] | null> => {
    if (!can.view) return null
    try {
      const rows = rowsOfScope(await listTolerances(api, scopeCompany), address.scope, companyId)
      setTolerances(ready(rows))
      setDefaultDraft(defaultDraftOf(ownDefaultOf(rows, address.scope, companyId)))
      setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
      setAsOf(new Date().toISOString())
      return rows
    } catch (error) {
      setTolerances(failed(readProblemOf(error)))
      return null
    }
  }, [address.scope, api, can.view, companyId, scopeCompany])

  const loadReminders = useCallback(async () => {
    if (!can.view) return
    try {
      const answer = await readReminders(api, scopeCompany)
      setReminders(ready(answer))
      setReminderDraft(answer.on)
    } catch (error) {
      setReminders(failed(readProblemOf(error)))
    }
  }, [api, can.view, scopeCompany])

  const loadAlerts = useCallback(async () => {
    if (!can.alerts) return
    try {
      setAlerts(ready(await readBuyerAlerts(api)))
    } catch (error) {
      setAlerts(failed(readProblemOf(error)))
    }
  }, [api, can.alerts])

  const loadAudit = useCallback(async () => {
    if (!can.audit) return
    const rowId = scopeCompany ?? session.tenant.id
    const [tolerancesAudit, settingsAudit] = await Promise.all([readChanges(api, 'DeliveryTolerance', null, 50).catch(() => null), readChanges(api, 'PurchasingSettings', rowId, 20).catch(() => null)])
    setAudit({ tolerances: tolerancesAudit, settings: settingsAudit })
  }, [api, can.audit, scopeCompany, session.tenant.id])

  const loadAll = useCallback(async () => {
    setChangedElsewhere(false)
    await Promise.all([loadRules(), loadTolerances(), loadReminders(), loadAlerts(), loadAudit()])
  }, [loadAlerts, loadAudit, loadReminders, loadRules, loadTolerances])

  useEffect(() => {
    setTolerances(reading())
    setReminders(reading())
    setDefaultDraft(null)
    setReminderDraft(null)
    setSelected([])
    void loadAll()
  }, [loadAll])

  // ---- live ----
  const rows = tolerances.value
  const ownDefault = rows ? ownDefaultOf(rows, address.scope, companyId) : null
  const defaultDirty = !!(rows && defaultDraft && defaultChanges(ownDefault, defaultDraft) > 0)
  const reminderDirty = reminders.value !== null && reminderDraft !== null && reminderDraft !== reminders.value.on
  const dirtyRef = useRef({ defaultDirty, reminderDirty, dialog: !!dialog })
  dirtyRef.current = { defaultDirty, reminderDirty, dialog: !!dialog }
  const live = useLive(
    (change) => {
      if (!(LIVE_EVENTS as readonly string[]).includes(change.type)) return
      if (change.type === 'approval.rule_changed') return void loadRules()
      if (change.type === 'alert.rule_changed') return void loadAlerts()
      const dirty = change.type === 'purchasing_settings.changed' ? dirtyRef.current.reminderDirty : dirtyRef.current.defaultDirty || dirtyRef.current.dialog
      if (dirty) {
        setChangedElsewhere(true)
        return
      }
      if (change.type === 'purchasing_settings.changed') void loadReminders()
      else void loadTolerances()
      void loadAudit()
    },
    () => {
      if (!dirtyRef.current.defaultDirty && !dirtyRef.current.reminderDirty && !dirtyRef.current.dialog) void loadAll()
      else void loadRules()
    },
  )

  // ---- the dialog follows the address ----
  const pickersRead = useRef(false)
  const readPickers = useCallback(() => {
    if (can.suppliers) {
      setSuppliers(reading())
      listSuppliers(api)
        .then((list) => setSuppliers(ready(list)))
        .catch((error: unknown) => setSuppliers(failed(readProblemOf(error))))
    }
    if (can.materials) {
      setMaterials(reading())
      listMaterials(api)
        .then((list) => setMaterials(ready(list)))
        .catch((error: unknown) => setMaterials(failed(readProblemOf(error))))
    }
  }, [api, can.materials, can.suppliers])
  useEffect(() => {
    if (!address.tolerance || !rows) {
      if (!address.tolerance) setDialog(null)
      return
    }
    if (dialog && (dialog.draft.id ?? 'new') === address.tolerance) return
    const row = address.tolerance === 'new' ? null : (rows.find((entry) => entry.id === address.tolerance) ?? null)
    if (address.tolerance !== 'new' && !row) {
      setNotice({ key: 'problem.toleranceGone', tone: 'warning' })
      writeAddress({ ...address, tolerance: null })
      return
    }
    createKey.current = null
    setDialog({ draft: toleranceDraftOf(row, address.scope === 'company' ? companyId : null), shown: false, problem: null })
    if (!row && !pickersRead.current) {
      pickersRead.current = true
      readPickers()
    }
    // Only the address and the read open it.
  }, [address.tolerance, rows])

  const closeDialog = useCallback(() => {
    setDialog(null)
    writeAddress({ ...address, tolerance: null })
  }, [address, writeAddress])

  // ---- writes ----
  const wrote = useCallback(() => {
    setSavedAt(new Date().toISOString())
    setLastFailed(false)
  }, [])
  const refused = useCallback((error: unknown): ReturnType<typeof writeProblemOf> => {
    const problem = writeProblemOf(error, address.scope)
    setLastFailed(true)
    return problem
  }, [address.scope])

  const applyDefault = useCallback(async () => {
    if (!rows || !defaultDraft) return
    const problems = defaultProblems(defaultDraft)
    if (problems.over || problems.under) return
    const write = defaultWrite(ownDefault, defaultDraft, address.scope, companyId)
    setBusy('default')
    try {
      if (write.kind === 'create') {
        createKey.current ??= newIdempotencyKey()
        await createTolerance(api, write.body, createKey.current)
        createKey.current = null
      } else {
        await updateTolerance(api, write.id, write.body, newIdempotencyKey())
      }
      wrote()
      setNotice({ key: 'done.default', tone: 'success' })
      await loadTolerances()
      void loadAudit()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const problem = refused(error)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) void loadTolerances()
    } finally {
      setBusy(null)
    }
  }, [address.scope, api, companyId, defaultDraft, loadAudit, loadTolerances, ownDefault, refused, rows, wrote])

  const move = useCallback(
    async (targets: readonly Tolerance[], to: 'archive' | 'reactivate', kind: 'default' | 'bulk' | 'dialog') => {
      if (targets.length === 0) return
      setBusy(kind)
      let done = 0
      let last: unknown = null
      for (const target of targets) {
        try {
          await moveTolerance(api, target, to, newIdempotencyKey())
          done += 1
        } catch (error) {
          last = error
        }
      }
      setBusy(null)
      setSelected([])
      if (done > 0) wrote()
      if (last && done === 0) {
        const problem = refused(last)
        setNotice({ key: problem.key, tone: 'danger' })
      } else if (kind === 'default') {
        setNotice({ key: 'done.defaultRemoved', tone: 'success' })
      } else {
        setNotice(
          done === targets.length
            ? { key: to === 'archive' ? 'done.archived' : 'done.reactivated', tone: 'success', params: { count: done } }
            : { key: to === 'archive' ? 'done.archivedSome' : 'done.reactivatedSome', tone: 'warning', params: { count: done, total: targets.length } },
        )
      }
      if (kind === 'dialog' && done > 0) closeDialog()
      await loadTolerances()
      void loadAudit()
    },
    [api, closeDialog, loadAudit, loadTolerances, refused, wrote],
  )

  const saveDialog = useCallback(async () => {
    if (!dialog || !rows) return
    const draft = dialog.draft
    const row = draft.id ? (rows.find((entry) => entry.id === draft.id) ?? null) : null
    const problems = draftProblems(draft, rows)
    if (Object.keys(problems).length > 0) {
      setDialog({ ...dialog, shown: true })
      return
    }
    const update = row ? draftUpdateBody(row, draft) : null
    if (row && !update) return
    setBusy('dialog')
    try {
      if (row && update) {
        await updateTolerance(api, row.id, update, newIdempotencyKey())
        setNotice({ key: 'done.saved', tone: 'success' })
      } else {
        createKey.current ??= newIdempotencyKey()
        await createTolerance(api, draftCreateBody(draft), createKey.current)
        createKey.current = null
        setNotice({ key: 'done.added', tone: 'success' })
      }
      wrote()
      closeDialog()
      await loadTolerances()
      void loadAudit()
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const problem = refused(error)
      setDialog({ ...dialog, problem, shown: true })
      if (problem.reload) void loadTolerances()
    } finally {
      setBusy(null)
    }
  }, [api, closeDialog, dialog, loadAudit, loadTolerances, refused, rows, wrote])

  const applyReminder = useCallback(async () => {
    const settings = reminders.value
    if (!settings || reminderDraft === null || reminderDraft === settings.on) return
    setBusy('reminders')
    try {
      const answer = await guard('stepUp.sentence', () => switchReminders(api, switchBody(settings, reminderDraft, address.scope, companyId), newIdempotencyKey()))
      setReminders(ready(answer))
      setReminderDraft(answer.on)
      wrote()
      setNotice({ key: answer.on ? 'done.remindersOn' : 'done.remindersOff', tone: 'success' })
      void loadAudit()
    } catch (error) {
      if (isStepUpCancelled(error)) {
        setNotice({ key: 'stepUp.cancelled', tone: 'warning' })
      } else {
        const problem = refused(error)
        setNotice({ key: problem.key, tone: 'danger' })
        if (problem.reload) void loadReminders()
      }
    } finally {
      setBusy(null)
    }
  }, [address.scope, api, companyId, guard, loadAudit, loadReminders, refused, reminderDraft, reminders.value, wrote])

  const save: SaveStatusState = busy ? { kind: 'saving' } : defaultDirty || reminderDirty ? { kind: 'unsaved', count: (defaultDirty ? 1 : 0) + (reminderDirty ? 1 : 0) } : lastFailed ? { kind: 'failed', count: 1 } : savedAt ? { kind: 'saved', at: savedAt } : { kind: 'idle' }
  const shownRules = poRulesOf(rules?.value ?? null, address.scope, companyId)

  const model: PurchasingSettingsModel = {
    prefix,
    address,
    companyId,
    companyName: session.company?.name ?? session.company?.code ?? '',
    can,
    rules,
    kinds,
    tolerances,
    defaultDraft,
    selected,
    dialog,
    suppliers,
    materials,
    reminders,
    reminderDraft,
    alerts,
    changed: {
      approval: rulesChangedOf(shownRules),
      tolerance: rows ? tolerancesChangedOf(rows, audit.tolerances) : null,
      confirm: switchChangedOf(reminders.value, address.scope, audit.settings),
    },
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
    <PurchasingSettingsView
      model={model}
      actions={{
        onScope: (scope) => {
          setDialog(null)
          writeAddress({ ...address, scope, tolerance: null })
        },
        onStatus: (status) => {
          setSelected([])
          writeAddress({ ...address, status })
        },
        onOpenRule: (ruleId) => router.push(adminRuleHref(prefix, ruleId)),
        onDefault: setDefaultDraft,
        onDiscardDefault: () => setDefaultDraft(defaultDraftOf(ownDefault)),
        onApplyDefault: () => void applyDefault(),
        onRemoveDefault: () => ownDefault && void move([ownDefault], 'archive', 'default'),
        onSelect: (ids) => setSelected([...ids]),
        onToleranceOpen: (id) => writeAddress({ ...address, tolerance: id }),
        onDraft: (draft) => dialog && setDialog({ ...dialog, draft, problem: null }),
        onDialogSave: () => void saveDialog(),
        onDialogClose: closeDialog,
        onMove: (tolerance, to) => void move([tolerance], to, dialog ? 'dialog' : 'bulk'),
        onBulkMove: (to) => rows && void move(movable(rows, selected, to), to, 'bulk'),
        onReminder: setReminderDraft,
        onDiscardReminder: () => reminders.value && setReminderDraft(reminders.value.on),
        onApplyReminder: () => void applyReminder(),
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpCancel: cancelStepUp,
        onRetry: () => void loadAll(),
        onRetryRules: () => {
          setRules(reading())
          void loadRules()
        },
        onRetryTolerances: () => {
          setTolerances(reading())
          void loadTolerances()
        },
        onRetryReminders: () => {
          setReminders(reading())
          void loadReminders()
        },
        onRetryAlerts: () => void loadAlerts(),
        onRetryPickers: readPickers,
        onReload: () => void loadAll(),
        onDismissNotice: () => setNotice(null),
        onKeys: () => setKeysOpen(true),
        onKeysClose: () => setKeysOpen(false),
      }}
    />
  )
}
