'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { useCoalesced, useLive } from '../../_shared/buying/hooks'
import { problemKey } from '../shared/model'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { changeTwoFactor, previewTwoFactor, readFingerprint, recordDrill, securityFacts, twoFactorRoles, type FingerprintAnswer, type SecurityFacts, type TwoFactorList } from './api'
import { changesFor, drillFormErrors, emptyDrillForm, LOADING, NO_DIALOG, securityCan, type Dialog, type DrillForm, type Read, type SecurityViewModel } from './model'
import { SecurityView } from './view/SecurityView'

const LIVE_TYPES = new Set(['security.drill_recorded', 'security.two_factor_changed'])

/** A refusal of a write as one of the page's words (the API's English never shows). */
function writeProblem(error: unknown): string {
  if (isApiError(error) && error.kind === 'invalid') return 'sec.problem.invalid'
  if (isApiError(error) && error.kind === 'conflict') return 'sec.problem.conflict'
  if (isApiError(error) && error.kind === 'forbidden') return 'sec.problem.forbidden'
  return 'sec.problem.failed'
}

/**
 * `/w/<company>/admin/security` (SCR-166): reads the page (`GET /admin/security`, security.view) and, with roles.view, the
 * roles' two-factor rules; reads them again on "Check again", when the tab comes back and on the live events
 * security.drill_recorded and security.two_factor_changed. Writes: a restore drill (its evidence first), the two-factor
 * rule of the ticked roles (preview first, then a fresh code).
 */
