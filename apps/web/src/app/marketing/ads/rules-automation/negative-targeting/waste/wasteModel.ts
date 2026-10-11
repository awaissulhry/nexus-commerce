/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the page's words and rules, pure and tested in Node
 * (`wasteModel.vitest.test.ts`). The components only draw what these say.
 *
 *   address   ?market= · ?view=wasting|stopped|rules · ?show=<tile filter> · ?kind= · ?q= · ?scope=pf:|cp:|ag:<id>
 *             · ?sort= · ?page= · ?row=<row id>&tab=overview|where|history
 *   verbs     our keyword or target → Pause (kept paused); a shopper's search term → Negative exact / phrase, in the ad
 *             group or the whole campaign; a shopper's ASIN → Negative product. A row whose verb the server holds keeps
 *             it on screen, held, with the server's reason. Stopped rows: Turn on… · Remove negative… · Release lock ·
 *             Keep paused until…, each allowed or held by the server's own gate.
 *   bulk      a verb counts the ticked rows it fits; the rest are left out, each with why (never silently).
 *   review    the server's preview (`POST /waste/preview`) in the review's words: where it lands, what is left out.
 */
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD, type ChangeState, type ChangeTone } from '../../bid/_shared/delivery'
import { dayWords, money } from '../../bid/_shared/format'
import type {
  ActionGate, ApplyAnswer, Delivery, HistoryAction, Match, Owner, PreviewAnswer, PreviewStep, Ref, RowKind, RowState, StoppedRow, StoppedState,
  StoppedTotals, VerbAction, WasteAction, WasteItem, WasteRow, WasteTotals, Where,
} from './wasteTypes'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const VIEWS = ['wasting', 'stopped', 'rules'] as const
export type View = (typeof VIEWS)[number]
export const viewOf = (v: string | null | undefined): View => ((VIEWS as readonly string[]).includes(v ?? '') ? v as View : 'wasting')

export const WASTING_SHOWS = ['wasting', 'waiting', 'skipped', 'turned-on', 'clashes', 'all'] as const
export type WastingShow = (typeof WASTING_SHOWS)[number]
export const wastingShowOf = (v: string | null | undefined): WastingShow => ((WASTING_SHOWS as readonly string[]).includes(v ?? '') ? v as WastingShow : 'wasting')

export const STOPPED_SHOWS = ['all', 'kept', 'negated', 'turned-on', 'still-bought'] as const
export type StoppedShow = (typeof STOPPED_SHOWS)[number]
export const stoppedShowOf = (v: string | null | undefined): StoppedShow => ((STOPPED_SHOWS as readonly string[]).includes(v ?? '') ? v as StoppedShow : 'all')

export const KINDS = ['all', 'keyword', 'term'] as const
export type KindFilter = (typeof KINDS)[number]
export const kindOf = (v: string | null | undefined): KindFilter => ((KINDS as readonly string[]).includes(v ?? '') ? v as KindFilter : 'all')

export const DETAIL_TABS = ['overview', 'where', 'history'] as const
export type DetailTab = (typeof DETAIL_TABS)[number]
export const detailTabOf = (v: string | null | undefined): DetailTab => ((DETAIL_TABS as readonly string[]).includes(v ?? '') ? v as DetailTab : 'overview')

/** A scope the toolbar picker sets: `pf:<portfolio id>`, `cp:<campaign id>`, `ag:<ad group id>`; null = the whole market. */
export type ScopeLevel = 'pf' | 'cp' | 'ag'
export interface Scope { level: ScopeLevel; id: string }
export function scopeOf(v: string | null | undefined): Scope | null {
  const m = /^(pf|cp|ag):(.{1,64})$/.exec((v ?? '').trim())
  return m ? { level: m[1] as ScopeLevel, id: m[2] } : null
}
export const scopeKey = (s: Scope | null): string | null => (s ? `${s.level}:${s.id}` : null)

/** The API's scope params for a scope (the read routes take portfolioId, campaignId, adGroupId). */
export function scopeParams(market: string | null, scope: Scope | null): Record<string, string> {
  const out: Record<string, string> = {}
  const m = (market ?? '').trim()
  if (m && m.toLowerCase() !== 'all') out.market = m.toUpperCase()
  if (scope?.level === 'pf') out.portfolioId = scope.id
  if (scope?.level === 'cp') out.campaignId = scope.id
  if (scope?.level === 'ag') out.adGroupId = scope.id
  return out
}

/** The grid's columns that the server can order by, and the key it takes. */
export const SORT_KEY: Readonly<Record<string, string>> = {
  term: 'text', where: 'where', product: 'product', spend: 'spend', clicks: 'clicks', orders: 'orders', xCpa: 'xCpa', owner: 'owner', state: 'state',
}
/** "-spend" → { colId: 'spend', dir: 'desc' }; an unknown key → null (the server's default: spend, highest first). */
export function sortOf(v: string | null | undefined): { colId: string; dir: 'asc' | 'desc' } | null {
  const s = (v ?? '').trim()
  if (!s) return null
  const desc = s.startsWith('-')
  const key = desc ? s.slice(1) : s
  const colId = Object.keys(SORT_KEY).find((c) => SORT_KEY[c] === key)
  return colId ? { colId, dir: desc ? 'desc' : 'asc' } : null
}
export const sortParam = (s: { colId: string; dir: 'asc' | 'desc' } | null): string | null =>
  s && SORT_KEY[s.colId] ? `${s.dir === 'desc' ? '-' : ''}${SORT_KEY[s.colId]}` : null

export const PAGE_SIZES = [50, 100, 200] as const
export const DEFAULT_PAGE_SIZE = 50

export interface ListQuery {
  market: string | null
  scope: Scope | null
  kind: KindFilter
  show: string
  q: string
  sort?: string | null
  page?: number
  pageSize?: number
}

