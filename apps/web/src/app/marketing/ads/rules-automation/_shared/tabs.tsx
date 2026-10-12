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
import Link from '@/lib/workspaces/Link'
import { usePathname, useSearchParams } from '@/lib/workspaces/navigation'
import { useMemo, type ComponentProps } from 'react'
import { Tabs, activeTabFromPath, type TabLinkComponent } from '@/design-system/components'
import { useAdsMarketplaceOptional } from '../../_shell/MarketplaceContext'
import { ALL_MARKETS, pageMarket } from '../../_shell/adsMarkets'
import { RULE_TYPES } from './ruleTypes'
import { rulesTabCounts, rulesTabItems } from './rulesFrame'
import { carryQuery, carryTabs } from './scopeFilter/scopeFilterModel'
import { useRulesTabRules } from './tabCountsContext'
import styles from './rulesFrame.module.css'

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

/**
 * U10 — **Helium 10's tab order and labels** (operator decision D1, 2026-08-18).
 *
 * The array order IS the bar. H10's order, frame-verified in the recording:
 *   Apply Rules · Bid · Keyword Harvest · Negative Targeting · Budget · Dayparting Schedules ·
 *   Budget Schedules · Placement · Share of Voice · Keyword Tracker
 * `automations` keeps 2nd place (D2): it is not an H10 tab, but it owns every rule record — all the
 * other grids link `?rule=` to it — plus the Queue and the Limits.
 *
 * Two labels moved with the order, and one deliberately did not:
 *   · `budget`           "Budget Rules"              → **"Budget"**           (H10's word)
 *   · `budget-schedules` "Budget Pacing & Schedules" → **"Budget Schedules"** (H10's word)
 *   · `dayparting` kept "Rank & Dayparting Schedules" until 2e (Owner D1 = A, 2026-10-04): no
 *     Amazon signal can feed a 15-minute rank loop, so the schedules now hold a fixed placement %,
 *     bid floor and base bid per hour, and the tab says that — **"Hourly Bids"**. Key and route stay.
 * Both relabelled tabs keep their `key` and route, so no URL, deep link or `RULE_TAB_ACTION_TYPES`
 * entry moved.
 *
 * 🔴 **The four-cluster `group` field is GONE, and had to go.** It rendered a hairline wherever the
 * group changed, which only reads as grouping while the array is sorted BY group. Under H10's order
 * the clusters interleave, which would have painted **eight stray dividers**. H10's own bar has
 * none, so the field and its separator went together rather than leaving a decorative rule behind.
 */
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
  // ── Act ──────────────────────────────────────────────────────────────────────────────────────
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
  // ── Bid & Place ──────────────────────────────────────────────────────────────────────────────
  // BID.S0 — its own page. The tab used to render a bid RULE list and not one bid: 2,944 enabled
  // targets carry a bid and no screen in the product listed them outside a single campaign.
  {
    key: 'bid',
    label: 'Bid',
    routed: true,
    subtitle: 'Rules that change bids — what each one does, and whether it acts on its own',
  },
  // ── Terms ────────────────────────────────────────────────────────────────────────────────────
  // HV.1 — its own page. The tab used to render a rule list that filtered every rule out of
  // itself (see RULE_TAB_ACTION_TYPES below) under a badge that said 5, and nothing else — while
  // the harvest engine acted on 14 candidates nightly with no surface anywhere in the product.
  {
    key: 'keyword-harvest',
    label: 'Keyword Harvest',
    routed: true,
    subtitle: 'Rules that create targets from converting search terms — and the ad groups they map',
  },
  // NEG.1 — its own page. The tab used to render the protections panel above a rule list and
  // nothing else: 2,059 negatives existed and no screen anywhere in the product listed one.
  {
    key: 'negative-targeting',
    label: 'Negative Targeting',
    routed: true,
    subtitle: 'Rules that create negatives — what each one blocks, and whether it acts on its own',
  },
  // ── Spend ────────────────────────────────────────────────────────────────────────────────────
  // BUD.1 — its own page, and relabelled. The tab used to render a rule list whose column edits
  // changed React state only and whose Delete removed a row while the rule survived — showing
  // neither the 2,386 budget changes in 60 days nor the two AUTO rules cutting −15%/−20% of the
  // CURRENT value every 15 minutes with no cooldown and no floor but Amazon's €1. U10 relabelled it
  // "Budget" (see above); the page header now reads the label too (7d), so the two cannot differ.
  {
    key: 'budget',
    label: 'Budget',
    routed: true,
    subtitle: 'Rules that change budgets — what each one does, and whether it acts on its own',
  },
  { key: 'dayparting', label: 'Hourly Bids', routed: true, subtitle: 'A fixed placement % and bid floor for each hour of the week, across many campaigns' },
  // BSP.0 — its own page, and renamed for the question it answers rather than for its object. The
  // `BudgetSchedule` table has never held a row and its executor has ticked 4,909 times over
  // nothing — but budget still binds on 32.7% of campaign-days, so the subject is pacing and level,
  // with the schedule as an instrument below it.
  {
    key: 'budget-schedules',
    label: 'Budget Schedules',
    routed: true,
    subtitle: 'When budgets change through the day, and the schedules that change them',
  },
  // PLC.0 — its own page. The tab used to render a placement RULE list: 8 rules, all disabled,
  // 0 successes ever, last activity 2026-08-03 — while the lever they describe moved 15,366 times
  // in 60 days and no screen listed one campaign's three lanes side by side.
  {
    key: 'placement',
    label: 'Placement',
    routed: true,
    subtitle: 'Rules that change placement modifiers — what each one does, and whether it acts on its own',
  },
  // SOV.0 — its own page. The tab used to render SovTrackerTab kind="sov": a [ Rules | Report ]
  // segment whose Rules half is the DEFAULT view and can never render a row, over a column that
  // divided by 28% of our real impressions.
  {
    key: 'share-of-voice',
    label: 'Share of Voice',
    routed: true,
    subtitle: 'Rules that bid on share of voice — what each one does, and whether it acts on its own',
  },
  // KT.1 — its own page. The tab used to render SovTrackerTab kind="tracker": a [ Rules | Report ]
  // segment over KeywordRank, a table with 0 rows, so all four columns read `#—` on every row.
  {
    key: 'keyword-tracker',
    label: 'Keyword Tracker',
    routed: true,
    subtitle: 'Rules that bid on weekly search volume (Amazon Brand Analytics) — organic and sponsored rank have no Amazon source — what each one does, and whether it acts on its own',
  },
]

