/**
 * ACR Stage 5 — reconcile local SB keyword rows against Amazon.
 *
 * Found 2026-08-05 the moment SB keywords became readable: our DB holds all 88 as `ARCHIVED` at
 * a flat 50c, while Amazon serves 70 of them ENABLED at real bids between €0.68 and €2.05.
 * Cause is the same family as the SD/SB campaign mis-archive — SP-only reconciliation writing
 * over entities it could never see.
 *
 * **Direction of truth is one-way and deliberate: Amazon → local.**
 *
 * This NEVER writes to Amazon. Our rows are the stale side, so pushing them would overwrite live
 * bids with a 50c placeholder and archive keywords that are currently serving — the single worst
 * outcome available here, and precisely what a naive "sync" would do. The AX-VT.1 portfolio
 * repair set the precedent for the shape (read-diff, classify, apply only on demand); this
 * inverts its direction because there the local value was the good one and here it is not.
 *
 * Read-only unless `apply` is set, and it reports what it WOULD do either way.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { listSbKeywords, listSdAdGroups, listSdTargets, type AdsRegion } from './ads-api-client.js'

export type SbKeywordVerdict =
  /** Local matches Amazon on state and bid. Nothing to do. */
  | 'AGREED'
  /** Amazon and local disagree on state and/or bid. Amazon wins. */
  | 'DRIFT'
  /** We hold an external id Amazon does not return — investigate, never guess. */
  | 'NOT_ON_AMAZON'
  /** Amazon has a keyword we hold no row for at all. */
  | 'MISSING_LOCALLY'
  /** Local row was never pushed (no external id). Not this tool's problem to fix. */
  | 'NOT_PUSHED'

export interface SbKeywordRow {
  verdict: SbKeywordVerdict
  marketplace: string
  keywordText: string
  externalTargetId: string | null
  localState: string | null
  amazonState: string | null
  localBidEur: number | null
  amazonBidEur: number | null
}

export interface SbKeywordReconcileResult {
  applied: boolean
  checked: number
  counts: Record<SbKeywordVerdict, number>
  /** Rows that would change (or did). Capped for readability; `counts` is the full tally. */
  rows: SbKeywordRow[]
  updated: number
  errors: string[]
}

const STATE_TO_LOCAL: Record<string, string> = { enabled: 'ENABLED', paused: 'PAUSED', archived: 'ARCHIVED' }

/**
 * ACR Stage 5 — the SD half of the same repair.
 *
 * `archiveMissingTargets` fed from `/sp/targets/list` wiped SD product/auto targets for exactly
 * the same reason it wiped SB keywords. The footprint proves the mechanism: 236 PRODUCT and 9
 * AUTO targets archived — precisely the kinds inside that caller's `{PRODUCT, AUTO, CATEGORY}`
 * scope — while AUDIENCE-family targets, which fall outside it, were untouched.
 *
 * **The bid drift here is the dangerous half.** Amazon holds €0.02 on SD ad groups: that is not
 * noise, it is this account's deliberate suppression doctrine (no-pause, hold bids at ~2c). Our
 * rows say €0.50 — 25× higher. Any path that pushed local bids to Amazon would silently undo the
 * suppression. Reconciling Amazon → local removes that risk; it never writes to Amazon.
 */
export interface SdReconcileResult {
  applied: boolean
  targets: { checked: number; drift: number; updated: number }
  adGroups: { checked: number; drift: number; updated: number }
  samples: string[]
  errors: string[]
}