/** The query string of a list read (rows, rows/ids, stopped). Empty values are left out. */
export function listSearch(q: ListQuery): string {
  const p = new URLSearchParams(scopeParams(q.market, q.scope))
  if (q.kind !== 'all') p.set('kind', q.kind)
  if (q.show) p.set('show', q.show)
  if (q.q.trim()) p.set('q', q.q.trim())
  if (q.sort) p.set('sort', q.sort)
  if (q.page && q.page > 1) p.set('page', String(q.page))
  if (q.pageSize) p.set('pageSize', String(q.pageSize))
  const s = p.toString()
  return s ? `?${s}` : ''
}

// ── words ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const isTerm = (r: { kind: RowKind }) => r.kind === 'TERM'

/** The kind mark's name: our keyword or target, or a shopper's search term (words only in the tooltip). */
export function kindWord(kind: RowKind, match?: Match): string {
  if (kind === 'TERM') return match === 'ASIN' ? 'A product a shopper viewed' : 'A shopper\'s search term'
  if (kind === 'TARGET') return 'Your product target'
  return 'Your keyword'
}

const MATCH: Readonly<Record<Match, { chip: string; word: string }>> = {
  EXACT: { chip: 'E', word: 'Exact' },
  PHRASE: { chip: 'P', word: 'Phrase' },
  BROAD: { chip: 'B', word: 'Broad' },
  AUTO: { chip: 'A', word: 'Auto' },
  ASIN: { chip: 'PT', word: 'Product' },
  CATEGORY: { chip: 'C', word: 'Category' },
}
export const matchChip = (m: Match | null | undefined) => (m ? MATCH[m]?.chip ?? '' : '')
export const matchWord = (m: Match | null | undefined) => (m ? MATCH[m]?.word ?? '—' : '—')

export type AnyState = RowState | StoppedState
const STATE: Readonly<Record<AnyState, string>> = {
  RUNNING: 'Running',
  PAUSED: 'Paused',
  KEPT_PAUSED: 'Kept paused',
  NEGATED: 'Negative',
  PROTECTED: 'Protected',
  TURNED_ON_ELSEWHERE: 'Turned on outside Nexus',
  NOT_AT_AMAZON: 'Not at Amazon',
}
export const stateWord = (s: AnyState) => STATE[s] ?? s

/** The full name of a row's state mark (its tooltip and its accessible name). */
export function stateSentence(r: { state: AnyState; match?: Match; level?: 'AD_GROUP' | 'CAMPAIGN' | null; keptPaused?: StoppedRow['keptPaused'] }): string {
  if (r.state === 'KEPT_PAUSED') {
    const by = r.keptPaused?.by.name
    return `Kept paused${by ? ` by ${by}` : ''}: no rule, Brain or plan turns it on`
  }
  if (r.state === 'NEGATED') {
    const m = r.match === 'PHRASE' ? 'phrase' : r.match === 'ASIN' ? 'product' : 'exact'
    return `Negative ${m}${r.level === 'CAMPAIGN' ? ' in the whole campaign' : r.level === 'AD_GROUP' ? ' in this ad group' : ''}`
  }
  if (r.state === 'TURNED_ON_ELSEWHERE') return 'Kept paused, but turned on outside Nexus: it spends again'
  if (r.state === 'NOT_AT_AMAZON') return 'Amazon never took it: it blocks nothing'
  if (r.state === 'PROTECTED') return 'Protected: never negated'
  return stateWord(r.state)
}

const VERB: Readonly<Record<WasteAction, string>> = {
  PAUSE: 'Pause',
  NEGATE_EXACT: 'Negative exact',
  NEGATE_PHRASE: 'Negative phrase',
  NEGATE_ASIN: 'Negative product',
  TURN_ON: 'Turn on',
  REMOVE_NEGATIVE: 'Remove negative',
  RELEASE: 'Release lock',
  KEEP_UNTIL: 'Keep paused',
}
/** A verb's short label: "Pause", "Negative exact", "Negative phrase · campaign". */
export function verbLabel(action: WasteAction, where?: Where | null): string {
  return `${VERB[action]}${where === 'campaign' && action.startsWith('NEGATE') ? ' · whole campaign' : ''}`
}
/** A verb's full sentence (its tooltip and accessible name). */
export function verbSentence(action: WasteAction, where?: Where | null): string {
  switch (action) {
    case 'PAUSE': return 'Pause it and keep it paused: no rule, Brain or plan turns it on'
    case 'NEGATE_EXACT': return `Negative exact ${where === 'campaign' ? 'in the whole campaign' : 'in this ad group'}`
    case 'NEGATE_PHRASE': return `Negative phrase ${where === 'campaign' ? 'in the whole campaign' : 'in this ad group'}`
    case 'NEGATE_ASIN': return 'Negative product target in this ad group'
    case 'TURN_ON': return 'Turn it on: it spends again'
    case 'REMOVE_NEGATIVE': return 'Remove the negative: Amazon archives it, final'
    case 'RELEASE': return 'End the lock: rules may turn it on again'
    case 'KEEP_UNTIL': return 'Keep it paused until a day, or always'
  }
}

const HISTORY: Readonly<Record<HistoryAction, string>> = {
  paused: 'Paused', kept: 'Kept paused', released: 'Released', turned_on: 'Turned on', negated: 'Negated', removed: 'Removed', refused: 'Refused', skipped: 'Skipped',
}
export const historyWord = (a: HistoryAction) => HISTORY[a] ?? a

const DELIVERY_STATE: Readonly<Record<Delivery, ChangeState>> = {
  WAITING: 'waiting', SENT: 'sent', LIVE: 'live', UNDONE: 'undone', FAILED: 'failed', CANCELLED: 'cancelled', REFUSED: 'failed',
}
/** One word and tone per delivery (the Bid page's `delivery.ts` set). */
export function deliveryView(d: Delivery): { word: string; tone: ChangeTone } {
  const s = DELIVERY_STATE[d] ?? 'waiting'
  return { word: CHANGE_STATE_WORD[s], tone: CHANGE_STATE_TONE[s] }
}

