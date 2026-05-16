/**
 * CI.2 + CI.4 — Customer Segments API.
 *
 *   GET    /api/customers/segments               list all segments
 *   POST   /api/customers/segments               create segment
 *   PATCH  /api/customers/segments/:id           update
 *   DELETE /api/customers/segments/:id           delete
 *   POST   /api/customers/segments/:id/evaluate  on-demand recount
 *   GET    /api/customers/segments/:id/customers paginated members
 *   POST   /api/customers/segments/:id/export    CSV export
 *   POST   /api/customers/segments/:id/tag       bulk tag members
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  evaluateSegment,
  listCustomersInSegment,
  type SegmentCondition,
} from '../services/customer-segment.service.js'

const customerSegmentsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── List segments ─────────────────────────────────────────────────────────
  fastify.get('/customers/segments', async () => {
    const segments = await prisma.customerSegment.findMany({
      orderBy: { updatedAt: 'desc' },
    })
    return { segments }
  })

  // ── Create segment ────────────────────────────────────────────────────────
  fastify.post('/customers/segments', async (req, reply) => {
    const body = req.body as {
      name: string
      description?: string
      conditions?: SegmentCondition[]
      createdBy?: string
    }
    if (!body.name?.trim()) return reply.status(400).send({ error: 'name is required' })

    const conditions = body.conditions ?? []
    const { count } = await evaluateSegment(prisma, conditions)

    const segment = await prisma.customerSegment.create({
      data: {
        name: body.name.trim(),
        description: body.description?.trim() ?? null,
        conditions: conditions as never,
        customerCount: count,
        lastCountedAt: new Date(),
        createdBy: body.createdBy ?? null,
      },
    })
    return reply.status(201).send({ segment })
  })

  // ── Update segment ────────────────────────────────────────────────────────
  fastify.patch('/customers/segments/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = req.body as {
      name?: string
      description?: string
      conditions?: SegmentCondition[]
    }

    let countUpdate = {}
    if (body.conditions) {
      const { count } = await evaluateSegment(prisma, body.conditions)
      countUpdate = { customerCount: count, lastCountedAt: new Date() }
    }

    const segment = await prisma.customerSegment.update({
      where: { id },
      data: {
        ...(body.name ? { name: body.name.trim() } : {}),
        ...(body.description !== undefined ? { description: body.description?.trim() ?? null } : {}),
        ...(body.conditions ? { conditions: body.conditions as never } : {}),
        ...countUpdate,
        updatedAt: new Date(),
      },
    })
    return { segment }
  })

  // ── Delete segment ────────────────────────────────────────────────────────
  fastify.delete('/customers/segments/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await prisma.customerSegment.delete({ where: { id } })
    return reply.status(204).send()
  })

  // ── On-demand evaluate ────────────────────────────────────────────────────
  fastify.post('/customers/segments/:id/evaluate', async (req, reply) => {
    const { id } = req.params as { id: string }
    const seg = await prisma.customerSegment.findUnique({ where: { id } })
    if (!seg) return reply.status(404).send({ error: 'Segment not found' })

    const conditions = seg.conditions as unknown as SegmentCondition[]
    const { count, sampleIds } = await evaluateSegment(prisma, conditions, { limit: 5 })

    await prisma.customerSegment.update({
      where: { id },
      data: { customerCount: count, lastCountedAt: new Date() },
    })

    // Load sample customers for preview
    const sample = await prisma.customer.findMany({
      where: { id: { in: sampleIds } },
      select: { id: true, email: true, name: true, totalSpentCents: true, rfmLabel: true },
    })

    return { count, sample: sample.map((c) => ({ ...c, totalSpentCents: Number(c.totalSpentCents) })) }
  })

  // ── Paginated members ─────────────────────────────────────────────────────
  fastify.get('/customers/segments/:id/customers', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { limit = '50', offset = '0' } = req.query as { limit?: string; offset?: string }

    const seg = await prisma.customerSegment.findUnique({ where: { id } })
    if (!seg) return reply.status(404).send({ error: 'Segment not found' })

    const customers = await listCustomersInSegment(
      prisma,
      seg.conditions as unknown as SegmentCondition[],
      { limit: parseInt(limit, 10), offset: parseInt(offset, 10) },
    )

    return {
      customers: customers.map((c) => ({ ...c, totalSpentCents: Number(c.totalSpentCents) })),
      segment: { id: seg.id, name: seg.name, customerCount: seg.customerCount },
    }
  })

  // ── CI.4: CSV export ──────────────────────────────────────────────────────
  fastify.post('/customers/segments/:id/export', async (req, reply) => {
    const { id } = req.params as { id: string }
    const seg = await prisma.customerSegment.findUnique({ where: { id } })
    if (!seg) return reply.status(404).send({ error: 'Segment not found' })

    const customers = await listCustomersInSegment(
      prisma,
      seg.conditions as unknown as SegmentCondition[],
      { limit: 10000 },
    )

    const lines = [
      'email,name,ltv_eur,total_orders,last_order_at,rfm_label,fiscal_kind,tags',
      ...customers.map((c) => [
        c.email,
        `"${(c.name ?? '').replace(/"/g, '""')}"`,
        (Number(c.totalSpentCents) / 100).toFixed(2),
        c.totalOrders,
        c.lastOrderAt?.toISOString().slice(0, 10) ?? '',
        c.rfmLabel ?? '',
        c.fiscalKind ?? '',
        `"${c.tags.join(';')}"`,
      ].join(',')),
    ]

    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="segment-${id}.csv"`)
      .send(lines.join('\n'))
  })

  // ── CI.4: Bulk tag ────────────────────────────────────────────────────────
  fastify.post('/customers/segments/:id/tag', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { tag } = req.body as { tag: string }
    if (!tag?.trim()) return reply.status(400).send({ error: 'tag is required' })

    const seg = await prisma.customerSegment.findUnique({ where: { id } })
    if (!seg) return reply.status(404).send({ error: 'Segment not found' })

    const { sampleIds: allIds } = await evaluateSegment(prisma, seg.conditions as unknown as SegmentCondition[], { limit: 10000 })

    // Get all IDs (evaluateSegment with high limit)
    const members = await prisma.customer.findMany({
      where: { id: { in: allIds } },
      select: { id: true, tags: true },
    })

    // Add tag if not already present
    let updated = 0
    await Promise.allSettled(
      members.filter((c) => !c.tags.includes(tag)).map(async (c) => {
        await prisma.customer.update({
          where: { id: c.id },
          data: { tags: [...c.tags, tag] },
        })
        updated++
      }),
    )

    return { ok: true, updated }
  })

  // ── CI.4: Review request for segment ─────────────────────────────────────
  fastify.post('/customers/segments/:id/review-request', async (req, reply) => {
    const { id } = req.params as { id: string }
    const seg = await prisma.customerSegment.findUnique({ where: { id } })
    if (!seg) return reply.status(404).send({ error: 'Segment not found' })

    const { sampleIds } = await evaluateSegment(prisma, seg.conditions as unknown as SegmentCondition[], { limit: 10000 })

    // Find DELIVERED orders for these customers without a recent ReviewRequest
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)

    const orders = await prisma.order.findMany({
      where: {
        customerId: { in: sampleIds },
        status: 'DELIVERED',
        reviewRequests: { none: { createdAt: { gte: cutoff } } },
      },
      select: { id: true, channel: true, marketplace: true },
      take: 500,
    })

    if (orders.length === 0) return { ok: true, created: 0, message: 'No eligible orders found' }

    await prisma.reviewRequest.createMany({
      data: orders.map((o) => ({
        orderId: o.id,
        channel: o.channel,
        status: 'SCHEDULED',
        scheduledFor: new Date(), // schedule for now; SR.4 mailer picks up next tick
        triggeredBy: `segment:${id}`,
      })),
      skipDuplicates: true,
    })

    return { ok: true, created: orders.length }
  })
}

export default customerSegmentsRoutes
