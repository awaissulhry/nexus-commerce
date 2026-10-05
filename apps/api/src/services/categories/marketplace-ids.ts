import prisma from '../../db.js'
import { marketLanguages, languageTag } from '../pim/market-languages.js'
import { MARKET_CATALOGUE } from '../pim/market-catalogue.js'
// Map internal 2-letter marketplace codes to Amazon's marketplaceId.
// Existing call-sites use raw IDs from env; this lookup centralises
// the mapping so the schema-sync service can accept the same
// 2-letter codes the bulk-operations UI uses (IT, DE, US, …).

const CODE_TO_AMAZON_ID: Record<string, string> = {
  IT: 'APJ6JRA9NG5V4',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  NL: 'A1805IZSGTT6HS',
  UK: 'A1F83G8C2ARO7P',
  GB: 'A1F83G8C2ARO7P',
  US: 'ATVPDKIKX0DER',
  CA: 'A2EUQ1WTGCTBG2',
  MX: 'A1AM78C64UM0Y8',
}

/**
 * 2026-09-27 — the markets the list above never had (BE, PL, SE, IE, TR). A code it did not know
 * passed through as itself, so Amazon was asked for marketplace "BE" and answered "Access to
 * requested resource is denied": no product-type rules could ever be fetched for those five markets,
 * and their Amazon scope showed only the fixed columns. The market catalogue holds every market's
 * real id (read from production), so it answers for any code the list above does not.
 */
const CATALOGUE_AMAZON_ID: Record<string, string> = Object.fromEntries(
  MARKET_CATALOGUE.filter((m) => m.channel === 'AMAZON').map((m) => [m.code, m.marketplaceId]),
)

export async function amazonLocale(code: string | null | undefined): Promise<string> {
  const market = code || 'US'
  return languageTag((await marketLanguages('AMAZON', market))[0], market)
}

/** Amazon's North American markets: their English is US English. */
const NORTH_AMERICA = new Set(['US', 'CA', 'MX', 'BR'])
const CATALOGUE_AMAZON_REGION: Record<string, string> = Object.fromEntries(
  MARKET_CATALOGUE.filter((m) => m.channel === 'AMAZON').map((m) => [m.code, m.region]),
)

/**
 * W3 PR-A — the locale of the English copy of a market's product-type definitions (`CategorySchema` channel
 * `AMAZON_EN`), or null when the market's own download is already English (UK, IE, US). EU markets read British
 * English (Owner decision 2, 2026-10-05), North America US English. Whether the market is English comes from the same
 * authority as its own download's locale (`amazonLocale`).
 */
export async function amazonEnglishLocale(code: string | null | undefined): Promise<string | null> {
  const market = (code || 'US').toUpperCase()
  if (/^en_/i.test(await amazonLocale(market))) return null
  return NORTH_AMERICA.has(market) || CATALOGUE_AMAZON_REGION[market] === 'NA' ? languageTag('en', 'US') : languageTag('en', 'UK')
}

export function amazonMarketplaceId(code: string | null | undefined): string {
  if (!code) {
    return process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
  }
  const upper = code.toUpperCase()
  // If the value already looks like an Amazon ID, pass through.
  if (upper.length > 6) return upper
  return CODE_TO_AMAZON_ID[upper] ?? CATALOGUE_AMAZON_ID[upper] ?? upper
}

export async function configuredAmazonMarketplaceId(code: string): Promise<string | undefined> {
  const row = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code }, select: { marketplaceId: true } })
  return row?.marketplaceId ?? undefined
}
