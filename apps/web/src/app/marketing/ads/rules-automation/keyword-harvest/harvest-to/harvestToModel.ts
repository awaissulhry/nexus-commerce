/**
 * "Harvest to…" — the window's rules and words (Keyword Harvest page, lane HTO, 2026-10-11). Pure, tested in Node
 * (`harvestToModel.vitest.test.ts`). The window (`HarvestToWindow.tsx`) draws; this decides.
 *
 *   scope      the terms' products and markets: one destination serves the terms of ONE product in ONE market (a harvest
 *              goes into its own product's campaigns); otherwise each term goes to its own suggested place.
 *   body       the POST /preview body: every term (never dropped — the server answers each), `to` (absent = its
 *              suggested place; a term whose suggested place is a new campaign gets its product's new campaign, one per
 *              product), match, the bids the person typed, the source switch only when the person touched it.
 *   review     the preview's steps as one table in three tabs (Keywords · Negatives · New campaign), the counted primary
 *              ("Harvest 3 · create 1"), the terms left out as warnings.
 *   done       the change set's state in words: approved (it goes to Amazon after the short undo window), waiting for an
 *              approval, or taken back; "3 harvested · 1 created · 6 blocked".
 *   undo       the harvests of this change set (once it ran): each keyword paused, each block it added lifted.
 *
 * Money is in minor units of the rows' currency (`bid/_shared/format.ts` words). Nothing here writes.
 */
import { currencyOf, money, moneyText } from '../../bid/_shared/format'
import { DEFAULT_NEW_KEY, destinationPlaces, negateAtSourceFor, suggestedTo } from '../../_shared/destinationOptions'
import type {
  ApplyAnswer, CandidateHold, HarvestCandidateRow, HarvestDestinations, HarvestMatch, HarvestTo, HistoryRow, NewCampaignInput,
  NewPortfolioInput, PreviewAnswer, PreviewBody, PreviewItemInput, PreviewStep, Ref, RequestAnswer, RequestStatus,
} from '../_shared/types'

/** One change set takes at most this many terms (POST /preview `items`). */
export const MAX_TERMS = 200
/** At most this many new campaigns in one change set. */
export const MAX_NEW_CAMPAIGNS = 20
/** The key of the one new campaign the person describes in the window. */
export const NEW_CAMPAIGN_KEY = DEFAULT_NEW_KEY
/** The key of the one new portfolio the person describes in the window. */
export const NEW_PORTFOLIO_KEY = 'pf'
/** Amazon's lowest daily budget. */
export const MIN_BUDGET_CENTS = 100
export const MIN_BID_CENTS = 2
export const MAX_BID_CENTS = 10_000

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const matchWord = (m: HarvestMatch | string | null | undefined) => (m === 'PHRASE' ? 'Phrase' : 'Exact')

// ── ids and scope ────────────────────────────────────────────────────────────────────────────────────────────────────

/** `market|productId|term` — split on the first two `|` (a term may hold one). */
export function candidateParts(id: string): { market: string; productId: string; term: string } | null {
  const a = id.indexOf('|')
  const b = a < 0 ? -1 : id.indexOf('|', a + 1)
  if (a <= 0 || b <= a + 1 || b === id.length - 1) return null
  return { market: id.slice(0, a), productId: id.slice(a + 1, b), term: id.slice(b + 1) }
}

export interface HarvestScope {
  /** The one market of the terms, else null. */
  market: string | null
  /** The one product (family root) of the terms, else null. */
  productId: string | null
  productName: string | null
  markets: string[]
  products: number
  /** Why one place cannot serve them all (several products or markets); null when it can. */
  held: string | null
}

/** Which product(s) and market(s) the terms are of; one place serves them only when there is one of each. */
export function scopeOf(rows: readonly HarvestCandidateRow[]): HarvestScope {
  const markets = new Set<string>()
  const products = new Map<string, string>()
  for (const r of rows) {
    const p = candidateParts(r.id)
    markets.add(p?.market ?? r.market)
    products.set(p?.productId ?? r.product.id, r.product.name)
  }
  const m = [...markets]
  const single = m.length === 1 && products.size === 1
  const [productId, productName] = single ? [...products][0] : [null, null]
  const held = !rows.length ? 'No terms to harvest'
    : m.length > 1 ? `Each to its own place · ${m.length} markets`
      : products.size > 1 ? `Each to its own place · ${products.size} products`
        : null
  return { market: m.length === 1 ? m[0] : null, productId, productName, markets: m.sort(), products: products.size, held }
}

/** A row's currency: its own, else its market's (R5: one currency per market, never the first row's for all). */
export const currencyOfRow = (r: Pick<HarvestCandidateRow, 'currency' | 'market'>): string => r.currency ?? currencyOf(r.market)

/** The rows' one currency, or null when they bill in more than one (then "Bid all €x" is held). */
export function oneCurrency(rows: readonly Pick<HarvestCandidateRow, 'currency' | 'market'>[]): string | null {
  const all = new Set(rows.map(currencyOfRow))
  return all.size === 1 ? [...all][0] : null
}

