/**
 * Bid page, Bids view (lane BIDS, 2026-10-10) — the rows of `GET /api/advertising/bids` and the words, filters and
 * rules the view draws them with. Pure, tested in Node (`bidsModel.vitest.test.ts`).
 *
 * The API decides ONE owner per bid (apps/api/src/services/advertising/bid-owner.ts `resolveBidOwner`); this file only
 * says it. Money is in cents of the row's own currency (`currency`, else its market's — `_shared/format.ts`, the page's
 * one helper for time, money and the period). The money keys (bidNow, maxCpc, brainAim, a change's from → to, spend,
 * acosPct, spark) are left out by the server for a person without the ad-spend permission: absent (undefined) means
 * hidden, null means "none".
 */
import type { ChangeState } from '../_shared/delivery'
import type { SuggestedCell } from './suggestedModel'
import { currencyOf, money, relWords, signedMoney, WEEK, whenWords } from '../_shared/format'

export interface Ref { id: string; name: string; href?: string | null }

export const OWNER_KINDS = ['BRAIN', 'RULE', 'PLAN', 'PERSON', 'ENGINE', 'NONE'] as const
export type OwnerKind = (typeof OWNER_KINDS)[number]

/** One writer of a bid. */
export interface BidWriter { kind: OwnerKind; name: string; id: string | null }
/**
 * The owner: the writer that writes the bid most (bid-owner.ts resolveBidOwner). `contested` when another writes it
 * too; every other writer is named in `alsoWrites`, never hidden. Older answers had neither: read as uncontested.
 */
export interface BidOwner extends BidWriter { contested?: boolean; alsoWrites?: BidWriter[] }
export interface HeldBy { kind: string; label: string; reason?: string }
/** Who made a change; `id` the rule's or plan's own (older answers had none). */
export interface ChangeAuthor { kind: OwnerKind; name: string; id?: string | null }

export interface BidRow {
  targetId: string
  text: string
  match: string
  portfolio: Ref | null
  campaign: Ref
  adGroup: Ref
  owner: BidOwner
  /** The campaign's market ("IT", "UK"); older answers had none. */
  market?: string | null
  /** The campaign's currency ("EUR", "GBP"); older answers had none — then the market's. */
  currency?: string | null
  bidNow?: number
  nightFloor: boolean
  maxCpc?: number
  brainAim?: number | null
  heldBy: HeldBy | null
  lastChange: { from?: number; to?: number; at: string; by: ChangeAuthor } | null
  changes7d: number
  d7: { clicks: number; orders: number; spend?: number; acosPct?: number | null }
  spark?: number[]
  // ── keyword Auto, goal + max, live (KEYWORD-AUTO.md; absent until the API carries them: the page then hides them) ──
  /** A person's own goal and max for this keyword (the brain's settings store); null = none. */
  goal?: BidGoal | null
  /** AUTO: an engine runs this keyword · MANUAL: a person holds it · NONE: no engine runs this campaign (`autoWhy`). */
  auto?: KeywordAuto
  /** Why the keyword cannot be switched (NONE), in one line. */
  autoWhy?: string | null
  /** What became of the newest change (delivery.ts words); null = no record. */
  delivery?: ChangeState | null
  /** The product whose brain runs this keyword's campaign: a goal is saved in that brain's settings. */
  brainProductId?: string | null
}

export const KEYWORD_AUTOS = ['AUTO', 'MANUAL', 'NONE'] as const
export type KeywordAuto = (typeof KEYWORD_AUTOS)[number]
/** A keyword's own goal: percents and cents; any may be empty. `by`: who set it. */
export interface BidGoal {
  acosPct: number | null
  tosPct: number | null
  maxCents: number | null
  by?: ChangeAuthor | null
  at?: string | null
}

/** The new fields this answer carries: a column or control shows only when its field is there (never fake data). */
export interface BidFeatures { auto: boolean; goal: boolean; delivery: boolean }
export const NO_FEATURES: BidFeatures = { auto: false, goal: false, delivery: false }

export function featuresOf(rows: readonly BidRow[]): BidFeatures {
  const has = (key: keyof BidRow) => rows.some((r) => Object.prototype.hasOwnProperty.call(r, key))
  return { auto: has('auto'), goal: has('goal'), delivery: has('delivery') }
}

