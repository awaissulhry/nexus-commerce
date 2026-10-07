/**
 * ADS AUTONOMY W4-3 (Owner 10-07: Claude works like a worker — every Amazon ads action on the Nexus screens has a tool) —
 * portfolios, as the Portfolios page (marketing/ads/portfolios) shows and changes them, through the page's own services:
 *
 *   ad-portfolios   read: each portfolio by market — name, state, budget cap (amount, policy, dates, within it or not),
 *                   its campaigns, and spend, sales and ACoS over a window (the page's own numbers, getPortfolioOverview).
 *                   `portfolioId` is Amazon's id, the one set-portfolio and set-campaign-settings take.
 *   set-portfolio   create   a new portfolio in one market (createPortfolio, PB-4: the page's Create), with an optional
 *                            budget cap set right after it (updatePortfolioById: the page's Set budget);
 *                   update   a new name and/or a budget cap (updatePortfolioById: the page's Rename and Set budget);
 *                   archive  for good (updatePortfolioById, state archived: the page's Archive).
 *                   A cap cannot be removed: neither the page nor Nexus's Amazon client sends "no cap" (Seller Central
 *                   can). Moving campaigns into or out of a portfolio is set-campaign-settings.
 *
 * Like every ad change tool (ads-change-kit.ts): the preview says where it lands (live at Amazon on which profile, or
 * sandbox) and a refusal is not queued; it runs only as an approved request, as the approver, its ads audit rows carrying
 * the approval as change set; `execute` refuses when what was approved moved. These writes are the page's own direct
 * pushes: they reach Amazon as soon as the request runs, with no 5-minute cancel window (as on the page). Whatever can
 * add spend — a cap raised, its policy or dates changed, an archive that frees a capped portfolio's campaigns — is listed
 * in `raises` and said in the effect; the Owner's code rule (ads-code-rule.ts) makes it a day-to-day change: a person's
 * approval sends it with no authenticator code (portfolioStepUp decides it). Strategy-bound (ads-autonomy-kit.ts): the portfolio
 * kind (an archive is the archive kind too); by default nothing runs by rule (no market is listed in its limits).
 */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import {
  createPortfolio,
  getPortfolioOverview,
  portfolioCreateGate,
  portfolioDetails,
  portfolioUpdateOf,
  portfolioWriteGate,
  updatePortfolioById,
  type PortfolioDetail,
} from '../../advertising/ads-portfolio.service.js'
import { marketCurrency } from '../../pim/market-currency.js'
import { STEP_UP_NEEDS, type StepUp } from '../step-up-approval.js'
import { ADDS_NO_SPEND, addsSpendWords, codeGate, DAY_TO_DAY_NO_CODE, needsCode } from './ads-code-rule.js'
import { amountLabel, liveReachOf } from './ads-tool-guards.js'
import { approvedRun, BY_RULE_WORDS, canonical, notRun, reachNote, reachRefusal, recheck, ruleFactsFor, ruleRefusal, storedReach } from './ads-change-kit.js'
import { adKitLimits, type KitItem } from './ads-autonomy-kit.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const TOOL = 'set-portfolio'
const ADSPEND = FIELDS.financialsAdspendView
/** The most portfolios one read returns (an account holds dozens). */
const MAX_PORTFOLIOS = 100
/** The campaigns named per portfolio in a read; the rest are counted. */
const CAMPAIGNS_SHOWN = 20
const MAX_DAYS = 90

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('base64url').slice(0, 32)
const today = () => new Date().toISOString().slice(0, 10)
const quote = (name: string) => `"${name}"`

/** A cap policy as Claude's tools say it; handed to the client in the page's words, which sends Amazon's (portfolioPolicyV3). */
const POLICY_OF: Record<string, 'monthly' | 'dateRange'> = { MONTHLY_RECURRING: 'monthly', DATE_RANGE: 'dateRange' }
const CLIENT_POLICY = { monthly: 'monthlyRecurring', dateRange: 'dateRange' } as const

/** A cap Nexus can read, as Claude's tools hold it: minor units of its currency, the policy, the dates of a dateRange. */
export interface Cap { amountCents: number; currency: string; policy: 'monthly' | 'dateRange'; startDate: string | null; endDate: string | null }
/**
 * A cap stored in a form Nexus cannot read — a policy it does not know, a policy without an amount (or the reverse), no
 * currency, a date range without dates. FAIL CLOSED: any change of it, or of what it holds, counts as one that may add
 * spend (listed in raises).
 */
export interface UnreadCap { unread: true; why: string; policy: string | null; amountCents: number | null; currency: string | null }
export type HeldCap = Cap | UnreadCap
export const isUnread = (cap: HeldCap | null | undefined): cap is UnreadCap => !!cap && 'unread' in cap

export const capWords = (cap: HeldCap | null) => {
  if (!cap) return 'no cap'
  if (isUnread(cap)) return `a cap Nexus cannot read (${cap.why})`
  return cap.policy === 'monthly'
    ? `${amountLabel(cap.amountCents, cap.currency)} a month`
    : `${amountLabel(cap.amountCents, cap.currency)} from ${cap.startDate} to ${cap.endDate}`
}

/**
 * The cap a portfolio holds now; null when none. The stored policy is read in every spelling Nexus's writers use
 * (capPolicyOf: MONTHLY_RECURRING, monthlyRecurring, DATE_RANGE, dateRange …); anything else is an UnreadCap.
 */