/** The window's currency for one market (a new campaign's budget, a portfolio cap): that market's rows', else its own. */
export function currencyOfRows(rows: readonly HarvestCandidateRow[], market: string | null | undefined): string {
  const mine = market ? rows.filter((r) => r.market === market) : rows
  return mine.find((r) => r.currency)?.currency ?? currencyOf(market ?? rows[0]?.market ?? null)
}

// ── money and percent typed by a person ──────────────────────────────────────────────────────────────────────────────

export type Parsed = { kind: 'empty' } | { kind: 'ok'; value: number } | { kind: 'bad' }

/** "0.35", "0,35", "€ 1", "1.5" → cents. Empty is not a number; anything else unreadable is bad. */
export function parseMoney(text: string | null | undefined): Parsed {
  const t = (text ?? '').replace(/[€£$\s]/g, '').replace(/^(?:EUR|GBP|SEK|PLN)/i, '').replace(',', '.')
  if (!t) return { kind: 'empty' }
  if (!/^\d+(?:\.\d{0,2})?$|^\.\d{1,2}$/.test(t)) return { kind: 'bad' }
  return { kind: 'ok', value: Math.round(Number(t) * 100) }
}

/** "10", "+10", "-5", "12.5 %" → percent. */
export function parsePercent(text: string | null | undefined): Parsed {
  const t = (text ?? '').replace(/[%\s]/g, '').replace(',', '.')
  if (!t) return { kind: 'empty' }
  if (!/^[+\-−]?\d+(?:\.\d+)?$/.test(t)) return { kind: 'bad' }
  return { kind: 'ok', value: Number(t.replace('−', '-')) }
}

/** Cents as a person types them: "0.35" (no currency mark: the field shows it). */
export const moneyInput = (cents: number): string => (cents / 100).toFixed(2)

/** A bid outside Amazon's band, or unreadable, in words; null when it is fine. */
export function bidProblem(text: string | null | undefined, currency: string): string | null {
  const p = parseMoney(text)
  if (p.kind === 'empty') return null
  if (p.kind === 'bad') return 'Type an amount, like 0.35'
  if (p.value < MIN_BID_CENTS || p.value > MAX_BID_CENTS) return `Between ${money(MIN_BID_CENTS, currency)} and ${money(MAX_BID_CENTS, currency)}`
  return null
}

// ── the term table ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface TermRow {
  id: string
  term: string
  /** The row's own currency (its market's): its bid field and amounts are in it. */
  currency: string
  orders: number
  /** "18 %", "5.5 %"; a dash when there is none or it is hidden. */
  acos: string
  /** The term's cost per click ("€0.40"); a dash when there is none or it is hidden. */
  cpc: string
  /** Why the bid is what it is, in a few words, with the CPC beside it (the bid's hover). */
  bidHint: string | null
  /** The bid field's text: the person's, else the start bid, else empty (the server picks). */
  bidText: string
  bidProblem: string | null
  /** The start bid is hidden from this person (no ad-spend permission). */
  moneyHidden: boolean
  held: CandidateHold | null
  goesTo: Array<Ref | null> | null
}

/** Terms the engine will not harvest as they stand, in the server's words where it gives them (else by its state). */
const STATE_HOLDS: Partial<Record<HarvestCandidateRow['state'], CandidateHold>> = {
  WAITING: { kind: 'record', label: 'Waiting', reason: 'A harvest of it waits for an approval already.' },
  IN_FLIGHT: { kind: 'record', label: 'Being sent', reason: 'A harvest of it is on its way to Amazon.' },
  HARVESTED: { kind: 'record', label: 'Harvested', reason: 'This term was harvested already: its keyword is its one home (undo it first to move it).' },
  AT_HOME: { kind: 'home', label: 'Already a keyword', reason: 'It is a keyword of this product already: one owner per term.' },
  OWNED_BY_SIBLING: { kind: 'sibling', label: 'Other product', reason: 'Another product of the family leads this term in the market.' },
}

/** Why a term will not be harvested as it stands: its hold, else its state's; null when it can go. */
export function rowHold(row: Pick<HarvestCandidateRow, 'heldBy' | 'state'>): CandidateHold | null {
  return row.heldBy ?? STATE_HOLDS[row.state] ?? null
}

/** "18 %", "5.5 %" (acosPct is a percent); a dash when there is none. */
export function acosWords(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return '—'
  return `${pct >= 10 ? Math.round(pct) : Math.round(pct * 10) / 10} %`
}

/** Where a row would go by itself (its suggested place): Portfolio › Campaign › Ad group, or the new campaign's name. */
export function suggestedPath(row: HarvestCandidateRow): Array<Ref | null> | null {
  const d = row.destination
  if (!d) return null
  if (d.kind === 'existing') return [d.portfolio, d.campaign, d.adGroup]
  return [d.plan.portfolio, { id: `new:${row.product.id}`, name: `New · ${d.plan.name}` }]
}

