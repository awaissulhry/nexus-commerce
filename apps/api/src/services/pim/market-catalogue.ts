/**
 * A-53 — the market catalogue: the ONE list of markets every business starts with.
 *
 * `Marketplace` is per business (`schema.prisma`, unique `(workspaceId, channel, code)`), and business
 * creation used to write none. A business made under profiles therefore had no market at all, and the
 * product studio waited for one forever (PLAN.md A-53 — Motovento, 2026-09-24).
 *
 * The rows are the REFERENCE columns of the 20 markets Xavia Racing carries in production (read-only
 * read, 2026-09-24): identity, currency, languages and VAT. The per-business state — `isParticipating`,
 * `participationStatus`, `participationCheckedAt`, `fbaProgram`, `schemaMapping` — is NOT here: each
 * business earns it from its own accounts (the connect flow's participation discovery).
 *
 * VAT is part of the reference. A market row without it prices every EU listing net of VAT, 19–25 % low
 * (`scripts/seed-marketplace-vat.mjs` records that incident); the old route list had none.
 *
 * Every writer is CREATE-ONLY — a business's existing row is never rewritten:
 *  - business creation (`workspace.service.ts` `create()`), inside the creation transaction;
 *  - `POST /api/marketplaces/seed` (`createMany … skipDuplicates`);
 *  - the backfill migration `20260924a_a53_market_catalogue_backfill`, which carries these rows as SQL —
 *    `market-catalogue.vitest.test.ts` fails when the two differ;
 *  - the dev seed script `packages/database/scripts/seed-marketplaces.ts` reads the list from here.
 *
 * Pure: no Prisma import, so a script, a migration test and a unit test can read it without a database.
 */

export interface CatalogueMarket {
  channel: 'AMAZON' | 'EBAY' | 'ETSY' | 'SHOPIFY' | 'WOOCOMMERCE'
  code: string
  name: string
  marketplaceId: string | null
  region: 'EU' | 'NA' | 'GLOBAL'
  currency: string
  /** The first entry of `languages` (LX.2: `languages` is the authority; `language` is its legacy mirror). */
  language: string
  languages: readonly string[]
  domainUrl: string | null
  /** A decimal string (`'22.00'` = 22 %), exactly as the `Decimal(5,2)` column holds it. */
  vatRate: string | null
  taxInclusive: boolean
  isActive: boolean
}

