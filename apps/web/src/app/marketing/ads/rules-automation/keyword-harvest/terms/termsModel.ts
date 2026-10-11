/**
 * Keyword Harvest page, Terms view — the pure rules (2026-10-11, lane TERMS). Tested in Node (`termsModel.vitest.test.ts`).
 *
 *   tiles      Ready · Waiting for you · Harvested · 30 d · Worse — each the server's total of the same read, and a click
 *              shows exactly that many rows (audit M1): the filter below counts the way the server counts.
 *   status     one word and tone per state (audit M9: plain words, no jargon): Ready · Waiting for you · Sending ·
 *              Harvested · Better · Worse · Too early · Needs campaign · <the hold's own label> · Already a keyword ·
 *              Other product · Below bar · Skipped.
 *   verbs      what each row offers (Harvest · Harvest to… · Approve / Reject · Skip · Unskip · Undo…), and the bulk bar's
 *              split of a selection — each held verb says why.
 *   review     the ReviewChangesModal rows of Skip, Unskip, Approve, Reject and Undo harvest.
 */
import type { ReviewChange } from '@/design-system/patterns'
import { currencyOf, dayWords, moneyText, periodWord, relWords } from '../../bid/_shared/format'
import type {
  CandidateState, HarvestCandidateRow, Ref, SkipDays,
} from '../_shared/types'

const DAY = 86_400_000
/** "Harvested" in the page's one window: the ledger's 60 days (the Sources view's; the tile says it). */
export const HARVESTED_WINDOW_DAYS = 60

