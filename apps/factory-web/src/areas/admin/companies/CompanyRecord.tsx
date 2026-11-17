'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { isApiError } from '../../../lib/api/errors'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { RecordPanels } from '../../../record-panels/RecordPanels'
import { editCompany, getCompany, type Company, type Site } from '../shared/api'
import { adminHref, failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { CompanyCalendarsTab } from './calendars/CompanyCalendarsTab'
import { companyPatch, companyTabOf, type CompanyDraft } from './model'
import { CompanyRecordView } from './view/CompanyRecordView'
// ---- B-TH-269: the docked thread on the company (RecordFrame; Activity's tools in its "⋯") ----
import { OfficeRecordThread } from '../../_shared/record-thread/OfficeRecordThread'
import { printHref } from '../../../shell/print/print-model'

/**
 * `/w/<company>/admin/companies/<id>` (SCR-008 Company record): reads the company and its sites
 * (`GET /org/companies/:id`), saves a form's changed fields with the version read (`PATCH`; a 409 reads it again and
 * says someone else changed it, COL-078), archives it (held while it has an active site), and docks the company's thread beside
 * every tab (B-TH-269: notes only — an admin record has no party, W03; with threads.read). `?tab=legal|sites|defaults|calendars`; the
 * old `activity` lands on Legal & tax with the thread opened. The Calendars tab (B-W2a-59) is its own container
 * (calendars/CompanyCalendarsTab.tsx), mounted only on that tab.
 */
export function CompanyRecord({ companyId }: { companyId: string }) {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const asked = companyTabOf(params?.get('tab'))
  // B-W2a-59: the Calendars tab is absent without calendars.view (the address falls back to Legal & tax).
  const viewCalendars = held.has('calendars.view')
  const tab = asked === 'calendars' && !viewCalendars ? 'legal' : asked
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

  // B-TH-269: the company's thread docked beside every tab (notes only: no party on an admin record, W03), with threads.read (the
  // API asks nothing more of a Company thread); Activity's tools are in its "⋯" (R-ACT). The print view keeps the record panels' form.
  const record = company ? { type: 'Company', id: company.id, companyId: company.id } : null
  const mayThread = held.has('threads.read')
  const thread = company && record && mayThread ? <OfficeRecordThread docked record={record} title={`${company.code} · ${company.legalName}`} recordLabel={company.code} party={null} printHref={printHref(pathname ?? '', params?.toString() ?? '')} /> : null
  const printThread = company && record && mayThread ? <RecordPanels record={record} title={company.legalName} /> : null

  return (
    <CompanyRecordView
      model={{
        prefix,
        tab,
        company,
        sites,
        problem,
        can: { manageCompanies: held.has('companies.manage'), viewSites: held.has('sites.view'), manageSites: held.has('sites.manage'), viewCalendars, manageCalendars: held.has('calendars.manage') },
        busy,
        notice,
        archiving,
        personId: session.user.id, // B-TH-269
      }}
      thread={thread}
      printThread={printThread}
      calendars={company && tab === 'calendars' ? <CompanyCalendarsTab company={company} sites={sites.items ?? []} prefix={prefix} canManage={held.has('calendars.manage')} /> : null}
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
        onOpen: (path) => router.push(path),
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
