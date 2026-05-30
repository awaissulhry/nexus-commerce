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

// RX.8 — the auto-approve decision as a pure, exhaustively-tested
// function. Single source of truth for eligibility so the gate ordering
// (FBA → policy → delivery → window → high-value) can't silently drift.
export type AutoApproveDecision =
  | 'eligible'
  | 'skip-fba'
  | 'skip-policy-manual'
  | 'skip-no-delivery'
  | 'skip-out-of-window'
  | 'skip-high-value'

export function classifyAutoApprove(input: {
  isFbaReturn: boolean
  policyAutoApprove: boolean
  hasDeliveryDate: boolean
  inWindow: boolean
  refundCents: number | null
  highValueThresholdCents: number | null
}): AutoApproveDecision {
  if (input.isFbaReturn) return 'skip-fba'
  if (!input.policyAutoApprove) return 'skip-policy-manual'
  if (!input.hasDeliveryDate) return 'skip-no-delivery'
  if (!input.inWindow) return 'skip-out-of-window'
  if (input.highValueThresholdCents != null && (input.refundCents ?? 0) >= input.highValueThresholdCents) {
    return 'skip-high-value'
  }
  return 'eligible'
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
    // Resolve cheaply first; only pay for the window check once the
    // FBA / policy / delivery gates have passed.
    const policy = r.isFbaReturn
      ? null
      : await resolveReturnPolicy({ channel: r.channel, marketplace: r.marketplace })
    const delivered = r.order?.deliveredAt ?? r.order?.purchaseDate ?? null
    const win = !r.isFbaReturn && policy?.autoApprove && delivered
      ? await checkReturnWindow({ channel: r.channel, marketplace: r.marketplace, deliveredAt: delivered })
      : null

    const decision = classifyAutoApprove({
      isFbaReturn: r.isFbaReturn,
      policyAutoApprove: !!policy?.autoApprove,
      hasDeliveryDate: !!delivered,
      inWindow: !!win?.inWindow,
      refundCents: r.refundCents,
      highValueThresholdCents: policy?.highValueThresholdCents ?? null,
    })

    if (decision === 'skip-fba') { skipped.fba++; continue }
    if (decision === 'skip-policy-manual') { skipped.policyManual++; continue }
    if (decision === 'skip-no-delivery') { skipped.noDeliveryDate++; continue }
    if (decision === 'skip-out-of-window') { skipped.outOfWindow++; continue }
    if (decision === 'skip-high-value') { skipped.highValue++; continue }

    // decision === 'eligible' — policy is guaranteed non-null here.
    autoApprove.push({
      id: r.id,
      rmaNumber: r.rmaNumber,
      channel: r.channel,
      marketplace: r.marketplace,
      refundCents: r.refundCents,
      daysSinceDelivery: win?.daysSinceDelivery ?? null,
      windowDays: policy!.windowDays,
      reason: `policy auto-approve · ${win?.daysSinceDelivery ?? 0}d of ${policy!.windowDays}d window`,
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
