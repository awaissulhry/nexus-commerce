/**
 * Keyword Harvest page rebuild (2026-10-11, lane HMCP) — the harvest engine (services/advertising/harvest/) in Claude's
 * hands, on the page's own code path: what the Keyword Harvest page reads, Claude reads; what it asks for, Claude asks for.
 *
 *   harvest-candidates    the page's Terms view (GET /api/advertising/harvest/candidates): one row per term × product ×
 *                         market over EVERY ad group of the product where the term ran, with the bar it passes (the ads
 *                         strategy's harvest group, else the brain's sized test), where it would go and how that was
 *                         chosen, the funnel blocks it implies, its start bid, its state, who owns it, a skip, a request
 *                         that waits for a person, and its last harvest with the verdict; totals (the page's tiles),
 *                         criteria (the bar per market and where it comes from) and freshness. idsOnly: every id that
 *                         matches (the page's "select all N that match").
 *   harvest-destinations  where one product's harvest can go (GET …/destinations): its portfolio → campaign → ad group tree
 *                         (only its own campaigns and the Owner's stored places), each option with why it is held and
 *                         whether it is the suggested one, the new campaign the engine would build, the stored places.
 *   harvest-history       every harvest of every actor — the brain, a person on the page, Claude, a rule (GET …/history):
 *                         where it went, its keyword, its source and funnel blocks, its verdict after the attribution
 *                         window + 72 hours (Better / Worse / Too early) and whether it can be put back now.
 *   skip-harvest-terms    hide terms for 7 days, 30 days or for good, or show them again (POST …/skip, /unskip): Nexus only;
 *                         a skipped term is not decided by the brain meanwhile, and a harvest of it unskips it.
 *
 * apply-harvest (harvest/tool.ts) is the one change set a harvest goes out as — the page's and Claude's alike;
 * harvest-search-term and graduate-keyword ask for the same (ads-harvest-alias.ts). Approving or rejecting a harvest that
 * waits is a person's act in Nexus (the Keyword Harvest page's "Waiting for you" tile, or the Approvals page): Claude
 * cannot approve.
 *
 * Money (spend, sales, ACoS, CPC, bids, budgets, caps, and the start bid's explanation) sits only under the engine's money
 * keys (HARVEST_MONEY), which the money filter strips for a person without financials.adspend.view.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
// The engine's modules, not its barrel: the barrel's request doors import the approval gate, which imports the registry.
import { harvestCandidateIds, harvestCandidates, marketsOf, type CandidatesQuery } from '../../advertising/harvest/candidates.js'
import { ALL_STATES, HARVEST_MONEY } from '../../advertising/harvest/constants.js'
import { harvestDestinations } from '../../advertising/harvest/destinations.js'
import { harvestHistory } from '../../advertising/harvest/history.js'
import { candidateIdOf, parseCandidateId } from '../../advertising/harvest/ids.js'
import { skipCandidates, unknownProducts, unskipCandidates } from '../../advertising/harvest/skip.js'
import { fingerprint } from './ads-targeting-kit.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { isLiveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import type { AgentTool, FieldPermission, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

export const HARVEST_READ_TOOLS = { candidates: 'harvest-candidates', destinations: 'harvest-destinations', history: 'harvest-history', skip: 'skip-harvest-terms' } as const

/** The engine's money keys, and the start bid's explanation (it explains a money value). */
const MONEY: Readonly<Record<string, FieldPermission>> = {
  ...(HARVEST_MONEY as Readonly<Record<string, FieldPermission>>),
  bidWhy: FIELDS.financialsAdspendView,
}

const ID = z.string().trim().min(1).max(64)
const CANDIDATE_ID = z.string().trim().min(5).max(300)
const MARKET = z.string().trim().min(2).max(200).optional()
  .describe('the market: an Amazon code (IT, DE, FR, ES, UK …), a comma list (IT,DE), or all (default: every market Nexus reads)')

/**
 * A business whose Amazon Ads Nexus reads in no market (no Amazon Ads account): an empty answer that says so, not an
 * error — there is nothing to harvest yet (the page's "no Amazon Ads account" screen). A market Nexus does not read while
 * it reads others is refused by the engine, named (L3).
 */
