/**
 * Reviews › Inbox — the words around the list: the tabs and their counts, the six status tiles, the removable chips,
 * the banner for a channel Nexus is not reading, the live pill, the header line, and the words of one row (received,
 * kind, due, product). Due and overdue are the API's 48-hour rule (`@nexus/shared/review-reply-rules`): the row carries
 * `dueAt` and `overdue`, this file only words them. Pure, tested in inboxTiles.vitest.test.ts.
 */
import { REPLY_DUE_HOURS } from '@nexus/shared/review-reply-rules'
import type { Tone } from '@/design-system/primitives'
import { STATUS_WORD, MOOD_WORD, channelMarketWords, themeWord } from '../_lib/reviewWords'
import { COUNTRY_NAMES } from '@/app/_shared/app-nav'
import { channelLabel } from '@/app/listings/_readiness/marketChips'
import type { InboxFacets, InboxReadState, InboxRow, InboxStatusCounts, InboxTabCounts } from './inboxDatasource'
import {
  NO_OWNER, toggleStatusTile, withNeedsReply, withPeriod, withPhotos, withProduct, withSearch, withoutValue, type InboxFilterKey, type InboxKind,
  type InboxPeriod,
  type InboxQuery, type InboxStatus,
} from './inboxQuery'

const HOUR = 3_600_000
const DAY = 24 * HOUR

export function count(n: number): string {
  return n.toLocaleString('en-US')
}

export function plural(n: number, one: string, many: string): string {
  return `${count(n)} ${n === 1 ? one : many}`
}

// ── Tabs ─────────────────────────────────────────────────────────────

export const TAB_LABEL: Record<InboxKind, string> = { all: 'All', product: 'Product reviews', seller: 'Seller feedback' }

/** The three tabs, each with the count the API gave (null = not known yet, never a zero). */
export function tabItems(counts: InboxTabCounts | null): { id: InboxKind; label: string; count: number | null }[] {
  return (['all', 'product', 'seller'] as const).map((id) => ({ id, label: TAB_LABEL[id], count: counts ? counts[id] : null }))
}

// ── Status tiles ─────────────────────────────────────────────────────

export const TILE_ORDER: readonly InboxStatus[] = ['NEW', 'IN_PROGRESS', 'RESPONDED', 'RESOLVED', 'IGNORED', 'OVERDUE']

export function tileLabel(status: InboxStatus): string {
  return status === 'OVERDUE' ? 'Overdue' : STATUS_WORD[status]
}

const TILE_HINT: Record<InboxStatus, string> = {
  NEW: 'nobody has picked it up',
  IN_PROGRESS: 'someone is on it',
  RESPONDED: 'a reply went out',
  RESOLVED: 'no reply needed',
  IGNORED: 'hidden from New',
  OVERDUE: `needs a reply for more than ${REPLY_DUE_HOURS} h`,
}

export function tileHint(status: InboxStatus): string {
  return TILE_HINT[status]
}

/** The tile's number: '—' until the API answered (never a zero it did not say). */
export function tileValue(counts: InboxStatusCounts | null, status: InboxStatus): string {
  return counts ? count(counts[status]) : '—'
}

/** The tile's dot: Overdue is the one that needs a person now. */
export function tileAccent(status: InboxStatus): string | undefined {
  return status === 'OVERDUE' ? 'var(--nds-danger)' : status === 'NEW' ? 'var(--nds-warning)' : undefined
}

// ── Chips (every filter on, each removable) ──────────────────────────

export interface InboxChip {
  key: string
  label: string
  /** The × button's name: what removing it shows. */
  removeLabel: string
  /** The query with this one filter gone. */
  next: InboxQuery
}

const PERIOD_SHORT: Record<InboxPeriod, string> = { '7d': '7 days', '30d': '30 days', '90d': '90 days', '12m': '12 months', all: 'All time' }

export function periodShort(period: InboxPeriod): string {
  return PERIOD_SHORT[period]
}

/** "last 30 days" / "all time", for a sentence. */
export function periodSentence(period: InboxPeriod): string {
  return period === 'all' ? 'all time' : `last ${PERIOD_SHORT[period]}`
}

export function marketWord(code: string): string {
  return COUNTRY_NAMES[code.toUpperCase()] ?? code
}

export function ownerWord(owner: string): string {
  return owner === NO_OWNER ? 'Nobody' : owner
}

export function starsChipWord(n: number): string {
  return `${n} ${n === 1 ? 'star' : 'stars'}`
}

/** "Status: New", "Overdue". */
export function statusChipWord(status: InboxStatus): string {
  return status === 'OVERDUE' ? 'Overdue' : `Status: ${STATUS_WORD[status]}`
}

const FIELD_NOUN: Record<InboxFilterKey, string> = {
  channels: 'Channel', markets: 'Market', stars: 'Stars', moods: 'Mood', themes: 'Theme', statuses: 'Status', owners: 'Owner', families: 'Family',
}