export function SecurityPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const can = securityCan(held)
  const prefix = companyPrefix(session.company?.code ?? '')
  const [facts, setFacts] = useState<Read<SecurityFacts>>(can.view ? LOADING : { state: 'no-right' })
  const [twoFactor, setTwoFactor] = useState<Read<TwoFactorList>>(can.roles ? LOADING : { state: 'no-right' })
  const [fingerprint, setFingerprint] = useState<Read<FingerprintAnswer> | null>(null)
  const [dialog, setDialog] = useState<Dialog>(NO_DIALOG)
  const [notice, setNotice] = useState<SecurityViewModel['notice']>(null)
  const evidence = useRef<File | null>(null)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)

  const load = useCallback(async () => {
    if (can.view) {
      securityFacts(api).then(
        (value) => setFacts({ state: 'ok', value }),
        (error: unknown) => setFacts({ state: 'failed', problem: problemKey(error) }),
      )
    }
    if (can.roles) {
      twoFactorRoles(api).then(
        (value) => setTwoFactor({ state: 'ok', value }),
        (error: unknown) => setTwoFactor({ state: 'failed', problem: problemKey(error) }),
      )
    }
  }, [api, can.view, can.roles])

  useEffect(() => {
    void load()
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])
  const reload = useCoalesced(() => void load())
  const live = useLive((change) => (LIVE_TYPES.has(change.type) ? reload() : undefined), reload, can.view || can.roles)

  // The drill dialog: this database's fingerprint at the backup's time, read again whenever that time changes.
  const backupAt = dialog.kind === 'drill' ? dialog.form.backupAt : null
  useEffect(() => {
    if (backupAt === null || backupAt === '') return
    let stale = false
    setDialog((current) => (current.kind === 'drill' ? { ...current, source: LOADING } : current))
    readFingerprint(api, backupAt).then(
      (value) => !stale && setDialog((current) => (current.kind === 'drill' ? { ...current, source: { state: 'ok', value } } : current)),
      (error: unknown) => !stale && setDialog((current) => (current.kind === 'drill' ? { ...current, source: { state: 'failed', problem: problemKey(error) } } : current)),
    )
    return () => {
      stale = true
    }
  }, [api, backupAt])

  const saveDrill = async () => {
    if (dialog.kind !== 'drill' || dialog.busy) return
    const form = dialog.form
    if (Object.keys(drillFormErrors(form, new Date())).length > 0) {
      setDialog({ ...dialog, tried: true })
      return
    }
    setDialog({ ...dialog, tried: true, busy: true, problem: null })
    try {
      const answer = await recordDrill(
        api,
        {
          drilledOn: form.drilledOn,
          environment: form.environment.trim(),
          backupAt: new Date(form.backupAt).toISOString(),
          restored: form.restored.trim(),
          ...(form.durationMinutes !== '' ? { durationMinutes: Number(form.durationMinutes) } : {}),
          ...(form.notes.trim() !== '' ? { notes: form.notes.trim() } : {}),
        },
        evidence.current,
      )
      evidence.current = null
      setDialog(NO_DIALOG)
      setNotice({ key: answer.drill.result === 'PASSED' ? 'sec.notice.drillPassed' : 'sec.notice.drillFailed', tone: answer.drill.result === 'PASSED' ? 'success' : 'warning' })
      void load()
    } catch (error) {
      setDialog((current) => (current.kind === 'drill' ? { ...current, busy: false, problem: writeProblem(error) } : current))
    }
  }

  const openTwoFactor = (roleIds: readonly string[], requireMfa: boolean) => {
    if (twoFactor.state !== 'ok') return
    const changes = changesFor(twoFactor.value.roles, roleIds, requireMfa)
    if (changes.length === 0) return
    setDialog({ kind: 'twoFactor', changes, requireMfa, preview: LOADING, busy: false, problem: null, reason: '' })
    previewTwoFactor(api, changes).then(
      (value) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, preview: { state: 'ok', value } } : current)),
      (error: unknown) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, preview: { state: 'failed', problem: problemKey(error) } } : current)),
    )
  }

  const saveTwoFactor = async () => {
    if (dialog.kind !== 'twoFactor' || dialog.busy || dialog.preview.state !== 'ok' || dialog.preview.value.refusals.length > 0) return
    const { changes, requireMfa, reason } = dialog
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await guard(requireMfa ? 'stepUp.sentence.twoFactorAsk' : 'stepUp.sentence.twoFactorStop', () => changeTwoFactor(api, changes, reason.trim() || undefined))
      setDialog(NO_DIALOG)
      setNotice({ key: requireMfa ? 'sec.notice.asked' : 'sec.notice.stopped', tone: 'success', params: { count: changes.length } })
      void load()
    } catch (error) {
      if (isStepUpCancelled(error)) setDialog((current) => (current.kind === 'twoFactor' ? { ...current, busy: false } : current))
      else setDialog((current) => (current.kind === 'twoFactor' ? { ...current, busy: false, problem: writeProblem(error) } : current))
    }
  }

  return (
    <SecurityView
      model={{ prefix, facts, twoFactor, fingerprint, dialog, notice, live }}
      stepUp={stepUp}
      actions={{
        onRecheck: () => void load(),
        onRetry: () => void load(),
        onDismissNotice: () => setNotice(null),
        onRecordDrill: () => {
          evidence.current = null
          setDialog({ kind: 'drill', form: emptyDrillForm(new Date()), source: LOADING, busy: false, problem: null, tried: false })
        },
        onDrillChange: (patch: Partial<DrillForm>, file?: File | null) => {
          if (file !== undefined) evidence.current = file
          setDialog((current) => (current.kind === 'drill' ? { ...current, form: { ...current.form, ...patch } } : current))
        },
        onDrillSave: () => void saveDrill(),
        onDialogClose: () => {
          evidence.current = null
          setDialog(NO_DIALOG)
        },
        onTwoFactor: openTwoFactor,
        onTwoFactorReason: (reason) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, reason } : current)),
        onTwoFactorSave: () => void saveTwoFactor(),
        onFingerprint: (asOf) => {
          setFingerprint(LOADING)
          readFingerprint(api, asOf === '' ? undefined : asOf).then(
            (value) => setFingerprint({ state: 'ok', value }),
            (error: unknown) => setFingerprint({ state: 'failed', problem: problemKey(error) }),
          )
        },
        onCopy: (text) => {
          void navigator.clipboard?.writeText(text).then(
            () => setNotice({ key: 'sec.notice.copied', tone: 'success' }),
            () => setNotice({ key: 'sec.notice.copyFailed', tone: 'warning' }),
          )
        },
        onStepUpSubmit: (code) => void submitStepUp(code),
        onStepUpClose: cancelStepUp,
      }}
    />
  )
}
