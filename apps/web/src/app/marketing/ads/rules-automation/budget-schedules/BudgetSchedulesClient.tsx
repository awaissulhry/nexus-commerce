'use client'

/**
 * BSP.0 — Budget Pacing & Schedules. The basis: route, scope spine, URL contract, the pinned pacing
 * band, six section shells and the inspector rail. Seven further sessions fill the sections.
 *
 * ── Why the page is named for the question and not for its object ──────────────────────────────
 *
 * The tab this replaces was called "Budget Schedules" after a table that has **never held a row**,
 * while its executor ticked 4,909 times over nothing. But the reason is not that budget is a weak
 * lever here — measured on production 2026-08-11, **32.7% of campaign-days spend at or over the
 * budget in force**, and only **3.0%** go dark before noon. Budget binds hard; it just does not
 * bind *early*. So the money question on this account is how big the budget is and how fast it is
 * going out — pacing — and the schedule object is an instrument below it, not the headline.
 *
 * Hence the layout: the pinned band answers *"will my money last the month?"* while you read
 * anything else, and it never scrolls away.
 *
 * ── The four bars above the content, and the 120px budget ──────────────────────────────────────
 *
 * `AdsPageHeader` (84.8px) and `RulesTabs` (35.3px) scroll away; the spine and the band stick.
 * Measured baseline on prod at 1280: header top 26 → tab bar bottom 164, i.e. **138px** of chrome,
 * first content card at y=192. The spine + band were budgeted at ≤120px on top of that.
 *
 * ⚠ Sticky here means sticky inside `MAIN.h10-main`, which is the app shell's real scroller — not
 * the window, and not `main.flex-1.overflow-auto`. It carries `padding: 26px 30px`, so `top: 0`
 * pins at y=26. Verified by scrolling on production, not by reading the CSS.
 *
 * ── Market ────────────────────────────────────────────────────────────────────────────────────
 *
 * One market state, from `?market=`, passed into the header — which always renders the picker, and
 * has no `showMarket` prop to turn it off (verified again; the prop does not exist and four sibling
 * sessions have each written that same correction). The band's four chips are the page's sticky
 * market control. See `BudgetScopeBar`'s header for the full reasoning.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
/**
 * 🔴 The design-system stylesheets are imported PER PAGE in this app — there is no global load, and
 * `rules-automation/layout.tsx` brings in `rules-automation.css` only. This page is the first in the
 * Rules & Automation subtree to compose from the DS (`EmptyState`, `ProgressBar`), so it imports
 * them the way `/marketing/ads/reporting` and `/marketing/ads/bulk` already do. Without these three
 * the DS components render completely unstyled — and nothing would fail: not tsc, not the tests,
 * not the DS ratchet, not the build.
 */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import { AdsPageHeader } from '../../_shell/AdsPageHeader'
import { RulesTabs, rulesTabByKey } from '../_shared/tabs'
import { getBackendUrl } from '@/lib/backend-url'
import {
  MARKETS, SECTIONS, needsNormalising, parseUrlState, patchUrlState, serialiseOpen,
  type BspOpen, type BspSection,
} from './urlState'
import { BudgetScopeBar, ScopeNote, resolveScope, type BspScopeValue } from './BudgetScopeBar'
import { PacingBand } from './PacingBand'
import { SectionShell, SectionPending } from './SectionShell'
import { InspectorRail } from './InspectorRail'
import { SchedulesSection } from './SchedulesSection'
import type { BudgetManagerResult, ScopeOptionsPayload } from './slot-contract'

/** The six sections, in order. Every one names the session that fills it. */
const SECTION_DEFS: Array<{
  id: BspSection
  heading: string
  purpose: string
  owner?: string
  pending?: string
}> = [
  {
    id: 'binding',
    heading: 'Binding now',
    purpose: 'Campaigns spending at or over the budget in force',
    owner: 'BSP.2',
    pending: 'Spend against the budget actually in force that day, per campaign, with the ratio and the last hour it delivered. 34 of 63 campaigns hit 90% of their budget at least once in the last 8 days.',
  },
  {
    id: 'hours',
    heading: 'Hour of day',
    purpose: 'What each hour actually returns, and how much of it we can see',
    owner: 'BSP.3',
    pending: 'A 24-cell hour-of-day view coloured by spend, with its coverage stated on the card. Not a 7×24 grid: eight complete days is 1.14 samples per weekday, and 49 attributed orders across 168 cells cannot colour a grid by CVR or ROAS.',
  },
  {
    id: 'schedules',
    heading: 'Schedules',
    purpose: 'Scheduled budget changes, and who enforces each one',
  },
  {
    id: 'events',
    heading: 'Events',
    purpose: 'Named, dated raises that revert themselves',
    owner: 'BSP.5',
    pending: 'Prime Day, Black Friday, a launch — pre-stageable, with a visible revert date. Native where Amazon can do it (Sponsored Products, increases only, and it does reach IT/DE/ES/FR), local where it cannot.',
  },
  {
    id: 'ceilings',
    heading: 'Ceilings & precedence',
    purpose: 'Spend limits per market, portfolio, line and campaign — and who wins',
    owner: 'BSP.6',
    pending: 'Today two live engines oscillate on the same campaign: 937 of 2,304 consecutive budget writes start from a value the previous write did not leave behind. This section is where precedence becomes visible.',
  },
  {
    id: 'log',
    heading: 'Change log',
    purpose: 'Every budget move: who, when, from what, back to what',
    owner: 'BSP.7',
    pending: '2,387 budget writes exist in the audit log and none of them is visible anywhere in the product. 488 are still PENDING at Amazon.',
  },
]