/** Harvested rows in the page's window (the tile's number; the server's total is 30 days). Pure. */
export function harvestedInWindow(rows: ReadonlyArray<Pick<HarvestCandidateRow, 'state' | 'lastHarvest' | 'waiting'>>, now: number = Date.now()): number {
  return rows.filter((r) => showMatches(r, 'harvested', now)).length
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n.toLocaleString('en-IE')} ${n === 1 ? one : many}`

// ── tiles and filters ─────────────────────────────────────────────────────────────────────────────────────────────────

export const TERMS_SHOWS = ['ready', 'waiting', 'harvested', 'worse', 'stale'] as const
export type TermsShow = (typeof TERMS_SHOWS)[number]
export const isTermsShow = (v: unknown): v is TermsShow => typeof v === 'string' && (TERMS_SHOWS as readonly string[]).includes(v)

/** Which read the table shows: the open work and the harvested (the server's default), or the skipped terms. */
export type TermsList = 'open' | 'skipped'
export const isTermsList = (v: unknown): v is TermsList => v === 'open' || v === 'skipped'
/** The read's `state` for a list: null = the server's default. */
export const listStates = (list: TermsList): CandidateState[] | null => (list === 'skipped' ? ['SKIPPED'] : null)

/** Does a row belong to a tile — counted exactly as the server counts its total (candidates.ts `totalsOf`). */
export function showMatches(row: Pick<HarvestCandidateRow, 'state' | 'lastHarvest' | 'waiting'>, show: TermsShow | null | undefined, now: number = Date.now()): boolean {
  if (!show) return true
  switch (show) {
    case 'ready': return row.state === 'READY'
    // Waiting for you = what can be approved now; an out-of-date ask is listed, but not under this tile (N-S1).
    case 'waiting': return row.state === 'WAITING' && !row.waiting?.stale
    case 'harvested': return row.state === 'HARVESTED' && !!row.lastHarvest && Date.parse(row.lastHarvest.at) >= now - HARVESTED_WINDOW_DAYS * DAY
    case 'worse': return row.state === 'HARVESTED' && row.lastHarvest?.verdict === 'worse'
    // The out-of-date asks ("2 out of date" beside Waiting for you): only rejectable (functional walk).
    case 'stale': return row.state === 'WAITING' && !!row.waiting?.stale
  }
}

/** The count beside the switch: "48 terms", "3 of 48". */
export function countWords(shown: number, total: number, filtered: boolean): string {
  return filtered && shown !== total ? `${shown.toLocaleString('en-IE')} of ${total.toLocaleString('en-IE')}` : plural(total, 'term')
}

/** The table's empty state: what it says, and whether Clear filters helps. */
export function emptyWords(args: { show: TermsShow | null; list: TermsList; search: string; any: boolean }): { title: string; clear: boolean } {
  const { show, list, search, any } = args
  if (search.trim() || show) return { title: 'No terms match', clear: true }
  if (list === 'skipped') return { title: 'Nothing skipped', clear: true }
  return { title: any ? 'No terms match' : 'Nothing to harvest', clear: any }
}

// ── status ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export interface StatusView { word: string; tone: StatusTone; hint: string | null }

/** Who did it, in one word everywhere (audit S8): a person on this page is "You"; a rule by its name. */
export const whoWord = (kind: string | null | undefined, name?: string | null): string =>
  (kind === 'BRAIN' ? 'Brain' : kind === 'CLAUDE' ? 'Claude' : kind === 'RULE' ? (name?.trim() || 'A rule') : 'You')
/** "Asked 2 h ago", "Brain asked 2 h ago", "TEST Harvest exact asked 2 h ago". */
const askedWords = (by: { kind: string; name?: string | null }, at: string, now: number): string => {
  const who = whoWord(by.kind, by.name)
  return `${who === 'You' ? 'Asked' : `${who} asked`} ${relWords(at, now)}`
}

/** The skip's end: "for good", "until 3 Nov". */
export const skipUntilWords = (until: string | null): string => (until ? `until ${dayWords(until)}` : 'for good')

export function statusOf(row: Pick<HarvestCandidateRow, 'state' | 'heldBy' | 'lastHarvest' | 'waiting' | 'skipped' | 'bar' | 'destination'>, now: number = Date.now()): StatusView {
  const held = row.heldBy
  switch (row.state) {
    case 'READY': return { word: 'Ready', tone: 'success', hint: null }
    case 'WAITING': {
      const w = row.waiting
      // Out of date (re-audit N-S1): its approval would be refused now — it can only be rejected.
      if (w?.stale) return { word: 'Out of date', tone: 'neutral', hint: w.stale.why || 'It can only be rejected now' }
      return { word: 'Waiting for you', tone: 'warning', hint: w ? `${askedWords(w.by, w.at, now)}${w.expiresAt ? ` · expires ${relWords(w.expiresAt, now)}` : ''}` : null }
    }
    case 'IN_FLIGHT': return { word: 'Sending', tone: 'info', hint: 'Being written at Amazon' }
    case 'HARVESTED': {
      const v = row.lastHarvest?.verdict ?? null
      const at = row.lastHarvest ? `Harvested ${relWords(row.lastHarvest.at, now)}` : null
      if (v === 'better') return { word: 'Better', tone: 'success', hint: at }
      if (v === 'worse') return { word: 'Worse', tone: 'danger', hint: at }
      if (v === 'too-early') return { word: 'Too early', tone: 'neutral', hint: at }
      // Not judged yet: the tile counts it as harvested, the row says what is true now (audit S8).
      return { word: 'Not checked yet', tone: 'info', hint: at }
    }
    case 'NEEDS_CAMPAIGN': return { word: 'Needs campaign', tone: 'info', hint: row.destination?.kind === 'new' ? `New: ${row.destination.plan.name}` : held?.reason ?? null }
    case 'NEEDS_DESTINATION': return { word: held?.label || 'Needs a place', tone: 'warning', hint: held?.reason ?? null }
    case 'HELD': return { word: held?.label || 'Held', tone: 'warning', hint: held?.reason ?? null }
    case 'AT_HOME': return { word: 'Already a keyword', tone: 'neutral', hint: held?.reason ?? null }
    case 'OWNED_BY_SIBLING': return { word: 'Other product', tone: 'neutral', hint: held?.reason ?? null }
    case 'BELOW_BAR': return { word: 'Does not sell yet', tone: 'neutral', hint: barWords(row.bar.label) }
    case 'SKIPPED': return { word: 'Skipped', tone: 'neutral', hint: row.skipped ? `Skipped ${skipUntilWords(row.skipped.until)}` : null }
  }
}

// ── the match the term came from ──────────────────────────────────────────────────────────────────────────────────────

const ROLE_WORD: Readonly<Record<string, string>> = { AUTO: 'Auto', BROAD: 'Broad', PHRASE: 'Phrase', EXACT: 'Exact', PRODUCT: 'ASIN' }
/** "Broad", "Auto", "Phrase" — the main source's match; null when unknown. */
export const roleWord = (role: string | null | undefined): string | null => (role ? ROLE_WORD[role] ?? null : null)

/** Goes to, in words for the CSV, the search and the hover line. */
export function goesToText(row: Pick<HarvestCandidateRow, 'destination'>): string {
  const d = row.destination
  if (!d) return ''
  if (d.kind === 'new') return `New campaign · ${d.plan.name}`
  return [d.portfolio?.name, d.campaign.name, d.adGroup.name].filter(Boolean).join(' › ')
}

/** The bar in plain words (audit §2): "1+ order · ACoS under target". */
export const barWords = (label: string): string => label.replace(/ACoS under band|ACoS cap/g, 'ACoS under target')

/**
 * The numbers a row shows (audit S7): a harvested term shows its keyword's own numbers since the harvest when the server
 * sends them (`sinceHarvest`); otherwise the search term's numbers over the bar's window. `since` says which.
 */
export function rowNumbers(row: Pick<HarvestCandidateRow, 'state' | 'metrics' | 'sinceHarvest'>): { since: number | null; clicks: number; orders: number; spendCents?: number; salesCents?: number; acosPct?: number | null; cpcCents?: number | null; windowDays: number } {
  const s = row.state === 'HARVESTED' ? row.sinceHarvest : null
  if (s) {
    const cpc = typeof s.spendCents === 'number' && s.clicks > 0 ? Math.round(s.spendCents / s.clicks) : null
    return { since: s.days, clicks: s.clicks, orders: s.orders, spendCents: s.spendCents, salesCents: s.salesCents, acosPct: s.acosPct ?? null, cpcCents: cpc, windowDays: s.days }
  }
  const m = row.metrics
  return { since: null, clicks: m.clicks, orders: m.orders, spendCents: m.spendCents, salesCents: m.salesCents, acosPct: m.acosPct ?? null, cpcCents: m.cpcCents ?? null, windowDays: m.windowDays }
}
/** The hover line of a row's numbers: "Since the harvest · 12 days" or "60 days". */
export const numbersWindowWords = (n: { since: number | null; windowDays: number }): string => (n.since != null ? `Since the harvest · ${n.since} days` : `${n.windowDays} days`)

/** "18 %"; a dash for none. */
export const acosText = (pct: number | null | undefined): string => (typeof pct === 'number' && Number.isFinite(pct) ? `${Math.round(pct * 10) / 10} %` : '—')
/**
 * A row's currency (release review R5): its own (B18), else its MARKET's — never another row's, never one currency for a
 * table of mixed markets.
 */
export const currencyOfRow = (row: Pick<HarvestCandidateRow, 'currency' | 'market'>): string => row.currency || currencyOf(row.market)
export const rowMoney = (row: Pick<HarvestCandidateRow, 'currency' | 'market'>, cents: number | null | undefined): string => moneyText(cents, currencyOfRow(row))

// ── verbs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

type VerbRow = Pick<HarvestCandidateRow, 'state' | 'heldBy' | 'waiting' | 'lastHarvest' | 'skipped'>

/** Harvest (to its suggested place): a Ready term, or one whose suggested place is a new campaign. */
export function harvestHeld(row: VerbRow): string | null {
  if (row.state === 'READY' || row.state === 'NEEDS_CAMPAIGN') return null
  return notHarvestable(row)
}
/** Harvest to… (pick the place): also a term whose suggested place cannot take it. */
export function harvestToHeld(row: VerbRow): string | null {
  if (row.state === 'READY' || row.state === 'NEEDS_CAMPAIGN' || row.state === 'NEEDS_DESTINATION') return null
  if (row.state === 'HELD' && row.heldBy?.kind === 'destination') return null
  return notHarvestable(row)
}
function notHarvestable(row: VerbRow): string {
  switch (row.state) {
    case 'WAITING': return 'Waits for you: approve or reject it'
    case 'IN_FLIGHT': return 'Being written at Amazon'
    case 'HARVESTED': return 'Already harvested'
    case 'SKIPPED': return 'Skipped: unskip it first'
    case 'AT_HOME': return 'Already a keyword of this product'
    case 'OWNED_BY_SIBLING': return 'Another product of the family runs it'
    case 'BELOW_BAR': return 'Below the bar: not enough orders yet'
    default: return row.heldBy?.reason || row.heldBy?.label || 'Cannot be harvested now'
  }
}
export function decideHeld(row: VerbRow): string | null {
  return row.state === 'WAITING' && row.waiting?.approvalId ? null : 'Nothing waits for you on this term'
}
/** Approve: also held when the server would refuse it now (a rule's ask whose rule changed) — Reject stays offered. */
export function approveHeld(row: VerbRow): string | null {
  return decideHeld(row) ?? (row.waiting?.stale ? row.waiting.stale.why || 'It cannot be approved now: reject it' : null)
}
const SKIPPABLE: readonly CandidateState[] = ['READY', 'NEEDS_DESTINATION', 'NEEDS_CAMPAIGN', 'HELD', 'BELOW_BAR', 'OWNED_BY_SIBLING']
export function skipHeld(row: VerbRow): string | null {
  if (SKIPPABLE.includes(row.state)) return null
  if (row.state === 'SKIPPED') return 'Already skipped'
  return notHarvestable(row)
}
export const unskipHeld = (row: VerbRow): string | null => (row.state === 'SKIPPED' ? null : 'Not skipped')
const UNDOABLE = ['DONE', 'HALF_DONE']
export function undoHeld(row: VerbRow): string | null {
  if (row.state !== 'HARVESTED') return row.state === 'IN_FLIGHT' ? 'Being written at Amazon' : 'Not harvested'
  if (!row.lastHarvest || !UNDOABLE.includes(row.lastHarvest.status)) return 'Already undone'
  // The undo's own answer (M3): never offered when the server would refuse it.
  const u = row.lastHarvest.undo
  if (!u?.available) return undoWhyWords(u?.why)
  return null
}
/** The server's "why not" of an undo, short (audit §2): "Already undone" for a keyword that no longer runs. */
export function undoWhyWords(why: string | null | undefined): string {
  const w = (why ?? '').trim()
  if (!w || /left to put back|put back already|not running/i.test(w)) return 'Already undone'
  if (/waits for a person/i.test(w)) return 'An undo of it waits for you'
  return w
}

/** A selection, split by what each bulk action can take. */
export interface BulkSplit<R> { harvest: R[]; harvestTo: R[]; decide: R[]; approve: R[]; skip: R[]; unskip: R[]; undo: R[] }
export function bulkSplit<R extends VerbRow>(rows: readonly R[]): BulkSplit<R> {
  return {
    harvest: rows.filter((r) => !harvestHeld(r)),
    harvestTo: rows.filter((r) => !harvestToHeld(r)),
    decide: rows.filter((r) => !decideHeld(r)),
    approve: rows.filter((r) => !approveHeld(r)),
    skip: rows.filter((r) => !skipHeld(r)),
    unskip: rows.filter((r) => !unskipHeld(r)),
    undo: rows.filter((r) => !undoHeld(r)),
  }
}
/** Why a bulk action takes none of the ticked terms, or null. */
export function bulkHeld(kind: keyof BulkSplit<unknown>, count: number, ticked: number): string | null {
  if (count > 0) return null
  if (!ticked) return 'Tick terms first'
  switch (kind) {
    case 'harvest': return 'No ticked term is ready'
    case 'harvestTo': return 'No ticked term can be harvested'
    case 'decide': return 'No ticked term waits for you'
    case 'approve': return 'No ticked request can be approved now'
    case 'skip': return 'No ticked term can be skipped'
    case 'unskip': return 'No ticked term is skipped'
    case 'undo': return 'No ticked harvest can be put back'
  }
}

/** One product: the "Harvest to…" window picks one place for terms of ONE product. */
export function productsOf(rows: ReadonlyArray<Pick<HarvestCandidateRow, 'product' | 'market'>>): number {
  return new Set(rows.map((r) => `${r.market}|${r.product.id}`)).size
}

// ── reviews ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export const SKIP_WORD = (days: SkipDays): string => (days == null ? 'Skipped for good' : `Skipped · ${periodWord(days)}`)

type ReviewRow = Pick<HarvestCandidateRow, 'id' | 'term' | 'product' | 'state' | 'heldBy' | 'lastHarvest' | 'waiting' | 'skipped' | 'bar' | 'destination'>

export function skipChanges(rows: readonly ReviewRow[], days: SkipDays): ReviewChange[] {
  return rows.map((r) => ({ id: r.id, where: r.product.name, what: r.term, now: statusOf(r).word, next: SKIP_WORD(days) }))
}
export function unskipChanges(rows: readonly ReviewRow[]): ReviewChange[] {
  return rows.map((r) => ({ id: r.id, where: r.product.name, what: r.term, now: r.skipped ? `Skipped ${skipUntilWords(r.skipped.until)}` : 'Skipped', next: 'Shown' }))
}

/** The review's tabs (M5): the same two as the Harvest window's review. */
export const REVIEW_GROUPS = [{ id: 'keywords', label: 'Keywords' }, { id: 'negatives', label: 'Negatives' }, { id: 'campaign', label: 'New campaign' }] as const

/** A row of an Approve / Reject review: one write of a waiting request, in its tab, with the request it belongs to. */
export interface DecideChange extends ReviewChange {
  group: 'keywords' | 'negatives' | 'campaign'
  approvalId: string
  /** Where it lands, as links (campaign › ad group; a new campaign by its name): the review draws them (N-S3). */
  place: Array<Ref | null>
  /** The term (the review's What). */
  term: string
}

type PlanRow = Pick<HarvestCandidateRow, 'id' | 'term' | 'product' | 'waiting' | 'destination' | 'startBidCents' | 'currency' | 'market' | 'sources' | 'funnel' | 'metrics'>

/** Where a keyword goes, as one line: "Campaign › Ad group", or the new campaign. */
const placeWords = (row: Pick<HarvestCandidateRow, 'destination'>): string => {
  const d = row.destination
  if (!d) return '—'
  if (d.kind === 'new') return `New campaign · ${d.plan.name}`
  return `${d.campaign.name} › ${d.adGroup.name}`
}

/**
 * What an Approve or a Reject decides (audit M5, release review R4): EVERY write of each waiting request, from the row's
 * plan — the new campaign (and its portfolio) it builds, each keyword (place, match, bid), each block where found and
 * each wider-match block — in the Keywords, Negatives and New campaign tabs, like the Harvest window's review. Approve:
 * Now → what gets written. Reject: what would have been written → Not sent. Each amount in its row's own currency (R5).
 */
export function decideChanges(rows: readonly PlanRow[], kind: 'approve' | 'reject', now: number = Date.now()): DecideChange[] {
  const out: DecideChange[] = []
  const campaigns = new Set<string>()
  for (const r of rows) {
    const w = r.waiting
    if (!w?.approvalId) continue
    const a = w.approvalId
    const cur = currencyOfRow(r)
    const d = r.destination
    if (d?.kind === 'new' && !campaigns.has(`${a}|${d.plan.name}`)) {
      campaigns.add(`${a}|${d.plan.name}`)
      const budget = typeof d.plan.dailyBudgetCents === 'number' ? `${moneyText(d.plan.dailyBudgetCents, cur)} a day` : 'New'
      out.push({
        id: `${a}|camp|${d.plan.name}`, approvalId: a, group: 'campaign', where: d.plan.portfolio?.name ?? '—', what: `Campaign · ${d.plan.name}`, term: `Campaign · ${d.plan.name}`,
        place: d.plan.portfolio ? [d.plan.portfolio] : [], now: kind === 'approve' ? '—' : budget, next: kind === 'approve' ? budget : 'Not sent',
        note: `Ad group · ${d.plan.adGroupName}`,
      })
    }
    const match = r.destination?.match === 'PHRASE' ? 'Phrase' : 'Exact'
    const bid = typeof r.startBidCents === 'number' ? ` · ${moneyText(r.startBidCents, cur)}` : ''
    const plan = `${match}${bid}`
    const cpc = typeof r.metrics.cpcCents === 'number' ? `CPC ${moneyText(r.metrics.cpcCents, cur)}` : '—'
    out.push({
      id: `${a}|kw|${r.id}`, approvalId: a, group: 'keywords', where: placeWords(r), what: r.term, term: r.term,
      place: r.destination?.kind === 'existing' ? [r.destination.campaign, r.destination.adGroup] : r.destination?.kind === 'new' ? [{ id: 'new', name: `New · ${r.destination.plan.name}` }] : [],
      now: kind === 'approve' ? cpc : plan, next: kind === 'approve' ? plan : 'Not sent',
      note: askedWords(w.by, w.at, now),
    })
    for (const src of r.sources.filter((x) => x.action === 'negate')) {
      out.push({
        id: `${a}|src|${r.id}|${src.adGroup.id}`, approvalId: a, group: 'negatives', where: `${src.campaign.name} › ${src.adGroup.name}`, what: r.term, term: r.term,
        place: [src.campaign, src.adGroup],
        now: kind === 'approve' ? '—' : 'Negative exact', next: kind === 'approve' ? 'Negative exact' : 'Not sent', note: 'Where found',
      })
    }
    for (const f of r.funnel) {
      const neg = f.match === 'PHRASE' ? 'Negative phrase' : 'Negative exact'
      out.push({
        id: `${a}|fun|${r.id}|${f.adGroup.id}`, approvalId: a, group: 'negatives', where: `${f.campaign.name} › ${f.adGroup.name}`, what: r.term, term: r.term,
        place: [f.campaign, f.adGroup],
        now: kind === 'approve' ? '—' : neg, next: kind === 'approve' ? neg : 'Not sent', note: 'Wider match',
      })
    }
  }
  return out
}

/** The requests among the rows (one request can cover several terms): the unit every Approve / Reject counts (M4). */
export const requestIds = (rows: ReadonlyArray<Pick<HarvestCandidateRow, 'waiting'>>): string[] =>
  [...new Set(rows.map((r) => r.waiting?.approvalId).filter((x): x is string => !!x))]

/** "Approve 2" with its long name "Approve 2 requests · 3 terms" (M4: the button and the review count the same unit). */
export function decideButtonWords(kind: 'approve' | 'reject', rows: ReadonlyArray<Pick<HarvestCandidateRow, 'waiting'>>): { label: string; long: string } {
  const verb = kind === 'approve' ? 'Approve' : 'Reject'
  const n = requestIds(rows).length
  // A request's own count of terms (it may cover terms this list does not hold), else its rows here.
  const per = new Map<string, number>()
  for (const r of rows) {
    const w = r.waiting
    if (!w?.approvalId) continue
    per.set(w.approvalId, typeof w.terms === 'number' ? w.terms : (per.get(w.approvalId) ?? 0) + 1)
  }
  const terms = [...per.values()].reduce((a, b) => a + b, 0)
  return { label: `${verb} ${n}`, long: `${verb} ${plural(n, 'request')}${terms !== n ? ` · ${plural(terms, 'term')}` : ''}` }
}

/** The Done line of a decision, counted in requests (the review lists their writes). */
export function decideDoneLine(kind: 'approve' | 'reject', results: ReadonlyMap<string, boolean>): { line: string; tone: 'success' | 'warning' | 'danger' } {
  const ok = [...results.values()].filter(Boolean).length
  const not = results.size - ok
  const verb = kind === 'approve' ? 'approved' : 'rejected'
  if (!ok) return { line: `Nothing ${verb}`, tone: 'danger' }
  return { line: `${plural(ok, 'request')} ${verb}${not ? ` · ${not} not ${verb}` : ''}`, tone: not ? 'warning' : 'success' }
}


export function undoChanges(rows: readonly ReviewRow[]): ReviewChange[] {
  return rows.filter((r) => r.lastHarvest).map((r) => ({
    id: r.lastHarvest!.harvestId,
    where: goesToText(r) || r.product.name,
    what: r.term,
    now: 'Keyword on',
    next: 'Keyword paused',
    note: 'Blocks removed',
  }))
}

/** The Done line's verb of each review. */
export const DONE_VERB = { skip: 'skipped', unskip: 'shown', approve: 'approved', reject: 'rejected', undo: 'undone' } as const

/** Terms for the clipboard: one per line. */
export const copyText = (rows: readonly Pick<HarvestCandidateRow, 'term'>[]): string => rows.map((r) => r.term).join('\n')

// ── the term's detail ─────────────────────────────────────────────────────────────────────────────────────────────────

export const TERM_TABS = ['overview', 'where', 'results', 'history'] as const
export type TermTab = (typeof TERM_TABS)[number]
export const isTermTab = (v: unknown): v is TermTab => typeof v === 'string' && (TERM_TABS as readonly string[]).includes(v)

/** What a harvest does in one source ad group. */
export const SOURCE_ACTION_WORD: Readonly<Record<string, string>> = {
  negate: 'Blocked',
  standing: 'Already blocked',
  kept: 'Keeps running',
  skipped: 'Left alone',
}
export const sourceActionWord = (action: string, negMatch?: string | null): string =>
  action === 'negate' ? (negMatch === 'PHRASE' ? 'Negative phrase' : 'Negative exact') : SOURCE_ACTION_WORD[action] ?? action

/** "3 ad groups", "Keeps running" — the "Blocked where found" line of the overview. */
export function inSourceWords(sources: ReadonlyArray<{ action: string }>): string {
  const negated = sources.filter((s) => s.action === 'negate').length
  if (negated) return plural(negated, 'ad group')
  if (sources.some((s) => s.action === 'standing')) return 'Already blocked'
  if (sources.some((s) => s.action === 'kept')) return 'Keeps running'
  return '—'
}

/**
 * A harvest record's state as one word (`bid/_shared/delivery.ts` words, plus Paused): "Live" only while its keyword
 * runs (audit M3): the keyword's own state in Nexus (`lastHarvest.keyword.state`) decides Live, Paused or Undone.
 */
export function historyStateOf(status: string, opts: { keyword?: { state: string | null } | null } = {}): 'waiting' | 'sent' | 'live' | 'undone' | 'failed' | 'paused' | 'off' {
  if ((status === 'DONE' || status === 'HALF_DONE') && opts.keyword !== undefined) {
    const k = opts.keyword?.state ?? null
    // No keyword at all (state null): nothing runs — never "Live".
    return k === 'ENABLED' ? 'live' : k === 'PAUSED' ? 'paused' : k === 'ARCHIVED' ? 'undone' : 'off'
  }
  switch (status) {
    case 'DONE':
    case 'HALF_DONE': return 'live'
    case 'WRITING':
    case 'CAMPAIGN_BUILT': return 'sent'
    case 'UNDONE': return 'undone'
    case 'REFUSED':
    case 'FAILED': return 'failed'
    default: return 'waiting'
  }
}

export const VERDICT_VIEW: Readonly<Record<'better' | 'worse' | 'too-early', { word: string; tone: StatusTone }>> = {
  better: { word: 'Better', tone: 'success' },
  worse: { word: 'Worse', tone: 'danger' },
  'too-early': { word: 'Too early', tone: 'neutral' },
}

/** Who a harvest's actor is, in one word. */
export const actorWord = (by: { kind: string; name?: string | null }): string =>
  by.kind === 'BRAIN' ? 'Brain' : by.kind === 'CLAUDE' ? 'Claude' : by.kind === 'RULE' ? (by.name || 'A rule')
    : by.name && !/^(person|you)$/i.test(by.name) ? by.name : 'You'

/**
 * The ONE Approve / Reject of waiting requests — the Terms view and the rule modal's Waiting tab ask it the same way.
 * Approve leaves out the requests the server would refuse now (`waiting.stale`) and counts them; Reject takes them all.
 * `all` = every loaded row, so a request covering several terms lists all of them.
 */
export function waitingDecision<R extends Pick<HarvestCandidateRow, 'waiting'>>(kind: 'approve' | 'reject', rows: readonly R[], all: readonly R[] = rows): { rows: R[]; leftOut: number } {
  const pool = kind === 'approve' ? rows.filter((r) => r.waiting?.approvalId && !r.waiting.stale) : rows.filter((r) => r.waiting?.approvalId)
  const ids = new Set(pool.map((r) => r.waiting!.approvalId))
  const leftOut = kind === 'approve' ? requestIds(rows.filter((r) => r.waiting?.stale)).length : 0
  return { rows: all.filter((r) => r.waiting && ids.has(r.waiting.approvalId)), leftOut }
}

/** What the Harvest window is given (release review R7): exactly the rows it may harvest — never a query. Pure. */
export const harvestSourceOf = <R,>(rows: readonly R[]): { rows: R[] } => ({ rows: [...rows] })
