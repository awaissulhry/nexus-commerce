/**
 * CE.5 — Cross-RMN Feed Export routes.
 *
 *   GET  /api/feed-export/gmc.xml     — Google Merchant Center RSS feed
 *   GET  /api/feed-export/meta.json   — Meta Product Catalog JSON
 *   GET  /api/feed-export/preview     — first 10 products as JSON table
 *   POST /api/feed-export/trigger     — manual feed generation (returns summary)
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  exportGMCFeed,
  exportMetaCatalog,
} from '../services/feed/feed-export.service.js'

const feedExportRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GMC XML feed ───────────────────────────────────────────────────────────
  fastify.get('/gmc.xml', async (_req, reply) => {
    const { xml, summary } = await exportGMCFeed(prisma)
    return reply
      .header('Content-Type', 'application/rss+xml; charset=utf-8')
      .header('X-Feed-Total', String(summary.total))
      .header('X-Feed-In-Stock', String(summary.inStock))
      .header('X-Feed-Generated-At', summary.generatedAt)
      .send(xml)
  })

  // ── Meta JSON feed ─────────────────────────────────────────────────────────
  fastify.get('/meta.json', async (_req, reply) => {
    const { items, summary } = await exportMetaCatalog(prisma)
    return reply
      .header('Content-Type', 'application/json')
      .header('X-Feed-Total', String(summary.total))
      .header('X-Feed-In-Stock', String(summary.inStock))
      .header('X-Feed-Generated-At', summary.generatedAt)
      .send(JSON.stringify({ data: items }, null, 2))
  })

  // ── Preview (first 10 products) ────────────────────────────────────────────
  fastify.get('/preview', async () => {
    const [gmc, meta] = await Promise.all([
      exportGMCFeed(prisma, { limit: 10 }),
      exportMetaCatalog(prisma, { limit: 10 }),
    ])
    return {
      gmc: { summary: gmc.summary, sampleXml: gmc.xml.slice(0, 2000) },
      meta: { summary: meta.summary, sampleItems: meta.items.slice(0, 10) },
    }
  })

  // ── Manual trigger ─────────────────────────────────────────────────────────
  fastify.post('/trigger', async () => {
    const [gmc, meta] = await Promise.all([
      exportGMCFeed(prisma),
      exportMetaCatalog(prisma),
    ])
    return { ok: true, gmc: gmc.summary, meta: meta.summary }
  })
}

export default feedExportRoutes
