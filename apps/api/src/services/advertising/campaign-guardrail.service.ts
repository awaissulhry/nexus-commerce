/**
 * ADS AUTONOMY W3-2 — a campaign's own guardrails: its bid bounds, budget bounds and budget baseline (Campaign columns),
 * its largest bid change (`dynamicBidding.maxBidChangePct`) and its authority pins. Moved unchanged out of
 * `routes/advertising.routes.ts` (PATCH /advertising/campaigns/:id/guardrails and /pins) so Claude's set-ad-guardrail
 * (ads-guardrail-change.service.ts) runs the same code. The routes answer byte for byte as before
 * (campaign-guardrail-route-parity.vitest.test.ts). The CPC ceiling was already a service (campaign-settings.service.ts
 * setCpcCeiling).
 *
 * Nothing here reaches Amazon: the write gate and the mutation layer read these values at their next decision.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'

export interface CampaignGuardrailsInput {
  maxBidChangePct?: number | null; maxWritesPerDay?: number | null
  // ADX G2 — absolute bid bounds. Real COLUMNS, not dynamicBidding JSON, because
  // ads-write-gate.ts reads them on every write and a column cannot be missed by a
  // future engine that forgets to look in the blob. Complementary to the two above:
  // maxBidChangePct clamps how far one move may swing, cpcCeiling caps against the
  // target's HISTORICAL CPC (useless for a keyword with no history), and these cap
  // the absolute value. Extended onto this route rather than a new one — a second
  // Fastify registration of the same path is a boot crash.
  minBidCents?: number | null; maxBidCents?: number | null
  // BUD.2 — the budget twin: bounds enforced at the gate, and the baseline every RELATIVE
  // budget rule anchors to (which is what makes a −20% rule idempotent instead of a ratchet).
  minBudgetCents?: number | null; maxBudgetCents?: number | null; budgetBaselineCents?: number | null
}

export interface CampaignGuardrailsView {
  ok: true
  maxBidChangePct: unknown
  maxWritesPerDay: unknown
  minBidCents: number | null
  maxBidCents: number | null
  minBudgetCents: number | null
  maxBudgetCents: number | null
  budgetBaselineCents: number | null
}

/**
 * BUD.2 — budget bounds + baseline, as they would stand: a field not named keeps the campaign's value, null clears it.
 * Validated here, enforced at the gate. €1 is Amazon's own hard floor, so anything below 100 cents is a value the gate
 * could never honour. Pure (set-ad-guardrail's preview asks it too).
 */
export function campaignBudgetBounds(
  b: Pick<CampaignGuardrailsInput, 'minBudgetCents' | 'maxBudgetCents' | 'budgetBaselineCents'>,
  current: { minBudgetCents: number | null; maxBudgetCents: number | null; budgetBaselineCents: number | null },
): { data: { minBudgetCents: number | null; maxBudgetCents: number | null; budgetBaselineCents: number | null } } | { error: string } {
  const norm = (v: number | null | undefined, cur: number | null): number | null =>
    v === undefined ? cur : v == null ? null : Math.round(Number(v))
  const minB = norm(b.minBudgetCents, current.minBudgetCents)
  const maxB = norm(b.maxBudgetCents, current.maxBudgetCents)
  const base = norm(b.budgetBaselineCents, current.budgetBaselineCents)
  for (const [name, v] of [['minBudgetCents', minB], ['maxBudgetCents', maxB], ['budgetBaselineCents', base]] as const) {
    if (v != null && (!Number.isFinite(v) || v < 100)) return { error: `${name} must be ≥ 100 cents (Amazon's own floor is €1) or null` }
  }
  if (minB != null && maxB != null && minB > maxB) {
    return { error: `minBudgetCents (€${(minB / 100).toFixed(2)}) is above maxBudgetCents (€${(maxB / 100).toFixed(2)})` }
  }
  return { data: { minBudgetCents: minB, maxBudgetCents: maxB, budgetBaselineCents: base } }
}

/**
 * Apex A.2a: per-campaign bid guardrails (max-change-% + writes/day). Stored in dynamicBidding JSON alongside
 * cpcCeiling. maxBidChangePct clamps how far any single bid move (manual/bulk/automation) can swing from the current
 * bid. maxWritesPerDay is stored and read back but NOT enforced: the write gate disabled that daily cap on purpose
 * (ads-write-gate.ts, WC). Pass 0/null to clear a cap. `actor` names who did it in the audit rows.
 */
