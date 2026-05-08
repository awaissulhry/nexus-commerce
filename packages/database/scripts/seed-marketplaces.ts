import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// VAT rates and tax-inclusive convention per marketplace (2026 standard rates).
//
// Tax-inclusive markets (Amazon EU/UK + eBay EU/UK) expose VAT-inclusive
// "value_with_tax" prices to consumers; the engine reads `taxInclusive=true`
// + `vatRate` and grosses up MASTER_INHERIT / PRICING_RULE / CHANNEL_RULE
// resolutions (pricing-engine.service.ts:404-422). SCHEDULED_SALE /
// OFFER_OVERRIDE / CHANNEL_OVERRIDE values are seller-entered and treated
// as already-final (no double-VAT).
//
// Amazon US, Shopify, WooCommerce, Etsy are tax-exclusive — net price stored,
// tax computed at checkout by the channel.
const MARKETPLACES = [
  // Amazon EU + UK — VAT-inclusive consumer pricing
  { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy',       marketplaceId: 'APJ6JRA9NG5V4', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'amazon.it',    vatRate: '22.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany',     marketplaceId: 'A1PA6795UKMFR9', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'amazon.de',    vatRate: '19.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'FR', name: 'Amazon France',      marketplaceId: 'A13V1IB3VIYZZH', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'amazon.fr',    vatRate: '20.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'ES', name: 'Amazon Spain',       marketplaceId: 'A1RKKUPIHCS9HS', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'amazon.es',    vatRate: '21.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'UK', name: 'Amazon UK',          marketplaceId: 'A1F83G8C2ARO7P', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'amazon.co.uk', vatRate: '20.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'NL', name: 'Amazon Netherlands', marketplaceId: 'A1805IZSGTT6HS', region: 'EU', currency: 'EUR', language: 'nl', domainUrl: 'amazon.nl',    vatRate: '21.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'SE', name: 'Amazon Sweden',      marketplaceId: 'A2NODRKZP88ZB9', region: 'EU', currency: 'SEK', language: 'sv', domainUrl: 'amazon.se',    vatRate: '25.00', taxInclusive: true },
  { channel: 'AMAZON', code: 'PL', name: 'Amazon Poland',      marketplaceId: 'A1C3SOZRARQ6R3', region: 'EU', currency: 'PLN', language: 'pl', domainUrl: 'amazon.pl',    vatRate: '23.00', taxInclusive: true },
  // Amazon US — sales tax via Marketplace Tax Collection, not VAT; net prices.
  { channel: 'AMAZON', code: 'US', name: 'Amazon US',          marketplaceId: 'ATVPDKIKX0DER',  region: 'NA', currency: 'USD', language: 'en', domainUrl: 'amazon.com',   vatRate: null,    taxInclusive: false },

  // eBay EU + UK — VAT-inclusive consumer pricing (same convention as Amazon EU)
  { channel: 'EBAY', code: 'IT', name: 'eBay Italy',   marketplaceId: 'EBAY_IT', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'ebay.it',    vatRate: '22.00', taxInclusive: true },
  { channel: 'EBAY', code: 'DE', name: 'eBay Germany', marketplaceId: 'EBAY_DE', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'ebay.de',    vatRate: '19.00', taxInclusive: true },
  { channel: 'EBAY', code: 'FR', name: 'eBay France',  marketplaceId: 'EBAY_FR', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'ebay.fr',    vatRate: '20.00', taxInclusive: true },
  { channel: 'EBAY', code: 'ES', name: 'eBay Spain',   marketplaceId: 'EBAY_ES', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'ebay.es',    vatRate: '21.00', taxInclusive: true },
  { channel: 'EBAY', code: 'UK', name: 'eBay UK',      marketplaceId: 'EBAY_GB', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'ebay.co.uk', vatRate: '20.00', taxInclusive: true },

  // Single-store channels — seller-configured tax handling.
  // Default to tax-exclusive: seller enters net prices, channel adds tax at
  // checkout per its own settings. Flip to taxInclusive=true via admin if
  // the storefront stores gross prices.
  { channel: 'SHOPIFY',     code: 'GLOBAL', name: 'Shopify Store',     region: 'GLOBAL', currency: 'EUR', language: 'en', vatRate: null, taxInclusive: false },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'WooCommerce Store', region: 'GLOBAL', currency: 'EUR', language: 'en', vatRate: null, taxInclusive: false },
  { channel: 'ETSY',        code: 'GLOBAL', name: 'Etsy Shop',         region: 'GLOBAL', currency: 'EUR', language: 'en', vatRate: null, taxInclusive: false },
]

async function main() {
  for (const mp of MARKETPLACES) {
    await prisma.marketplace.upsert({
      where: { channel_code: { channel: mp.channel, code: mp.code } },
      create: mp,
      update: mp,
    })
  }
  console.log(`Seeded ${MARKETPLACES.length} marketplaces`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
