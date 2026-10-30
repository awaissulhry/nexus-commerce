'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { queryWords, SEARCH_LIMITS } from '@nexus/factory-domain/search/text'
import { browserApi } from '../../lib/api/browser'
import type { CompanyRef } from '../../lib/session/session'
import { searchRecords } from '../../areas/search/api'
import { resultHref, searchPageHref } from '../../areas/search/model'
import { OFFICE_PAGES } from '../nav/office-nav'
import type { PaletteRecord, PaletteRecords } from './palette-model'

/**
 * The palette's record search (B-W2a-32; SCR-004 Records and Exact number groups): the container side. The palette
 * view reports what is typed (`onQuery`); this waits for a pause (180 ms), asks `GET /search` for the first 8 records
 * as the screen's company, drops an answer to an older query, says "Still loading…" after about a second, and maps each
 * result to the address it opens (its company's Office, its record page or its panels). A query under two characters
 * asks nothing.
 */

const PAUSE_MS = 180
const SLOW_MS = 1_000
const IDLE: PaletteRecords = Object.freeze({ query: '', state: 'idle', hits: [], total: 0, allHref: null })

export function useRecordSearch({ company, companies }: { company: string; companies: readonly CompanyRef[] }): { records: PaletteRecords; onQuery: (query: string) => void } {
  const api = useMemo(() => browserApi({ company }), [company])
  const [records, setRecords] = useState<PaletteRecords>(IDLE)
  const asked = useRef<string | null>(null)
  const timers = useRef<{ pause?: ReturnType<typeof setTimeout>; slow?: ReturnType<typeof setTimeout>; request?: AbortController }>({})
  const place = useMemo(() => ({ built: OFFICE_PAGES, companies, company }), [companies, company])

  const stop = () => {
    clearTimeout(timers.current.pause)
    clearTimeout(timers.current.slow)
    timers.current.request?.abort()
  }
  useEffect(() => stop, [])

  const onQuery = useCallback(
    (raw: string) => {
      const query = raw.trim()
      if (asked.current === query) return
      asked.current = query
      stop()
      if (queryWords(query).tooShort) {
        setRecords(IDLE)
        return
      }
      setRecords({ query, state: 'loading', hits: [], total: 0, allHref: searchPageHref(company, query) })
      timers.current.slow = setTimeout(() => setRecords((current) => (current.query === query && current.state === 'loading' ? { ...current, state: 'slow' } : current)), SLOW_MS)
      timers.current.pause = setTimeout(() => {
        const request = new AbortController()
        timers.current.request = request
        searchRecords(api, { q: query, limit: SEARCH_LIMITS.palette }, request.signal)
          .then((answer) => {
            if (request.signal.aborted || asked.current !== query) return
            clearTimeout(timers.current.slow)
            const hits: PaletteRecord[] = answer.results.map((result) => ({
              recordType: result.recordType,
              recordId: result.recordId,
              number: result.number,
              title: result.title,
              subtitle: result.subtitle,
              status: result.status,
              match: result.match,
              href: resultHref(result, place),
            }))
            setRecords({ query, state: 'ready', hits, total: answer.total, allHref: searchPageHref(company, query) })
          })
          .catch((error: unknown) => {
            if (request.signal.aborted || (error as { name?: string } | null)?.name === 'AbortError' || asked.current !== query) return
            clearTimeout(timers.current.slow)
            setRecords({ query, state: 'error', hits: [], total: 0, allHref: null })
          })
      }, PAUSE_MS)
    },
    [api, company, place],
  )

  return { records, onQuery }
}
