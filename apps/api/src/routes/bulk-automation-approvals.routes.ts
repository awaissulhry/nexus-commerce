/**
 * W7.7 — Approval-queue routes.
 *
 * /api/bulk-automation-approvals — list / approve / reject /
 * sweep-expired. The W7 visual builder + a dedicated approvals
 * page (W7.8 stretches to include it inline) consume this surface.
 */

import type { FastifyPluginAsync } from 'fastify'
import { BulkApprovalService } from '../services/automation/bulk-approval.service.js'
import prisma from '../db.js'

const approvalService = new BulkApprovalService(prisma)

const bulkAutomationApprovalsRoutes: FastifyPluginAsync = async (fastify) => {
  /** GET /api/bulk-automation-approvals */
  fastify.get<{
    Querystring: { status?: string; ruleId?: string; limit?: string }
  }>('/bulk-automation-approvals', async (request, reply) => {
    try {
      const q = request.query
      const approvals = await approvalService.list({
        status: q.status,
        ruleId: q.ruleId,
        limit: q.limit ? Number(q.limit) : undefined,
      })
      return reply.send({ success: true, approvals })
    } catch (e) {
      return reply
        .code(500)
        .send({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })

  /** GET /api/bulk-automation-approvals/:id */
  fastify.get<{ Params: { id: string } }>(
    '/bulk-automation-approvals/:id',
    async (request, reply) => {
      const a = await approvalService.get(request.params.id)
      if (!a) return reply.code(404).send({ success: false, error: 'Not found' })
      return reply.send({ success: true, approval: a })
    },
  )

  /** POST /api/bulk-automation-approvals/:id/approve */
  fastify.post<{
    Params: { id: string }
    Body: { approvedBy?: string | null }
  }>(
    '/bulk-automation-approvals/:id/approve',
    async (request, reply) => {
      try {
        const a = await approvalService.approve(
          request.params.id,
          request.body?.approvedBy ?? null,
        )
        return reply.send({ success: true, approval: a })
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (msg.startsWith('Approval not found')) {
          return reply.code(404).send({ success: false, error: msg })
        }
        if (
          msg.startsWith('Approval is not PENDING') ||
          msg.startsWith('Approval has expired')
        ) {
          return reply.code(409).send({ success: false, error: msg })
        }
        return reply.code(500).send({ success: false, error: msg })
      }
    },
  )

  /** POST /api/bulk-automation-approvals/:id/reject */
  fastify.post<{
    Params: { id: string }
    Body: { rejectedBy?: string | null; reason?: string | null }
  }>('/bulk-automation-approvals/:id/reject', async (request, reply) => {
    try {
      const a = await approvalService.reject(
        request.params.id,
        request.body?.rejectedBy ?? null,
        request.body?.reason ?? null,
      )
      return reply.send({ success: true, approval: a })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (msg.startsWith('Approval not found')) {
        return reply.code(404).send({ success: false, error: msg })
      }
      if (msg.startsWith('Approval is not PENDING')) {
        return reply.code(409).send({ success: false, error: msg })
      }
      return reply.code(500).send({ success: false, error: msg })
    }
  })

  /** POST /api/bulk-automation-approvals/sweep-expired */
  fastify.post('/bulk-automation-approvals/sweep-expired', async (_request, reply) => {
    try {
      const r = await approvalService.expireStale()
      return reply.send({ success: true, ...r })
    } catch (e) {
      return reply
        .code(500)
        .send({ success: false, error: e instanceof Error ? e.message : String(e) })
    }
  })
}

export default bulkAutomationApprovalsRoutes
