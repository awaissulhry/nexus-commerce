'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { editCompany, listCompanies, listUsers } from '../shared/api'
import { failed, loaded, loading, problemKey, problemNotice, type Loaded, type Notice } from '../shared/model'
import { listFloorLanguages, setFloorLanguages } from './api'
import { completenessOf, floorRefusalOf, type CompanyLanguage, type FloorProblem, type FloorSite } from './model'
import { LanguagesView } from './view/LanguagesView'

/**
 * `/w/<company>/admin/languages` (SCR-016): the companies with their sites (`GET /org/companies`: language, time zone),
 * the office people's languages (`GET /auth/users`, users.view) and each site's floor languages (`GET
 * /org/floor-languages`, sites.view: the languages, the active workers per language, the worker notice in force); a
 * read the person may not make is not made and its section is absent. Saving a company's language is `PATCH
 * /org/companies/:id` with the version read (companies.manage), one company at a time; a site's floor languages `PUT
 * /org/sites/:id/floor-languages` with the site's version (sites.manage; B-W2a-41), its refusal in the page's words.
 */
export function LanguagesPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const completeness = useMemo(() => completenessOf(CATALOGUE), [])
  const [companies, setCompanies] = useState<Loaded<CompanyLanguage>>(loading())
  const [people, setPeople] = useState<Loaded<{ locale: string }> | null>(held.has('users.view') ? loading() : null)
  const [floor, setFloor] = useState<Loaded<FloorSite> | null>(held.has('sites.view') ? loading() : null)
  const [floorProblem, setFloorProblem] = useState<FloorProblem | null>(null)
  const [floorBusy, setFloorBusy] = useState(false)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const load = useCallback(async () => {
    await Promise.all([
      listCompanies(api).then(
        (items) =>
          setCompanies(
            loaded(
              items.map((company) => ({
                id: company.id,
                code: company.code,
                legalName: company.legalName,
                locale: company.locale,
                timezone: company.timezone,
                status: company.status,
                version: company.version,
                sites: company.sites.map((site) => ({ id: site.id, name: site.name, kind: site.kind, timezone: site.timezone, status: site.status })),
              })),
            ),
          ),
        (error: unknown) => setCompanies(failed(problemKey(error))),
      ),
      held.has('users.view')
        ? listUsers(api).then(
            (items) => setPeople(loaded(items.filter((user) => user.status === 'ACTIVE' || user.status === 'INVITED').map((user) => ({ locale: user.locale })))),
            (error: unknown) => setPeople(failed(problemKey(error))),
          )
        : Promise.resolve(),
      held.has('sites.view')
        ? listFloorLanguages(api).then(
            (items) => setFloor(loaded(items)),
            (error: unknown) => setFloor(failed(problemKey(error))),
          )
        : Promise.resolve(),
    ])
    setAsOf(new Date().toISOString())
  }, [api, held])
  useEffect(() => {
    void load()
  }, [load])

  return (
    <LanguagesView
      model={{ prefix, companies, people, floor, floorProblem, floorBusy, completeness, can: { manage: held.has('companies.manage') }, asOf, busy, notice }}
      actions={{
        onDismissNotice: () => setNotice(null),
        onRetry: () => {
          setCompanies(loading())
          if (floor?.problem) setFloor(loading())
          void load()
        },
        onFloorChange: async (site, dialog, locales, reason) => {
          setFloorBusy(true)
          setFloorProblem(null)
          try {
            const saved = await setFloorLanguages(api, site.id, { version: site.version, locales, ...(reason ? { reason } : {}) })
            setFloor((current) => (current?.items ? loaded(current.items.map((item) => (item.id === saved.id ? saved : item))) : current))
            setNotice({ key: dialog.action === 'add' ? 'langs.floor.done.added' : 'langs.floor.done.removed', tone: 'success', params: { site: `${site.companyCode} › ${site.name}` } })
          } catch (error) {
            const issues = isApiError(error) ? error.issues.map((issue) => ({ path: issuePath(issue).replace(/\./g, '/'), message: issue.message })) : []
            setFloorProblem(floorRefusalOf(site, dialog, isApiError(error) ? error.kind : 'internal', issues, problemKey(error)))
            await load()
          } finally {
            setFloorBusy(false)
          }
        },
        onSave: async (changes) => {
          setBusy(true)
          setNotice(null)
          let saved = 0
          try {
            for (const change of changes) {
              await editCompany(api, change.company.id, { version: change.company.version, locale: change.locale })
              saved += 1
            }
            setNotice({ key: 'langs.done.saved', tone: 'success', params: { count: saved } })
          } catch (error) {
            const refusal = problemNotice(error)
            setNotice(refusal.key === 'problem.conflict' ? { key: 'langs.problem.conflict', tone: 'warning', params: { count: saved } } : refusal)
          } finally {
            setBusy(false)
            await load()
          }
        },
      }}
    />
  )
}
