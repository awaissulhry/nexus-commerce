'use client'

/**
 * U3 — the Share of Voice tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.9 and §7.4. In H10 the SOV tab is a single
 * grid — "Showing 0 rules" · 🔍 · [+ Rule], columns ☐ · SOV Rule ⇅ · Automation · Criteria ·
 * Frequency (· SOV Reports), empty state "Create a rule to generate campaign suggestions" — and
 * nothing else. That is what this renders.
 *
 * 🔴 Like Placement, this tab GAINS a grid: SOV.0 removed `SovTrackerTab kind="sov"`, whose Rules
 * half could never render a row (`liveType="sov"` matched no key), and replaced the whole page with
 * the market-share report. Two fixes were needed to make the grid real, not just present:
 * `RULE_TAB_ACTION_TYPES` now HAS a `share-of-voice` entry (without one `ruleBelongsToTab` returns
 * false for every rule — grid and badge empty by construction), and it derives the builder slug
 * `sov`, so a rule created in `/builder/sov` appears on the tab it was created from.
 *
 * ⚖️ **D4, decided by measurement rather than left blocking (operator may overturn).** H10's grid
 * carries a sixth column, "SOV Reports", naming the SOV *report object* a rule reads — a thing you
 * create under Reporting, up to 20 per account, and a rule breaks when it is deleted. We have no
 * such object: our share is derived from the SQP feed per market, and a rule's market already lives
 * in its scope. A column that would restate the scope on every row is the decorative-column class
 * this programme exists to remove, so it is NOT rendered. If the operator wants SOV report objects
 * as a real thing, that is a build, not a column — say so and it becomes its own unit.
 *
 * The market-share report itself — the gate, freshness band, rejection reckoning, summary strip,
 * signal chips, the query grid with saved views and the row drawer — is PARKED in place
 * (`docs/2026-08-16-ra-parked-sections.md`), headed for Analytics › Coverage. No endpoint retired.
 */
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'
import { getBackendUrl } from '@/lib/backend-url'

const MARKETS = ['IT', 'DE', 'ES', 'FR']

interface SovStripCounts {
  enabledKeywords: number
  measured: number
  medianPct: number | null
  underOnePct: number
}
interface SovStrip extends SovStripCounts {
  byMarket: Record<string, SovStripCounts>
  periods: Array<{ marketplace: string; week: string | null; ageDays: number | null; refused: boolean }>
}

/**
 * 🔴 A rounded 0.00 % is not a zero ([[reference_sov_zero_vs_rounding]]). Measured on this very
 * feed: the smallest real share here is 1 in ~10,000, and `toFixed(2)` renders it as the identical
 * string a genuine zero produces. Anything non-zero below the display precision reads `<0.01%`.
 */
const sharePct = (f: number | null): string => {
  if (f == null) return '—'
  if (f > 0 && f < 0.0001) return '<0.01%'
  return `${(f * 100).toFixed(2)}%`
}

export function SovRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'
  /**
   * SOV-P3 — the NEG-P3/HP4 strip idiom, from the server's own census. Never recomposed
   * client-side, and ABSENT rather than fabricated on a failed read.
   *
   * The two questions it answers are the two an operator cannot otherwise ask before writing their
   * first SOV rule: how many of my keywords does Amazon report a market share for at all, and how
   * old is that reading. The median and the under-1 % count are there so a threshold can be
   * CHOSEN — before P1 every threshold matched ~100 % of rows, and the distribution was the only
   * thing that would have shown it.
   */
  const [strip, setStrip] = useState<SovStrip | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/sov/strip`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null))
        if (alive && j && typeof j.measured === 'number') setStrip(j)
      } catch { /* absent, not fabricated */ }
    })()
    return () => { alive = false }
  }, [])

  const shown = strip?.periods.filter((p) => (market === 'all' ? true : p.marketplace === market)) ?? []
  const refused = shown.filter((p) => p.refused)
  /**
   * 🔴 The counts follow the market selector. Printing the account's totals beside one market's
   * week is a scope lie an operator has no way to detect: on `?market=DE` the strip read
   * "793 of 1,777 … Amazon's week: DE 2026-08-09", and neither number was Germany's. Found by
   * driving the selector on the local rig, not by reading the diff.
   */
  const counts: SovStripCounts | null = !strip ? null : (market === 'all' ? strip : (strip.byMarket?.[market] ?? null))

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Share of Voice"
        subtitle="Rules that bid on share of voice — what each one does, and whether it acts on its own"
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
      <RulesTabs active="share-of-voice" />
      {strip && counts && (
        <p className="h10-hv-cohortline">
          <b>{counts.measured.toLocaleString('en-IE')}</b> of {counts.enabledKeywords.toLocaleString('en-IE')} enabled
          {market === 'all' ? '' : ` ${market}`} keywords
          carry a market share{counts.medianPct != null && <> · median <b>{sharePct(counts.medianPct)}</b></>}
          {counts.underOnePct > 0 && <> · <b>{counts.underOnePct.toLocaleString('en-IE')}</b> under 1%</>}
          {shown.filter((p) => !p.refused).length > 0 && (
            <> · Amazon’s week: {shown.filter((p) => !p.refused).map((p) => `${p.marketplace} ${p.week}${p.ageDays != null ? ` (${p.ageDays}d)` : ''}`).join(' · ')}</>
          )}
          {/* A market the gate refused is the one thing a count cannot show: those keywords are not
              "unmeasured", they are deliberately not offered until Amazon publishes a whole week. */}
          {refused.length > 0 && <> · <b>{refused.map((p) => p.marketplace).join('/')}</b> skipped — no complete week yet</>}
          {' '}· shares come from Amazon’s own search-query report
        </p>
      )}
      <RulesGrid
        tabKey="share-of-voice"
        noun="SOV Rule"
        builderHref="/marketing/ads/rules-automation/builder/sov"
        /* H10's SOV empty state differs from the other types — verbatim from the recording. */
        emptyLine="Create a rule to generate campaign suggestions"
      />
    </div>
  )
}
