'use client'

/**
 * DPS.3 — the Rules & Automation tab substrate.
 *
 * The 10 tabs used to live as `useState` inside RulesAutomationClient, which meant the section had
 * exactly one URL: refreshing, bookmarking or sharing any tab always dropped you back on "Apply
 * Rules". Every tab is now addressable.
 *
 * Two kinds of destination, so tabs can migrate one at a time instead of in one large change:
 *   · `routed: true`  → its own page at /rules-automation/<key> (own route, own data loading)
 *   · otherwise       → the index page at /rules-automation?tab=<key> (still deep-linkable)
 *
 * Flipping a tab to its own page = build the route, set `routed: true`, drop its branch from the
 * index. Nothing else in the bar changes.
 */
import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { getBackendUrl } from '@/lib/backend-url'
import { RULE_TYPES } from './ruleTypes'

export interface RulesTab {
  key: string
  label: string
  /** true once this tab has its own page under /rules-automation/<key> */
  routed?: boolean
  /**
   * 🔴 AR.S0 (additive) — the path segment, when it differs from `key`.
   *
   * `rulesTabHref` builds `${RULES_BASE}/${key}`, which is right for every tab whose route is named
   * after its key. It is wrong for exactly one: `rules` is routed at `/apply-rules`, and renaming
   * the key is not an option — `?tab=rules`, `RULE_TAB_ACTION_TYPES`, the index client's fallback
   * and every `active="rules"` all read it, and two sessions renaming one key in one shared file is
   * this programme's highest-collision edit.
   *
   * No other tab sets this, so every other href is byte-identical. Take it if your page's route
   * ever needs to differ from its key; do not add a second mechanism.
   */
  path?: string
  /** shown under the page title when this tab is active */
  subtitle?: string
}

export const RULES_BASE = '/marketing/ads/rules-automation'

