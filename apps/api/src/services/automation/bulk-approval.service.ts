/**
 * W7.7 — Bulk-automation approval service.
 *
 * Pure CRUD over BulkAutomationApproval rows + the resume path that
 * fires the gated action when an operator approves. Distinct from
 * the AutomationRule evaluator (W4) and the bulk-ops triggers (W7.2)
 * — those produce the data this service queues; this service owns
 * the operator's approve/reject lifecycle.
 *
 * Approve/reject preserve the original triggerPayload + actionPlan
 * so the resumed action sees the exact same context the rule was
 * evaluating against, even if the underlying entity has changed
 * since the gate fired.
 */

import type {
  BulkAutomationApproval,
  PrismaClient,
} from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'

const DEFAULT_EXPIRY_HOURS = 24

export interface CreateApprovalInput {
  ruleId: string
  ruleName: string
  triggerPayload: Record<string, unknown>
  actionPlan: Array<Record<string, unknown>>
  threshold: 'value' | 'manual' | 'safety'
  estimatedValueCentsEur?: number | null
  expiresAt?: Date
  createdBy?: string | null
}

export class BulkApprovalService {
  constructor(private prisma: PrismaClient = prisma) {}

  async create(input: CreateApprovalInput): Promise<BulkAutomationApproval> {
    return this.prisma.bulkAutomationApproval.create({
      data: {
        ruleId: input.ruleId,
        ruleName: input.ruleName,
        triggerPayload: input.triggerPayload as never,
        actionPlan: input.actionPlan as never,
        threshold: input.threshold,
        estimatedValueCentsEur: input.estimatedValueCentsEur ?? null,
        expiresAt:
          input.expiresAt ??
          new Date(Date.now() + DEFAULT_EXPIRY_HOURS * 60 * 60 * 1000),
        createdBy: input.createdBy ?? null,
      },
    })
  }

  async list(filters: {
    status?: string
    ruleId?: string
    limit?: number
  } = {}): Promise<BulkAutomationApproval[]> {
    const where: any = {}
    if (filters.status) where.status = filters.status
    if (filters.ruleId) where.ruleId = filters.ruleId
    return this.prisma.bulkAutomationApproval.findMany({
      where,
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(Math.max(filters.limit ?? 100, 1), 500),
    })
  }

  async get(id: string): Promise<BulkAutomationApproval | null> {
    return this.prisma.bulkAutomationApproval.findUnique({ where: { id } })
  }

  /**
   * Approve and resume the gated action plan. Walks every action
   * through ACTION_HANDLERS with dryRun=false (the operator already
   * gave consent) and stores the per-action results back on the row.
   */
  async approve(
    id: string,
    approvedBy: string | null,
  ): Promise<BulkAutomationApproval> {
    const row = await this.prisma.bulkAutomationApproval.findUnique({
      where: { id },
    })
    if (!row) throw new Error(`Approval not found: ${id}`)
    if (row.status !== 'PENDING') {
      throw new Error(`Approval is not PENDING (was ${row.status})`)
    }
    if (row.expiresAt < new Date()) {
      throw new Error('Approval has expired')
    }
    const plan = (row.actionPlan as Array<Record<string, unknown>>) ?? []
    const triggerPayload = row.triggerPayload as unknown
    const actionResults: Array<{
      type: string
      ok: boolean
      output?: unknown
      error?: string
    }> = []
    for (const action of plan) {
      const handler = ACTION_HANDLERS[action.type as string]
      if (!handler) {
        actionResults.push({
          type: String(action.type ?? '?'),
          ok: false,
          error: `Unknown action type: ${action.type}`,
        })
        continue
      }
      try {
        const r = await handler(action as never, triggerPayload, {
          dryRun: false,
          ruleId: row.ruleId,
        })
        actionResults.push({
          type: r.type,
          ok: r.ok,
          output: r.output,
          error: r.error,
        })
      } catch (err) {
        actionResults.push({
          type: String(action.type ?? '?'),
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
    return this.prisma.bulkAutomationApproval.update({
      where: { id },
      data: {
        status: 'APPROVED',
        approvedBy,
        approvedAt: new Date(),
        resolvedActionResults: actionResults as never,
      },
    })
  }

  async reject(
    id: string,
    rejectedBy: string | null,
    reason: string | null,
  ): Promise<BulkAutomationApproval> {
    const row = await this.prisma.bulkAutomationApproval.findUnique({
      where: { id },
    })
    if (!row) throw new Error(`Approval not found: ${id}`)
    if (row.status !== 'PENDING') {
      throw new Error(`Approval is not PENDING (was ${row.status})`)
    }
    return this.prisma.bulkAutomationApproval.update({
      where: { id },
      data: {
        status: 'REJECTED',
        rejectedBy,
        rejectedAt: new Date(),
        rejectedReason: reason,
      },
    })
  }

  /**
   * Auto-expire pending rows past their expiresAt. Called by the
   * approval-cleanup tick or on-demand via the queue UI's
   * "Sweep expired" button.
   */
  async expireStale(): Promise<{ expired: number }> {
    const r = await this.prisma.bulkAutomationApproval.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: new Date() } },
      data: { status: 'EXPIRED' },
    })
    if (r.count > 0) {
      logger.info(`[bulk-approval] auto-expired ${r.count} pending rows`)
    }
    return { expired: r.count }
  }
}