/** A filter value in words, for its chip and its Filters option. */
export function valueWord(key: InboxFilterKey, value: string | number, facets: InboxFacets | null = null): string {
  const v = String(value)
  switch (key) {
    case 'channels': return channelLabel(v)
    case 'markets': return marketWord(v)
    case 'stars': return starsChipWord(Number(v))
    case 'moods': return MOOD_WORD[v] ?? v
    case 'themes': return themeWord(v)
    case 'statuses': return v === 'OVERDUE' ? 'Overdue' : STATUS_WORD[v] ?? v
    case 'owners': return ownerWord(v)
    case 'families': return facets?.families.find((f) => f.id === v)?.label ?? 'A product family'
  }
}

/** One chip per filter on, in the Filters order, then the search; the period first. */
export function inboxChips(q: InboxQuery, facets: InboxFacets | null = null): InboxChip[] {
  const chips: InboxChip[] = []
  if (q.period !== 'all') {
    chips.push({ key: 'period', label: `Received in the last ${PERIOD_SHORT[q.period]}`, removeLabel: 'Show reviews from any date', next: withPeriod(q, 'all') })
  }
  if (q.product) {
    chips.push({ key: 'product', label: 'One product (and its variants)', removeLabel: 'Show the reviews of every product', next: withProduct(q, null) })
  }
  if (q.needsReply) {
    chips.push({ key: 'needsReply', label: 'Needs a reply', removeLabel: 'Show every review, not only the ones that need a reply', next: withNeedsReply(q, false) })
  }
  if (q.statuses.length === 1) {
    const s = q.statuses[0]
    chips.push({ key: `statuses:${s}`, label: statusChipWord(s), removeLabel: `Show every status, not only ${tileLabel(s)}`, next: toggleStatusTile(q, null) })
  }
  const keys: InboxFilterKey[] = ['channels', 'markets', 'stars', 'moods', 'themes', 'statuses', 'owners', 'families']
  for (const key of keys) {
    if (key === 'statuses' && q.statuses.length === 1) continue
    for (const value of q[key] as readonly (string | number)[]) {
      const word = valueWord(key, value, facets)
      chips.push({
        key: `${key}:${value}`,
        label: key === 'stars' ? word : `${FIELD_NOUN[key]}: ${word}`,
        removeLabel: `Remove the filter ${FIELD_NOUN[key]}: ${word}`,
        next: withoutValue(q, key, value),
      })
    }
  }
  if (q.photos) chips.push({ key: 'photos', label: 'Has photos', removeLabel: 'Show reviews with or without photos', next: withPhotos(q, false) })
  if (q.q) chips.push({ key: 'q', label: `Search: “${q.q}”`, removeLabel: 'Clear the search', next: withSearch(q, '') })
  return chips
}

// ── Read state: a channel Nexus is not reading ───────────────────────

export interface ReadBanner {
  key: string
  title: string
  body: string
  action: { label: string; href: string } | null
}

/** "Thu 23 Oct" (local time; `timeZone` for tests). */
export function dayWords(iso: string, timeZone?: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone })
}