// Order matches Helium 10 Ads. "Dayparting Schedules" is renamed because 100% of the live rows are
// rank-goal schedules (hold an impression share), not classic bid/pause dayparting — the old label
// described the mode nobody uses.
export const RULES_TABS: RulesTab[] = [
  // AR.S0 — its own page, at /apply-rules. The tab used to render five columns copied from
  // Helium 10, three of which are fiction: `Bid Rule` reads a field no API returns, `Budget Rule`
  // renders a hard-coded "None", and `Min/Max Bid` reads `c.minMaxBid` — a key the payload does not
  // contain — so it printed "None" on all 220 rows while `minBidCents`/`maxBidCents` sat unread in
  // the same response. Every one of the five returned ONE identical value on all 220 rows, and the
  // grid had no Status column at all.
  //
  // ⚠ `key` and `label` are deliberately unchanged. The route is `path`, not the key (see the
  // `path` field above), and the bare `/rules-automation` still renders the index's own grid —
  // whether it eventually redirects here is an open operator decision.
  {
    key: 'rules',
    label: 'Apply Rules',
    routed: true,
    path: 'apply-rules',
    subtitle: 'Which campaigns automation may write to, and what it is allowed to change',
  },
  // RA.AUTO — one page for all 51 automations, with the type filter that replaces the five
  // action-type tabs below. Added rather than swapped: the tabs it supersedes are retired in
  // the session that owns them, once this page is live and verified (plan Part 6).
  {
    key: 'automations',
    label: 'Automations',
    routed: true,
    subtitle: 'Every automation you have, what it can change, and the one control that decides',
  },
  // BID.S0 — its own page. The tab used to render a bid RULE list and not one bid: 2,944 enabled
  // targets carry a bid and no screen in the product listed them outside a single campaign.
  {
    key: 'bid',
    label: 'Bid',
    routed: true,
    subtitle: 'What each target bids, why it is that number, and who decided',
  },
  // HV.1 — its own page. The tab used to render a rule list that filtered every rule out of
  // itself (see RULE_TAB_ACTION_TYPES below) under a badge that said 5, and nothing else — while
  // the harvest engine acted on 14 candidates nightly with no surface anywhere in the product.
  {
    key: 'keyword-harvest',
    label: 'Keyword Harvest',
    routed: true,
    subtitle: 'Which search terms have earned their own keyword',
  },
  // NEG.1 — its own page. The tab used to render the protections panel above a rule list and
  // nothing else: 2,059 negatives existed and no screen anywhere in the product listed one.
  {
    key: 'negative-targeting',
    label: 'Negative Targeting',
    routed: true,
    subtitle: 'What you are blocking, where, and who decided',
  },
  // BUD.1 — its own page, and relabelled. The tab used to render a rule list whose column edits
  // changed React state only and whose Delete removed a row while the rule survived — showing
  // neither the 2,386 budget changes in 60 days nor the two AUTO rules cutting −15%/−20% of the
  // CURRENT value every 15 minutes with no cooldown and no floor but Amazon's €1. "Budget Rules"
  // rather than "Budget", because tab 4 is now "Budget Pacing & Schedules" and the two answer
  // different questions: that one decides how much money exists, this one decides what may spend it.
  {
    key: 'budget',
    label: 'Budget Rules',
    routed: true,
    subtitle: 'What may change a budget, by how much, and what it actually did',
  },
  { key: 'dayparting', label: 'Rank & Dayparting Schedules', routed: true, subtitle: 'Hold a rank, on a schedule, across many campaigns' },
  // BSP.0 — its own page, and renamed for the question it answers rather than for its object. The
  // `BudgetSchedule` table has never held a row and its executor has ticked 4,909 times over
  // nothing — but budget still binds on 32.7% of campaign-days, so the subject is pacing and level,
  // with the schedule as an instrument below it.
  {
    key: 'budget-schedules',
    label: 'Budget Pacing & Schedules',
    routed: true,
    subtitle: 'Where the money goes, how fast, and whether it lasts the month',
  },
  // PLC.0 — its own page. The tab used to render a placement RULE list: 8 rules, all disabled,
  // 0 successes ever, last activity 2026-08-03 — while the lever they describe moved 15,366 times
  // in 60 days and no screen listed one campaign's three lanes side by side.
  {
    key: 'placement',
    label: 'Placement',
    routed: true,
    subtitle: 'Which lane your ads show in, what each one is worth, and who put the multiplier there',
  },
  // SOV.0 — its own page. The tab used to render SovTrackerTab kind="sov": a [ Rules | Report ]
  // segment whose Rules half is the DEFAULT view and can never render a row, over a column that
  // divided by 28% of our real impressions.
  {
    key: 'share-of-voice',
    label: 'Share of Voice',
    routed: true,
    subtitle: 'On the queries that matter, how much of each market do we hold?',
  },
  // KT.1 — its own page. The tab used to render SovTrackerTab kind="tracker": a [ Rules | Report ]
  // segment over KeywordRank, a table with 0 rows, so all four columns read `#—` on every row.
  {
    key: 'keyword-tracker',
    label: 'Keyword Tracker',
    routed: true,
    subtitle: 'On the keywords you chose — are we on the page, and is it moving?',
  },
]

export const rulesTabByKey = (key: string): RulesTab | undefined => RULES_TABS.find((t) => t.key === key)

/**
 * Which ACTION TYPES belong to each tab.
 *
 * These tabs used to filter with `actions[0].type === <tab key>` — comparing an action type
 * against a tab key. Those are different vocabularies and the comparison could never be true,
 * so all five live tabs rendered empty. Measured on prod 2026-08-05: the Negative Targeting
 * tab read "Showing 0 Negative Targeting Rules" while five negation rules existed and three
 * were enabled. Same shape as the KEYWORD/AD_TARGET grain mismatch — two halves of one
 * feature disagreeing about the name of the thing they exchange.
 *
 * Two rules this map has to follow:
 *
 *   · Match ANY action on the rule, not `actions[0]`. Rules routinely pair a change with a
 *     `notify`, and ordering inside the array is incidental — filtering on the first element
 *     hides a bid rule because someone listed the notification first.
 *   · A rule may legitimately appear under more than one tab. `harvest_and_negate` both
 *     promotes a converting term and negates a wasteful one, so it belongs to both; filing it
 *     under one would hide it from an operator looking in the other.
 *
 * Deliberately unmapped: notify, alert_operator, retail_guard, the pause_* family and
 * archive_keyword. They are real actions but none of these five tabs is their home, and
 * inventing a home would misfile them where nobody would think to look. They remain visible
 * on Apply Rules, which lists every rule regardless of type.
 */