/** The read's own totals (`GET /api/advertising/bids` → totals). */
export interface BidTotals {
  bids: number
  shown: number
  owners: Record<OwnerKind, number>
  nightFloor: number
  changed7d: number
  d7: { clicks: number; orders: number; spend?: number; acosPct?: number | null }
  truncated: boolean
}

export interface BidsAnswer { rows: BidRow[]; totals: BidTotals }

// ── Who sets it ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The filter chips' words, one per kind. An engine is "Engine" (never "Auto-bid": that reads like the mode Auto). */
export const OWNER_WORD: Record<OwnerKind, string> = {
  BRAIN: 'Brain',
  RULE: 'Rule',
  PLAN: 'Hourly plan',
  PERSON: 'You',
  ENGINE: 'Engine',
  NONE: '—',
}

/** The words a screen reader and a hover line use where the chip shows only a dash. */
export const OWNER_NAME: Record<OwnerKind, string> = { ...OWNER_WORD, NONE: 'Nothing sets it' }

/** The row chip: a rule by its name, the brain by its name (it may say "stopped"), the rest by their kind. */
export function ownerLabel(o: BidOwner): string {
  const name = o.name?.trim()
  if ((o.kind === 'RULE' || o.kind === 'BRAIN') && name) return name
  return OWNER_WORD[o.kind] ?? OWNER_WORD.NONE
}

/** A writer by its name where it has one: a rule or a plan; the rest by their kind. */
export function writerName(w: BidWriter): string {
  const name = w.name?.trim()
  if ((w.kind === 'RULE' || w.kind === 'PLAN') && name) return name
  return OWNER_WORD[w.kind] ?? OWNER_WORD.NONE
}

/** The other writers of a contested bid (empty when it has one writer). */
export const otherWriters = (o: BidOwner): BidWriter[] => (Array.isArray(o.alsoWrites) ? o.alsoWrites : [])

/** Another writer writes this bid too. */
export const isContested = (o: BidOwner): boolean => !!o.contested || otherWriters(o).length > 0

/** "+1" when another writer writes this bid too; null when it has one writer. */
export function contestedMark(o: BidOwner): string | null {
  const n = otherWriters(o).length
  return n > 0 ? `+${n}` : null
}

/** The owner and the others in a few words, for the CSV and the quick filter: "Hourly plan · also Engine". */
export function ownerWords(o: BidOwner): string {
  const also = otherWriters(o)
  const base = o.kind === 'NONE' ? OWNER_NAME.NONE : ownerLabel(o)
  return also.length ? `${base} · also ${also.map(writerName).join(', ')}` : base
}

/** The chip's hover line and accessible name. */
export function ownerHint(o: BidOwner): string {
  const also = otherWriters(o)
  const base = soleHint(o)
  return also.length ? `${base} · also: ${also.map(writerName).join(', ')}` : base
}

function soleHint(o: BidOwner): string {
  const name = o.name?.trim()
  switch (o.kind) {
    case 'BRAIN': return 'The brain sets this bid'
    case 'RULE': return name ? `Rule “${name}” sets this bid` : 'A rule sets this bid'
    case 'PLAN': return name ? `Hourly plan “${name}” sets this bid` : 'An hourly plan sets this bid'
    case 'PERSON': return 'You hold this bid: automation leaves it'
    case 'ENGINE': return name ? `Engine “${name}” sets this bid` : 'An engine sets this bid'
    default: return 'No automation sets this bid'
  }
}

export type OwnerTone = 'info' | 'success' | 'neutral'
/** Automatic writers share one tone (the icon tells them apart); you are success; nothing is neutral. */
export const ownerTone = (kind: OwnerKind): OwnerTone => (kind === 'PERSON' ? 'success' : kind === 'NONE' ? 'neutral' : 'info')

/** The owners a direct bid edit may go to: nothing automatic writes over it. */
export const editableOwner = (kind: OwnerKind): boolean => kind === 'PERSON' || kind === 'NONE'

// ── Where a writer is opened (audit S9; Owner 2026-10-10: the Bid page does all its work itself) ─────────────────────

