/**
 * R.7 — PO approval workflow service.
 *
 * State machine:
 *   DRAFT ──► REVIEW ──► APPROVED ──► SUBMITTED ──► ACKNOWLEDGED
 *      │        │           │             │
 *      └─► CANCELLED ◄──────┴─────────────┘
 *
 * Forward-only. The only backward path is to CANCELLED, allowed
 * from DRAFT/REVIEW/APPROVED but NOT from SUBMITTED+ — once the
 * supplier has the PO, you don't "cancel" without contacting them.
 *
 * Auto-advance: when BrandSettings.requireApprovalForPo=false,
 * 'submit-for-review' collapses DRAFT → REVIEW → APPROVED in one
 * transaction. Audit timestamps captured for both transitions so
 * the trail stays symmetric.
 *
 * Existing PurchaseOrderStatus enum values that pre-date R.7
 * (CONFIRMED / PARTIAL / RECEIVED) are downstream of ACKNOWLEDGED
 * and out of scope for this state machine — the inbound flow drives
 * those (a PO becomes PARTIAL when its first inbound shipment lands).
 */

import prisma from '../db.js'
import type { PurchaseOrderStatus } from '@prisma/client'

export type WorkflowTransition =
  | 'submit-for-review'
  | 'approve'
  | 'send'
  | 'acknowledge'
  | 'cancel'

export type NextStatusResult =
  | { ok: true; next: PurchaseOrderStatus; autoAdvanced: PurchaseOrderStatus[] }
  | { ok: false; reason: string }

const TRANSITIONS_BY_CURRENT: Partial<
  Record<PurchaseOrderStatus, Partial<Record<WorkflowTransition, PurchaseOrderStatus>>>
> = {
  DRAFT: {
    'submit-for-review': 'REVIEW',
    cancel: 'CANCELLED',
  },
  REVIEW: {
    approve: 'APPROVED',
    cancel: 'CANCELLED',
  },
  APPROVED: {
    send: 'SUBMITTED',
    cancel: 'CANCELLED',
  },
  SUBMITTED: {
    acknowledge: 'ACKNOWLEDGED',
    // No cancel — once sent, must contact supplier (out of scope).
  },
  ACKNOWLEDGED: {
    // Terminal for this state machine. Receive flow takes over.
  },
  CONFIRMED: {
    // Legacy alias of ACKNOWLEDGED. No transitions out via R.7.
  },
}

/**
 * Pure function: given a current status + transition + config,
 * return the next legal status (or a reason for rejection).
 *
 * Auto-advance rule: when requireApproval=false, a successful
 * 'submit-for-review' collapses through REVIEW into APPROVED.
 * Caller persists timestamps for both intermediate states.
 */
export function nextStatus(args: {
  current: PurchaseOrderStatus
  transition: WorkflowTransition
  requireApproval: boolean
}): NextStatusResult {
  const allowed = TRANSITIONS_BY_CURRENT[args.current]
  const next = allowed?.[args.transition]
  if (!next) {
    return {
      ok: false,
      reason: `Transition '${args.transition}' not allowed from status '${args.current}'`,
    }
  }

  // Auto-advance: REVIEW collapses to APPROVED when no human gate.
  if (next === 'REVIEW' && !args.requireApproval) {
    return { ok: true, next: 'APPROVED', autoAdvanced: ['REVIEW'] }
  }

  return { ok: true, next, autoAdvanced: [] }
}

/**
 * Persist the transition. Captures audit timestamps + user ids
 * for the new status (and any auto-advanced intermediate states).
 * Idempotent: calling 'send' on an already-SUBMITTED PO returns
 * the current state without re-stamping timestamps.
 */
