'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { queryWords, SEARCH_LIMITS } from '@nexus/factory-domain/search/text'
import { useOfficeApi, useOfficeSession } from '../../lib/session/context'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { searchRecords, type SearchAnswer } from './api'
import { canSearchSomething, companyCodeOf, readTerms, resultHref, termsQuery, type SearchTerms } from './model'
import { SearchResultsView, type SearchResultRow, type SearchResultsViewModel } from './view/SearchResultsView'

/**
 * The All results page's container (`/w/<company>/search?q=&type=`; SCR-248; B-W2a-32): reads the address's terms,
 * asks `GET /search` for a page of 50 (the type chip as `type`), the next page with "Show more", maps each result to the
 * address it opens, copies the selected numbers to the clipboard, and keeps the terms in the address (a search is a
 * link). "Still loading…" after about a second. A person whose roles open no record type sees that in words.
 */

const SLOW_MS = 1_000
const TIME_ZONE = 'Europe/Rome'

type State = SearchResultsViewModel['state']

export function SearchPage() {
  const api = useOfficeApi()
  const session = useOfficeSession()
  const router = useRouter()
  const pathname = usePathname() ?? ''
  const params = useSearchParams()
  const terms = useMemo(() => readTerms(params), [params])
  const company = session.company?.code ?? ''
  const place = useMemo(() => ({ built: OFFICE_PAGES, companies: session.companies, company }), [session.companies, company])
  const allowed = canSearchSomething(session.permissions)

  const [state, setState] = useState<State>('start')
  const [answer, setAnswer] = useState<SearchAnswer | null>(null)
  const [rows, setRows] = useState<SearchResultRow[]>([])
  const [loadingMore, setLoadingMore] = useState(false)
  const [notice, setNotice] = useState<SearchResultsViewModel['notice']>(null)
  const request = useRef<AbortController | null>(null)

  const rowsOf = useCallback(
    (page: SearchAnswer): SearchResultRow[] =>
      page.results.map((result) => ({
        recordType: result.recordType,
        recordId: result.recordId,
        number: result.number,
        title: result.title,
        subtitle: result.subtitle,
        status: result.status,
        area: result.area,
        companyCode: companyCodeOf(result.companyId, session.companies),
        match: result.match,
        href: resultHref(result, place),
      })),
    [place, session.companies],
  )

  const load = useCallback(async () => {
    request.current?.abort()
    if (!allowed) return setState('noAccess')
    if (queryWords(terms.q).tooShort) {
      setAnswer(null)
      setRows([])
      return setState('start')
    }
    const controller = new AbortController()
    request.current = controller
    setState('loading')
    const slow = setTimeout(() => setState((current) => (current === 'loading' ? 'slow' : current)), SLOW_MS)
    try {
      const page = await searchRecords(api, { q: terms.q, type: terms.type, limit: SEARCH_LIMITS.page }, controller.signal)
      if (controller.signal.aborted) return
      setAnswer(page)
      setRows(rowsOf(page))
      setState('ready')
    } catch (error) {
      if (controller.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError') return
      setState('error')
    } finally {
      clearTimeout(slow)
    }
  }, [allowed, api, rowsOf, terms.q, terms.type])

  useEffect(() => {
    void load()
    return () => request.current?.abort()
  }, [load])

  const more = async () => {
    if (!answer?.nextOffset || loadingMore) return
    setLoadingMore(true)
    try {
      const page = await searchRecords(api, { q: terms.q, type: terms.type, limit: SEARCH_LIMITS.page, offset: answer.nextOffset })
      setAnswer(page)
      setRows((current) => [...current, ...rowsOf(page).filter((row) => !current.some((seen) => seen.recordId === row.recordId))])
    } catch {
      setNotice({ tone: 'danger', key: 'state.errorTitle' })
    } finally {
      setLoadingMore(false)
    }
  }

  const go = (next: SearchTerms) => router.replace(`${pathname}${termsQuery(next)}`, { scroll: false })

  const model: SearchResultsViewModel = {
    q: terms.q,
    type: terms.type,
    state,
    words: answer?.words ?? [],
    rows,
    counts: answer?.counts ?? [],
    total: answer?.total ?? 0,
    more: answer?.nextOffset !== null && answer?.nextOffset !== undefined,
    loadingMore,
    asOf: answer?.asOf ?? null,
    timeZone: TIME_ZONE,
    notice,
  }

  return (
    <SearchResultsView
      model={model}
      actions={{
        onSearch: (q) => go({ q, type: terms.type }),
        onType: (type) => go({ q: terms.q, type }),
        onMore: () => void more(),
        onRetry: () => void load(),
        onOpen: (row) => router.push(row.href),
        onCopy: (numbers) => {
          if (numbers.length === 0) return
          navigator.clipboard
            ?.writeText(numbers.join('\n'))
            .then(() => setNotice({ tone: 'success', key: 'page.copied', count: numbers.length }))
            .catch(() => setNotice({ tone: 'danger', key: 'page.copyFailed' }))
        },
        onDismissNotice: () => setNotice(null),
      }}
    />
  )
}
