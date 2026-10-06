/**
 * 4i (review 4.8, 4.10) — what a rule's campaign picker may offer, and the picks a rule can never act on.
 *
 * The tick matches a rule's market AND its picks (`ruleMatchesScope`), and placement adjustments exist on Sponsored
 * Products only. Since 4c the server refuses to save a DE rule that holds an IT pick, or a Placement rule that holds a
 * Sponsored Brands one (`ruleScopeProblems`). So the picker offers only what the rule can act on, and a draft that still
 * holds such picks (a rule saved before 4c, or a market changed after picking) says so and drops them in one click.
 *
 * Pure: `CampaignSection` and `RuleBuilder` render it; the tests read it without a DOM.
 */
import { ALL_MARKETS } from './adsScope'
import { MARKET_NAME } from '../../_shell/MarketSelect'

/** The fields a pick is judged on — `SchedCampaign`'s own (`adProduct` is 'SP' | 'SB' | 'SD'). */
export interface PickFacts { id: string; marketplace: string | null; adProduct: string }

export interface PickScope {
  /** The rule's one market; null or 'all' = every market. */
  marketplace?: string | null
  /** The ad types the rule can act on; absent or empty = every type. A Placement rule passes ['SP']. */
  adProducts?: readonly string[]
}

const AD_PRODUCT_NAME: Record<string, string> = { SP: 'Sponsored Products', SB: 'Sponsored Brands', SD: 'Sponsored Display' }
const productName = (p: string) => AD_PRODUCT_NAME[p] ?? p
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many)
/** "30 in IT, 25 in FR" — most first, as the server's own sentence counts them. */
const tally = (labels: string[]) => {
  const counts = new Map<string, number>()
  for (const l of labels) counts.set(l, (counts.get(l) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([l, n]) => `${n} ${l}`).join(', ')
}

/**
 * The builder's market list: All markets plus the markets where a rule can act — Ads wave 4c: the provider's
 * `writeMarkets` (from the connections and the write gate's checks), no longer a fixed four. A rule in a market Nexus
 * only reads is refused at save ("a rule there can never run"), so it is not offered. A stored market outside the list
 * stays on screen, named for what it is (reading only, or not connected), so the field never reads blank over a value
 * the rule really holds.
 */
export function ruleMarketOptions(
  stored: string | null | undefined,
  writable: readonly string[],
  read: readonly string[] = [],
): Array<{ value: string; label: string }> {
  const out = [{ value: ALL_MARKETS, label: 'All markets' }, ...writable.map((m) => ({ value: m, label: `${MARKET_NAME[m] ?? m} (${m})` }))]
  if (stored && !out.some((o) => o.value === stored)) {
    out.push({ value: stored, label: `${MARKET_NAME[stored] ?? stored} (${stored}) — ${read.includes(stored) ? 'reading only' : 'not connected'}` })
  }
  return out
}

/** The rule's one market, or null for every market. */
export const pickMarket = (scope: PickScope): string | null =>
  (scope.marketplace && scope.marketplace !== ALL_MARKETS ? scope.marketplace : null)

/** True when the picker may offer this campaign to the rule. */
export function campaignInScope(c: Pick<PickFacts, 'marketplace' | 'adProduct'>, scope: PickScope): boolean {
  const market = pickMarket(scope)
  if (market && c.marketplace !== market) return false
  if (scope.adProducts?.length && !scope.adProducts.includes(c.adProduct)) return false
  return true
}

/** What the picker says about its own list — "DE only", "Sponsored Products only". Empty when it shows everything. */
export function pickScopeTags(scope: PickScope): string[] {
  const market = pickMarket(scope)
  return [
    ...(market ? [`${market} only`] : []),
    ...(scope.adProducts?.length ? [`${scope.adProducts.map(productName).join(' or ')} only`] : []),
  ]
}

export interface PicksOutside {
  /** Every pick the rule can never act on, in pick order — what the Remove button drops. */
  ids: string[]
  /** How many picks the draft holds. */
  total: number
  outsideMarket: PickFacts[]
  wrongType: PickFacts[]
}

/**
 * The picks this rule can never act on. Each is judged on the LIVE campaign when the picker's list has it — the server
 * reads the Campaign row, not the copy stored with the pick — and on the stored copy otherwise.
 */
export function picksOutsideScope(selected: readonly PickFacts[], live: ReadonlyMap<string, PickFacts>, scope: PickScope): PicksOutside {
  const market = pickMarket(scope)
  const out: PicksOutside = { ids: [], total: selected.length, outsideMarket: [], wrongType: [] }
  for (const pick of selected) {
    const c = live.get(pick.id) ?? pick
    const offMarket = !!market && c.marketplace !== market
    const offType = !!scope.adProducts?.length && !scope.adProducts.includes(c.adProduct)
    if (offMarket) out.outsideMarket.push(c)
    if (offType) out.wrongType.push(c)
    if (offMarket || offType) out.ids.push(pick.id)
  }
  return out
}

export interface PicksNotice { title: string; sentence: string; button: string }

/** The warning and its one button, in plain words — or null when every pick is one the rule can act on. */
export function picksOutsideNotice(o: PicksOutside, scope: PickScope): PicksNotice | null {
  const n = o.ids.length
  if (n === 0) return null
  const market = pickMarket(scope)
  const allowed = (scope.adProducts ?? []).map(productName).join(' or ')
  const parts: string[] = []
  if (o.outsideMarket.length) {
    const k = o.outsideMarket.length
    const where = tally(o.outsideMarket.map((c) => (c.marketplace ? `in ${c.marketplace}` : 'with no market')))
    parts.push(`It runs in ${market} only, and ${k} ${plural(k, 'pick is', 'picks are')} elsewhere (${where}).`)
  }
  if (o.wrongType.length) {
    const k = o.wrongType.length
    parts.push(`It can change ${allowed} campaigns only, and ${k} ${plural(k, 'pick is', 'picks are')} not (${tally(o.wrongType.map((c) => productName(c.adProduct)))}).`)
  }
  parts.push('Nexus will not save the rule until they are removed.')
  const picks = `${n} ${plural(n, 'pick', 'picks')}`
  const button = o.outsideMarket.length && o.wrongType.length ? `Remove ${picks} it can never change`
    : o.outsideMarket.length ? `Remove ${picks} outside ${market}`
    : `Remove ${picks} that ${plural(n, 'is', 'are')} not ${allowed}`
  return {
    title: `This rule can never change ${n} of its ${o.total} picked ${plural(o.total, 'campaign', 'campaigns')}`,
    sentence: parts.join(' '),
    button,
  }
}
