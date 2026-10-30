'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { listCompanies, listRoles, listUsers, roleCatalogue, type PermissionCatalogue, type Role, type User } from '../shared/api'
import { failed, loaded, loading, problemKey, type Loaded, type ScopeOption } from '../shared/model'
import { useRecordTab, useThreadDock } from '../shared/record-hooks'
import { isStepUpCancelled, useStepUp } from '../shared/step-up'
import { changeTwoFactor, previewTwoFactor, twoFactorRoles, type TwoFactorRole } from '../security/api'
import { LOADING, NO_DIALOG, type Dialog, type Read } from '../security/model'
import { AdminMessages, StepUp } from '../shared/view/parts'
import { ROLE_TABS } from './model'
import { RoleRecordView } from './view/RoleRecordView'

/**
 * `/w/<company>/admin/roles/<id>` (SCR-012 Role record): the role from `GET /auth/roles` (no read of one role exists),
 * the catalogue for its permissions in words, and its holders from `GET /auth/users` (users.view; without it the Users
 * tab says so).
 */
export function RoleRecord({ roleId }: { roleId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(ROLE_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Role')
  const [role, setRole] = useState<Role | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null)
  const [holders, setHolders] = useState<Loaded<User>>(loading())
  const [companies, setCompanies] = useState<ScopeOption[]>([])
  // B-W2a-36: Scope rules › Two-factor (GET /admin/security/two-factor, roles.view).
  const [twoFactor, setTwoFactor] = useState<Read<TwoFactorRole>>(held.has('roles.view') ? LOADING : { state: 'no-right' })
  const [canChange, setCanChange] = useState(false)
  const [dialog, setDialog] = useState<Dialog>(NO_DIALOG)
  const { stepUp, guard, submitStepUp, cancelStepUp } = useStepUp(api)
  const loadTwoFactor = useCallback(() => {
    if (!held.has('roles.view')) return
    twoFactorRoles(api).then(
      (list) => {
        const found = list.roles.find((item) => item.id === roleId)
        setCanChange(list.canChange)
        setTwoFactor(found ? { state: 'ok', value: found } : { state: 'no-right' })
      },
      (error: unknown) => setTwoFactor({ state: 'failed', problem: problemKey(error) }),
    )
  }, [api, held, roleId])

  const load = useCallback(async () => {
    try {
      const found = (await listRoles(api)).find((item) => item.id === roleId) ?? null
      setRole(found)
      setProblem(found ? null : 'problem.notFound')
    } catch (error) {
      setProblem(problemKey(error))
    }
    roleCatalogue(api).then(setCatalogue, () => setCatalogue(null))
    if (held.has('users.view'))
      listUsers(api).then(
        (users) => setHolders(loaded(users)),
        (error: unknown) => setHolders(failed(problemKey(error))),
      )
    else setHolders(failed('problem.forbidden'))
    if (held.has('companies.view'))
      listCompanies(api).then(
        (items) => setCompanies(items.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))),
        () => undefined,
      )
  }, [api, held, roleId])
  useEffect(() => {
    void load()
    loadTwoFactor()
  }, [load, loadTwoFactor])

  const saveTwoFactor = async () => {
    if (dialog.kind !== 'twoFactor' || dialog.busy || dialog.preview.state !== 'ok' || dialog.preview.value.refusals.length > 0) return
    const { changes, requireMfa, reason } = dialog
    setDialog({ ...dialog, busy: true, problem: null })
    try {
      await guard(requireMfa ? 'stepUp.sentence.twoFactorAsk' : 'stepUp.sentence.twoFactorStop', () => changeTwoFactor(api, changes, reason.trim() || undefined))
      setDialog(NO_DIALOG)
      void load()
      loadTwoFactor()
    } catch (error) {
      setDialog((current) => (current.kind === 'twoFactor' ? { ...current, busy: false, problem: isStepUpCancelled(error) ? null : 'sec.problem.failed' } : current))
    }
  }

  return (
    <>
    <RoleRecordView
      model={{ prefix, tab, role, problem: role ? null : problem, catalogue, holders, companies, dockOpen, twoFactor: { role: twoFactor, canChange, dialog } }}
      panels={role ? <RecordPanels record={{ type: 'Role', id: role.id, companyId: null }} title={role.name} /> : null}
      actions={{
        onOpen: (path) => router.push(path),
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          void load()
        },
        twoFactor: {
          onRetry: loadTwoFactor,
          onSave: (requireMfa) => {
            if (twoFactor.state !== 'ok') return
            const changes = [{ roleId: twoFactor.value.id, version: twoFactor.value.version, requireMfa }]
            setDialog({ kind: 'twoFactor', changes, requireMfa, preview: LOADING, busy: false, problem: null, reason: '' })
            previewTwoFactor(api, changes).then(
              (value) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, preview: { state: 'ok', value } } : current)),
              (error: unknown) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, preview: { state: 'failed', problem: problemKey(error) } } : current)),
            )
          },
          onTwoFactorReason: (reason) => setDialog((current) => (current.kind === 'twoFactor' ? { ...current, reason } : current)),
          onTwoFactorSave: () => void saveTwoFactor(),
          onDialogClose: () => setDialog(NO_DIALOG),
        },
      }}
    />
    <AdminMessages>
      <StepUp model={stepUp} onSubmit={(code) => void submitStepUp(code)} onClose={cancelStepUp} />
    </AdminMessages>
    </>
  )
}
