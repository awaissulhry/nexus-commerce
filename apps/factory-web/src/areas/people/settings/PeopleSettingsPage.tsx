'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { DEFAULT_ATTENDANCE_SETTINGS, type AttendanceSettings } from '@nexus/factory-domain/people/attendance/rules'
import { newIdempotencyKey } from '../../../lib/api/client'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useOfficeScope } from '../../../shell/scope/scope-context'
import { useLive } from '../../_shared/buying/hooks'
import { isStepUpCancelled, liveMatches, useStepUp } from '../../quality/_shared/hooks'
import { readProblem } from '../_shared/model'
import { addStandardCodes, archiveLimit, changeLeads, createCode, editCode, getCompanyPrivacy, getLimits, getPrivacy, getRounding, getSitePrivacy, listCodes, saveCompanyPrivacy, saveLimit, saveRounding, setCodeState, switchOff, switchOn, type AbsenceCode, type CompanyPrivacy, type Limits, type RuleKind, type SitePrivacy } from './api'
import { blankCode, codeDraftOf, codeFieldsOf, codeHeld, gateReasonHeld, limitBodyOf, limitDraftOf, limitHeld, limitsChanged, privacyDirty, privacyDraftOf, privacyHeld, roundingChanges, roundingDraft, roundingHeld, settingsCan, settingsProblem, type CodeDraft, type LimitDraft, type PrivacyDraft } from './model'
import { useUnsavedGuard } from './use-unsaved-guard'
import type { CodesActions } from './view/AbsenceCard'
import type { GateDialog, PrivacyActions } from './view/PrivacyCard'
import { SettingsView, type Section, type SettingsModel, type SettingsProblem } from './view/SettingsView'

const LIVE = ['people_settings.attendance_changed', 'people_settings.privacy_changed', 'absence_code.changed', 'working_time_rule.changed', 'legal_gate.changed']
const OWN_MS = 5000
const failed = (error: unknown) => ({ status: 'error' as const, problem: readProblem(error) })

/**
 * `/w/<company>/people/settings` (SCR-265): each section reads on its own, with what the person may read (rounding and
 * codes: people.attendance.view or .settings; limits: the top bar's site, else the company; privacy: people.privacy.view).
 * A card's edit stays until saved or discarded, and leaving asks Save · Discard · Stay. Every write is one command with the
 * version read; widening who sees figures and switching a purpose on ask a fresh code when the API answers 403 `stepUp`.
 * Someone else's change → "Changed by someone else · Reload".
 */
