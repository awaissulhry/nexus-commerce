// PH.6 — campaign settings, out of the HTTP layer.
//
// Four write endpoints and one read that lived as inline Fastify handlers.
// Each carried real domain logic — a whitelist, two clamps, an audited
// default-deny toggle — and none of it was reachable by a test, because
// reaching it meant standing up an HTTP request.
//
// Behaviour is preserved exactly, including status codes and response shapes.
// The handlers keep deciding the HTTP status; the service decides what is
// valid. That split is what makes this testable without inventing a fake
// request object.

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

/**
 * Success, or a refusal the handler turns into a status code.
 *
 * Deliberately NOT a discriminated union: apps/api's tsconfig is not strict, so
 * `if (!r.ok)` does not narrow and every consumer would need a cast. An
 * optional-field shape needs no narrowing to be used correctly.
 */
export interface SettingsResult<T> {
  value?: T
  status?: 400 | 404
  error?: string
}

const NOT_FOUND: SettingsResult<never> = { status: 404, error: 'campaign not found' }

/**
 * C1 — the Adtomic bid-algorithm picker's store. WHITELISTED rather than free
 * text: it feeds a three-option control, and an unknown value renders as a
 * blank cell rather than an error anyone would notice.
 */
export const BID_ALGORITHMS = ['TARGET_ACOS', 'MAX_IMPRESSIONS', 'MAX_ORDERS'] as const

export interface AutomationPatch {
  bidAutomation?: boolean
  targetAcos?: number | null
  bidAlgorithm?: string | null
}

/**
 * PURE. Apply an automation patch to a campaign's dynamicBidding blob.
 *
 * `undefined` means "not supplied, leave alone"; explicit `null` means "clear".
 * Those are different intents arriving through the same JSON field, and
 * collapsing them would make it impossible to unset a value.
 */
export function applyAutomationPatch(
  current: Record<string, unknown>,
  patch: AutomationPatch,
): SettingsResult<Record<string, unknown>> {
  const next = { ...current }

  if (patch.bidAutomation !== undefined) next.bidAutomation = !!patch.bidAutomation

  if (patch.bidAlgorithm !== undefined) {
    if (patch.bidAlgorithm == null) delete next.bidAlgorithm
    else if ((BID_ALGORITHMS as readonly string[]).includes(patch.bidAlgorithm)) {
      next.bidAlgorithm = patch.bidAlgorithm
    } else {
      return { status: 400, error: `bidAlgorithm must be one of ${BID_ALGORITHMS.join(', ')}` }
    }
  }

  if (patch.targetAcos !== undefined) {
    if (patch.targetAcos == null) delete next.targetAcos
    // A fraction, clamped 0–5 (i.e. 0–500% ACoS).
    else next.targetAcos = Math.max(0, Math.min(5, Number(patch.targetAcos)))
  }

  return { value: next }
}

export interface AutomationView {
  ok: true
  bidAutomation: boolean
  targetAcos: number | null
  bidAlgorithm: string | null
}

export async function setBidAutomation(
  campaignId: string,
  patch: AutomationPatch,
): Promise<SettingsResult<AutomationView>> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { dynamicBidding: true },
  })
  if (!campaign) return NOT_FOUND

  const applied = applyAutomationPatch((campaign.dynamicBidding ?? {}) as Record<string, unknown>, patch)
  if (applied.error) return { status: applied.status, error: applied.error }

  const next = applied.value as Record<string, unknown>
  await prisma.campaign.update({ where: { id: campaignId }, data: { dynamicBidding: next as never } })
  return {
    value: {
      ok: true,
      bidAutomation: (next.bidAutomation as boolean) ?? false,
      targetAcos: (next.targetAcos as number) ?? null,
      bidAlgorithm: (next.bidAlgorithm as string) ?? null,
    },
  }
}

/** PURE. The CPC ceiling multiple, clamped 1–10; 1.5 when unspecified. */
export function clampCpcMultiple(value: unknown): number {
  return value != null ? Math.max(1, Math.min(10, Number(value))) : 1.5
}

export async function setCpcCeiling(
  campaignId: string,
  patch: { enabled?: boolean; multiple?: number },
): Promise<SettingsResult<{ ok: true; cpcCeiling: { enabled: boolean; multiple: number } }>> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { dynamicBidding: true },
  })
  if (!campaign) return NOT_FOUND

  const next = { ...((campaign.dynamicBidding ?? {}) as Record<string, unknown>) }
  const cpcCeiling = { enabled: !!patch.enabled, multiple: clampCpcMultiple(patch.multiple) }
  next.cpcCeiling = cpcCeiling
  await prisma.campaign.update({ where: { id: campaignId }, data: { dynamicBidding: next as never } })
  return { value: { ok: true, cpcCeiling } }
}

