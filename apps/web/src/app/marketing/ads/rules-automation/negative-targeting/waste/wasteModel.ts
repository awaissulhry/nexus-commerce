/**
 * Negative Targeting page (2026-10-11, lane NVIEW) — the page's words and rules, pure and tested in Node
 * (`wasteModel.vitest.test.ts`). The components only draw what these say.
 *
 *   address   ?market= · ?view=wasting|stopped|words|rules · ?show=<tile filter> · ?kind= · ?q= · ?sort= · ?page=
 *             · ?row=<row id>&tab=overview|where|history; the page's filter bar `?portfolio=&campaign=&adGroup=&product=`
 *             (`_shared/scopeFilter`, read here as `lists`)
 *   verbs     our keyword or target → Pause (kept paused); a shopper's search term → Negative exact / phrase, in the ad
 *             group or the whole campaign; a shopper's ASIN → Negative product. A row whose verb the server holds keeps
 *             it on screen, held, with the server's reason. Stopped rows: Turn on… · Remove negative… · Release lock ·
 *             Keep paused until…, each allowed or held by the server's own gate.
 *   bulk      a verb counts the ticked rows it fits; the rest are left out, each with why (never silently).
 *   review    the server's preview (`POST /waste/preview`) in the review's words: where it lands, what is left out.
 */
import { CHANGE_STATE_TONE, CHANGE_STATE_WORD, type ChangeState, type ChangeTone } from '../../bid/_shared/delivery'
import { dayWords, money, relWords } from '../../bid/_shared/format'
import { addApiParams, type ScopeApi } from '../../_shared/scopeFilter/scopeFilterModel'
import { MARKET_NAME } from '../../../_shell/adsMarkets'
import type {
  ActionGate, ApplyAnswer, Delivery, HistoryAction, Match, Owner, PreviewAnswer, PreviewStep, Reach, ReachTotal, Ref, RowKind, RowState, StoppedRow, StoppedState,
  StoppedTotals, VerbAction, WaitingSteps, WasteAction, WasteCriteria, WasteFreshness, WasteItem, WasteRow, WasteTotals, Where,
} from './wasteTypes'

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// ── the address ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const VIEWS = ['wasting', 'stopped', 'words', 'rules'] as const
export type View = (typeof VIEWS)[number]
export const viewOf = (v: string | null | undefined): View => ((VIEWS as readonly string[]).includes(v ?? '') ? v as View : 'wasting')

export const WASTING_SHOWS = ['wasting', 'waiting', 'skipped', 'turned-on', 'clashes', 'protected', 'all'] as const
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

/** The grid's columns that the server can order by, and the key it takes. */
export const SORT_KEY: Readonly<Record<string, string>> = {
  term: 'text', where: 'where', product: 'product', spend: 'spend', clicks: 'clicks', orders: 'orders', xCpa: 'xCpa', owner: 'owner', state: 'state',
  // The Stopped view's own columns (the server orders it too: `?sort=`).
  since: 'since', spendBefore: 'spendBefore', saved: 'saved', stillServes: 'stillServes',
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
const VIEW_SORTS: Readonly<Record<'wasting' | 'stopped', ReadonlySet<string>>> = {
  wasting: new Set(['text', 'where', 'product', 'spend', 'clicks', 'orders', 'xCpa', 'owner', 'state']),
  stopped: new Set(['text', 'where', 'product', 'owner', 'since', 'spendBefore', 'saved', 'state', 'stillServes']),
}
/** The address's sort when this view's server orders by it; else none (the view's own default). */
export const viewSort = (view: 'wasting' | 'stopped', sort: string | null | undefined): string | null =>
  sort && VIEW_SORTS[view].has(sort.replace(/^-/, '')) ? sort : null

export const sortParam = (s: { colId: string; dir: 'asc' | 'desc' } | null): string | null =>
  s && SORT_KEY[s.colId] ? `${s.dir === 'desc' ? '-' : ''}${SORT_KEY[s.colId]}` : null

export const PAGE_SIZES = [50, 100, 200] as const
export const DEFAULT_PAGE_SIZE = 50

export interface ListQuery {
  market: string | null
  /** The page's filter bar: `portfolioIds`, `campaignIds`, `adGroupIds`, `productIds` (lists; OR inside, AND across). */
  lists?: ScopeApi | null
  kind: KindFilter
  show: string
  q: string
  sort?: string | null
  page?: number
  pageSize?: number
}

/** The query string of a list read (rows, rows/ids, stopped). Empty values are left out; 'all' markets = no market. */
export function listSearch(q: ListQuery): string {
  const p = new URLSearchParams()
  const m = (q.market ?? '').trim()
  if (m && m.toLowerCase() !== 'all') p.set('market', m.toUpperCase())
  addApiParams(p, q.lists)
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
export function stateSentence(r: { state: AnyState; match?: Match; level?: 'AD_GROUP' | 'CAMPAIGN' | null; keptPaused?: StoppedRow['keptPaused']; protection?: WasteRow['protection'] }): string {
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
  if (r.state === 'PROTECTED') {
    const t = r.protection?.terms ?? []
    return t.length ? `Protected by "${t[0].term}"${t.length > 1 ? ` and ${plural(t.length - 1, 'more term')}` : ''}: never negated` : 'Protected: never negated'
  }
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
  UNPROTECT: 'Remove protection',
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
    case 'UNPROTECT': return 'Remove the protected term: rules, the Brain and Claude may then stop what it kept safe'
  }
}

/**
 * NFIX — a stopped row's "Since" as the page shows it: the day, or "—" when it is not known; `hint` says how it is known
 * or why not (the cell's hover, the record's note). A kept-paused keyword's hint is its lock's end.
 */
export function sinceView(r: Pick<StoppedRow, 'since' | 'sinceWhy' | 'keptPaused'>): { text: string; hint: string | undefined } {
  const until = r.keptPaused?.until
  const hint = until ? `Kept paused until ${dayWords(until)}` : r.keptPaused ? 'Kept paused, always' : r.sinceWhy ?? (r.since ? undefined : 'Not on record')
  return { text: dayWords(r.since), hint }
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

/** Every verb of the page is held, with this reason, for a person who may see ads but not change them: the rows' verbs,
 *  the bulk bars and the records' footers say the same. */
export const NO_WRITE = 'You can see ads here, not change them'
export const writeHeld = (canWrite: boolean): string | null => (canWrite ? null : NO_WRITE)

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
  /** Step 4 — the verb opens the row's record (a protected row: Keep protected, or Remove protection and stop there). */
  opens?: boolean
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

/** A wasting row's verb: only a row that runs (or a protected one: its record) has one. Null = nothing to do here. */
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
  // Step 4 — a protected row's two actions (Keep protected · Remove protection and stop) are in its record: the verb opens it.
  if (r.state === 'PROTECTED') {
    return { action, where: null, label: 'Protected…', short: 'Protected…', sentence: 'A protected term keeps it safe: keep it protected, or remove the protection and stop it', held: null, primary: false, opens: true }
  }
  const where = action === 'PAUSE' || action === 'NEGATE_ASIN' ? null : r.verb.where
  const held = heldOf(r.verb)
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
      // A clash row's Remove is not what its ask does (the ask pauses it); a row listed for its ask has the ask's verb.
      what: r.verb.action === 'REMOVE_NEGATIVE' && !r.askOnly ? undefined : verbLabel(r.verb.action, r.verb.action === 'PAUSE' || r.verb.action === 'REMOVE_NEGATIVE' ? null : r.verb.where), place: pathOf(r),
    })
  }
  return [...out.values()]
}

