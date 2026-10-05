'use client'

/**
 * Approvals grid — the queue, read and kept fresh (PLAN §5–§6).
 *
 * One light pair of calls per tick: `GET /api/agent/fleet/approvals/queue?show=…` (the rows on screen, re-read from the
 * top) and `GET /api/agent/fleet/approvals/queue/counts` (the health strip). Every 3 s while a row is starting, running
 * or on hold, every 15 s otherwise, and only while the tab is visible (`useVisibilityPoll`). It never re-reads the
 * decision history.
 *
 * A failed read keeps the rows of the last good read on screen and says so (`error`); it never empties the list, so a
 * failure can never look like "nothing needs you".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { QueueCounts, QueuePage, QueueRow, QueueShow } from '@nexus/shared/approval-queue'

import { getBackendUrl } from '@/lib/backend-url'
import { useVisibilityPoll } from '../../_shared/use-visibility-poll'
import { PAGE_SIZE, appendPage, mergePolledPage, pollInterval, pollLimit } from './queueWords'

export interface ApprovalQueue {
  rows: QueueRow[]
  /** How many rows match `show` on the server (not only those loaded). Null until read. */
  total: number | null
  counts: QueueCounts | null
  /** True until the first read for this `show` answered. */
  loading: boolean
  /** True once a read for this `show` succeeded: an empty list after that is a real "nothing". */
  loaded: boolean
  /** The last read's error, or null. The rows of the last good read stay. */
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  moreError: string | null
  loadMore(): void
  /** Read now (after a decision), without waiting for the next tick. */
  refresh(): void
  /** Changes on every successful read — the drawer re-reads its detail on it. */
  readKey: number
  /** When the rows on screen were read. */
  asOf: Date | null
}

const QUEUE_PATH = '/api/agent/fleet/approvals/queue'

async function readError(response: Response, what: string): Promise<Error> {
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  return new Error(body?.error ?? `${what} could not be read (HTTP ${response.status}).`)
}

const words = (e: unknown) => (e instanceof Error ? e.message : String(e))

export function useApprovalQueue(show: QueueShow): ApprovalQueue {
  const [rows, setRows] = useState<QueueRow[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [total, setTotal] = useState<number | null>(null)
  const [counts, setCounts] = useState<QueueCounts | null>(null)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [readKey, setReadKey] = useState(0)

  // The poll reads through refs: `useVisibilityPoll` keeps one timer and calls the latest `load`.
  const showRef = useRef(show)
  const listRef = useRef<{ rows: QueueRow[]; nextCursor: string | null }>({ rows: [], nextCursor: null })
  /** Bumped when `show` changes: an answer for the old list is dropped, never shown under the new one. */
  const generation = useRef(0)
  /** A read was dropped (the list changed under it) — read again as soon as the poll is free. */
  const readAgain = useRef(false)
  const refreshRef = useRef<() => void>(() => {})

  const apply = useCallback((next: { rows: QueueRow[]; nextCursor: string | null }) => {
    listRef.current = next
    setRows(next.rows)
    setNextCursor(next.nextCursor)
  }, [])

  const load = useCallback(async () => {
    const gen = generation.current
    const limit = pollLimit(listRef.current.rows.length)
    const base = getBackendUrl()
    try {
      const [queueRes, countsRes] = await Promise.all([
        fetch(`${base}${QUEUE_PATH}?show=${encodeURIComponent(showRef.current)}&limit=${limit}`, { cache: 'no-store' }),
        // The strip must never take the list down with it: a failed count read keeps the last counts.
        fetch(`${base}${QUEUE_PATH}/counts`, { cache: 'no-store' }).catch(() => null),
      ])
      if (gen !== generation.current) {
        readAgain.current = true
        return
      }
      if (countsRes?.ok) {
        const c = (await countsRes.json().catch(() => null)) as QueueCounts | null
        if (c) setCounts(c)
      }
      if (!queueRes.ok) throw await readError(queueRes, 'The requests')
      const page = (await queueRes.json()) as QueuePage
      if (gen !== generation.current) {
        readAgain.current = true
        return
      }
      apply(mergePolledPage(listRef.current, page, limit))
      setTotal(page.total)
      setError(null)
      setLoaded(true)
      setLoading(false)
      setReadKey((k) => k + 1)
    } catch (e) {
      if (gen !== generation.current) {
        readAgain.current = true
        return
      }
      setError(e instanceof TypeError ? `Nexus could not be reached: ${e.message}` : words(e))
      setLoading(false)
      // The poll keeps its stamp at the last GOOD read (use-visibility-poll's contract).
      throw e
    } finally {
      if (readAgain.current) {
        readAgain.current = false
        // After the poll's own in-flight flag is released (its `finally` runs before this timer).
        setTimeout(() => refreshRef.current(), 0)
      }
    }
  }, [apply])

  const { asOf, refresh } = useVisibilityPoll(load, pollInterval(rows, counts))
  refreshRef.current = refresh

  // A new list: drop what is on screen and read it now. Not on mount — the poll reads once by itself.
  const mounted = useRef(false)
  useEffect(() => {
    showRef.current = show
    if (!mounted.current) {
      mounted.current = true
      return
    }
    generation.current += 1
    apply({ rows: [], nextCursor: null })
    setTotal(null)
    setLoaded(false)
    setLoading(true)
    setError(null)
    setMoreError(null)
    // When a read for the old list is still in flight this call is dropped by the poll; that read then finds its
    // generation stale and asks for this one again (`readAgain`).
    refreshRef.current()
  }, [show, apply])

  const loadMore = useCallback(() => {
    const cursor = listRef.current.nextCursor
    if (!cursor || loadingMore) return
    const gen = generation.current
    setLoadingMore(true)
    setMoreError(null)
    void (async () => {
      try {
        const r = await fetch(
          `${getBackendUrl()}${QUEUE_PATH}?show=${encodeURIComponent(showRef.current)}&cursor=${encodeURIComponent(cursor)}&limit=${PAGE_SIZE}`,
          { cache: 'no-store' },
        )
        if (!r.ok) throw await readError(r, 'More requests')
        const page = (await r.json()) as QueuePage
        if (gen !== generation.current) return
        apply({ rows: appendPage(listRef.current.rows, page), nextCursor: page.nextCursor })
        setTotal(page.total)
      } catch (e) {
        if (gen === generation.current) setMoreError(e instanceof TypeError ? `Nexus could not be reached: ${e.message}` : words(e))
      } finally {
        setLoadingMore(false)
      }
    })()
  }, [apply, loadingMore])

  const refreshNow = useCallback(() => refreshRef.current(), [])

  return {
    rows,
    total,
    counts,
    loading,
    loaded,
    error,
    hasMore: !!nextCursor,
    loadingMore,
    moreError,
    loadMore,
    refresh: refreshNow,
    readKey,
    asOf,
  }
}
