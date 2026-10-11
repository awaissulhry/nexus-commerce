/**
 * Negative Targeting page, Rules view (2026-10-11) — the words and rules of the stop-waste rules table, pure and tested
 * in Node.
 *
 * The shapes mirror GET /api/advertising/waste/rules (apps/api/src/services/advertising/waste-rules/read.ts): the Bid
 * page's rule row (`bid/rules/bidRulesModel.ts`: mode, holds, scope lists with true counts, 7 days, runs) plus `kind`
 * (a keyword pause rule or a search-term negative rule), `source` (a rule, or the read-only Brain and Harvest rows),
 * the stop-waste `test` and the ad-group grain of its scope. Money is in cents under money keys a person without the
 * ad-spend permission does not receive (so every money field is optional here); every `href` comes WITHOUT the
 * `/w/<id>` prefix (the workspace `Link` adds it).
 *
 * The Owner's words only: Off · Watch · Ask me · Auto; Brain, Harvest, Rule. Labels, numbers and chips.
 */
import type { EntityRef } from '@/design-system/components'
import { WEEK } from '../../bid/_shared/format'
import { holdReason, holdWord, holdsOf, type BidMode, type BidRuleMode, type Hold, type Ref, type RefCounts, type RefSet } from '../../bid/rules/bidRulesModel'

// ── the API's shapes ────────────────────────────────────────────────────────────────────────────────────────────────

export type WasteKind = 'PAUSE_KEYWORD' | 'NEGATE_TERM'
export type WasteSource = 'rule' | 'brain' | 'harvest'

/** A stop-waste rule's test (null for a rule made elsewhere: its trigger's own window). `spendFloorCents` is money. */
export interface WasteTest { kind: WasteKind; windowDays: number; minClicks: number; cpaMultiple: number; spendFloorCents?: number }

export interface WasteRuleRow {
  id: string
  kind: WasteKind
  source: WasteSource
  /** The Brain and Harvest rows: shown, never changed here (their own pages own them). */
  readOnly: boolean
  name: string
  sentence: string
  market: string | null
  mode: BidRuleMode
  test: WasteTest | null
  /** What it applies to (the evaluator's matcher): its campaigns, their portfolios, its ONE ad group when it names one. */
  scope: RefSet & { all: boolean; product: Ref | null; adGroup: Ref | null; counts: RefCounts }
  changed7d: RefSet & { paused: number; negated: number; counts?: RefCounts }
  last7d: { runs: number; asks: number; applied: number; written: number; refused: number; askedByCaps: number }
  waiting: number
  lastRunAt: string | null
  nextRunAt: string | null
  firstRunAt?: string | null
  thenRunAt?: string | null
  schedule?: string | null
  archived: boolean
}

export interface WasteRulesTotals {
  rules: number; on: number; acting: number; auto: number; asking: number; held: number; waiting: number
  paused7d: number; negated7d: number; archived: number; otherMarkets: number
}

export interface WasteRulesAnswer { channel: string; market: string | null; rules: WasteRuleRow[]; totals: WasteRulesTotals; note: string | null }

export const isPseudo = (row: Pick<WasteRuleRow, 'source' | 'readOnly'>): boolean => row.source !== 'rule' || row.readOnly

/**
 * NFIX — Harvest's waiting harvests are decided on the Keyword Harvest page (its own page), never here: its Waiting is a
 * link there with the count (or "—"), and its detail has no Waiting tab — no count on this page without its list.
 */
export const decidedElsewhere = (row: Partial<Pick<WasteRuleRow, 'source'>>): boolean => row.source === 'harvest'
export const HARVEST_PAGE = '/marketing/ads/rules-automation/keyword-harvest'
/** The Keyword Harvest page's "Waiting for you" list, in this market. */
export function harvestWaitingHref(market: string | null | undefined): string {
  const m = (market ?? '').trim()
  return `${HARVEST_PAGE}?show=waiting${m && m.toLowerCase() !== 'all' ? `&market=${encodeURIComponent(m.toUpperCase())}` : ''}`
}
export const isStopWaste = (row: Pick<WasteRuleRow, 'test'>): boolean => row.test != null

