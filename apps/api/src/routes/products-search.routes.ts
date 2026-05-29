/**
 * Faceted catalog search route — the fast read path for the /products grid.
 *
 *   GET /api/products/search
 *
 * Mirrors the GET /api/products querystring contract (page, limit, search,
 * status, channels, productTypes, brands, families, workflowStages,
 * fulfillment, hasPhotos/Description/Brand/Gtin, driftOnly, stockLevel,
 * parentId, sort) and adds `categories` (a category id — matches the whole
 * subtree via the closure rollup baked into ProductReadCache.categoryIds /
 * the Typesense doc).
 *
 * Backed by Typesense when SEARCH_ENGINE_ENABLED=1 and healthy; otherwise
 * by ProductReadCache. Either way the item shape is identical (the display
 * payload is always hydrated from ProductReadCache).
 *
 * A fast-json-stringify response schema is declared so the fixed, flat
 * payload serializes at maximum throughput at 50–200 rows/page. ETag/304
 * keeps the grid's smart-polling cheap.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  parseFilters,
  searchProductsGrid,
} from '../services/product-search.service.js'
import { listEtag, matches } from '../utils/list-etag.js'
import { logger } from '../utils/logger.js'

// JSON-blob fields (family / workflowStage / coverage / categoryPath) use
// an empty schema so fast-json-stringify serializes them with JSON.stringify
// rather than enforcing a fixed shape.
const anyJson = {}

const itemSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    sku: { type: 'string' },
    name: { type: 'string' },
    brand: { type: ['string', 'null'] },
    basePrice: { type: ['number', 'null'] },
    totalStock: { type: 'integer' },
    lowStockThreshold: { type: ['integer', 'null'] },
    status: { type: 'string' },
    syncChannels: { type: 'array', items: { type: 'string' } },
    productType: { type: ['string', 'null'] },
    fulfillmentMethod: { type: ['string', 'null'] },
    isParent: { type: 'boolean' },
    parentId: { type: ['string', 'null'] },
    version: { type: 'integer' },
    family: anyJson,
    workflowStage: anyJson,
    imageUrl: { type: ['string', 'null'] },
    photoCount: { type: 'integer' },
    channelCount: { type: 'integer' },
    variantCount: { type: 'integer' },
    childCount: { type: 'integer' },
    hasDescription: { type: 'boolean' },
    hasBrand: { type: 'boolean' },
    hasGtin: { type: 'boolean' },
    hasPhotos: { type: 'boolean' },
    channelKeys: { type: 'array', items: { type: 'string' } },
    driftCount: { type: 'integer' },
    coverage: anyJson,
    primaryCategoryId: { type: ['string', 'null'] },
    categoryIds: { type: 'array', items: { type: 'string' } },
    categoryPath: anyJson,
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
}

const facetBucket = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      value: { type: 'string' },
      count: { type: 'integer' },
    },
  },
}

const responseSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: itemSchema },
    total: { type: 'integer' },
    page: { type: 'integer' },
    limit: { type: 'integer' },
    stats: {
      type: 'object',
      properties: {
        total: { type: 'integer' },
        active: { type: 'integer' },
        draft: { type: 'integer' },
        inStock: { type: 'integer' },
        outStock: { type: 'integer' },
      },
    },
    // Dynamic facet field names → bucket arrays.
    facets: { type: 'object', additionalProperties: facetBucket },
    engine: { type: 'string' },
  },
}

const productsSearchRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get(
    '/products/search',
    {
      schema: {
        response: {
          200: responseSchema,
          304: { type: 'null' },
          500: {
            type: 'object',
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const filters = parseFilters(request.query as Record<string, unknown>)

      try {
        // Freshness ETag from the (cheap, single-table) cache set. Same
        // signal whichever engine serves the page; filter context keeps
        // distinct views distinct.
        const { etag } = await listEtag(prisma as any, {
          model: 'productReadCache',
          where: { deletedAt: null },
          filterContext: { ...filters },
        })
        if (matches(request, etag)) {
          return reply.code(304).header('ETag', etag).send()
        }

        const result = await searchProductsGrid(filters)

        reply
          .header('ETag', etag)
          .header('Cache-Control', 'private, max-age=0, must-revalidate')
          .header('X-Search-Engine', result.engine)
        return result
      } catch (err) {
        logger.error('[products-search] query failed', {
          error: err instanceof Error ? err.message : String(err),
        })
        return reply.code(500).send({ error: 'Search failed' })
      }
    },
  )
}

export default productsSearchRoutes
