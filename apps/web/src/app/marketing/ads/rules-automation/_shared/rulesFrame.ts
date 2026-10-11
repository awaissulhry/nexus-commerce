/**
 * Bid page programme, lane SHELL (2026-10-10) — the Rules & Automation frame as pure data: the eleven link tabs and the
 * header's market list. React-free, so every rule is a vitest case (`rulesFrame.vitest.test.ts`); `tabs.tsx` and
 * `RulesHeader.tsx` only draw what these return.
 */
import type { ListboxPanelOption } from '@/design-system/components/ListboxPanel'
import { marketplaceCode } from '@/lib/marketplace-code'
import { ALL_MARKETS, MARKET_NAME } from '../../_shell/adsMarkets'

/** The part of a `RulesTab` the bar reads. */
export interface FrameTab { key: string; label: string }

/** One link tab, in the DS `TabItem` shape (`id`, `label`, `href`, `count`). */
export interface FrameTabItem { id: string; label: string; href: string; count: number | null }

/**
 * The bar's tabs, in the list's order. A count pill only where the counts provider has a number above 0 (polish round 2,
 * audit S12): a tab with nothing to count — no rule in this market, or a tab the provider does not count — shows no
 * pill, the same way on every tab; "0" pills beside blank tabs read as two different answers. A failed or pending read
 * (`counts` null) draws every label without a pill; the navigation never blanks.
 */
export function rulesTabItems<T extends FrameTab>(
  tabs: ReadonlyArray<T>,
  counts: Readonly<Record<string, number>> | null,
  hrefOf: (tab: T) => string,
): FrameTabItem[] {
  return tabs.map((t) => {
    const n = counts && Object.prototype.hasOwnProperty.call(counts, t.key) ? counts[t.key] : undefined
    return { id: t.key, label: t.label, href: hrefOf(t), count: typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : null }
  })
}

/** A rule as the tab counts read it: its actions and its market (`scopeMarketplace`; null = every market). */
export interface CountedRule { actions: unknown; market: string | null }

/**
 * One market code from what a rule or the picker carries — 'it', 'APJ6JRA9NG5V4', 'GB' → 'IT', 'IT', 'UK' — or null for
 * none and for all markets.
 */
export function marketKey(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toUpperCase()
  if (!v || v === ALL_MARKETS.toUpperCase()) return null
  const code = marketplaceCode(v)
  return code === 'GB' ? 'UK' : code
}

/**
 * The tab counts for the market the header shows (audit S12: Bid said 4 while Germany listed 0 rules). A rule counts
 * where it can act — its own market, or every market when it sets none: the evaluator's test, and the rules the Bid
 * page and the rule grids list under that market. All markets (or none picked) counts every rule. `belongs` is the
 * bar's own action-type test (`ruleBelongsToTab`), handed in so this file stays free of the bar.
 */
export function rulesTabCounts(
  rules: ReadonlyArray<CountedRule>,
  tabKeys: ReadonlyArray<string>,
  belongs: (actions: unknown, tabKey: string) => boolean,
  market: string | null | undefined,
): Record<string, number> {
  const want = marketKey(market)
  const here = want ? rules.filter((r) => { const own = marketKey(r.market); return !own || own === want }) : rules
  const out: Record<string, number> = {}
  for (const key of tabKeys) out[key] = here.filter((r) => belongs(r.actions, key)).length
  return out
}

/** The held row's value when no market is connected; it can never be chosen. */
export const NO_MARKET = '__none'

/** What the header knows about one market it may show (`AdsPageHeader`'s `markets` plus the connections list). */
export interface FrameMarket {
  code: string
  /** A short word beside a market you can still pick ("reading only"). */
  note?: string | null
  /** Why that note, in a sentence (hover). */
  whyNot?: string | null
}

/**
 * The market picker's options (DS `Listbox`). Words, no flags: "All markets", then each market by its name with its code
 * at the end ("Italy … IT"), and a note under a market Nexus only reads.
 *
 * · `allowAll` false: no "All markets" (a page that cannot serve it).
 * · `notYet`: the page cannot filter by market yet — only "All markets", with the reason under it.
 * · The market the page is on is always listed, even when the list does not hold it (a deep link): the picker never
 *   reads blank or shows a market that is not the one in use.
 * · No market at all: one held row that says so.
 */
export function rulesMarketOptions(input: {
  markets: ReadonlyArray<FrameMarket>
  value: string
  allowAll: boolean
  notYet?: string | null
}): ListboxPanelOption[] {
  if (input.notYet) return [{ value: ALL_MARKETS, label: 'All markets', note: input.notYet }]
  const out: ListboxPanelOption[] = []
  if (input.allowAll) out.push({ value: ALL_MARKETS, label: 'All markets' })
  const seen = new Set<string>()
  for (const m of input.markets) {
    if (!m.code || seen.has(m.code)) continue
    seen.add(m.code)
    out.push({
      value: m.code,
      label: MARKET_NAME[m.code] ?? m.code,
      trailing: m.code,
      searchText: m.code,
      ...(m.note ? { note: m.note } : {}),
      ...(m.note && m.whyNot ? { title: m.whyNot } : {}),
    })
  }
  const v = input.value
  if (v && v !== ALL_MARKETS && !seen.has(v)) {
    seen.add(v)
    out.push({ value: v, label: MARKET_NAME[v] ?? v, trailing: v, searchText: v })
  }
  if (seen.size === 0) out.push({ value: NO_MARKET, label: 'No connected markets', heldReason: 'No Amazon market is connected yet' })
  return out
}