/** NFIX — an ask that is a change plan, in words: "Plan · 2 steps (1 not on this page)"; null for a single request. */
export function planWords(plan: { steps: number; offPage: number } | null | undefined): string | null {
  if (!plan) return null
  return `Plan · ${plural(plan.steps, 'step')}${plan.offPage ? ` (${plan.offPage} not on this page)` : ''}`
}

/**
 * NFIX — the decide review's lines: one per change each request makes. A request that is one change on this page reads
 * as the row did (its words, its place); a change plan — or a request holding a change this page does not show — lists
 * EVERY step's every change (what, where, from → to), each noted as decided together with the rest of its request: the
 * approvals service approves or rejects a request whole (no approve-one-step). `steps` null for a request: not read
 * (a rule's card has none to read: it is one change).
 */
export interface DecideLine {
  id: string
  approvalId: string
  what: string
  /** The row's place (a single change), or the step's own place (a link). */
  place?: Array<Ref | null>
  whereLink?: { name: string; href: string | null }
  now: string
  next: string
  note?: string
  /** A change this page does not show (a bid, a price …) that runs with the rest of its request. */
  offPage?: boolean
}
export function decideLines(waits: readonly Waiting[], steps: ReadonlyMap<string, WaitingSteps | null>, decide: 'approve' | 'reject'): DecideLine[] {
  const done = decide === 'approve' ? 'Approved' : 'Rejected'
  const together = decide === 'approve' ? 'Approved together' : 'Rejected together'
  const out: DecideLine[] = []
  for (const w of waits) {
    const s = steps.get(w.approvalId) ?? null
    const single = !s || (!s.plan && s.steps.length <= 1 && s.offPage === 0)
    if (single) {
      out.push({ id: w.approvalId, approvalId: w.approvalId, what: w.what ? `${w.what} · ${w.text}` : w.text, place: w.place, now: `Waiting · ${w.by}`, next: done, note: (w.places ?? 1) > 1 ? `${w.places} places` : undefined })
      continue
    }
    const of = `${together} · ${plural(s.steps.length, 'step')} · ${w.by}`
    for (const step of s.steps) {
      const note = `${of}${step.onPage ? '' : ' · not on this page'}`
      const base = { approvalId: w.approvalId, whereLink: step.where ?? undefined, offPage: !step.onPage || undefined }
      if (step.hidden || !step.changes.length) {
        out.push({ ...base, id: `${w.approvalId}#${step.step}`, what: step.summary && !step.hidden ? `${step.words} · ${step.summary}` : step.words, now: '—', next: done, note: step.hidden ? `${note} · ${step.hidden}` : note })
        continue
      }
      step.changes.forEach((c, i) => out.push({ ...base, id: `${w.approvalId}#${step.step}.${i}`, what: `${step.words} · ${c.label}`, now: c.from ?? '—', next: c.to ?? done, note }))
      const more = step.changeCount - step.changes.length
      if (more > 0) out.push({ ...base, id: `${w.approvalId}#${step.step}.more`, what: `${step.words} · and ${plural(more, 'more change')}`, now: '—', next: done, note })
    }
  }
  return out
}

