/**
 * OWNER DECISION 2A (2026-10-08 ~19:20 UTC, design 2026-10-08-ads-one-brain/DESIGN.md §10) — an Amazon portfolio's budget
 * cap is a month's money, so it has a limit of its own, apart from the per-write value cap (NEXUS_AMAZON_ADS_MAX_WRITE_VALUE_CENTS,
 * €500), which stays exactly as it is for every other write. The write gate judges every portfolio's own write against it
 * (the brain's money writer, a person's set-portfolio and the Portfolios page alike); the brain's money writer checks the same
 * limit before it asks or writes, so a cap above it is never sent to a doomed write.
 *
 *   server   NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS, default 200,000 (€2,000) a month.
 *   owner    the Owner's own limit for one product's portfolios (set-ads-brain op set-value, key portfolioCapLimitCents, per
 *            product and market): it replaces the server's limit — higher or lower — for a portfolio that holds only that
 *            product's campaigns (N2: the portfolios the brain caps; brain/ownership.ts decides a campaign's product). Empty =
 *            the server's. His setting always wins over the default (§10 "control it individually").
 *   reads    none for a portfolio write while no product has that value set (one query: production today); otherwise the
 *            portfolio's campaigns, their owner (the ownership resolver) and the product's value. A failed read is not a
 *            refusal: it goes out of the gate like every failed read there (the caller retries or sees the error).
 *   words    a refusal names the limit that applied and how to change it; amounts in cents, as the gate's other refusals.
 */
import prisma from '../../../db.js'
import { settingRefusal } from './levers.js'
import { resolveCampaignOwnership } from './ownership.js'

export const PORTFOLIO_CAP_LIMIT_ENV = 'NEXUS_AMAZON_ADS_MAX_PORTFOLIO_CAP_CENTS'
/** €2,000 a month (Owner decision 2A). */
export const DEFAULT_PORTFOLIO_CAP_LIMIT_CENTS = 200_000
/** The brain setting that holds the Owner's own limit for one product's portfolios (levers.ts BRAIN_SETTINGS). */
export const PORTFOLIO_CAP_LIMIT_SETTING = 'portfolioCapLimitCents'

/** The server's limit of a portfolio's cap (cents): the env's whole number above 0, else €2,000. */
export function serverPortfolioCapLimitCents(): number {
  const v = Number(process.env[PORTFOLIO_CAP_LIMIT_ENV])
  if (Number.isFinite(v) && v > 0) return Math.floor(v)
  return DEFAULT_PORTFOLIO_CAP_LIMIT_CENTS
}

/** The limit that applies to one portfolio's cap, and where it comes from. */
export interface PortfolioCapLimit {
  cents: number
  source: 'server' | 'owner'
  /** The product (family root) whose Owner value applies; null for the server's limit. */
  productId: string | null
  market: string | null
  /** Where it comes from, in words (no amount): the env's name, or the product's setting. */
  words: string
}

const SERVER_WORDS = `the server's portfolio cap limit (${PORTFOLIO_CAP_LIMIT_ENV}, default ${DEFAULT_PORTFOLIO_CAP_LIMIT_CENTS}¢ a month)`

/** The server's limit. */
export function serverPortfolioCapLimit(): PortfolioCapLimit {
  return { cents: serverPortfolioCapLimitCents(), source: 'server', productId: null, market: null, words: SERVER_WORDS }
}

/** One product's limit: the Owner's value when it is a valid one, else the server's. Pure but for the env. */
export function productPortfolioCapLimit(value: unknown, productId: string, market: string): PortfolioCapLimit {
  if (value === null || value === undefined || settingRefusal(PORTFOLIO_CAP_LIMIT_SETTING, value, 'PRODUCT') !== null) return serverPortfolioCapLimit()
  return {
    cents: value as number, source: 'owner', productId, market,
    words: `the Owner's portfolio cap limit for product ${productId} in ${market} (set-ads-brain ${PORTFOLIO_CAP_LIMIT_SETTING})`,
  }
}

/** How to raise the limit that refused a cap, in words. */
export function raiseLimitWords(l: Pick<PortfolioCapLimit, 'source'>): string {
  return l.source === 'owner'
    ? `raise the product's ${PORTFOLIO_CAP_LIMIT_SETTING} (set-ads-brain op set-value), or set the cap in Seller Central`
    : `raise ${PORTFOLIO_CAP_LIMIT_ENV}, or the product's own ${PORTFOLIO_CAP_LIMIT_SETTING} (set-ads-brain op set-value), or set the cap in Seller Central`
}

/**
 * The limit of a portfolio's cap: the Owner's value of the one product whose campaigns the portfolio holds (every one not
 * archived), else the server's. `portfolioId` is Nexus's portfolio row id or Amazon's portfolio id; none (a portfolio made
 * with its cap, an empty one): the server's. No product with the value set: one query, the server's.
 */
export async function portfolioCapLimitOf(portfolioId: string | null | undefined): Promise<PortfolioCapLimit> {
  if (!portfolioId) return serverPortfolioCapLimit()
  const anyOwnerValue = await prisma.adsBrainOverride.findFirst({ where: { endedAt: null, scope: 'PRODUCT', kind: 'VALUE', key: PORTFOLIO_CAP_LIMIT_SETTING }, select: { id: true } })
  if (!anyOwnerValue) return serverPortfolioCapLimit()
  const row = await prisma.amazonAdsPortfolio.findFirst({ where: { OR: [{ id: portfolioId }, { externalPortfolioId: portfolioId }] }, select: { externalPortfolioId: true } })
  const campaigns = await prisma.campaign.findMany({ where: { portfolioId: row?.externalPortfolioId ?? portfolioId, status: { not: 'ARCHIVED' } }, select: { id: true } })
  if (!campaigns.length) return serverPortfolioCapLimit()
  const owners = await resolveCampaignOwnership(campaigns.map((c) => c.id))
  const first = owners.get(campaigns[0].id)
  if (!first || first.owner.kind !== 'product' || !first.market) return serverPortfolioCapLimit()
  const productId = first.owner.productId
  const market = first.market
  const one = campaigns.every((c) => {
    const o = owners.get(c.id)
    return !!o && o.owner.kind === 'product' && o.owner.productId === productId && o.market === market
  })
  if (!one) return serverPortfolioCapLimit()
  const value = await prisma.adsBrainOverride.findFirst({
    where: { endedAt: null, scope: 'PRODUCT', kind: 'VALUE', key: PORTFOLIO_CAP_LIMIT_SETTING, productId, marketplace: market },
    orderBy: { createdAt: 'desc' },
    select: { value: true },
  })
  return productPortfolioCapLimit(value?.value, productId, market)
}
