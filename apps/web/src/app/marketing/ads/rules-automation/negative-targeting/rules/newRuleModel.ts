/**
 * Negative Targeting page, Rules view (2026-10-11) — a stop-waste rule as the page makes and edits it: the two starters
 * (GET /api/advertising/waste/rules/starters, the PLAN §2 defaults), the place it acts (market › portfolio › campaign ›
 * ONE ad group), its few fields, the body the API takes (POST /waste/rules, PATCH /waste/rules/:id, POST
 * /waste/rules/preview) and the review lines. Pure, tested in Node.
 *
 * The bounds are the API's own (`waste-rules/pure.ts` bodyProblems): a window of 14–90 days, 1–10 000 clicks, 0.5–10 ×
 * the target cost per order, a fixed bar in the market's money, a daily run time in Rome. A new rule is born at Watch
 * (the API); the page then sets Ask me when the person picked it. Auto is earned: the API holds it until the rule has run.
 */
import type { EntityRef, ListboxPanelOption } from '@/design-system/components'
import type { ReviewChange } from '@/design-system/patterns'
import { MODE_WORD, type BidMode } from '../../bid/rules/bidRulesModel'
import { marketStep, plural, type WasteKind } from './wasteRulesModel'

// ── the API's shapes ────────────────────────────────────────────────────────────────────────────────────────────────

export type NegateMatch = 'EXACT' | 'PHRASE'
export type NegateLevel = 'AD_GROUP' | 'CAMPAIGN'

export interface Starter {
  id: string
  kind: WasteKind
  name: string
  windowDays: number
  minClicks: number
  cpaMultiple: number
  /** Money: absent without the ad-spend permission. */
  spendFloorCents?: number
  match?: NegateMatch
  level?: NegateLevel
  says: string
}

export interface WasteScope {
  marketplace?: string | null
  portfolioId?: string | null
  campaignId?: string | null
  adGroupId?: string | null
  productId?: string | null
  wholeAccount?: boolean
}

export interface WasteRuleBody {
  kind: WasteKind
  name?: string
  scope?: WasteScope
  windowDays?: number
  minClicks?: number
  cpaMultiple?: number
  spendFloorCents?: number
  match?: NegateMatch
  level?: NegateLevel
  runAt?: string
}

// ── the fields ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RuleFields {
  name: string
  windowDays: number
  minClicks: number
  cpaMultiple: number
  /** The fixed bar in cents (used when a product has no target cost per order); null when the money is hidden. */
  spendFloorCents: number | null
  match: NegateMatch
  level: NegateLevel
  /** "HH:MM", Rome. */
  runAt: string
}

export const BOUNDS = {
  windowDays: { min: 14, max: 90 },
  minClicks: { min: 1, max: 10_000 },
  cpaMultiple: { min: 0.5, max: 10 },
  spendFloorCents: { min: 1, max: 10_000_000 },
} as const

export const DEFAULT_RUN_AT = '06:00'
const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

export function fieldsOfStarter(s: Starter): RuleFields {
  return {
    name: s.name, windowDays: s.windowDays, minClicks: s.minClicks, cpaMultiple: s.cpaMultiple,
    spendFloorCents: typeof s.spendFloorCents === 'number' ? s.spendFloorCents : null,
    match: s.match ?? 'EXACT', level: s.level ?? 'AD_GROUP', runAt: DEFAULT_RUN_AT,
  }
}

/** A saved stop-waste rule's fields: its test (the rules list) and, from the stored rule, its verb and its run time. */
export function fieldsOfSaved(
  row: { name: string; test: { windowDays: number; minClicks: number; cpaMultiple: number; spendFloorCents?: number } },
  actions: unknown,
): RuleFields {
  const a0 = (Array.isArray(actions) ? actions[0] : null) as { type?: unknown; scope?: unknown; schedule?: { time?: unknown } } | null
  const time = typeof a0?.schedule?.time === 'string' && HHMM.test(a0.schedule.time) ? a0.schedule.time : DEFAULT_RUN_AT
  return {
    name: row.name, windowDays: row.test.windowDays, minClicks: row.test.minClicks, cpaMultiple: row.test.cpaMultiple,
    spendFloorCents: typeof row.test.spendFloorCents === 'number' ? row.test.spendFloorCents : null,
    match: a0?.type === 'add_negative_phrase' ? 'PHRASE' : 'EXACT',
    level: a0?.scope === 'CAMPAIGN' ? 'CAMPAIGN' : 'AD_GROUP',
    runAt: time,
  }
}

