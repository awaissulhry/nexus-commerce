/**
 * W3.4 — Per-product workflow API.
 *
 * The workflow *definition* CRUD lives in workflows.routes.ts (W3.3).
 * This file is the *runtime*: attach a product to a workflow, move
 * between stages, read history, post comments. Wraps
 * workflowService (W3.2) which owns the state-machine guards +
 * audit-log writes.
 *
 * Endpoints (all under /api):
 *
 *   POST   /products/:id/workflow/attach        { workflowId }
 *           Lands the product on the workflow's isInitial stage and
 *           writes the entry transition (fromStage=null → initial).
 *           Idempotent — re-attaching to the same workflow's initial
 *           stage is a no-op.
 *
 *   POST   /products/:id/workflow/detach
 *           Clears Product.workflowStageId. Does NOT delete the
 *           transition history — the audit trail stays intact for
 *           re-attachment later. No transition row is written for
 *           detach (would have a null toStage which the schema
 *           refuses); detach is logged as a separate AuditLog row.
 *
 *   POST   /products/:id/workflow/move          { toStageId, comment? }
 *           Cross-workflow moves rejected (per workflowService rule).
 *           Writes WorkflowTransition + Product update inside one tx.
 *
 *   GET    /products/:id/workflow
 *           Snapshot: current stage, full transition history, all
 *           comments, sla state for the current stage.
 *
 *   POST   /products/:id/workflow/comments      { stageId, body }
 *           Comment scoped to a stage. Survives transitions.
 *
 *   DELETE /workflow-comments/:id
 *           Hard delete. Audit row is the recovery path.
 *
 *   POST   /products/bulk-move-workflow-stage   { productIds, toStageId, comment? }
 *           Bulk transition (BulkActionBar integration). Reuses the
 *           single-product moveStage so each product gets its own
 *           transition row + audit. Hard-capped at 500.
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import {
  workflowService,
  slaState,
} from '../services/workflow.service.js'
import { auditLogService } from '../services/audit-log.service.js'

const productWorkflowRoutes: FastifyPluginAsync = async (fastify) => {
  // ── attach / detach ─────────────────────────────────────────

  fastify.post('/products/:id/workflow/attach', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as { workflowId?: string; comment?: string | null }
    if (!body.workflowId)
      return reply.code(400).send({ error: 'workflowId is required' })

    try {
      const result = await workflowService.attachToProduct(
        productId,
        body.workflowId,
        {
          ip: request.ip ?? null,
          comment: body.comment ?? null,
        },
      )
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/no isInitial stage|not found/i.test(msg))
        return reply.code(400).send({ error: msg })
      throw err
    }
  })

  fastify.post('/products/:id/workflow/detach', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, workflowStageId: true },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })
    if (product.workflowStageId == null)
      return { ok: true, changed: false, productId }

    await prisma.product.update({
      where: { id: productId },
      data: { workflowStageId: null },
    })

    void auditLogService.write({
      userId: null,
      ip: request.ip ?? null,
      entityType: 'Product',
      entityId: productId,
      action: 'workflow.detach',
      before: { workflowStageId: product.workflowStageId },
      after: { workflowStageId: null },
      metadata: { source: 'product-workflow.routes' },
    })

    return { ok: true, changed: true, productId }
  })

  // ── move stage ──────────────────────────────────────────────

  fastify.post('/products/:id/workflow/move', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as { toStageId?: string; comment?: string | null }
    if (!body.toStageId)
      return reply.code(400).send({ error: 'toStageId is required' })

    try {
      const result = await workflowService.moveStage(
        productId,
        body.toStageId,
        {
          ip: request.ip ?? null,
          comment: body.comment ?? null,
        },
      )
      return result
    } catch (err: any) {
      const msg = err?.message ?? String(err)
      if (/cross-workflow/i.test(msg))
        return reply.code(409).send({ error: msg })
      if (/not found/i.test(msg))
        return reply.code(404).send({ error: msg })
      throw err
    }
  })

  // ── snapshot ────────────────────────────────────────────────

  fastify.get('/products/:id/workflow', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        sku: true,
        workflowStageId: true,
        workflowStage: {
          select: {
            id: true,
            code: true,
            label: true,
            slaHours: true,
            isPublishable: true,
            isInitial: true,
            isTerminal: true,
            workflowId: true,
            workflow: {
              select: {
                id: true,
                code: true,
                label: true,
                stages: {
                  orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
                },
              },
            },
          },
        },
        workflowTransitions: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            fromStage: { select: { id: true, code: true, label: true } },
            toStage: { select: { id: true, code: true, label: true } },
          },
        },
        workflowComments: {
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: {
            stage: { select: { id: true, code: true, label: true } },
          },
        },
      },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })

    // SLA: based on the current stage's slaHours + the most recent
    // transition's createdAt (i.e., when the product entered this
    // stage). Falls back to product.workflowStage.createdAt if no
    // transition exists (shouldn't happen post-attach, but defensive).
    let sla = null as ReturnType<typeof slaState> | null
    if (product.workflowStage) {
      const enteredTransition = product.workflowTransitions.find(
        (t) => t.toStageId === product.workflowStageId,
      )
      const enteredAt =
        enteredTransition?.createdAt ?? new Date(0).toISOString()
      sla = slaState(
        { slaHours: product.workflowStage.slaHours },
        enteredAt,
      )
    }

    return {
      productId,
      sku: product.sku,
      currentStage: product.workflowStage,
      sla,
      transitions: product.workflowTransitions,
      comments: product.workflowComments,
    }
  })

  // ── comments ────────────────────────────────────────────────

  fastify.post('/products/:id/workflow/comments', async (request, reply) => {
    const { id: productId } = request.params as { id: string }
    const body = request.body as { stageId?: string; body?: string }
    if (!body.stageId)
      return reply.code(400).send({ error: 'stageId is required' })
    if (!body.body?.trim())
      return reply.code(400).send({ error: 'body is required' })

    const stage = await prisma.workflowStage.findUnique({
      where: { id: body.stageId },
      select: { id: true, workflowId: true },
    })
    if (!stage) return reply.code(400).send({ error: 'stageId does not exist' })

    const product = await prisma.product.findUnique({
      where: { id: productId },
      select: { id: true },
    })
    if (!product) return reply.code(404).send({ error: 'product not found' })

    const comment = await prisma.workflowComment.create({
      data: {
        productId,
        stageId: body.stageId,
        body: body.body.trim(),
      },
      include: {
        stage: { select: { id: true, code: true, label: true } },
      },
    })
    return reply.code(201).send({ comment })
  })

  fastify.delete('/workflow-comments/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      const comment = await prisma.workflowComment.delete({
        where: { id },
        select: { productId: true },
      })
      void auditLogService.write({
        userId: null,
        ip: request.ip ?? null,
        entityType: 'Product',
        entityId: comment.productId,
        action: 'workflow.comment.delete',
        metadata: { commentId: id, source: 'product-workflow.routes' },
      })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'comment not found' })
      throw err
    }
  })

  // ── bulk move ───────────────────────────────────────────────

  fastify.post('/products/bulk-move-workflow-stage', async (request, reply) => {
    const body = request.body as {
      productIds?: string[]
      toStageId?: string
      comment?: string | null
    }
    if (!Array.isArray(body.productIds) || body.productIds.length === 0)
      return reply
        .code(400)
        .send({ error: 'productIds must be a non-empty array' })
    if (body.productIds.length > 500)
      return reply
        .code(400)
        .send({ error: 'productIds cannot exceed 500 per call' })
    if (!body.toStageId)
      return reply.code(400).send({ error: 'toStageId is required' })

    const startTs = Date.now()
    const results: Array<{
      productId: string
      changed: boolean
      error?: string
    }> = []
    let changedCount = 0
    let errorCount = 0

    // Sequential per-product so each gets its own transition row +
    // audit. moveStage is internally transactional; running them in
    // parallel can race on the Product.workflowStageId update for
    // products that share a parent. Sequential is fine at the 500
    // cap (each takes ~10ms).
    for (const productId of body.productIds) {
      try {
        const r = await workflowService.moveStage(productId, body.toStageId, {
          ip: request.ip ?? null,
          comment: body.comment ?? null,
        })
        results.push({ productId, changed: r.changed })
        if (r.changed) changedCount++
      } catch (err: any) {
        errorCount++
        results.push({
          productId,
          changed: false,
          error: err?.message ?? String(err),
        })
      }
    }

    return {
      ok: errorCount === 0,
      requested: body.productIds.length,
      changed: changedCount,
      noOp: body.productIds.length - changedCount - errorCount,
      errors: errorCount,
      perProduct: results,
      elapsedMs: Date.now() - startTs,
    }
  })
}

export default productWorkflowRoutes