const NO_MARKET = 'no Amazon Ads market is read in this business: there is nothing to harvest yet'
const noMarkets = async () => 'error' in (await marketsOf('all'))
/** A product named by id must be a live product of this business (a deleted one is not found, MCP.12). */
const productRefusal = async (productId: string | undefined): Promise<ToolResult | null> =>
  productId && !(await isLiveProduct(productId)) ? { ok: false, error: PRODUCT_NOT_FOUND } : null
const STATES = ['all', ...ALL_STATES] as unknown as [string, ...string[]]
const SORTS = /^-?(orders|acos|spend|clicks|cpc|term|state|product)$/
/** The most rows a page of a harvest read holds (the page itself may ask for more). */
const MAX_PAGE = 100
/** Ids a page of idsOnly: as many as one skip takes (apply-harvest takes 200). */
const MAX_IDS_PAGE = 250
const MAX_SKIP = 250

const STATE_WORDS = 'READY (can be harvested now) · NEEDS_DESTINATION / NEEDS_CAMPAIGN (pick an ad group, or a new campaign) · HELD '
  + '(heldBy says why) · WAITING (a harvest of it waits for a person: waiting.approvalId) · IN_FLIGHT (being written) · HARVESTED '
  + '(lastHarvest, with its verdict) · AT_HOME (already a keyword of the product) · OWNED_BY_SIBLING (another product leads it) · '
  + 'BELOW_BAR · SKIPPED'

// ── harvest-candidates ────────────────────────────────────────────────────────────────────────────

const CANDIDATES_INPUT = z.object({
  market: MARKET,
  productId: ID.optional().describe('only this product (any member of its family: the family root owns the row)'),
  portfolioId: ID.optional().describe('only terms whose source or destination sits in this portfolio (its Amazon portfolio id, as ad-portfolios gives it)'),
  campaignId: ID.optional().describe('only terms whose source or destination is this campaign (Nexus id)'),
  adGroupId: ID.optional().describe('only terms that ran in this ad group (Nexus id)'),
  state: z.array(z.enum(STATES)).max(12).optional()
    .describe(`the states to list (default: the open work and what was harvested — READY, NEEDS_DESTINATION, NEEDS_CAMPAIGN, HELD, WAITING, IN_FLIGHT, HARVESTED; all = every state). ${STATE_WORDS}`),
  owner: z.enum(['BRAIN', 'RULE', 'PERSON', 'NONE']).optional().describe('only terms this owner decides: the ads brain, a harvest rule, a person, or nobody'),
  kind: z.enum(['keyword', 'asin']).optional().describe('keyword: words a shopper typed; asin: a product page (harvested as a product target)'),
  q: z.string().trim().min(1).max(200).optional().describe('only terms that contain this text'),
  sort: z.string().trim().regex(SORTS, 'one of orders, acos, spend, clicks, cpc, term, state, product, with - for descending').optional()
    .describe('orders, acos, spend, clicks, cpc, term, state or product; a leading - sorts descending (default -orders)'),
  page: z.coerce.number().int().min(1).max(10_000).optional().describe('the page (default 1)'),
  pageSize: z.coerce.number().int().min(1).max(MAX_IDS_PAGE).optional().describe(`rows a page (default 25, at most ${MAX_PAGE}); with idsOnly, ids a page (default ${MAX_IDS_PAGE}, at most ${MAX_IDS_PAGE})`),
  idsOnly: z.boolean().optional().describe(`true: the candidate ids that match instead of the rows, a page at a time (${MAX_IDS_PAGE} a page: one apply-harvest takes 200, one skip ${MAX_IDS_PAGE}) — for a harvest or a skip of all of them`),
})
type CandidatesArgs = z.infer<typeof CANDIDATES_INPUT>

const queryOf = (a: CandidatesArgs): CandidatesQuery => ({
  market: a.market ?? 'all', productId: a.productId ?? null, portfolioId: a.portfolioId ?? null, campaignId: a.campaignId ?? null, adGroupId: a.adGroupId ?? null,
  state: a.state?.length ? a.state : null, owner: a.owner ?? null, kind: a.kind ?? null, q: a.q ?? null,
  page: a.page ?? 1, pageSize: Math.min(MAX_PAGE, a.pageSize ?? 25), sort: a.sort ?? null,
})