export function termRowsOf(rows: readonly HarvestCandidateRow[], bids: Readonly<Record<string, string>>): TermRow[] {
  return rows.map((r) => {
    const currency = currencyOfRow(r)
    const own = bids[r.id]
    const start = r.startBidCents
    const bidText = own ?? (typeof start === 'number' ? moneyInput(start) : '')
    const cpc = r.metrics.cpcCents
    const why = own === undefined ? bidWhyWords(r.bidWhy) : 'Your bid'
    return {
      id: r.id, term: r.term, currency, orders: r.metrics.orders, acos: acosWords(r.metrics.acosPct), cpc: moneyText(cpc, currency), bidText,
      bidProblem: own === undefined ? null : bidProblem(own, currency),
      bidHint: [why, typeof cpc === 'number' ? `CPC now ${money(cpc, currency)}` : null].filter(Boolean).join(' · ') || null,
      moneyHidden: !('startBidCents' in r), held: rowHold(r), goesTo: suggestedPath(r),
    }
  })
}

/** "All to €x": every row's bid. */
export function bidsAllTo(rows: readonly Pick<HarvestCandidateRow, 'id'>[], cents: number): Record<string, string> {
  const v = moneyInput(Math.min(MAX_BID_CENTS, Math.max(MIN_BID_CENTS, Math.round(cents))))
  return Object.fromEntries(rows.map((r) => [r.id, v]))
}

/** "CPC +x %": each row's own cost per click, raised (or lowered) by x %; a row without a CPC keeps its bid. */
export function bidsFromCpc(rows: readonly Pick<HarvestCandidateRow, 'id' | 'metrics'>[], pct: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) {
    const cpc = r.metrics.cpcCents
    if (typeof cpc !== 'number' || !Number.isFinite(cpc) || cpc <= 0) continue
    out[r.id] = moneyInput(Math.min(MAX_BID_CENTS, Math.max(MIN_BID_CENTS, Math.round(cpc * (1 + pct / 100)))))
  }
  return out
}

// ── the new campaign and portfolio the person describes ──────────────────────────────────────────────────────────────

export type PortfolioChoice = { id: string } | { newPortfolio: string } | null

export interface NewCampaignDraft {
  name: string
  budget: string
  portfolio: PortfolioChoice
}
export interface NewPortfolioDraft { name: string; cap: string }

/** The SP Super Wizard's own default daily budget for a new campaign (`campaign-builder/sp-super-wizard/CampaignSetup.tsx`
 *  `DEFAULT_BUDGET = 10`: 10.00 a day). */
export const WIZARD_DEFAULT_BUDGET_CENTS = 1000
/** A new campaign's budget is at least this many times its highest start bid, so a day holds a few clicks. */
export const BUDGET_BIDS = 10

/**
 * A new campaign's starting daily budget (functional walk: the server's 1.00 sat below the start bids, so the defaults
 * could never harvest). The highest of: the server's proposal (a playbook's budget, when it has one), the SP Super
 * Wizard's default (10.00), and 10 × the highest start bid of its terms, rounded up to a whole unit.
 */
export function defaultBudgetCents(proposedCents: number | null | undefined, bidCents: readonly (number | null | undefined)[]): number {
  const top = Math.max(0, ...bidCents.filter((b): b is number => typeof b === 'number' && Number.isFinite(b)))
  return Math.max(MIN_BUDGET_CENTS, proposedCents ?? 0, WIZARD_DEFAULT_BUDGET_CENTS, Math.ceil((top * BUDGET_BIDS) / 100) * 100)
}

/** The new campaign's fields as the server proposes them (the SP Super Wizard's naming, the product's portfolio), with a
 *  budget its terms' start bids fit in. */
export function newCampaignDefaults(tree: HarvestDestinations | null, bidCents: readonly (number | null | undefined)[] = []): NewCampaignDraft {
  const nc = tree?.newCampaign
  const portfolio = nc?.portfolio && !nc.portfolio.id.startsWith('local-pf-') ? { id: nc.portfolio.id } : null
  return { name: nc?.name ?? '', budget: moneyInput(defaultBudgetCents(nc?.dailyBudgetCents, bidCents)), portfolio }
}

/** A portfolio that lives in Nexus only: Amazon refuses a campaign born in it. */
export const isLocalPortfolio = (id: string): boolean => id.startsWith('local-pf-')

/** What is wrong with the new campaign / portfolio fields, first problem only; null when they can go. */
export function draftProblem(nc: NewCampaignDraft | null, np: NewPortfolioDraft | null, currency: string): string | null {
  if (nc) {
    if (!nc.name.trim()) return 'Name the new campaign'
    if (nc.name.trim().length > 128) return 'Name: at most 128 characters'
    const b = parseMoney(nc.budget)
    if (b.kind !== 'ok' || b.value < MIN_BUDGET_CENTS) return `Budget: at least ${money(MIN_BUDGET_CENTS, currency)} a day`
    if (b.value > 10_000_000) return `Budget: at most ${money(10_000_000, currency)} a day`
  }
  if (np && nc?.portfolio && 'newPortfolio' in nc.portfolio) {
    if (!np.name.trim()) return 'Name the new portfolio'
    if (np.name.trim().length > 100) return 'Portfolio name: at most 100 characters'
    const c = parseMoney(np.cap)
    if (c.kind === 'bad' || (c.kind === 'ok' && c.value < 100)) return `Monthly cap: at least ${money(100, currency)}, or leave it empty`
    if (c.kind === 'ok' && c.value > 100_000_000) return `Monthly cap: at most ${money(100_000_000, currency)}`
  }
  return null
}

