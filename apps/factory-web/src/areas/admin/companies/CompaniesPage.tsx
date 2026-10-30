'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { createCompany, createSite, listCompanies, type CompanyWithSites } from '../shared/api'
import { adminHref, failed, loaded, loading, problemKey, type Loaded, type Notice } from '../shared/model'
import { useNewParam } from '../shared/record-hooks'
import { siteAddress, type OrgDialog } from './model'
import { CompaniesView } from './view/CompaniesView'

/**
 * `/w/<company>/admin/companies` (SCR-008): reads the tree (`GET /org/companies`, archived ones too: the toggle filters
 * here), and makes a company or a site; a new record opens at once (a company on Legal & tax). `?new=company` or
 * `?new=site` opens the dialog (the checklist's "Do it", the palette).
 */
export function CompaniesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const asked = useNewParam()
  const askedCompany = useSearchParams()?.get('company') ?? null
  const [companies, setCompanies] = useState<Loaded<CompanyWithSites>>(loading())
  const [asOf, setAsOf] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [pages, setPages] = useState(1)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [busy, setBusy] = useState(false)
  const [dialogProblem, setDialogProblem] = useState<string | null>(null)
  const dialog: OrgDialog | null = asked === 'company' ? 'new-company' : asked === 'site' ? 'new-site' : null

  const load = useCallback(async () => {
    try {
      setCompanies(loaded(await listCompanies(api, true)))
      setAsOf(new Date().toISOString())
    } catch (error) {
      setCompanies(failed(problemKey(error)))
    }
  }, [api])
  useEffect(() => {
    void load()
  }, [load])

  // Stable: the tree's columns are built with it.
  const onToggle = useCallback((id: string, expanded: boolean) => setCollapsed((current) => (expanded ? current.filter((item) => item !== id) : [...new Set([...current, id])])), [])

  const run = async <T,>(work: () => Promise<T>, open: (value: T) => string): Promise<boolean> => {
    setBusy(true)
    setDialogProblem(null)
    try {
      const value = await work()
      router.push(open(value))
      return true
    } catch (error) {
      setDialogProblem(problemKey(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <CompaniesView
      model={{
        prefix,
        companies,
        asOf,
        can: { manageCompanies: held.has('companies.manage'), viewSites: held.has('sites.view'), manageSites: held.has('sites.manage'), viewCalendars: held.has('calendars.view') },
        currentCompanyId: session.company?.id ?? null,
        query,
        showArchived,
        collapsed,
        pages,
        notice,
        dialog,
        dialogCompanyId: askedCompany,
        busy,
        dialogProblem,
      }}
      actions={{
        onQuery: (next) => {
          setQuery(next)
          setPages(1)
        },
        onShowArchived: setShowArchived,
        onToggle,
        onMore: () => setPages((current) => current + 1),
        onOpen: (path) => router.push(path),
        onRetry: () => {
          setCompanies(loading())
          void load()
        },
        onDialog: (next) => {
          setDialogProblem(null)
          if (!next && asked) router.replace(adminHref(prefix, '/companies'))
        },
        onCreateCompany: (draft) =>
          run(
            () => createCompany(api, { code: draft.code, legalName: draft.legalName.trim(), vatNumber: draft.vatNumber.trim() || null, country: draft.country.trim().toUpperCase() }),
            (company) => `${adminHref(prefix, `/companies/${company.id}`)}?tab=legal`,
          ),
        onCreateSite: (draft) =>
          run(
            () => createSite(api, { companyId: draft.companyId, code: draft.code, name: draft.name.trim(), kind: draft.kind, timezone: draft.timezone, address: siteAddress(draft) }),
            (site) => adminHref(prefix, `/companies/${site.companyId}/sites/${site.id}`),
          ),
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