export async function setCampaignGuardrails(id: string, b: CampaignGuardrailsInput, actor: string): Promise<ServiceOutcome<CampaignGuardrailsView>> {
  const c = await prisma.campaign.findUnique({
    where: { id },
    select: {
      dynamicBidding: true, name: true, minBidCents: true, maxBidCents: true,
      minBudgetCents: true, maxBudgetCents: true, budgetBaselineCents: true,
    },
  })
  if (!c) return refused(404, { error: 'campaign not found' })
  const db = (c.dynamicBidding ?? {}) as Record<string, unknown>

  let budgetData: Record<string, number | null> = {}
  if (b.minBudgetCents !== undefined || b.maxBudgetCents !== undefined || b.budgetBaselineCents !== undefined) {
    const checked = campaignBudgetBounds(b, c)
    if ('error' in checked) return refused(400, { ok: false, error: checked.error })
    budgetData = checked.data
  }

  let boundsData: Record<string, number | null> = {}
  if (b.minBidCents !== undefined || b.maxBidCents !== undefined) {
    const { validateGuardrails } = await import('./ads-guardrails.js')
    const v = validateGuardrails(
      { minBidCents: b.minBidCents, maxBidCents: b.maxBidCents },
      [{ name: c.name, minBidCents: c.minBidCents, maxBidCents: c.maxBidCents }],
    )
    if (!v.ok) return refused(400, { ok: false, error: v.error })
    boundsData = v.data
  }
  if (b.maxBidChangePct !== undefined) {
    const pct = b.maxBidChangePct == null ? 0 : Math.max(0, Math.min(500, Number(b.maxBidChangePct)))
    if (pct > 0) db.maxBidChangePct = pct
    else delete db.maxBidChangePct
  }
  if (b.maxWritesPerDay !== undefined) {
    const n = b.maxWritesPerDay == null ? 0 : Math.max(0, Math.min(10000, Math.round(Number(b.maxWritesPerDay))))
    if (n > 0) db.maxWritesPerDay = n
    else delete db.maxWritesPerDay
  }
  // CM-6 — only the guardrail keys this request names go into `dynamicBidding` (set, or removed when cleared), merged
  // into the row as it is now: writing `db` whole put back a placement (or an automation / CPC ceiling edit) saved
  // since the read above.
  const guardKeys = (['maxBidChangePct', 'maxWritesPerDay'] as const).filter((k) => b[k] !== undefined)
  const { patchDynamicBidding } = await import('./dynamic-bidding-write.js')
  await patchDynamicBidding(id, {
    set: Object.fromEntries(guardKeys.filter((k) => k in db).map((k) => [k, db[k]])),
    remove: guardKeys.filter((k) => !(k in db)),
  }, { ...boundsData, ...budgetData })

  // BUD.2 — its own audit row, cents-keyed (this is OUR governance columns, distinct from
  // AD_BUDGET_UPDATE whose payloads are euros).
  if (Object.keys(budgetData).length > 0) {
    // CM-30 — these columns are the one store the Budget Manager reads too; its old per-month copies are dropped.
    const { forgetOldMonthLimits } = await import('./ads-budget-manager.service.js')
    await forgetOldMonthLimits(id).catch(() => 0)
    await prisma.advertisingActionLog.create({
      data: {
        userId: actor,
        actionType: 'set_campaign_budget_bounds', entityType: 'CAMPAIGN', entityId: id,
        payloadBefore: { minBudgetCents: c.minBudgetCents, maxBudgetCents: c.maxBudgetCents, budgetBaselineCents: c.budgetBaselineCents },
        payloadAfter: budgetData, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_guardrail', note: 'Budget bounds + baseline; bounds enforced at the write gate, the baseline anchors relative budget rules. Never pushed to Amazon.' },
      },
    }).catch(() => { /* an audit row must never fail the write it describes */ })
  }

  // ADX A2 — record WHY, using the evidence column that phase added. Bid bounds are
  // local governance: nothing is pushed to Amazon, which has no concept of them.
  if (Object.keys(boundsData).length > 0) {
    await prisma.advertisingActionLog.create({
      data: {
        userId: actor,
        actionType: 'set_campaign_bid_bounds', entityType: 'CAMPAIGN', entityId: id,
        payloadBefore: { minBidCents: c.minBidCents, maxBidCents: c.maxBidCents },
        payloadAfter: boundsData, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_guardrail', note: 'Absolute bid bounds; enforced at the write gate, never pushed to Amazon.' },
      },
    }).catch(() => { /* an audit row must never fail the write it describes */ })
  }
  return done({
    ok: true,
    maxBidChangePct: db.maxBidChangePct ?? null,
    maxWritesPerDay: db.maxWritesPerDay ?? null,
    minBidCents: boundsData.minBidCents !== undefined ? boundsData.minBidCents : c.minBidCents,
    maxBidCents: boundsData.maxBidCents !== undefined ? boundsData.maxBidCents : c.maxBidCents,
    minBudgetCents: budgetData.minBudgetCents !== undefined ? budgetData.minBudgetCents : c.minBudgetCents,
    maxBudgetCents: budgetData.maxBudgetCents !== undefined ? budgetData.maxBudgetCents : c.maxBudgetCents,
    budgetBaselineCents: budgetData.budgetBaselineCents !== undefined ? budgetData.budgetBaselineCents : c.budgetBaselineCents,
  })
}