// ── the preview body ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface BodyInput {
  rows: readonly HarvestCandidateRow[]
  /** One place for every term; null = each to its own suggested place. */
  to: HarvestTo | null
  match: HarvestMatch
  /** The source switch; null = the person did not touch it (the server's default and the Owner's saved setting win). */
  negate: boolean | null
  /** The bids the person typed (text by candidate id). */
  bids: Readonly<Record<string, string>>
  /** The new campaign of `to: { newCampaign }` (the window's one). */
  newCampaign: NewCampaignDraft | null
  newPortfolio: NewPortfolioDraft | null
}

/** The POST /preview body. Every term is sent (the server answers each: harvested, or refused with why). */
export function buildPreviewBody(input: BodyInput): PreviewBody {
  const { rows, to, match, negate, bids } = input
  const items: PreviewItemInput[] = []
  const newCampaigns: NewCampaignInput[] = []
  const newPortfolios: NewPortfolioInput[] = []
  // Each term to its own place: a term whose suggested place is a new campaign gets its product's in ITS market (R1: one
  // per market and product — terms of two markets never share a new campaign).
  const perProduct = new Map<string, string>()
  for (const r of rows.slice(0, MAX_TERMS)) {
    const item: PreviewItemInput = { candidateId: r.id, match }
    const typed = parseMoney(bids[r.id])
    if (bids[r.id] !== undefined && typed.kind === 'ok') item.bidCents = typed.value
    if (negate !== null) item.negateSource = negate
    if (to) item.to = to
    else if (r.destination?.kind === 'new') {
      const parts = candidateParts(r.id)
      const productId = parts?.productId ?? r.product.id
      const where = `${parts?.market ?? r.market}|${productId}`
      let key = perProduct.get(where)
      if (!key && newCampaigns.length < MAX_NEW_CAMPAIGNS) {
        key = `new-${newCampaigns.length + 1}`
        perProduct.set(where, key)
        const plan = r.destination.plan
        newCampaigns.push({
          key, productId, match,
          // The proposed name is the plan's match; another match takes the server's own name for it.
          ...(r.destination.match === match ? { name: plan.name } : {}),
          dailyBudgetCents: defaultBudgetCents(plan.dailyBudgetCents, rows.filter((x) => x.destination?.kind === 'new' && `${candidateParts(x.id)?.market ?? x.market}|${candidateParts(x.id)?.productId ?? x.product.id}` === where)
            .map((x) => { const t = parseMoney(bids[x.id]); return bids[x.id] !== undefined && t.kind === 'ok' ? t.value : x.startBidCents })),
          portfolio: plan.portfolio && !isLocalPortfolio(plan.portfolio.id) ? { id: plan.portfolio.id } : null,
        })
      }
      if (key) item.to = { newCampaign: key }
    }
    items.push(item)
  }
  if (to && 'newCampaign' in to && input.newCampaign && rows.length) {
    const nc = input.newCampaign
    const productId = candidateParts(rows[0].id)?.productId ?? rows[0].product.id
    const budget = parseMoney(nc.budget)
    newCampaigns.push({
      key: to.newCampaign, productId, match, name: nc.name.trim(),
      ...(budget.kind === 'ok' ? { dailyBudgetCents: Math.max(MIN_BUDGET_CENTS, budget.value) } : {}),
      portfolio: nc.portfolio,
    })
    if (nc.portfolio && 'newPortfolio' in nc.portfolio && input.newPortfolio) {
      const cap = parseMoney(input.newPortfolio.cap)
      newPortfolios.push({ key: nc.portfolio.newPortfolio, name: input.newPortfolio.name.trim(), ...(cap.kind === 'ok' ? { capMonthlyCents: cap.value } : {}) })
    }
  }
  return { items, ...(newCampaigns.length ? { newCampaigns } : {}), ...(newPortfolios.length ? { newPortfolios } : {}) }
}

/**
 * The person's pick of the source switch, as stored (R3): a pick that equals what the place would do by itself is no
 * choice at all (null), so ticking the box off and on again never turns into "block everywhere" over a saved "keep the
 * source". Only a deliberate pick away from the default is sent.
 */
export const sourceChoice = (checked: boolean, defaultOn: boolean): boolean | null => (checked === defaultOn ? null : checked)

/** Terms whose saved place keeps the source running (the server's own plan for each, before any pick). */
export function keptBySaved(rows: readonly Pick<HarvestCandidateRow, 'sources'>[]): number {
  return rows.filter((r) => r.sources.some((s) => s.action === 'kept' && /saved harvest place/i.test(s.why))).length
}

/** The source switch as shown: the person's choice, else the destination's (a saved "keep the source" wins, said so). */
export function sourceSwitch(tree: HarvestDestinations | null, to: HarvestTo | null, match: HarvestMatch, chosen: boolean | null): { on: boolean; why: string | null } {
  const d = negateAtSourceFor(tree, to, match)
  if (chosen === null || chosen === d.on) return d
  return { on: chosen, why: chosen ? 'On for this harvest: your saved setting says off' : null }
}

