import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const MARKETPLACES = [
  // Amazon EU
  { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy',       marketplaceId: 'APJ6JRA9NG5V4', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'amazon.it' },
  { channel: 'AMAZON', code: 'DE', name: 'Amazon Germany',     marketplaceId: 'A1PA6795UKMFR9', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'amazon.de' },
  { channel: 'AMAZON', code: 'FR', name: 'Amazon France',      marketplaceId: 'A13V1IB3VIYZZH', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'amazon.fr' },
  { channel: 'AMAZON', code: 'ES', name: 'Amazon Spain',       marketplaceId: 'A1RKKUPIHCS9HS', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'amazon.es' },
  { channel: 'AMAZON', code: 'UK', name: 'Amazon UK',          marketplaceId: 'A1F83G8C2ARO7P', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'amazon.co.uk' },
  { channel: 'AMAZON', code: 'NL', name: 'Amazon Netherlands', marketplaceId: 'A1805IZSGTT6HS', region: 'EU', currency: 'EUR', language: 'nl', domainUrl: 'amazon.nl' },
  { channel: 'AMAZON', code: 'SE', name: 'Amazon Sweden',      marketplaceId: 'A2NODRKZP88ZB9', region: 'EU', currency: 'SEK', language: 'sv', domainUrl: 'amazon.se' },
  { channel: 'AMAZON', code: 'PL', name: 'Amazon Poland',      marketplaceId: 'A1C3SOZRARQ6R3', region: 'EU', currency: 'PLN', language: 'pl', domainUrl: 'amazon.pl' },
  { channel: 'AMAZON', code: 'US', name: 'Amazon US',          marketplaceId: 'ATVPDKIKX0DER',  region: 'NA', currency: 'USD', language: 'en', domainUrl: 'amazon.com' },

  // eBay
  { channel: 'EBAY', code: 'IT', name: 'eBay Italy',   marketplaceId: 'EBAY_IT', region: 'EU', currency: 'EUR', language: 'it', domainUrl: 'ebay.it' },
  { channel: 'EBAY', code: 'DE', name: 'eBay Germany', marketplaceId: 'EBAY_DE', region: 'EU', currency: 'EUR', language: 'de', domainUrl: 'ebay.de' },
  { channel: 'EBAY', code: 'FR', name: 'eBay France',  marketplaceId: 'EBAY_FR', region: 'EU', currency: 'EUR', language: 'fr', domainUrl: 'ebay.fr' },
  { channel: 'EBAY', code: 'ES', name: 'eBay Spain',   marketplaceId: 'EBAY_ES', region: 'EU', currency: 'EUR', language: 'es', domainUrl: 'ebay.es' },
  { channel: 'EBAY', code: 'UK', name: 'eBay UK',      marketplaceId: 'EBAY_GB', region: 'EU', currency: 'GBP', language: 'en', domainUrl: 'ebay.co.uk' },

  // Single-store channels
  { channel: 'SHOPIFY',     code: 'GLOBAL', name: 'Shopify Store',     region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'WooCommerce Store', region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'ETSY',        code: 'GLOBAL', name: 'Etsy Shop',         region: 'GLOBAL', currency: 'EUR', language: 'en' },
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
