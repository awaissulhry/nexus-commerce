'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useLocale } from '../../../lib/i18n/provider'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useLive } from '../../_shared/buying/hooks'
import {
  createType,
  listLabelTemplates,
  listScales,
  listTypes,
  moveType,
  readChanges,
  readCosting,
  readSettings,
  saveSettings,
  updateType,
  type CostingDefaults,
  type LabelRef,
  type ProductSettings,
  type ProductType,
  type ScaleRef,
} from './api'
import {
  addressOf,
  changedByOf,
  createTypeBody,
  failed,
  inheritedRules,
  LIVE_EVENTS,
  mayKeepTypeOf,
  movable,
  newestChange,
  queryOf,
  readProblemOf,
  reading,
  ready,
  rulesBody,
  rulesChanged,
  rulesDraftOf,
  rulesLoosenings,
  toleranceBody,
  toleranceChanges,
  toleranceDraftOf,
  toleranceHeld,
  typeDraftOf,
  typeProblems,
  inheritedOf,
  updateTypeBody,
  writeProblemOf,
  type Address,
  type ChangedBy,
  type Notice,
  type Read,
  type RulesDraft,
  type ToleranceDraft,
} from './model'
import { ProductSettingsView } from './view/ProductSettingsView'
// B-W2b-283 (FU1:03): the measurement templates a type picks from.
import { listMeasurementTemplates, type TemplateRef } from './template-picker/api'
import type { ProductSettingsModel, SettingsCan, TypeDialogState } from './view-model'

const EMPTY_CHANGES: ProductSettingsModel['changed'] = { rules: null, tolerance: null, types: null }

/** A card's "Changed …" without the audit log: the row's last save when the scope keeps values of its own there. */
function savedAt(settings: ProductSettings, card: 'rules' | 'tolerance'): ChangedBy | null {
  if (!settings.exists || !settings.updatedAt) return null
  const own = card === 'rules' ? settings.editRules.some((entry) => entry.own !== null) : settings.tolerance.own.rule !== null || settings.tolerance.byKind.some((row) => row.own !== null)
  // B-W2b-283 (FU1:04): the person who saved the row last, without audit.read.
  return own ? { at: settings.updatedAt, by: settings.changedBy?.name ?? null } : null
}

/**
 * The Product settings container (`/w/<company>/products/settings`, SCR-251): reads the scope's settings and every
 * company's (what a company follows), the product types, the costing defaults (costing.view) and who changed what
 * (audit.read); keeps the address (`?scope=all`, `?status=`, `?type=<id>|new`); saves each form card at the version read
 * (a looser edit rule: the confirm with the reason first); keeps the types one write each (the dialog, Archive / Restore,
 * the bulk actions); listens to the live stream (a change elsewhere re-reads, or says so while this page holds unsaved
 * changes).
 */
