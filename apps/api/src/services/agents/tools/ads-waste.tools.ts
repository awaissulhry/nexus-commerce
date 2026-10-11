/**
 * Negative Targeting page (NREAD, 2026-10-11) — `ad-waste`: Claude reads what the page reads, through the same service
 * functions (services/advertising/waste/*), so the page and Claude can never see two answers. Read only: nothing is
 * asked or sent. The writes stay the existing tools (pause-ads, add-negative-targets, retire-negatives, enable-ads).
 *
 *   rows     every keyword and target of ours and every shopper's search term per ad group, with its owner, its verb
 *            (pause and keep paused, negative exact / phrase / product target, here or in the campaign) or why it is
 *            held, its waste test over the late-order-safe window (days out of stock left out), its numbers, what waits
 *   stopped  everything stopped: kept-paused and paused keywords, standing negatives — who, since when, the spend before,
 *            still serving elsewhere, and what may be done with each (and why not)
 *   row      one row with where its words run and where they are blocked in the market, and its history
 *   history  what was paused, kept, released, turned on, negated, removed, refused or skipped, with its delivery and undo
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { readHistory } from '../../advertising/waste/history.js'
import { isMoneySort, MAX_PAGE_SIZE, WASTE_MONEY } from '../../advertising/waste/pure.js'
import { readWasteRows } from '../../advertising/waste/read.js'
import { readRowDetail } from '../../advertising/waste/row.js'
import { readStopped } from '../../advertising/waste/stopped.js'
import type { AgentTool } from '../tool-types.js'

const ID = z.string().trim().min(1).max(64)

export const AD_WASTE_INPUT = z.object({
  view: z.enum(['rows', 'stopped', 'row', 'history']).default('rows')
    .describe('rows (default): what wastes — our keywords and targets, and shoppers\' search terms per ad group; stopped: kept-paused and paused keywords and standing negatives; row: one row (rowId) with where its words run and are blocked, and its history; history: what changed, newest first'),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('one Amazon market code (business-overview); omitted: every market with Amazon ads here (each row keeps its market and currency; spend is never added across currencies)'),
  portfolioId: ID.optional().describe('Amazon\'s portfolio id (ad-portfolios)'),
  productId: ID.optional().describe('a product (its family\'s campaigns), its Nexus id'),
  campaignId: ID.optional().describe('one campaign, its Nexus id (ad-campaigns)'),
  adGroupId: ID.optional().describe('one ad group, its Nexus id (ad-groups)'),
  rowId: z.string().trim().min(3).max(600).optional().describe('view row: kw:<AdTarget id>, term:<market>|<Amazon ad group id>|<words>, or neg:<negative AdTarget id> (from rows or stopped)'),
  kind: z.enum(['keyword', 'term', 'all']).default('all').describe('keyword: our keywords and targets; term: shoppers\' search terms (stopped: negatives); all (default)'),
  show: z.string().trim().optional().describe('rows: wasting (default) · waiting · skipped · turned-on (kept paused, but switched on outside Nexus) · clashes (each with clash.label: turned on outside Nexus, a negative over our own keyword, a negative that blocks a term that sold here) · all. stopped: kept · negated · turned-on · still-bought · all (default)'),
  owner: z.string().trim().min(1).max(64).optional().describe('BRAIN · RULE · HARVEST · PERSON · CLAUDE · NONE, or an owner\'s id (a rule\'s id, brain)'),
  q: z.string().trim().max(200).optional().describe('words in the keyword or term, its campaign, ad group, portfolio or product'),
  sort: z.string().trim().regex(/^-?(spend|clicks|orders|xCpa|text|where|product|owner|state)$/).optional().describe('rows: spend, clicks, orders, xCpa, text, where, product, owner, state; a leading - for descending (default -spend)'),
  page: z.coerce.number().int().min(1).max(100_000).optional().describe('rows / stopped: the page, from 1 (default 1)'),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional().describe(`rows per page (default 50, at most ${MAX_PAGE_SIZE})`),
  days: z.coerce.number().int().min(1).max(90).optional().describe('history: days back (default 30)'),
})

const ROW_SHOW = ['wasting', 'waiting', 'skipped', 'turned-on', 'clashes', 'all'] as const
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
    + 'ASIN; in the whole campaign when it served in 2+ of its ad groups). view rows (default; show wasting): one row per keyword '
    + 'or target (id kw:<AdTarget id>) and per search term in one ad group (id term:<market>|<Amazon ad group id>|<words>) in '
    + 'places that run, each with where (portfolio › campaign › ad group, links), the product (or productCount when the campaign '
    + 'is shared), via (the keyword that bought a term), its state (RUNNING, PAUSED, KEPT_PAUSED, TURNED_ON_ELSEWHERE — kept '
    + 'paused but switched on outside Nexus, its holder the owner — NEGATED, PROTECTED), ONE owner '
    + '(Brain, Rule by name, Harvest, You, Claude, or — ; a writer of the last 7 days is always the owner), its verb (PAUSE, '
    + 'NEGATE_EXACT, NEGATE_ASIN; where adGroup or campaign) or why it is held (protected, our own keyword there, harvested '
    + 'lately, a place under 14 days, a shared campaign, its terms sell), its test (met, the bar and who set it — the ads '
    + 'strategy\'s negate group, a rule, or the page\'s default: 0 orders, clicks at least max(20, 3 ÷ the product\'s pooled '
    + 'conversion rate), spend at least 1.5 × the product\'s target cost per order for a term and 2 × for a keyword with no '
    + 'search term under it sold, 60 days; a fixed bar when no target ACoS is set), the numbers d (clicks and spend to 3 days '
    + 'ago, orders to today — a late order can only save a row; days half the place\'s advertised products were out of stock '
    + 'left out of clicks and spend, counted in stockOutDays; d null = Amazon reported nothing: no data, not 0 orders), d90, '
    + 'spark (spend per week, 8 weeks), waiting (a request or a rule card waiting for a person: approvalId, or suggestion:<id>), '
    + 'skipped, stillServesIn (other places where the words still spend, not blocked), lastChange (with changeId for '
    + 'undo-ad-change). totals: the tiles from the same rows (wasting, waiting, kept paused, turned on elsewhere, negated, clashes — our live keyword '
    + 'blocked by a negative in its own place — skipped); criteria: the bar in force and the days it reads. view stopped: '
    + 'kept-paused and paused keywords (kw:) and standing negatives (neg:) in places that run, each with who stopped it (Brain '
    + 'funnel, Brain, Harvest, Playbook, a rule, You, Claude, Amazon, Unknown), since when, the spend in the 30 days before, '
    + 'its state (KEPT_PAUSED, PAUSED, NEGATED, TURNED_ON_ELSEWHERE — kept paused but switched on outside Nexus — '
    + 'NOT_AT_AMAZON), stillServesIn, places (the same negative in N places), and actions turnOn / removeNegative / release '
    + 'each with allowed and why (a Harvest or Brain-funnel negative is not removed here; a removed negative is final at '
    + 'Amazon); show still-bought: a paused exact keyword whose words still spend elsewhere. view row (rowId): the row, runsIn '
    + '(where its words run, with owner and numbers), blockedIn (the negatives that block them, with who made each) and its '
    + 'history. view history (days, default 30): paused, kept, released, turned_on, negated, removed, refused (the brain\'s '
    + 'refused negatives and refused writes too) and skipped, each with who, why, delivery (SENT, LIVE, UNDONE, FAILED, '
    + 'CANCELLED, REFUSED), changeId / changeSetId and whether undo is available and why. To act: pause-ads, '
    + 'add-negative-targets, retire-negatives, enable-ads (a person approves each). Money is in cents of the row\'s currency '
    + 'under money keys (spendCents, salesCents, acosPct, cpcCents, xCpa, spendBarCents, wastingSpendCents — null across several currencies, then wastingSpendByCurrency and wastingSpendNote — spendBeforeCents, '
    + 'spark): stripped for a person who may not see ad spend.',
  handler: async (raw, ctx) => {
    const a = AD_WASTE_INPUT.parse(raw)
    // As the route: a person who may not see ad spend is never ordered by it (the order would give the ranking away).
    const seesSpend = !ctx?.can || ctx.can(FIELDS.financialsAdspendView) || ctx.can(FIELDS.financialsView)
    const sort = a.sort && isMoneySort(a.sort) && !seesSpend ? 'where' : a.sort ?? (seesSpend ? '-spend' : 'where')
    const scope = { channel: 'AMAZON' as const, market: a.market, portfolioId: a.portfolioId, productId: a.productId, campaignId: a.campaignId, adGroupId: a.adGroupId }
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
      const out = await readStopped({ ...scope, kind: a.kind, owner: a.owner, show, q: a.q, page: a.page, pageSize: a.pageSize })
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