/**
 * Where "one place for all" starts: the server's suggestion for the product, else the place most of the terms would go
 * by themselves (when the tree lists it and does not hold it), else the proposed new campaign when every term needs one,
 * else nothing (the person picks).
 */
export function defaultTo(tree: HarvestDestinations | null, rows: readonly HarvestCandidateRow[]): HarvestTo | null {
  if (!tree) return null
  const s = suggestedTo(tree)
  if (s) return s
  const usable = new Set(destinationPlaces(tree).filter((p) => !p.adGroup.held).map((p) => p.adGroup.id))
  const count = new Map<string, number>()
  for (const r of rows) if (r.destination?.kind === 'existing' && usable.has(r.destination.adGroup.id)) count.set(r.destination.adGroup.id, (count.get(r.destination.adGroup.id) ?? 0) + 1)
  const best = [...count].sort((a, b) => b[1] - a[1])[0]
  if (best) return { adGroupId: best[0] }
  if (rows.length && rows.every((r) => r.destination?.kind === 'new') && !tree.newCampaign.held) return { newCampaign: NEW_CAMPAIGN_KEY }
  return null
}

/** Why "Review" cannot run yet, in words; null when it can. */
export function setupHeld(a: { rows: number; mode: 'suggested' | 'choose'; single: boolean; to: HarvestTo | null; draft: string | null; bid: { term: string; problem: string } | null }): string | null {
  if (!a.rows) return 'No terms to harvest'
  if (a.mode === 'choose' && a.single && !a.to) return 'Choose where they go'
  if (a.draft) return a.draft
  if (a.bid) return `Bid of “${a.bid.term}”: ${a.bid.problem}`
  return null
}

// ── the review ───────────────────────────────────────────────────────────────────────────────────────────────────────

export const REVIEW_GROUPS = [
  { id: 'keywords', label: 'Keywords' },
  { id: 'negatives', label: 'Negatives' },
  { id: 'campaign', label: 'New campaign' },
  { id: 'portfolio', label: 'New portfolio' },
] as const
export type ReviewGroupId = (typeof REVIEW_GROUPS)[number]['id']

/** One row of a review table, in data (the window draws `where` as links). */
export interface HarvestReviewRow {
  id: string
  group: ReviewGroupId
  kind: PreviewStep['kind'] | 'pause' | 'lift'
  /** Portfolio › Campaign › Ad group (a step without a page is plain text). */
  where: Array<Ref | null>
  what: string
  now: string
  next: string
  note?: string
}

/** A new entity of this change set (`new:<key>`) has no page yet. */
const plainNew = (ref: Ref | null | undefined): Ref | null => (!ref ? null : ref.id.startsWith('new:') ? { id: ref.id, name: ref.name } : ref)

/**
 * The preview's steps as the review's rows: keywords, negatives, the new campaign (a portfolio's cap folded into it).
 * A keyword's "Now" is the term's cost per click (S3: a start bid far above it says why in its note).
 */
export function reviewRowsOf(
  preview: PreviewAnswer, currency: string, cpcById: ReadonlyMap<string, number | null | undefined> = new Map(),
  currencyById: ReadonlyMap<string, string> = new Map(),
): HarvestReviewRow[] {
  const whyById = new Map(preview.items.map((i) => [i.candidateId, i.bidWhy]))
  // R5 — each amount in its own market's money: a term's by its row; a new campaign's and portfolio's by its terms'.
  const moneyOf = (candidateId: string | undefined) => (candidateId ? currencyById.get(candidateId) : undefined) ?? currency
  const campaignMoney = new Map<string, string>()
  for (const x of preview.steps) if ((x.kind === 'keyword' || x.kind === 'enable') && x.campaign && !campaignMoney.has(x.campaign.id)) campaignMoney.set(x.campaign.id, moneyOf(x.candidateId))
  const portfolioMoney = new Map<string, string>()
  for (const x of preview.steps) if (x.kind === 'campaign' && x.portfolio && x.campaign && campaignMoney.has(x.campaign.id)) portfolioMoney.set(x.portfolio.id, campaignMoney.get(x.campaign.id)!)
  const caps = new Map(preview.steps.filter((s) => s.kind === 'portfolioCap').map((s) => [s.portfolio?.id ?? '', s.capMonthlyCents]))
  const out: HarvestReviewRow[] = []
  for (const s of preview.steps) {
    const id = `s${s.i}`
    switch (s.kind) {
      case 'keyword':
      case 'enable':
      {
        const cur = moneyOf(s.candidateId)
        const cpc = s.candidateId ? cpcById.get(s.candidateId) : undefined
        const why = s.candidateId ? bidWhyWords(whyById.get(s.candidateId) ?? null) : null
        out.push({
          id, group: 'keywords', kind: s.kind, where: [plainNew(s.campaign), plainNew(s.adGroup)], what: s.term ?? '',
          now: s.kind === 'enable' ? 'Paused' : typeof cpc === 'number' ? `CPC ${money(cpc, cur)}` : '—',
          next: `${matchWord(s.match)}${typeof s.bidCents === 'number' ? ` · ${money(s.bidCents, cur)}` : ''}`,
          ...(s.kind === 'enable' ? { note: why ? `On again · ${why}` : 'On again' } : why ? { note: why } : {}),
        })
        break
      }
      case 'sourceNegative':
      case 'funnelNegative':
        out.push({
          id, group: 'negatives', kind: s.kind, where: [plainNew(s.campaign), plainNew(s.adGroup)], what: s.term ?? '', now: '—',
          next: `Negative ${(s.match ?? 'EXACT').toLowerCase()}`, note: s.kind === 'sourceNegative' ? 'Where found' : 'Wider match',
        })
        break
      case 'portfolio': {
        const cap = caps.get(s.portfolio?.id ?? '')
        const cur = portfolioMoney.get(s.portfolio?.id ?? '') ?? currency
        out.push({ id, group: 'portfolio', kind: s.kind, where: [plainNew(s.portfolio)], what: 'Portfolio', now: '—', next: typeof cap === 'number' ? `New · ${money(cap, cur)} a month` : 'New' })
        break
      }
      case 'campaign':
        out.push({
          id, group: 'campaign', kind: s.kind, where: [plainNew(s.portfolio), plainNew(s.campaign)], what: 'Campaign', now: '—',
          next: typeof s.dailyBudgetCents === 'number' ? `${money(s.dailyBudgetCents, campaignMoney.get(s.campaign?.id ?? '') ?? currency)} a day` : 'New',
          note: `${matchWord(s.match)} · 1 ad group`,
        })
        break
      default:
        break // portfolioCap: folded into its portfolio
    }
  }
  return out
}

