/**
 * HV.4 — the paired write's PLAN: what promoting a candidate and negating it at its source would do (GET
 * /advertising/harvest-promote). The write itself (POST /advertising/harvest-promote, promoteCandidates) was removed with the
 * Keyword Harvest page (2026-10-11): a harvest is one approval request through the harvest engine (services/advertising/harvest/).
 *
 * 🔴 **The first thing on this page that spends money.** Everything before it was a read.
 *
 * This composes; it does not fork. `applyHarvest` already implements destination routing (H.2), the
 * isolation negative (H.3), product targets (H.5) and per-match-type plans. A second harvest write
 * path is exactly the duplication this section exists to remove, so HV.4 extends that one
 * additively and calls it.
 *
 * ── What it is NOT ────────────────────────────────────────────────────────────────────────────
 *
 * It arms no automation. Harvest rules are capped at PROPOSE by `ads-graduation.ts`, which caps
 * *automations* because structural actions have no retirement path — **an operator pressing a
 * button is a different actor and is not what that ceiling governs.** (The rule-less nightly
 * cron this note used to cite was retired in HP5, 2026-08-21.)
 *
 * ── The three defects it must not reproduce ───────────────────────────────────────────────────
 *
 * ① **A graduation that reports success and never reaches Amazon.** 209 of the engine's 218
 *    graduations carry no Amazon id — 209 of the account's 210 local-only positive keywords.
 *    `createKeywordLocal` writes the local row and the audit row whether or not the push landed.
 *    Every outcome here reports `reachedAmazon` from `externalTargetId != null`, never from "we
 *    called create", and a partial success is never rendered as a success.
 *
 * ② **A bid that ignores the evidence.** Five constants exist across the rule path. The bid here is
 *    derived from the term's own observed CPC, computed ONCE, shown in the confirm dialog and
 *    written unchanged. `previewBid()` and the write share this function — the dialog cannot show
 *    one number and the write use another.
 *
 * ③ **A promotion that does not negate its source.** `applyHarvest` fires the isolation negative
 *    only when the destination differs from the source. HV.3 made that visible; HV.4 enforces it
 *    and reports which of the two happened, in the same words.
 */

import prisma from '../../db.js'
import { getKeywordHarvest, type HarvestRow } from './keyword-harvest.service.js'
import { checkAdsWriteGate } from './ads-write-gate.js'
import { checkLanding, switchOnBid } from './harvest-landing-guard.js'
import type { AdWriteEvidence } from './ads-evidence.js'

/** The floor `applyHarvest` already applies when a term has no clicks. Restated so the preview matches. */
const BID_FLOOR_EUR = 0.05

export interface PromotePlanRow {
  candidateId: string
  term: string
  market: string
  sourceAdGroupId: string | null
  sourceAdGroupName: string
  destinationAdGroupId: string | null
  destinationAdGroupName: string
  destinationCampaignName: string
  matchType: 'EXACT' | 'PHRASE' | 'BROAD'
  /** what the term earned: spend ÷ clicks */
  observedCpcCents: number | null
  /** what will actually be written, after the destination campaign's ceiling */
  bidCents: number
  clamped: null | { from: number; to: number; ceilingCents: number; campaignName: string }
  /** 🔴 does the destination differ from the source? decides the isolation negative */
  wouldNegateAtSource: boolean
  negateReason: string
  /** null when nothing refuses it */
  blocked: null | { deniedAt: string; reason: string; half: 'keyword' | 'negative' }
  promotable: boolean
  evidence: AdWriteEvidence
  reachCampaigns: string[]
}