export function ProductSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const locale = useLocale()
  const can: SettingsCan = useMemo(() => {
    const held = new Set(session.permissions)
    return {
      view: held.has('product.styles.view'),
      audit: held.has('audit.read'),
      costing: held.has('costing.view'),
      cost: held.has('money.cost'),
      finance: held.has('invoices.view'),
      labels: held.has('compliance.certificates.view'),
    }
  }, [session.permissions])
  const address = addressOf(params)
  const companyId = session.company?.id ?? null
  const scopeCompany = address.scope === 'company' ? companyId : null
  const rowId = scopeCompany ?? session.tenant.id

  const [settings, setSettings] = useState<Read<ProductSettings>>(reading())
  const [tenant, setTenant] = useState<Read<ProductSettings>>(reading())
  const [rules, setRules] = useState<RulesDraft | null>(null)
  const [tolerance, setTolerance] = useState<ToleranceDraft | null>(null)
  const [types, setTypes] = useState<Read<ProductType[]>>(reading())
  const [selected, setSelected] = useState<readonly string[]>([])
  const [typeDialog, setTypeDialog] = useState<TypeDialogState | null>(null)
  const [scales, setScales] = useState<Read<ScaleRef[]> | null>(null)
  const [labels, setLabels] = useState<Read<LabelRef[]> | null>(null)
  const [templates, setTemplates] = useState<Read<TemplateRef[]> | null>(null) // B-W2b-283
  const [costing, setCosting] = useState<Read<CostingDefaults> | null>(null)
  const [changed, setChanged] = useState<ProductSettingsModel['changed']>(EMPTY_CHANGES)
  const [busy, setBusy] = useState<ProductSettingsModel['busy']>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [loosen, setLoosen] = useState<ProductSettingsModel['loosen']>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [keysOpen, setKeysOpen] = useState(false)
  const createKey = useRef<string | null>(null)

  const writeAddress = useCallback((next: Address) => router.replace(`${pathname}${queryOf(next)}`, { scroll: false }), [pathname, router])

  // ---- reads ----
  const loadChanges = useCallback(
    async (scoped: ProductSettings | null, typeRows: readonly ProductType[] | null) => {
      const fallback = {
        rules: scoped ? savedAt(scoped, 'rules') : null,
        tolerance: scoped ? savedAt(scoped, 'tolerance') : null,
        // B-W2b-283 (FU1:04): the newest type's last changer, without audit.read.
        types: typeRows && typeRows.length > 0 ? (([newest]) => ({ at: newest!.updatedAt, by: newest!.changedBy?.name ?? null }))([...typeRows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) : null,
      }
      if (!can.audit) {
        setChanged(fallback)
        return
      }
      try {
        const [row, typeEntries] = await Promise.all([scoped?.exists ? readChanges(api, 'ProductSettings', rowId, 50) : Promise.resolve([]), readChanges(api, 'ProductTypeProfile', null, 1)])
        setChanged({ rules: changedByOf(row, 'editRule') ?? fallback.rules, tolerance: changedByOf(row, 'consumptionTolerance') ?? fallback.tolerance, types: newestChange(typeEntries) ?? fallback.types })
      } catch {
        setChanged(fallback)
      }
    },
    [api, can.audit, rowId],
  )

  const loadSettings = useCallback(async (): Promise<ProductSettings | null> => {
    if (!can.view) return null
    try {
      const [scoped, wide] = await Promise.all([readSettings(api, scopeCompany), scopeCompany ? readSettings(api, null) : Promise.resolve(null)])
      setSettings(ready(scoped))
      setTenant(ready(wide ?? scoped))
      setRules(rulesDraftOf(scoped))
      setTolerance(toleranceDraftOf(scoped, locale))
      setAsOf(new Date().toISOString())
      setChangedElsewhere(false)
      return scoped
    } catch (error) {
      setSettings(failed(readProblemOf(error)))
      setTenant(failed(readProblemOf(error)))
      return null
    }
  }, [api, can.view, locale, scopeCompany])

  const loadTypes = useCallback(async (): Promise<ProductType[] | null> => {
    if (!can.view) return null
    try {
      const rows = await listTypes(api, scopeCompany)
      setTypes(ready(rows))
      setSelected((current) => current.filter((id) => rows.some((row) => row.id === id)))
      return rows
    } catch (error) {
      setTypes(failed(readProblemOf(error)))
      return null
    }
  }, [api, can.view, scopeCompany])

  const loadCosting = useCallback(async () => {
    if (!can.costing) return
    setCosting(reading())
    try {
      setCosting(ready(await readCosting(api, companyId)))
    } catch (error) {
      setCosting(failed(readProblemOf(error)))
    }
  }, [api, can.costing, companyId])

  const loadAll = useCallback(async () => {
    const [scoped, rows] = await Promise.all([loadSettings(), loadTypes()])
    await loadChanges(scoped, rows)
  }, [loadChanges, loadSettings, loadTypes])

  useEffect(() => {
    setSettings(reading())
    setTenant(reading())
    setTypes(reading())
    setSelected([])
    setChanged(EMPTY_CHANGES)
    void loadAll()
  }, [loadAll])
  useEffect(() => {
    void loadCosting()
  }, [loadCosting])

  // ---- live ----
  const dirty = !!(settings.value && rules && tolerance && (rulesChanged(settings.value, rules).length > 0 || toleranceChanges(settings.value, tolerance, locale) > 0))
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const versionRef = useRef<string | null>(null)
  versionRef.current = settings.value ? `${settings.value.version}:${tenant.value?.version ?? ''}` : null
  const live = useLive(
    (change) => {
      if (!(LIVE_EVENTS as readonly string[]).includes(change.type)) return
      if (change.type === 'product_type.changed') {
        void loadTypes()
        return
      }
      if (!dirtyRef.current) {
        void loadAll()
        return
      }
      // Unsaved changes here: say so only when the row really moved past what this page read (our own save's event does not).
      Promise.all([readSettings(api, scopeCompany), scopeCompany ? readSettings(api, null) : Promise.resolve(null)])
        .then(([scoped, wide]) => `${scoped.version}:${(wide ?? scoped).version}` !== versionRef.current && setChangedElsewhere(true))
        .catch(() => undefined)
    },
    () => {
      if (!dirtyRef.current) void loadAll()
      else void loadTypes()
    },
  )

  // ---- the type dialog follows the address ----
  const pickersRead = useRef(false)
  useEffect(() => {
    if (!address.type || !types.value || !settings.value) {
      if (!address.type) setTypeDialog(null)
      return
    }
    if (typeDialog && (typeDialog.draft.id ?? 'new') === address.type) return
    const type = address.type === 'new' ? null : (types.value.find((entry) => entry.id === address.type) ?? null)
    if (address.type !== 'new' && !type) {
      setNotice({ key: 'problem.typeGone', tone: 'warning' })
      writeAddress({ ...address, type: null })
      return
    }
    createKey.current = null
    const may = (owner: string | null) => mayKeepTypeOf(address.scope, settings.value, tenant.value, live === 'offline', owner)
    // A new type is the company's when the person keeps the company's types, else every company's.
    const owner = address.scope === 'company' && companyId && may(companyId) ? companyId : may(null) ? null : scopeCompany
    setTypeDialog({ draft: typeDraftOf(type, owner), shown: false, problem: null, changedBy: null })
    if (type && can.audit) {
      readChanges(api, 'ProductTypeProfile', type.id, 1)
        .then((entries) => setTypeDialog((current) => (current && current.draft.id === type.id ? { ...current, changedBy: newestChange(entries) } : current)))
        .catch(() => undefined)
    }
    if (!pickersRead.current) {
      pickersRead.current = true
      setScales(reading())
      listScales(api)
        .then((rows) => setScales(ready(rows)))
        .catch((error: unknown) => setScales(failed(readProblemOf(error))))
      // B-W2b-283 (FU1:03): the measurement templates (product.styles.view, as the page).
      setTemplates(reading())
      listMeasurementTemplates(api)
        .then((rows) => setTemplates(ready(rows)))
        .catch((error: unknown) => setTemplates(failed(readProblemOf(error))))
      if (can.labels) {
        setLabels(reading())
        listLabelTemplates(api)
          .then((rows) => setLabels(ready(rows)))
          .catch((error: unknown) => setLabels(failed(readProblemOf(error))))
      }
    }
    // Only the address and the reads open it.
  }, [address.type, types.value, settings.value])

  // ---- edit rules ----
  const sendRules = useCallback(
    async (reason: string | null) => {
      const current = settings.value
      if (!current || !rules) return
      setBusy('rules')
      try {
        const answer = await saveSettings(api, rulesBody(current, rules, reason), newIdempotencyKey())
        setSettings(ready(answer))
        if (!scopeCompany) setTenant(ready(answer))
        setRules(rulesDraftOf(answer))
        setLoosen(null)
        setNotice({ key: reason ? 'done.rulesLoosened' : 'done.rules', tone: 'success' })
        setAsOf(new Date().toISOString())
        void loadChanges(answer, types.value)
      } catch (error) {
        const problem = writeProblemOf(error, address.scope)
        setNotice({ key: problem.key, tone: 'danger' })
        if (problem.reload) {
          setLoosen(null)
          void loadSettings()
        }
      } finally {
        setBusy(null)
      }
    },
    [address.scope, api, loadChanges, loadSettings, rules, scopeCompany, settings.value, types.value],
  )

  const applyRules = useCallback(() => {
    const current = settings.value
    if (!current || !rules) return
    const inherited = inheritedRules(address.scope, current, address.scope === 'all' ? current : tenant.value)
    const loosenings = rulesLoosenings(current, rules, inherited, address.scope)
    if (loosenings.length > 0) setLoosen({ reason: '', loosenings })
    else void sendRules(null)
  }, [address.scope, rules, sendRules, settings.value, tenant.value])

  // ---- consumption tolerance ----
  const applyTolerance = useCallback(async () => {
    const current = settings.value
    if (!current || !tolerance || toleranceHeld(tolerance)) return
    setBusy('tolerance')
    try {
      const answer = await saveSettings(api, toleranceBody(current, tolerance, locale), newIdempotencyKey())
      setSettings(ready(answer))
      if (!scopeCompany) setTenant(ready(answer))
      setTolerance(toleranceDraftOf(answer, locale))
      setNotice({ key: 'done.tolerance', tone: 'success' })
      setAsOf(new Date().toISOString())
      void loadChanges(answer, types.value)
    } catch (error) {
      const problem = writeProblemOf(error, address.scope)
      setNotice({ key: problem.key, tone: 'danger' })
      if (problem.reload) void loadSettings()
    } finally {
      setBusy(null)
    }
  }, [address.scope, api, loadChanges, loadSettings, locale, scopeCompany, settings.value, tolerance, types.value])

  // ---- product types ----
  const closeType = useCallback(() => {
    setTypeDialog(null)
    writeAddress({ ...address, type: null })
  }, [address, writeAddress])

  const saveType = useCallback(async () => {
    if (!typeDialog || !types.value) return
    const draft = typeDialog.draft
    const problems = typeProblems(draft, inheritedOf(types.value, draft))
    if (Object.keys(problems).length > 0) {
      setTypeDialog({ ...typeDialog, shown: true })
      return
    }
    const type = draft.id ? (types.value.find((entry) => entry.id === draft.id) ?? null) : null
    setBusy('type')
    try {
      if (type) {
        await updateType(api, type.id, updateTypeBody(type, draft), newIdempotencyKey())
        setNotice({ key: 'done.typeSaved', tone: 'success', params: { code: draft.code.trim() } })
      } else {
        createKey.current ??= newIdempotencyKey()
        await createType(api, createTypeBody(draft), createKey.current)
        createKey.current = null
        setNotice({ key: 'done.typeAdded', tone: 'success', params: { code: draft.code.trim() } })
      }
      closeType()
      const rows = await loadTypes()
      void loadChanges(settings.value, rows)
    } catch (error) {
      if (!isApiError(error) || error.kind !== 'unavailable') createKey.current = null
      const problem = writeProblemOf(error, draft.companyId === null ? 'all' : 'company')
      setTypeDialog({ ...typeDialog, problem, shown: true })
      if (problem.reload) void loadTypes()
    } finally {
      setBusy(null)
    }
  }, [api, closeType, loadChanges, loadTypes, settings.value, typeDialog, types.value])

  const moveTypes = useCallback(
    async (targets: readonly ProductType[], to: 'archive' | 'restore') => {
      if (targets.length === 0) return
      setBusy('types')
      let done = 0
      for (const type of targets) {
        try {
          await moveType(api, type, to, newIdempotencyKey())
          done += 1
        } catch {
          // Said in the notice's count; the list is read again.
        }
      }
      setBusy(null)
      setSelected([])
      setNotice(
        done === targets.length
          ? { key: to === 'archive' ? 'done.archived' : 'done.restored', tone: 'success', params: { count: done } }
          : { key: to === 'archive' ? 'done.archivedSome' : 'done.restoredSome', tone: 'warning', params: { count: done, total: targets.length } },
      )
      const rows = await loadTypes()
      void loadChanges(settings.value, rows)
    },
    [api, loadChanges, loadTypes, settings.value],
  )

  const model: ProductSettingsModel = {
    prefix: companyPrefix(session.company?.code ?? ''),
    address,
    companyId,
    rowId,
    companyName: session.company?.name ?? session.company?.code ?? '',
    can,
    settings,
    tenant,
    rules,
    tolerance,
    types,
    selected,
    typeDialog,
    scales,
    labels,
    templates, // B-W2b-283
    costing: can.costing ? costing : null,
    changed,
    busy,
    notice,
    loosen,
    live,
    asOf,
    changedElsewhere,
    keysOpen,
  }

  return (
    <ProductSettingsView
      model={model}
      actions={{
        onScope: (scope) => writeAddress({ ...address, scope, type: null }),
        onStatus: (status) => {
          setSelected([])
          writeAddress({ ...address, status })
        },
        onRules: setRules,
        onDiscardRules: () => settings.value && setRules(rulesDraftOf(settings.value)),
        onApplyRules: applyRules,
        onLoosenReason: (reason) => loosen && setLoosen({ ...loosen, reason }),
        onLoosenConfirm: () => loosen && loosen.reason.trim() !== '' && void sendRules(loosen.reason.trim()),
        onLoosenCancel: () => setLoosen(null),
        onTolerance: setTolerance,
        onDiscardTolerance: () => settings.value && setTolerance(toleranceDraftOf(settings.value, locale)),
        onApplyTolerance: () => void applyTolerance(),
        onSelect: (ids) => setSelected([...ids]),
        onTypeOpen: (id) => writeAddress({ ...address, type: id }),
        onTypeDraft: (draft) => typeDialog && setTypeDialog({ ...typeDialog, draft, problem: null }),
        onTypeSave: () => void saveType(),
        onTypeClose: closeType,
        onTypeMove: (type, to) => void moveTypes([type], to),
        onBulkMove: (to) => void moveTypes(movable(types.value ?? [], selected, to).filter((type) => mayKeepTypeOf(address.scope, settings.value, tenant.value, live === 'offline', type.companyId)), to),
        onRetry: () => void loadAll(),
        onRetryTypes: () => void loadTypes(),
        onRetryCosting: () => void loadCosting(),
        onReload: () => {
          void loadAll()
          void loadCosting()
        },
        onDismissNotice: () => setNotice(null),
        onKeys: () => setKeysOpen(true),
        onKeysClose: () => setKeysOpen(false),
      }}
    />
  )
}