/** What is wrong with the fields, per field, in a few words; empty when they can be saved. */
export function fieldProblems(f: RuleFields): Partial<Record<keyof RuleFields, string>> {
  const out: Partial<Record<keyof RuleFields, string>> = {}
  const within = (v: number, b: { min: number; max: number }) => Number.isFinite(v) && v >= b.min && v <= b.max
  if (!f.name.trim()) out.name = 'Give it a name'
  else if (f.name.trim().length > 120) out.name = 'At most 120 characters'
  if (!within(f.windowDays, BOUNDS.windowDays) || !Number.isInteger(f.windowDays)) out.windowDays = `${BOUNDS.windowDays.min}–${BOUNDS.windowDays.max} days`
  if (!within(f.minClicks, BOUNDS.minClicks) || !Number.isInteger(f.minClicks)) out.minClicks = `${BOUNDS.minClicks.min}–${BOUNDS.minClicks.max.toLocaleString('en-GB')}`
  if (!within(f.cpaMultiple, BOUNDS.cpaMultiple)) out.cpaMultiple = `${BOUNDS.cpaMultiple.min}–${BOUNDS.cpaMultiple.max} ×`
  if (f.spendFloorCents != null && (!within(f.spendFloorCents, BOUNDS.spendFloorCents) || !Number.isInteger(f.spendFloorCents))) out.spendFloorCents = 'More than 0'
  if (!HHMM.test(f.runAt)) out.runAt = 'A time, HH:MM'
  return out
}

/** The body the API takes for these fields (money only when it was shown). Match and level only for a search-term rule. */
export function bodyOf(kind: WasteKind, f: RuleFields, scope: WasteScope | null): WasteRuleBody {
  return {
    kind,
    name: f.name.trim(),
    ...(scope ? { scope } : {}),
    windowDays: f.windowDays,
    minClicks: f.minClicks,
    cpaMultiple: f.cpaMultiple,
    ...(f.spendFloorCents != null ? { spendFloorCents: f.spendFloorCents } : {}),
    ...(kind === 'NEGATE_TERM' ? { match: f.match, level: f.level } : {}),
    runAt: f.runAt,
  }
}