export const rulesTabByKey = (key: string): RulesTab | undefined => RULES_TABS.find((t) => t.key === key)

/**
 * Ads fix 7d (review D.6, I.8) — a tab page's header, from this list only: the title is the tab's own label and the
 * subtitle is its `subtitle`. The pages hard-coded both, so "Budget Rules" sat over a tab named "Budget" and the stored
 * subtitles described the parked pages.
 */
export function rulesTabHeader(key: string): { title: string; subtitle: string } {
  const tab = rulesTabByKey(key)
  return { title: tab?.label ?? key, subtitle: tab?.subtitle ?? '' }
}

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
  // C2 — pause_target/enable_target are Bid-tab actions: they are what the Bid builder's THEN
  // writes when the operator chooses Pause/Unpause Target, so the rule must list where it was made.
  bid: ['bid_to_target_acos', 'bid_up', 'bid_down', 'lower_bid_to_floor', 'raise_bids_for_rank_defense', 'bid_apply', 'pause_target', 'enable_target'],
  budget: ['adjust_ad_budget'],
  placement: ['set_placement_multiplier', 'defend_top_of_search'],
  'keyword-harvest': ['promote_to_exact', 'harvest_and_negate'],
  'negative-targeting': ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns'],
  /**
   * U3 — Share of Voice, entered with an EMPTY engine list on purpose.
   *
   * The entry has to exist at all: `ruleBelongsToTab` returns false for any tab that is absent from
   * this map, so before this line the SOV tab's grid and badge were empty **by construction** — a
   * rule created in `/builder/sov` could never appear on the tab it was created from. That is the
   * defect this map's own comment predicted, and the one the old `SovTrackerTab liveType="sov"`
   * shipped for months.
   *
   * The list is empty because no ENGINE action type belongs here: SOV-driven bidding is expressed
   * as `bid_*` actions, which are the Bid tab's, and filing them here too would double-count one
   * rule on two tabs. The derivation below adds the builder slug `sov`, which is the only thing an
   * SOV rule can carry — so this tab counts exactly the rules built as SOV rules, and nothing else.
   */
  'share-of-voice': [],
  /**
   * U4 — Keyword Tracker, empty for the same reason as Share of Voice above: rank-driven bidding
   * is expressed as `bid_*` / `raise_bids_for_rank_defense`, which are the Bid and Placement tabs'.
   * The derivation adds the builder slug `keyword-tracker`, so a rule built here lists here.
   */
  'keyword-tracker': [],
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
 * A tab follows its link without scrolling the page to the top — the bar sits at the top of every page, and a tab
 * changes only what is under it (as the bar did before the design system).
 */
