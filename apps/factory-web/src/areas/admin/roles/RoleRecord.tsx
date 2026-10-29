'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { listCompanies, listRoles, listUsers, roleCatalogue, type PermissionCatalogue, type Role, type User } from '../shared/api'
import { failed, loaded, loading, problemKey, type Loaded, type ScopeOption } from '../shared/model'
import { useRecordTab, useThreadDock } from '../shared/record-hooks'
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
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(ROLE_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Role')
  const [role, setRole] = useState<Role | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null)
  const [holders, setHolders] = useState<Loaded<User>>(loading())
  const [companies, setCompanies] = useState<ScopeOption[]>([])

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
  }, [load])

  return (
    <RoleRecordView
      model={{ prefix, tab, role, problem: role ? null : problem, catalogue, holders, companies, dockOpen }}
      panels={role ? <RecordPanels record={{ type: 'Role', id: role.id, companyId: null }} title={role.name} /> : null}
      actions={{
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          void load()
        },
      }}
    />
  )
}
