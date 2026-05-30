/**
 * RX.4 — Returns automation engine (guardrailed).
 *
 * Builds on the existing ReturnPolicy.autoApprove flag rather than a
 * new rule schema: a return is auto-approvable when its resolved policy
 * opts in AND it's inside the return window AND it's under the policy's
 * high-value threshold. FBA returns are excluded (Amazon manages them).
 *
 * The engine is preview-first ("diff-then-apply"): previewReturnAutomation
 * computes what WOULD happen without touching anything; the route layer
 * applies only the IDs an operator confirms. Per the locked scope,
 * refunds are never auto-issued — auto-approve advances REQUESTED →
 * AUTHORIZED only. Returnless ("keep it") candidates are surfaced as
 * suggestions, never auto-refunded.
 */

import prisma from '../db.js'
import { resolveReturnPolicy, checkReturnWindow } from './return-policies/resolver.service.js'

export interface AutoApproveCandidate {
  id: string
  rmaNumber: string | null
  channel: string
  marketplace: string | null
  refundCents: number | null
  daysSinceDelivery: number | null
  windowDays: number
  reason: string
}

export interface ReturnlessCandidate {
  id: string
  rmaNumber: string | null
  channel: string
  refundCents: number | null
  reason: string
}

export interface AutomationPreview {
  autoApprove: AutoApproveCandidate[]
  returnless: ReturnlessCandidate[]
  skipped: { highValue: number; outOfWindow: number; policyManual: number; fba: number; noDeliveryDate: number }
  returnlessMaxCents: number
  generatedAt: string
}

export async function previewReturnAutomation(): Promise<AutomationPreview> {
  const RETURNLESS_MAX = Math.max(0, Number(process.env.NEXUS_RETURNS_RETURNLESS_MAX_CENTS) || 1500)

  const requested = await prisma.return.findMany({
    where: { status: 'REQUESTED' },
    select: {
      id: true, rmaNumber: true, channel: true, marketplace: true,
      refundCents: true, isFbaReturn: true,
      order: { select: { deliveredAt: true, purchaseDate: true } },
    },
    take: 1000,
    orderBy: { createdAt: 'asc' },
  })

  const autoApprove: AutoApproveCandidate[] = []
  const returnless: ReturnlessCandidate[] = []
  const skipped = { highValue: 0, outOfWindow: 0, policyManual: 0, fba: 0, noDeliveryDate: 0 }

  for (const r of requested) {
    // Amazon owns FBA returns end-to-end; never auto-action them.
    if (r.isFbaReturn) { skipped.fba++; continue }

    const policy = await resolveReturnPolicy({ channel: r.channel, marketplace: r.marketplace })
    if (!policy.autoApprove) { skipped.policyManual++; continue }

    const delivered = r.order?.deliveredAt ?? r.order?.purchaseDate ?? null
    if (!delivered) { skipped.noDeliveryDate++; continue }

    const win = await checkReturnWindow({
      channel: r.channel,
      marketplace: r.marketplace,
      deliveredAt: delivered,
    })
    if (!win.inWindow) { skipped.outOfWindow++; continue }

    // High-value gate: a policy can require a human eye above a euro
    // threshold even when auto-approve is on.
    if (policy.highValueThresholdCents != null && (r.refundCents ?? 0) >= policy.highValueThresholdCents) {
      skipped.highValue++
      continue
    }

    autoApprove.push({
      id: r.id,
      rmaNumber: r.rmaNumber,
      channel: r.channel,
      marketplace: r.marketplace,
      refundCents: r.refundCents,
      daysSinceDelivery: win.daysSinceDelivery ?? null,
      windowDays: policy.windowDays,
      reason: `policy auto-approve · ${win.daysSinceDelivery ?? 0}d of ${policy.windowDays}d window`,
    })

    // Returnless suggestion is independent of approval — flag low-value
    // returns where the return-leg cost likely exceeds recovery.
    if (r.refundCents != null && r.refundCents > 0 && r.refundCents <= RETURNLESS_MAX) {
      returnless.push({
        id: r.id,
        rmaNumber: r.rmaNumber,
        channel: r.channel,
        refundCents: r.refundCents,
        reason: `low value (≤ €${(RETURNLESS_MAX / 100).toFixed(0)}) — return shipping may exceed recovery`,
      })
    }
  }

  return {
    autoApprove,
    returnless,
    skipped,
    returnlessMaxCents: RETURNLESS_MAX,
    generatedAt: new Date().toISOString(),
  }
}
