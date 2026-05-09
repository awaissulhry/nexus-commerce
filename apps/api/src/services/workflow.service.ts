/**
 * W3.2 — WorkflowService.
 *
 * State-machine helpers for the W3.1 ProductWorkflow schema.
 *
 *   attachToProduct(productId, workflowId, ctx)
 *     Drops the product onto the workflow's `isInitial` stage and
 *     writes the entry transition (fromStage=null → toStage=initial).
 *
 *   moveStage(productId, toStageId, ctx)
 *     Transitions the product to a new stage on the same workflow.
 *     Refuses cross-workflow moves (the candidate stage must belong
 *     to the same workflow as the current stage). Writes a
 *     WorkflowTransition log row inside the same $transaction as
 *     the Product update so the history is always consistent with
 *     the live state.
 *
 *   canTransition(productId, toStageId)
 *     Pre-flight check used by the API to surface a friendly error
 *     before the operator clicks. Returns { ok, reason? }.
 *
 *   slaState(stage, enteredAt)
 *     Computes overdue/soon/on-track for the workflow lens badges.
 *
 * Movement policy (intentionally permissive for the single-operator
 * MVP):
 *
 *   - Forward AND backward moves both allowed within a workflow.
 *     Akeneo allows configurable per-stage "next stages"; we don't
 *     have the operator headcount yet to need a strict graph.
 *   - Cross-workflow moves rejected — the candidate stage must
 *     belong to the same workflow as the current stage. Detach +
 *     attach is the path for switching workflows.
 *   - A product without a workflow stage can be attached to any
 *     workflow (the entry transition has fromStage=null).
 *
 * Pure / impure split:
 *
 *   slaState() and validateWorkflow() are pure — exported for unit
 *   tests + UI re-use without a DB roundtrip. The DB-bound methods
 *   live on the class.
 */

import type { PrismaClient } from '@prisma/client'
import { Prisma } from '@prisma/client'
import prisma from '../db.js'
import { auditLogService } from './audit-log.service.js'

export type SlaState = 'on_track' | 'soon' | 'overdue' | 'no_sla'

export interface SlaInfo {
  state: SlaState
  /** ISO timestamp when the SLA expires; null when stage has no SLA. */
  dueAt: string | null
  /** Hours until / since the SLA. Negative when overdue. */
  hoursRemaining: number | null
}

export interface MoveContext {
  userId?: string | null
  comment?: string | null
  ip?: string | null
}

export interface MoveResult {
  changed: boolean
  fromStageId: string | null
  toStageId: string
  transitionId: string
}

export interface WorkflowValidation {
  ok: boolean
  errors: string[]
}

/**
 * Pure validation of a workflow's stage list. Called at write time
 * by the W3.3+ API to refuse a workflow that breaks the invariants
 * the runtime depends on.
 */