/**
 * Apex A.2a — per-campaign live-write allowlist. DEFAULT-DENY: even with the
 * deploy flag and connection writes enabled, the write-gate refuses live
 * mutations to a campaign until this is on. Every flip is logged at warn,
 * because turning it on is the moment real money becomes reachable.
 */
export async function setLiveWrites(
  campaignId: string,
  enabled: boolean,
  actor: string | undefined,
): Promise<SettingsResult<{ ok: true; campaignId: string; liveBidWritesEnabled: boolean }>> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true },
  })
  if (!campaign) return NOT_FOUND

  await prisma.campaign.update({ where: { id: campaignId }, data: { liveBidWritesEnabled: enabled } })
  logger.warn('[ADS-LIVE-ALLOWLIST]', { campaignId, name: campaign.name, enabled, actor })
  return { value: { ok: true, campaignId, liveBidWritesEnabled: enabled } }
}

/**
 * MM.2 — the same allowlist for a whole marketplace or an explicit set, so an
 * operator taking a market live does not flip dozens of campaigns one by one.
 * Flips the per-campaign allowlist ONLY; the connection gate still
 * independently governs whether anything reaches Amazon.
 */
export async function setLiveWritesBulk(
  input: { marketplace?: string; campaignIds?: string[]; enabled: boolean },
  actor: string | undefined,
): Promise<SettingsResult<{ ok: true; count: number; enabled: boolean }>> {
  const hasIds = Boolean(input.campaignIds?.length)
  if (!input.marketplace && !hasIds) {
    return { status: 400, error: 'marketplace or campaignIds required' }
  }
  const where = hasIds ? { id: { in: input.campaignIds as string[] } } : { marketplace: input.marketplace }
  const result = await prisma.campaign.updateMany({ where, data: { liveBidWritesEnabled: input.enabled } })
  logger.warn('[ADS-LIVE-ALLOWLIST-BULK]', {
    marketplace: input.marketplace,
    campaignIds: input.campaignIds?.length,
    enabled: input.enabled,
    count: result.count,
    actor,
  })
  return { value: { ok: true, count: result.count, enabled: input.enabled } }
}

// ── self-competition (RC2.R8) ───────────────────────────────────────────────

export interface SelfCompetitionConflict {
  campaignId: string
  name: string
  status: string
  asins: string[]
}

/** PURE. Group other campaigns' ads by campaign, most-overlapping first. */
export function groupSelfCompetition(
  rows: Array<{ asin: string | null; adGroup: { campaign: { id: string; name: string; status: string } | null } | null }>,
): SelfCompetitionConflict[] {
  const byCampaign = new Map<string, { campaignId: string; name: string; status: string; asins: Set<string> }>()
  for (const row of rows) {
    const campaign = row.adGroup?.campaign
    if (!campaign || !row.asin) continue
    let group = byCampaign.get(campaign.id)
    if (!group) {
      group = { campaignId: campaign.id, name: campaign.name, status: campaign.status, asins: new Set() }
      byCampaign.set(campaign.id, group)
    }
    group.asins.add(row.asin)
  }
  return [...byCampaign.values()]
    .map((g) => ({ campaignId: g.campaignId, name: g.name, status: g.status, asins: [...g.asins] }))
    .sort((a, b) => b.asins.length - a.asins.length)
}

/**
 * Other campaigns in the SAME marketplace advertising the SAME ASIN. They
 * compete in one auction — only the highest-eligible bid serves — so this
 * flags accidental cannibalisation. Read-only.
 */
export async function getSelfCompetition(
  campaignId: string,
): Promise<SettingsResult<{ marketplace: string | null; asins: string[]; conflicts: SelfCompetitionConflict[] }>> {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { marketplace: true },
  })
  if (!campaign) return NOT_FOUND

  const mine = await prisma.adProductAd.findMany({
    where: { adGroup: { campaignId }, asin: { not: null } },
    select: { asin: true },
  })
  const asins = [...new Set(mine.map((a) => a.asin).filter((x): x is string => !!x))]
  if (asins.length === 0) {
    return { value: { marketplace: campaign.marketplace, asins: [], conflicts: [] } }
  }

  const others = await prisma.adProductAd.findMany({
    where: {
      asin: { in: asins },
      adGroup: { campaign: { marketplace: campaign.marketplace, id: { not: campaignId }, status: 'ENABLED' } },
    },
    select: { asin: true, adGroup: { select: { campaign: { select: { id: true, name: true, status: true } } } } },
  })

  return { value: { marketplace: campaign.marketplace, asins, conflicts: groupSelfCompetition(others) } }
}