// ── who owns a row ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface OwnerWords {
  /** The chip's word. */
  word: string
  /** Why its mode is not changed here — the lock's reason (hover and focus). */
  lock: string
  /** Where it is changed. */
  href: string
  /** That page's name, for the link. */
  page: string
}

export const OWNERS: Readonly<Record<'brain' | 'harvest', OwnerWords>> = {
  brain: { word: 'Brain', lock: 'The Brain keeps these negatives: it is set per product in the Control Room', href: '/marketing/ads/rules-automation/control-room', page: 'Control Room' },
  harvest: { word: 'Harvest', lock: 'Harvest owns these negatives: it is set on Keyword Harvest', href: '/marketing/ads/rules-automation/keyword-harvest', page: 'Keyword Harvest' },
}

/** The owner of a read-only row; null for a rule (it is changed here). */
export const ownerOf = (row: Pick<WasteRuleRow, 'source' | 'readOnly'>): OwnerWords | null =>
  row.source === 'brain' ? OWNERS.brain : row.source === 'harvest' ? OWNERS.harvest : null

/** What a rule stops, as the icon's words (the icon is the page's: Crosshair for our keyword, TextSearch for a term). */
export const KIND_WORD: Readonly<Record<WasteKind, string>> = { PAUSE_KEYWORD: 'Our keywords', NEGATE_TERM: 'Shoppers’ search terms' }

// ── modes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What each mode does for a waste rule, for the hover help (the Control Room's one vocabulary). */
export const WASTE_MODE_MEANS: Readonly<Record<BidMode, string>> = {
  OFF: 'Does not run.',
  WATCH: 'Runs and records what it would stop. Changes nothing.',
  ASK: 'You decide each pause or negative.',
  AUTO: 'Pauses and adds negatives by itself, inside its caps.',
}

/** Why the whole mode picker is locked for this row (owner, archived, permission), or null. One wording everywhere. */
export function modeLock(row: Pick<WasteRuleRow, 'source' | 'readOnly' | 'archived'>, permission: string | null = null): string | null {
  const owner = ownerOf(row)
  if (owner) return owner.lock
  if (row.archived) return 'Archived: unarchive it first'
  return permission
}

/** Why a step cannot be picked for this row (the list's held line), or null. Auto: the API's own reason. */
export function heldStep(row: Pick<WasteRuleRow, 'mode'>, step: string): string | null {
  if (step !== 'AUTO' || row.mode.set === 'AUTO' || !row.mode.autoLocked) return null
  if (row.mode.set === 'OFF') return 'Pick Watch or Ask me first'
  return holdReason(row.mode.autoLocked)
}

/** Why Auto cannot be picked, as a chip and its hover; null when it can, it is Auto, archived or read only. */
export function autoLockOf(row: Pick<WasteRuleRow, 'mode' | 'archived' | 'source' | 'readOnly'>): Hold | null {
  if (row.archived || isPseudo(row) || row.mode.set === 'AUTO' || !row.mode.autoLocked) return null
  const label = holdWord(row.mode.autoLocked.label)
  // A rule that always asks: "Asks first" (audit M8: never "Auto: Always asks").
  if (/always asks|asks first/i.test(label)) return { ...row.mode.autoLocked, label: 'Asks first' }
  return { ...row.mode.autoLocked, label: /^auto\b/i.test(label) ? label : `Auto: ${label}` }
}

/** The holds the Mode cell's arrow does not show (it acts as set): marked beside it so the table is as honest as the detail. */
export function partHolds(mode: BidRuleMode): Hold[] {
  return mode.acts === mode.set ? holdsOf(mode) : []
}

/** A part hold that only informs (Auto inside its caps), as opposed to one that keeps it from some campaigns. */
export const isInfoHold = (h: Pick<Hold, 'kind'>): boolean => h.kind === 'cap'

// ── scope: channel › market › portfolio › campaign › ad group ───────────────────────────────────────────────────────

export type ScopeLevel = 'adGroup' | 'campaign' | 'portfolio' | 'product' | 'market' | 'account'

const trueCount = (list: readonly Ref[], counted: number | undefined): number =>
  Math.max(list.length, typeof counted === 'number' && Number.isFinite(counted) ? counted : list.length)