/** The decide review's summary: what is decided whole, and how many changes are not on this page. */
export function decideSummary(waits: readonly Waiting[], steps: ReadonlyMap<string, WaitingSteps | null>, decide: 'approve' | 'reject'): string | null {
  const plans = waits.map((w) => steps.get(w.approvalId)).filter((s): s is WaitingSteps => !!s && (s.plan || s.steps.length > 1 || s.offPage > 0))
  if (!plans.length) return null
  const off = plans.reduce((n, s) => n + s.offPage, 0)
  const verb = decide === 'approve' ? 'approved' : 'rejected'
  return `${plans.length === 1 ? 'This request' : `${plans.length} requests`} ${plans.length === 1 ? 'is' : 'are'} ${verb} whole: every step below ${decide === 'approve' ? 'runs' : 'is dropped'} together${off ? `, ${plural(off, 'step')} not on this page included` : ''}.`
}

// ── the review ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where one previewed change lands, in one short note. */
export function landsWord(s: Pick<PreviewStep, 'lands' | 'refusal' | 'needsCode' | 'runsAt' | 'action' | 'final' | 'after'>): string {
  if (s.refusal) return `Left out: ${s.refusal.label}`
  // Step 4 — a negative of a protected term goes once its protection is removed (its tool refuses it before).
  if (s.after) return s.lands === 'amazon' ? 'Sends to Amazon once the protection is removed' : 'Nexus only, once the protection is removed'
  if (isFinal(s)) return 'Archived at Amazon — final, cannot come back'
  if (s.needsCode) return 'Needs your code'
  if (s.lands === 'amazon') return 'Sends to Amazon'
  if (s.lands === 'nexus') return 'Nexus only'
  if (s.lands === 'approval') return 'Waits for approval'
  return '—'
}

/** A removal that Amazon archives (it cannot come back): the server says `final`; an older answer, the action. */
export const isFinal = (s: Pick<PreviewStep, 'action' | 'final' | 'lands'>) => (s.final ?? (s.action === 'REMOVE_NEGATIVE' && s.lands !== 'nexus')) === true

/**
 * The review's one line: the market, then how many go where, then how many are left out — the steps the server leaves
 * out and the ticked rows a bulk verb left out before it asked (`leftRows`), one count for the Wasting and Words views.
 */