export async function reconcileSdEntities(opts: { apply?: boolean } = {}): Promise<SdReconcileResult> {
  const res: SdReconcileResult = {
    applied: !!opts.apply,
    targets: { checked: 0, drift: 0, updated: 0 },
    adGroups: { checked: 0, drift: 0, updated: 0 },
    samples: [], errors: [],
  }

  const markets = (await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_DISPLAY' }, select: { marketplace: true }, distinct: ['marketplace'],
  })).map((m) => m.marketplace)

  for (const marketplace of markets) {
    const conn = await prisma.amazonAdsConnection.findFirst({
      where: { marketplace, isActive: true }, select: { profileId: true, region: true },
    })
    if (!conn) { res.errors.push(`no active connection for ${marketplace}`); continue }
    const ctx = { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' }

    const extIds = (await prisma.campaign.findMany({
      where: { adProduct: 'SPONSORED_DISPLAY', marketplace }, select: { externalCampaignId: true },
    })).map((c) => c.externalCampaignId).filter((x): x is string => !!x)
    if (!extIds.length) continue

    // ── Ad groups ────────────────────────────────────────────────────────────────────────────
    try {
      const remoteAgs = await listSdAdGroups(ctx, { externalCampaignIds: extIds })
      for (const a of remoteAgs) {
        if (!a.adGroupId) continue
        const local = await prisma.adGroup.findFirst({
          where: { externalAdGroupId: String(a.adGroupId) },
          select: { id: true, name: true, status: true, defaultBidCents: true },
        })
        if (!local) continue
        res.adGroups.checked += 1
        const wantStatus = a.state ? STATE_TO_LOCAL[String(a.state).toLowerCase()] : undefined
        const wantBid = a.defaultBid == null ? null : Math.round(a.defaultBid * 100)
        const stateDiffers = !!wantStatus && wantStatus !== local.status
        const bidDiffers = wantBid != null && wantBid !== local.defaultBidCents
        if (!stateDiffers && !bidDiffers) continue
        res.adGroups.drift += 1
        if (res.samples.length < 8) res.samples.push(`AD_GROUP ${marketplace} "${local.name}" local=${local.status}@€${(local.defaultBidCents / 100).toFixed(2)} amazon=${a.state}@€${(wantBid ?? 0) / 100}`)
        if (opts.apply) {
          await prisma.adGroup.update({
            where: { id: local.id },
            data: { ...(stateDiffers ? { status: wantStatus as never } : {}), ...(bidDiffers && wantBid != null ? { defaultBidCents: wantBid } : {}) },
          })
          res.adGroups.updated += 1
        }
      }
    } catch (e) { res.errors.push(`adGroups ${marketplace}: ${(e as Error).message.slice(0, 140)}`) }

    // ── Targets ──────────────────────────────────────────────────────────────────────────────
    try {
      const remoteTargets = await listSdTargets(ctx, { externalCampaignIds: extIds })
      for (const t of remoteTargets) {
        if (!t.targetId) continue
        const local = await prisma.adTarget.findFirst({
          where: { externalTargetId: String(t.targetId) },
          select: { id: true, expressionValue: true, status: true, bidCents: true },
        })
        if (!local) continue
        res.targets.checked += 1
        const wantStatus = t.state ? STATE_TO_LOCAL[String(t.state).toLowerCase()] : undefined
        const wantBid = t.bid == null ? null : Math.round(t.bid * 100)
        const stateDiffers = !!wantStatus && wantStatus !== local.status
        const bidDiffers = wantBid != null && wantBid !== local.bidCents
        if (!stateDiffers && !bidDiffers) continue
        res.targets.drift += 1
        if (res.samples.length < 8) res.samples.push(`TARGET ${marketplace} "${local.expressionValue}" local=${local.status}@€${(local.bidCents / 100).toFixed(2)} amazon=${t.state}@€${(wantBid ?? 0) / 100}`)
        if (opts.apply) {
          await prisma.adTarget.update({
            where: { id: local.id },
            data: { ...(stateDiffers ? { status: wantStatus as never } : {}), ...(bidDiffers && wantBid != null ? { bidCents: wantBid } : {}) },
          })
          res.targets.updated += 1
        }
      }
    } catch (e) { res.errors.push(`targets ${marketplace}: ${(e as Error).message.slice(0, 140)}`) }
  }

  logger.info('[ACR.5] reconcileSdEntities', { apply: !!opts.apply, ...res.targets, errors: res.errors.length })
  return res
}