/** How many it creates (new campaigns and portfolios). */
export const createCount = (p: Pick<PreviewAnswer, 'totals'>): number => p.totals.campaigns + p.totals.portfolios

/** The counted primary: "Harvest 3 · create 1". */
export function harvestButtonWords(p: Pick<PreviewAnswer, 'totals'>): string {
  const create = createCount(p)
  if (!p.totals.ok) return 'Harvest'
  return `Harvest ${p.totals.ok}${create ? ` · create ${create}` : ''}`
}

/** The line under "Review": "Amazon IT · 1 new campaign". */
export function reviewSummary(markets: readonly string[], p: Pick<PreviewAnswer, 'totals'>): string {
  const where = markets.length === 1 ? `Amazon ${markets[0]}` : `Amazon ${markets.join(', ')}`
  const create = [p.totals.campaigns ? plural(p.totals.campaigns, 'new campaign') : '', p.totals.portfolios ? plural(p.totals.portfolios, 'new portfolio') : ''].filter(Boolean)
  return [where, ...create].join(' · ')
}

export interface LeftOut {
  /** One line per reason: its plain words (a chip), the terms it holds, the server's sentence (hover), a fix link. */
  key: string
  label: string
  terms: string[]
  reason: string
  fix: Fix | null
}

/** The terms the preview leaves out, one line per reason (M7: the reason in words on the line, not only in a hover). */
export function leftOutOf(p: Pick<PreviewAnswer, 'blocked' | 'items'>, market: string | null): LeftOut[] {
  const out = new Map<string, LeftOut>()
  for (const b of p.blocked) {
    const hold = p.items.find((i) => i.candidateId === b.candidateId)?.hold
    const reason = hold?.reason ?? b.reason
    const plain = plainReason(reason, market) ?? campaignReason(reason)
    const label = plain?.words ?? hold?.label ?? 'Left out'
    const line = out.get(label) ?? { key: label, label, terms: [], reason, fix: plain?.fix ?? null }
    line.terms.push(b.term)
    out.set(label, line)
  }
  return [...out.values()]
}

/** "a, b, c +2". */
export function termList(terms: readonly string[], shown = 3): string {
  return terms.length <= shown ? terms.join(', ') : `${terms.slice(0, shown).join(', ')} +${terms.length - shown}`
}

/**
 * More ticked than one change set takes (R7): the window harvests the first `MAX_TERMS` it lists, and says so. Null when
 * it lists every ticked term.
 */
export function limitWordsOf(selected: number, listed: number): string | null {
  if (listed >= selected) return null
  return `${selected.toLocaleString('en-GB')} selected: this harvests the ${listed} listed below, at most ${MAX_TERMS} at once. Harvest the rest after this one.`
}

// ── the new campaign: can this market build one? (M7, asked before the person fills anything) ────────────────────────

/** Where a person fixes what holds a harvest. */
export interface Fix { label: string; href: string }

/** Automations › Limits: where a market's daily spend limit (its spend ceiling) is set. */
export const LIMITS_HREF = '/marketing/ads/rules-automation/automations?view=limits'