/** Cents in the row's own money; a key the server left out (no ad-spend permission) or none is a dash. */
export const moneyOr = (cents: number | null | undefined, currency: string) => (typeof cents === 'number' && Number.isFinite(cents) ? money(cents, currency) : '—')
/** "2.1×" — spend over the target cost per order; a dash without one. */
export const xCpaText = (x: number | null | undefined) => (typeof x === 'number' && Number.isFinite(x) ? `${x >= 10 ? Math.round(x) : x.toFixed(1)}×` : '—')
export const acosText = (p: number | null | undefined) => (typeof p === 'number' && Number.isFinite(p) ? `${p.toFixed(1)} %` : '—')

/** Where a row sits, top first (portfolio › campaign › ad group); a missing step is left out by the DS path. */
export const pathOf = (r: { portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null }): Array<Ref | null> => [r.portfolio, r.campaign, r.adGroup]

/** The product cell: the one product, or "2 products" (a shared campaign has no single product). */
export function productWords(r: { product: Ref | null; productCount?: number }): string {
  if (r.product) return r.product.name
  const n = r.productCount ?? 0
  return n > 1 ? plural(n, 'product') : '—'
}

// ── owners ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The owner chip's kinds (shared `_shared/OwnerChip.tsx`). */
export type ChipKind = 'BRAIN' | 'RULE' | 'HARVEST' | 'PERSON' | 'CLAUDE' | 'PLAN' | 'ENGINE' | 'NONE'
export interface ChipOwner { kind: ChipKind; label: string; hint: string; locked: boolean; ruleId: string | null }

/** A row's owner in the chip's words: the kind word, the name on hover, a lock when its stop is the owner's to keep. */
export function chipOwner(o: Owner): ChipOwner {
  const name = (o.name ?? '').trim()
  switch (o.kind) {
    case 'BRAIN': {
      const funnel = /funnel/i.test(name)
      return { kind: 'BRAIN', label: 'Brain', hint: funnel ? 'The Brain keeps it' : 'Brain', locked: funnel, ruleId: null }
    }
    case 'RULE': return { kind: 'RULE', label: 'Rule', hint: name ? `Rule: ${name}` : 'A rule', locked: false, ruleId: o.id }
    case 'HARVEST': return { kind: 'HARVEST', label: 'Harvest', hint: 'Harvest keeps it', locked: true, ruleId: null }
    case 'CLAUDE': return { kind: 'CLAUDE', label: 'Claude', hint: 'Claude', locked: false, ruleId: null }
    case 'PERSON': return { kind: 'PERSON', label: name && name !== 'You' ? name : 'You', hint: name && name !== 'You' ? name : 'A person', locked: false, ruleId: null }
    default: return { kind: 'NONE', label: '—', hint: name && name !== '—' ? name : 'Nobody', locked: false, ruleId: null }
  }
}

// ── one row's verb ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface RowVerbView {
  action: WasteAction
  where: Where | null
  label: string
  short: string
  sentence: string
  held: string | null
  /** The blue fill only for a row that wastes (its test is met); every other verb is the quiet button. */
  primary: boolean
  /** The row the verb acts on when it is not this row (a clash: the negative that blocks our keyword). */
  targetRowId?: string | null
  /** A second action beside the verb (a wasting keyword with a negative over it: Pause, and Remove negative…). */
  second?: RowVerbView | null
}

const heldOf = (v: { held: null | { label: string; reason: string } }) => (v.held ? v.held.reason || v.held.label : null)
/** A clash "negative over our own keyword". */
export const isOwnKeywordClash = (c: WasteRow['clash']) => !!c && c.kind === 'NEG_OVER_OWN_KEYWORD'

/** Remove the negative over our own keyword (a clash), held with its owner's words when Harvest or the Brain keep it. */
function removeNegativeVerb(r: Pick<WasteRow, 'verb'> & Partial<Pick<WasteRow, 'clash'>>): RowVerbView {
  const neg = r.clash?.negative ?? null
  const target = (r.verb.action === 'REMOVE_NEGATIVE' ? r.verb.targetRowId : null) ?? neg?.rowId ?? null
  const ownerHeld = neg && chipOwner(neg.owner).locked ? chipOwner(neg.owner).hint : null
  const held = (r.verb.action === 'REMOVE_NEGATIVE' ? heldOf(r.verb) : null) ?? ownerHeld ?? (target ? null : 'The negative is not named yet')
  return { action: 'REMOVE_NEGATIVE', where: null, label: 'Remove negative…', short: 'Remove…', sentence: 'Remove the negative that blocks this keyword: Amazon archives it, final', held, primary: false, targetRowId: target }
}

/** A wasting row's verb: only a row that runs (or a protected one, held) has one. Null = nothing to do here. */
export function wasteVerb(r: Pick<WasteRow, 'state' | 'verb' | 'kind'> & Partial<Pick<WasteRow, 'test' | 'clash'>>): RowVerbView | null {
  const met = !!r.test?.met
  const clash = isOwnKeywordClash(r.clash) || r.verb.action === 'REMOVE_NEGATIVE'
  if (clash && r.state === 'RUNNING') {
    const remove = removeNegativeVerb(r)
    // It wastes: Pause stays its verb (the Owner's job), Remove negative… is the second action (audit N1).
    if (met) {
      const pauseHeld = r.verb.action === 'PAUSE' ? heldOf(r.verb) : null
      return { action: 'PAUSE', where: null, label: 'Pause', short: 'Pause', sentence: verbSentence('PAUSE'), held: pauseHeld, primary: !pauseHeld, second: remove }
    }
    // It does not waste: the clash's fix (removing the negative over it) is its one action.
    return remove
  }
  if (clash) return removeNegativeVerb(r)
  // Kept paused, but switched on outside Nexus: pause it again (and keep it paused).
  if (r.state === 'TURNED_ON_ELSEWHERE') {
    return { action: 'PAUSE', where: null, label: 'Pause again', short: 'Pause again', sentence: 'Pause it again and keep it paused: it was turned on outside Nexus', held: heldOf(r.verb), primary: true }
  }
  if (r.state !== 'RUNNING' && r.state !== 'PROTECTED') return null
  const action: VerbAction = r.verb.action
  const where = action === 'PAUSE' || action === 'NEGATE_ASIN' ? null : r.verb.where
  const held = heldOf(r.verb) ?? (r.state === 'PROTECTED' ? 'Protected: never negated' : null)
  return { action, where, label: verbLabel(action, where), short: action === 'PAUSE' ? 'Pause' : 'Negative', sentence: verbSentence(action, where), held, primary: met && !held }
}

