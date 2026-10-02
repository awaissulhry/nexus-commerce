/**
 * R14 (MCP full control, part 06) — an eBay campaign's automation policy (posture, protected, rate and bid bounds), moved
 * unchanged out of `PUT /ebay-ads/campaigns/:id/automation-policy` (ebay-ads.routes.ts) so tune-ad-engine writes through
 * the same validation and audit row. Local governance: no eBay call. The route answers byte for byte as before
 * (automation-tune-route-parity.vitest.test.ts).
 */
import prisma from '../../db.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export const EBAY_POSTURES = ['INHERIT', 'OFF', 'SUGGEST', 'AUTO'] as const

export interface EbayCampaignPolicyInput {
  posture?: string
  protected?: boolean
  rateCapPct?: number | null
  rateFloorPct?: number | null
  bidCapCents?: number | null
  bidFloorCents?: number | null
}

export interface EbayCampaignPolicyView {
  posture: string
  protected: boolean
  rateCapPct: number | null
  rateFloorPct: number | null
  bidCapCents: number | null
  bidFloorCents: number | null
}

export async function setEbayCampaignPolicy(campaignId: string, b: EbayCampaignPolicyInput, actorUserId: string | null): Promise<ServiceOutcome<{ ok: true; policy: EbayCampaignPolicyView }>> {
  const c = await prisma.ebayCampaign.findUnique({ where: { id: campaignId }, include: { automationPolicy: true } })
  if (!c) return refused(404, { error: 'campaign not found' })
  if (b.posture != null && !(EBAY_POSTURES as readonly string[]).includes(b.posture)) return refused(400, { error: 'posture must be INHERIT | OFF | SUGGEST | AUTO' })
  for (const k of ['rateCapPct', 'rateFloorPct'] as const) {
    const v = b[k]
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) return refused(400, { error: `${k} must be 0–100` })
  }
  if (b.rateCapPct != null && b.rateFloorPct != null && b.rateFloorPct > b.rateCapPct) return refused(400, { error: 'rate floor cannot exceed rate cap' })
  const data = {
    ...(b.posture != null ? { posture: b.posture } : {}),
    ...(b.protected != null ? { protected: b.protected } : {}),
    ...(b.rateCapPct !== undefined ? { rateCapPct: b.rateCapPct } : {}),
    ...(b.rateFloorPct !== undefined ? { rateFloorPct: b.rateFloorPct } : {}),
    ...(b.bidCapCents !== undefined ? { bidCapCents: b.bidCapCents } : {}),
    ...(b.bidFloorCents !== undefined ? { bidFloorCents: b.bidFloorCents } : {}),
    updatedBy: actorUserId,
  }
  const before = c.automationPolicy
  const saved = await prisma.ebayCampaignAutomationPolicy.upsert({ where: { campaignId: c.id }, create: { campaignId: c.id, ...data }, update: data })
  await prisma.campaignAction.create({
    data: {
      userId: actorUserId, channel: 'EBAY', actionType: 'set_automation_policy', entityType: 'CAMPAIGN', entityId: c.externalCampaignId,
      payloadBefore: (before ? { posture: before.posture, protected: before.protected } : {}) as object,
      payloadAfter: { posture: saved.posture, protected: saved.protected, rateCapPct: saved.rateCapPct?.toString() ?? null, rateFloorPct: saved.rateFloorPct?.toString() ?? null, _mode: 'local' } as object,
      channelResponseStatus: 'SUCCESS',
    },
  }).catch(() => {})
  return done({ ok: true as const, policy: policyView(saved) })
}

/** A policy row as the route answers it (Decimals as numbers). No row = the defaults (INHERIT, nothing set). */
export function policyView(row: { posture: string; protected: boolean; rateCapPct: { toString(): string } | null; rateFloorPct: { toString(): string } | null; bidCapCents: number | null; bidFloorCents: number | null } | null): EbayCampaignPolicyView {
  if (!row) return { posture: 'INHERIT', protected: false, rateCapPct: null, rateFloorPct: null, bidCapCents: null, bidFloorCents: null }
  return { posture: row.posture, protected: row.protected, rateCapPct: row.rateCapPct != null ? Number(row.rateCapPct.toString()) : null, rateFloorPct: row.rateFloorPct != null ? Number(row.rateFloorPct.toString()) : null, bidCapCents: row.bidCapCents, bidFloorCents: row.bidFloorCents }
}