export function capOf(pf: Pick<PortfolioDetail, 'cap'>, fallbackCurrency: string | null): HeldCap | null {
  if (!pf.cap) return null
  const policy = pf.cap.policy ? POLICY_OF[pf.cap.policy] : undefined
  const currency = pf.cap.currency ?? fallbackCurrency
  const unread = (why: string): UnreadCap => ({ unread: true, why, policy: pf.cap!.policy, amountCents: pf.cap!.amountCents, currency })
  if (!policy) return unread(pf.cap.policy ? `its policy "${pf.cap.policy}" is not one Nexus knows` : 'it holds an amount and no policy')
  if (pf.cap.amountCents == null) return unread('it holds a policy and no amount')
  if (!currency) return unread('Nexus does not know its currency')
  if (policy === 'dateRange' && (!pf.cap.startDate || !pf.cap.endDate)) return unread('it is a date range without its dates')
  return { amountCents: pf.cap.amountCents, currency, policy, startDate: pf.cap.startDate, endDate: pf.cap.endDate }
}

/** The currency of an Amazon market: as configured (Marketplace), else Amazon's checked limits for it; null: unknown. */
export async function currencyOfMarket(market: string | null): Promise<string | null> {
  if (!market) return null
  try {
    return await marketCurrency('AMAZON', market)
  } catch {
    return marketLimitsOf(market)?.currency ?? null
  }
}

/**
 * Pure — how a cap change moves spend (a portfolio's own cap changed, or a campaign moving from one portfolio's cap to
 * another's). A cap where there was none, or a lower one with the same policy and dates, holds spend back (cut). A cap
 * let go, a higher amount, another policy (the amounts no longer compare) or a date range that starts earlier or ends
 * later can let more spend (raise). A cap Nexus cannot read on either side: a raise (fail closed), unless nothing moves.
 */
export function capMove(from: HeldCap | null, to: HeldCap | null): { direction: 'raise' | 'cut' | 'same'; why: string | null } {
  if (isUnread(from) || isUnread(to)) {
    if (canonical(from) === canonical(to)) return { direction: 'same', why: null }
    const unread = (isUnread(from) ? from : to) as UnreadCap
    return { direction: 'raise', why: `${isUnread(from) ? 'the cap it holds now' : 'the cap it gets'} is ${capWords(unread)}, so Nexus cannot tell whether it lets more spend: it counts as a raise` }
  }
  if (!from && !to) return { direction: 'same', why: null }
  if (!from) return { direction: 'cut', why: null }
  if (!to) return { direction: 'raise', why: `the cap ${capWords(from)} no longer holds it` }
  const same = from.amountCents === to.amountCents && from.policy === to.policy && from.startDate === to.startDate && from.endDate === to.endDate
  if (same) return { direction: 'same', why: null }
  if (from.policy !== to.policy) return { direction: 'raise', why: `its cap changes from ${capWords(from)} to ${capWords(to)}: another kind of cap may let more spend` }
  if (to.amountCents > from.amountCents) return { direction: 'raise', why: `its cap rises from ${capWords(from)} to ${capWords(to)}` }
  if (to.policy === 'dateRange' && ((to.startDate ?? '') < (from.startDate ?? '') || (to.endDate ?? '') > (from.endDate ?? ''))) {
    return { direction: 'raise', why: `its cap's dates widen from ${from.startDate}–${from.endDate} to ${to.startDate}–${to.endDate}` }
  }
  return { direction: 'cut', why: null }
}

// ── ad-portfolios (read) ──────────────────────────────────────────────────────────────────────────

/** The cap's amount (spend, sales and ACoS are the shared registry's money keys). Whether spend is within the cap says no amount. */
const PORTFOLIO_MONEY = { capCents: ADSPEND } as const