/** A stopped row's verb and its gate (the server's own allowed / why). */
export function stoppedVerb(r: Pick<StoppedRow, 'state' | 'kind' | 'actions' | 'id'>): RowVerbView {
  const gate = (g: ActionGate) => (g.allowed ? null : g.why || 'Not allowed here')
  if (r.id.startsWith('neg:')) return { action: 'REMOVE_NEGATIVE', where: null, label: 'Remove…', short: 'Remove…', sentence: verbSentence('REMOVE_NEGATIVE'), held: gate(r.actions.removeNegative), primary: false }
  if (r.state === 'TURNED_ON_ELSEWHERE') return { action: 'RELEASE', where: null, label: 'Release', short: 'Release', sentence: verbSentence('RELEASE'), held: gate(r.actions.release), primary: false }
  return { action: 'TURN_ON', where: null, label: 'Turn on…', short: 'Turn on…', sentence: verbSentence('TURN_ON'), held: gate(r.actions.turnOn), primary: false }
}

// ── bulk ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A ticked row: the whole row when it is loaded, else only its id ("select all N that match" across pages). */
export type Picked<R> = R | { id: string }
const loaded = <R extends { id: string }>(p: Picked<R>): p is R => 'kind' in p
const ASIN_KEY = /^b0[a-z0-9]{8}$/i

/** A row id's kind when the row is not loaded: `kw:` ours, `term:` a shopper's, `neg:` a negative. */
export function idKind(id: string): 'kw' | 'term' | 'neg' | null {
  if (id.startsWith('kw:')) return 'kw'
  if (id.startsWith('term:')) return 'term'
  if (id.startsWith('neg:')) return 'neg'
  return null
}
/** A term row id's words (`term:<market>|<ad group>|<words>`). */
export function termOfId(id: string): string | null {
  if (!id.startsWith('term:')) return null
  const parts = id.slice(5).split('|')
  if (parts.length < 3) return null
  const raw = parts.slice(2).join('|')
  try { return decodeURIComponent(raw) } catch { return raw }
}
const isAsinRow = (p: Picked<WasteRow>) => (loaded(p) ? p.match === 'ASIN' || ASIN_KEY.test(p.text.trim()) : ASIN_KEY.test((termOfId(p.id) ?? '').trim()))

export type WasteBulk = 'pause' | 'negExact' | 'negPhrase' | 'negCampaign'
export const WASTE_BULK_LABEL: Readonly<Record<WasteBulk, string>> = {
  pause: 'Pause',
  negExact: 'Negative exact',
  negPhrase: 'Negative phrase',
  negCampaign: 'Negative · campaign',
}

export interface BulkPlan { items: WasteItem[]; left: Array<{ id: string; text: string; why: string }> }

const textOf = (p: Picked<WasteRow | StoppedRow>) => (loaded(p) ? p.text : termOfId(p.id) ?? p.id)

/** What a bulk verb sends for the ticked rows, and every row it leaves out with why. Pure. */
export function wasteBulkPlan(picked: ReadonlyArray<Picked<WasteRow>>, verb: WasteBulk): BulkPlan {
  const items: WasteItem[] = []
  const left: BulkPlan['left'] = []
  for (const p of picked) {
    const kind = loaded(p) ? (p.kind === 'TERM' ? 'term' : 'kw') : idKind(p.id)
    const leave = (why: string) => left.push({ id: p.id, text: textOf(p), why })
    if (loaded(p)) {
      const runs = p.state === 'RUNNING' || (verb === 'pause' && p.state === 'TURNED_ON_ELSEWHERE')
      if (!runs) { leave(p.state === 'PROTECTED' ? 'Protected: never negated' : p.state === 'TURNED_ON_ELSEWHERE' ? 'Turned on outside Nexus: pause it again' : `${stateWord(p.state)} already`); continue }
      // A keyword with a negative over it may be paused (audit N1); its verb's hold is the removal's, not the pause's.
      const clash = p.verb.action === 'REMOVE_NEGATIVE' || isOwnKeywordClash(p.clash)
      if (clash && verb !== 'pause') { leave('Our keyword is paused, never negated in its own ad group'); continue }
      if (!clash && p.verb.held) { leave(p.verb.held.reason || p.verb.held.label); continue }
    }
    if (verb === 'pause') {
      if (kind !== 'kw') { leave('A search term is negated, not paused'); continue }
      items.push({ rowId: p.id, action: 'PAUSE' })
      continue
    }
    if (kind !== 'term') { leave('Our keyword is paused, never negated in its own ad group'); continue }
    const asin = isAsinRow(p)
    if (verb === 'negExact') items.push({ rowId: p.id, action: asin ? 'NEGATE_ASIN' : 'NEGATE_EXACT', ...(asin ? {} : { where: 'adGroup' as const }) })
    else if (asin) leave(verb === 'negPhrase' ? 'A product is negated as a product target' : 'A product is negated in its ad group only')
    else items.push({ rowId: p.id, action: verb === 'negPhrase' ? 'NEGATE_PHRASE' : 'NEGATE_EXACT', where: verb === 'negCampaign' ? 'campaign' : 'adGroup' })
  }
  return { items, left }
}

/** How many ticked rows each wasting verb fits (the bulk buttons' counts). */
export function wasteBulkCounts(picked: ReadonlyArray<Picked<WasteRow>>): Record<WasteBulk, number> {
  return {
    pause: wasteBulkPlan(picked, 'pause').items.length,
    negExact: wasteBulkPlan(picked, 'negExact').items.length,
    negPhrase: wasteBulkPlan(picked, 'negPhrase').items.length,
    negCampaign: wasteBulkPlan(picked, 'negCampaign').items.length,
  }
}

