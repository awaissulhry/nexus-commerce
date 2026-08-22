'use client'

/**
 * U2 — the Placement tab, reduced to Helium 10's shape: page header · tab bar · ONE rules card.
 *
 * Study `docs/2026-08-16-ra-h10-reference-study.md` §3.8 and §7.3. In H10 the Placement tab is a
 * single grid — "Showing 0 Placement Rules" · 🔍 · [+ Rule], columns ☐ · Placement Rule ⇅ ·
 * Automation · Criteria · Frequency, empty state "Create a Placement Rule to generate suggestions
 * for a campaign!" — and nothing else. That is what this renders.
 *
 * 🔴 This tab GAINS a rules grid rather than trading one: PLC.0 removed the old
 * `RuleListTab liveType="placement"` and never replaced it, so since then the eight placement rules
 * have had no home on their own tab (they were reachable only via Automations). The grid is back,
 * and it is the shared one.
 *
 * The lane grid, the census cells, the lane split, "the hour", the inspector rail and the bulk
 * panel are PARKED in place (unmounted, PARKED headers, register
 * `docs/2026-08-16-ra-parked-sections.md`). Nothing was deleted and no endpoint retired — including
 * the PLC.3 write path (`PATCH /placements/:id/lane`), which is untouched and still served; this
 * page simply does not write multipliers, which is H10's shape too.
 */
import { useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs } from '../_shared/tabs'
import { RulesGrid } from '../_shared/RulesGrid'
import { getBackendUrl } from '@/lib/backend-url'

interface PlacementStrip {
  windowDays: number; enabledCampaigns: number; measurable: number; gateOpen: number
  governed: number; durable: number; engineWrites7d: number; engineCampaigns7d: number
  engineLastWriteAt: string | null; ruleWrites7d: number; humanWrites30d: number
}

const MARKETS = ['IT', 'DE', 'ES', 'FR']
const n = (v: number) => v.toLocaleString('en-IE')

export function PlacementRulesClient() {
  const router = useRouter()
  const params = useSearchParams()
  const market = params.get('market') || 'all'
  /**
   * PLC-P1 — the strip. Server-censused (never recomposed from the grid's rows) and ABSENT on a
   * failed read rather than fabricated: a zero here would read as "nothing is governed" and "no
   * engine touches these lanes", which are the two claims this line exists to disprove.
   */
  const [strip, setStrip] = useState<PlacementStrip | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/placement-rules/strip`, { cache: 'no-store' })
          .then((r) => (r.ok ? r.json() : null))
        if (alive && j && typeof j.enabledCampaigns === 'number') setStrip(j)
      } catch { /* absent, not fabricated */ }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Placement"
        /* The tab's stored subtitle describes the lane grid that is now parked ("which lane your
           ads show in, what each one is worth"). This page is the rule list, so it says that. */
        subtitle="Rules that change placement modifiers — what each one does, and whether it acts on its own"
        markets={MARKETS}
        market={market}
        onMarketChange={(m) => {
          const next = new URLSearchParams(params.toString())
          if (m && m !== 'all') next.set('market', m); else next.delete('market')
          const q = next.toString()
          router.replace(q ? `?${q}` : '?', { scroll: false })
        }}
        showDataSync={false}
        /* No date control: a rule list carries no windowed metric. The parked lane grid owned the
           date range, and it went with it. */
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="placement" />
      {strip && (
        <p className="h10-hv-cohortline">
          <b>{n(strip.enabledCampaigns)}</b> enabled campaigns · <b>{n(strip.measurable)}</b> with spend in the last {strip.windowDays} settled days, the most a placement rule can reach
          {strip.gateOpen < strip.measurable && <> · <b>{n(strip.gateOpen)}</b> past the write gate</>}
          {/* 🔴 `durable` lives INSIDE this branch on purpose. It is only meaningful as the
              complement of `governed` — on its own it is just `gateOpen` restated, and "17 where a
              rule's write is the last word" with no preceding contrast leaves a reader doing
              arithmetic against a number that is not on screen. */}
          {strip.governed > 0 ? (
            <> · <b>{n(strip.governed)}</b> of those governed by{' '}
              <a
                className="h10-nt-open"
                href="/marketing/ads/rules-automation/dayparting"
                /* The supporting measurement, on the link the clause already invites you to hover.
                   Not a bare ⓘ glyph: the sentence is complete without this, so the tooltip is
                   detail and must not look like a control. */
                title={`Measured from CampaignBidHistory, one row per lane actually moved: ${n(strip.engineWrites7d)} automation writes across ${n(strip.engineCampaigns7d)} campaigns in the last 7 days${strip.engineLastWriteAt ? `, most recently ${new Date(strip.engineLastWriteAt).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })}` : ''}. Humans made ${n(strip.humanWrites30d)} lane edits in 30 days. A placement rule writing to a governed campaign is snapped back on the engine's next pass.`}
              >the rank engine</a>
              , which rewrote these lanes <b>{n(strip.engineWrites7d)}×</b> in 7 days
              {strip.ruleWrites7d === 0 ? <> and no rule did any of it</> : <> — <b>{n(strip.ruleWrites7d)}×</b> of it from a rule</>}
              {strip.durable > 0 && <> · the remaining <b>{n(strip.durable)}</b> are where a rule&rsquo;s write is the last word</>}
            </>
          ) : strip.engineWrites7d > 0 ? (
            <> · none of them governed by{' '}
              <a className="h10-nt-open" href="/marketing/ads/rules-automation/dayparting">the rank engine</a>
              , though it rewrote placement lanes <b>{n(strip.engineWrites7d)}×</b> in 7 days
            </>
          ) : null}
          {' '}· rule output queues on <a className="h10-nt-open" href="/marketing/ads/suggestions">Suggestions</a>
        </p>
      )}
      <RulesGrid
        tabKey="placement"
        noun="Placement Rule"
        builderHref="/marketing/ads/rules-automation/builder/placement"
        emptyLine="Create a Placement Rule to generate suggestions for a campaign!"
      />
    </div>
  )
}