const harvestCandidatesTool: AgentTool = {
  name: HARVEST_READ_TOOLS.candidates,
  title: 'Harvest candidates',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: MONEY,
  input: CANDIDATES_INPUT,
  description:
    'The Amazon Sponsored Products search terms worth harvesting, exactly as the Keyword Harvest page lists them (the same '
    + 'engine): one row per search term × product × market, over EVERY ad group of the product where the term ran. Per row: '
    + 'its id (candidateId, what apply-harvest and skip-harvest-terms take), the term and whether it is an ASIN, the '
    + 'product, the sources (every ad group where it ran, with clicks and what the harvest would do there: negate, standing, '
    + 'kept or skipped, and why), the metrics over the bar\'s own window, the bar (the ads strategy\'s "Harvest a search term '
    + 'when" group for the product, else the ads brain\'s sized test) and whether it passes, the state and why it is held '
    + '(heldBy), who owns it (the brain, a rule, a person, nobody), where it would go (destination: an ad group of the '
    + 'product\'s own campaigns and how it was chosen — the Owner\'s stored place, the playbook, its own exact ad group — or a '
    + 'new campaign with its name, portfolio and budget), the funnel blocks the harvest would add, the start bid and why, a '
    + 'skip, a harvest request that waits for a person (waiting.approvalId: a person approves or rejects it in Nexus; '
    + 'Claude cannot), and the last harvest with its verdict. totals count every state in scope (the page\'s tiles), '
    + 'criteria names the bar per market and where it comes from, freshness the newest data day. The window is the bar\'s '
    + 'own (criteria), not a filter. Filter by market (a code, a comma list, or all: the default), product, portfolio, campaign, '
    + 'ad group, state, owner, kind or text; sort; page. idsOnly gives every id that matches. Next: harvest-destinations '
    + 'for one term\'s choices, then apply-harvest. Amounts are minor units of the market\'s currency (currency on each row), '
    + 'never summed across markets; a person without the ad-spend money permission gets the same answer without them.',
  async handler(args): Promise<ToolResult> {
    const a = args as CandidatesArgs
    const gone = await productRefusal(a.productId)
    if (gone) return gone
    if (await noMarkets()) return { ok: true, data: a.idsOnly ? { ids: [], total: 0, note: NO_MARKET } : { markets: [], rows: [], total: 0, note: NO_MARKET } }
    const q = queryOf(a)
    if (a.idsOnly) {
      const got = await harvestCandidateIds(q)
      if ('error' in got) return { ok: false, error: got.error }
      const page = a.page ?? 1
      const size = a.pageSize ?? MAX_IDS_PAGE
      const ids = got.data.ids.slice((page - 1) * size, page * size)
      const more = page * size < got.data.ids.length
      return { ok: true, data: { ids, total: got.data.total, page, pageSize: size, ...(more ? { nextPage: page + 1 } : {}), ...(got.data.total > got.data.ids.length ? { note: `${got.data.total} match; the first ${got.data.ids.length} can be listed — narrow by state, product or text.` } : {}) } }
    }
    const got = await harvestCandidates(q)
    if ('error' in got) return { ok: false, error: got.error }
    const d = got.data
    const more = d.page * d.pageSize < d.total
    return { ok: true, data: { ...d, ...(more ? { nextPage: d.page + 1, more: `${d.total} match: ask again with page ${d.page + 1}, or narrow by state, product or text.` } : {}) } }
  },
}

// ── harvest-destinations ──────────────────────────────────────────────────────────────────────────

const DESTINATIONS_INPUT = z.object({
  candidateId: CANDIDATE_ID.optional().describe('the term (its id from harvest-candidates): the options for it, its suggested place first'),
  market: z.string().trim().min(2).max(20).optional().describe('with productId and no candidateId: the market (an Amazon code)'),
  productId: ID.optional().describe('with market and no candidateId: the product (any member of its family)'),
  match: z.enum(['EXACT', 'PHRASE']).optional().describe('the keyword\'s match (default EXACT): which ad groups can take it, and the new campaign\'s kind'),
})
type DestinationsArgs = z.infer<typeof DESTINATIONS_INPUT>

