import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

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
  // Single-store
  { channel: 'SHOPIFY',     code: 'GLOBAL', name: 'Shopify Store',     region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'WOOCOMMERCE', code: 'GLOBAL', name: 'WooCommerce Store', region: 'GLOBAL', currency: 'EUR', language: 'en' },
  { channel: 'ETSY',        code: 'GLOBAL', name: 'Etsy Shop',         region: 'GLOBAL', currency: 'EUR', language: 'en' },
] as const

const marketplacesRoutes: FastifyPluginAsync = async (fastify) => {
  // POST /api/marketplaces/seed — idempotent seed of the 17 marketplaces
  fastify.post('/marketplaces/seed', async (_request, reply) => {
    try {
      let upserted = 0
      for (const mp of MARKETPLACES) {
        await prisma.marketplace.upsert({
          where: { channel_code: { channel: mp.channel, code: mp.code } },
          create: { ...mp },
          update: { ...mp },
        })
        upserted++
      }
      const total = await prisma.marketplace.count()
      return { success: true, upserted, total }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[marketplaces/seed] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/marketplaces?channel=AMAZON — flat list, optional channel filter
  fastify.get('/marketplaces', async (request, reply) => {
    try {
      const { channel } = request.query as { channel?: string }
      const marketplaces = await prisma.marketplace.findMany({
        where: { isActive: true, ...(channel ? { channel } : {}) },
        orderBy: [{ channel: 'asc' }, { code: 'asc' }],
      })
      return marketplaces
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/marketplaces/grouped — { AMAZON: [...], EBAY: [...], ... }
  fastify.get('/marketplaces/grouped', async (_request, reply) => {
    try {
      const marketplaces = await prisma.marketplace.findMany({
        where: { isActive: true },
        orderBy: [{ channel: 'asc' }, { code: 'asc' }],
      })
      const grouped = marketplaces.reduce(
        (acc, mp) => {
          ;(acc[mp.channel] ??= []).push(mp)
          return acc
        },
        {} as Record<string, typeof marketplaces>
      )
      return grouped
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // GET /api/products/:id/all-listings — every channel/marketplace listing for a product
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/all-listings',
    async (request, reply) => {
      try {
        const { id } = request.params
        const listings = await prisma.channelListing.findMany({
          where: { productId: id },
          orderBy: [{ channel: 'asc' }, { marketplace: 'asc' }],
        })
        const grouped = listings.reduce(
          (acc, l) => {
            ;(acc[l.channel] ??= []).push(l)
            return acc
          },
          {} as Record<string, typeof listings>
        )
        return grouped
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // GET /api/products/:id/listings/:channel/:marketplace
  fastify.get<{
    Params: { id: string; channel: string; marketplace: string }
  }>(
    '/products/:id/listings/:channel/:marketplace',
    async (request, reply) => {
      try {
        const { id, channel, marketplace } = request.params
        const listing = await prisma.channelListing.findFirst({
          where: { productId: id, channel, marketplace },
        })
        if (!listing) {
          return reply
            .code(404)
            .send({ error: 'Listing not found', productId: id, channel, marketplace })
        }
        return listing
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // PUT /api/products/:id/listings/:channel/:marketplace — upsert
  fastify.put<{
    Params: { id: string; channel: string; marketplace: string }
    Body: Record<string, any>
  }>(
    '/products/:id/listings/:channel/:marketplace',
    async (request, reply) => {
      try {
        const { id, channel, marketplace } = request.params
        const data = request.body ?? {}

        // Verify the marketplace is configured
        const mp = await prisma.marketplace.findUnique({
          where: { channel_code: { channel, code: marketplace } },
        })
        if (!mp) {
          return reply
            .code(400)
            .send({ error: `Marketplace ${channel}/${marketplace} not configured` })
        }

        // Verify the product exists
        const product = await prisma.product.findUnique({ where: { id } })
        if (!product) {
          return reply.code(404).send({ error: `Product ${id} not found` })
        }

        const channelMarket = `${channel}_${marketplace}`
        const existing = await prisma.channelListing.findFirst({
          where: { productId: id, channel, marketplace },
        })

        let listing
        if (existing) {
          listing = await prisma.channelListing.update({
            where: { id: existing.id },
            data: {
              ...data,
              channel,
              marketplace,
              channelMarket,
              region: marketplace,
            },
          })
        } else {
          listing = await prisma.channelListing.create({
            data: {
              ...data,
              productId: id,
              channel,
              marketplace,
              channelMarket,
              region: marketplace,
            },
          })
        }
        return listing
      } catch (error: any) {
        fastify.log.error({ err: error }, '[products/listings PUT] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )
}

export default marketplacesRoutes