// Ordered by channel, then code — the order of the production read, and of the migration's VALUES.
export const MARKET_CATALOGUE: readonly CatalogueMarket[] = [
  // Amazon EU + UK — VAT-inclusive consumer prices. BE sells in Dutch and French (A-22).
  { channel: 'AMAZON', code: 'BE', name: 'Amazon Belgium',     marketplaceId: 'AMEN7PMS3EDWL',  region: 'EU', currency: 'EUR', language: 'nl', languages: ['nl', 'fr'], domainUrl: 'amazon.com.be', vatRate: '21.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany',     marketplaceId: 'A1PA6795UKMFR9', region: 'EU', currency: 'EUR', language: 'de', languages: ['de'],       domainUrl: 'amazon.de',     vatRate: '19.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'ES', name: 'Amazon Spain',       marketplaceId: 'A1RKKUPIHCS9HS', region: 'EU', currency: 'EUR', language: 'es', languages: ['es'],       domainUrl: 'amazon.es',     vatRate: '21.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'FR', name: 'Amazon France',      marketplaceId: 'A13V1IB3VIYZZH', region: 'EU', currency: 'EUR', language: 'fr', languages: ['fr'],       domainUrl: 'amazon.fr',     vatRate: '20.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'IE', name: 'Amazon Ireland',     marketplaceId: 'A28R8C7NBKEWEA', region: 'EU', currency: 'EUR', language: 'en', languages: ['en'],       domainUrl: 'amazon.ie',     vatRate: '23.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy',       marketplaceId: 'APJ6JRA9NG5V4',  region: 'EU', currency: 'EUR', language: 'it', languages: ['it'],       domainUrl: 'amazon.it',     vatRate: '22.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'NL', name: 'Amazon Netherlands', marketplaceId: 'A1805IZSGTT6HS', region: 'EU', currency: 'EUR', language: 'nl', languages: ['nl'],       domainUrl: 'amazon.nl',     vatRate: '21.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'PL', name: 'Amazon Poland',      marketplaceId: 'A1C3SOZRARQ6R3', region: 'EU', currency: 'PLN', language: 'pl', languages: ['pl'],       domainUrl: 'amazon.pl',     vatRate: '23.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'SE', name: 'Amazon Sweden',      marketplaceId: 'A2NODRKZP88ZB9', region: 'EU', currency: 'SEK', language: 'sv', languages: ['sv'],       domainUrl: 'amazon.se',     vatRate: '25.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'TR', name: 'Amazon Turkey',      marketplaceId: 'A33AVAJ2PDY3EV', region: 'EU', currency: 'TRY', language: 'tr', languages: ['tr'],       domainUrl: 'amazon.com.tr', vatRate: '18.00', taxInclusive: true, isActive: true },
  { channel: 'AMAZON', code: 'UK', name: 'Amazon UK',          marketplaceId: 'A1F83G8C2ARO7P', region: 'EU', currency: 'GBP', language: 'en', languages: ['en'],       domainUrl: 'amazon.co.uk',  vatRate: '20.00', taxInclusive: true, isActive: true },
  // Amazon US — sales tax is collected by Amazon at checkout, so net prices; inactive, as on Xavia.
  { channel: 'AMAZON', code: 'US', name: 'Amazon US',          marketplaceId: 'ATVPDKIKX0DER',  region: 'NA', currency: 'USD', language: 'en', languages: ['en'],       domainUrl: 'amazon.com',    vatRate: null,    taxInclusive: false, isActive: false },
  // eBay EU + UK — VAT-inclusive, the same convention as Amazon EU.
  { channel: 'EBAY', code: 'DE', name: 'eBay Germany', marketplaceId: 'EBAY_DE', region: 'EU', currency: 'EUR', language: 'de', languages: ['de'], domainUrl: 'ebay.de',    vatRate: '19.00', taxInclusive: true, isActive: true },
  { channel: 'EBAY', code: 'ES', name: 'eBay Spain',   marketplaceId: 'EBAY_ES', region: 'EU', currency: 'EUR', language: 'es', languages: ['es'], domainUrl: 'ebay.es',    vatRate: '21.00', taxInclusive: true, isActive: true },
  { channel: 'EBAY', code: 'FR', name: 'eBay France',  marketplaceId: 'EBAY_FR', region: 'EU', currency: 'EUR', language: 'fr', languages: ['fr'], domainUrl: 'ebay.fr',    vatRate: '20.00', taxInclusive: true, isActive: true },
  { channel: 'EBAY', code: 'IT', name: 'eBay Italy',   marketplaceId: 'EBAY_IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'], domainUrl: 'ebay.it',    vatRate: '22.00', taxInclusive: true, isActive: true },
  { channel: 'EBAY', code: 'UK', name: 'eBay UK',      marketplaceId: 'EBAY_GB', region: 'EU', currency: 'GBP', language: 'en', languages: ['en'], domainUrl: 'ebay.co.uk', vatRate: '20.00', taxInclusive: true, isActive: true },
  // Single-store channels — the seller's store decides tax, so net prices by default.
  { channel: 'ETSY',        code: 'GLOBAL', name: 'Etsy Shop',         marketplaceId: null, region: 'GLOBAL', currency: 'EUR', language: 'en', languages: ['en'], domainUrl: null, vatRate: null, taxInclusive: false, isActive: true },
  { channel: 'SHOPIFY',     code: 'GLOBAL', name: 'Shopify Store',     marketplaceId: null, region: 'GLOBAL', currency: 'EUR', language: 'en', languages: ['en'], domainUrl: null, vatRate: null, taxInclusive: false, isActive: true },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'WooCommerce Store', marketplaceId: null, region: 'GLOBAL', currency: 'EUR', language: 'en', languages: ['en'], domainUrl: null, vatRate: null, taxInclusive: false, isActive: true },
]

/** The catalogue as `Marketplace` create rows. A fresh copy per call: Prisma must not share the readonly arrays. */
export function marketCatalogueRows() {
  return MARKET_CATALOGUE.map((market) => ({ ...market, languages: [...market.languages] }))
}
