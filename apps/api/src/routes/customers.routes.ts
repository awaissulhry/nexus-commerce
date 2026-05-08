/**
 * O.21a — Customers REST surface.
 *
 * Lands the operator-facing API for the new Customer schema (O.20):
 *   GET    /api/customers              — list (paginated + search + sort)
 *   GET    /api/customers/:id          — detail (with orders, addresses, notes)
 *   GET    /api/customers/by-email/:e  — lookup by email (deep-link from
 *                                         existing OrdersWorkspace
 *                                         customerEmail-filter pattern)
 *   POST   /api/customers/:id/notes    — create note
 *   PATCH  /api/customers/:id/notes/:noteId — edit note (body, pinned)
 *   DELETE /api/customers/:id/notes/:noteId — delete note
 *   PATCH  /api/customers/:id/tags     — replace tags array
 *   POST   /api/customers/:id/refresh-cache
 *                                       — manual recompute (ops escape
 *                                         hatch when the auto-refresh
 *                                         from order-ingestion drifts)
 *
 * Returns are flat objects (no `{ success, data }` wrapper) per the
 * D.2 orders-api convention (avoids the @fastify/compress empty-body
 * bug — see TECH_DEBT.md).
 */

import { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { refreshCustomerCache } from '../services/customer-cache.service.js'
import { recomputeCustomerRisk } from '../services/order-risk.service.js'

export async function customersRoutes(app: FastifyInstance) {
  // ── List ───────────────────────────────────────────────────────────
  app.get('/api/customers', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const search = (q.search ?? '').trim()
      const page = Math.max(1, parseInt(q.page ?? '1', 10) || 1)
      const pageSize = Math.min(500, parseInt(q.pageSize ?? '50', 10) || 50)
      // Sort: ltv (totalSpentCents) DESC default; lastOrder, orders, name.
      const sortBy = q.sortBy ?? 'ltv'
      const sortDir = (q.sortDir === 'asc' ? 'asc' : 'desc') as 'asc' | 'desc'

      const orderBy =
        sortBy === 'lastOrder'
          ? { lastOrderAt: sortDir }
          : sortBy === 'orders'
            ? { totalOrders: sortDir }
            : sortBy === 'name'
              ? { name: sortDir }
              : { totalSpentCents: sortDir }

      // O.22: optional risk filters. `riskFlag=HIGH` filters to a
      // single flag; comma-separated list is OR'd. `manualReviewState
      // =PENDING` is the operator's "needs my attention" queue.
      const riskFlags = (q.riskFlag ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const manualReviewState = (q.manualReviewState ?? '').trim()

      const where: any = {}
      if (search) {
        where.OR = [
          { email: { contains: search.toLowerCase() } },
          { name: { contains: search, mode: 'insensitive' as const } },
        ]
      }
      if (riskFlags.length > 0) where.riskFlag = { in: riskFlags }
      if (manualReviewState) where.manualReviewState = manualReviewState

      const [rows, total] = await Promise.all([
        prisma.customer.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
          select: {
            id: true,
            email: true,
            name: true,
            totalOrders: true,
            totalSpentCents: true,
            firstOrderAt: true,
            lastOrderAt: true,
            channelOrderCounts: true,
            tags: true,
            riskFlag: true,
            manualReviewState: true,
            lastRiskComputedAt: true,
            createdAt: true,
          },
        }),
        prisma.customer.count({ where }),
      ])

      return {
        customers: rows.map((c) => ({
          ...c,
          // Serialise BigInt to Number — totalSpentCents fits an Int53 for
          // any realistic LTV (€90T cap). Frontend reads it as a number.
          totalSpentCents: Number(c.totalSpentCents),
        })),
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      }
    } catch (err: any) {
      logger.error('GET /api/customers failed', { error: err?.message })
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── Detail ─────────────────────────────────────────────────────────
  app.get('/api/customers/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const customer = await prisma.customer.findUnique({
        where: { id },
        include: {
          addresses: { orderBy: { isPrimary: 'desc' } },
          notes: { orderBy: [{ pinned: 'desc' }, { createdAt: 'desc' }] },
        },
      })
      if (!customer) return reply.status(404).send({ error: 'Customer not found' })

      // Recent orders (last 50) — full join would be heavy on big
      // customers; the detail page doesn't need every order, just
      // the timeline header + a "View all N orders" deep-link.
      // Includes the per-order risk score so the detail UI can show
      // the breakdown without a second roundtrip.
      const orders = await prisma.order.findMany({
        where: { customerId: id },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: {
          id: true,
          channel: true,
          marketplace: true,
          channelOrderId: true,
          status: true,
          totalPrice: true,
          currencyCode: true,
          purchaseDate: true,
          createdAt: true,
          riskScore: {
            select: {
              score: true,
              flag: true,
              signals: true,
              reasons: true,
              computedAt: true,
            },
          },
        },
      })

      return {
        ...customer,
        totalSpentCents: Number(customer.totalSpentCents),
        orders: orders.map((o) => ({
          ...o,
          totalPrice: Number(o.totalPrice),
        })),
      }
    } catch (err: any) {
      logger.error('GET /api/customers/:id failed', { error: err?.message })
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── Lookup by email ────────────────────────────────────────────────
  // Closes the loop with the existing OrdersWorkspace customerEmail
  // filter pattern: clicking a customer email link historically went
  // to /orders?customerEmail=… (no Customer concept). With O.20+O.21,
  // CustomerLens / OrderDetailClient / etc. can resolve email → id
  // and link straight to /customers/:id instead.
  app.get('/api/customers/by-email/:email', async (request, reply) => {
    try {
      const { email } = request.params as { email: string }
      const customer = await prisma.customer.findUnique({
        where: { email: email.toLowerCase() },
        select: { id: true, email: true, name: true },
      })
      if (!customer) return reply.status(404).send({ error: 'No customer for that email' })
      return customer
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── Notes CRUD ─────────────────────────────────────────────────────
  app.post('/api/customers/:id/notes', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { body?: string; pinned?: boolean; authorEmail?: string }
      if (!body.body || body.body.trim() === '') {
        return reply.status(400).send({ error: 'body required' })
      }
      const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } })
      if (!customer) return reply.status(404).send({ error: 'Customer not found' })

      const note = await prisma.customerNote.create({
        data: {
          customerId: id,
          body: body.body.trim(),
          pinned: body.pinned ?? false,
          authorEmail: body.authorEmail ?? null,
        },
      })
      return note
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  app.patch('/api/customers/:id/notes/:noteId', async (request, reply) => {
    try {
      const { id, noteId } = request.params as { id: string; noteId: string }
      const body = request.body as { body?: string; pinned?: boolean }
      const existing = await prisma.customerNote.findFirst({
        where: { id: noteId, customerId: id },
      })
      if (!existing) return reply.status(404).send({ error: 'Note not found' })
      const updated = await prisma.customerNote.update({
        where: { id: noteId },
        data: {
          body: body.body !== undefined ? body.body.trim() : undefined,
          pinned: body.pinned !== undefined ? body.pinned : undefined,
        },
      })
      return updated
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  app.delete('/api/customers/:id/notes/:noteId', async (request, reply) => {
    try {
      const { id, noteId } = request.params as { id: string; noteId: string }
      const existing = await prisma.customerNote.findFirst({
        where: { id: noteId, customerId: id },
      })
      if (!existing) return reply.status(404).send({ error: 'Note not found' })
      await prisma.customerNote.delete({ where: { id: noteId } })
      return { ok: true }
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── Tags (replace-array semantics) ─────────────────────────────────
  app.patch('/api/customers/:id/tags', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { tags?: string[] }
      if (!Array.isArray(body.tags)) {
        return reply.status(400).send({ error: 'tags array required' })
      }
      const updated = await prisma.customer.update({
        where: { id },
        data: { tags: body.tags },
      })
      return { id: updated.id, tags: updated.tags }
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── O.22: risk queue — flagged customers awaiting operator review ─
  app.get('/api/customers/risk-queue', async (request, reply) => {
    try {
      const q = request.query as Record<string, string | undefined>
      const flags = (q.flag ?? 'HIGH,MEDIUM')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const limit = Math.min(500, parseInt(q.limit ?? '100', 10) || 100)

      const customers = await prisma.customer.findMany({
        where: {
          OR: [
            { riskFlag: { in: flags } },
            { manualReviewState: 'PENDING' },
          ],
        },
        orderBy: [
          // PENDING reviews first, then by score severity by proxy of
          // lastOrderAt freshness.
          { manualReviewState: 'desc' },
          { lastOrderAt: 'desc' },
        ],
        take: limit,
        select: {
          id: true,
          email: true,
          name: true,
          totalOrders: true,
          totalSpentCents: true,
          lastOrderAt: true,
          riskFlag: true,
          manualReviewState: true,
          lastRiskComputedAt: true,
        },
      })
      return {
        customers: customers.map((c) => ({
          ...c,
          totalSpentCents: Number(c.totalSpentCents),
        })),
      }
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── O.22: set manual-review state (PENDING / APPROVED / REJECTED) ──
  app.patch('/api/customers/:id/manual-review', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { state?: string }
      const allowed = ['PENDING', 'APPROVED', 'REJECTED']
      if (!body.state || !allowed.includes(body.state)) {
        return reply.status(400).send({ error: `state must be one of ${allowed.join(', ')}` })
      }
      const updated = await prisma.customer.update({
        where: { id },
        data: { manualReviewState: body.state },
        select: { id: true, manualReviewState: true },
      })
      return updated
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── O.22: manual recompute (recomputes every order + rolls up) ─────
  app.post('/api/customers/:id/recompute-risk', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } })
      if (!customer) return reply.status(404).send({ error: 'Customer not found' })
      await recomputeCustomerRisk(id)
      const fresh = await prisma.customer.findUnique({
        where: { id },
        select: {
          id: true,
          riskFlag: true,
          manualReviewState: true,
          lastRiskComputedAt: true,
        },
      })
      return fresh
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // ── Manual cache refresh (ops escape hatch) ────────────────────────
  app.post('/api/customers/:id/refresh-cache', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const customer = await prisma.customer.findUnique({ where: { id }, select: { id: true } })
      if (!customer) return reply.status(404).send({ error: 'Customer not found' })
      await refreshCustomerCache(id)
      const fresh = await prisma.customer.findUnique({
        where: { id },
        select: {
          id: true,
          totalOrders: true,
          totalSpentCents: true,
          firstOrderAt: true,
          lastOrderAt: true,
          channelOrderCounts: true,
        },
      })
      return { ...fresh, totalSpentCents: Number(fresh!.totalSpentCents) }
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message ?? 'failed' })
    }
  })
}
