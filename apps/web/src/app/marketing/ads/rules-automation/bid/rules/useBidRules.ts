'use client'

/**
 * Bid page — the bid rules of one market (GET /api/advertising/bid-rules), read once for the page: the tiles above both
 * views and the Rules view read the same answer. Read again when any tab announces a rule change (`ads.rule.changed`),
 * unless a review or a dialog is open (the next announcement after it closes brings the page up to date).
 */
import { useCallback, useEffect, useState } from 'react'
import { useAdsSync } from '../../_shared/adsBus'
import type { BidRulesAnswer } from './bidRulesModel'
import { fetchRules } from './ruleApi'

export interface BidRulesData {
  answer: BidRulesAnswer | null
  err: string | null
  /** Read again; resolves to the fresh answer, or null when the read failed (`err` says why). */
  load(): Promise<BidRulesAnswer | null>
  /** Put a fresh answer read elsewhere (a review's re-read) in place. */
  put(answer: BidRulesAnswer): void
  /** Hold the automatic re-read while a review or dialog is open. */
  setPaused(paused: boolean): void
}

export function useBidRules(market: string): BidRulesData {
  const [answer, setAnswer] = useState<BidRulesAnswer | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const load = useCallback(async (): Promise<BidRulesAnswer | null> => {
    try {
      const a = await fetchRules(market)
      setAnswer(a); setErr(null)
      return a
    } catch (e) { setErr((e as Error).message); return null }
  }, [market])
  useEffect(() => { setAnswer(null); void load() }, [load])
  useAdsSync(['ads.rule.changed', 'ads.suggestion.changed'], () => { void load() }, paused)
  return { answer, err, load, put: setAnswer, setPaused }
}
