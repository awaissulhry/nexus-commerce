'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { companyPrefix } from '../../../lib/session/session'
import { useOfficeApi, useOfficeSession } from '../../../lib/session/context'
import { listCompanies, listUsers } from '../shared/api'
import { failed, loaded, loading, problemKey, type Loaded } from '../shared/model'
import { listAudit, type AuditCounts, type AuditEntry } from './api'
import { hiddenGrains, paramsOf, periodFrom, queryOf, recordLabel, stateFromParams, TILE_PERIOD, withQuery, type AuditFilters, type AuditMode, type AuditViewModel } from './model'
import { AuditView } from './view/AuditView'

/** Rows a page reads (Owner L3: 50). */
export const AUDIT_PAGE_SIZE = 50

/**
 * `/w/<company>/admin/audit` (SCR-018): the log (`GET /audit` with the address's filters, 50 a page, "Show older" with
 * the API's cursor), the tiles' counts over the last 30 days (`withCounts`), the office people for the Who filter
 * (`GET /auth/users`, only with users.view) and the companies for "Where" (`GET /org/companies`, only with
 * companies.view). `?open=<id>` opens an entry (a link: Back closes it); its request's other rows are read with
 * `requestId`; J / K and closing replace the address. The address is the state: Back undoes a filter or a mode. No
 * live event reports new audit rows yet: "Updated <time>" says how fresh the page is, and coming back to the tab reads
 * it again.
 */
export function AuditPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const held = useMemo(() => new Set(session.permissions), [session.permissions])
  const prefix = companyPrefix(session.company?.code ?? '')
  const canRead = held.has('audit.read')
  const { filters, mode, open: openId } = stateFromParams(params)
  const filterKey = paramsOf(filters, 'story')

  const [entries, setEntries] = useState<Loaded<AuditEntry>>(loading())
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [older, setOlder] = useState<{ loading: boolean; problem: string | null }>({ loading: false, problem: null })
  const [counts, setCounts] = useState<AuditCounts | null>(null)
  const [asOf, setAsOf] = useState<string | null>(null)
  const [people, setPeople] = useState<AuditViewModel['people']>(null)
  const [companies, setCompanies] = useState<AuditViewModel['companies']>([])
  const [find, setFind] = useState('')
  const [siblings, setSiblings] = useState<{ requestId: string; rows: Loaded<AuditEntry> } | null>(null)
  const seq = useRef(0)

  /** A filter or the mode is a step Back undoes (push); moving inside or closing the open entry replaces it. */
  const go = useCallback(
    (next: AuditFilters, nextMode: AuditMode, open: string | null, how: 'push' | 'replace' = 'push') => {
      const target = withQuery(pathname ?? '', paramsOf(next, nextMode, open))
      if (how === 'push') router.push(target, { scroll: false })
      else router.replace(target, { scroll: false })
    },
    [pathname, router],
  )

  const load = useCallback(async () => {
    if (!canRead) return
    const mine = ++seq.current
    const now = new Date()
    setEntries(loading())
    setOlder({ loading: false, problem: null })
    try {
      const page = await listAudit(api, { ...queryOf(stateFromParams(new URLSearchParams(filterKey)).filters, now), limit: AUDIT_PAGE_SIZE })
      if (mine !== seq.current) return
      setEntries(loaded(page.entries))
      setNextBefore(page.nextBefore)
      setAsOf(now.toISOString())
    } catch (error) {
      if (mine === seq.current) setEntries(failed(problemKey(error)))
    }
    listAudit(api, { withCounts: true, from: periodFrom(TILE_PERIOD, now), limit: 1 }).then(
      (page) => setCounts(page.counts),
      () => setCounts(null),
    )
  }, [api, canRead, filterKey])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  useEffect(() => {
    if (!canRead) return
    if (held.has('users.view'))
      listUsers(api).then(
        (users) => setPeople(users.map((user) => ({ id: user.id, name: user.displayName })).sort((a, b) => a.name.localeCompare(b.name))),
        () => setPeople(null),
      )
    if (held.has('companies.view'))
      listCompanies(api).then(
        (list) => setCompanies(list.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))),
        () => setCompanies([]),
      )
  }, [api, canRead, held])

  const showOlder = async () => {
    if (!nextBefore || older.loading) return
    const mine = seq.current
    setOlder({ loading: true, problem: null })
    try {
      const page = await listAudit(api, { ...queryOf(filters, new Date()), before: nextBefore, limit: AUDIT_PAGE_SIZE })
      if (mine !== seq.current) return
      setEntries((current) => loaded([...(current.items ?? []), ...page.entries]))
      setNextBefore(page.nextBefore)
      setOlder({ loading: false, problem: null })
    } catch (error) {
      if (mine === seq.current) setOlder({ loading: false, problem: problemKey(error) })
    }
  }

  const openEntry = openId ? (entries.items?.find((entry) => entry.id === openId) ?? null) : null
  const requestId = openEntry?.requestId ?? null
  useEffect(() => {
    if (!requestId) return
    setSiblings({ requestId, rows: loading() })
    listAudit(api, { requestId, limit: AUDIT_PAGE_SIZE }).then(
      (page) => setSiblings((current) => (current?.requestId === requestId ? { requestId, rows: loaded(page.entries) } : current)),
      (error: unknown) => setSiblings((current) => (current?.requestId === requestId ? { requestId, rows: failed(problemKey(error)) } : current)),
    )
  }, [api, requestId])

  const named = filters.recordId ? (entries.items?.find((entry) => entry.recordId === filters.recordId) ?? null) : null
  const model: AuditViewModel = {
    prefix,
    mode,
    filters,
    entries,
    nextBefore,
    older,
    counts,
    asOf,
    people,
    companies,
    canRead,
    hiddenGrains: hiddenGrains(session.permissions),
    find,
    open: openId ? { id: openId, entry: openEntry, siblings: siblings && requestId === siblings.requestId ? siblings.rows : loading() } : null,
    recordWords: named ? recordLabel(named) : null,
  }

  return (
    <AuditView
      model={model}
      actions={{
        onFilters: (next) => go(next, mode, null),
        onMode: (next) => go(filters, next, openId),
        onFind: setFind,
        onOpen: (id) => go(filters, mode, id, 'replace'),
        onOlder: () => void showOlder(),
        onRetry: () => void load(),
      }}
    />
  )
}