/** The fields that changed, as a PATCH body (only those) — an empty object when nothing changed. */
export function fieldsPatch(kind: WasteKind, before: RuleFields, after: RuleFields): Partial<WasteRuleBody> {
  const out: Partial<WasteRuleBody> = {}
  if (after.name.trim() !== before.name.trim()) out.name = after.name.trim()
  if (after.windowDays !== before.windowDays) out.windowDays = after.windowDays
  if (after.minClicks !== before.minClicks) out.minClicks = after.minClicks
  if (after.cpaMultiple !== before.cpaMultiple) out.cpaMultiple = after.cpaMultiple
  if (after.spendFloorCents != null && after.spendFloorCents !== before.spendFloorCents) out.spendFloorCents = after.spendFloorCents
  if (kind === 'NEGATE_TERM' && after.match !== before.match) out.match = after.match
  if (kind === 'NEGATE_TERM' && after.level !== before.level) out.level = after.level
  if (after.runAt !== before.runAt) out.runAt = after.runAt
  return out
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const MATCH_WORD: Readonly<Record<NegateMatch, string>> = { EXACT: 'Exact', PHRASE: 'Phrase' }
export const LEVEL_WORD: Readonly<Record<NegateLevel, string>> = { AD_GROUP: 'Ad group', CAMPAIGN: 'Campaign' }

/** What the rule does, in a few words: "Pause · keep paused", "Negative exact · ad group". */
export function verbWords(kind: WasteKind, f: Pick<RuleFields, 'match' | 'level'>): string {
  if (kind === 'PAUSE_KEYWORD') return 'Pause · keep paused'
  return `Negative ${f.match === 'PHRASE' ? 'phrase' : 'exact'} · ${f.level === 'CAMPAIGN' ? 'campaign' : 'ad group'}`
}

const multiple = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)}×`

/** The test in chips' words: "60 d", "≥ 20 clicks", "≥ 2× CPA", "0 orders". */
export function testWords(f: Pick<RuleFields, 'windowDays' | 'minClicks' | 'cpaMultiple'>): string[] {
  return ['0 orders', `≥ ${f.minClicks} clicks`, `≥ ${multiple(f.cpaMultiple)} CPA`, `${f.windowDays} d`]
}

/** One review line per changed field of a saved rule (Now → New). */
export function fieldsReviewChanges(kind: WasteKind, before: RuleFields, after: RuleFields, money: (cents: number | null) => string, where: string): ReviewChange[] {
  const out: ReviewChange[] = []
  const add = (id: string, what: string, now: string, next: string) => out.push({ id, where, what, now, next })
  if (after.name.trim() !== before.name.trim()) add('name', 'Name', before.name, after.name.trim())
  if (after.windowDays !== before.windowDays) add('windowDays', 'Window', `${before.windowDays} d`, `${after.windowDays} d`)
  if (after.minClicks !== before.minClicks) add('minClicks', 'Clicks at least', String(before.minClicks), String(after.minClicks))
  if (after.cpaMultiple !== before.cpaMultiple) add('cpaMultiple', 'Spend at least', `${multiple(before.cpaMultiple)} CPA`, `${multiple(after.cpaMultiple)} CPA`)
  if (after.spendFloorCents != null && after.spendFloorCents !== before.spendFloorCents) add('spendFloorCents', 'Fixed bar', money(before.spendFloorCents), money(after.spendFloorCents))
  if (kind === 'NEGATE_TERM' && (after.match !== before.match || after.level !== before.level)) add('verb', 'Does', verbWords(kind, before), verbWords(kind, after))
  if (after.runAt !== before.runAt) add('runAt', 'Runs daily', before.runAt, after.runAt)
  return out
}

/** The new rule's one review line: where it acts, what it does, born at Watch → the mode picked. */
export function newRuleReviewChange(p: { kind: WasteKind; fields: RuleFields; where: string; mode: BidMode; wouldChange: number | null }): ReviewChange {
  const raise = p.mode === 'ASK' || p.mode === 'AUTO'
  const now = p.wouldChange == null ? null : p.wouldChange === 0 ? 'Nothing would change now' : `${plural(p.wouldChange, p.kind === 'PAUSE_KEYWORD' ? 'keyword' : 'search term')} now`
  return {
    id: 'new', where: p.where, what: `${p.fields.name.trim()} · ${verbWords(p.kind, p.fields)}`,
    now: '—', next: MODE_WORD[p.mode], raise,
    ...(now ? { note: now } : {}),
  }
}

/** The tick's words for a new rule that asks or acts (Watch only records). */
export const newRuleAck = (kind: WasteKind): string => (kind === 'PAUSE_KEYWORD'
  ? 'I understand: from its first run this rule can pause keywords'
  : 'I understand: from its first run this rule can add negatives')

/** Watch · Ask me · Auto for a new rule: Auto is earned after it has run (the API holds it; the rule's Mode shows the date). */
export const NEW_RULE_AUTO_HELD = 'A new rule earns Auto after it has run for a while: its Mode shows the date'
export const NEW_RULE_MODES: readonly BidMode[] = ['WATCH', 'ASK', 'AUTO']

// ── where it acts: market › portfolio › campaign › ONE ad group ─────────────────────────────────────────────────────

/** GET /advertising/scope-options (the fields read) and GET /advertising/ad-groups?marketplace=. */
export interface ScopeCampaign { id: string; name: string; marketplace: string | null; portfolioId: string | null; status: string }
export interface ScopePortfolio { externalPortfolioId: string; name: string }
export interface ScopeAdGroup { id: string; name: string; status: string; campaignId: string; campaignName: string | null; campaignStatus: string | null; marketplace: string | null; portfolioId: string | null }
export interface ScopeData { campaigns: ScopeCampaign[]; portfolios: ScopePortfolio[]; adGroups: ScopeAdGroup[] }

export const WHOLE_MARKET = 'm'

const archived = (s: string | null | undefined) => (s ?? '').toUpperCase() === 'ARCHIVED'
const paused = (s: string | null | undefined) => (s ?? '').toUpperCase() === 'PAUSED'

/** The markets campaigns run in, sorted. */
export function marketsOf(d: Pick<ScopeData, 'campaigns'>): string[] {
  return [...new Set(d.campaigns.filter((c) => c.marketplace && !archived(c.status)).map((c) => c.marketplace as string))].sort()
}

/**
 * The places a rule may act on in one market, one grouped list: the whole market, its portfolios, its campaigns, its
 * ad groups (an ad group says its campaign under it). Archived campaigns and ad groups are left out; a paused one says so.
 * Values: 'm' · 'p:<portfolio>' · 'c:<campaign>' · 'g:<ad group>'.
 */
export function scopeOptions(d: ScopeData, market: string): ListboxPanelOption[] {
  const camps = d.campaigns.filter((c) => c.marketplace === market && !archived(c.status))
  const portIds = new Set(camps.map((c) => c.portfolioId).filter((p): p is string => !!p))
  const ports = d.portfolios.filter((p) => portIds.has(p.externalPortfolioId))
  const campIds = new Set(camps.map((c) => c.id))
  const groups = d.adGroups.filter((g) => campIds.has(g.campaignId) && !archived(g.status))
  const campName = new Map(camps.map((c) => [c.id, c.name]))
  return [
    { value: WHOLE_MARKET, label: `Whole market · ${market}`, group: 'Market' },
    ...ports.map((p) => ({ value: `p:${p.externalPortfolioId}`, label: p.name, group: 'Portfolio' })),
    ...camps.map((c) => ({ value: `c:${c.id}`, label: c.name, group: 'Campaign', ...(paused(c.status) ? { note: 'Paused' } : {}) })),
    ...groups.map((g) => ({
      // The panel searches `searchText` INSTEAD of the label when one is given: both go in.
      value: `g:${g.id}`, label: g.name, group: 'Ad group', searchText: `${g.name} ${campName.get(g.campaignId) ?? g.campaignName ?? ''}`.trim(),
      note: [campName.get(g.campaignId) ?? g.campaignName ?? '', paused(g.status) ? 'Paused' : ''].filter(Boolean).join(' · '),
    })),
  ]
}

/** A picked place as the API's scope (an ad group carries its campaign; a portfolio and a campaign are never sent together). */
export function scopeOfPick(d: ScopeData, market: string, value: string): WasteScope | null {
  if (!market) return null
  if (value === WHOLE_MARKET || !value) return { marketplace: market }
  const [kind, id] = [value.slice(0, 1), value.slice(2)]
  if (!id) return null
  if (kind === 'p') return d.portfolios.some((p) => p.externalPortfolioId === id) ? { marketplace: market, portfolioId: id } : null
  if (kind === 'c') return d.campaigns.some((c) => c.id === id) ? { marketplace: market, campaignId: id } : null
  if (kind === 'g') {
    const g = d.adGroups.find((x) => x.id === id)
    return g ? { marketplace: market, campaignId: g.campaignId, adGroupId: g.id } : null
  }
  return null
}

/** The picked place as a path for the DS `EntityPath`: market › portfolio › campaign › ad group, each a link. */
export function pathOfPick(d: ScopeData, market: string, value: string): EntityRef[] {
  const head = marketStep(market || null)
  const portfolio = (ext: string | null | undefined): EntityRef | null => {
    const p = ext ? d.portfolios.find((x) => x.externalPortfolioId === ext) : null
    return p ? { id: p.externalPortfolioId, name: p.name, href: `/marketing/ads/portfolios/${encodeURIComponent(p.externalPortfolioId)}` } : null
  }
  const campaign = (id: string): EntityRef | null => {
    const c = d.campaigns.find((x) => x.id === id)
    return c ? { id: c.id, name: c.name, href: `/marketing/ads/campaigns/${encodeURIComponent(c.id)}` } : null
  }
  if (!value || value === WHOLE_MARKET) return [head]
  const id = value.slice(2)
  if (value.startsWith('p:')) return [head, portfolio(id)].filter((x): x is EntityRef => !!x)
  if (value.startsWith('c:')) {
    const c = d.campaigns.find((x) => x.id === id)
    return [head, portfolio(c?.portfolioId), campaign(id)].filter((x): x is EntityRef => !!x)
  }
  if (value.startsWith('g:')) {
    const g = d.adGroups.find((x) => x.id === id)
    if (!g) return [head]
    const c = d.campaigns.find((x) => x.id === g.campaignId)
    const group: EntityRef = { id: g.id, name: g.name, href: `/marketing/ads/campaigns/${encodeURIComponent(g.campaignId)}/ad-groups/${encodeURIComponent(g.id)}` }
    return [head, portfolio(c?.portfolioId ?? g.portfolioId), campaign(g.campaignId), group].filter((x): x is EntityRef => !!x)
  }
  return [head]
}

/** The path in words, for the review's Where. */
export const pathText = (path: readonly EntityRef[]): string => path.map((p) => p.name).join(' › ')