const RULE_TAB_ACTION_TYPES_BASE: Record<string, string[]> = {
  bid: ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier', 'defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact', 'harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'],
}

/**
 * 🔴 HV.1 — a tab must also match its own BUILDER SLUG, and the map is derived rather than copied.
 *
 * `RuleBuilder.tsx:499` writes `actions: [{ type: slug }]` where `slug` is the builder's URL
 * segment — `keyword-harvesting`, not the action type `promote_to_exact`. So a rule created in the
 * builder carries an action type that the base map above has never contained, and **the first rule
 * an operator creates is invisible on the tab it was created from.**
 *
 * Zero rules carry a builder slug today, so this is latent rather than a live defect — which is
 * exactly why it would have survived: nothing on screen would have been wrong until the day
 * someone used the builder.
 *
 * `ruleTypes.ts` already holds `{ slug, tab }` for all nine rule types and nothing read it. Merging
 * from there rather than hand-adding a string keeps one source of truth: adding a rule type to the
 * modal now wires its tab automatically.
 *
 * ⚠ Scoped to the tabs that already have an entry. `keyword-tracker`, `share-of-voice`,
 * `dayparting` and `budget-schedules` have no entry in the base map at all — giving them one
 * changes what those tabs count and belongs to the sessions that own them, not to this one.
 */
export const RULE_TAB_ACTION_TYPES: Record<string, string[]> = Object.fromEntries(
  Object.entries(RULE_TAB_ACTION_TYPES_BASE).map(([tab, types]) => [
    tab,
    [...new Set([...types, ...RULE_TYPES.filter((rt) => rt.tab === tab).map((rt) => rt.slug)])],
  ]),
)

/** True when any of the rule's actions belongs to `tabKey`. */
export function ruleBelongsToTab(actions: unknown, tabKey: string): boolean {
  const want = RULE_TAB_ACTION_TYPES[tabKey]
  if (!want) return false
  const list = Array.isArray(actions) ? actions : []
  return list.some((a) => want.includes(String((a as { type?: unknown })?.type ?? '')))
}

/** Where clicking a tab goes. Routed tabs get a real path; the rest ride the index's ?tab= param. */
export function rulesTabHref(tab: RulesTab): string {
  // `tab.path ?? tab.key` — AR.S0. Only `rules` sets `path`, so every other href is unchanged.
  if (tab.routed) return `${RULES_BASE}/${tab.path ?? tab.key}`
  return tab.key === 'rules' ? RULES_BASE : `${RULES_BASE}?tab=${tab.key}`
}

/**
 * The sticky tab bar, shared by the index and every routed tab page so the row is identical
 * wherever you are. Links (not buttons) so middle-click / cmd-click / back all behave.
 */
