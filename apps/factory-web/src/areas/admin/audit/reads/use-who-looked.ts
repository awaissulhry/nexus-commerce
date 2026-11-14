'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '../../../../lib/api/client'
import { searchRecords } from '../../../search/api'
import { problemKey } from '../../shared/model'
import { personReads, readLogStatus, recordReads } from './api'
import { isReadLogType, reasonProblem } from './model'
import type { RecordHit, WhoLookedModel } from './view/WhoLookedCard'

const PAUSE_MS = 250

/**
 * Who looked (SCR-018, B-W2b-413), for audit.reads.view: whether the log is on (`GET /audit/reads/status`), a record found by
 * the global search (`GET /search`, only kinds the read log keeps) and its reads (`GET /audit/reads`), or one person's reads
 * with a reason (`POST /audit/reads/person`; the reason is never kept in the address or the browser). "Show older" pages with
 * the API's cursor.
 */
export function useWhoLooked(api: ApiClient, can: boolean, people: WhoLookedModel['people']) {
  const [logging, setLogging] = useState<boolean | null>(null)
  const [mode, setMode] = useState<WhoLookedModel['mode']>('record')
  const [record, setRecord] = useState<RecordHit | null>(null)
  const [search, setSearch] = useState<WhoLookedModel['search']>({ query: '', state: 'idle', hits: [] })
  const [person, setPerson] = useState<WhoLookedModel['person']>({ userId: '', reason: '', tried: false })
  const [rows, setRows] = useState<WhoLookedModel['rows']>(null)
  const [loading, setLoading] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const asked = useRef('')

  useEffect(() => {
    if (!can) return
    readLogStatus(api).then(setLogging, () => setLogging(null))
  }, [api, can])
  useEffect(() => () => clearTimeout(pause.current), [])

  const readRecord = useCallback(
    async (hit: RecordHit, before: string | null) => {
      setLoading(true)
      setProblem(null)
      try {
        const page = await recordReads(api, hit, before)
        setRows((current) => ({ kind: 'record', reads: before && current?.kind === 'record' ? [...current.reads, ...page.reads] : page.reads }))
        setNextBefore(page.nextBefore)
      } catch (error) {
        setProblem(problemKey(error))
      } finally {
        setLoading(false)
      }
    },
    [api],
  )

  const readPerson = async (before: string | null) => {
    if (person.userId === '' || reasonProblem(person.reason)) return setPerson({ ...person, tried: true })
    setPerson({ ...person, tried: true })
    setLoading(true)
    setProblem(null)
    try {
      const page = await personReads(api, { userId: person.userId, reason: person.reason.trim(), before })
      setRows((current) => ({ kind: 'person', name: page.person.name, reads: before && current?.kind === 'person' ? [...current.reads, ...page.reads] : page.reads }))
      setNextBefore(page.nextBefore)
    } catch (error) {
      setProblem(problemKey(error))
    } finally {
      setLoading(false)
    }
  }

  const query = (text: string) => {
    setSearch((current) => ({ ...current, query: text }))
    clearTimeout(pause.current)
    const words = text.trim()
    asked.current = words
    if (words.length < 2) return setSearch({ query: text, state: 'idle', hits: [] })
    setSearch({ query: text, state: 'loading', hits: [] })
    pause.current = setTimeout(() => {
      searchRecords(api, { q: words, limit: 20 }).then(
        (answer) => {
          if (asked.current !== words) return
          const hits = answer.results.filter((result) => isReadLogType(result.recordType)).map((result) => ({ type: result.recordType, id: result.recordId, title: result.title, number: result.number ?? null }))
          setSearch({ query: text, state: 'ready', hits })
        },
        () => asked.current === words && setSearch({ query: text, state: 'error', hits: [] }),
      )
    }, PAUSE_MS)
  }

  const clear = () => {
    setRows(null)
    setNextBefore(null)
    setProblem(null)
  }

  return {
    model: can ? ({ logging, mode, record, search, people, person, rows, loading, problem, nextBefore } satisfies WhoLookedModel) : null,
    actions: {
      onMode: (next: WhoLookedModel['mode']) => {
        setMode(next)
        clear()
        if (next === 'record' && record) void readRecord(record, null)
      },
      onQuery: query,
      onPick: (hit: RecordHit) => {
        setRecord(hit)
        void readRecord(hit, null)
      },
      onClearRecord: () => {
        setRecord(null)
        clear()
      },
      onPerson: (userId: string) => setPerson((current) => ({ ...current, userId })),
      onReason: (reason: string) => setPerson((current) => ({ ...current, reason })),
      onSearchPerson: () => void readPerson(null),
      onOlder: () => (rows?.kind === 'record' && record ? void readRecord(record, nextBefore) : rows?.kind === 'person' ? void readPerson(nextBefore) : undefined),
      onRetry: () => (mode === 'record' && record ? void readRecord(record, null) : void readPerson(null)),
    },
  }
}
