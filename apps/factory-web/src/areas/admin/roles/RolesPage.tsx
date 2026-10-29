'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { listRoles, roleCatalogue, type PermissionCatalogue, type Role } from '../shared/api'
import { failed, loaded, loading, problemKey, type Loaded } from '../shared/model'
import type { RolesViewModel } from './model'
import { RolesView } from './view/RolesView'

/**
 * `/w/<company>/admin/roles` (SCR-012): the tenant's roles (`GET /auth/roles`: system roles kept equal to their
 * templates, custom copies with what their template gained) and the permission catalogue for Compare (the ticked
 * roles)
 * (`GET /auth/roles/templates`: every permission with its area, risk and description).
 */
export function RolesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const prefix = companyPrefix(session.company?.code ?? '')
  const [roles, setRoles] = useState<Loaded<Role>>(loading())
  const [catalogue, setCatalogue] = useState<PermissionCatalogue | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [audience, setAudience] = useState<RolesViewModel['audience']>('all')
  const [pages, setPages] = useState(1)

  const load = useCallback(async () => {
    try {
      setRoles(loaded(await listRoles(api)))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setRoles(failed(problemKey(error)))
    }
    roleCatalogue(api).then(setCatalogue, () => setCatalogue(null))
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <RolesView
      model={{ prefix, roles, catalogue, asOf, query, audience, pages }}
      actions={{
        onQuery: (next) => {
          setQuery(next)
          setPages(1)
        },
        onAudience: (next) => {
          setAudience(next)
          setPages(1)
        },
        onMore: () => setPages((current) => current + 1),
        onOpen: (path) => router.push(path),
        onRetry: () => {
          setRoles(loading())
          void load()
        },
      }}
    />
  )
}