/** How far down a rule's scope reaches, from what it applies to: one ad group, one campaign, one portfolio, a product, a market. */
export function scopeLevel(row: Pick<WasteRuleRow, 'scope' | 'market'>): ScopeLevel {
  const s = row.scope
  if (s.adGroup) return 'adGroup'
  if (s.product) return 'product'
  if (s.all) return row.market ? 'market' : 'account'
  if (trueCount(s.campaigns, s.counts.campaigns) === 1) return 'campaign'
  if (trueCount(s.portfolios, s.counts.portfolios) === 1 && trueCount(s.campaigns, s.counts.campaigns) > 1) return 'portfolio'
  return row.market ? 'market' : 'account'
}

/** The market step of a path: its code ("IT"), or "All markets". Never a link (the header picker is the market). */
export const marketStep = (market: string | null): EntityRef => ({ id: `market:${market ?? 'all'}`, name: market ?? 'All markets' })

/**
 * Where a rule acts, top first, for the DS `EntityPath`: market › portfolio › campaign › ad group (each a link), or
 * market › product. The deepest step is the rule's own level; a level it spans many of is said by `scopeCount`.
 */
export function scopePath(row: Pick<WasteRuleRow, 'scope' | 'market'>): EntityRef[] {
  const s = row.scope
  const level = scopeLevel(row)
  const head = marketStep(row.market)
  const portfolio = trueCount(s.portfolios, s.counts.portfolios) === 1 ? s.portfolios[0] ?? null : null
  const campaign = trueCount(s.campaigns, s.counts.campaigns) === 1 ? s.campaigns[0] ?? null : null
  const steps: Array<EntityRef | null> = level === 'adGroup' ? [head, portfolio, campaign, s.adGroup]
    : level === 'campaign' ? [head, portfolio, campaign]
      : level === 'portfolio' ? [head, portfolio]
        : level === 'product' ? [head, s.product]
          : [head]
  return steps.filter((x): x is EntityRef => !!x)
}

/** How many campaigns a rule spans beyond its path's last step (the count chip beside the path), 0 when the path says it all. */
export function scopeCount(row: Pick<WasteRuleRow, 'scope' | 'market'>): number {
  const level = scopeLevel(row)
  if (level === 'adGroup' || level === 'campaign') return 0
  return trueCount(row.scope.campaigns, row.scope.counts.campaigns)
}

/** The scope in words for the CSV, the quick filter and a review line: "IT › IT_Jacket › Exact group", "+ 4 campaigns". */
export function scopeText(row: Pick<WasteRuleRow, 'scope' | 'market'>): string {
  const path = scopePath(row).map((s) => s.name).join(' › ')
  const n = scopeCount(row)
  const whole = row.scope.all && !row.scope.product ? ' · whole market' : ''
  return n > 1 ? `${path}${whole} · ${n} campaigns` : `${path}${whole}`
}

// ── a stop-waste rule's test and action, in chips' words ──────────────────────────────────────────────────────────

/** What a stop-waste rule does, in the builder's words: "Pause keyword, keep it paused", "Negative exact", "Negative phrase · whole campaign". */
export function verbWords(kind: WasteKind, f: { match?: 'EXACT' | 'PHRASE'; level?: 'AD_GROUP' | 'CAMPAIGN' } = {}): string {
  if (kind === 'PAUSE_KEYWORD') return ACTION_WORD.PAUSE
  return `Negative ${f.match === 'PHRASE' ? 'phrase' : 'exact'}${f.level === 'CAMPAIGN' ? ' · whole campaign' : ''}`
}

