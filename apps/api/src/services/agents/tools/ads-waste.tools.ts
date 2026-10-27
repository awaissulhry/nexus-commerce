/**
 * Negative Targeting page (NREAD, 2026-10-11) — `ad-waste`: Claude reads what the page reads, through the same service
 * functions (services/advertising/waste/*), so the page and Claude can never see two answers. Read only: nothing is
 * asked or sent. The writes stay the existing tools (pause-ads, add-negative-targets, retire-negatives, enable-ads).
 *
 *   rows     every keyword and target of ours and every shopper's search term per ad group, with its owner, its verb
 *            (pause and keep paused, negative exact / phrase / product target, here or in the campaign) or why it is
 *            held, its waste test over the late-order-safe window (days out of stock left out), its numbers, what waits
 *   stopped  everything stopped: kept-paused and paused keywords, standing negatives — who, since when, the spend before,
 *            still serving elsewhere, what it saved since (step 4: effect, "Did it work?"), and what may be done with each
 *            (and why not)
 *   row      one row with where its words run and where they are blocked in the market, and its history
 *   history  what was paused, kept, released, turned on, negated, removed, refused or skipped, with its delivery and undo
 *   words    the Words view (step 4, 2026-10-25): a word of 1 or 2 words next to each other that wastes across shoppers'
 *            search terms, with its terms, places, products, test and its verb (a negative phrase per place) or why held
 *   word     one word (wordId) with every term holding it, every place (each OPEN or why not, with its Nexus ids), each
 *            product's test, and the negatives made of it. Blocking a word is add-negative-targets with those places: the
 *            same request the page's Block word sends, one place each.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { readHistory } from '../../advertising/waste/history.js'
import { isMoneySort, MAX_PAGE_SIZE, WASTE_MONEY } from '../../advertising/waste/pure.js'
import { readWasteRows } from '../../advertising/waste/read.js'
import { readRowDetail } from '../../advertising/waste/row.js'
import { isStoppedMoneySort, readStopped, STOPPED_SORT_KEYS } from '../../advertising/waste/stopped.js'
import { readWordDetail, readWords } from '../../advertising/waste/words.js'
import { isWordMoneySort, WORD_SHOWS, WORD_SORT_RE } from '../../advertising/waste/words-pure.js'
import type { AgentTool } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

export const AD_WASTE_INPUT = z.object({
  view: z.enum(['rows', 'stopped', 'row', 'history', 'words', 'word']).default('rows')
    .describe('rows (default): what wastes — our keywords and targets, and shoppers\' search terms per ad group; stopped: kept-paused and paused keywords and standing negatives; row: one row (rowId) with where its words run and are blocked, and its history; history: what changed, newest first; words: words (1 or 2 next to each other) that waste across search terms; word: one word (wordId) with its terms, places and products'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('one Amazon market code (business-overview); omitted: every market with Amazon ads here (each row keeps its market and currency; spend is never added across currencies)'),
  portfolioId: ID.optional().describe('Amazon\'s portfolio id (ad-portfolios)'),
  productId: ID.optional().describe('a product (its family\'s campaigns), its Nexus id'),
  campaignId: ID.optional().describe('one campaign, its Nexus id (ad-campaigns)'),
  adGroupId: ID.optional().describe('one ad group, its Nexus id (ad-groups)'),
  rowId: z.string().trim().min(3).max(600).optional().describe('view row: kw:<AdTarget id>, term:<market>|<Amazon ad group id>|<words>, or neg:<negative AdTarget id> (from rows or stopped)'),
  wordId: z.string().trim().min(6).max(300).optional().describe('view word: word:<market>|<word> (from view words); the same scope as the words read gives the same numbers'),
  kind: z.enum(['keyword', 'term', 'all']).default('all').describe('keyword: our keywords and targets; term: shoppers\' search terms (stopped: negatives); all (default)'),
  show: z.string().trim().optional().describe('rows: wasting (default) · waiting · skipped · turned-on (kept paused, but switched on outside Nexus) · clashes (each with clash.label: turned on outside Nexus, a negative over our own keyword, a negative that blocks a term that sold here) · protected (wasting rows a protected term keeps safe, each with protection: the terms, their scope and why) · all. stopped: kept · negated · turned-on · still-bought · all (default). words: wasting (default) · blocked (a negative phrase stands over it somewhere) · all'),
  owner: z.string().trim().min(1).max(64).optional().describe('BRAIN · RULE · HARVEST · PERSON · CLAUDE · NONE, or an owner\'s id (a rule\'s id, brain)'),
  q: z.string().trim().max(200).optional().describe('words in the keyword or term, its campaign, ad group, portfolio or product (words: in the word or in one of its terms)'),
  sort: z.string().trim().regex(/^-?(spend|clicks|orders|xCpa|text|where|product|owner|state|terms|places|products|word|since|spendBefore|saved|stillServes)$/).optional().describe('rows: spend, clicks, orders, xCpa, text, where, product, owner, state; words: spend, clicks, orders, terms, places, products, word, state; stopped: text, where, product, owner, since, spendBefore, saved, state, stillServes (default: the newest stop first); a leading - for descending (default -spend)'),
  page: z.coerce.number().int().min(1).max(100_000).optional().describe('rows / stopped: the page, from 1 (default 1)'),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`rows per page (default 50, at most ${MAX_PAGE_SIZE})`),
  days: z.coerce.number().int().min(1).max(90).optional().describe('history: days back (default 30)'),
})

const ROW_SHOW = ['wasting', 'waiting', 'skipped', 'turned-on', 'clashes', 'protected', 'all'] as const
const ROW_SORT = /^-?(spend|clicks|orders|xCpa|text|where|product|owner|state)$/
const STOPPED_SHOW = ['kept', 'negated', 'turned-on', 'still-bought', 'all'] as const

const adWaste: AgentTool = {
  name: 'ad-waste',
  title: 'Ad waste',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: WASTE_MONEY as never,
  input: AD_WASTE_INPUT,
  description:
    'Read the Negative Targeting page of Amazon Sponsored Products (one market, or every market): what wastes ad money and how it is stopped. Two jobs: '
    + 'OUR keyword or target that spends with no sales is paused and kept paused (never a negative of the same words in its own '
    + 'ad group: it would block itself); a SHOPPER\'S search term that wastes gets a negative (exact, or a product target for an '
    + 'ASIN; in the whole campaign when it served in 2+ of its ad groups and no other ad group of it sold those words or holds our '
    + 'keyword of them). view rows (default; show wasting): one row per keyword '
    + 'or target (id kw:<AdTarget id>) and per search term in one ad group (id term:<market>|<Amazon ad group id>|<words>) in '
    + 'places that run, each with where (portfolio › campaign › ad group, links), the product (or productCount when the campaign '
    + 'is shared), via (the keyword that bought a term), its state (RUNNING, PAUSED, KEPT_PAUSED, TURNED_ON_ELSEWHERE — kept '
    + 'paused but switched on outside Nexus, its holder the owner — NEGATED: a negative blocks it there now (one switched off or '
    + 'never taken by Amazon blocks nothing), PAUSED on a search term: every keyword that bought it there is paused (Amazon does '
    + 'not buy it now: not wasting), PROTECTED: a protected term keeps it safe, '
    + 'its protection naming every such term — term, match EXACT / PREFIX / CONTAINS, market and campaign or null for every '
    + 'one, reason — and then, the hold its verb keeps once they are removed), ONE owner '
    + '(Brain, Rule by name, Harvest, a person by their own name — "A person" when Nexus has none, never "You" — Claude, or — ; a writer of the last 7 days is always the owner), its verb (PAUSE, '
    + 'NEGATE_EXACT, NEGATE_ASIN; where adGroup or campaign) or why it is held (protected, our own keyword there, harvested '
    + 'lately, a place under 14 days, a shared campaign, its terms sell; the page\'s preview and write refuse a held pause or '
    + 'negative with that reason), its test (met, the bar and who set it — the ads '
    + 'strategy\'s negate group, a rule, or the page\'s default: 0 orders, clicks at least max(20, 3 ÷ the product\'s pooled '
    + 'conversion rate), spend at least 1.5 × the product\'s target cost per order for a term and 2 × for a keyword with no '
    + 'search term under it sold, 60 days; a fixed bar when no target ACoS is set), the numbers d (clicks and spend to 3 days '
    + 'ago, orders to today — a late order can only save a row; days half the place\'s advertised products were out of stock '
    + 'left out of clicks and spend, counted in stockOutDays; d null = Amazon reported nothing: no data, not 0 orders), d90, '
    + 'spark (spend per week, 8 weeks), waiting (a request or a rule card waiting for a person: approvalId, or suggestion:<id>; '
    + 'action, match, level and text: the ask\'s OWN change at this row, never the row\'s verb; keepPaused on a pause; changes: '
    + 'how many of this page\'s changes the ask holds, all decided by one answer; rows: how many listed rows carry it; a row '
    + 'listed only for its ask has askOnly and test.judged false: the test never ran on it), '
    + 'skipped (until, by: the person\'s name), stillServesIn (other live ad groups where the words SPENT in the window, to its settled day, not blocked there now — never impressions alone), blockedBy (a NEGATED term: the negative that blocks it there — its words, match EXACT / PHRASE / ASIN and level AD_GROUP / CAMPAIGN), test.settledThrough (the last day its clicks and spend count), lastChange (with changeId for '
    + 'undo-ad-change). totals: the tiles from the same rows (wasting, waiting, kept paused, turned on elsewhere, negated, clashes — a negative in our live '
    + 'keyword\'s own place that blocks EVERY search it can serve (a negative exact or phrase of its words over our exact keyword, '
    + 'a negative phrase of its words over our phrase keyword, a negative product over our product target; never a negative exact '
    + 'over our phrase or broad keyword nor a negative phrase over our broad one: that is the funnel, on purpose), a negative that '
    + 'blocks a term that sold here (never a funnel negative), a keyword turned on outside Nexus — skipped, protected: exactly the rows show protected lists); criteria: the bar in force and the days it reads. view stopped: '
    + 'kept-paused and paused keywords (kw:) and standing negatives (neg:) in places that run, each with who stopped it (Brain '
    + 'funnel, Brain, Harvest, Playbook, a rule, a person by name, Claude, Amazon, Unknown), since when, the spend in the 30 days before, '
    + 'its state (KEPT_PAUSED, PAUSED, NEGATED, TURNED_ON_ELSEWHERE — kept paused but switched on outside Nexus — '
    + 'NOT_AT_AMAZON), stillServesIn (other live ad groups where its words spent since the stop, not blocked there now; the page\'s window when the stop day is not on record), places (the same negative in N places), effect ("Did it work?": verdict TOO_EARLY for '
    + 'the first 14 days, with no money; SAVED; or STILL_SPENDS when its words spent in another place since the stop — with '
    + 'beforePerDayCents (its place\'s spend per day over up to 30 days before the stop), afterCents (since the stop, to 3 '
    + 'days ago), savedCents (before × those days − after) and words; null when the stop day is not known or the days '
    + 'before it are older than Nexus keeps), and actions turnOn / removeNegative / release '
    + 'each with allowed and why (a Harvest or Brain-funnel negative is not removed here; a removed negative is final at '
    + 'Amazon; one Amazon never had is removed in Nexus only); show still-bought: a paused exact keyword whose words spent elsewhere since its stop. view row (rowId): the row, runsIn '
    + '(where its words run, with owner and numbers), blockedIn (every negative of those words, with who made each and its state: NEGATED blocks now, PAUSED or NOT_AT_AMAZON blocks nothing), blockedAdGroups (the live ad groups, other than the row\'s own, blocked NOW), settledThrough and its '
    + 'history. view history (days, default 30): paused, kept, released, turned_on, negated, removed, refused (the brain\'s '
    + 'refused negatives and refused writes too) and skipped, each with who, why, delivery (SENT, LIVE, UNDONE, FAILED, '
    + 'CANCELLED, REFUSED), changeId / changeSetId and whether undo is available and why. view words (show wasting by default, '
    + 'blocked, all): one row per word (id word:<market>|<word>) of 1 or 2 words next to each other (Amazon\'s phrase match; no '
    + 'stopword at an edge, no number, size or ASIN) that 2 or more shoppers\' search terms hold in places that run: terms (how '
    + 'many hold it), sold (how many of them sold), d (the sums of its terms\' numbers, each in its own window), places '
    + '(adGroups, campaigns, open, blocked), products, its state (WASTING, PARTLY_BLOCKED, BLOCKED — a negative phrase stands '
    + 'over it in every place — PROTECTED, HELD, NOT_WASTING) and stateWhy (that state in one sentence, true for the whole row: '
    + 'the product whose part wastes — the test is per product, the numbers are every product\'s — with what its other '
    + 'products did, what blocks or holds it, or why it does not waste; the same words the page shows), wastesFor (that '
    + 'product, its terms, ad groups and orders), its test (the search-term bar above, applied per product to '
    + 'the word\'s totals in that product\'s places, over 2 terms or more; met when one product\'s is), coveredBy (a 2-word '
    + 'piece one of whose words wastes too: blocking that word blocks it; left out of show wasting) and its verb NEGATE_PHRASE '
    + '(a negative phrase in each open place) or why it is held. view word (wordId, with the same scope): the row, terms '
    + '(each with its term rowId, where, product, numbers and sold), places (each ad group its terms spent in: OPEN, BLOCKED '
    + 'with the negative phrase, HELD with why — a protected term, our own keyword holding the word there, a term holding it '
    + 'harvested lately, a place under 14 days, a shared campaign, a term holding it that sold there, the same negative '
    + 'already waiting — or NOT_WASTING; with campaignId and adGroupId), products (each product\'s part and test) and the '
    + 'negatives made of it (history). To block a word: add-negative-targets with keywords [{ text: the word, matchType: '
    + 'NEGATIVE_PHRASE }] and adGroupIds = the OPEN places\' adGroupId (or scope CAMPAIGN with their campaignIds) — the page\'s '
    + 'Block word sends exactly that, one place a step. To act: pause-ads, '
    + 'add-negative-targets, retire-negatives, enable-ads (a person approves each); a protected row stops only once its '
    + 'protected terms are removed (set-ad-guardrail kind protected-term, op remove — a person approves it). Money is in cents of the row\'s currency '
    + 'under money keys (spendCents, salesCents, acosPct, cpcCents, xCpa, spendBarCents, wastingSpendCents — null across several currencies, then wastingSpendByCurrency and wastingSpendNote — spendBeforeCents, '
    + 'spark, beforePerDayCents, afterCents, savedCents): stripped for a person who may not see ad spend.',
  handler: async (raw, ctx) => {
    const a = AD_WASTE_INPUT.parse(raw)
    // As the route: a person who may not see ad spend is never ordered by it (the order would give the ranking away).
    const seesSpend = !ctx?.can || ctx.can(FIELDS.financialsAdspendView) || ctx.can(FIELDS.financialsView)
    const sort = a.sort && isMoneySort(a.sort) && !seesSpend ? 'where' : a.sort ?? (seesSpend ? '-spend' : 'where')
    const scope = { channel: 'AMAZON' as const, market: a.market, portfolioId: a.portfolioId, productId: a.productId, campaignId: a.campaignId, adGroupId: a.adGroupId }
    if (a.view === 'word') {
      if (!a.wordId) return { ok: false, error: 'view word needs wordId (word:<market>|<word>) from view words.' }
      const { market: _market, ...lists } = scope
      const out = await readWordDetail(a.wordId, lists)
      if ('error' in out) return { ok: false, error: out.error }
      const { ok: _ok, ...data } = out
      return { ok: true, data }
    }
    if (a.view === 'words') {
      const show = (a.show ?? 'wasting') as (typeof WORD_SHOWS)[number]
      if (!(WORD_SHOWS as readonly string[]).includes(show)) return { ok: false, error: `words: show is one of ${WORD_SHOWS.join(', ')}.` }
      if (a.sort && !WORD_SORT_RE.test(a.sort)) return { ok: false, error: 'words: sort is one of spend, clicks, orders, terms, places, products, word, state (a leading - for descending).' }
      // As the route: a person who may not see ad spend is never ordered by it (the most terms first instead).
      const wordSort = a.sort && isWordMoneySort(a.sort) && !seesSpend ? '-terms' : a.sort ?? (seesSpend ? '-spend' : '-terms')
      const out = await readWords({ ...scope, show, q: a.q, sort: wordSort, page: a.page, pageSize: a.pageSize })
      if ('error' in out) return { ok: false, error: out.error }
      const { ok: _ok, ...data } = out
      return { ok: true, data }
    }
    if (a.view !== 'stopped' && a.sort && !ROW_SORT.test(a.sort)) return { ok: false, error: 'sort is one of spend, clicks, orders, xCpa, text, where, product, owner, state (a leading - for descending).' }
    if (a.view === 'row') {
      if (!a.rowId) return { ok: false, error: 'view row needs rowId (kw:<id>, term:<market>|<ad group>|<words>, neg:<id>) from view rows or stopped.' }
      const out = await readRowDetail(a.rowId)
      if ('error' in out) return { ok: false, error: out.error }
      const { ok: _ok, ...data } = out
      return { ok: true, data }
    }
    if (a.view === 'history') {
      const out = await readHistory({ ...scope, days: a.days ?? 30, kind: a.kind })
      if ('error' in out) return { ok: false, error: out.error }
      return { ok: true, data: { rows: out.rows, days: out.days, truncated: out.truncated } }
    }
    if (a.view === 'stopped') {
      const show = (a.show ?? 'all') as (typeof STOPPED_SHOW)[number]
      if (!(STOPPED_SHOW as readonly string[]).includes(show)) return { ok: false, error: `stopped: show is one of ${STOPPED_SHOW.join(', ')}.` }
      const key = a.sort?.replace(/^-/, '')
      if (key && !(STOPPED_SORT_KEYS as readonly string[]).includes(key)) return { ok: false, error: `stopped: sort is one of ${STOPPED_SORT_KEYS.join(', ')} (a leading - for descending).` }
      // As the route: never ordered by money for a person who may not see it.
      const stoppedSort = a.sort && isStoppedMoneySort(a.sort) && !seesSpend ? 'where' : a.sort
      const out = await readStopped({ ...scope, kind: a.kind, owner: a.owner, show, q: a.q, sort: stoppedSort, page: a.page, pageSize: a.pageSize })
      if ('error' in out) return { ok: false, error: out.error }
      const { ok: _ok, ...data } = out
      return { ok: true, data }
    }
    const show = (a.show ?? 'wasting') as (typeof ROW_SHOW)[number]
    if (!(ROW_SHOW as readonly string[]).includes(show)) return { ok: false, error: `rows: show is one of ${ROW_SHOW.join(', ')}.` }
    const out = await readWasteRows({ ...scope, kind: a.kind, show, owner: a.owner, q: a.q, sort, page: a.page, pageSize: a.pageSize })
    if ('error' in out) return { ok: false, error: out.error }
    const { ok: _ok, ...data } = out
    return { ok: true, data }
  },
}

export const ADS_WASTE_TOOLS: AgentTool[] = [adWaste]
