'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { editCompany, getCompany, type Company, type Site } from '../shared/api'
import { adminHref, failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { useRecordTab, useThreadDock } from '../shared/record-hooks'
import { COMPANY_TABS, companyPatch, type CompanyDraft } from './model'
import { CompanyRecordView } from './view/CompanyRecordView'

/**
 * `/w/<company>/admin/companies/<id>` (SCR-008 Company record): reads the company and its sites
 * (`GET /org/companies/:id`), saves a form's changed fields with the version read (`PATCH`; a 409 reads it again and
 * says someone else changed it, COL-078), archives it (held while it has an active site), and mounts the record panels.
 */
export function CompanyRecord({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const tab = useRecordTab(COMPANY_TABS)
  const { dockOpen, toggleDock } = useThreadDock('Company')
  const [company, setCompany] = useState<Company | null>(null)
  const [sites, setSites] = useState<Loaded<Site>>(loading())
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [archiving, setArchiving] = useState(false)

  const load = useCallback(async () => {
    try {
      const answer = await getCompany(api, companyId)
      setCompany(answer.company)
      setSites(loaded(answer.sites))
      setProblem(null)
    } catch (error) {
      setProblem(problemKey(error))
      setSites(failed(problemKey(error)))
    }
  }, [api, companyId])
  useEffect(() => {
    void load()
  }, [load])

  const save = async (body: Record<string, unknown> & { version: number }, done: string): Promise<boolean> => {
    setBusy(true)
    setNotice(null)
    try {
      setCompany(await editCompany(api, companyId, body))
      setNotice({ key: done, tone: 'success' })
      return true
    } catch (error) {
      setNotice(problemNotice(error))
      if (isApiError(error) && error.kind === 'conflict') void load()
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <CompanyRecordView
      model={{
        prefix,
        tab,
        company,
        sites,
        problem,
        can: { manageCompanies: held.has('companies.manage'), viewSites: held.has('sites.view'), manageSites: held.has('sites.manage') },
        busy,
        notice,
        archiving,
        dockOpen,
      }}
      panels={company ? <RecordPanels record={{ type: 'Company', id: company.id, companyId: company.id }} title={company.legalName} /> : null}
      actions={{
        onSave: (before: CompanyDraft, after: CompanyDraft, fields) => (company ? save(companyPatch(before, after, fields, company.version), 'company.saved') : Promise.resolve(false)),
        onArchive: setArchiving,
        onArchiveConfirm: async () => {
          if (!company) return false
          const ok = await save({ version: company.version, status: 'ARCHIVED' }, 'company.archived')
          setArchiving(false)
          return ok
        },
        onNewSite: () => router.push(`${adminHref(prefix, '/companies')}?new=site&company=${encodeURIComponent(companyId)}`),
        onDock: toggleDock,
        onRetry: () => {
          setProblem(null)
          setCompany(null)
          void load()
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