const adPortfolios: AgentTool = {
  name: 'ad-portfolios',
  title: 'Ad portfolios',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView],
  restrictedFields: PORTFOLIO_MONEY,
  input: z.object({
    market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('only this Amazon marketplace: IT, DE, FR, ES, UK, …'),
    portfolioId: z.string().trim().min(1).max(64).optional().describe("only this portfolio: Amazon's portfolio id (portfolio.id in ad-campaigns)"),
    search: z.string().trim().min(1).max(100).optional().describe('only portfolios whose name contains this text'),
    days: z.coerce.number().int().min(1).max(MAX_DAYS).default(30)
      .describe(`the spend window: the last N complete days, ending yesterday — today has no daily report yet (default 30, max ${MAX_DAYS})`),
  }),
  description:
    'The Amazon Ads portfolios, by market, as the Portfolios page shows them. Per portfolio: portfolioId (Amazon\'s id, '
    + 'the one set-portfolio and set-campaign-settings take), name, market, state, whether Amazon holds it (atAmazon: '
    + 'false for one made in Nexus while writes were closed, which no campaign can be moved into), its budget cap '
    + '(amount, monthly or a date range with its dates, and whether spend is within it), its campaigns (counted as the '
    + 'page counts them: enabled and paused; archived apart; the first 20 named with their campaignId and status), and '
    + 'spend, sales and ACoS over the window from the daily reports (the last 3 days provisional). Amounts are minor units '
    + '(cents) of the portfolio market\'s currency, named beside them and never converted; a person without the ad-spend '
    + 'money permission gets the same answer without the amounts. Filter by market, portfolio or name.',
  async handler(args) {
    const a = args as { market?: string; portfolioId?: string; search?: string; days: number }
    const [details, overview] = await Promise.all([
      portfolioDetails({ ...(a.portfolioId ? { portfolioIds: [a.portfolioId] } : {}), market: a.market ?? null }),
      getPortfolioOverview({ windowDays: String(a.days) }),
    ])
    const money = new Map(overview.portfolios.map((p) => [p.portfolioId, p]))
    const search = a.search?.toLowerCase()
    const rows = details
      .filter((p) => !search || p.name.toLowerCase().includes(search))
      .sort((x, y) => (x.market ?? '').localeCompare(y.market ?? '') || x.name.localeCompare(y.name) || x.portfolioId.localeCompare(y.portfolioId))
    const currencies = new Map<string, string | null>()
    for (const market of new Set(rows.map((p) => p.market).filter((m): m is string => !!m))) currencies.set(market, await currencyOfMarket(market))
    const items = rows.slice(0, MAX_PORTFOLIOS).map((p) => {
      const m = money.get(p.portfolioId)
      const currency = p.cap?.currency ?? (p.market ? currencies.get(p.market) ?? null : null)
      const counted = p.campaigns.filter((c) => c.status === 'ENABLED' || c.status === 'PAUSED')
      const held = capOf(p, currency)
      return {
        portfolioId: p.portfolioId,
        name: p.name,
        market: p.market,
        state: p.state,
        atAmazon: p.atAmazon,
        currency,
        cap: p.cap
          ? {
            capCents: p.cap.amountCents, policy: held && !isUnread(held) ? held.policy : 'unreadable', storedPolicy: p.cap.policy,
            startDate: p.cap.startDate, endDate: p.cap.endDate, inBudget: p.cap.inBudget,
            ...(isUnread(held) ? { note: `Nexus cannot read this cap: ${held.why}. Any change of it, or of the campaigns it holds, counts as a raise.` } : {}),
          }
          : null,
        campaigns: {
          counted: counted.length,
          enabled: counted.filter((c) => c.status === 'ENABLED').length,
          archived: p.campaigns.filter((c) => c.status === 'ARCHIVED').length,
          named: p.campaigns.slice(0, CAMPAIGNS_SHOWN).map((c) => ({ campaignId: c.id, name: c.name, status: c.status })),
          ...(p.campaigns.length > CAMPAIGNS_SHOWN ? { more: p.campaigns.length - CAMPAIGNS_SHOWN } : {}),
        },
        metrics: { spendCents: m?.spendCents ?? 0, salesCents: m?.salesCents ?? 0, acos: m?.acos ?? null },
        lastSyncedAt: p.lastSyncedAt,
      }
    })
    return {
      ok: true,
      data: {
        window: { from: overview.range.startDate, to: overview.range.endDate, days: a.days },
        items,
        total: rows.length,
        ...(rows.length > MAX_PORTFOLIOS ? { more: `Only the first ${MAX_PORTFOLIOS} (by market and name) are listed: narrow with market or search.` } : {}),
        ...(rows.length ? {} : { empty: a.portfolioId ? `Portfolio ${a.portfolioId} not found in this business.` : a.market ? `No portfolio in market ${a.market}.` : 'No portfolio in this business.' }),
      },
    }
  },
}

// ── set-portfolio (change) ────────────────────────────────────────────────────────────────────────

const OPS = ['create', 'update', 'archive'] as const
type Op = (typeof OPS)[number]
const DATE = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'a date is YYYY-MM-DD')

const capInput = z.object({
  amountCents: z.coerce.number().int().min(1).max(100_000_000)
    .describe("the cap in minor units (cents) of the portfolio market's currency, never converted"),
  policy: z.enum(['monthly', 'dateRange'])
    .describe('monthly: the cap renews every calendar month (Amazon\'s MONTHLY_RECURRING); dateRange: one cap from startDate to endDate'),
  startDate: DATE.optional().describe('dateRange: the first day (YYYY-MM-DD)'),
  endDate: DATE.optional().describe('dateRange: the last day (YYYY-MM-DD)'),
})

