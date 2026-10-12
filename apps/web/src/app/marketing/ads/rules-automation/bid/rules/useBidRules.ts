'use client'

/**
 * Bid page — the bid rules of one market (GET /api/advertising/bid-rules), read once for the page: the tiles above both
 * views and the Rules view read the same answer. Read again when any tab announces a rule change (`ads.rule.changed`),
 * unless a review or a dialog is open (the next announcement after it closes brings the page up to date).
 *
 * The filter bar's lists (2026-10-12) go with every read: they narrow the clash count only (the page narrows the rules
 * itself). A new filter reads again with the rules left on screen; `listsKey` names the filter the answer was read for, so
 * the count of the filter before is never shown as this one's. A read overtaken by a newer one is not shown.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAdsSync } from '../../_shared/adsBus'
import type { ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import type { BidRulesAnswer } from './bidRulesModel'
import { fetchRules } from './ruleApi'

export interface BidRulesData {
  answer: BidRulesAnswer | null
  /** The filter (its key, '' for none) the answer was read for: its clash count is that filter's. */
  listsKey: string | null
  err: string | null
  /** Read again; resolves to the fresh answer, or null when the read failed (`err` says why). */
  load(): Promise<BidRulesAnswer | null>
  /** Put a fresh answer read elsewhere (a review's re-read, with the page's filter) in place. */
  put(answer: BidRulesAnswer): void
  /** Hold the automatic re-read while a review or dialog is open. */
  setPaused(paused: boolean): void
}

export function useBidRules(market: string, lists?: { key: string; api: ScopeApi } | null): BidRulesData {
  const [answer, setAnswer] = useState<BidRulesAnswer | null>(null)
  const [listsKey, setListsKey] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const filter = useRef(lists ?? null)
  filter.current = lists ?? null
  const reads = useRef(0)
  const load = useCallback(async (): Promise<BidRulesAnswer | null> => {
    const mine = ++reads.current
    const asked = filter.current
    try {
      const a = await fetchRules(market, asked?.api)
      if (mine === reads.current) { setAnswer(a); setListsKey(asked?.key ?? ''); setErr(null) }
      return a
    } catch (e) { if (mine === reads.current) setErr((e as Error).message); return null }
  }, [market])
  useEffect(() => { setAnswer(null); setListsKey(null); void load() }, [load])
  // A new filter: read again; the rules stay on screen meanwhile (only the clash count is the filter's).
  const key = lists?.key ?? ''
  const readFor = useRef(key)
  useEffect(() => { if (key !== readFor.current) { readFor.current = key; void load() } }, [key, load])
  useAdsSync(['ads.rule.changed', 'ads.suggestion.changed'], () => { void load() }, paused)
  const put = useCallback((a: BidRulesAnswer) => {
    reads.current++
    setAnswer(a); setListsKey(filter.current?.key ?? '')
  }, [])
  return { answer, listsKey, err, load, put, setPaused }
}