const BID_PAGE = '/marketing/ads/rules-automation/bid'

const marketParam = (market: string | null | undefined): string | null => {
  const m = market?.trim()
  return m && m.toLowerCase() !== 'all' ? m.toUpperCase() : null
}

/** A rule's detail on this page (the Rules view): `?rule=<id>&tab=overview`, in the view's market. */
export function rulePanelHref(ruleId: string, market: string | null | undefined): string {
  const qs = new URLSearchParams()
  const m = marketParam(market)
  if (m) qs.set('market', m)
  qs.set('rule', ruleId)
  qs.set('tab', 'overview')
  return `${BID_PAGE}?${qs}`
}

/**
 * Where a writer opens, never on another page: a rule → its detail on this page (no `/w/<id>` prefix: the workspace
 * `Link` adds it); the Brain → the keyword's own Why tab (`why`); an hourly plan, an engine, you and nothing → their
 * words only (the hover line says who).
 */
export function writerHref(w: Pick<BidWriter, 'kind' | 'id'>, market: string | null | undefined): string | null {
  return w.kind === 'RULE' && w.id ? rulePanelHref(w.id, market) : null
}

/** The Brain opens the keyword's Why tab. */
export const opensWhy = (w: Pick<BidWriter, 'kind'>): boolean => w.kind === 'BRAIN'

/** A writer as the page draws it: its words, its icon kind, where it opens. */
export interface WriterLink { key: string; kind: OwnerKind; name: string; hint: string; href: string | null; why: boolean }

export function writerLinkOf(w: BidWriter, market: string | null | undefined): WriterLink {
  return { key: `${w.kind}:${w.id ?? w.name}`, kind: w.kind, name: writerName(w), hint: soleHint(w), href: writerHref(w, market), why: opensWhy(w) }
}

// ── Owner filter chips ───────────────────────────────────────────────────────────────────────────────────────────────

export type OwnerFilter = OwnerKind | 'ALL'
export interface OwnerChip { key: OwnerFilter; label: string; name: string; count: number }

/** A filter chip needs a word: a lone "—" reads as nothing (cells keep "—"). */
const CHIP_NONE = 'No one'

/** All, then each kind that has bids (or is the one chosen), in the API's order. Counts are the totals'. */
export function ownerChips(totals: Pick<BidTotals, 'bids' | 'owners'> | null, active: OwnerFilter): OwnerChip[] {
  if (!totals) return []
  const kinds = OWNER_KINDS.filter((k) => (totals.owners?.[k] ?? 0) > 0 || k === active)
  return [
    { key: 'ALL', label: 'All', name: 'All', count: totals.bids },
    ...kinds.map((k) => ({ key: k, label: k === 'NONE' ? CHIP_NONE : OWNER_WORD[k], name: OWNER_NAME[k], count: totals.owners?.[k] ?? 0 })),
  ]
}

export const isOwnerFilter = (v: unknown): v is OwnerFilter => v === 'ALL' || (OWNER_KINDS as readonly unknown[]).includes(v)

// ── Match ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const MATCH_WORD: Record<string, string> = {
  EXACT: 'Exact',
  PHRASE: 'Phrase',
  BROAD: 'Broad',
  SEARCH_CLOSE_MATCH: 'Close',
  SEARCH_LOOSE_MATCH: 'Loose',
  PRODUCT_SUBSTITUTES: 'Substitutes',
  PRODUCT_COMPLEMENTS: 'Complements',
  PRODUCT_EXACT: 'Product',
  PRODUCT_SIMILAR: 'Similar',
  PRODUCT_CATEGORY: 'Category',
  SEARCH_RELATED_TO_YOUR_BRAND: 'Brand',
  SEARCH_RELATED_TO_YOUR_LANDING_PAGES: 'Landing pages',
}