export function PeopleSettingsPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const scope = useOfficeScope()
  const router = useRouter()
  const pathname = usePathname()
  const prefix = pathname.replace(/\/people\/settings\/?$/, '')
  const can = useMemo(() => settingsCan(session.permissions), [session.permissions])
  const companyId = session.company?.id ?? null

  const [asOf, setAsOf] = useState<string | null>(null)
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [done, setDone] = useState<SettingsModel['done']>(null)
  const ownUntil = useRef(0)
  const own = () => {
    ownUntil.current = Date.now() + OWN_MS
  }

  // ---- rounding --------------------------------------------------------------------------------------------------------------
  const [roundingRead, setRoundingRead] = useState<SettingsModel['rounding']['read']>({ status: 'loading' })
  const [roundingEdit, setRoundingEdit] = useState<AttendanceSettings | null>(null)
  const [roundingBusy, setRoundingBusy] = useState(false)
  const [roundingProblem, setRoundingProblem] = useState<SettingsProblem | null>(null)
  const readRounding = useCallback(async () => {
    if (!can.attendance || !companyId) return
    try {
      const value = await getRounding(api, companyId)
      setRoundingRead({ status: 'ready', value: { version: value.version, values: roundingDraft(value) } })
      setAsOf(new Date().toISOString())
    } catch (error) {
      setRoundingRead(failed(error))
    }
  }, [api, can.attendance, companyId])

  // ---- absence codes ---------------------------------------------------------------------------------------------------------
  const [codesRead, setCodesRead] = useState<SettingsModel['absence']['read']>({ status: 'loading' })
  const [showArchived, setShowArchived] = useState(false)
  const [codeDialog, setCodeDialog] = useState<SettingsModel['absence']['dialog']>(null)
  const [codesBusy, setCodesBusy] = useState(false)
  const [codesProblem, setCodesProblem] = useState<SettingsProblem | null>(null)
  const readCodes = useCallback(async () => {
    if (!can.attendance) return
    try {
      setCodesRead({ status: 'ready', value: await listCodes(api, companyId) })
    } catch (error) {
      setCodesRead(failed(error))
    }
  }, [api, can.attendance, companyId])

  // ---- limits: the top bar's site, held while the card has edits ------------------------------------------------------------
  const [limitsRead, setLimitsRead] = useState<Section<Limits>>({ status: 'loading' })
  const [limitDrafts, setLimitDrafts] = useState<Record<string, LimitDraft>>({})
  const [limitsBusy, setLimitsBusy] = useState(false)
  const [limitsProblem, setLimitsProblem] = useState<SettingsProblem | null>(null)
  const [limitsSite, setLimitsSite] = useState<string | null>(scope.siteId)
  const limitEntries = limitsRead.status === 'ready' ? limitsRead.value.limits : []
  const limitsDirty = limitsChanged(limitEntries, limitDrafts).length > 0
  const siteScope = useMemo(() => ({ companyId, siteId: limitsSite }), [companyId, limitsSite])
  const readLimits = useCallback(async () => {
    if (!can.limits) return
    try {
      const value = await getLimits(api, siteScope)
      setLimitsRead({ status: 'ready', value })
      setLimitDrafts(Object.fromEntries(value.limits.map((entry) => [entry.kind, limitDraftOf(entry)])))
    } catch (error) {
      setLimitsRead(failed(error))
    }
  }, [api, can.limits, siteScope])
  useEffect(() => {
    if (!limitsDirty) setLimitsSite(scope.siteId)
  }, [scope.siteId, limitsDirty])

  // ---- privacy ---------------------------------------------------------------------------------------------------------------
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const [companyRead, setCompanyRead] = useState<Section<CompanyPrivacy>>({ status: 'loading' })
  const [privacyEdit, setPrivacyEdit] = useState<PrivacyDraft | null>(null)
  const [privacyBusy, setPrivacyBusy] = useState(false)
  const [privacyProblem, setPrivacyProblem] = useState<SettingsProblem | null>(null)
  const [sitesRead, setSitesRead] = useState<Section<SitePrivacy[]>>({ status: 'loading' })
  const [gateDialog, setGateDialog] = useState<GateDialog | null>(null)
  const attempt = useRef<{ body: string; key: string } | null>(null)
  const keyFor = (body: unknown) => {
    const text = JSON.stringify(body)
    if (attempt.current?.body !== text) attempt.current = { body: text, key: newIdempotencyKey() }
    return attempt.current.key
  }
  const readPrivacy = useCallback(async () => {
    if (!can.privacy || !companyId) return
    try {
      setCompanyRead({ status: 'ready', value: await getCompanyPrivacy(api, companyId) })
      const overview = await getPrivacy(api, companyId)
      const chosen = overview.sites.filter((entry) => !scope.siteId || entry.site.id === scope.siteId)
      setSitesRead({ status: 'ready', value: await Promise.all(chosen.map((entry) => getSitePrivacy(api, entry.site.id))) })
    } catch (error) {
      setCompanyRead((current) => (current.status === 'ready' ? current : failed(error)))
      setSitesRead(failed(error))
    }
  }, [api, can.privacy, companyId, scope.siteId])

  useEffect(() => void readRounding(), [readRounding])
  useEffect(() => void readCodes(), [readCodes])
  useEffect(() => void readLimits(), [readLimits])
  useEffect(() => void readPrivacy(), [readPrivacy])

  const live = useLive(
    (change) => {
      if (liveMatches(change, LIVE) && Date.now() > ownUntil.current) setChangedElsewhere(true)
    },
    () => undefined,
    can.privacy || can.attendance || can.limits,
  )

  // ---- saves -----------------------------------------------------------------------------------------------------------------
  const saveRoundingCard = async (): Promise<boolean> => {
    if (roundingRead.status !== 'ready' || !roundingEdit || !companyId || roundingHeld(roundingEdit)) return false
    setRoundingBusy(true)
    setRoundingProblem(null)
    own()
    try {
      const value = await saveRounding(api, { companyId, version: roundingRead.value.version, ...roundingEdit })
      setRoundingRead({ status: 'ready', value: { version: value.version, values: roundingDraft(value) } })
      // Rounding and privacy are two cards of ONE PeopleSettings row: each takes the version the other's save answers.
      setCompanyRead((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, settings: { ...current.value.settings, version: value.version } } } : current))
      setRoundingEdit(null)
      setDone({ key: 'done.rounding' })
      return true
    } catch (error) {
      setRoundingProblem(settingsProblem(error))
      return false
    } finally {
      setRoundingBusy(false)
    }
  }

  const saveLimitsCard = async (): Promise<boolean> => {
    if (limitsRead.status !== 'ready') return false
    const changed = limitsChanged(limitsRead.value.limits, limitDrafts)
    if (changed.length === 0 || changed.some((draft) => limitHeld(draft))) return false
    setLimitsBusy(true)
    setLimitsProblem(null)
    own()
    try {
      for (const draft of changed) await saveLimit(api, limitBodyOf(draft, limitsRead.value.limits.find((entry) => entry.kind === draft.kind)!, siteScope))
      await readLimits()
      setDone({ key: 'done.limits', params: { count: changed.length } })
      return true
    } catch (error) {
      setLimitsProblem(settingsProblem(error))
      await readLimits().catch(() => undefined)
      return false
    } finally {
      setLimitsBusy(false)
    }
  }

  const savePrivacyCard = async (): Promise<boolean> => {
    if (companyRead.status !== 'ready' || !privacyEdit || !companyId || privacyHeld(companyRead.value, privacyEdit)) return false
    const value = companyRead.value
    const body = { minimumGroupSize: privacyEdit.minimumGroupSize, figureRoleKeys: privacyEdit.figureRoleKeys, ...(privacyEdit.reason.trim() ? { reason: privacyEdit.reason.trim() } : {}), ...(value.settings.version !== null ? { version: value.settings.version } : {}) }
    setPrivacyBusy(true)
    setPrivacyProblem(null)
    own()
    try {
      const key = keyFor(body)
      const answer = await guard('stepUp.widen', () => saveCompanyPrivacy(api, companyId, body, key))
      attempt.current = null
      setCompanyRead({ status: 'ready', value: answer })
      setRoundingRead((current) => (current.status === 'ready' ? { status: 'ready', value: { ...current.value, version: answer.settings.version } } : current))
      setPrivacyEdit(null)
      setDone({ key: 'done.privacy' })
      return true
    } catch (error) {
      if (!isStepUpCancelled(error)) setPrivacyProblem(settingsProblem(error))
      return false
    } finally {
      setPrivacyBusy(false)
    }
  }

  const roundingDirty = roundingRead.status === 'ready' && roundingEdit !== null && roundingChanges(roundingRead.value.values, roundingEdit) > 0
  const privacyIsDirty = companyRead.status === 'ready' && privacyEdit !== null && privacyDirty(companyRead.value, privacyEdit)
  const unsaved = useUnsavedGuard(roundingDirty || limitsDirty || privacyIsDirty)
  const [leaveBusy, setLeaveBusy] = useState(false)

  const replaceSite = (next: SitePrivacy) => setSitesRead((current) => (current.status === 'ready' ? { status: 'ready', value: current.value.map((entry) => (entry.site.id === next.site.id ? next : entry)) } : current))

  const codes: CodesActions = {
    onNew: () => setCodeDialog({ draft: blankCode(), busy: false, problem: null }),
    onEdit: (row: AbsenceCode) => setCodeDialog({ draft: codeDraftOf(row), busy: false, problem: null }),
    onDraft: (patch: Partial<CodeDraft>) => setCodeDialog((current) => (current ? { ...current, draft: { ...current.draft, ...patch } } : current)),
    onClose: () => setCodeDialog(null),
    onSave: () => {
      if (!codeDialog || codeDialog.busy || codeHeld(codeDialog.draft)) return
      const { draft } = codeDialog
      setCodeDialog({ ...codeDialog, busy: true, problem: null })
      own()
      const work = draft.id ? editCode(api, draft.id, { ...codeFieldsOf(draft), version: draft.version ?? 1 }) : createCode(api, { ...codeFieldsOf(draft), companyId: draft.group ? null : companyId, code: draft.code.trim() })
      work
        .then(() => {
          setCodeDialog(null)
          setDone({ key: 'done.code', params: { code: draft.code } })
          return readCodes()
        })
        .catch((error: unknown) => setCodeDialog((current) => (current ? { ...current, busy: false, problem: settingsProblem(error) } : current)))
    },
    onState: (rows, to) => {
      setCodesBusy(true)
      setCodesProblem(null)
      own()
      void (async () => {
        let count = 0
        try {
          for (const row of rows) {
            await setCodeState(api, row.id, to, row.version)
            count += 1
          }
          setDone({ key: to === 'archive' ? 'done.archived' : 'done.restored', params: { count } })
        } catch (error) {
          setCodesProblem(settingsProblem(error))
        } finally {
          setCodesBusy(false)
          await readCodes()
        }
      })()
    },
    onStandard: () => {
      setCodesBusy(true)
      setCodesProblem(null)
      own()
      addStandardCodes(api, companyId)
        .then((answer) => {
          setDone({ key: 'done.standard', params: { count: answer.added.length } })
          return readCodes()
        })
        .catch((error: unknown) => setCodesProblem(settingsProblem(error)))
        .finally(() => setCodesBusy(false))
    },
    onShowArchived: setShowArchived,
  }

  const failGate = (error: unknown) => {
    if (isStepUpCancelled(error)) return setGateDialog((current) => (current ? { ...current, busy: false } : current))
    setGateDialog((current) => (current ? { ...current, busy: false, problem: settingsProblem(error) } : current))
  }

  const privacy: PrivacyActions = {
    onDraft: (patch) => setPrivacyEdit((current) => ({ ...(current ?? (companyRead.status === 'ready' ? privacyDraftOf(companyRead.value) : { minimumGroupSize: 3, figureRoleKeys: [], reason: '' })), ...patch })),
    onSave: () => void savePrivacyCard(),
    onDiscard: () => {
      setPrivacyEdit(null)
      setPrivacyProblem(null)
    },
    onSwitchOn: (site, purpose) => setGateDialog({ kind: 'on', site: site.site, purpose, siteBasis: site.siteBasis, basisKind: '', reference: '', coversLeads: false, leads: false, reason: '', busy: false, problem: null }),
    onSwitchOff: (site, entry) => entry.gate && setGateDialog({ kind: 'off', site: site.site, purpose: entry.purpose, version: entry.gate.version, reason: '', busy: false, problem: null }),
    onLeads: (site, entry, next) => {
      if (!entry.gate) return
      if (next) return setGateDialog({ kind: 'leads', site: site.site, version: entry.gate.version, reason: '', busy: false, problem: null })
      // Narrowing never asks: no reason, no code.
      own()
      changeLeads(api, site.site.id, 'PERFORMANCE', { version: entry.gate.version, leadsSeeFigures: false }, newIdempotencyKey())
        .then((answer) => {
          replaceSite(answer)
          setDone({ key: 'done.narrowed' })
        })
        .catch((error: unknown) => setPrivacyProblem(settingsProblem(error)))
    },
    onDialog: (patch) => setGateDialog((current) => (current ? ({ ...current, ...patch } as GateDialog) : current)),
    onDialogClose: () => setGateDialog(null),
    onDialogConfirm: () => {
      if (!gateDialog || gateDialog.busy || gateReasonHeld(gateDialog.reason)) return
      const dialog = gateDialog
      const reason = dialog.reason.trim()
      setGateDialog({ ...dialog, busy: true, problem: null })
      own()
      const finish = (answer: SitePrivacy, key: string) => {
        attempt.current = null
        replaceSite(answer)
        setGateDialog(null)
        setDone({ key })
      }
      if (dialog.kind === 'off') {
        switchOff(api, dialog.site.id, dialog.purpose, { version: dialog.version, reason }).then((answer) => finish(answer, 'done.switchedOff')).catch(failGate)
      } else if (dialog.kind === 'leads') {
        const body = { version: dialog.version, leadsSeeFigures: true, reason }
        const key = keyFor(body)
        guard('stepUp.leads', () => changeLeads(api, dialog.site.id, 'PERFORMANCE', body, key)).then((answer) => finish(answer, 'done.widened')).catch(failGate)
      } else {
        const body = dialog.purpose === 'ATTENDANCE' ? { basis: { kind: dialog.basisKind, reference: dialog.reference.trim() }, reason } : { basisCoversLeads: dialog.coversLeads, leadsSeeFigures: dialog.leads, reason }
        const key = keyFor(body)
        guard('stepUp.switchOn', () => switchOn(api, dialog.site.id, dialog.purpose, body, key)).then((answer) => finish(answer, 'done.switchedOn')).catch(failGate)
      }
    },
    onStepUpSubmit: (code) => void submitStepUp(code),
    onStepUpCancel: cancelStepUp,
  }

  const discardAll = () => {
    setRoundingEdit(null)
    setPrivacyEdit(null)
    void readLimits()
  }

  return (
    <SettingsView
      model={{
        prefix,
        scope,
        can,
        asOf,
        live,
        changedElsewhere,
        done,
        rounding: { read: roundingRead, draft: roundingEdit, busy: roundingBusy, problem: roundingProblem },
        absence: { read: codesRead, showArchived, dialog: codeDialog, busy: codesBusy, problem: codesProblem },
        limits: { read: limitsRead, drafts: limitDrafts, busy: limitsBusy, problem: limitsProblem, scopeName: limitsSite ? (scope.sites.find((site) => site.id === limitsSite)?.name ?? null) : null, waitingScope: limitsSite !== scope.siteId },
        privacy: { company: companyRead, draft: privacyEdit, busy: privacyBusy, problem: privacyProblem, sites: sitesRead, dialog: gateDialog, stepUp },
        leaving: unsaved.pending ? { busy: leaveBusy } : null,
      }}
      actions={{
        onRetry: (section) => {
          if (section === 'rounding') void readRounding()
          else if (section === 'absence') void readCodes()
          else if (section === 'limits') void readLimits()
          else void readPrivacy()
        },
        onReload: () => {
          setChangedElsewhere(false)
          void Promise.all([readRounding(), readCodes(), readLimits(), readPrivacy()])
        },
        onDismissDone: () => setDone(null),
        onRounding: (change) => setRoundingEdit((current) => ({ ...(current ?? (roundingRead.status === 'ready' ? roundingRead.value.values : DEFAULT_ATTENDANCE_SETTINGS)), ...change })),
        onRoundingSave: () => void saveRoundingCard(),
        onRoundingDiscard: () => {
          setRoundingEdit(null)
          setRoundingProblem(null)
        },
        onLimit: (kind: RuleKind, change) => setLimitDrafts((current) => ({ ...current, [kind]: { ...current[kind]!, ...change } })),
        onLimitsSave: () => void saveLimitsCard(),
        onLimitsDiscard: () => {
          setLimitsProblem(null)
          void readLimits()
        },
        onLimitArchive: (kind) => {
          const own_ = limitEntries.find((entry) => entry.kind === kind)?.own
          if (!own_) return
          setLimitsBusy(true)
          setLimitsProblem(null)
          own()
          archiveLimit(api, own_.id, own_.version)
            .then(() => readLimits())
            .catch((error: unknown) => setLimitsProblem(settingsProblem(error)))
            .finally(() => setLimitsBusy(false))
        },
        codes,
        privacy,
        onLeaveStay: unsaved.stay,
        onLeaveDiscard: () => {
          const to = unsaved.pending
          discardAll()
          unsaved.stay()
          if (to) router.push(to)
        },
        onLeaveSave: () => {
          const to = unsaved.pending
          setLeaveBusy(true)
          void (async () => {
            const saved = [roundingDirty ? await saveRoundingCard() : true, limitsDirty ? await saveLimitsCard() : true, privacyIsDirty ? await savePrivacyCard() : true]
            setLeaveBusy(false)
            unsaved.stay()
            if (to && saved.every(Boolean)) router.push(to)
          })()
        },
      }}
    />
  )
}
