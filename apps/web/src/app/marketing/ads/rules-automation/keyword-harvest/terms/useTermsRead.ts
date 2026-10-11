'use client'

/**
 * Keyword Harvest page, Terms view — the read (2026-10-11, lane TERMS). Every term of the query, all pages at once
 * (GET /candidates, 500 a page, at most `MAX_PAGES` pages in parallel): the table sorts, filters and pages on the client,
 * so Prev / Next in the term's detail walk every page (DS recordNav), and a tile's number is the server's total of the
 * very rows the table holds (audit M1). The server computes every row of a market for any page anyway.
 *
 * A re-read keeps the rows on screen until the new ones come (the selection, the sort and the open detail stay). A failed
 * re-read over rows already shown is said by the view (a banner), never as "No terms".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { readCandidates } from '../_shared/harvestApi'
import type { CandidateQuery, CandidatesAnswer } from '../_shared/types'

export const PAGE_SIZE = 500
export const MAX_PAGES = 10

/** The pages to read after the first: 2..n, at most MAX_PAGES in all. Pure. */
export function morePages(total: number, pageSize = PAGE_SIZE, max = MAX_PAGES): number[] {
  const pages = Math.min(max, Math.ceil(Math.max(0, total) / pageSize))
  return Array.from({ length: Math.max(0, pages - 1) }, (_, i) => i + 2)
}

/** Every page of one query, as one answer (`rows` all pages, the rest from the first page). */
export async function readAllCandidates(q: CandidateQuery): Promise<CandidatesAnswer & { truncated: boolean }> {
  const first = await readCandidates({ ...q, page: 1, pageSize: PAGE_SIZE })
  const rest = await Promise.all(morePages(first.total).map((page) => readCandidates({ ...q, page, pageSize: PAGE_SIZE })))
  const rows = [...first.rows, ...rest.flatMap((a) => a.rows)]
  // One row per id, even when a re-sort on the server moved a row across a page while we read.
  const seen = new Set<string>()
  const unique = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
  return { ...first, rows: unique, truncated: first.total > unique.length }
}

export interface TermsRead {
  answer: (CandidatesAnswer & { truncated: boolean }) | null
  err: string | null
  reading: boolean
  /** Read again in place (after a change): the rows stay until the new ones come. */
  reload(): Promise<void>
}

export function useTermsRead(q: CandidateQuery, enabled = true): TermsRead {
  // A new scope (market, list, product …) drops the rows; a new search reads again in place (no flash per keystroke).
  const scopeKey = JSON.stringify([q.market, q.state ?? null, q.productId ?? null, q.portfolioId ?? null, q.campaignId ?? null, q.adGroupId ?? null, q.owner ?? null, q.kind ?? null])
  const key = `${scopeKey}|${q.q ?? ''}`
  const lastScope = useRef<string | null>(null)
  const [answer, setAnswer] = useState<TermsRead['answer']>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reading, setReading] = useState(true)
  const latest = useRef(q)
  latest.current = q
  const ticket = useRef(0)

  const load = useCallback(async () => {
    const mine = ++ticket.current
    setReading(true)
    try {
      const a = await readAllCandidates({ ...latest.current, sort: '-orders' })
      if (mine !== ticket.current) return
      setAnswer(a)
      setErr(null)
    } catch (e) {
      if (mine !== ticket.current) return
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      if (mine === ticket.current) setReading(false)
    }
  }, [])

  // A new scope: the old rows go, so a row of the old scope is never acted on. A new search keeps them until it answers.
  // One read per query (NICE): the dev double effect, or a re-render with the same query, never reads again.
  const lastKey = useRef<string | null>(null)
  useEffect(() => {
    if (!enabled || lastKey.current === key) return
    lastKey.current = key
    if (lastScope.current !== scopeKey) {
      lastScope.current = scopeKey
      setAnswer(null)
      setErr(null)
    }
    void load()
  }, [key, scopeKey, enabled, load])

  return { answer, err, reading, reload: load }
}
