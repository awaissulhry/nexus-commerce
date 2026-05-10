/**
 * W9.x — Workflow assignment CRUD.
 *
 *   GET    /api/products/:id/workflow/assignments
 *     → WorkflowAssignment[] with assignee { id, displayName, email, avatarUrl }
 *
 *   POST   /api/products/:id/workflow/assignments
 *     body: { assigneeId, role?, stageId?, dueAt?, note? }
 *     → WorkflowAssignment
 *
 *   PATCH  /api/products/:id/workflow/assignments/:assignmentId
 *     body: { role?, stageId?, dueAt?, note? }
 *     → WorkflowAssignment
 *
 *   DELETE /api/products/:id/workflow/assignments/:assignmentId
 *     → { deleted: true }
 *
 *   GET    /api/users/search?q=...
 *     → UserProfile[] (for the assignee picker in the WorkflowTab)
 */

import type { FastifyPluginAsync } from 'fastify';
import prisma from '../db.js';

const VALID_ROLES = new Set(['REVIEWER', 'APPROVER', 'OWNER'])

const workflowAssignmentsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── GET assignments ─────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/products/:id/workflow/assignments',
    async (req, reply) => {
      const rows = await prisma.workflowAssignment.findMany({
        where: { productId: req.params.id },
        include: {
          assignee: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
          stage: { select: { id: true, label: true, code: true } },
        },
        orderBy: { createdAt: 'asc' },
      })
      return reply.send(rows)
    },
  )

  // ── POST — create assignment ─────────────────────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: {
      assigneeId: string;
      role?: string;
      stageId?: string | null;
      dueAt?: string | null;
      note?: string | null;
      assignedById?: string | null;
    };
  }>('/products/:id/workflow/assignments', async (req, reply) => {
    const { id } = req.params
    const { assigneeId, role = 'REVIEWER', stageId, dueAt, note, assignedById } = req.body ?? {}

    if (!assigneeId) return reply.status(400).send({ error: 'ASSIGNEE_REQUIRED' })
    if (!VALID_ROLES.has(role)) return reply.status(400).send({ error: 'INVALID_ROLE', validRoles: [...VALID_ROLES] })

    const [product, assignee] = await Promise.all([
      prisma.product.findUnique({ where: { id }, select: { id: true } }),
      prisma.userProfile.findUnique({ where: { id: assigneeId }, select: { id: true } }),
    ])
    if (!product) return reply.status(404).send({ error: 'PRODUCT_NOT_FOUND' })
    if (!assignee) return reply.status(404).send({ error: 'ASSIGNEE_NOT_FOUND' })

    const row = await prisma.workflowAssignment.upsert({
      where: { productId_assigneeId_role: { productId: id, assigneeId, role } },
      create: {
        productId: id,
        assigneeId,
        role,
        stageId: stageId ?? null,
        dueAt: dueAt ? new Date(dueAt) : null,
        note: note ?? null,
        assignedById: assignedById ?? null,
      },
      update: {
        stageId: stageId ?? null,
        dueAt: dueAt ? new Date(dueAt) : null,
        note: note ?? null,
        assignedById: assignedById ?? null,
      },
      include: {
        assignee: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        stage: { select: { id: true, label: true, code: true } },
      },
    })

    return reply.status(201).send(row)
  })

  // ── PATCH — update assignment ────────────────────────────────────────
  fastify.patch<{
    Params: { id: string; assignmentId: string };
    Body: {
      role?: string;
      stageId?: string | null;
      dueAt?: string | null;
      note?: string | null;
    };
  }>('/products/:id/workflow/assignments/:assignmentId', async (req, reply) => {
    const { id, assignmentId } = req.params
    const body = req.body ?? {}

    if (body.role !== undefined && !VALID_ROLES.has(body.role)) {
      return reply.status(400).send({ error: 'INVALID_ROLE' })
    }

    const existing = await prisma.workflowAssignment.findFirst({
      where: { id: assignmentId, productId: id },
    })
    if (!existing) return reply.status(404).send({ error: 'ASSIGNMENT_NOT_FOUND' })

    const updated = await prisma.workflowAssignment.update({
      where: { id: assignmentId },
      data: {
        ...(body.role !== undefined && { role: body.role }),
        ...(body.stageId !== undefined && { stageId: body.stageId }),
        ...(body.dueAt !== undefined && { dueAt: body.dueAt ? new Date(body.dueAt) : null }),
        ...(body.note !== undefined && { note: body.note }),
      },
      include: {
        assignee: { select: { id: true, displayName: true, email: true, avatarUrl: true } },
        stage: { select: { id: true, label: true, code: true } },
      },
    })
    return reply.send(updated)
  })

  // ── DELETE — remove assignment ───────────────────────────────────────
  fastify.delete<{ Params: { id: string; assignmentId: string } }>(
    '/products/:id/workflow/assignments/:assignmentId',
    async (req, reply) => {
      const { id, assignmentId } = req.params
      const existing = await prisma.workflowAssignment.findFirst({
        where: { id: assignmentId, productId: id },
      })
      if (!existing) return reply.status(404).send({ error: 'ASSIGNMENT_NOT_FOUND' })
      await prisma.workflowAssignment.delete({ where: { id: assignmentId } })
      return reply.send({ deleted: true })
    },
  )

  // ── GET users/search — for the assignee picker ──────────────────────
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/users/search',
    async (req, reply) => {
      const q = (req.query.q ?? '').trim()
      const limit = Math.min(parseInt(req.query.limit ?? '10', 10), 50)

      const users = await prisma.userProfile.findMany({
        where: q
          ? {
              OR: [
                { displayName: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {},
        select: { id: true, displayName: true, email: true, avatarUrl: true },
        take: limit,
        orderBy: { displayName: 'asc' },
      })
      return reply.send(users)
    },
  )
}

export default workflowAssignmentsRoutes
