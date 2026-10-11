/**
 * Keyword Harvest page, Sources view (2026-10-11, lane HRULES) — the words and rules of the sources table, pure and tested
 * in Node. A source is an ad group of the market that feeds search terms to harvest (automatic, broad, phrase, product
 * targets): GET /api/advertising/harvest/sources. Replaces the old Ad Group View (market-filtered, working tick boxes,
 * real links).
 *
 * The four bulk actions, each reviewed (one table Now → New, a counted button) and ended in Done with Undo:
 *   Assign rule   a builder harvest rule starts reading these ad groups (its first mapping, `look`) — Undo detaches them;
 *   Detach rule   the rule stops reading them — Undo assigns them again;
 *   Turn off      "Harvest from here: Off" — no harvest (the page, Claude, a rule or the brain) takes a term from them;
 *   Turn on       harvesting from them again — each one's Undo is the other.
 * A rule that reaches its sources by its SCOPE (harvest_and_negate, promote_to_exact: market, portfolio, campaign or
 * product) is not assigned or detached here: its scope is edited in the rule (the server refuses it, named) — the review
 * says so before Save.
 */
import type { ReviewChange } from '@/design-system/patterns'
import { periodWord } from '../../bid/_shared/format'
import type { HarvestSourceRow, Ref } from '../_shared/types'
import type { ViewTile } from '../rules/harvestRulesModel'

export type { ViewTile }

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const ROLE_WORD: Readonly<Record<NonNullable<HarvestSourceRow['role']>, string>> = { AUTO: 'Auto', BROAD: 'Broad', PHRASE: 'Phrase', PRODUCT: 'Product' }
export const roleWord = (r: HarvestSourceRow['role']): string => (r ? ROLE_WORD[r] ?? r : '—')

/** The window of the source counts: the API's one window (`windowDays`, HCORE S9), 60 days until a read says otherwise. */
export const SOURCES_WINDOW_DAYS = 60
export const windowWord = (days: number | null | undefined): string => periodWord(typeof days === 'number' && days > 0 ? days : SOURCES_WINDOW_DAYS)

/** "Harvest from here": On, or Off (who turned it off and when on hover). */
export const harvestingWord = (r: Pick<HarvestSourceRow, 'paused'>): 'On' | 'Off' => (r.paused ? 'Off' : 'On')

// ── tiles, search ───────────────────────────────────────────────────────────────────────────────────────────────────

export const SOURCES_SHOWS = ['rule', 'norule', 'converting', 'paused'] as const
export type HarvestSourcesShow = (typeof SOURCES_SHOWS)[number]
export const isSourcesShow = (v: unknown): v is HarvestSourcesShow => typeof v === 'string' && (SOURCES_SHOWS as readonly string[]).includes(v)

export function rowMatchesShow(r: HarvestSourceRow, show: HarvestSourcesShow | null): boolean {
  if (!show) return true
  if (show === 'rule') return r.rules.length > 0
  if (show === 'norule') return r.rules.length === 0
  if (show === 'converting') return r.sellingTerms > 0
  return !!r.paused
}

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/** Every word in its ad group, campaign, portfolio, product, rules or role. */
export function rowMatchesSearch(r: HarvestSourceRow, search: string): boolean {
  const words = norm(search).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm([r.adGroup.name, r.campaign.name, r.portfolio?.name ?? '', r.product?.name ?? '', roleWord(r.role), ...r.rules.map((x) => x.name)].join(' '))
  return words.every((w) => hay.includes(w))
}

export const visibleSources = (rows: readonly HarvestSourceRow[], show: HarvestSourcesShow | null, search: string): HarvestSourceRow[] =>
  rows.filter((r) => rowMatchesShow(r, show) && rowMatchesSearch(r, search))

/** What the Sources view reports to the page (`onTotals`) after each read. */
export interface HarvestSourcesViewTotals {
  sources: number
  withRule: number
  noRule: number
  converting: number
  paused: number
  tiles: Array<ViewTile<HarvestSourcesShow>>
}

export const SOURCES_TILE_LABEL: Readonly<Record<HarvestSourcesShow, string>> = {
  rule: 'With a rule',
  norule: 'No rule',
  converting: `Selling groups · ${windowWord(SOURCES_WINDOW_DAYS)}`,
  paused: 'Harvest off',
}

/** The numbers over the rows as read, with the filter's own predicates (a tile and its rows never disagree). */
export function sourcesViewTotals(rows: readonly HarvestSourceRow[], windowDays: number = SOURCES_WINDOW_DAYS): HarvestSourcesViewTotals {
  const count = (s: HarvestSourcesShow) => rows.filter((r) => rowMatchesShow(r, s)).length
  const withRule = count('rule'), noRule = count('norule'), converting = count('converting'), paused = count('paused')
  return {
    sources: rows.length, withRule, noRule, converting, paused,
    tiles: [
      { id: 'rule', label: SOURCES_TILE_LABEL.rule, value: withRule, tone: 'success', filters: withRule > 0 },
      { id: 'norule', label: SOURCES_TILE_LABEL.norule, value: noRule, tone: 'warning', filters: noRule > 0 },
      { id: 'converting', label: `Selling groups · ${windowWord(windowDays)}`, value: converting, tone: 'primary', filters: converting > 0 },
      { id: 'paused', label: SOURCES_TILE_LABEL.paused, value: paused, tone: 'danger', filters: paused > 0 },
    ],
  }
}