const input = z.object({
  op: z.enum(OPS).describe('create: a new portfolio in one market (name, market, optional cap); update: a new name and/or a budget cap (portfolioId); archive: for good (portfolioId)'),
  portfolioId: z.string().trim().min(1).max(64).optional().describe("update, archive: Amazon's portfolio id (portfolioId in ad-portfolios)"),
  market: z.string().trim().toUpperCase().min(2).max(20).optional().describe('create: the Amazon marketplace code (IT, DE, FR, ES, UK, …; business-overview lists them)'),
  name: z.string().trim().min(1).max(128).optional().describe('create: its name; update: a new name. A market holds one portfolio per name'),
  cap: capInput.optional().describe("create, update: a budget cap, as the Portfolios page's Set budget sets it (a cap cannot be removed here)"),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof input>

const PERMANENT = 'PERMANENT: Amazon does not bring an archived portfolio back. Its campaigns are not archived: they leave it (and its budget cap) and keep running.'
const DIRECT = "Sent to Amazon as soon as it is approved: the Portfolios page's own push, with no 5-minute cancel window."
const STEP_UP_HOW = 'A person with settings.security.manage approves it in Nexus with their authenticator code, or the person who asked '
  + "confirms it in Claude with theirs. By rule only inside this tool's limits (maxCapCents, allowArchive), which are loosened only with that code."

/**
 * set-portfolio's code decision, in ONE place: the Owner's code rule (ads-code-rule.ts) makes a cap raised or an archive
 * that frees a capped portfolio's campaigns a day-to-day change — listed in raises and said in the effect, and a person's
 * approval sends it (no stepUp).
 */
function portfolioStepUp(raises: readonly unknown[], archive: boolean): { stepUp: StepUp } | { noCode: string } {
  if (!raises.length) return { noCode: ADDS_NO_SPEND }
  if (!needsCode('set-portfolio')) return { noCode: DAY_TO_DAY_NO_CODE }
  return { stepUp: { what: archive ? 'archives a capped portfolio, which frees its campaigns from its budget cap' : "raises a portfolio's budget cap", raises: ['Portfolio budget cap'], needs: STEP_UP_NEEDS, how: STEP_UP_HOW } }
}

/** What one request decided: its preview, and what `execute` writes. */
interface PortfolioPlan {
  op: Op
  market: string
  currency: string | null
  portfolio: { portfolioId: string; profileId: string; name: string; state: string | null; campaigns: number; cap: HeldCap | null } | null
  name: { from: string | null; to: string } | null
  cap: { from: HeldCap | null; to: Cap } | null
  archive: boolean
}

const refuse = (error: string): { result: ToolResult; plan: null } => ({ result: { ok: false, error }, plan: null })

/** The portfolio this market already has under this name (Amazon takes one per name), or null. */
async function nameTaken(market: string, name: string, except: string | null): Promise<PortfolioDetail | null> {
  const key = name.trim().toLowerCase()
  return (await portfolioDetails({ market })).find((p) => p.portfolioId !== except && (p.state ?? '').toUpperCase() !== 'ARCHIVED' && p.name.trim().toLowerCase() === key) ?? null
}

/** The cap asked for, checked as the page's route checks it (portfolioUpdateOf) and against today; or why not. */
function capAsked(cap: NonNullable<Args['cap']>, currency: string): { cap: Cap; refusal?: undefined } | { refusal: string } {
  const asked = portfolioUpdateOf({ budget: { amount: cap.amountCents / 100, currencyCode: currency, policy: CLIENT_POLICY[cap.policy], startDate: cap.startDate, endDate: cap.endDate } })
  if ('error' in asked) return { refusal: `Not queued: ${asked.error === 'dateRange budget requires startDate + endDate' ? 'a dateRange cap needs both startDate and endDate' : asked.error}.` }
  if (cap.policy === 'monthly' && (cap.startDate || cap.endDate)) return { refusal: 'Not queued: a monthly cap takes no dates (startDate, endDate are for a dateRange cap).' }
  if (cap.policy === 'dateRange') {
    const valid = (d: string) => !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
    if (!valid(cap.startDate!) || !valid(cap.endDate!)) return { refusal: 'Not queued: startDate and endDate must be real dates (YYYY-MM-DD).' }
    if (cap.endDate! < cap.startDate!) return { refusal: `Not queued: the cap's endDate ${cap.endDate} is before its startDate ${cap.startDate}.` }
    if (cap.endDate! < today()) return { refusal: `Not queued: the cap's endDate ${cap.endDate} is in the past.` }
  }
  return { cap: { amountCents: cap.amountCents, currency, policy: cap.policy, startDate: cap.policy === 'dateRange' ? cap.startDate! : null, endDate: cap.policy === 'dateRange' ? cap.endDate! : null } }
}

/** The request decided: its preview and plan (the dry run, and again in `execute`). */
async function decide(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'approvalId'>): Promise<{ result: ToolResult; plan: PortfolioPlan | null }> {
  const parsed = input.safeParse(raw)
  if (!parsed.success) return refuse(parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; '))
  const a = parsed.data
  let plan: PortfolioPlan
  let payloadValueCents = 0

  if (a.op === 'create') {
    if (a.portfolioId) return refuse('Not queued: op create makes a new portfolio and names no portfolioId (to change one, use op update).')
    if (!a.market || !a.name) return refuse('Not queued: op create needs market and name.')
    const taken = await nameTaken(a.market, a.name, null)
    if (taken) return refuse(`Not queued: ${a.market} already has a portfolio named ${quote(taken.name)} (portfolioId ${taken.portfolioId}): a market holds one portfolio per name, so give the new one another name.`)
    const currency = await currencyOfMarket(a.market)
    if (a.cap && !currency) return refuse(`Not queued: Nexus does not know the currency of ${a.market}, so it cannot read the cap.`)
    let capTo: Cap | null = null
    if (a.cap) {
      const asked = capAsked(a.cap, currency!)
      if (asked.refusal !== undefined) return refuse(asked.refusal)
      capTo = (asked as { cap: Cap }).cap
    }
    plan = { op: 'create', market: a.market, currency, portfolio: null, name: { from: null, to: a.name }, cap: capTo ? { from: null, to: capTo } : null, archive: false }
    payloadValueCents = capTo?.amountCents ?? 0
  } else {
    if (!a.portfolioId) return refuse(`Not queued: op ${a.op} needs portfolioId (Amazon's portfolio id, from ad-portfolios).`)
    if (a.market) return refuse(`Not queued: op ${a.op} takes no market (the portfolio's own market is used).`)
    const [pf] = await portfolioDetails({ portfolioIds: [a.portfolioId] })
    if (!pf) return refuse(`Not queued: portfolio ${a.portfolioId} not found in this business.`)
    const label = `portfolio ${quote(pf.name)}`
    if (!pf.market) return refuse(`Not queued: Nexus cannot tell which market ${label} belongs to (no connection names its profile and it holds no campaign).`)
    if ((pf.state ?? '').toUpperCase() === 'ARCHIVED') {
      return refuse(a.op === 'archive' ? `Nothing would change: ${label} is archived already.` : `Not queued: ${label} is archived: Amazon does not change an archived portfolio.`)
    }
    const currency = pf.cap?.currency ?? (await currencyOfMarket(pf.market))
    const now = capOf(pf, currency)
    const serving = pf.campaigns.filter((c) => c.status === 'ENABLED' || c.status === 'PAUSED').length
    const portfolio = { portfolioId: pf.portfolioId, profileId: pf.profileId, name: pf.name, state: pf.state, campaigns: serving, cap: now }
    if (a.op === 'archive') {
      if (a.name || a.cap) return refuse('Not queued: op archive takes no name or cap.')
      plan = { op: 'archive', market: pf.market, currency, portfolio, name: null, cap: null, archive: true }
    } else {
      if (!a.name && !a.cap) return refuse(`Nothing to change for ${label}: give a new name (name) or a budget cap (cap). A cap cannot be removed here.`)
      const rename = a.name && a.name !== pf.name ? a.name : null
      if (rename) {
        const taken = await nameTaken(pf.market, rename, pf.portfolioId)
        if (taken) return refuse(`Not queued: ${pf.market} already has a portfolio named ${quote(taken.name)} (portfolioId ${taken.portfolioId}): a market holds one portfolio per name.`)
      }
      if (a.cap && !currency) return refuse(`Not queued: Nexus does not know the currency of ${pf.market}, so it cannot read the cap.`)
      let capTo: Cap | null = null
      if (a.cap) {
        const asked = capAsked(a.cap, currency!)
        if (asked.refusal !== undefined) return refuse(asked.refusal)
        capTo = (asked as { cap: Cap }).cap
      }
      const capChanges = capTo && capMove(now, capTo).direction !== 'same' ? { from: now, to: capTo } : null
      if (!rename && !capChanges) {
        return refuse(`Nothing would change: ${label} already has ${[a.name ? `the name ${quote(pf.name)}` : null, a.cap ? `that cap (${capWords(now)})` : null].filter(Boolean).join(' and ')}.`)
      }
      plan = { op: 'update', market: pf.market, currency, portfolio, name: rename ? { from: pf.name, to: rename } : null, cap: capChanges, archive: false }
      payloadValueCents = capChanges?.to.amountCents ?? 0
    }
  }

  // Where it lands: the page's own services asked without writing (the same connection lookup, the same write gate).
  const gate = plan.op === 'create'
    ? await portfolioCreateGate(plan.market)
    : await portfolioWriteGate({ portfolioId: plan.portfolio!.portfolioId, profileId: plan.portfolio!.profileId }, payloadValueCents)
  if ('nexusOnly' in gate) {
    return refuse(plan.op === 'create'
      ? `Not queued: ${gate.nexusOnly}, and Amazon refuses a campaign in a portfolio it does not know.`
      : `Not queued: portfolio ${quote(plan.portfolio!.name)} — ${gate.nexusOnly}.`)
  }
  let reach = liveReachOf(gate.decision)
  // A cap set with a new portfolio is a second write, judged by its own value (the gate's value cap).
  if (reach.reach !== 'refused' && plan.op === 'create' && payloadValueCents) {
    const { checkAdsWriteGate } = await import('../../advertising/ads-write-gate.js')
    const second = liveReachOf(await checkAdsWriteGate({ marketplace: plan.market, payloadValueCents }))
    if (second.reach === 'refused') reach = second
  }
  if (reach.reach === 'refused') return refuse(reachRefusal(reach))
  const stored = storedReach(reach)

  // What can add spend: a cap that may let more through, an archive that frees a capped portfolio's campaigns.
  const raises: Array<{ what: string; why: string }> = []
  const capDirection = plan.cap ? capMove(plan.cap.from, plan.cap.to) : null
  if (capDirection?.direction === 'raise') raises.push({ what: 'Budget cap', why: capDirection.why! })
  if (plan.archive && plan.portfolio!.cap && plan.portfolio!.campaigns) {
    raises.push({ what: 'Budget cap', why: `archiving it lets its ${plural(plan.portfolio!.campaigns, 'campaign')} spend without its cap (${capWords(plan.portfolio!.cap)})` })
  }
  const direction = raises.length ? 'raise' : capDirection?.direction === 'cut' ? 'cut' : 'same'
  const label = plan.portfolio ? `portfolio ${quote(plan.portfolio.name)}` : `the new portfolio ${quote(plan.name!.to)}`
  const lines = [
    ...(plan.op === 'create' ? [{ label: 'Portfolio', from: null, to: `${quote(plan.name!.to)} in ${plan.market}` }] : []),
    ...(plan.op === 'update' && plan.name ? [{ label: 'Name', from: plan.name.from, to: plan.name.to }] : []),
    ...(plan.cap ? [{ label: 'Budget cap', from: capWords(plan.cap.from), to: capWords(plan.cap.to) }] : []),
    ...(plan.archive ? [{ label: 'State', from: plan.portfolio!.state ?? 'ENABLED', to: 'ARCHIVED' }] : []),
  ]
  const setting = plan.op === 'create' ? 'new portfolio' : plan.archive ? 'portfolio state' : [plan.name ? 'portfolio name' : null, plan.cap ? 'portfolio budget cap' : null].filter(Boolean).join(', ')
  const item: KitItem = {
    entity: { kind: 'products', market: plan.market, productIds: [], label },
    change: {
      field: 'setting', setting,
      from: plan.op === 'create' ? null : lines.map((l) => `${l.label}: ${l.from ?? 'none'}`).join('; '),
      to: lines.map((l) => `${l.label}: ${l.to}`).join('; '),
      ...(direction === 'raise' ? { raises: true } : direction === 'cut' ? { cuts: true } : {}),
    },
  }
  const facts = await ruleFactsFor({ tool: TOOL, limits: PORTFOLIO_LIMITS, items: [item], writes: [], approvalId: ctx.approvalId ?? null })

  const code = portfolioStepUp(raises, plan.archive)
  const effect = (plan.op === 'create'
    ? `Creates the portfolio ${quote(plan.name!.to)} in ${plan.market}${plan.cap ? `, with a budget cap of ${capWords(plan.cap.to)}` : ', with no budget cap'}. It holds no campaign yet: set-campaign-settings moves campaigns into it.`
    : plan.archive
      ? `Archives ${label} in ${plan.market} for good${plan.portfolio!.campaigns ? `: its ${plural(plan.portfolio!.campaigns, 'campaign')} leave it and keep running${plan.portfolio!.cap ? ', no longer held by its budget cap' : ''}` : ''}.`
      : `Changes ${label} in ${plan.market}: ${lines.map((l) => `${l.label.toLowerCase()} ${l.from ?? 'none'} → ${l.to}`).join('; ')}${plan.portfolio!.campaigns ? ` (it holds ${plural(plan.portfolio!.campaigns, 'campaign')})` : ''}.`)
    + addsSpendWords(raises.map((r) => r.why), 'stepUp' in code)
  return {
    plan,
    result: {
      ok: true,
      preview: {
        action: TOOL,
        op: plan.op,
        market: plan.market,
        currency: plan.currency,
        ...(plan.portfolio ? { portfolio: { portfolioId: plan.portfolio.portfolioId, name: plan.portfolio.name, state: plan.portfolio.state, campaigns: plan.portfolio.campaigns, capNow: capWords(plan.portfolio.cap) } } : {}),
        changes: lines,
        ...(plan.cap ? { capChange: { fromCents: plan.cap.from?.amountCents ?? null, toCents: plan.cap.to.amountCents, fromPolicy: plan.cap.from?.policy ?? null, toPolicy: plan.cap.to.policy, startDate: plan.cap.to.startDate, endDate: plan.cap.to.endDate } } : {}),
        raises,
        ...code,
        ...(plan.archive ? { permanent: PERMANENT } : {}),
        // Every value it starts from and sets: a move of any of them after approval is caught (recheck).
        basis: hash({ op: plan.op, market: plan.market, portfolio: plan.portfolio, name: plan.name, cap: plan.cap, archive: plan.archive }),
        reach: stored,
        reachNote: stored.reach === 'live' ? `${reachNote(stored)} ${DIRECT}` : reachNote(stored),
        effect,
        undoNote: plan.op === 'create'
          ? 'Undo archives the new portfolio (set-portfolio op archive): permanent at Amazon, which keeps it as archived.'
          : plan.archive
            ? 'It cannot be undone: Amazon does not bring an archived portfolio back.'
            : plan.cap && !plan.cap.from
              ? 'Undo puts the old name back; the cap stays: Nexus cannot remove a cap (Seller Central can).'
              : 'Undo puts the old name and cap back (set-portfolio op update).',
        ...facts,
      },
    },
  }
}

/**
 * Claude's limits for a portfolio change run by rule: the kit's (one portfolio per request), the markets where it may
 * run, and what it may do there — every default refuses: each change waits for a person until he lists a market.
 */
const PORTFOLIO_LIMITS = adKitLimits({ maxItems: 1 }, {
  markets: z.array(z.string().trim().toUpperCase().min(2).max(20)).max(20).default([])
    .describe('the markets where a portfolio change may run by rule; empty = none: every change waits for a person'),
  allowCreate: z.boolean().default(false).describe('let a new portfolio be created by rule; never by default'),
  allowRename: z.boolean().default(false).describe('let a portfolio be renamed by rule; never by default'),
  allowArchive: z.boolean().default(false).describe('let a portfolio be archived by rule (permanent at Amazon); never by default'),
  maxCapCents: z.number().int().min(0).default(0)
    .describe("the highest budget cap a change by rule may set, in minor units of the market's currency; 0 = every cap change waits for a person"),
})

/** set-portfolio's own checks around the kit's (C1–C7). Pure. */
function portfolioRefusal(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = (preview ?? {}) as { action?: string; op?: Op; market?: string; changes?: Array<{ label: string }>; capChange?: { toCents?: number }; currency?: string | null }
  if (p.action !== TOOL || !p.op) return 'there is no preview of this portfolio change to check; a person decides'
  const markets = (limits.markets as string[] | undefined) ?? []
  if (!p.market || !markets.includes(p.market)) {
    return markets.length
      ? `this business lets a portfolio change run by rule only in ${markets.join(', ')}; a person decides`
      : 'this business names no market where a portfolio change may run by rule (markets is empty); a person decides'
  }
  const common = ruleRefusal(preview, limits)
  if (common) return common
  if (p.op === 'create' && limits.allowCreate !== true) return 'a new portfolio runs by rule only with allowCreate; a person decides'
  if (p.op === 'archive' && limits.allowArchive !== true) return 'an archive is permanent at Amazon: it runs by rule only with allowArchive; a person decides'
  if (p.op === 'update' && p.changes?.some((c) => c.label === 'Name') && limits.allowRename !== true) return 'a rename runs by rule only with allowRename; a person decides'
  if (p.capChange) {
    const max = typeof limits.maxCapCents === 'number' ? limits.maxCapCents : 0
    const to = Number(p.capChange.toCents)
    if (!(to <= max)) return `it sets a budget cap of ${amountLabel(to, p.currency ?? 'EUR')}, above the ${amountLabel(max, p.currency ?? 'EUR')} this tool's limits allow by rule${max === 0 ? ' (0: every cap change waits for a person)' : ''}; a person decides`
  }
  return null
}

/** What a change of this tool records: the portfolio, and its name and cap before / after (Claude's words). */
interface PortfolioRecord { op: Op; portfolioId: string | null; market: string; name: string | null; cap: HeldCap | null; state?: string | null; atAmazon?: boolean }

/** Undo: create → archive it; update → the old name and cap (a cap that was none cannot be removed); archive → none. */
export const SET_PORTFOLIO_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as PortfolioRecord
    if (!after.portfolioId) return change.after
    const [pf] = await portfolioDetails({ portfolioIds: [after.portfolioId] })
    if (!pf) return { ...after, name: null, state: 'NOT_FOUND' }
    // Only what the change set is compared: a cap it did not touch is recorded as null on both sides.
    return { ...after, name: pf.name, cap: after.cap ? capOf(pf, after.cap.currency ?? null) : null, ...('state' in after ? { state: pf.state } : {}) }
  },
  request(change) {
    const before = (change.before ?? {}) as Partial<PortfolioRecord>
    const after = (change.after ?? {}) as Partial<PortfolioRecord>
    if (!after.portfolioId) return { refusal: 'This change does not name the portfolio it changed.' }
    if (after.op === 'archive') return { refusal: 'An archived portfolio cannot be brought back: Amazon does not undo an archive.' }
    if (after.op === 'create') {
      if (after.atAmazon === false) return { refusal: 'The portfolio was made in Nexus only; there is nothing at Amazon to archive.' }
      return { tool: TOOL, args: { op: 'archive', portfolioId: after.portfolioId, why: `undo of the portfolio "${after.name ?? '?'}" Claude created: archived (permanent at Amazon)` } }
    }
    if (isUnread(before.cap) && canonical(before.cap) !== canonical(after.cap)) {
      return { refusal: `The cap it replaced was ${capWords(before.cap)}: Nexus cannot set that back. Set the cap again on the Portfolios page, or ask set-portfolio for a cap you name.` }
    }
    const name = before.name && before.name !== after.name ? before.name : undefined
    const cap = before.cap && !isUnread(before.cap) && canonical(before.cap) !== canonical(after.cap) ? before.cap : undefined
    if (!name && !cap) {
      return { refusal: before.cap == null && after.cap ? 'The portfolio had no budget cap before, and Nexus cannot remove a cap (neither the Portfolios page nor its Amazon client can): remove it in Seller Central.' : 'This change does not record what it replaced.' }
    }
    return {
      tool: TOOL,
      args: {
        op: 'update', portfolioId: after.portfolioId, ...(name ? { name } : {}),
        ...(cap ? { cap: { amountCents: cap.amountCents, policy: cap.policy, ...(cap.policy === 'dateRange' ? { startDate: cap.startDate, endDate: cap.endDate } : {}) } } : {}),
        why: 'undo of an earlier portfolio change',
      },
    }
  },
}

const setPortfolio: AgentTool = {
  name: TOOL,
  title: 'Create or change a portfolio',
  input,
  requires: [F.adsCampaignsManage, F.adsBudgetsEdit, FIELDS.financialsAdspendView],
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  strategyBound: 'amazon-ads',
  requiresApprovalDefault: true,
  openWorld: true,
  // A create is undone by an archive (Amazon keeps the portfolio, archived); an archive cannot be undone; a cap set
  // where there was none cannot be removed from Nexus.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: PORTFOLIO_LIMITS,
  withinLimits: portfolioRefusal,
  undo: SET_PORTFOLIO_UNDO,
  description:
    "Create, change or archive an Amazon Ads portfolio, as the Portfolios page does and through its own services. op "
    + 'create: a new portfolio in one market (name, market, an optional budget cap). op update: a new name and/or a budget '
    + 'cap (monthly, or a date range) of one portfolio (portfolioId from ad-portfolios). op archive: for good — PERMANENT, '
    + "Amazon does not bring it back; its campaigns leave it and keep running. A cap cannot be removed here (neither the page "
    + 'nor Nexus\'s Amazon client can). To move campaigns into or out of a portfolio use set-campaign-settings. '
    + `${BY_RULE_WORDS} (by default it does not: no market is listed). Whatever can add spend — a cap raised, its policy or `
    + 'dates changed, an archive that frees a capped portfolio\'s campaigns — is listed in raises and said in the preview: '
    + 'a day-to-day change, so a person\'s approval sends it with no authenticator code. '
    + 'The preview shows each value from → to, where it lands (live at Amazon or sandbox) and the limits that apply; '
    + "it is sent to Amazon as soon as it is approved (the page's own push, no 5-minute cancel window). Refused, and not "
    + 'queued, when the portfolio is not found, archived or made in Nexus only, a name is taken in the market, or Amazon\'s '
    + 'write gate would refuse it. Undo: a create is archived, an update puts the old name and cap back; an archive has none.',
  async handler(args, ctx) {
    return (await decide(args, ctx)).result
  },
  async execute(args, ctx) {
    const { result: fresh, plan } = await decide(args, ctx)
    const refusal = recheck(ctx, fresh, ['basis'])
    if (refusal || !plan) return notRun(refusal ?? 'Not run: it is no longer a valid change.')
    const p = fresh.preview as { raises: unknown[]; effect: string; reach: unknown }
    // The code, as portfolioStepUp decided it on this fresh dry run (none under the Owner's code rule).
    const gate = await codeGate(ctx, fresh.preview)
    if ('refusal' in gate) return notRun(gate.refusal)
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const audit = { actor: run.actor, changeSetId: run.changeSetId }
    const budgetOf = (cap: Cap) => ({ amount: cap.amountCents / 100, currencyCode: cap.currency, policy: CLIENT_POLICY[cap.policy], ...(cap.policy === 'dateRange' ? { startDate: cap.startDate!, endDate: cap.endDate! } : {}) })

    if (plan.op === 'create') {
      const made = await createPortfolio({ name: plan.name!.to, marketplace: plan.market, audit })
      const portfolioId = made.portfolio.portfolioId
      const atAmazon = !portfolioId.startsWith('local-pf-')
      let capProblem: string | null = null
      if (plan.cap && !atAmazon) capProblem = 'not set: the portfolio is not at Amazon'
      else if (plan.cap) {
        const out = await updatePortfolioById({ portfolioId, budget: budgetOf(plan.cap.to), audit })
        if (!out.ok) capProblem = out.error ?? 'refused'
      }
      const after: PortfolioRecord = { op: 'create', portfolioId, market: plan.market, name: made.portfolio.name, cap: plan.cap && !capProblem ? plan.cap.to : null, atAmazon }
      const data = {
        portfolioId, name: made.portfolio.name, market: plan.market, mode: made.mode, atAmazon, reach: p.reach, changeSetId: run.changeSetId,
        ...(made.amazonRefused
          ? { note: `Amazon refused it (${made.amazonRefused}): it exists in Nexus only, so no campaign can be moved into it. Nothing reached Amazon.` }
          : atAmazon ? {} : { note: 'Made in Nexus only: Amazon was not reached (its write gate closed after approval), so no campaign can be moved into it. Ask again once writes to this market are open.' }),
        ...(capProblem ? { capNote: `Its budget cap was not set (${capProblem}): it has no cap.${atAmazon ? ' Ask for the cap again with op update.' : ''}` } : {}),
      }
      return { ok: true, data, change: { before: { op: 'create', portfolioId: null, market: plan.market, name: null, cap: null, changeSetId: run.changeSetId }, after } }
    }

    const pf = plan.portfolio!
    const out = await updatePortfolioById({
      portfolioId: pf.portfolioId,
      ...(plan.name ? { name: plan.name.to } : {}),
      ...(plan.cap ? { budget: budgetOf(plan.cap.to) } : {}),
      ...(plan.archive ? { state: 'archived' as const } : {}),
      audit,
    })
    if (!out.ok) return notRun(`Not run: ${out.mode === 'gated' ? "Amazon's write gate refused it" : 'Amazon refused it'} (${out.error ?? 'unknown'}). Nothing changed.`)
    const before: PortfolioRecord = { op: plan.op, portfolioId: pf.portfolioId, market: plan.market, name: pf.name, cap: plan.cap?.from ?? null, state: pf.state }
    const after: PortfolioRecord = { op: plan.op, portfolioId: pf.portfolioId, market: plan.market, name: plan.name?.to ?? pf.name, cap: plan.cap ? plan.cap.to : null, state: plan.archive ? 'ARCHIVED' : pf.state }
    // A cap the change did not touch is not recorded (its undo leaves it alone).
    if (!plan.cap) { before.cap = null; after.cap = null }
    return {
      ok: true,
      data: {
        portfolioId: pf.portfolioId, op: plan.op, mode: out.mode, reach: p.reach, changeSetId: run.changeSetId,
        ...(out.mode === 'local' ? { note: "Changed in Nexus only: Amazon's write gate closed after it was approved. Ask again once writes are open." } : {}),
      },
      change: { before: { ...before, changeSetId: run.changeSetId }, after },
    }
  },
}

export const ADS_PORTFOLIO_TOOLS: AgentTool[] = [adPortfolios, setPortfolio]