export type StoppedBulk = 'turnOn' | 'remove' | 'release' | 'keepUntil'
export const STOPPED_BULK_LABEL: Readonly<Record<StoppedBulk, string>> = {
  turnOn: 'Turn on…',
  remove: 'Remove negative…',
  release: 'Release lock',
  keepUntil: 'Keep paused until…',
}

/** What a Stopped bulk verb sends; `keepUntil` (an ISO day) for Keep paused until…. Pure. */
export function stoppedBulkPlan(picked: ReadonlyArray<Picked<StoppedRow>>, verb: StoppedBulk, keepUntil?: string | null): BulkPlan {
  const items: WasteItem[] = []
  const left: BulkPlan['left'] = []
  for (const p of picked) {
    const leave = (why: string) => left.push({ id: p.id, text: textOf(p), why })
    const kind = idKind(p.id)
    if (verb === 'remove') {
      if (kind !== 'neg') { leave('Not a negative: turn it on instead'); continue }
      if (loaded(p) && !p.actions.removeNegative.allowed) { leave(p.actions.removeNegative.why); continue }
      items.push({ rowId: p.id, action: 'REMOVE_NEGATIVE' })
      continue
    }
    if (kind !== 'kw') { leave('A negative is removed, not turned on'); continue }
    if (verb === 'turnOn') {
      if (loaded(p) && !p.actions.turnOn.allowed) { leave(p.actions.turnOn.why); continue }
      items.push({ rowId: p.id, action: 'TURN_ON' })
    } else if (verb === 'release') {
      if (loaded(p) && !p.actions.release.allowed) { leave(p.actions.release.why); continue }
      items.push({ rowId: p.id, action: 'RELEASE' })
    } else {
      if (loaded(p) && p.state !== 'KEPT_PAUSED' && p.state !== 'PAUSED') { leave(`${stateWord(p.state)}: pause it first`); continue }
      // A paused keyword (kept or not): its lock's end, at most 30 d ahead, or Always (KEEP_UNTIL).
      items.push({ rowId: p.id, action: 'KEEP_UNTIL', keepUntil: keepUntil ?? null })
    }
  }
  return { items, left }
}

export function stoppedBulkCounts(picked: ReadonlyArray<Picked<StoppedRow>>): Record<StoppedBulk, number> {
  return {
    turnOn: stoppedBulkPlan(picked, 'turnOn').items.length,
    remove: stoppedBulkPlan(picked, 'remove').items.length,
    release: stoppedBulkPlan(picked, 'release').items.length,
    keepUntil: stoppedBulkPlan(picked, 'keepUntil').items.length,
  }
}

/** The ticked rows Skip fits (ours or a shopper's, running, not skipped) and Unskip fits (skipped). */
export function skipIds(picked: ReadonlyArray<Picked<WasteRow>>): { skip: string[]; unskip: string[] } {
  const skip: string[] = []
  const unskip: string[] = []
  for (const p of picked) {
    const k = idKind(p.id)
    if (k !== 'kw' && k !== 'term') continue
    if (loaded(p) && p.skipped) unskip.push(p.id)
    else if (!loaded(p) || p.state === 'RUNNING' || p.state === 'PROTECTED' || p.state === 'TURNED_ON_ELSEWHERE') skip.push(p.id)
  }
  return { skip, unskip }
}

/** The ticked rows that wait for a person, with the request each waits on. */
export interface Waiting {
  rowId: string
  approvalId: string
  text: string
  by: string
  what?: string
  place?: Array<Ref | null>
  /** How many places this one ask covers ("2 places"); absent = one. */
  places?: number
}
/** The asks behind the ticked rows: ONE per ask (an ask may cover several rows), with how many places it covers. */
export function waitingOf(rows: ReadonlyArray<Picked<WasteRow>>): Waiting[] {
  const out = new Map<string, Waiting>()
  const seen = new Map<string, number>()
  for (const r of rows) {
    if (!loaded(r) || !r.waiting) continue
    const n = (seen.get(r.waiting.approvalId) ?? 0) + 1
    seen.set(r.waiting.approvalId, n)
    const cur = out.get(r.waiting.approvalId)
    if (cur) { cur.places = Math.max(n, r.waiting.rows ?? 1); continue }
    out.set(r.waiting.approvalId, {
      rowId: r.id, approvalId: r.waiting.approvalId, text: r.text, by: r.waiting.by.name, places: Math.max(1, r.waiting.rows ?? 1),
      what: r.verb.action === 'REMOVE_NEGATIVE' ? undefined : verbLabel(r.verb.action, r.verb.action === 'PAUSE' ? null : r.verb.where), place: pathOf(r),
    })
  }
  return [...out.values()]
}

// ── the review ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where one previewed change lands, in one short note. */
export function landsWord(s: Pick<PreviewStep, 'lands' | 'refusal' | 'needsCode' | 'runsAt' | 'action' | 'final'>): string {
  if (s.refusal) return `Left out: ${s.refusal.label}`
  if (isFinal(s)) return 'Archived at Amazon — final, cannot come back'
  if (s.needsCode) return 'Needs your code'
  if (s.lands === 'amazon') return 'Sends to Amazon'
  if (s.lands === 'nexus') return 'Nexus only'
  if (s.lands === 'approval') return 'Waits for approval'
  return '—'
}

/** A removal that Amazon archives (it cannot come back): the server says `final`; an older answer, the action. */
export const isFinal = (s: Pick<PreviewStep, 'action' | 'final' | 'lands'>) => (s.final ?? (s.action === 'REMOVE_NEGATIVE' && s.lands !== 'nexus')) === true