export function validateWorkflow(
  stages: Array<{ code: string; isInitial: boolean; isTerminal: boolean }>,
): WorkflowValidation {
  const errors: string[] = []

  if (stages.length === 0) {
    errors.push('workflow must have at least one stage')
  }

  const initialCount = stages.filter((s) => s.isInitial).length
  if (initialCount === 0)
    errors.push('workflow must have exactly one isInitial=true stage')
  else if (initialCount > 1)
    errors.push(
      `workflow has ${initialCount} isInitial=true stages; exactly one is allowed`,
    )

  const terminalCount = stages.filter((s) => s.isTerminal).length
  if (terminalCount > 1)
    errors.push(
      `workflow has ${terminalCount} isTerminal=true stages; at most one is allowed`,
    )

  // Code uniqueness — the DB enforces @@unique([workflowId, code])
  // but checking here gives a faster, friendlier error.
  const codes = new Map<string, number>()
  for (const s of stages) codes.set(s.code, (codes.get(s.code) ?? 0) + 1)
  for (const [code, n] of codes) {
    if (n > 1) errors.push(`stage code "${code}" appears ${n} times`)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Pure SLA computation. Called by the workflow lens to render
 * overdue/soon badges per product.
 *
 *   on_track : within budget; > 25% time remaining
 *   soon     : within budget; ≤ 25% time remaining
 *   overdue  : past the SLA
 *   no_sla   : stage.slaHours is null
 */
export function slaState(
  stage: { slaHours: number | null },
  enteredAt: Date | string,
  now: Date = new Date(),
): SlaInfo {
  if (stage.slaHours == null) {
    return { state: 'no_sla', dueAt: null, hoursRemaining: null }
  }
  const entered = typeof enteredAt === 'string' ? new Date(enteredAt) : enteredAt
  const dueMs = entered.getTime() + stage.slaHours * 3600 * 1000
  const dueAt = new Date(dueMs)
  const remainingMs = dueMs - now.getTime()
  const hoursRemaining = remainingMs / 3600 / 1000

  let state: SlaState
  if (remainingMs < 0) state = 'overdue'
  else if (remainingMs < stage.slaHours * 3600 * 1000 * 0.25) state = 'soon'
  else state = 'on_track'

  return {
    state,
    dueAt: dueAt.toISOString(),
    hoursRemaining,
  }
}

export class WorkflowService {
  constructor(private readonly client: PrismaClient = prisma) {}

  /**
   * Drop a product onto the workflow's initial stage. Idempotent —
   * if the product is already on this workflow's initial stage,
   * returns changed=false and writes no transition.
   */
  async attachToProduct(
    productId: string,
    workflowId: string,
    ctx: MoveContext = {},
  ): Promise<MoveResult> {
    const initial = await this.client.workflowStage.findFirst({
      where: { workflowId, isInitial: true },
      select: { id: true, workflowId: true },
    })
    if (!initial) {
      throw new Error(
        `WorkflowService.attachToProduct: workflow ${workflowId} has no isInitial stage`,
      )
    }
    return this.moveStageInternal(productId, initial.id, ctx, true)
  }

  async moveStage(
    productId: string,
    toStageId: string,
    ctx: MoveContext = {},
  ): Promise<MoveResult> {
    return this.moveStageInternal(productId, toStageId, ctx, false)
  }

  /**
   * Pre-flight check. Returns { ok: false, reason } when the
   * transition would be rejected by moveStage. Cheap — does the
   * same lookups but skips the writes.
   */
  async canTransition(
    productId: string,
    toStageId: string,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const toStage = await this.client.workflowStage.findUnique({
      where: { id: toStageId },
      select: { id: true, workflowId: true },
    })
    if (!toStage) return { ok: false, reason: 'target stage not found' }

    const product = await this.client.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        workflowStageId: true,
        workflowStage: { select: { workflowId: true } },
      },
    })
    if (!product) return { ok: false, reason: 'product not found' }

    if (
      product.workflowStage &&
      product.workflowStage.workflowId !== toStage.workflowId
    ) {
      return {
        ok: false,
        reason:
          'cross-workflow move rejected — detach the current workflow first',
      }
    }

    return { ok: true }
  }

  private async moveStageInternal(
    productId: string,
    toStageId: string,
    ctx: MoveContext,
    isInitialAttach: boolean,
  ): Promise<MoveResult> {
    return this.client.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { id: productId },
        select: {
          id: true,
          sku: true,
          workflowStageId: true,
          workflowStage: { select: { workflowId: true } },
        },
      })
      if (!product) {
        throw new Error(`WorkflowService: product ${productId} not found`)
      }

      const toStage = await tx.workflowStage.findUnique({
        where: { id: toStageId },
        select: { id: true, workflowId: true, code: true, label: true },
      })
      if (!toStage) {
        throw new Error(`WorkflowService: target stage ${toStageId} not found`)
      }

      // Cross-workflow guard. Initial attach (from null) is exempt.
      if (
        !isInitialAttach &&
        product.workflowStage &&
        product.workflowStage.workflowId !== toStage.workflowId
      ) {
        throw new Error(
          'WorkflowService: cross-workflow move rejected — detach the current workflow first',
        )
      }

      // No-op short-circuit. Writes nothing, returns changed=false.
      if (product.workflowStageId === toStageId) {
        return {
          changed: false,
          fromStageId: product.workflowStageId,
          toStageId,
          transitionId: '',
        }
      }

      const fromStageId = product.workflowStageId

      const transition = await tx.workflowTransition.create({
        data: {
          productId,
          fromStageId,
          toStageId,
          userId: ctx.userId ?? null,
          comment: ctx.comment ?? null,
        },
        select: { id: true },
      })

      await tx.product.update({
        where: { id: productId },
        data: { workflowStageId: toStageId },
      })

      // Audit row outside the tx (fail-open) — same pattern as the
      // master-* services. Slim diff.
      void auditLogService.write({
        userId: ctx.userId ?? null,
        ip: ctx.ip ?? null,
        entityType: 'Product',
        entityId: productId,
        action: 'workflow.transition',
        before: { workflowStageId: fromStageId },
        after: { workflowStageId: toStageId },
        metadata: {
          source: 'workflow.service',
          fromStageId,
          toStageId,
          toStageCode: toStage.code,
          transitionId: transition.id,
          comment: ctx.comment ?? null,
        },
      })

      return {
        changed: true,
        fromStageId,
        toStageId,
        transitionId: transition.id,
      }
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    })
  }
}

export const workflowService = new WorkflowService()