const multiple = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)} ×`

/** The test in chips' words (the builder's, no jargon): "0 orders", "≥ 20 clicks", "spend ≥ 2 × target cost per order", "60 d". */
export function testWords(f: Pick<WasteTest, 'windowDays' | 'minClicks' | 'cpaMultiple'>): string[] {
  return ['0 orders', `≥ ${f.minClicks} clicks`, `spend ≥ ${multiple(f.cpaMultiple)} target cost per order`, `${f.windowDays} d`]
}

// ── last 7 days ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const LAST_WEEK = `Last ${WEEK}`

/** A chip: its words, its tone, and the detail tab it opens (a chip with a tab is a button). */
export interface Part { key: string; text: string; tone?: 'warning' | 'info'; tab?: 'history' | 'waiting'; hint?: string }

const n = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
export const plural = n

/** The cell's chips, most telling first: keywords paused and negatives added (History), asks (Waiting), refusals. */
export function last7Parts(row: Pick<WasteRuleRow, 'changed7d' | 'last7d'> & Partial<Pick<WasteRuleRow, 'source'>>): Part[] {
  const l = row.last7d
  const parts: Part[] = []
  if (row.changed7d.paused > 0) parts.push({ key: 'paused', text: `${row.changed7d.paused} paused`, tab: 'history' })
  if (row.changed7d.negated > 0) parts.push({ key: 'negated', text: n(row.changed7d.negated, 'negative'), tab: 'history' })
  // Harvest's asks are decided on its own page: here a word, never a tab with nothing to list (NFIX).
  if (l.asks > 0) parts.push(decidedElsewhere(row) ? { key: 'asks', text: `${l.asks} asked`, hint: 'Decided on the Keyword Harvest page' } : { key: 'asks', text: `${l.asks} asked`, tab: 'waiting' })
  if (l.applied > 0) parts.push({ key: 'applied', text: `${l.applied} approved`, tab: 'history' })
  if (l.askedByCaps > 0) parts.push({ key: 'caps', text: `${l.askedByCaps} over cap`, tone: 'info', hint: 'Past its daily cap these were asked, not done alone' })
  if (l.refused > 0) parts.push({ key: 'refused', text: `${l.refused} refused`, tone: 'warning' })
  return parts
}

/** The same in one line for the tooltip, the CSV and the quick filter, with the runs. */
export function last7Text(row: Pick<WasteRuleRow, 'changed7d' | 'last7d'>): string {
  const parts = last7Parts(row).map((p) => p.text)
  const runs = row.last7d.runs
  if (!parts.length) return runs ? `${n(runs, 'run')}, nothing stopped` : 'No runs'
  return [...parts, ...(runs ? [n(runs, 'run')] : [])].join(' · ')
}

/** Where Enter on the Last 7 d cell goes: the waiting asks while some wait, else the first chip's tab, else the Overview. */
export function last7Tab(row: Pick<WasteRuleRow, 'changed7d' | 'last7d' | 'waiting'> & Partial<Pick<WasteRuleRow, 'source'>>): 'waiting' | 'history' | 'overview' {
  if (row.waiting > 0 && !decidedElsewhere(row)) return 'waiting'
  return last7Parts(row).find((p) => p.tab)?.tab ?? 'overview'
}

// ── search, archived ────────────────────────────────────────────────────────────────────────────────────────────────

const norm = (s: string) => s.toLocaleLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '')

/** A rule matches when every word is in its name, its sentence, its market or a portfolio / campaign / ad group it works on. */
export function rowMatchesSearch(row: WasteRuleRow, search: string): boolean {
  const words = norm(search).split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = norm([
    row.name, row.sentence, row.market ?? '', ownerOf(row)?.word ?? '',
    ...row.scope.portfolios.map((r) => r.name), ...row.scope.campaigns.map((r) => r.name), ...row.scope.adGroups.map((r) => r.name),
    row.scope.adGroup?.name ?? '', row.scope.product?.name ?? '',
  ].join(' '))
  return words.every((w) => hay.includes(w))
}

export interface RulesFilter { search: string; archived: boolean }

/** The rows on screen: the Brain and Harvest always (while they match the search, never in the Archived list), then the rules. */
export function visibleRows(rows: readonly WasteRuleRow[], f: RulesFilter): WasteRuleRow[] {
  return rows.filter((r) => (isPseudo(r) ? !f.archived : f.archived ? r.archived : !r.archived) && rowMatchesSearch(r, f.search))
}

export const isFiltered = (f: RulesFilter): boolean => f.search.trim() !== '' || f.archived

// ── history ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WasteChangeAction = 'paused' | 'turned_on' | 'negated' | 'removed'
export interface WasteRuleChange {
  id: string
  at: string
  action: WasteChangeAction
  target: Ref | null
  adGroup: Ref | null
  campaign: Ref | null
  portfolio: Ref | null
  match: string | null
  level: string | null
  from: string | null
  to: string | null
  who: { kind: 'rule' | 'brain' | 'harvest' | 'person'; id: string | null; name: string }
  delivery: string | null
  changeId: string | null
  undoBlocked: string | null
}
export interface WasteHistory { id: string; name: string; days: number; changes: WasteRuleChange[] }

const STATE_WORD: Readonly<Record<string, string>> = { ENABLED: 'On', PAUSED: 'Paused', ARCHIVED: 'Archived' }
export const stateWord = (s: string | null | undefined): string => (s ? STATE_WORD[s.toUpperCase()] ?? s : '—')

/** "Negative exact", "Negative phrase · campaign". */
export function negativeWord(match: string | null | undefined, level?: string | null): string {
  const m = (match ?? '').toUpperCase()
  const base = m.includes('PHRASE') ? 'Negative phrase' : m.includes('ASIN') || m.includes('PRODUCT') ? 'Negative product' : 'Negative exact'
  return level && level.toUpperCase() === 'CAMPAIGN' ? `${base} · campaign` : base
}

/** A change as before → after in words: a keyword's state, or a negative added / removed. */
export function changeFromTo(c: Pick<WasteRuleChange, 'action' | 'from' | 'to' | 'match' | 'level'>): { what: string; from: string; to: string } {
  if (c.action === 'negated') return { what: 'Negative', from: '—', to: negativeWord(c.match, c.level) }
  if (c.action === 'removed') return { what: 'Negative', from: negativeWord(c.match, c.level), to: 'Removed' }
  return { what: 'State', from: stateWord(c.from ?? (c.action === 'paused' ? 'ENABLED' : 'PAUSED')), to: stateWord(c.to ?? (c.action === 'paused' ? 'PAUSED' : 'ENABLED')) }
}

/** Who made it, as a chip word — only when it is not the row whose History this is. */
export function whoWord(c: Pick<WasteRuleChange, 'who'>, ownerId: string): string | null {
  if (c.who.kind === 'person') return c.who.name || 'You'
  if (c.who.kind === 'brain') return ownerId === 'brain' ? null : 'Brain'
  if (c.who.kind === 'harvest') return ownerId === 'harvest' ? null : 'Harvest'
  return c.who.id && c.who.id !== ownerId ? c.who.name || 'Rule' : null
}

// ── preview ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export type WasteAction = 'PAUSE' | 'NEGATE_EXACT' | 'NEGATE_PHRASE' | 'NEGATE_ASIN'
export const ACTION_WORD: Readonly<Record<WasteAction, string>> = {
  PAUSE: 'Pause keyword, keep it paused',
  NEGATE_EXACT: 'Negative exact',
  NEGATE_PHRASE: 'Negative phrase',
  NEGATE_ASIN: 'Negative product',
}
export const actionWord = (a: string | null | undefined): string => (a && a in ACTION_WORD ? ACTION_WORD[a as WasteAction] : a === 'REMOVE_NEGATIVE' ? 'Remove negative' : a ?? '—')

export interface PreviewItem {
  row: Ref
  campaign: Ref | null
  adGroup: Ref | null
  action: string
  /** The test in words (no amount in it). */
  why: string
  /** It would act alone (Auto, inside the caps); false: it would ask. */
  alone: boolean
  /** Why it would ask instead of acting alone. */
  asks: string | null
}
export interface WastePreview {
  ruleId: string | null
  saved: boolean
  sentence: string
  engine: string
  windowDays: number | null
  wouldChange: number
  wouldAsk: number
  sample: PreviewItem[]
  refused: Array<{ row: Ref; why: string }>
  note: string | null
}

/** The one "why" every listed change shares (an engine rule says the same line for each), else null: said once, above. */
export function sharedWhy(sample: ReadonlyArray<Pick<PreviewItem, 'why'>>): string | null {
  if (sample.length < 2) return null
  const first = sample[0].why
  return sample.every((s) => s.why === first) ? (/trigger and conditions match/i.test(first) ? 'Passes its test now' : first) : null
}

/** "5 would change · 1 would ask · 2 refused", as chips. */
export function previewParts(p: Pick<WastePreview, 'wouldChange' | 'wouldAsk' | 'refused'>): Part[] {
  const parts: Part[] = [{ key: 'change', text: `${p.wouldChange} would change` }]
  if (p.wouldAsk) parts.push({ key: 'ask', text: `${p.wouldAsk} would ask`, tone: 'info' })
  if (p.refused.length) parts.push({ key: 'refused', text: `${p.refused.length} refused`, tone: 'warning' })
  return parts
}

/** A refusal's reason in words: the server's sentence, or its code made readable ("source-ad-group-not-in-mappings"). */
export function refusalWhy(why: string): string {
  const w = why.trim()
  if (/\s/.test(w)) return w
  const plain = w.replace(/[-_]+/g, ' ').trim()
  return plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : 'Refused'
}

// ── waiting: the rows of GET /waste/rows?show=waiting that a rule (or the Brain) left for a person ─────────────────────

/** The fields of a waste row the Waiting tab reads (the rows endpoint's `WasteRow`). Money keys may be absent. */
export interface WaitingRow {
  id: string
  kind: 'KEYWORD' | 'TARGET' | 'TERM'
  text: string
  match: string
  currency: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  product: Ref | null
  verb: { action: string; where: 'adGroup' | 'campaign'; held: null | { label: string; reason: string } }
  d: { clicks: number; orders: number; spendCents?: number; xCpa?: number | null }
  waiting: null | { approvalId: string; by: { id: string | null; name: string }; at: string; expiresAt: string | null }
}

/** One decision: an approval (or a rule's card), and every row it covers (a card can cover a term in two ad groups). */
export interface WaitingAsk {
  approvalId: string
  rows: WaitingRow[]
  at: string
  expiresAt: string | null
}

/** The asks a rule (or the Brain: id 'brain') left, one per approval, oldest first; rows in their order. */
export function waitingAsksOf(rows: readonly WaitingRow[], ownerId: string): WaitingAsk[] {
  const by = new Map<string, WaitingAsk>()
  for (const r of rows) {
    const w = r.waiting
    if (!w || w.by.id !== ownerId) continue
    const ask = by.get(w.approvalId)
    if (ask) ask.rows.push(r)
    else by.set(w.approvalId, { approvalId: w.approvalId, rows: [r], at: w.at, expiresAt: w.expiresAt })
  }
  return [...by.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
}

/** What an ask would do, in words: its verb and where ("Negative exact · campaign"). */
export function askWhat(a: WaitingAsk): string {
  const v = a.rows[0]?.verb
  if (!v) return '—'
  const word = actionWord(v.action)
  return v.action !== 'PAUSE' && v.where === 'campaign' ? `${word} · campaign` : word
}

/** How many the rule says wait, against how many the page lists (a row the page hides — a paused campaign — is not listed). */
export function waitingGap(ruleWaiting: number, listed: readonly WaitingAsk[]): number {
  return Math.max(0, ruleWaiting - listed.length)
}

// ── archive ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** POST /waste/rules/:id/archive's answer, as the Done step's words. */
export interface ArchiveAnswer { already?: boolean; expiredAsks?: number; cancelledWrites?: number }
export function archiveWords(a: ArchiveAnswer | null | undefined): string {
  if (a?.already) return 'Already archived'
  return ['Archived', a?.expiredAsks ? `${n(a.expiredAsks, 'ask')} expired` : null, a?.cancelledWrites ? `${n(a.cancelledWrites, 'change')} cancelled` : null].filter(Boolean).join(' · ')
}

// ── errors ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The server's own sentence from a failed read; null for a bare HTTP code or a network failure. */
export function readError(message: string | null | undefined): string | null {
  const m = message?.trim()
  if (!m) return null
  if (/^Refused \(HTTP \d+/.test(m) || /^No answer/.test(m) || /^(Failed to fetch|NetworkError|Load failed)/i.test(m)) return null
  return m
}