/** The review's one line: the market, then how many go where, then how many are left out. */
export function previewSummary(steps: readonly PreviewStep[], market: string | null): string {
  const go = steps.filter((s) => !s.refusal)
  const count = (pred: (s: PreviewStep) => boolean) => go.filter(pred).length
  const parts = [
    market && market.toLowerCase() !== 'all' ? `Amazon ${market.toUpperCase()}` : 'Amazon',
    count((s) => s.lands === 'amazon' && !s.needsCode) ? `${count((s) => s.lands === 'amazon' && !s.needsCode)} to Amazon` : '',
    count((s) => s.lands === 'nexus') ? `${count((s) => s.lands === 'nexus')} Nexus only` : '',
    count((s) => s.needsCode) ? `${count((s) => s.needsCode)} ${count((s) => s.needsCode) === 1 ? 'needs' : 'need'} your code` : '',
    steps.length - go.length ? `${steps.length - go.length} left out` : '',
  ].filter(Boolean)
  return parts.join(' · ')
}

/** The step's "now" / "new" words: RUNNING → Running, KEPT_PAUSED → Kept paused, REMOVED → Removed. */
/** "Not kept": a paused keyword without the lock (the server's `from: null` for a Keep paused). */
export const NOT_KEPT = 'NOT_KEPT'
/** A kept-paused end: "Always" (none, or the server's 'ALWAYS'), its day ("10 Nov"), or "Paused" when it was not kept. */
export const keepWord = (iso: string | null | undefined) => (iso === NOT_KEPT ? 'Paused' : !iso || iso === 'ALWAYS' ? 'Always' : dayWords(iso))

export function stepStateWord(s: string | null): string {
  if (!s) return '—'
  if (s === 'REMOVED') return 'Removed'
  return (STATE as Record<string, string>)[s] ?? s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ')
}

/** A verb's family: the negatives (exact, phrase, product) are one ("Add 3 negatives"). */
const family = (a: WasteAction): string => (a.startsWith('NEGATE') ? 'NEGATE' : a)

/** The Save button: "Pause 2", "Add 3 negatives", "Remove 1 negative", "Keep 2 paused", "Send 3 changes". */
export function saveWords(steps: readonly PreviewStep[]): string {
  const go = steps.filter((s) => !s.refusal)
  const families = new Set(go.map((s) => family(s.action)))
  const n = go.length
  if (families.size === 1) {
    const f = [...families][0]
    if (f === 'PAUSE') return `Pause ${n}`
    if (f === 'TURN_ON') return `Turn on ${n}`
    if (f === 'REMOVE_NEGATIVE') return `Remove ${plural(n, 'negative')}`
    if (f === 'RELEASE') return `Release ${n}`
    if (f === 'NEGATE') return `Add ${plural(n, 'negative')}`
    if (f === 'KEEP_UNTIL') return `Keep ${n} paused`
  }
  return `Send ${plural(n, 'change')}`
}

/**
 * What Undo does, in words (it never just says "Undo"); null when there is no Undo: a removal is archived at Amazon and
 * cannot come back. `keepFrom`: the old ends a Keep paused put back.
 */
export function undoWords(actions: readonly WasteAction[], keepFrom: ReadonlyArray<string | null> = []): string | null {
  const n = actions.length
  if (!n) return null
  if (actions.includes('REMOVE_NEGATIVE')) return null
  const families = new Set(actions.map(family))
  if (families.size === 1) {
    const f = [...families][0]
    if (f === 'PAUSE') return `Undo: turn ${n} back on`
    if (f === 'NEGATE') return `Undo: remove ${plural(n, 'negative')}`
    if (f === 'TURN_ON') return `Undo: pause ${n} again`
    if (f === 'RELEASE') return `Undo: lock ${n} again`
    if (f === 'KEEP_UNTIL') {
      if (keepFrom.length && keepFrom.every((e) => e === NOT_KEPT)) return 'Undo: end the lock'
      const ends = new Set(keepFrom.map((e) => keepWord(e)))
      return ends.size === 1 && !keepFrom.includes(NOT_KEPT) ? `Undo: back to ${[...ends][0]}` : 'Undo: back to the old ends'
    }
  }
  return `Undo: put ${n} back`
}

/** The result of one step after Apply, from the apply answer's status and where the step lands. */
export function appliedWords(step: PreviewStep, answer: ApplyAnswer): { ok: boolean; words: string } {
  if (step.refusal) return { ok: false, words: `Left out: ${step.refusal.label}` }
  if (answer.status === 'waiting') return { ok: false, words: answer.approve?.error ? `Waiting: ${answer.approve.error}` : 'Waiting for approval' }
  if (answer.status !== 'applied' && answer.status !== 'queued') return { ok: false, words: answer.error ?? 'Not sent' }
  if (step.action === 'KEEP_UNTIL') return { ok: true, words: step.to && step.to !== 'ALWAYS' ? `Kept paused to ${keepWord(step.to)}` : 'Kept paused, always' }
  if (step.lands === 'nexus') return { ok: true, words: 'Saved in Nexus' }
  if (step.action === 'REMOVE_NEGATIVE') return { ok: true, words: answer.status === 'queued' ? 'Archiving at Amazon' : 'Archived at Amazon' }
  return { ok: true, words: answer.status === 'queued' ? 'Sending' : 'Sent' }
}

/** The Done screen's line: where the changes went (audit S1: never "Sent" for a change that stays in Nexus). */
export function doneLine(steps: readonly PreviewStep[], answer: ApplyAnswer): string | undefined {
  const go = steps.filter((s) => !s.refusal)
  if (answer.status === 'waiting') return `Waiting: ${answer.approve?.error ?? 'it needs an approval'}`
  const amazon = go.some((s) => s.lands === 'amazon' || s.lands === 'approval')
  if (answer.status === 'queued') return amazon ? 'Sends to Amazon in 20 s · Undo stops it' : 'Saved in Nexus: nothing is sent to Amazon'
  if (answer.status === 'applied') return amazon ? 'Sent to Amazon' : 'Saved in Nexus: nothing is sent to Amazon'
  return undefined
}

/** Is this text an ASIN (a product a shopper viewed)? */
export const isAsinText = (s: string) => ASIN_KEY.test(s.trim())

// ── the review: the tick, a Keep paused the server answers in its older form ─────────────────────────────────────────