function sentence(text: string): string {
  const t = text.trim()
  if (!t) return t
  const capped = t.charAt(0).toUpperCase() + t.slice(1)
  return /[.!?]$/.test(capped) ? capped : `${capped}.`
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * One banner per reason a channel is not read ("eBay Germany has not been read since 23 Oct."): markets with the same
 * reason and the same fix share a banner, so five unread markets are one sentence, not five banners.
 */
export function readStateBanners(readState: readonly InboxReadState[] | null, timeZone?: string): ReadBanner[] {
  const groups = new Map<string, InboxReadState[]>()
  for (const r of readState ?? []) {
    if (r.ok) continue
    const key = `${r.reason ?? ''}|${r.reconnectHref ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  return [...groups.entries()].map(([key, rows]) => {
    const places = rows.map((r) => channelMarketWords(r.channel, r.market))
    const where = joinWords(places)
    const since = rows.length === 1 && rows[0].since ? dayWords(rows[0].since, timeZone) : ''
    const title = since ? `${where} has not been read since ${since}.` : `${where} ${rows.length === 1 ? 'is' : 'are'} not being read.`
    const reason = rows[0].reason ? sentence(rows[0].reason) : ''
    // Only what is known (audit B1): this place is not read. Nothing is claimed about the other channels.
    const body = `${reason ? `${reason} ` : ''}New reviews from ${rows.length === 1 ? where : 'these markets'} are missing here until Nexus reads ${rows.length === 1 ? 'it' : 'them'} again.`
    const href = rows[0].reconnectHref
    const action = href ? { label: rows.length === 1 ? `Reconnect ${where}` : `Reconnect ${channelLabel(rows[0].channel)}`, href } : null
    return { key, title, body, action }
  })
}

/** The toolbar's live pill. */
export function livePill(state: { error: boolean; updating: boolean; readState: readonly InboxReadState[] | null }): { tone: Tone; words: string } {
  if (state.error) return { tone: 'danger', words: 'Not updating' }
  if (state.updating) return { tone: 'info', words: 'Updating…' }
  const behind = (state.readState ?? []).filter((r) => !r.ok)
  if (behind.length === 1) return { tone: 'warning', words: `${channelMarketWords(behind[0].channel, behind[0].market)} behind` }
  if (behind.length > 1) return { tone: 'warning', words: `${behind.length} markets behind` }
  return { tone: 'success', words: 'Up to date' }
}

/** The header line: "1,284 reviews · last 30 days". */
/** "37 need a reply" — the badges' number on the button that shows them. */
export function needsReplyWords(n: number): string {
  return `${count(n)} ${n === 1 ? 'needs' : 'need'} a reply`
}

export function headerSubtitle(total: number | null, period: InboxPeriod, state: 'loading' | 'error' | 'ready'): string {
  if (state === 'loading' || (state === 'ready' && total == null)) return 'Loading…'
  if (state === 'error' || total == null) return `Could not load · ${periodSentence(period)}`
  return `${plural(total, 'review', 'reviews')} · ${periodSentence(period)}`
}

// ── One row in words ─────────────────────────────────────────────────

/** "just now", "12 min ago", "5 h ago", "1 day ago", "3 months ago". */
export function agoWords(iso: string, now: number): string {
  const ms = now - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return ''
  if (ms < 60_000) return 'just now'
  if (ms < HOUR) return `${Math.floor(ms / 60_000)} min ago`
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h ago`
  const days = Math.floor(ms / DAY)
  if (days < 30) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  if (days < 365) {
    const months = Math.floor(days / 30)
    return `${months} ${months === 1 ? 'month' : 'months'} ago`
  }
  const years = Math.floor(days / 365)
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}

/** "Seller feedback", "Product review · imported". */
export function kindWords(row: Pick<InboxRow, 'kind' | 'imported'>): string {
  return `${row.kind === 'seller' ? 'Seller feedback' : 'Product review'}${row.imported ? ' · imported' : ''}`
}

/** PR G — "2 photos", "1 photo"; null when the buyer added none (or an older answer has no count). */
export function photoWords(row: Partial<Pick<InboxRow, 'photos'>>): string | null {
  const n = typeof row.photos === 'number' ? row.photos : 0
  return n > 0 ? `${n} ${n === 1 ? 'photo' : 'photos'}` : null
}

export type DueKind = 'late' | 'soon' | 'ok' | 'done'

/** "Overdue 7 h", "Due in 18 h", "Due 29 Oct", "Replied", "No reply needed" — from the API's due time and flag. */
export function dueWords(row: Pick<InboxRow, 'status' | 'dueAt' | 'overdue' | 'responses'>, now: number, timeZone?: string): { text: string; kind: DueKind } {
  if (row.responses.sent > 0 || row.status === 'RESPONDED') return { text: 'Replied', kind: 'done' }
  if (!row.dueAt) return { text: 'No reply needed', kind: 'done' }
  const due = new Date(row.dueAt).getTime()
  if (row.overdue || due <= now) {
    const late = Math.max(0, now - due)
    const days = Math.floor(late / DAY)
    return { text: days >= 1 ? `Overdue ${days} ${days === 1 ? 'day' : 'days'}` : `Overdue ${Math.max(1, Math.floor(late / HOUR))} h`, kind: 'late' }
  }
  const left = due - now
  if (left < DAY) return { text: `Due in ${Math.max(1, Math.ceil(left / HOUR))} h`, kind: 'soon' }
  return { text: `Due ${dayWords(row.dueAt, timeZone)}`, kind: 'ok' }
}

/** "Touring jacket — M · Black"; no product link → null. */
export function productWords(row: Pick<InboxRow, 'product'>): string | null {
  if (!row.product) return null
  return row.product.variant ? `${row.product.name} — ${row.product.variant}` : row.product.name
}

/** "German" for "de"; null when unknown. */
export function languageWords(code: string | null | undefined): string | null {
  if (!code) return null
  try {
    return new Intl.DisplayNames('en', { type: 'language' }).of(code) ?? null
  } catch {
    return null
  }
}

/** The review is in another language and its English is known: the Review cell offers it on hover. */
export function hasTranslation(row: Pick<InboxRow, 'language' | 'english'>): boolean {
  return !!row.english && !!row.language && row.language !== 'en'
}

export const STATUS_TONE: Record<string, Tone> = { NEW: 'warning', IN_PROGRESS: 'info', RESPONDED: 'success', RESOLVED: 'neutral', IGNORED: 'neutral' }
export const MOOD_TONE: Record<string, Tone> = { POSITIVE: 'success', NEUTRAL: 'neutral', NEGATIVE: 'danger' }