// ── rules: which can be assigned here ───────────────────────────────────────────────────────────────────────────────

/** How a harvest rule reaches its sources: its mapping (a builder rule: assign / detach here) or its scope (edit the rule). */
export type RuleReach = 'mapping' | 'scope'

const HARVEST_TYPES = new Set(['keyword-harvesting', 'harvest_and_negate', 'promote_to_exact'])

/** A stored rule's reach from its actions; null when it is not a harvest rule. */
export function ruleReachOf(actions: unknown): RuleReach | null {
  const list = Array.isArray(actions) ? (actions as Array<{ type?: unknown }>) : []
  if (!list.some((a) => HARVEST_TYPES.has(String(a?.type ?? '')))) return null
  return list[0]?.type === 'keyword-harvesting' ? 'mapping' : 'scope'
}

export const SCOPE_REFUSAL = 'It reaches its sources by its scope (market, portfolio, campaign or product): change its scope in the rule'

/** A harvest rule; `offered`: it may be assigned here (this market, or every market). */
export interface PickRule { id: string; name: string; reach: RuleReach | null; offered: boolean }

/** The rules the Assign list offers: the market's harvest rules (the brain is not a rule); a scope rule is held, with why. */
export function assignOptions(rules: readonly PickRule[]): Array<{ value: string; label: string; heldReason?: string; note?: string }> {
  return rules.filter((r) => r.offered).map((r) => (r.reach === 'mapping'
    ? { value: r.id, label: r.name }
    : { value: r.id, label: r.name, heldReason: r.reach === 'scope' ? SCOPE_REFUSAL : 'Not a harvest rule this page can read', note: 'By its scope' }))
}

export const EVERY_RULE = '*'

/** The rules the Detach list offers: those on the ticked sources (and "Every rule"); a scope rule is held, with why. */
export function detachOptions(rows: readonly HarvestSourceRow[], reach: ReadonlyMap<string, RuleReach | null>): Array<{ value: string; label: string; heldReason?: string; note?: string }> {
  const seen = new Map<string, Ref>()
  for (const r of rows) for (const x of r.rules) if (!seen.has(x.id)) seen.set(x.id, x)
  const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
  const mapping = list.filter((x) => reach.get(x.id) === 'mapping')
  return [
    ...(mapping.length > 1 ? [{ value: EVERY_RULE, label: 'Every rule here' }] : []),
    ...list.map((x) => (reach.get(x.id) === 'mapping' ? { value: x.id, label: x.name } : { value: x.id, label: x.name, heldReason: SCOPE_REFUSAL, note: 'By its scope' })),
  ]
}

// ── the reviews ─────────────────────────────────────────────────────────────────────────────────────────────────────

const where = (r: HarvestSourceRow) => `${r.adGroup.name} · ${r.campaign.name}`
const names = (refs: readonly Ref[]) => (refs.length ? refs.map((x) => x.name).join(', ') : '—')

/** Assign: one line per source that does not have the rule yet. */
export function assignChanges(rows: readonly HarvestSourceRow[], rule: Ref): ReviewChange[] {
  return rows.filter((r) => !r.rules.some((x) => x.id === rule.id)).map((r) => ({
    id: r.id, where: where(r), what: 'Rules', now: names(r.rules), next: names([...r.rules, rule]),
  }))
}

/** The detach requests: per rule, the sources it reads among these (scope rules left out: they cannot be detached). */
export function detachPlan(rows: readonly HarvestSourceRow[], ruleId: string, reach: ReadonlyMap<string, RuleReach | null>): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const r of rows) for (const x of r.rules) {
    if ((ruleId !== EVERY_RULE && x.id !== ruleId) || reach.get(x.id) !== 'mapping') continue
    out.set(x.id, [...(out.get(x.id) ?? []), r.id])
  }
  return out
}

/** Detach: one line per source that loses a rule; what stays is shown in New. */
export function detachChanges(rows: readonly HarvestSourceRow[], ruleId: string, reach: ReadonlyMap<string, RuleReach | null>): ReviewChange[] {
  return rows.flatMap((r) => {
    const gone = r.rules.filter((x) => (ruleId === EVERY_RULE || x.id === ruleId) && reach.get(x.id) === 'mapping')
    if (!gone.length) return []
    const stays = r.rules.filter((x) => !gone.includes(x))
    return [{ id: r.id, where: where(r), what: 'Rules', now: names(r.rules), next: names(stays) }]
  })
}

/** Turn off (or on): one line per source whose "Harvest from here" changes. */
export function pauseChanges(rows: readonly HarvestSourceRow[], pause: boolean): ReviewChange[] {
  return rows.filter((r) => !!r.paused !== pause).map((r) => ({
    id: r.id, where: where(r), what: 'Harvest from here', now: pause ? 'On' : 'Off', next: pause ? 'Off' : 'On',
  }))
}

/** Why a bulk action cannot run for these ticked sources, or null. */
export function pauseHeld(rows: readonly HarvestSourceRow[], pause: boolean): string | null {
  if (!rows.length) return 'Tick at least one ad group'
  return rows.some((r) => !!r.paused !== pause) ? null : pause ? 'Already off' : 'None of these is off'
}