/** The one tick's words: what the raised changes do (spend again; archived for good) — only what is true. */
export function ackWords(steps: readonly PreviewStep[]): string | undefined {
  const raised = steps.filter((s) => !s.refusal && (s.raise || isFinal(s)))
  if (!raised.length) return undefined
  const parts: string[] = []
  if (raised.some((s) => isFinal(s))) parts.push('Amazon archives a removed negative: it cannot come back')
  if (raised.some((s) => !isFinal(s))) parts.push('it lets these spend again')
  return `I understand ${parts.join(', and ')}.`
}

/**
 * The previewed steps as the review shows them. A Keep paused the server answered as an older Pause (it did not know
 * KEEP_UNTIL yet) reads as Keep paused, with the old and the new end.
 */
export function shownSteps(p: PreviewAnswer, a: { items: readonly WasteItem[]; keepFrom?: Record<string, string | null> }, legacy: boolean): PreviewStep[] {
  return p.steps.map((s, i) => {
    const item = a.items[i]
    if (item?.action === 'KEEP_UNTIL' && (legacy || s.action === 'KEEP_UNTIL')) {
      // The server's own ends (ISO, 'ALWAYS', or null = it was not kept); an older answer: the ask's.
      const from = !legacy && s.action === 'KEEP_UNTIL' ? s.from ?? NOT_KEPT : a.keepFrom?.[item.rowId] ?? NOT_KEPT
      const to = !legacy && s.action === 'KEEP_UNTIL' ? s.to ?? 'ALWAYS' : item.keepUntil ?? 'ALWAYS'
      return { ...s, action: 'KEEP_UNTIL', from, to, raise: false }
    }
    return s
  })
}

/** The server does not know KEEP_UNTIL yet: the same Keep paused as a Pause with its end (the older form). */
export const olderKeep = (items: readonly WasteItem[]): WasteItem[] => items.map((i) => (i.action === 'KEEP_UNTIL' ? { rowId: i.rowId, action: 'PAUSE', keepUntil: i.keepUntil ?? null } : i))
export const unknownAction = (e: unknown) => /KEEP_UNTIL|action[^a-z]*:?.*(enum|invalid|expected)/i.test(e instanceof Error ? e.message : String(e))

// ── tiles ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type TileId = 'wasting' | 'waiting' | 'kept' | 'blocked' | 'clashes'
export interface TileView { id: TileId; label: string; short: string; value: number | null; hint?: string; active: boolean; clickable: boolean; title: string }

/**
 * The five tiles. Each number comes from the read whose table it opens (Bid audit M1): Wasting and Waiting from the
 * Wasting view's read, Kept paused and Blocked from the Stopped view's read. Clashes has no list of its own yet (the
 * rows API has no clash filter): a plain tile, never a button that opens a different number.
 */
export function tilesOf(args: {
  waste: WasteTotals | null
  stopped: StoppedTotals | null
  view: View
  wastingShow: WastingShow
  stoppedShow: StoppedShow
  currency: string
}): TileView[] {
  const { waste, stopped, view, wastingShow, stoppedShow, currency } = args
  const hint = waste?.wasting ? spendHint(waste, currency) : null
  return [
    { id: 'wasting', label: 'Wasting', short: 'Wasting', value: waste?.wasting ?? null, hint: hint?.text, active: view === 'wasting' && wastingShow === 'wasting', clickable: true, title: hint?.note ?? 'Wasting now. The spend counts each euro once: search terms inside a wasting keyword are not added again' },
    { id: 'waiting', label: 'Waiting for you', short: 'Waiting', value: waste?.waiting ?? null, hint: waste?.waiting ? (waste.waiting === 1 ? 'ask' : 'asks') : undefined, active: view === 'wasting' && wastingShow === 'waiting', clickable: !!waste?.waiting, title: 'Asks waiting for your approval (one ask may cover several places)' },
    { id: 'kept', label: 'Kept paused', short: 'Kept paused', value: stopped?.kept ?? null, active: view === 'stopped' && stoppedShow === 'kept', clickable: !!stopped?.kept, title: 'Kept paused: no rule, Brain or plan turns them on' },
    { id: 'blocked', label: 'Blocked', short: 'Blocked', value: stopped?.negated ?? null, active: view === 'stopped' && stoppedShow === 'negated', clickable: !!stopped?.negated, title: 'Negatives that block now' },
    { id: 'clashes', label: 'Clashes', short: 'Clashes', value: waste?.clashes ?? null, active: view === 'wasting' && wastingShow === 'clashes', clickable: !!waste?.clashes, title: 'Clashes: turned on outside Nexus, a negative over our own keyword, a negative that blocks a term that sold' },
  ]
}

/**
 * The Wasting tile's money: one currency → its sum; several → the split ("€500.00 · £40.00"), never added up; none
 * shown → nothing. `note` is the server's reason when it split.
 */
export function spendHint(t: Pick<WasteTotals, 'wastingSpendCents' | 'currency' | 'wastingSpendByCurrency' | 'wastingSpendNote'>, fallbackCurrency: string): { text: string; note: string | null } | null {
  if (typeof t.wastingSpendCents === 'number') return { text: money(t.wastingSpendCents, t.currency ?? fallbackCurrency), note: null }
  const split = Object.entries(t.wastingSpendByCurrency ?? {}).filter(([, c]) => typeof c === 'number').sort(([a], [b]) => a.localeCompare(b))
  if (split.length > 1) return { text: split.map(([cur, c]) => money(c, cur)).join(' · '), note: t.wastingSpendNote ?? null }
  return null
}

/** Where a tile goes: its view and filter (pressing the tile that is on goes back to the view's default). */
export function tileQuery(id: TileId, active: boolean): Record<string, string | null> {
  const base = { row: null, tab: null, page: null }
  switch (id) {
    case 'wasting': return { ...base, view: null, show: null }
    case 'waiting': return { ...base, view: null, show: active ? null : 'waiting' }
    case 'kept': return { ...base, view: 'stopped', show: active ? null : 'kept' }
    case 'blocked': return { ...base, view: 'stopped', show: active ? null : 'negated' }
    case 'clashes': return { ...base, view: null, show: active ? null : 'clashes' }
    default: return {}
  }
}