export async function reconcileSbKeywords(opts: { apply?: boolean; marketplaces?: string[] } = {}): Promise<SbKeywordReconcileResult> {
  const counts: Record<SbKeywordVerdict, number> = { AGREED: 0, DRIFT: 0, NOT_ON_AMAZON: 0, MISSING_LOCALLY: 0, NOT_PUSHED: 0 }
  const rows: SbKeywordRow[] = []
  const errors: string[] = []
  let checked = 0
  let updated = 0

  const markets = opts.marketplaces ?? (await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_BRANDS' }, select: { marketplace: true }, distinct: ['marketplace'],
  })).map((m) => m.marketplace)

  for (const marketplace of markets) {
    const conn = await prisma.amazonAdsConnection.findFirst({
      where: { marketplace, isActive: true }, select: { profileId: true, region: true },
    })
    if (!conn) { errors.push(`no active connection for ${marketplace}`); continue }
    const ctx = { profileId: conn.profileId, region: (conn.region as AdsRegion) ?? 'EU' }

    const campaigns = await prisma.campaign.findMany({
      where: { adProduct: 'SPONSORED_BRANDS', marketplace },
      select: { id: true, externalCampaignId: true },
    })
    const extIds = campaigns.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
    if (!extIds.length) continue

    let remote: Awaited<ReturnType<typeof listSbKeywords>>
    try { remote = await listSbKeywords(ctx, { externalCampaignIds: extIds }) }
    catch (e) { errors.push(`read ${marketplace}: ${(e as Error).message.slice(0, 140)}`); continue }

    const locals = await prisma.adTarget.findMany({
      where: {
        kind: 'KEYWORD', isNegative: false,
        adGroup: { campaign: { adProduct: 'SPONSORED_BRANDS', marketplace } },
      },
      select: { id: true, externalTargetId: true, expressionValue: true, status: true, bidCents: true },
    })

    const byExtId = new Map(locals.filter((l) => l.externalTargetId).map((l) => [l.externalTargetId!, l]))
    const seen = new Set<string>()

    for (const k of remote) {
      const extId = k.keywordId == null ? null : String(k.keywordId)
      if (!extId) continue
      checked += 1
      seen.add(extId)
      const local = byExtId.get(extId)
      const amazonState = (k.state ?? '').toLowerCase()
      const wantStatus = STATE_TO_LOCAL[amazonState]
      const amazonBidEur = k.bid ?? null
      const wantBidCents = amazonBidEur == null ? null : Math.round(amazonBidEur * 100)

      if (!local) {
        counts.MISSING_LOCALLY += 1
        rows.push({ verdict: 'MISSING_LOCALLY', marketplace, keywordText: k.keywordText ?? '?', externalTargetId: extId, localState: null, amazonState, localBidEur: null, amazonBidEur })
        continue
      }

      const stateDiffers = !!wantStatus && wantStatus !== local.status
      const bidDiffers = wantBidCents != null && wantBidCents !== local.bidCents
      if (!stateDiffers && !bidDiffers) { counts.AGREED += 1; continue }

      counts.DRIFT += 1
      rows.push({
        verdict: 'DRIFT', marketplace, keywordText: k.keywordText ?? local.expressionValue,
        externalTargetId: extId, localState: local.status, amazonState,
        localBidEur: local.bidCents / 100, amazonBidEur,
      })

      if (opts.apply) {
        await prisma.adTarget.update({
          where: { id: local.id },
          data: {
            ...(stateDiffers ? { status: wantStatus as never } : {}),
            ...(bidDiffers && wantBidCents != null ? { bidCents: wantBidCents } : {}),
          },
        })
        updated += 1
      }
    }

    // Local rows Amazon did not return. NEVER deleted or archived here — that is the exact
    // mistake that created this mess (a function archiving what its fetch could not see).
    for (const l of locals) {
      if (!l.externalTargetId) {
        counts.NOT_PUSHED += 1
        continue
      }
      if (seen.has(l.externalTargetId)) continue
      counts.NOT_ON_AMAZON += 1
      rows.push({ verdict: 'NOT_ON_AMAZON', marketplace, keywordText: l.expressionValue, externalTargetId: l.externalTargetId, localState: l.status, amazonState: null, localBidEur: l.bidCents / 100, amazonBidEur: null })
    }
  }

  logger.info('[ACR.5] reconcileSbKeywords', { apply: !!opts.apply, checked, counts, updated, errors: errors.length })
  return { applied: !!opts.apply, checked, counts, rows, updated, errors }
}
