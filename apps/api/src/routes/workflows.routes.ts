/**
 * W3.3 — ProductWorkflow + WorkflowStage CRUD.
 *
 * Endpoints (all under /api):
 *
 *   ProductWorkflow:
 *     GET    /workflows                 list with stage counts
 *     GET    /workflows/:id             detail with stages
 *     POST   /workflows                 create with stages[] inline
 *     PATCH  /workflows/:id             update label/description
 *     DELETE /workflows/:id             drop (cascades to stages;
 *                                        attached families lose
 *                                        their workflowId via
 *                                        SET NULL)
 *
 *   WorkflowStage:
 *     POST   /workflows/:id/stages      add stage to workflow
 *     PATCH  /workflow-stages/:id       update label/order/SLA/flags
 *     DELETE /workflow-stages/:id       drop (RESTRICT'd by DB if
 *                                        transitions land on it)
 *
 * Stage transitions per product live in W3.4.
 *
 * Validation:
 *   - workflow code: required, lowercase snake_case
 *   - stage code: required, lowercase snake_case, unique per workflow
 *   - stages[] on create: must satisfy validateWorkflow():
 *       - non-empty
 *       - exactly one isInitial
 *       - at most one isTerminal
 *       - unique stage codes
 *
 * 409 returned for invariant violations (validateWorkflow failures,
 * P2002 unique-collisions, P2003 FK-restrict on stage deletes).
 */

import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { validateWorkflow } from '../services/workflow.service.js'

const CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/

interface StageInput {
  code?: string
  label?: string
  description?: string | null
  sortOrder?: number
  slaHours?: number | null
  isPublishable?: boolean
  isInitial?: boolean
  isTerminal?: boolean
}