/** The Stopped view's filter chips: their words and counts (the same read). */
export function stoppedChips(t: StoppedTotals | null): Array<{ id: StoppedShow; label: string; count: number | null; title: string }> {
  return [
    { id: 'all', label: 'All', count: t?.all ?? null, title: 'Everything stopped' },
    { id: 'kept', label: 'Kept paused', count: t?.kept ?? null, title: 'Kept paused: no rule, Brain or plan turns them on' },
    { id: 'negated', label: 'Blocked', count: t?.negated ?? null, title: 'Negatives that block now' },
    { id: 'turned-on', label: 'Turned on', count: t?.turnedOn ?? null, title: 'Kept paused, but turned on outside Nexus' },
    { id: 'still-bought', label: 'Still bought', count: t?.stillBought ?? null, title: 'Paused exact keywords whose words still spend in another ad group' },
  ]
}

// ── counts and empties ──────────────────────────────────────────────────────────────────────────────────────────────

/** The Waiting list's count in the tile's unit (audit N3): "4 asks · 5 places" — one ask may cover several places. */
export function waitingCount(asks: number | null | undefined, places: number): string {
  if (asks == null) return plural(places, 'row')
  return asks === places ? plural(asks, 'ask') : `${plural(asks, 'ask')} · ${plural(places, 'place')}`
}

/** The toolbar count: "14", "Showing 3 of 14" when a filter narrows the view's total. */
export const countText = (shown: number, total: number | null, narrowed: boolean): string =>
  narrowed && total != null && total !== shown ? `${shown} of ${total}` : String(shown)

/** The empty table's words: nothing at all vs. nothing under the filters (never an error: that is its own state). */
export function emptyWords(view: 'wasting' | 'stopped', show: string, filtered: boolean): { title: string; clear: boolean } {
  if (filtered) return { title: 'Nothing matches these filters', clear: true }
  if (view === 'stopped') return { title: show === 'all' ? 'Nothing stopped here' : 'None here', clear: show !== 'all' }
  if (show === 'clashes') return { title: 'No clashes', clear: true }
  if (show === 'turned-on') return { title: 'Nothing turned on outside Nexus', clear: true }
  if (show === 'waiting') return { title: 'Nothing waits for you', clear: true }
  if (show === 'skipped') return { title: 'Nothing skipped', clear: true }
  return { title: 'Nothing wasting', clear: false }
}

// ── the scope picker ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScopeOption { value: string; label: string; group: string }

/**
 * The scope picker's options, from the refs of the rows read so far (portfolio › campaign › ad group), each level its
 * group; a campaign's ad groups carry the campaign in the label. The scope on now is always an option.
 */
export function scopeOptions(seen: Iterable<{ portfolio: Ref | null; campaign: Ref | null; adGroup: Ref | null }>, current: Scope | null, currentLabel?: string | null): ScopeOption[] {
  const pf = new Map<string, string>()
  const cp = new Map<string, string>()
  const ag = new Map<string, string>()
  for (const r of seen) {
    if (r.portfolio) pf.set(r.portfolio.id, r.portfolio.name)
    if (r.campaign) cp.set(r.campaign.id, r.campaign.name)
    if (r.adGroup && r.campaign) ag.set(r.adGroup.id, `${r.adGroup.name} · ${r.campaign.name}`)
  }
  const sorted = (m: Map<string, string>) => [...m].sort((a, b) => a[1].localeCompare(b[1]))
  const out: ScopeOption[] = [
    ...sorted(pf).map(([id, name]) => ({ value: `pf:${id}`, label: name, group: 'Portfolio' })),
    ...sorted(cp).map(([id, name]) => ({ value: `cp:${id}`, label: name, group: 'Campaign' })),
    ...sorted(ag).map(([id, name]) => ({ value: `ag:${id}`, label: name, group: 'Ad group' })),
  ]
  const key = scopeKey(current)
  if (key && !out.some((o) => o.value === key)) {
    out.unshift({ value: key, label: currentLabel || current!.id, group: current!.level === 'pf' ? 'Portfolio' : current!.level === 'cp' ? 'Campaign' : 'Ad group' })
  }
  return out
}

// ── CSV ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const WASTE_CSV_HEADERS = ['Term', 'Kind', 'Match', 'Portfolio', 'Campaign', 'Ad group', 'Product', 'Spend', 'Clicks', 'Orders', '×CPA', 'Who', 'State', 'Verb'] as const
export function wasteCsvRow(r: WasteRow): string[] {
  const v = wasteVerb(r)
  return [
    r.text, isTerm(r) ? 'Search term' : r.kind === 'TARGET' ? 'Target' : 'Keyword', matchWord(r.match), r.portfolio?.name ?? '', r.campaign.name, r.adGroup.name,
    productWords(r), moneyOr(r.d?.spendCents, r.currency), String(r.d?.clicks ?? ''), String(r.d?.orders ?? ''), xCpaText(r.d?.xCpa),
    chipOwner(r.owner).hint, stateWord(r.state), v ? `${v.label}${v.held ? ' (held)' : ''}` : '',
  ]
}
export const STOPPED_CSV_HEADERS = ['Term', 'Kind', 'Match', 'Level', 'Portfolio', 'Campaign', 'Ad group', 'Product', 'Kept by', 'Since', 'Spend before', 'State'] as const
export function stoppedCsvRow(r: StoppedRow): string[] {
  return [
    r.text, isTerm(r) ? 'Negative' : r.kind === 'TARGET' ? 'Target' : 'Keyword', matchWord(r.match), r.level === 'CAMPAIGN' ? 'Campaign' : r.level === 'AD_GROUP' ? 'Ad group' : '',
    r.portfolio?.name ?? '', r.campaign.name, r.adGroup?.name ?? '', productWords(r), chipOwner(r.owner).hint, r.since ?? '', moneyOr(r.spendBeforeCents, r.currency), stateWord(r.state),
  ]
}