export function previewSummary(steps: readonly PreviewStep[], market: string | null, leftRows = 0): string {
  const go = steps.filter((s) => !s.refusal)
  const count = (pred: (s: PreviewStep) => boolean) => go.filter(pred).length
  const parts = [
    market && market.toLowerCase() !== 'all' ? `Amazon ${market.toUpperCase()}` : 'Amazon',
    count((s) => s.lands === 'amazon' && !s.needsCode) ? `${count((s) => s.lands === 'amazon' && !s.needsCode)} to Amazon` : '',
    count((s) => s.lands === 'nexus') ? `${count((s) => s.lands === 'nexus')} Nexus only` : '',
    count((s) => s.needsCode) ? `${count((s) => s.needsCode)} ${count((s) => s.needsCode) === 1 ? 'needs' : 'need'} your code` : '',
    steps.length - go.length + leftRows ? `${steps.length - go.length + leftRows} left out` : '',
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

/** Step 4 — "Remove protection and pause", "Remove 2 protections and add a negative", "Remove 2 protections and stop 3". */
function unprotectSaveWords(go: readonly PreviewStep[]): string {
  const n = go.filter((s) => s.action === 'UNPROTECT').length
  const stops = go.filter((s) => s.action !== 'UNPROTECT')
  const head = n === 1 ? 'Remove protection' : `Remove ${plural(n, 'protection')}`
  if (!stops.length) return head
  if (stops.length > 1) return `${head} and stop ${stops.length}`
  const stop = stops[0]
  return `${head} and ${stop.action === 'PAUSE' ? 'pause' : stop.action.startsWith('NEGATE') ? 'add a negative' : verbLabel(stop.action).toLowerCase()}`
}

/** The Save button: "Pause 2", "Add 3 negatives", "Remove 1 negative", "Keep 2 paused", "Send 3 changes". */
export function saveWords(steps: readonly PreviewStep[]): string {
  const go = steps.filter((s) => !s.refusal)
  if (go.some((s) => s.action === 'UNPROTECT')) return unprotectSaveWords(go)
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
  // Step 4 — the protection goes back, and the stop is undone with it.
  if (actions.includes('UNPROTECT')) {
    const stop = actions.find((a) => a !== 'UNPROTECT')
    return `Undo: protect again${stop === 'PAUSE' ? ' and turn back on' : stop?.startsWith('NEGATE') ? ' and remove the negative' : ''}`
  }
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
  // Step 4 — the removal runs after the undo window; a negative of its term waits for it.
  if (step.action === 'UNPROTECT') return { ok: true, words: answer.status === 'queued' ? 'Removes in 20 s' : 'Protection removed' }
  if (step.after) return { ok: true, words: 'Waits for the removal' }
  if (step.lands === 'nexus') return { ok: true, words: 'Saved in Nexus' }
  if (step.action === 'REMOVE_NEGATIVE') return { ok: true, words: answer.status === 'queued' ? 'Archiving at Amazon' : 'Archived at Amazon' }
  return { ok: true, words: answer.status === 'queued' ? 'Sending' : 'Sent' }
}

/** The Done screen's line: where the changes went (audit S1: never "Sent" for a change that stays in Nexus). */
export function doneLine(steps: ReadonlyArray<Pick<PreviewStep, 'refusal' | 'lands'>>, answer: Pick<ApplyAnswer, 'status' | 'approve'>): string | undefined {
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
  // Step 4 — a removed protection lets every writer stop what it kept safe.
  if (raised.some((s) => s.action === 'UNPROTECT')) parts.push('without the protection, rules, the Brain and Claude may stop what it kept safe')
  if (raised.some((s) => !isFinal(s) && s.action !== 'UNPROTECT')) parts.push('it lets these spend again')
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

export type TileId = 'wasting' | 'waiting' | 'kept' | 'blocked' | 'clashes' | 'protected'
export interface TileView { id: TileId; label: string; short: string; value: number | null; hint?: string; active: boolean; clickable: boolean; title: string }

/**
 * The six tiles. Each number comes from the read whose table it opens (Bid audit M1): Wasting, Waiting, Clashes and
 * Protected (step 4: wasting rows a protected term keeps safe, show=protected) from the Wasting view's read, Kept paused
 * and Blocked from the Stopped view's read. A tile with nothing to list is a plain tile.
 */
export function tilesOf(args: {
  waste: WasteTotals | null
  stopped: StoppedTotals | null
  view: View
  wastingShow: WastingShow
  stoppedShow: StoppedShow
  currency: string
  /** The redesign (D3): the page's window ("€754.50 in 60 days"), from the server's criteria; absent = the money only. */
  windowDays?: number | null
}): TileView[] {
  const { waste, stopped, view, wastingShow, stoppedShow, currency, windowDays } = args
  const hint = waste?.wasting ? spendHint(waste, currency) : null
  // D3 — every tile has a hint line, so the six are one height: the money and its window, the asks, else a short form of
  // the tile's own title.
  const spend = hint ? `${hint.text}${windowDays ? ` in ${windowDays} days` : ''}` : 'wasting now'
  return [
    { id: 'wasting', label: 'Wasting', short: 'Wasting', value: waste?.wasting ?? null, hint: spend, active: view === 'wasting' && wastingShow === 'wasting', clickable: true, title: hint?.note ?? 'Wasting now. The spend counts each euro once: search terms inside a wasting keyword are not added again' },
    { id: 'waiting', label: 'Waiting for you', short: 'Waiting', value: waste?.waiting ?? null, hint: typeof waste?.waiting === 'number' ? plural(waste.waiting, 'ask') : 'waiting for your approval', active: view === 'wasting' && wastingShow === 'waiting', clickable: !!waste?.waiting, title: 'Asks waiting for your approval (one ask may cover several places)' },
    { id: 'kept', label: 'Kept paused', short: 'Kept paused', value: stopped?.kept ?? null, hint: 'nothing turns them on', active: view === 'stopped' && stoppedShow === 'kept', clickable: !!stopped?.kept, title: 'Kept paused: no rule, Brain or plan turns them on' },
    { id: 'blocked', label: 'Blocked', short: 'Blocked', value: stopped?.negated ?? null, hint: 'negatives that block now', active: view === 'stopped' && stoppedShow === 'negated', clickable: !!stopped?.negated, title: 'Negatives that block now' },
    { id: 'clashes', label: 'Clashes', short: 'Clashes', value: waste?.clashes ?? null, hint: 'need a look', active: view === 'wasting' && wastingShow === 'clashes', clickable: !!waste?.clashes, title: 'Clashes: turned on outside Nexus, a negative over our own keyword, a negative that blocks a term that sold' },
    { id: 'protected', label: 'Protected', short: 'Protected', value: waste?.protected ?? null, hint: 'kept safe by a term', active: view === 'wasting' && wastingShow === 'protected', clickable: !!waste?.protected, title: 'Wasting, but a protected term keeps it safe: keep it protected, or remove the protection and stop it' },
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
    case 'protected': return { ...base, view: null, show: active ? null : 'protected' }
    default: return {}
  }
}

/** The Wasting view's Show picks: their words and counts (the same read; Waiting counts asks, as its tile does). */
export function wastingChips(t: WasteTotals | null): Array<{ id: WastingShow; label: string; count: number | null; title: string }> {
  return [
    { id: 'wasting', label: 'Wasting', count: t?.wasting ?? null, title: 'Wasting now' },
    { id: 'waiting', label: 'Waiting', count: t?.waiting ?? null, title: 'Waiting for you' },
    { id: 'skipped', label: 'Skipped', count: t?.skipped ?? null, title: 'Skipped for now' },
    { id: 'turned-on', label: 'Turned on', count: t?.turnedOn ?? null, title: 'Kept paused, but turned on outside Nexus' },
    { id: 'clashes', label: 'Clashes', count: t?.clashes ?? null, title: 'Clashes the Owner should see' },
    { id: 'protected', label: 'Protected', count: t?.protected ?? null, title: 'Wasting, but a protected term keeps it safe' },
    { id: 'all', label: 'All', count: null, title: 'Every keyword and search term with numbers' },
  ]
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
  if (show === 'protected') return { title: 'Nothing wasting is protected', clear: true }
  return { title: 'Nothing wasting', clear: false }
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
export const STOPPED_CSV_HEADERS = ['Term', 'Kind', 'Match', 'Level', 'Portfolio', 'Campaign', 'Ad group', 'Product', 'Kept by', 'Since', 'Spend before', 'Saved', 'State'] as const
export function stoppedCsvRow(r: StoppedRow): string[] {
  return [
    r.text, isTerm(r) ? 'Negative' : r.kind === 'TARGET' ? 'Target' : 'Keyword', matchWord(r.match), r.level === 'CAMPAIGN' ? 'Campaign' : r.level === 'AD_GROUP' ? 'Ad group' : '',
    r.portfolio?.name ?? '', r.campaign.name, r.adGroup?.name ?? '', productWords(r), chipOwner(r.owner).hint, r.since ?? '', moneyOr(r.spendBeforeCents, r.currency), savedView(r).text, stateWord(r.state),
  ]
}

// ── step 4: what a negative blocks (the review), what a stop saved (the Stopped view) ─────────────────

const hasMoney = (c: number | null | undefined): c is number => typeof c === 'number' && Number.isFinite(c)
/** "−€3.00" for a saving below 0 (a real minus sign): it spends more than before, never hidden. */
const savedMoney = (cents: number, currency: string) => (cents < 0 ? `−${money(-cents, currency)}` : money(cents, currency))

/** One step's line in the review: "Blocks 14 terms · €32.00 · 0 orders" (no money without ad spend). */
export function reachLine(r: Reach): string {
  if (!r.terms) return 'Blocks no term seen here'
  return [`Blocks ${plural(r.terms, 'term')}`, hasMoney(r.spendCents) ? money(r.spendCents, r.currency) : null, plural(r.orders, 'order')].filter(Boolean).join(' · ')
}

/** The review's total line: the sent steps together, each term once; money per currency, never added across them. */
export function reachTotalLine(t: ReachTotal): string {
  const spend = t.currency && hasMoney(t.spendCents) ? money(t.spendCents, t.currency)
    : t.currencies.every((c) => hasMoney(c.spendCents)) && t.currencies.length ? t.currencies.map((c) => money(c.spendCents!, c.currency)).join(' + ') : null
  return [`Together: blocks ${plural(t.terms, 'term')}`, spend, plural(t.orders, 'order')].filter(Boolean).join(' · ')
}

/** "Shows the last 60 days" — said once in the review (each market's own when they differ). */
export const reachWindowWords = (days: number | null | undefined) => (days ? `Shows the last ${days} days` : 'Shows each market\'s own window')

export interface SoldItem { key: string; text: string; orders: number; where: string; leftOut: boolean }

/** The terms that sold a review's negatives would block, once per place, those that are sent first. */
export function soldItems(steps: readonly PreviewStep[]): SoldItem[] {
  const out = new Map<string, SoldItem>()
  for (const s of steps) {
    if (!s.reach?.sold.length) continue
    const whole = s.level === 'CAMPAIGN' || !s.place.adGroup
    const where = [s.place.campaign?.name, whole ? 'whole campaign' : s.place.adGroup?.name].filter(Boolean).join(whole ? ' · ' : ' › ')
    for (const t of s.reach.sold) {
      const key = `${s.place.campaign?.id ?? ''}|${whole ? '*' : s.place.adGroup?.id ?? ''}|${t.text.toLowerCase()}`
      const had = out.get(key)
      if (!had || (had.leftOut && !s.refusal)) out.set(key, { key, text: t.text, orders: t.orders, where, leftOut: !!s.refusal })
    }
  }
  return [...out.values()].sort((a, b) => Number(a.leftOut) - Number(b.leftOut) || b.orders - a.orders || a.text.localeCompare(b.text))
}

/**
 * The terms that sold, in two notes: red (`danger`) only for those a sent step blocks; a calm one (`calm`) for those whose
 * negative is left out, so nothing that sold is blocked there. Null where a note has nothing to say.
 */
export function soldNotes(items: readonly SoldItem[]): { danger: { title: string; items: SoldItem[] } | null; calm: { title: string; items: SoldItem[] } | null } {
  const sent = items.filter((i) => !i.leftOut)
  const left = items.filter((i) => i.leftOut)
  return {
    danger: sent.length ? { title: `Blocks ${plural(sent.length, 'term')} that sold`, items: sent } : null,
    calm: left.length ? { title: `Not blocked: ${plural(left.length, 'term')} that sold — left out`, items: left } : null,
  }
}

/** The total line only for two negatives or more sent (one step's own line says it already). */
export const showsTogether = (steps: readonly PreviewStep[]) => steps.filter((s) => s.reach && !s.refusal).length > 1

/** The Stopped view's "Saved" cell: the money saved since the stop, "Too early" under 14 days, a dash when not known. */
export function savedView(r: Pick<StoppedRow, 'since' | 'effect' | 'currency'>): { text: string; tone: 'ok' | 'warn' | 'muted'; hint: string; cents: number | null } {
  const e = r.effect
  if (!e) return { text: '—', tone: 'muted', hint: r.since ? 'Not known: the days before it stopped are older than Nexus keeps' : 'Not known: when it stopped is not on record', cents: null }
  if (e.verdict === 'TOO_EARLY') return { text: 'Too early', tone: 'muted', hint: e.words, cents: null }
  if (!hasMoney(e.savedCents)) return { text: '—', tone: 'muted', hint: e.words, cents: null }
  return { text: savedMoney(e.savedCents, r.currency), tone: e.verdict === 'STILL_SPENDS' ? 'warn' : e.savedCents > 0 ? 'ok' : 'muted', hint: e.words, cents: e.savedCents }
}

/** The record's "Did it work?" line: the saving, then before and after; its words below. */
export function effectLine(r: Pick<StoppedRow, 'since' | 'effect' | 'currency'>): { value: string; hint: string } {
  const v = savedView(r)
  const e = r.effect
  if (!e || e.verdict === 'TOO_EARLY' || v.cents == null) return { value: v.text, hint: v.hint }
  const parts = [`Saved ${v.text}`, hasMoney(e.beforePerDayCents) ? `before ${money(e.beforePerDayCents, r.currency)} a day` : null, hasMoney(e.afterCents) ? `after ${money(e.afterCents, r.currency)}` : null]
  return { value: parts.filter(Boolean).join(' · '), hint: e.words }
}

// ── the redesign (2026-10-26, BRIEF D2–D8, D12, D13): the frame's words, the state chips, the rows' ⋯ ────────────────

/**
 * D2 — the header's one live line, from what the reads give: the market, what the page does, the search terms' last
 * day and when Nexus read them ("Amazon Italy · stops ads that spend with no orders · search terms to 24 Oct · checked
 * 6 min ago"). A part no read gives is left out, never guessed.
 */
export function headerLine(a: { market: string | null | undefined; freshness?: Pick<WasteFreshness, 'searchTermsThrough' | 'readAt'> | null; now?: number }): string {
  const code = (a.market ?? '').trim().toUpperCase()
  const checked = a.freshness?.readAt ? relWords(a.freshness.readAt, a.now) : '—'
  return [
    code && code !== 'ALL' ? `Amazon ${MARKET_NAME[code] ?? code}` : 'Amazon, all markets',
    'stops ads that spend with no orders',
    a.freshness?.searchTermsThrough ? `search terms to ${dayWords(a.freshness.searchTermsThrough)}` : null,
    checked !== '—' ? `checked ${checked}` : null,
  ].filter(Boolean).join(' · ')
}

/** D4 — the Kind field's words (the brief's; the toolbar's icons named them "Keywords: ours" / "Search terms: shoppers'"). */
export const KIND_WORDS: Readonly<Record<KindFilter, string>> = { all: 'All', keyword: 'Our keywords and targets', term: 'Search terms' }

/** D4 — how many of the view's own fields in the filter bar filter now (Kind, Show off its default). */
export function ownFilterCount(view: 'wasting' | 'stopped', kind: KindFilter, show: string): number {
  return (kind !== 'all' ? 1 : 0) + (show !== (view === 'wasting' ? 'wasting' : 'all') ? 1 : 0)
}

/** One bold number and the words after it: "9" + " rows". */
export interface CountPart { n: string; words: string }

/**
 * D5 — the toolbar's count in the code's units: "9 rows · €754.50" (the money only when the rows are exactly what it
 * counts: Show Wasting, every kind, the same number of rows as the tile), "2 asks · 3 places" (Waiting counts asks, as
 * its tile does), "59 rows".
 */
export function toolbarCount(a: { view: 'wasting' | 'stopped'; show: string; kind: KindFilter; total: number; totals: WasteTotals | StoppedTotals | null; currency: string }): CountPart[] {
  const rows: CountPart = { n: String(a.total), words: a.total === 1 ? ' row' : ' rows' }
  if (a.view !== 'wasting' || !a.totals || !('wasting' in a.totals)) return [rows]
  const t = a.totals
  if (a.show === 'waiting' && typeof t.waiting === 'number') {
    const asks: CountPart = { n: String(t.waiting), words: t.waiting === 1 ? ' ask' : ' asks' }
    return t.waiting === a.total ? [asks] : [asks, { n: String(a.total), words: a.total === 1 ? ' place' : ' places' }]
  }
  if (a.show === 'wasting' && a.kind === 'all' && a.total === t.wasting) {
    const spend = spendHint(t, a.currency)
    if (spend) return [rows, { n: spend.text, words: '' }]
  }
  return [rows]
}

/** D5 — while rows are ticked the count says how many: "3 ticked". */
export const tickedCount = (n: number): CountPart[] => [{ n: String(n), words: ' ticked' }]

/** D7 — the pager's line, always shown: "1–9 of 9", "51–59 of 59", "0 of 0". */
export function pagerWords(page: number, pageSize: number, total: number): string {
  if (!(total > 0)) return '0 of 0'
  const from = Math.min((Math.max(1, page) - 1) * pageSize + 1, total)
  return `${from}–${Math.min(from + pageSize - 1, total)} of ${total}`
}

/** The Stopped view's money columns in the code's words (their header hovers; the note under the card says the same). */
export const SPEND_BEFORE_WORDS = 'Spend in the 30 days before it stopped'
export const SAVED_WORDS = 'Did it work? Its spend a day before the stop × the days since, minus what it spent since (to 3 days ago). Too early: the first 14 days'

/**
 * D8 — the one note under the card, only in the code's own words: the Wasting view's test as the server words it
 * (`criteria.sentence`: the window, the days its numbers reach, the bar); the Stopped view's two money columns. Null when
 * the read did not say (nothing is made up in its place).
 */
export function noteLine(view: 'wasting' | 'stopped', criteria: Pick<WasteCriteria, 'sentence'> | null | undefined): string | null {
  if (view === 'stopped') {
    return 'Spend before: spend in the 30 days before it stopped · Saved (did it work?): its spend a day before the stop × the days since, minus what it spent since (to 3 days ago) · Too early: the first 14 days'
  }
  return criteria?.sentence?.trim() || null
}

/** A chip's tone (the DS Pill tones). */
export type ChipTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
/** The mark a chip or its second line draws (marks.tsx). */
export type ChipMark = 'play' | 'pause' | 'ban' | 'shield' | 'hourglass' | 'alert' | 'cloud' | 'clock' | 'warn'
export interface StateChipView { word: string; tone: ChipTone; mark: ChipMark; title: string }
/** The smaller line under a chip: a clash (red), Remove protection and stop still finishing (or refused), a skip. */
export interface StateSubView { word: string; tone: 'danger' | 'muted'; mark: ChipMark }

/** Who asked, as the chip says it: a rule's card (`suggestion:<id>`, as useWasteReview reads it) is "Rule" — its name
 *  is in the hover; anyone else by the name the server gives (Brain, Claude, You). */
export const askerWord = (w: { approvalId: string; by: { name: string } }): string => (w.approvalId.startsWith('suggestion:') ? 'Rule' : w.by.name)

/** The whole waiting sentence (the chip's hover and its screen-reader words): who, when, until when, a plan's steps. */
export function waitingSentence(w: { by: { name: string }; at: string; expiresAt: string | null; plan?: { steps: number; offPage: number } }, now?: number): string {
  const plan = planWords(w.plan)
  return `Waiting for you · asked by ${w.by.name} ${relWords(w.at, now)}${w.expiresAt ? ` · expires ${relWords(w.expiresAt, now)}` : ''}${plan ? ` · ${plan}, approved together` : ''}`
}

const CHIP: Readonly<Record<AnyState, Omit<StateChipView, 'title'>>> = {
  RUNNING: { word: 'Running', tone: 'neutral', mark: 'play' },
  PAUSED: { word: 'Paused', tone: 'neutral', mark: 'pause' },
  KEPT_PAUSED: { word: 'Kept paused', tone: 'info', mark: 'pause' },
  NEGATED: { word: 'Blocked', tone: 'info', mark: 'ban' },
  PROTECTED: { word: 'Protected', tone: 'success', mark: 'shield' },
  TURNED_ON_ELSEWHERE: { word: 'Turned on', tone: 'warning', mark: 'alert' },
  NOT_AT_AMAZON: { word: 'Not at Amazon', tone: 'neutral', mark: 'cloud' },
}

/**
 * D6 — a row's state as ONE chip: a word with a tone and its mark, never a mark alone; the code's sentence on hover. A
 * running row that wastes (its test is met) says Wasting, one that does not says Running; a waiting row says who asked
 * (D12: "Waiting · asked by Brain").
 */
export function stateChip(
  r: { state: AnyState; match?: Match; level?: 'AD_GROUP' | 'CAMPAIGN' | null; keptPaused?: StoppedRow['keptPaused']; protection?: WasteRow['protection']; test?: { met: boolean } | null; waiting?: WasteRow['waiting'] },
  now?: number,
): StateChipView {
  if (r.waiting) return { word: `Waiting · asked by ${askerWord(r.waiting)}`, tone: 'warning', mark: 'hourglass', title: waitingSentence(r.waiting, now) }
  if (r.state === 'RUNNING' && r.test?.met) return { word: 'Wasting', tone: 'danger', mark: 'play', title: 'Running' }
  const base = CHIP[r.state] ?? { word: stateWord(r.state), tone: 'neutral' as const, mark: 'play' as const }
  return { ...base, title: stateSentence(r) }
}

/**
 * D6 — the line under the chip, the first that applies: a clash the Owner should see (red; a turned-on keyword's chip
 * says it already), Remove protection and stop still finishing or refused (`followUp`: its sentence, protectionModel),
 * a skip ("Skipped until 3 Nov", or the kept-protected words). Null: one line.
 */
export function stateSub(
  r: { state: AnyState; clash?: WasteRow['clash']; followUp?: WasteRow['followUp']; skipped?: WasteRow['skipped'] },
  words: { followUp?: string | null; keptProtected?: string | null } = {},
): StateSubView | null {
  if (r.clash && r.clash.kind !== 'TURNED_ON') return { word: r.clash.label, tone: 'danger', mark: 'warn' }
  if (r.followUp && words.followUp) return { word: words.followUp, tone: r.followUp.status === 'WAITING' ? 'muted' : 'danger', mark: r.followUp.status === 'WAITING' ? 'hourglass' : 'warn' }
  if (r.skipped) return { word: words.keptProtected ?? `Skipped until ${dayWords(r.skipped.until)}`, tone: 'muted', mark: 'clock' }
  return null
}

/** D12 — a waiting row's two verbs, each through its review: "Approve rain cover · 2 places" for a screen reader. */
export function decideAria(decide: 'approve' | 'reject', r: { text: string; waiting: { rows?: number } | null }): string {
  const places = Math.max(1, r.waiting?.rows ?? 1)
  return `${decide === 'approve' ? 'Approve' : 'Reject'} ${r.text}${places > 1 ? ` · ${places} places` : ''}`
}

/** What a ⋯ entry asks the view: a skip of the row, its unskip, one change (with a Keep paused's old end), its record. */
export type RowMenuAsk =
  | { kind: 'skip'; days: 7 | 30 }
  | { kind: 'unskip' }
  | { kind: 'change'; item: WasteItem; keepFrom?: string }
  | { kind: 'record' }
/** One entry of a row's ⋯ menu (the view turns `ask` into its review); a held one says why. */
export type RowMenuEntry =
  | { id: string; heading: string }
  | { id: string; separator: true }
  | { id: string; label: string; title?: string; held: string | null; ask: RowMenuAsk }

/** A ⋯ entry that does something (not a heading, not a rule). */
export type RowMenuVerb = Extract<RowMenuEntry, { ask: RowMenuAsk }>

const OPEN_RECORD: RowMenuEntry = { id: 'record', label: 'Open record', held: null, ask: { kind: 'record' } }
/** Open record is the last entry, under a rule when other entries stand above it. It never needs a write. */
const withRecord = (entries: RowMenuEntry[]): RowMenuEntry[] => (entries.length ? [...entries, { id: 'sep-record', separator: true }, OPEN_RECORD] : [OPEN_RECORD])

/**
 * D6 — a Wasting row's ⋯: its second verb (Remove negative… under a clash), Skip 7 d · Skip 30 d (Unskip once skipped),
 * Open record. A keyword turned on outside Nexus is not skipped: it spends again (the record's rule, audit S9). `noWrite`
 * holds every verb (writeHeld); Open record still works.
 */
export function wasteRowMenu(r: Pick<WasteRow, 'id' | 'state' | 'verb' | 'kind' | 'skipped'> & Partial<Pick<WasteRow, 'test' | 'clash'>>, noWrite: string | null): RowMenuEntry[] {
  const out: RowMenuEntry[] = []
  const second = wasteVerb(r)?.second
  if (second) {
    out.push({ id: second.action, label: second.label, title: second.sentence, held: noWrite ?? second.held, ask: { kind: 'change', item: { rowId: r.id, action: second.action, ...(second.targetRowId ? { targetRowId: second.targetRowId } : {}) } } })
  }
  const k = idKind(r.id)
  if ((k === 'kw' || k === 'term') && r.state !== 'TURNED_ON_ELSEWHERE') {
    if (r.skipped) out.push({ id: 'unskip', label: 'Unskip', held: noWrite, ask: { kind: 'unskip' } })
    else if (r.state === 'RUNNING' || r.state === 'PROTECTED') {
      out.push({ id: 'skip7', label: 'Skip 7 d', held: noWrite, ask: { kind: 'skip', days: 7 } }, { id: 'skip30', label: 'Skip 30 d', held: noWrite, ask: { kind: 'skip', days: 30 } })
    }
  }
  return withRecord(out)
}

/**
 * D13 — a Stopped row's ⋯ (new): the record footer's other verbs, then Open record. Turned on outside Nexus: Pause again.
 * Our paused keyword: Keep paused (kept paused: Keep until) 7 d · 30 d · Always, and Release lock when it is kept. A
 * negative: Open record only (Remove… is its row button). `now`: today, for the ends.
 */
export function stoppedRowMenu(r: Pick<StoppedRow, 'id' | 'state' | 'keptPaused' | 'actions'>, noWrite: string | null, now: number): RowMenuEntry[] {
  const out: RowMenuEntry[] = []
  const inDays = (d: number) => new Date(now + d * 86_400_000).toISOString().slice(0, 10)
  if (r.state === 'TURNED_ON_ELSEWHERE') {
    out.push({ id: 'pause', label: 'Pause again', title: 'Pause it again and keep it paused: it was turned on outside Nexus', held: noWrite, ask: { kind: 'change', item: { rowId: r.id, action: 'PAUSE' } } })
  }
  if (idKind(r.id) === 'kw' && (r.state === 'KEPT_PAUSED' || r.state === 'PAUSED')) {
    const kept = r.state === 'KEPT_PAUSED'
    const from = kept ? r.keptPaused?.until ?? 'ALWAYS' : NOT_KEPT
    const keep = (id: string, label: string, until: string | null): RowMenuEntry => ({ id, label, held: noWrite, ask: { kind: 'change', item: { rowId: r.id, action: 'KEEP_UNTIL', keepUntil: until }, keepFrom: from } })
    out.push({ id: 'keep', heading: kept ? 'Keep until' : 'Keep paused' }, keep('keep7', '7 d', inDays(7)), keep('keep30', '30 d', inDays(30)), keep('keepAlways', 'Always', null))
    if (kept) {
      const why = r.actions.release.allowed ? null : r.actions.release.why || 'Not allowed here'
      out.push({ id: 'sep-release', separator: true }, { id: 'release', label: 'Release lock', title: verbSentence('RELEASE'), held: noWrite ?? why, ask: { kind: 'change', item: { rowId: r.id, action: 'RELEASE' } } })
    }
  }
  return withRecord(out)
}