const workflowsRoutes: FastifyPluginAsync = async (fastify) => {
  // ── ProductWorkflow ─────────────────────────────────────────

  fastify.get('/workflows', async () => {
    const workflows = await prisma.productWorkflow.findMany({
      orderBy: [{ label: 'asc' }],
      include: {
        _count: { select: { stages: true, families: true } },
      },
    })
    return { workflows }
  })

  fastify.get('/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const workflow = await prisma.productWorkflow.findUnique({
      where: { id },
      include: {
        stages: { orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }] },
        families: { select: { id: true, code: true, label: true } },
      },
    })
    if (!workflow)
      return reply.code(404).send({ error: 'workflow not found' })
    return { workflow }
  })

  fastify.post('/workflows', async (request, reply) => {
    const body = request.body as {
      code?: string
      label?: string
      description?: string | null
      stages?: StageInput[]
    }
    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error:
          'code is required and must be lowercase snake_case (matches /^[a-z][a-z0-9_]{0,63}$/)',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })
    if (!Array.isArray(body.stages) || body.stages.length === 0)
      return reply
        .code(400)
        .send({ error: 'stages[] is required and must contain at least one stage' })

    // Stage-level validation. Run validateWorkflow first so the
    // operator sees the structural error before per-stage code-regex
    // failures.
    const stagesNorm = body.stages.map((s, i) => ({
      code: s.code ?? '',
      label: s.label ?? '',
      description: s.description ?? null,
      sortOrder: typeof s.sortOrder === 'number' ? s.sortOrder : i,
      slaHours: s.slaHours == null ? null : Number(s.slaHours),
      isPublishable: !!s.isPublishable,
      isInitial: !!s.isInitial,
      isTerminal: !!s.isTerminal,
    }))
    const v = validateWorkflow(stagesNorm)
    if (!v.ok)
      return reply.code(409).send({
        error: 'workflow stage validation failed',
        details: v.errors,
      })
    for (const s of stagesNorm) {
      if (!CODE_PATTERN.test(s.code))
        return reply.code(400).send({
          error: `stage code "${s.code}" must be lowercase snake_case`,
        })
      if (!s.label.trim())
        return reply
          .code(400)
          .send({ error: `stage "${s.code}" requires a label` })
    }

    try {
      const created = await prisma.productWorkflow.create({
        data: {
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
          stages: { create: stagesNorm },
        },
        include: {
          stages: { orderBy: [{ sortOrder: 'asc' }] },
        },
      })
      return reply.code(201).send({ workflow: created })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply
          .code(409)
          .send({ error: `workflow code "${body.code}" already exists` })
      throw err
    }
  })

  fastify.patch('/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as {
      label?: string
      description?: string | null
    }
    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined)
      data.description = body.description?.trim() || null
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })
    try {
      const workflow = await prisma.productWorkflow.update({
        where: { id },
        data,
      })
      return { workflow }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'workflow not found' })
      throw err
    }
  })

  fastify.delete('/workflows/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.productWorkflow.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'workflow not found' })
      // P2003 from a transition still pointing at a stage in this
      // workflow — RESTRICT bubbles up. Rare but possible if the
      // operator soft-deletes a workflow with active products.
      if (err?.code === 'P2003')
        return reply.code(409).send({
          error:
            'cannot delete workflow: a stage still has WorkflowTransition rows pointing at it (RESTRICT). Move products off this workflow first.',
        })
      throw err
    }
  })

  // ── WorkflowStage ───────────────────────────────────────────

  fastify.post('/workflows/:id/stages', async (request, reply) => {
    const { id: workflowId } = request.params as { id: string }
    const body = request.body as StageInput

    if (!body.code || !CODE_PATTERN.test(body.code))
      return reply.code(400).send({
        error: 'code is required and must be lowercase snake_case',
      })
    if (!body.label?.trim())
      return reply.code(400).send({ error: 'label is required' })

    const wf = await prisma.productWorkflow.findUnique({
      where: { id: workflowId },
      include: { stages: true },
    })
    if (!wf) return reply.code(404).send({ error: 'workflow not found' })

    // Re-run validateWorkflow on the projected list to refuse adds
    // that would break invariants (e.g., a second isInitial).
    const projected = [
      ...wf.stages.map((s) => ({
        code: s.code,
        isInitial: s.isInitial,
        isTerminal: s.isTerminal,
      })),
      {
        code: body.code,
        isInitial: !!body.isInitial,
        isTerminal: !!body.isTerminal,
      },
    ]
    const v = validateWorkflow(projected)
    if (!v.ok)
      return reply.code(409).send({
        error: 'adding this stage would break workflow invariants',
        details: v.errors,
      })

    try {
      const stage = await prisma.workflowStage.create({
        data: {
          workflowId,
          code: body.code,
          label: body.label.trim(),
          description: body.description?.trim() || null,
          sortOrder:
            typeof body.sortOrder === 'number'
              ? body.sortOrder
              : wf.stages.length,
          slaHours: body.slaHours == null ? null : Number(body.slaHours),
          isPublishable: !!body.isPublishable,
          isInitial: !!body.isInitial,
          isTerminal: !!body.isTerminal,
        },
      })
      return reply.code(201).send({ stage })
    } catch (err: any) {
      if (err?.code === 'P2002')
        return reply.code(409).send({
          error: `stage code "${body.code}" already exists in this workflow`,
        })
      throw err
    }
  })

  fastify.patch('/workflow-stages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const body = request.body as StageInput

    const current = await prisma.workflowStage.findUnique({
      where: { id },
      select: {
        id: true,
        workflowId: true,
        code: true,
        isInitial: true,
        isTerminal: true,
      },
    })
    if (!current) return reply.code(404).send({ error: 'stage not found' })

    // Re-run validateWorkflow on the projected list. The patch may
    // flip isInitial / isTerminal on this stage; we need to refuse
    // the update if it'd leave the workflow with two initials etc.
    const peers = await prisma.workflowStage.findMany({
      where: { workflowId: current.workflowId, NOT: { id } },
      select: { code: true, isInitial: true, isTerminal: true },
    })
    const projected = [
      ...peers,
      {
        code: current.code,
        isInitial: body.isInitial ?? current.isInitial,
        isTerminal: body.isTerminal ?? current.isTerminal,
      },
    ]
    const v = validateWorkflow(projected)
    if (!v.ok)
      return reply.code(409).send({
        error: 'this update would break workflow invariants',
        details: v.errors,
      })

    const data: Record<string, unknown> = {}
    if (body.label !== undefined) {
      if (!body.label.trim())
        return reply.code(400).send({ error: 'label cannot be empty' })
      data.label = body.label.trim()
    }
    if (body.description !== undefined)
      data.description = body.description?.trim() || null
    if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
    if (body.slaHours !== undefined)
      data.slaHours = body.slaHours == null ? null : Number(body.slaHours)
    if (body.isPublishable !== undefined)
      data.isPublishable = !!body.isPublishable
    if (body.isInitial !== undefined) data.isInitial = !!body.isInitial
    if (body.isTerminal !== undefined) data.isTerminal = !!body.isTerminal
    if (Object.keys(data).length === 0)
      return reply.code(400).send({ error: 'no mutable fields supplied' })

    try {
      const stage = await prisma.workflowStage.update({
        where: { id },
        data,
      })
      return { stage }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'stage not found' })
      throw err
    }
  })

  fastify.delete('/workflow-stages/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    try {
      await prisma.workflowStage.delete({ where: { id } })
      return { ok: true, id }
    } catch (err: any) {
      if (err?.code === 'P2025')
        return reply.code(404).send({ error: 'stage not found' })
      if (err?.code === 'P2003')
        return reply.code(409).send({
          error:
            'cannot delete stage: a WorkflowTransition still lands on it (RESTRICT). Move affected products off this stage first.',
        })
      throw err
    }
  })
}

export default workflowsRoutes
