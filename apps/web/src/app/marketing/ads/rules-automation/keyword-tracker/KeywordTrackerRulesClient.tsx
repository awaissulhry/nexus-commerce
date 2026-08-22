'use client'

/**
 * U4 — the Keyword Tracker tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.10 and §7.5. In H10 the Keyword Tracker tab
 * is a single grid — "Showing 0 Keyword Tracker rules" · 🔍 · [+ Rule], columns ☐ · Keyword Tracker
 * Rule ⇅ · Automation · Criteria · Frequency, empty state "Create a Keyword Tracker Rule to
 * generate campaign suggestions" — and nothing else. That is what this renders.
 *
 * 🔴 Same mandatory fix as U3: `RULE_TAB_ACTION_TYPES` now HAS a `keyword-tracker` entry. Without
 * one `ruleBelongsToTab` returns false for every rule, so the grid and the badge would be empty by
 * construction and a rule created in `/builder/keyword-tracker` could never appear on the tab it
 * was created from.
 *
 * The rank report — the one-market gate, feed-health line, watchlist panel, the term grid and the
 * per-term drawer (chart · our ASINs · campaigns bidding it · bid action · change log) — is PARKED
 * in place (`docs/2026-08-16-ra-parked-sections.md`), headed for Analytics › Coverage, with the
 * watchlist itself belonging in the builder's Setup step (H10 puts "+ Create New Keyword Tracker"
 * exactly there). No endpoint retired.
 *
 * ⚠ The header keeps the market picker but drops this page's old one-market GATE. The gate existed
 * because every number on the rank report is a per-marketplace quantity with no honest sum; a rule
 * list has no such number, and refusing to show rules until a market is picked would be a ceremony
 * with nothing behind it.
 */
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

interface FeedHealth {
  rows: number
  keywords: number
  markets: number
  newestCapturedAt: string | null
  coveredTargets: number
  totalTargets: number
}

/**
 * 🔴 KT-P1 (2026-08-22) — the one-line census, live, matching the harvest and negative tabs.
 *
 * Every other tab in this programme states the population its rules act on before the operator
 * builds one. Keyword Tracker had no such line, and it is the tab that needed it most: its rules
 * read `KeywordRank`, which holds **0 rows on production**, so a rule built here matches nothing on
 * every run — and nothing on the page said so.
 *
 * Numbers only, no adjectives, and never fabricated: when the fetch has not landed or failed, the
 * strip does not render at all. An empty feed and an unanswered question must not look alike.
 */
function FeedStrip() {
  const [feed, setFeed] = useState<FeedHealth | null>(null)
  useEffect(() => {
    let live = true
    fetch(`${getBackendUrl()}/api/advertising/keyword-tracker/feed-health`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j && typeof j.rows === 'number') setFeed(j) })
      .catch(() => { /* silence is not zero */ })
    return () => { live = false }
  }, [])
  if (!feed) return null

  const n = (v: number) => v.toLocaleString('en-GB')
  if (feed.rows === 0) {
    return (
      <p className="h10-ktp-strip" role="status">
        <span className="warn">⚠ No keyword rank has ever been recorded.</span>
        <span>
          These rules bid on organic and paid rank, and the rank feed is empty — <b>0</b> observations
          against <b>{n(feed.totalTargets)}</b> keyword targets in your campaigns. A rule created here
          would match nothing on every run, so the builder holds Create until the feed has data.
        </span>
      </p>
    )
  }
  const age = feed.newestCapturedAt
    ? Math.floor((Date.now() - new Date(feed.newestCapturedAt).getTime()) / 86_400_000)
    : null
  return (
    <p className="h10-ktp-strip" role="status">
      <span><b>{n(feed.rows)}</b> rank observations</span>
      <span className="sep">·</span>
      <span><b>{n(feed.keywords)}</b> keywords across <b>{feed.markets}</b> {feed.markets === 1 ? 'market' : 'markets'}</span>
      <span className="sep">·</span>
      {/* The reach that matters is not the feed's size but how much of it a rule can act on: a
          keyword we do not bid on cannot have its bid changed. */}
      <span><b>{n(feed.coveredTargets)}</b> of <b>{n(feed.totalTargets)}</b> keyword targets covered</span>
      {age != null && (<><span className="sep">·</span><span>newest {age === 0 ? 'today' : `${age}d old`}</span></>)}
    </p>
  )
}

export function KeywordTrackerRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Keyword Tracker"
        subtitle="Rules that bid on organic and paid rank — what each one does, and whether it acts on its own"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="keyword-tracker" />
      <FeedStrip />
      <RulesGrid
        tabKey="keyword-tracker"
        noun="Keyword Tracker Rule"
        builderHref="/marketing/ads/rules-automation/builder/keyword-tracker"
        /* H10's KT empty state, verbatim — "campaign suggestions", not "suggestions for a campaign". */
        emptyLine="Create a Keyword Tracker Rule to generate campaign suggestions"
      />
    </div>
  )
}
