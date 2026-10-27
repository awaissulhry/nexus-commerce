/**
 * Reviews › Insights › Brief — the page's words and rules (build spec §3.4, the Brief board): which brief shows (the
 * newest of the scope, or an earlier one by `?brief=<id>`, read-only), why "Generate" is held (the permission, 10 a day,
 * fewer than 20 reviews and Amazon topic mentions), the findings with their trend and evidence links, the before / now
 * table, what the brief was made from, the history, and the brief as plain text. The brief never sees Amazon review
 * text — only Amazon's English topics and reviews a person imported (ruling 5). Pure, tested in briefModel.vitest.test.ts.
 */
import { inboxHref, insightsHref } from '../../_lib/reviewsLinks'
import { themeWord } from '../../_lib/reviewWords'
import { amazonTopicsInScope, periodWords, scopeKey, scopeLabel, type InsightsScope, type ScopeChoice } from '../_shared/insightsScope'

// ── The API's answers ───────────────────────────────────────────────

export interface SpotlightFinding {
  n: number
  theme: string | null
  title: string
  trend: 'worse' | 'new' | 'steady' | 'better'
  text: string
  evidence: Array<{ kind: 'reviews'; theme: string; count: number } | { kind: 'alert'; id: string; market: string } | { kind: 'fixes'; theme: string; count: number } | { kind: 'theme'; theme: string; mentions: number }>
}

export interface SpotlightChange {
  key: string
  what: string
  before: number | null
  now: number | null
  change: number | null
  higherIsBetter: boolean
  unit: 'stars' | 'percent' | 'count'
}

export interface SpotlightContent {
  sentiment: { positive: number; neutral: number; negative: number; total: number; avgRating: number | null }
  complaints: Array<{ theme: string; count: number; severity: string; quotes: string[] }>
  praises: Array<{ theme: string; count: number; quotes: string[] }>
  emerging: Array<{ theme: string; note: string }>
  recommendations: Array<{ title: string; detail: string; area: string; sku?: string }>
  findings?: SpotlightFinding[]
  changes?: SpotlightChange[]
  sources?: { reviews: number; amazonTopics: number; amazonTopicsAt: string | null; amazonReviewText: false }
}

export interface Spotlight {
  id: string
  productId: string | null
  channel: string | null
  marketplace: string | null
  windowDays: number
  reviewCount: number
  headline: string | null
  content: SpotlightContent
  model: string
  usedAi: boolean
  generatedAt: string
}

export interface ScopeOptionFull extends ScopeChoice {
  label: string
  material: number
  tooFew: boolean
  latest: { id: string; generatedAt: string } | null
  note: string
}

export interface ScopesAnswer {
  options: ScopeOptionFull[]
  limit: { perDay: number; usedToday: number; left: number }
  minReviews: number
  windowDays: number
}

export interface HistoryRow {
  id: string
  generatedAt: string
  channel: string | null
  marketplace: string | null
  label: string
  windowDays: number
  reviewCount: number
  headline: string | null
  usedAi: boolean
}

// ── Generate ────────────────────────────────────────────────────────

export const MANAGE_BRIEF = "You need 'Manage reviews' to write a brief. Everyone with the Reviews page can read them."
export const WRITING_HELD = 'A brief is being written. Wait for it, or cancel it.'

/** The scope's option in the API's list (its review count and whether a brief exists). */
export function optionFor(scopes: ScopesAnswer | null, scope: Pick<InsightsScope, 'channel' | 'market'>): ScopeOptionFull | null {
  if (!scopes) return null
  const key = scopeKey(scope)
  return scopes.options.find((o) => scopeKey({ channel: o.channel, market: o.marketplace }) === key) ?? null
}

/** "eBay Italy has 13 reviews and Amazon topic mentions in 30 days; a brief needs 20. Pick 90 days, or more markets." */
export function tooFewWords(scope: Pick<InsightsScope, 'channel' | 'market'>, material: number, days: number, min: number): string {
  const what = amazonTopicsInScope(scope)
    ? material === 1 ? 'review or Amazon topic mention' : 'reviews and Amazon topic mentions'
    : material === 1 ? 'review' : 'reviews'
  return `${scopeLabel(scope)} has ${material} ${what} in ${days} days; a brief needs ${min}. Pick a longer period, or more markets.`
}

/** Why Generate is held (null = it can write one): the permission, writing now, 10 a day, too few reviews. */
export function generateHeld(input: { canManage: boolean; writing: boolean; scopes: ScopesAnswer | null; scope: Pick<InsightsScope, 'channel' | 'market'> }): string | null {
  if (!input.canManage) return MANAGE_BRIEF
  if (input.writing) return WRITING_HELD
  const s = input.scopes
  if (!s) return 'Wait until Nexus has counted the reviews.'
  if (s.limit.left <= 0) return `${s.limit.perDay} briefs a day for this business: ${s.limit.usedToday} made today. Try again tomorrow.`
  const option = optionFor(s, input.scope)
  const material = option?.material ?? 0
  if (material < s.minReviews) return tooFewWords(input.scope, material, s.windowDays, s.minReviews)
  return null
}

/** "About 30 seconds · a small AI cost · 3 of 10 today". */
export function costWords(scopes: ScopesAnswer | null): string {
  const today = scopes ? ` · ${scopes.limit.usedToday} of ${scopes.limit.perDay} today` : ''
  return `About 30 seconds · a small AI cost${today}`
}

/** The button: Generate a brief (none yet) / Generate again. */
export function generateLabel(brief: Spotlight | null): string {
  return brief ? 'Generate again' : 'Generate a brief'
}

// ── The brief ───────────────────────────────────────────────────────

const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })

/** "Voice of the customer · Amazon Germany · last 30 days". */
export function briefEyebrow(brief: Spotlight | null, scope: InsightsScope): string {
  const days = brief?.windowDays
  const span = days ? (days === 365 ? 'last 12 months' : `last ${days} days`) : periodWords(scope.period).label
  return `Voice of the customer · ${scopeLabel(brief ? { channel: brief.channel, market: brief.marketplace } : scope)} · ${span}`
}

/** "Written Mon 26 Oct from 128 reviews and the Amazon topics of Mon 20 Oct · by AI". */
export function briefMeta(brief: Spotlight): string {
  const src = brief.content.sources
  const reviews = src?.reviews ?? brief.reviewCount
  const topics = src?.amazonTopicsAt ? ` and the Amazon topics of ${day(src.amazonTopicsAt)}` : src?.amazonTopics ? ' and Amazon topics' : ''
  const how = brief.usedAi ? 'by AI' : 'without AI (the AI service was not available): from the review themes and phrases'
  return `Written ${day(brief.generatedAt)} from ${reviews} ${reviews === 1 ? 'review' : 'reviews'}${topics} · ${how}`
}

export const TREND_WORDS: Record<SpotlightFinding['trend'], { word: string; tone: 'danger' | 'warning' | 'neutral' | 'success' }> = {
  worse: { word: 'Worse', tone: 'danger' },
  new: { word: 'New', tone: 'warning' },
  steady: { word: 'Steady', tone: 'neutral' },
  better: { word: 'Better', tone: 'success' },
}

/** A finding's evidence as links: its reviews (the Inbox), its alert, its fixes, its theme. */
export function evidenceLinks(f: SpotlightFinding, scope: InsightsScope): Array<{ label: string; href: string }> {
  return f.evidence.map((e) => {
    if (e.kind === 'reviews') return { label: `${e.count} ${e.count === 1 ? 'review' : 'reviews'} about ${themeWord(e.theme)}`, href: inboxHref({ theme: e.theme, channel: scope.channel, market: scope.market, period: scope.period }) }
    if (e.kind === 'alert') return { label: `Open alert · ${e.market}`, href: insightsHref('alerts', { status: 'ALL', channel: scope.channel, market: e.market, period: scope.period }) }
    if (e.kind === 'fixes') return { label: `${e.count} open ${e.count === 1 ? 'fix' : 'fixes'}`, href: insightsHref('fixes', { channel: scope.channel, market: scope.market, period: scope.period }) }
    return { label: `${themeWord(e.theme)}: ${e.mentions} mentions`, href: insightsHref('themes', { channel: scope.channel, market: scope.market, period: scope.period }) }
  })
}

/** A before / now value in its unit; unknown → "—". */
export function changeValue(value: number | null, unit: SpotlightChange['unit']): string {
  if (value == null) return '—'
  if (unit === 'stars') return value.toFixed(1)
  if (unit === 'percent') return `${Math.round(value)}%`
  return Math.round(value).toLocaleString('en-IE')
}

/** The change with its sign and whether it is good news. */
export function changeDelta(c: SpotlightChange): { text: string; tone: 'good' | 'bad' | null } {
  if (c.change == null) return { text: '—', tone: null }
  if (c.change === 0) return { text: 'Same', tone: null }
  const abs = Math.abs(c.change)
  const text = `${c.change > 0 ? '+' : '−'}${c.unit === 'stars' ? abs.toFixed(1) : c.unit === 'percent' ? `${Math.round(abs)} pts` : Math.round(abs).toLocaleString('en-IE')}`
  return { text, tone: (c.change > 0) === c.higherIsBetter ? 'good' : 'bad' }
}

/** The brief as plain text, for "Copy as text". */
export function briefText(brief: Spotlight, scope: InsightsScope): string {
  const lines = [briefEyebrow(brief, scope), brief.headline ?? '', '']
  for (const f of brief.content.findings ?? []) lines.push(`${f.n}. ${f.title} (${TREND_WORDS[f.trend].word})`, `   ${f.text}`)
  const changes = brief.content.changes ?? []
  if (changes.length) {
    lines.push('', `What changed since ${periodWords(scope.period).before}:`)
    for (const c of changes) lines.push(`- ${c.what}: ${changeValue(c.before, c.unit)} → ${changeValue(c.now, c.unit)} (${changeDelta(c).text})`)
  }
  lines.push('', briefMeta(brief))
  return lines.join('\n')
}

/** An earlier brief in the list: "Mon 19 Oct" · "Amazon Germany · 30 days". */
export function historyWords(row: HistoryRow): { date: string; scope: string } {
  return { date: day(row.generatedAt), scope: `${row.label} · ${row.windowDays === 365 ? '12 months' : `${row.windowDays} days`}` }
}

/** The empty card under the headline "No brief yet for …": too few reviews for one, or the way to the first one. */
export function emptyBrief(scopes: ScopesAnswer | null, scope: Pick<InsightsScope, 'channel' | 'market'>): { headline: string; title: string; text: string } {
  const headline = `No brief yet for ${scopeLabel(scope)}`
  const option = optionFor(scopes, scope)
  if (scopes && (option?.material ?? 0) < scopes.minReviews) {
    return { headline, title: 'Not enough reviews for a brief', text: tooFewWords(scope, option?.material ?? 0, scopes.windowDays, scopes.minReviews) }
  }
  return { headline, title: 'Generate the first brief', text: 'Nexus reads the period’s reviews (and Amazon’s topics, where there are any) and writes what buyers tell you, with the evidence.' }
}

/** The toast when a brief is written; when it could not be. */
export function generatedWords(brief: Spotlight): string {
  return brief.usedAi ? `New brief written from ${brief.reviewCount} reviews.` : `New brief written without AI (the AI service was not available), from ${brief.reviewCount} reviews.`
}