export interface CampaignPinsInput {
  pinPlacement?: boolean; pinBids?: boolean; pinBudget?: boolean; pinNote?: string | null
}

export interface CampaignPinsView {
  ok: true
  campaignId: string
  pinPlacement: boolean
  pinBids: boolean
  pinBudget: boolean
  pinNote: string | null
  pinnedBy: string | null
  pinnedAt: Date | null
}

/**
 * ACR.1.2b — set or clear a campaign's per-dimension authority pins.
 *
 * A separate route from /guardrails on purpose: that one validates a min/max PAIR through
 * `validateGuardrails`, and pins have no such interdependence. Folding them in would put
 * two unrelated validation shapes behind one body.
 *
 * The write is audited with the same evidence column the bounds use — a pin an operator
 * finds later with no author is indistinguishable from a bug, which is why the columns
 * carry pinnedBy/pinnedAt at all.
 */
export async function setCampaignPins(id: string, b: CampaignPinsInput, actor: string): Promise<ServiceOutcome<CampaignPinsView>> {
  const c = await prisma.campaign.findUnique({
    where: { id },
    select: { id: true, name: true, pinPlacement: true, pinBids: true, pinBudget: true, pinNote: true },
  })
  if (!c) return refused(404, { error: 'campaign not found' })

  const data: Record<string, unknown> = {}
  if (b.pinPlacement !== undefined) data.pinPlacement = !!b.pinPlacement
  if (b.pinBids !== undefined) data.pinBids = !!b.pinBids
  if (b.pinBudget !== undefined) data.pinBudget = !!b.pinBudget
  if (b.pinNote !== undefined) data.pinNote = b.pinNote?.trim() ? b.pinNote.trim().slice(0, 280) : null
  if (Object.keys(data).length === 0) return refused(400, { ok: false, error: 'no pin fields supplied' })

  const nextPlacement = (data.pinPlacement as boolean | undefined) ?? c.pinPlacement
  const nextBids = (data.pinBids as boolean | undefined) ?? c.pinBids
  const nextBudget = (data.pinBudget as boolean | undefined) ?? c.pinBudget
  const anyPinned = nextPlacement || nextBids || nextBudget
  // Stamp the author only while something is actually pinned. Keeping a pinnedBy on a
  // fully-cleared campaign would leave the grid showing an owner for a pin that is gone.
  data.pinnedBy = anyPinned ? actor : null
  data.pinnedAt = anyPinned ? new Date() : null
  if (!anyPinned) data.pinNote = null

  await prisma.campaign.update({ where: { id }, data: data as never })

  await prisma.advertisingActionLog.create({
    data: {
      userId: actor,
      actionType: 'set_campaign_authority_pins', entityType: 'CAMPAIGN', entityId: id,
      payloadBefore: { pinPlacement: c.pinPlacement, pinBids: c.pinBids, pinBudget: c.pinBudget, pinNote: c.pinNote },
      payloadAfter: { pinPlacement: nextPlacement, pinBids: nextBids, pinBudget: nextBudget, pinNote: (data.pinNote as string | null) ?? null },
      amazonResponseStatus: 'SUCCESS',
      evidence: {
        metric: 'operator_authority_pin',
        note: 'Per-dimension hands-off pin; enforced at the write gate, never pushed to Amazon.',
      },
    },
  }).catch(() => { /* an audit row must never fail the write it describes */ })

  logger.warn('[ADS-AUTHORITY-PIN]', {
    campaignId: id, name: c.name, actor,
    pinPlacement: nextPlacement, pinBids: nextBids, pinBudget: nextBudget,
  })

  return done({
    ok: true, campaignId: id,
    pinPlacement: nextPlacement, pinBids: nextBids, pinBudget: nextBudget,
    pinNote: (data.pinNote as string | null) ?? null,
    pinnedBy: data.pinnedBy as string | null, pinnedAt: data.pinnedAt as Date | null,
  })
}