const harvestDestinationsTool: AgentTool = {
  name: HARVEST_READ_TOOLS.destinations,
  title: 'Harvest destinations',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: MONEY,
  input: DESTINATIONS_INPUT,
  description:
    'Where one product\'s harvested Amazon search term can go — the Keyword Harvest page\'s destination picker: the product\'s '
    + 'portfolios → campaigns → ad groups (only the product\'s own campaigns and the Owner\'s stored harvest places; '
    + 'campaigns in no portfolio under unplaced), each ad group with its role, size, whether it serves, held (why it cannot '
    + 'take the keyword now: an automatic ad group, paused, an archived copy there, a negative there that blocks it, the '
    + 'wrong kind) and suggested (the engine\'s own pick for this term and match); suggested (the place and why, a new '
    + 'campaign, or why it is held); newCampaign (the product\'s funnel campaign for the match the engine would build: '
    + 'its name by the SP Super Wizard\'s naming, its one ad group, its portfolio, its daily budget, or why it cannot be '
    + 'built); stored (the Owner\'s saved harvest places that cover the product, with negateAtSource). Name the term '
    + '(candidateId), or the market and product. Then ask apply-harvest with the place chosen (to: { adGroupId }, or a new '
    + 'campaign). Budgets are minor units of the market\'s currency; a person without the ad-spend money permission gets '
    + 'the same answer without them.',
  async handler(args): Promise<ToolResult> {
    const a = args as DestinationsArgs
    const gone = await productRefusal(a.productId ?? (a.candidateId ? parseCandidateId(a.candidateId)?.productId : undefined))
    if (gone) return gone
    if (!a.candidateId && (!a.market || !a.productId)) return { ok: false, error: 'Name the term (candidateId, from harvest-candidates), or the market and the product (market, productId).' }
    const got = await harvestDestinations({ market: a.market ?? '', productId: a.productId ?? null, candidateId: a.candidateId ?? null, match: a.match ?? null })
    if ('error' in got) return { ok: false, error: got.error }
    return { ok: true, data: got.data }
  },
}

// ── harvest-history ───────────────────────────────────────────────────────────────────────────────

const HISTORY_INPUT = z.object({
  market: MARKET,
  productId: ID.optional().describe('only this product\'s harvests'),
  days: z.coerce.number().int().min(1).max(365).optional().describe('the harvests changed in the last N days (default 30)'),
  actor: z.enum(['BRAIN', 'PERSON', 'CLAUDE', 'RULE']).optional().describe('only harvests this actor made: the ads brain, a person (the page), Claude, a harvest rule'),
  verdict: z.enum(['better', 'worse', 'too-early', 'none']).optional().describe('only harvests judged so (none: not judged yet)'),
  harvestIds: z.array(ID).min(1).max(200).optional().describe('only these harvests (harvestId), whatever their date'),
  page: z.coerce.number().int().min(1).max(10_000).optional().describe('the page (default 1)'),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE).optional().describe(`rows a page (default 25, at most ${MAX_PAGE})`),
})
type HistoryArgs = z.infer<typeof HISTORY_INPUT>

const harvestHistoryTool: AgentTool = {
  name: HARVEST_READ_TOOLS.history,
  title: 'Harvest history',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: MONEY,
  input: HISTORY_INPUT,
  description:
    'Every Amazon search-term harvest of every actor — the ads brain, a person on the Keyword Harvest page, Claude, a harvest '
    + 'rule — newest first, as the page\'s history shows it: per harvest its harvestId and candidateId, the term, product and '
    + 'market, when and by whom, its change set (changeSetId: the approval it ran as), the match, its status (WRITING, '
    + 'CAMPAIGN_BUILT, DONE, HALF_DONE, UNDO_PROPOSED, UNDONE, REFUSED, FAILED), where it went (portfolio, campaign, ad '
    + 'group) and its keyword, each source and funnel block with what became of it, the verdict after the attribution '
    + 'window + 72 hours (better, worse, too-early, or not judged yet; judgeAfter, judgedAt, why), and whether it can be '
    + 'put back now (undo.available, why). totals count harvested, better, worse, too early and undone. Put one back with '
    + 'apply-harvest op undo (its harvestIds), or undo-change of the change set: its blocks are lifted, then its keyword '
    + 'paused (never archived). Filter by market (default: every market Nexus reads), product, days, actor, verdict or harvestIds; page.',
  async handler(args): Promise<ToolResult> {
    const a = args as HistoryArgs
    const gone = await productRefusal(a.productId)
    if (gone) return gone
    if (await noMarkets()) return { ok: true, data: { markets: [], rows: [], total: 0, note: NO_MARKET } }
    const markets = await marketsOf(a.market ?? 'all')
    if ('error' in markets) return { ok: false, error: markets.error }
    const got = await harvestHistory({ market: markets, productId: a.productId ?? null, days: a.days, actor: a.actor ?? null, verdict: a.verdict ?? null, ids: a.harvestIds ?? null })
    if ('error' in got) return { ok: false, error: got.error }
    const pageSize = a.pageSize ?? 25
    const page = a.page ?? 1
    const total = got.data.rows.length
    const rows = got.data.rows.slice((page - 1) * pageSize, page * pageSize)
    const more = page * pageSize < total
    return { ok: true, data: { markets, rows, total, page, pageSize, totals: got.data.totals, ...(more ? { nextPage: page + 1 } : {}) } }
  },
}