/** A server reason in plain words, with where to fix it, for the reasons a person can act on; null for the rest. */
export function plainReason(reason: string | null | undefined, market: string | null): { words: string; fix: Fix | null } | null {
  const r = reason ?? ''
  const m = /(\b[A-Z]{2}\b) has no daily spend ceiling/.exec(r)
  if (m || /no daily spend ceiling/i.test(r)) {
    const code = m?.[1] ?? market ?? 'this market'
    return { words: `Set ${code}'s daily spend limit first`, fix: { label: `Set ${code}'s daily spend limit`, href: LIMITS_HREF } }
  }
  if (/above .*spend ceiling a day/i.test(r)) return { words: 'Budget above the daily spend limit', fix: { label: 'Daily spend limits', href: LIMITS_HREF } }
  if (/lives in Nexus only/i.test(r)) return { words: 'Portfolio is in Nexus only', fix: null }
  if (/already has a campaign named/i.test(r)) return { words: 'Name taken: give it another', fix: null }
  if (/advertise no SKU/i.test(r)) return { words: 'No product to advertise', fix: null }
  return null
}

/** "The new campaign cannot be built: <why> (<more>)." → "<Why>" — the server's words without the wrapping. */
export function campaignReason(reason: string | null | undefined): { words: string; fix: Fix | null } | null {
  const m = /^The new campaign cannot be built:\s*(.+)$/i.exec((reason ?? '').trim())
  if (!m) return null
  const words = m[1].replace(/\s*\([^)]*\)\.?$/, '').replace(/\.$/, '').trim()
  return words ? { words: words.charAt(0).toUpperCase() + words.slice(1), fix: null } : null
}

/** The body of the probe: one term into a new campaign the server proposes (writes nothing). */
export const PROBE_KEY = 'probe'
export function probeBody(row: Pick<HarvestCandidateRow, 'id' | 'product'>, match: HarvestMatch): PreviewBody {
  const productId = candidateParts(row.id)?.productId ?? row.product.id
  return { items: [{ candidateId: row.id, to: { newCampaign: PROBE_KEY }, match }], newCampaigns: [{ key: PROBE_KEY, productId, match }] }
}

/** The term the probe and the destination tree read: one that can go, else the first. */
export function anchorRow<R extends Pick<HarvestCandidateRow, 'heldBy' | 'state' | 'destination'>>(rows: readonly R[]): R | null {
  if (!rows.length) return null
  const ok = rows.filter((r) => !rowHold(r))
  const pool = ok.length ? ok : rows
  // The term whose own place most of the terms share (so the tree's "Suggested" is theirs).
  const count = new Map<string, number>()
  for (const r of pool) if (r.destination?.kind === 'existing') count.set(r.destination.adGroup.id, (count.get(r.destination.adGroup.id) ?? 0) + 1)
  const best = [...count].sort((a, b) => b[1] - a[1])[0]?.[0]
  return (best ? pool.find((r) => r.destination?.kind === 'existing' && r.destination.adGroup.id === best) : undefined) ?? pool[0]
}

/**
 * What a probe says about a new campaign in this market: held (the plain reason, the server's, where to fix it), or null
 * when one can be built — or when the probe term was refused for its own reasons (the probe says nothing then).
 */
export function newCampaignHold(answer: Pick<PreviewAnswer, 'items'> | null, market: string | null): { label: string; reason: string; fix: Fix | null } | null {
  const item = answer?.items[0]
  if (!item || item.ok) return null
  const reason = item.refusal ?? item.hold?.reason ?? ''
  // R9 — only what holds whatever the person types here: the market has no daily spend limit, the product has nothing to
  // advertise. A budget, a bid or a name the probe's defaults trip on is not a hold: the review judges what is typed.
  if (!MARKET_HOLDS.some((re) => re.test(reason))) return null
  const plain = plainReason(reason, market) ?? campaignReason(reason)
  const words = plain?.words ?? 'A new campaign cannot be built here'
  return { label: words, reason: words, fix: plain?.fix ?? null }
}

/** The new-campaign refusals no field of the window can change (R9). */
const MARKET_HOLDS: readonly RegExp[] = [/no daily spend ceiling/i, /advertise no SKU/i, /owns no (?:Sponsored Products )?campaign/i]

/** The start bid's why, in a few words (S3): never the brain's formula. */
export function bidWhyWords(why: string | null | undefined): string | null {
  const w = (why ?? '').toLowerCase()
  if (!w) return null
  if (w.startsWith('the bid you set')) return 'Your bid'
  if (w.includes('goal bid')) return 'For your target ACoS'
  if (w.includes('cost per click')) return w.includes('held inside') ? 'Your CPC, inside your bid limits' : 'Your CPC'
  return null
}

/** Why the primary of the review cannot run, in words; null when it can. */
export function reviewHeld(phase: 'reading' | 'failed' | 'ready' | 'saving' | 'done', p: Pick<PreviewAnswer, 'totals'> | null, problem: string | null): string | null {
  if (phase === 'reading') return 'Reading the plan'
  if (phase === 'failed') return 'The plan could not be read'
  if (phase === 'saving') return 'Sending'
  if (phase === 'done') return 'Already sent'
  if (!p || p.totals.ok === 0) return 'Nothing can be harvested'
  if (problem) return problem
  return null
}

// ── done ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface DoneView {
  /** The Done line and its tone. */
  line: string
  tone: 'success' | 'warning' | 'danger'
  /** The Result of every row. */
  words: string
  resultTone: 'success' | 'warning' | 'neutral'
  /** It waits for the short undo window and then goes to Amazon (show the countdown). */
  runsAt: string | null
  /** The request asked for an approval that did not come in this click (why, the server's words). */
  approveError: string | null
}