const TabLink: TabLinkComponent = (props) => <Link {...(props as ComponentProps<typeof Link>)} scroll={false} />

/**
 * Bid page programme, lane SHELL (2026-10-10) — the eleven tabs as DS link `Tabs`, shared by every tab page so the bar
 * is the same wherever you are.
 *
 * · Real links (`<nav>` with `aria-current="page"`): open in a new tab, middle-click, back and a copied address work.
 * · The tab you are on comes from the ROUTE (`activeTabFromPath`); `active` is only a fallback for a page whose path
 *   no tab names. A page's own sub-path (`/bid/…`) keeps its tab.
 * · A count where the counts provider has one (the tabs that list rules): from the layout's one read, refreshed when a
 *   rule changes (`tabCounts.tsx`), counted for the market the header shows (polish round 2, S12). Nothing to count
 *   (0, or a tab that is not counted) is no pill, on every tab alike; a failed read keeps every label.
 * · `dense` (polish round 2, M6): the eleven tabs fit at 1440 (13.5px labels, 16px apart). Narrower, the strip
 *   scrolls sideways inside itself, the tab you are on in view, with a fade and an arrow at each edge that has more
 *   (`overflow="scroll"`); the scrollbar stays in a band below the labels.
 * · Keyboard: every tab is a Tab stop; ←/→/Home/End move between them; Enter follows.
 * · The filter bar's picks (2026-10-12): between Bid, Keyword Harvest and Negative Targeting the links carry
 *   `?portfolio=&campaign=&adGroup=&product=` (`carryTabs`); every other link is as it was.
 */
export function RulesTabs({ active }: { active?: string }) {
  const rules = useRulesTabRules()
  const pathname = usePathname()
  const params = useSearchParams()
  const ads = useAdsMarketplaceOptional()
  // The market the header shows, read the way the pages read it (AM-28 `useSharedAdsMarket`): the address's `?market=`
  // wins, else the shared choice. The counts follow it (polish round 2, S12).
  const market = ads ? pageMarket(params?.get('market') ?? null, { read: ads.readMarkets, shared: ads.scopeMarket, allowAll: true }) : ALL_MARKETS
  const counts = useMemo(
    () => (rules ? rulesTabCounts(rules, Object.keys(RULE_TAB_ACTION_TYPES), ruleBelongsToTab, market) : null),
    [rules, market],
  )
  const base = useMemo(() => rulesTabItems(RULES_TABS, counts, rulesTabHref), [counts])
  const current = activeTabFromPath(base, pathname) ?? active ?? ''
  const carry = carryQuery(new URLSearchParams(params?.toString() ?? ''))
  const items = useMemo(() => carryTabs(base, current, carry), [base, current, carry])
  return (
    <div className={styles.tabs}>
      <Tabs size="lg" dense overflow="scroll" ariaLabel="Rules and automation" tabs={items} active={current} linkAs={TabLink} />
    </div>
  )
}