// ── skip-harvest-terms ────────────────────────────────────────────────────────────────────────────

const PERIODS = { '7d': 7, '30d': 30, forever: null } as const
type Period = keyof typeof PERIODS

const SKIP_INPUT = z.object({
  op: z.enum(['skip', 'unskip']).default('skip').describe('skip (default): hide the terms from the harvest candidates; unskip: show them again (the undo of a skip)'),
  ids: z.array(CANDIDATE_ID).min(1).max(MAX_SKIP).describe('the terms (candidateId from harvest-candidates; idsOnly gives every id that matches)'),
  period: z.enum(['7d', '30d', 'forever']).optional().describe('op skip: for 7 days, 30 days, or for good (required with op skip)'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it'),
})
type SkipArgs = z.infer<typeof SKIP_INPUT>

/**
 * skip-harvest-terms' Claude limits (a Nexus-only change): by default every skip waits for a person (maxTerms 0); a skip
 * for good only when the business allows it.
 */
const SKIP_LIMITS = z.object({
  maxTerms: z.number().int().min(0).max(MAX_SKIP).default(0)
    .describe('the most terms one skip or unskip may hide or show again without a person; 0 = every one waits for a person'),
  allowForever: z.boolean().default(false).describe('whether a skip for good may run without a person'),
})

interface SkipState { until: string | null; forGood: boolean }
interface SkipPreview { action: string; op: 'skip' | 'unskip'; period: Period | null; ids: string[]; left: Array<{ id: string; why: string }>; basis: string }

const termWords = (id: string) => { const c = parseCandidateId(id); return c ? `"${c.term}" (${c.market})` : id }
const stateWords = (s: SkipState | null) => (!s ? 'shown' : s.forGood ? 'skipped for good' : `skipped until ${s.until?.slice(0, 10)}`)

/** Each term's skip as stored now (null: shown), by candidate id. */
async function skipStates(ids: readonly string[], now: Date): Promise<Map<string, SkipState | null>> {
  const parsed = ids.map((id) => ({ id, c: parseCandidateId(id) })).filter((x): x is { id: string; c: NonNullable<ReturnType<typeof parseCandidateId>> } => !!x.c)
  const rows = parsed.length ? await prisma.adsBrainHarvest.findMany({
    where: { productId: { in: [...new Set(parsed.map((x) => x.c.productId))] }, marketplace: { in: [...new Set(parsed.map((x) => x.c.market))] }, term: { in: [...new Set(parsed.map((x) => x.c.term))] } },
    select: { productId: true, marketplace: true, term: true, skippedUntil: true, skippedForGood: true },
  }) : []
  const byKey = new Map(rows.map((r) => [candidateIdOf(r.marketplace, r.productId, r.term), r]))
  const out = new Map<string, SkipState | null>()
  for (const { id, c } of parsed) {
    const r = byKey.get(candidateIdOf(c.market, c.productId, c.term))
    const timed = r?.skippedUntil && r.skippedUntil.getTime() > now.getTime() ? r.skippedUntil.toISOString() : null
    out.set(id, r && (r.skippedForGood || timed) ? { until: r.skippedForGood ? null : timed, forGood: r.skippedForGood } : null)
  }
  return out
}

async function decideSkip(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = SKIP_INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const a: SkipArgs = parsed.data
  if (a.op === 'skip' && !a.period) return { ok: false, error: 'period: name how long the terms are skipped — 7d, 30d or forever.' }
  const now = new Date()
  const unique = [...new Set(a.ids.map((id) => id.trim()))]
  const left: SkipPreview['left'] = []
  const canonicalIds = new Map<string, string>()
  for (const raw of unique) {
    const c = parseCandidateId(raw)
    if (!c) left.push({ id: raw, why: 'not a candidate id (market|productId|term, from harvest-candidates)' })
    else canonicalIds.set(raw, candidateIdOf(c.market, c.productId, c.term))
  }
  const states = await skipStates([...canonicalIds.values()], now)
  const changing: string[] = []
  for (const id of new Set(canonicalIds.values())) {
    const s = states.get(id) ?? null
    if (a.op === 'skip' && s) left.push({ id, why: `already ${stateWords(s)}: unskip it first to skip it for another period` })
    else if (a.op === 'unskip' && !s) left.push({ id, why: 'it is not skipped' })
    else changing.push(id)
  }
  if (!changing.length) return { ok: false, error: `Nothing to change: ${left.slice(0, 5).map((l) => `${termWords(l.id)} ${l.why}`).join('; ')}.` }
  // The engine's own check (M8): every product the ids name is a live product of this business, or nothing changes.
  const unknown = await unknownProducts(changing)
  if (unknown.length) return { ok: false, error: `Not queued: product ${unknown[0]} was not found in this business: nothing is skipped.` }
  changing.sort()
  const period = a.op === 'skip' ? a.period! : null
  const to = a.op === 'skip' ? (period === 'forever' ? 'skipped for good' : `skipped ${PERIODS[period!]} days`) : 'shown'
  const changes: Record<string, { from: unknown; to: unknown }> = {}
  for (const id of changing.slice(0, 20)) changes[termWords(id)] = { from: stateWords(states.get(id) ?? null), to }
  const preview: SkipPreview & Record<string, unknown> = {
    action: HARVEST_READ_TOOLS.skip,
    op: a.op,
    period,
    ids: changing,
    left,
    summary: a.op === 'skip'
      ? `Hides ${changing.length} search term${changing.length === 1 ? '' : 's'} from the harvest candidates ${period === 'forever' ? 'for good' : `for ${PERIODS[period!]} days`}; the ads brain does not decide ${changing.length === 1 ? 'it' : 'them'} meanwhile.`
      : `Shows ${changing.length} skipped search term${changing.length === 1 ? '' : 's'} in the harvest candidates again.`,
    changes,
    totals: { changing: changing.length, left: left.length },
    basis: fingerprint({ op: a.op, period, ids: changing.map((id) => [id, states.get(id) ?? null]) }),
    note: 'Nexus only: nothing is sent to Amazon. Undoable (undo-change).',
  }
  return { ok: true, preview }
}

/** The skip of each term as stored now, in the shape of `change.after` (the undo guard compares the two). */
async function skipNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; ids?: unknown }
  if (!Array.isArray(after.ids)) return change.after
  const ids = after.ids.map(String)
  const states = await skipStates(ids, new Date())
  return { op: after.op, ids, state: Object.fromEntries(ids.map((id) => [id, states.get(id) ?? null])) }
}