export function RulesTabs({ active }: { active: string }) {
  // Counts in the tab labels, so the information architecture does the prioritising: you see
  // where the work is before clicking anything. Computed from RULE_TAB_ACTION_TYPES — the same
  // map the lists filter by — so a label can never claim a number its tab won't show.
  //
  // Only the five mapped tabs get a count. The rest genuinely have no number to state here, and
  // a blank is honest where a 0 would read as "nothing to do".
  const [counts, setCounts] = useState<Record<string, number> | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const j = await fetch(`${getBackendUrl()}/api/advertising/automation-rules`, { cache: 'no-store' }).then((r) => r.json())
        const all = (Array.isArray(j?.rules) ? j.rules : Array.isArray(j?.items) ? j.items : Array.isArray(j) ? j : []) as Array<Record<string, unknown>>
        const next: Record<string, number> = {}
        for (const key of Object.keys(RULE_TAB_ACTION_TYPES)) {
          next[key] = all.filter((r) => ruleBelongsToTab(r.actions, key)).length
        }
        if (alive) setCounts(next)
      } catch { /* a failed count must never blank the navigation */ }
    })()
    return () => { alive = false }
  }, [])

  /**
   * 🔴 PLC.0 — at eleven items the bar overflows and the ACTIVE tab can be off-screen.
   *
   * Measured on production 2026-08-12 at innerWidth 1380, standing on /placement:
   * `scrollWidth 1642` against `clientWidth 1254` — **388px of overflow** — with the active
   * "Placement" tab at L=1355 against a bar ending at 1350. So the page you are on is the one tab
   * you cannot see, and `.h10-rules-tabs` hides its scrollbar (`ads.css:2063`), so there is no
   * affordance saying more tabs exist. The last three routed pages are all in that dead zone.
   *
   * This scrolls the container, never `scrollIntoView`: the shell scrolls
   * `main.flex-1.overflow-auto`, and an element-level scroll walks up to it and jumps the whole
   * page on load. Setting `scrollLeft` on this div cannot move anything but this div.
   *
   * Deliberately the minimum. The edge fade, the four clusters and keyboard scrolling are the
   * substrate's S6 and are a design change to a bar eleven pages share; making the active tab
   * visible is a correctness fix, and it fixes it for all eleven at once.
   */
  const barRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let cancelled = false
    const bring = () => {
      const bar = barRef.current
      if (cancelled || !bar) return
      const el = bar.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!el || bar.scrollWidth <= bar.clientWidth) return
      // 🔴 Rects, not `offsetLeft`. `.h10-rules-tabs` is not positioned, so the active tab's
      // offsetParent is an ancestor further up and `offsetLeft` is measured from THAT — the first
      // version scrolled 78px where 388 were needed and left the tab clipped. A rect delta is
      // relative to nothing and cannot be wrong.
      const barRect = bar.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const overRight = elRect.right - barRect.right
      const overLeft = barRect.left - elRect.left
      if (overRight > 0) bar.scrollLeft += overRight + 24
      else if (overLeft > 0) bar.scrollLeft -= overLeft + 24
    }
    bring()
    /**
     * 🔴 …and measuring ONCE on mount is not enough, which is the second thing prod taught this.
     *
     * The second version computed the right number and still left `scrollLeft` at 0. The bundle was
     * current and the math checked out when run by hand — the effect was simply measuring a
     * narrower bar than the one that ends up on screen. `counts` arrives from a fetch and adds five
     * badges worth ~200px; at mount, without them, "Placement" ends at ~1257 inside a bar ending at
     * 1350 and genuinely fits, so `bring()` correctly does nothing. The badges then land and push
     * it to 1457.
     *
     * So it re-runs when the counts land (the dependency) and when the font swaps — the other thing
     * that silently widens a row of text after it was measured. Deliberately not `requestAnimation-
     * Frame`: rAF does not fire in a background tab, and a tab restored from the background is
     * exactly when a bar has been laid out without ever being painted.
     */
    const fonts = (document as Document & { fonts?: { ready?: Promise<unknown> } }).fonts
    if (fonts?.ready) void fonts.ready.then(bring)
    return () => { cancelled = true }
  }, [active, counts])

  return (
    <div ref={barRef} className="h10-cd-tabs h10-rules-tabs" role="tablist" aria-label="Rule types">
      {RULES_TABS.map((t) => {
        const n = counts?.[t.key]
        return (
          <Link
            key={t.key}
            href={rulesTabHref(t)}
            role="tab"
            aria-selected={t.key === active}
            className={`h10-cd-tab ${t.key === active ? 'on' : ''}`}
            scroll={false}
          >
            {t.label}
            {n != null && <span className="h10-cd-tabn">{n}</span>}
          </Link>
        )
      })}
    </div>
  )
}