/** What became of the change set when it was asked, in words. */
export function doneViewOf(answer: Pick<RequestAnswer, 'status' | 'executeAfter' | 'approve'>, counted: string): DoneView {
  const status: RequestStatus = answer.status
  const a = answer.approve
  const approveError = a && !a.ok
    ? a.code === 'mfa_required' || a.code === 'mfa_invalid' ? 'Waits for your authenticator code'
      : a.code === 'mfa_not_enrolled' ? 'Turn on your authenticator to approve a new campaign'
        : a.error ?? 'Not approved in this click'
    : null
  if (status === 'queued') return { line: 'Asked · waits for approval', tone: 'warning', words: 'Waiting', resultTone: 'warning', runsAt: null, approveError }
  return { line: counted, tone: 'success', words: status === 'runs_by_rule' ? 'Runs by rule' : 'Approved', resultTone: 'success', runsAt: answer.executeAfter ?? null, approveError }
}

/**
 * "3 keywords · 1 new campaign · 6 blocks" — what was approved (S2: never "harvested" before it ran; the window adds
 * when it goes to Amazon).
 */
export function harvestDoneLine(p: Pick<PreviewAnswer, 'totals'>): string {
  const blocks = p.totals.sourceNegatives + p.totals.funnelNegatives
  return [
    plural(p.totals.ok, 'keyword'),
    p.totals.campaigns ? plural(p.totals.campaigns, 'new campaign') : '',
    p.totals.portfolios ? plural(p.totals.portfolios, 'new portfolio') : '',
    blocks ? plural(blocks, 'block') : '',
  ].filter(Boolean).join(' · ')
}


/** "Open campaign": the one campaign the keywords go to — its page; a new one is built when the harvest runs. */
export function openCampaignOf(p: Pick<PreviewAnswer, 'steps'>): { href: string } | { held: string } | null {
  const ids = new Map<string, Ref>()
  for (const s of p.steps) if ((s.kind === 'keyword' || s.kind === 'enable') && s.campaign) ids.set(s.campaign.id, s.campaign)
  if (ids.size !== 1) return null
  const c = [...ids.values()][0]
  if (c.id.startsWith('new:')) return { held: 'The campaign is built when the harvest runs' }
  return c.href ? { href: c.href } : null
}

/** Undo before the change set ran = take it back (nothing was sent); after it ran = undo its harvests (a review). */
export function canTakeBack(answer: Pick<ApplyAnswer, 'status' | 'executeAfter'>, now: number): boolean {
  if (answer.status === 'queued') return true
  const t = answer.executeAfter ? Date.parse(answer.executeAfter) : Number.NaN
  return Number.isFinite(t) && now < t
}

// ── undo ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The harvests this change set wrote (newest read of the history). */
export const harvestsOf = (rows: readonly HistoryRow[], changeSetId: string): HistoryRow[] => rows.filter((r) => r.changeSetId === changeSetId)

export interface UndoPlan {
  harvestIds: string[]
  rows: HarvestReviewRow[]
  pauses: number
  lifts: number
  /** Why nothing can be put back; null when something can. */
  held: string | null
}

/** What an undo puts back: each keyword paused (never archived), each block it added lifted. */
export function undoPlanOf(harvests: readonly HistoryRow[]): UndoPlan {
  const rows: HarvestReviewRow[] = []
  const ids: string[] = []
  let pauses = 0
  let lifts = 0
  for (const h of harvests) {
    if (!h.undo.available) continue
    ids.push(h.harvestId)
    if (h.keyword) {
      pauses += 1
      rows.push({ id: `p:${h.harvestId}`, group: 'keywords', kind: 'pause', where: [h.destination?.campaign ?? null, h.destination?.adGroup ?? null], what: h.term, now: 'On', next: 'Paused' })
    }
    ;[...h.sources, ...h.funnel].forEach((b, i) => {
      if (b.action !== 'negate' || b.result !== 'landed') return
      lifts += 1
      rows.push({ id: `l:${h.harvestId}:${i}`, group: 'negatives', kind: 'lift', where: [b.adGroup], what: h.term, now: 'Negative', next: 'Removed' })
    })
  }
  const held = ids.length ? null : harvests.find((h) => h.undo.why)?.undo.why ?? 'Nothing of it stands any more'
  return { harvestIds: ids, rows, pauses, lifts, held }
}

/** "Undo 3 harvests". */
export const undoButtonWords = (plan: Pick<UndoPlan, 'harvestIds'>): string => `Undo ${plural(plan.harvestIds.length, 'harvest')}`

/** "Undo · 3 keywords · 6 blocks" — what the undo was approved for (the window adds when it goes to Amazon). */
export function undoDoneLine(plan: Pick<UndoPlan, 'pauses' | 'lifts'>): string {
  return ['Undo', plan.pauses ? plural(plan.pauses, 'keyword') : '', plan.lifts ? plural(plan.lifts, 'block') : ''].filter(Boolean).join(' · ')
}

/** The page's words for the request it took back: nothing was sent. */
export const TAKEN_BACK = 'Taken back · nothing sent'