/**
 * C2 — undo of a skip: the terms shown again (they were shown before: a skip leaves an already skipped term); of an
 * unskip: the terms skipped again — for good where they were, else for 7 or 30 days (the days that were left, rounded up).
 */
export const SKIP_UNDO: ToolUndo = {
  current: skipNow,
  request(change) {
    const before = (change.before ?? {}) as { op?: unknown; state?: Record<string, SkipState | null> }
    const after = (change.after ?? {}) as { op?: unknown; ids?: unknown }
    if (!Array.isArray(after.ids) || !after.ids.length) return { refusal: 'This change does not name the terms it changed.' }
    const ids = after.ids.map(String)
    if (after.op === 'skip') return { tool: HARVEST_READ_TOOLS.skip, args: { op: 'unskip', ids, why: 'undo of a skip: the terms shown again' } }
    const was = Object.values(before.state ?? {})
    const forGood = was.some((s) => s?.forGood)
    const longest = Math.max(0, ...was.map((s) => (s?.until ? Date.parse(s.until) - Date.now() : 0)))
    const period: Period = forGood ? 'forever' : longest > 7 * 86_400_000 ? '30d' : '7d'
    return { tool: HARVEST_READ_TOOLS.skip, args: { op: 'skip', ids, period, why: 'undo of an unskip: the terms skipped again' } }
  },
}

function skipWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as Partial<SkipPreview>
  if (p.action !== HARVEST_READ_TOOLS.skip || !Array.isArray(p.ids)) return 'there is no preview of this skip to check; a person decides'
  const max = typeof limits.maxTerms === 'number' ? limits.maxTerms : 0
  if (p.ids.length > max) return `it ${p.op === 'unskip' ? 'shows' : 'hides'} ${p.ids.length} term${p.ids.length === 1 ? '' : 's'}, more than the ${max} this business lets Claude ${p.op === 'unskip' ? 'show again' : 'skip'} without a person${max === 0 ? ' (0: every one waits for a person)' : ''}`
  if (p.op === 'skip' && p.period === 'forever' && limits.allowForever !== true) return 'a skip for good waits for a person (allowForever is off)'
  return null
}

const skipHarvestTerms: AgentTool = {
  name: HARVEST_READ_TOOLS.skip,
  title: 'Skip harvest terms',
  category: 'advertising',
  riskTier: 'low',
  readOnly: false,
  requires: [F.adsCampaignsManage],
  input: SKIP_INPUT,
  requiresApprovalDefault: true,
  // Nexus only: nothing is sent to Amazon (a skipped term only leaves the candidates and the brain's decisions).
  openWorld: false,
  // An unskip's undo skips again for 7 or 30 days, not to the exact day it ran to before.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: SKIP_LIMITS,
  withinLimits: skipWithinLimits,
  undo: SKIP_UNDO,
  description:
    'Skip Amazon search terms on the Keyword Harvest page — hide them from harvest-candidates for 7 days, 30 days or for '
    + 'good (period 7d, 30d or forever) — or show skipped ones again (op unskip). The same skip as the page\'s Skip: a '
    + 'skipped term is listed only under state SKIPPED, the ads brain does not decide it meanwhile, and a harvest of it '
    + 'unskips it. Terms are candidateIds from harvest-candidates (idsOnly gives every id that matches); a term already '
    + 'skipped is left as it is (unskip it first to change its period). Nexus only: nothing is sent to Amazon. Nothing '
    + 'changes until a person approves it in Nexus, unless the business lets Claude skip a few terms itself (by default it '
    + 'does not). The preview lists each term from → to. Undo (undo-change) shows the terms again (or, for an unskip, '
    + 'skips them again).',
  async handler(args): Promise<ToolResult> {
    return decideSkip(args)
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const fresh = await decideSkip(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as SkipPreview
    if ((ctx.approvedPreview as { basis?: unknown } | undefined)?.basis !== p.basis) return notRun('Not run: what you approved has moved since — a term was skipped or shown again meanwhile. Ask for it again as it is now.')
    const run = approvedRun(ctx, String((args as { why?: unknown }).why ?? '') || String((fresh.preview as { summary?: unknown }).summary ?? ''))
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const now = new Date()
    const before = await skipStates(p.ids, now)
    const by = run.actor
    const out = p.op === 'skip' ? await skipCandidates(p.ids, PERIODS[p.period ?? '30d'], by, now) : await unskipCandidates(p.ids)
    if ('error' in out) return notRun(`Not run: ${out.error}`)
    if (!out.changed) return notRun(`Not run: nothing changed — ${out.refused.slice(0, 3).map((r) => `${termWords(r.id)} ${r.why}`).join('; ') || 'no term could be changed'}.`)
    const ids = [...out.ids].sort()
    const after = await skipStates(ids, now)
    return {
      ok: true,
      data: { op: p.op, changed: out.changed, until: out.until, forGood: out.forGood, refused: out.refused, note: 'Nexus only: nothing was sent to Amazon.' },
      change: {
        before: { op: p.op, ids, state: Object.fromEntries(ids.map((id) => [id, before.get(id) ?? null])) },
        after: { op: p.op, ids, state: Object.fromEntries(ids.map((id) => [id, after.get(id) ?? null])) },
      },
    }
  },
}

export const ADS_HARVEST_TOOLS: AgentTool[] = [harvestCandidatesTool, harvestDestinationsTool, harvestHistoryTool, skipHarvestTerms]