export function BudgetSchedulesClient() {
  const router = useRouter()
  const params = useSearchParams()

  // ── the URL contract ────────────────────────────────────────────────────────────────────────
  // Parsed once, in one module, and never mirrored into `useState`. That is what makes back and
  // forward restore a view exactly: there is no second copy of the state to fall out of step.
  const url = useMemo(() => parseUrlState(params), [params])

  const push = useCallback((patch: Record<string, string>) => {
    const qs = patchUrlState(params, patch)
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  // A hand-typed or stale URL is rewritten once, to the form the page actually used. Without this a
  // shared link and the view it produces disagree, and nothing on screen says which one is lying.
  useEffect(() => {
    if (!needsNormalising(params)) return
    const qs = patchUrlState(params, {})
    router.replace(qs ? `?${qs}` : '?', { scroll: false })
  }, [params, router])

  const scope: BspScopeValue = { portfolio: url.portfolio, campaign: url.campaign, line: url.line }

  // ── data ────────────────────────────────────────────────────────────────────────────────────
  const [options, setOptions] = useState<ScopeOptionsPayload | null>(null)
  useEffect(() => {
    let alive = true
    void fetch(`${getBackendUrl()}/api/advertising/scope-options`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => { if (alive && Array.isArray(d?.campaigns)) setOptions(d as ScopeOptionsPayload) })
      .catch(() => { /* the pickers degrade to empty; nothing else on the page depends on them */ })
    return () => { alive = false }
  }, [])

  const [pacing, setPacing] = useState<BudgetManagerResult | null>(null)
  const [pacingLoading, setPacingLoading] = useState(true)
  const [pacingErr, setPacingErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    // Not scoped by market on purpose: the band shows every market at once and highlights the
    // selected one, so narrowing the fetch would empty three chips whenever a market is picked.
    void fetch(`${getBackendUrl()}/api/advertising/budget-manager`, { cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok) throw new Error(`The pacing request failed (${r.status}).`)
        return r.json()
      })
      .then((d) => { if (alive) { setPacing(d as BudgetManagerResult); setPacingErr(null) } })
      .catch((e) => { if (alive) { setPacingErr((e as Error).message); setPacing(null) } })
      .finally(() => { if (alive) setPacingLoading(false) })
    return () => { alive = false }
  }, [])

  const reach = useMemo(() => resolveScope(options, url.market, scope), [options, url.market, scope.portfolio, scope.campaign, scope.line])

  // ── sections ────────────────────────────────────────────────────────────────────────────────
  // All six expanded by default. `?section=` is a jump target, not persisted accordion state, so
  // collapsing one does not rewrite the URL — an operator who tidies the page has not thereby
  // changed the link they are about to share.
  const [collapsed, setCollapsed] = useState<Set<BspSection>>(new Set())
  const toggle = (id: BspSection) => setCollapsed((s) => {
    const next = new Set(s)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  // `?section=` also forces its section open, so a link cannot land on a collapsed heading.
  useEffect(() => {
    if (url.section) setCollapsed((s) => { const n = new Set(s); n.delete(url.section as BspSection); return n })
  }, [url.section])

  const openRail = useCallback((open: BspOpen) => push({ open: serialiseOpen(open) }), [push])

  const subtitle = rulesTabByKey('budget-schedules')?.subtitle ?? ''

  return (
    <div className="h10-rules-page">
      <AdsPageHeader
        title="Rules & Automation"
        subtitle={subtitle}
        markets={[...MARKETS]}
        market={url.market}
        // Changing market clears the campaign: a campaign belongs to one marketplace, so keeping the
        // selection would hold a scope that resolves to nothing and read as missing data.
        onMarketChange={(m) => push({ market: m, campaign: '' })}
        showLearn={false}
        showDataSync={false}
        showDateRange={false}
        showChangeLog
      />
      <RulesTabs active="budget-schedules" />

      {/* ── the two sticky bars ─────────────────────────────────────────────────────────────── */}
      <div className="h10-bsp-pin">
        <BudgetScopeBar
          options={options}
          market={url.market}
          scope={scope}
          weeks={url.weeks}
          reach={reach}
          onChange={(next) => push({ portfolio: next.portfolio, campaign: next.campaign, line: next.line })}
          onWeeks={(w) => push({ weeks: String(w) })}
        />
        <PacingBand
          data={pacing}
          loading={pacingLoading}
          error={pacingErr}
          market={url.market}
          onMarket={(m) => push({ market: m, campaign: '' })}
          onOpenPlan={(mkt) => mkt && openRail({ kind: 'plan', id: mkt })}
        />
      </div>

      <ScopeNote reach={reach} market={url.market} scope={scope} />

      {/* ── content + rail ──────────────────────────────────────────────────────────────────── */}
      <div className={`h10-bsp-body${url.open ? ' railed' : ''}`}>
        <div className="h10-bsp-cols">
          {SECTION_DEFS.map((s) => (
            <SectionShell
              key={s.id}
              id={s.id}
              heading={s.heading}
              purpose={s.purpose}
              owner={s.owner}
              open={!collapsed.has(s.id)}
              onToggle={() => toggle(s.id)}
              focused={url.section === s.id}
            >
              {s.id === 'schedules'
                ? <SchedulesSection />
                : <SectionPending session={s.owner ?? ''} what={s.pending ?? ''} />}
            </SectionShell>
          ))}
        </div>

        {url.open && (
          <InspectorRail
            open={url.open}
            onClose={() => push({ open: '' })}
            pacing={pacing}
          />
        )}
      </div>
    </div>
  )
}

/** Kept beside the sections it orders, so adding one is a single edit in one file. */
export const BSP_SECTIONS = SECTIONS
