/**
 * Send-time optimization windows (STO.2) — CRUD for ReviewSendWindow.
 *
 * - GET  /api/review-send-windows[?marketplace=IT]  → list (global + overrides)
 * - PUT  /api/review-send-windows                   → upsert a marketplace's 7 rows
 * - POST /api/review-send-windows/seed[?reset=1]    → (re)seed the global default
 *
 * marketplace '*' = global default pattern; a code (IT/DE/…) overrides it for
 * that market. The resolver (STO.3) reads these to pin each request's send hour.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'

const GLOBAL_SEED = [
  { dayOfWeek: 0, hourLocal: 11, dayRank: 2 }, // Sun
  { dayOfWeek: 1, hourLocal: 19, dayRank: 6 }, // Mon
  { dayOfWeek: 2, hourLocal: 19, dayRank: 1 }, // Tue
  { dayOfWeek: 3, hourLocal: 19, dayRank: 1 }, // Wed
  { dayOfWeek: 4, hourLocal: 19, dayRank: 3 }, // Thu
  { dayOfWeek: 5, hourLocal: 18, dayRank: 7 }, // Fri
  { dayOfWeek: 6, hourLocal: 11, dayRank: 2 }, // Sat
]

function normMarket(v: unknown): string {
  const s = (v ?? '*').toString().trim()
  return s === '*' ? '*' : s.toUpperCase()
}

function clampInt(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, n))
}

export default async function reviewSendWindowsRoutes(app: FastifyInstance) {
  // list — global + any per-market overrides (optionally filtered)
  app.get('/review-send-windows', async (req, reply) => {
    const marketplace = (req.query as any)?.marketplace
    const where = marketplace ? { marketplace: normMarket(marketplace) } : {}
    const rows = await prisma.reviewSendWindow.findMany({
      where,
      orderBy: [{ marketplace: 'asc' }, { dayOfWeek: 'asc' }],
    })
    return reply.send({ windows: rows })
  })

  // upsert a marketplace's rows (the grid saves all 7 days for one market at once)
  app.put('/review-send-windows', async (req, reply) => {
    const body = (req.body || {}) as {
      marketplace?: string
      windows?: Array<{ dayOfWeek: number; hourLocal: number; dayRank?: number; isActive?: boolean }>
    }
    const marketplace = normMarket(body.marketplace)
    const windows = Array.isArray(body.windows) ? body.windows : []

    // empty payload for a non-global market = drop the override (fall back to global)
    if (windows.length === 0 && marketplace !== '*') {
      await prisma.reviewSendWindow.deleteMany({ where: { marketplace } })
      return reply.send({ ok: true, marketplace, deleted: true })
    }

    try {
      for (const w of windows) {
        const dayOfWeek = clampInt(w.dayOfWeek, 0, 6, -1)
        if (dayOfWeek < 0) continue
        const data = {
          hourLocal: clampInt(w.hourLocal, 0, 23, 11),
          dayRank: clampInt(w.dayRank ?? 0, 0, 99, 0),
          isActive: w.isActive !== false,
        }
        await prisma.reviewSendWindow.upsert({
          where: { marketplace_dayOfWeek: { marketplace, dayOfWeek } },
          update: data,
          create: { marketplace, dayOfWeek, ...data },
        })
      }
      const rows = await prisma.reviewSendWindow.findMany({
        where: { marketplace },
        orderBy: { dayOfWeek: 'asc' },
      })
      return reply.send({ ok: true, marketplace, windows: rows })
    } catch (err: any) {
      logger.error('review-send-windows PUT failed', { error: err?.message })
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // (re)seed the global default pattern
  app.post('/review-send-windows/seed', async (req, reply) => {
    const reset = (req.query as any)?.reset === '1'
    if (reset) await prisma.reviewSendWindow.deleteMany({ where: { marketplace: '*' } })
    for (const s of GLOBAL_SEED) {
      await prisma.reviewSendWindow.upsert({
        where: { marketplace_dayOfWeek: { marketplace: '*', dayOfWeek: s.dayOfWeek } },
        update: reset ? { hourLocal: s.hourLocal, dayRank: s.dayRank, isActive: true } : {},
        create: { marketplace: '*', dayOfWeek: s.dayOfWeek, hourLocal: s.hourLocal, dayRank: s.dayRank },
      })
    }
    const rows = await prisma.reviewSendWindow.findMany({
      where: { marketplace: '*' },
      orderBy: { dayOfWeek: 'asc' },
    })
    return reply.send({ ok: true, windows: rows })
  })
}