/** Amazon's match type in one word; an unknown one in plain case; none is a dash. */
export function matchWord(match: string | null | undefined): string {
  const m = (match ?? '').trim()
  if (!m || m.toUpperCase() === 'UNKNOWN') return '—'
  const known = MATCH_WORD[m.toUpperCase()]
  if (known) return known
  if (/^ASIN/i.test(m)) return 'Product'
  const words = m.replace(/[_-]+/g, ' ').toLowerCase().trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

// ── Filter and search ────────────────────────────────────────────────────────────────────────────────────────────────

export interface BidFilter { owner: OwnerFilter; search: string }
export const NO_BID_FILTER: BidFilter = { owner: 'ALL', search: '' }
export const isBidFiltered = (f: BidFilter): boolean => f.owner !== 'ALL' || f.search.trim() !== ''

/** Every word of the search must be in the keyword, its campaign, ad group or portfolio, or who sets it. */
export function rowMatches(row: BidRow, f: BidFilter): boolean {
  if (f.owner !== 'ALL' && row.owner.kind !== f.owner) return false
  const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return true
  const hay = [row.text, row.campaign.name, row.adGroup.name, row.portfolio?.name ?? '', ownerWords(row.owner), matchWord(row.match)]
    .join(' ')
    .toLowerCase()
  return words.every((w) => hay.includes(w))
}

// ── What the page's tiles show (M1: the Bid page's tiles above this view filter it and read its totals) ─────────────

export const BIDS_SHOWS = ['changed7d', 'contested', 'waiting'] as const
/** A tile's filter: bids changed in 7 d · bids two writers write · bids with an ask waiting for a person. */
export type BidsShow = (typeof BIDS_SHOWS)[number]
export const isBidsShow = (v: unknown): v is BidsShow => (BIDS_SHOWS as readonly unknown[]).includes(v)

/** Does the row belong to the tile's filter? `waiting`: the target ids with an ask waiting (null = not read: none). */
export function showMatches(row: BidRow, show: BidsShow | null | undefined, waiting: ReadonlySet<string> | null): boolean {
  if (!show) return true
  if (show === 'changed7d') return row.changes7d > 0
  if (show === 'contested') return isContested(row.owner)
  return !!waiting?.has(row.targetId)
}

/** The view's numbers, for the page's tiles (`onTotals`). Never narrowed by the view's own filters. */
export interface BidsTotals {
  /** Bids in the view's scope. */
  bids: number
  /** Bids with at least one change in 7 d (the server's count). */
  changed7d: number
  /** Bids another writer writes too. */
  contested: number
  /** Bids with an ask waiting for a person; null when the asks could not be read. */
  waiting: number | null
  /** Bids per owner kind (the server's counts). */
  owners: Record<OwnerKind, number>
  /** The read was capped: `contested` and `waiting` count the bids read. */
  truncated: boolean
}

export function bidsTotalsOf(answer: BidsAnswer, waiting: ReadonlySet<string> | null): BidsTotals {
  return {
    bids: answer.totals.bids,
    changed7d: answer.totals.changed7d,
    contested: answer.rows.filter((r) => isContested(r.owner)).length,
    waiting: waiting ? answer.rows.filter((r) => waiting.has(r.targetId)).length : null,
    owners: answer.totals.owners,
    truncated: answer.totals.truncated,
  }
}

/** The grid's empty words when nothing shows. */
export function emptyWords(show: BidsShow | null | undefined, filtered: boolean, any: boolean): { title: string; clear: boolean } {
  if (filtered && any) return { title: 'No bid matches', clear: true }
  if (show === 'changed7d') return { title: `No bid changed in ${WEEK}`, clear: false }
  if (show === 'contested') return { title: 'No bid has two writers', clear: false }
  if (show === 'waiting') return { title: 'Nothing waiting', clear: false }
  return { title: 'No live bids', clear: false }
}

// ── Money and time (the page's one helper: _shared/format.ts) ───────────────────────────────────────────────────────

/** The row's currency: its own, else its market's, else the view's market's. */
export function rowCurrency(row: Pick<BidRow, 'currency' | 'market'>, viewMarket: string | null | undefined): string {
  const own = row.currency?.trim()
  if (own) return own.toUpperCase()
  return currencyOf(row.market || marketParam(viewMarket))
}

/** The Last change cell: "−€0.03 · 2 h ago", and its hover line "€0.18 → €0.15 · Brain · 10 Oct, 08:00". */
export function lastChangeWords(lc: BidRow['lastChange'], currency: string, now: number = Date.now()): { text: string; title: string } | null {
  if (!lc) return null
  const age = relWords(lc.at, now)
  const known = typeof lc.from === 'number' && typeof lc.to === 'number'
  const text = known ? `${signedMoney(lc.to! - lc.from!, currency)} · ${age}` : age
  const step = known ? `${money(lc.from!, currency)} → ${money(lc.to!, currency)} · ` : ''
  const by = lc.by ? writerName({ kind: lc.by.kind, name: lc.by.name, id: lc.by.id ?? null }) : 'Unknown'
  return { text, title: `${step}${by === OWNER_WORD.NONE ? 'Unknown' : by} · ${whenWords(lc.at)}` }
}

/** Where the brain aims against the bid now: up, down, the same, or nothing to say. */
export function aimDirection(row: Pick<BidRow, 'bidNow' | 'brainAim'>): 'up' | 'down' | 'same' | null {
  if (typeof row.brainAim !== 'number' || typeof row.bidNow !== 'number') return null
  return row.brainAim > row.bidNow ? 'up' : row.brainAim < row.bidNow ? 'down' : 'same'
}

/** "24 %", or a dash when there were no sales (no ACoS) or it is hidden. */
export const acosText = (pct: number | null | undefined): string => (typeof pct === 'number' && Number.isFinite(pct) ? `${pct} %` : '—')

/** The 7-day results cell: three numbers, and the hover line that names them (spend only when this person sees it). */
export function resultsWords(d7: BidRow['d7'], currency: string): { clicks: string; orders: string; acos: string; title: string } {
  const plural = (n: number, one: string) => `${n.toLocaleString('en-IE')} ${one}${n === 1 ? '' : 's'}`
  const parts = [plural(d7.clicks, 'click'), plural(d7.orders, 'order'), `ACoS ${acosText(d7.acosPct)}`]
  if (typeof d7.spend === 'number') parts.push(`spend ${money(d7.spend, currency)}`)
  return { clicks: d7.clicks.toLocaleString('en-IE'), orders: d7.orders.toLocaleString('en-IE'), acos: acosText(d7.acosPct), title: `${WEEK}: ${parts.join(' · ')}` }
}

/**
 * The bid the night floor gives back in the morning: the spark's last reading is the bid now with the floor left out
 * (bid-owner.ts sparkOf). Null when the bid is not at the floor or the line is hidden.
 */
export function floorGivesBack(row: Pick<BidRow, 'nightFloor' | 'spark'>): number | null {
  if (!row.nightFloor || !Array.isArray(row.spark) || !row.spark.length) return null
  const last = row.spark[row.spark.length - 1]
  return typeof last === 'number' && Number.isFinite(last) ? last : null
}

// ── A direct bid edit ───────────────────────────────────────────────────────────────────────────────────────────────

/** Nexus refuses a bid under 5 cents (the API's bid_below_floor_5_cents); Amazon's ceiling in a euro market. */
export const MIN_BID_CENTS = 5
export const MAX_BID_CENTS = 100_000

/** "0,15" or "0.15" → 15; "" → null; anything else → NaN. */
export function parseBid(text: string): number | null {
  const t = text.trim().replace(',', '.')
  if (t === '') return null
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return Number.NaN
  return Math.round(Number(t) * 100)
}

/** Why a typed bid cannot be sent, or null. */
export function bidProblem(cents: number | null, currency: string): string | null {
  if (cents === null) return 'Type a bid'
  if (!Number.isFinite(cents)) return 'Not a bid'
  if (cents < MIN_BID_CENTS) return `At least ${money(MIN_BID_CENTS, currency)}`
  if (cents > MAX_BID_CENTS) return `At most ${money(MAX_BID_CENTS, currency)}`
  return null
}

/**
 * Why this person may not set this bid by hand, or null when they may. Only where nothing automatic writes over it
 * (You · nothing); the others are held with the way out.
 */
export function editHeldReason(row: Pick<BidRow, 'owner' | 'bidNow'>, canEdit: boolean): string | null {
  if (!canEdit) return 'Needs the ads campaigns permission'
  if (typeof row.bidNow !== 'number') return 'Bids are hidden for you'
  if (!editableOwner(row.owner.kind)) return `${ownerLabel(row.owner)} sets this bid · lock the campaign bids first`
  return null
}

// ── Auto / Manual per keyword (KEYWORD-AUTO.md: Manual = a person's hold with no end; Auto = handed back) ──────────

export const AUTO_WORDS = { on: 'Auto', off: 'Manual' } as const

/** Why this keyword's switch cannot move, or null. Honest when no engine runs its campaign. */
export function autoHeld(row: Pick<BidRow, 'auto' | 'autoWhy'>, canBids: boolean): string | null {
  if (row.auto === 'NONE') return row.autoWhy?.trim() || 'No engine runs this campaign'
  if (!canBids) return 'Needs the ads bids permission'
  return null
}

/** The engine that runs it, in a word: the Brain, else "the engine". */
const runnerOf = (o: BidOwner): string => (o.kind === 'BRAIN' ? 'The brain' : 'The engine')

/** The review's line for a switch: Auto → Manual, or back. Handing back lets automation do more (counted). */
export function modeChangeLine(row: Pick<BidRow, 'targetId' | 'text' | 'owner'>, next: 'AUTO' | 'MANUAL'): { id: string; what: string; now: string; next: string; note: string; raise: boolean } {
  return {
    id: row.targetId,
    what: 'Auto',
    now: next === 'AUTO' ? AUTO_WORDS.off : AUTO_WORDS.on,
    next: next === 'AUTO' ? AUTO_WORDS.on : AUTO_WORDS.off,
    note: next === 'MANUAL' ? `${runnerOf(row.owner)} stops moving this keyword until you switch it back to Auto` : `${runnerOf(row.owner)} moves this keyword again from its next run`,
    raise: next === 'AUTO',
  }
}

// ── The grid's row ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A grid row: the bid, its links as lists (the DS entity-links cell), its currency, and where its writers live. */
export interface BidGridRow extends BidRow {
  portfolios: Ref[]
  campaigns: Ref[]
  adGroups: Ref[]
  currency: string
  /** The owner's rule detail on this page; null for every other owner. */
  ownerHref: string | null
  /** The owner is the Brain: its chip opens the keyword's Why tab. */
  ownerWhy: boolean
  /** Every other writer, with where it opens. */
  others: WriterLink[]
  /** The Auto switch's value: an engine runs it (false for Manual and for no engine). */
  autoOn: boolean
  /** Why the Auto switch cannot move for this person (the view sets it: no engine, no permission); null = it may. */
  autoLock?: string | null
  /** Amazon's suggested bid for this row (the view sets it from its ad group's read). */
  suggested?: SuggestedCell
}

export function gridRowOf(row: BidRow, viewMarket: string | null | undefined): BidGridRow {
  return {
    ...row,
    portfolios: row.portfolio ? [row.portfolio] : [],
    campaigns: [row.campaign],
    adGroups: [row.adGroup],
    currency: rowCurrency(row, viewMarket),
    ownerHref: writerHref(row.owner, viewMarket),
    ownerWhy: opensWhy(row.owner),
    others: otherWriters(row.owner).map((w) => writerLinkOf(w, viewMarket)),
    autoOn: row.auto === 'AUTO',
  }
}

/** The bids view's read: the scope as query words (an empty market or 'all' = every market). */
export function bidsQuery(scope: { market?: string | null; productId?: string | null; campaignId?: string | null; adGroupId?: string | null }): string {
  const qs = new URLSearchParams()
  const market = marketParam(scope.market)
  if (market) qs.set('market', market)
  if (scope.productId) qs.set('productId', scope.productId)
  if (scope.campaignId) qs.set('campaignId', scope.campaignId)
  if (scope.adGroupId) qs.set('adGroupId', scope.adGroupId)
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** The toolbar count: "70 bids", or "Showing 3 of 70 bids" while a filter narrows them. */
export function countWords(shown: number, total: number, filtered: boolean): string {
  const noun = (n: number) => `${n.toLocaleString('en-IE')} ${n === 1 ? 'bid' : 'bids'}`
  return filtered ? `Showing ${shown.toLocaleString('en-IE')} of ${noun(total)}` : noun(total)
}