export async function transitionPo(args: {
  poId: string
  transition: WorkflowTransition
  userId?: string | null
  cancelReason?: string | null
}): Promise<{
  poId: string
  poNumber: string
  fromStatus: PurchaseOrderStatus
  toStatus: PurchaseOrderStatus
  autoAdvanced: PurchaseOrderStatus[]
}> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: args.poId },
    select: { id: true, poNumber: true, status: true },
  })
  if (!po) throw new Error(`PO not found: ${args.poId}`)

  // Idempotency: target-status-already-current short-circuits.
  const targetByTransition: Record<WorkflowTransition, PurchaseOrderStatus[]> = {
    'submit-for-review': ['REVIEW', 'APPROVED'], // either, depending on auto-advance
    approve: ['APPROVED'],
    send: ['SUBMITTED'],
    acknowledge: ['ACKNOWLEDGED'],
    cancel: ['CANCELLED'],
  }
  if (targetByTransition[args.transition].includes(po.status)) {
    return {
      poId: po.id,
      poNumber: po.poNumber,
      fromStatus: po.status,
      toStatus: po.status,
      autoAdvanced: [],
    }
  }

  const settings = await prisma.brandSettings.findFirst({
    select: { requireApprovalForPo: true },
  })
  const requireApproval = settings?.requireApprovalForPo ?? false

  const result = nextStatus({
    current: po.status,
    transition: args.transition,
    requireApproval,
  })
  if (result.ok === false) throw new Error(result.reason)

  const now = new Date()
  const data: any = { status: result.next }

  // Timestamp + user fields per transition. Auto-advanced
  // intermediate states get stamped too so the audit doesn't show
  // gaps between DRAFT and APPROVED.
  if (args.transition === 'submit-for-review') {
    data.reviewedAt = now
    data.reviewedByUserId = args.userId ?? null
    if (result.autoAdvanced.includes('REVIEW')) {
      // Auto-advanced through REVIEW → APPROVED; stamp APPROVED too.
      data.approvedAt = now
      data.approvedByUserId = args.userId ?? null
    }
  } else if (args.transition === 'approve') {
    data.approvedAt = now
    data.approvedByUserId = args.userId ?? null
  } else if (args.transition === 'send') {
    data.submittedAt = now
    data.submittedByUserId = args.userId ?? null
  } else if (args.transition === 'acknowledge') {
    data.acknowledgedAt = now
  } else if (args.transition === 'cancel') {
    data.cancelledAt = now
    data.cancelledReason = args.cancelReason ?? 'no reason given'
  }

  const updated = await prisma.purchaseOrder.update({
    where: { id: po.id },
    data,
    select: { id: true, poNumber: true, status: true },
  })

  return {
    poId: updated.id,
    poNumber: updated.poNumber,
    fromStatus: po.status,
    toStatus: updated.status,
    autoAdvanced: result.autoAdvanced,
  }
}

/**
 * Read-side helper: chronological list of transition timestamps for
 * a PO. Powers the audit endpoint.
 */
export async function getPoAuditTrail(poId: string): Promise<Array<{
  status: PurchaseOrderStatus
  at: Date
  userId: string | null
  reason?: string | null
}>> {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: poId },
    select: {
      createdAt: true,
      reviewedAt: true,
      reviewedByUserId: true,
      approvedAt: true,
      approvedByUserId: true,
      submittedAt: true,
      submittedByUserId: true,
      acknowledgedAt: true,
      cancelledAt: true,
      cancelledReason: true,
    },
  })
  if (!po) return []

  const trail: Array<{ status: PurchaseOrderStatus; at: Date; userId: string | null; reason?: string | null }> = []
  trail.push({ status: 'DRAFT', at: po.createdAt, userId: null })
  if (po.reviewedAt) trail.push({ status: 'REVIEW', at: po.reviewedAt, userId: po.reviewedByUserId ?? null })
  if (po.approvedAt) trail.push({ status: 'APPROVED', at: po.approvedAt, userId: po.approvedByUserId ?? null })
  if (po.submittedAt) trail.push({ status: 'SUBMITTED', at: po.submittedAt, userId: po.submittedByUserId ?? null })
  if (po.acknowledgedAt) trail.push({ status: 'ACKNOWLEDGED', at: po.acknowledgedAt, userId: null })
  if (po.cancelledAt) trail.push({ status: 'CANCELLED', at: po.cancelledAt, userId: null, reason: po.cancelledReason ?? null })
  trail.sort((a, b) => a.at.getTime() - b.at.getTime())
  return trail
}