export interface PromotePlan {
  rows: PromotePlanRow[]
  /** C5 — one denominator, everywhere */
  reach: { campaigns: number; ofTotal: number }
  promotable: number
  blocked: number
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`

/**
 * The bid, derived once.
 *
 * Observed CPC, floored at €0.05 (what `applyHarvest` already does), then clamped by the
 * DESTINATION campaign's ceiling — the destination decides the clamp, so the same term promoted
 * elsewhere gets a different bid. Measured ceilings: IT €0.80 · DE €1.90 · ES €0.90, and
 * `minBidCents` is unset on every campaign, so there is no floor but the code constant.
 */
export function deriveBid(args: { spendCents: number; clicks: number; ceilingCents: number | null; campaignName: string }) {
  const observed = args.clicks > 0 ? args.spendCents / args.clicks : null
  const base = Math.max(BID_FLOOR_EUR * 100, observed ?? 50)
  if (args.ceilingCents != null && base > args.ceilingCents) {
    return {
      observedCpcCents: observed,
      bidCents: Math.round(args.ceilingCents),
      clamped: { from: Math.round(base), to: Math.round(args.ceilingCents), ceilingCents: args.ceilingCents, campaignName: args.campaignName },
    }
  }
  return { observedCpcCents: observed, bidCents: Math.round(base), clamped: null }
}

/** The evidence sentence C9 requires, from the numbers the criteria actually used. */
function evidenceFor(row: HarvestRow, criteria: { minOrders: number; minClicks: number; maxAcosPct: number | null; windowDays: number }): AdWriteEvidence {
  const via = row.matchedVia.map((m) => m.matchType).join(', ')
  return {
    metric: 'searchTerm.orders',
    observed: row.metrics.orders,
    threshold: criteria.minOrders,
    windowDays: criteria.windowDays,
    note: `${row.metrics.orders} orders / ${row.metrics.clicks} clicks / ${row.metrics.acosPct == null ? 'no measurable' : `${row.metrics.acosPct.toFixed(0)}%`} ACoS over ${criteria.windowDays} days, against a threshold of ${criteria.minOrders} orders · ${criteria.minClicks} clicks${criteria.maxAcosPct != null ? ` · ACoS ≤ ${criteria.maxAcosPct}%` : ''}. Matched via ${via || 'no attributed match type'}.`,
  } as AdWriteEvidence
}

/**
 * Build the plan for a set of candidates — everything the confirm dialog states, computed
 * server-side so the sentence, the number written and the record afterwards cannot diverge.
 *
 * Nothing is written here.
 */
export async function planPromotion(args: {
  market: string
  candidateIds: string[]
  line?: string | null; portfolio?: string | null; campaign?: string | null; adGroup?: string | null
}): Promise<PromotePlan> {
  const page = await getKeywordHarvest({
    market: args.market, line: args.line ?? null, portfolio: args.portfolio ?? null,
    campaign: args.campaign ?? null, adGroup: args.adGroup ?? null,
  })
  const wanted = new Set(args.candidateIds)
  const rows = page.rows.filter((r) => wanted.has(r.id))

  const totalCampaigns = await prisma.campaign.count()
  const out: PromotePlanRow[] = []

  for (const r of rows) {
    const d = r.destination
    const chosen = d?.chosen ?? null
    // 🔴 HV.3 renders "no destination" as not-promotable; HV.4 enforces it. A row with an
    // undecided destination is NOT silently promoted into its source — that is the §4.1 defect.
    const promotableShape = !!chosen && !!r.adGroup.id
    const matchType = (r.kind === 'product' ? 'EXACT' : 'EXACT') as 'EXACT'

    const bid = deriveBid({
      spendCents: r.metrics.spendCents,
      clicks: r.metrics.clicks,
      ceilingCents: chosen?.maxBidCents ?? null,
      campaignName: chosen?.campaignName ?? '',
    })

    // Pre-flight BOTH halves. A refusal is not a failure (C7) and it must be visible before the
    // button, not after — D5, decided two sessions ago.
    let blocked: PromotePlanRow['blocked'] = null
    let wouldNegateAtSource = d?.wouldNegateAtSource ?? false
    let negateReason = d?.negateReason ?? 'No destination is resolved, so nothing would be written.'
    // Harvest fix B1 + B10 (harvest-landing-guard.ts) — the landing guard, as the write asks it: an archived keyword of the
    // term or a negative that blocks it in the destination refuses the row; a paused one is switched on again at the bid
    // shown (switchOnBid: the bid the write sends) and its source waits for Amazon's confirmation; a destination that does
    // not serve never negates the source.
    const cap = (w: string) => `${w[0].toUpperCase()}${w.slice(1)}`
    const landing = promotableShape ? await checkLanding({ adGroupId: chosen!.adGroupId, term: r.term, match: /^b0[a-z0-9]{8}$/i.test(r.term.trim()) ? 'PRODUCT' : 'EXACT' }) : null
    if (landing?.kind === 'hold') blocked = { deniedAt: landing.deniedAt, reason: landing.why, half: 'keyword' }
    else if (landing?.kind === 'enable') {
      // The write runs as the person's actor without his manual mark (applyHarvest), so the engine's step applies: as here.
      const sw = await switchOnBid({ targetId: landing.targetId, wantCents: bid.bidCents, who: { actor: 'automation:harvest' } })
      bid.bidCents = sw.cents
      bid.clamped = null
      wouldNegateAtSource = false
      negateReason = `${cap(landing.why)}${sw.held ? ` (its bid ${sw.held})` : ''} — harvest the term again once it is confirmed.`
    } else if (landing && !landing.serves) {
      wouldNegateAtSource = false
      negateReason = `${cap(landing.why)}.`
    } else if (landing?.kind === 'landed') negateReason = `${cap(landing.why)}: nothing is created${wouldNegateAtSource ? ', and the source is negated' : ''}.`
    if (promotableShape && !blocked) {
      const kw = await checkAdsWriteGate({ marketplace: r.market, payloadValueCents: bid.bidCents, campaignId: chosen!.campaignId, dimension: 'keywords' } as never) as { allowed: boolean; reason?: string; deniedAt?: string }
      if (!kw.allowed) blocked = { deniedAt: String(kw.deniedAt), reason: String(kw.reason), half: 'keyword' }
      else if (wouldNegateAtSource) {
        const neg = await checkAdsWriteGate({ marketplace: r.market, payloadValueCents: 0, campaignId: r.campaign.id ?? undefined, isNegation: true, keywordText: r.term, dimension: 'negatives' } as never) as { allowed: boolean; reason?: string; deniedAt?: string }
        if (!neg.allowed) blocked = { deniedAt: String(neg.deniedAt), reason: String(neg.reason), half: 'negative' }
      }
    }

    out.push({
      candidateId: r.id,
      term: r.term,
      market: r.market,
      sourceAdGroupId: r.adGroup.id,
      sourceAdGroupName: r.adGroup.name,
      destinationAdGroupId: chosen?.adGroupId ?? null,
      destinationAdGroupName: chosen?.adGroupName ?? '',
      destinationCampaignName: chosen?.campaignName ?? '',
      matchType,
      observedCpcCents: bid.observedCpcCents,
      bidCents: bid.bidCents,
      clamped: bid.clamped,
      wouldNegateAtSource,
      negateReason,
      blocked,
      // 🔴 A blocked NEGATIVE half blocks the whole pair. Promoting without the isolation negative
      // is the defect this session exists to close, so it is refused rather than half-done.
      promotable: promotableShape && !blocked,
      evidence: evidenceFor(r, { ...page.criteria.inForce }),
      reachCampaigns: [...new Set([r.campaign.name, chosen?.campaignName].filter((x): x is string => !!x))],
    })
  }

  const campaigns = new Set(out.flatMap((r) => r.reachCampaigns))
  return {
    rows: out,
    reach: { campaigns: campaigns.size, ofTotal: totalCampaigns },
    promotable: out.filter((r) => r.promotable).length,
    blocked: out.filter((r) => !r.promotable).length,
  }
}

export { eur }
