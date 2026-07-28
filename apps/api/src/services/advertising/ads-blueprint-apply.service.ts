/**
 * AX2.5 — apply a blueprint to a new product.
 *
 * SAFETY MODEL, in order:
 *   1. dryRun is the DEFAULT. Executing requires an explicit `dryRun: false`.
 *   2. A plan that is not `allowed` can never execute — the self-competition
 *      gate and the budget cap are enforced here, not just displayed.
 *   3. Creation goes through ads-create.service, which is itself behind
 *      checkAdsWriteGate — so in sandbox nothing reaches Amazon and every
 *      campaign simply lands locally with a null externalCampaignId.
 *   4. Every run is recorded as one AdBlueprintApplication so it can be rolled
 *      back as a single unit rather than leaving orphaned entities behind.
 *   5. After creating we READ BACK: a campaign without an externalCampaignId
 *      did not reach Amazon, and the run is reported PARTIAL rather than
 *      claiming success.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { BlueprintDoc } from '../ads-core/ads-blueprint.js'
import { planApplication, type ApplyPlan, type ApplyOptions, type ApplyTarget, type ExistingTarget } from '../ads-core/ads-blueprint-apply.js'

/**
 * Every positive keyword we currently target in this marketplace — the surface
 * a replication could collide with. Archived campaigns are excluded: they are
 * not in any auction.
 */
export async function loadExistingTargets(marketplace: string): Promise<ExistingTarget[]> {
  const rows = await prisma.adTarget.findMany({
    where: {
      isNegative: false,
      status: { not: 'ARCHIVED' },
      orphanedAt: null,
      adGroup: { campaign: { marketplace, status: { not: 'ARCHIVED' } } },
    },
    select: { expressionValue: true, adGroup: { select: { campaign: { select: { id: true, name: true } } } } },
  })
  return rows
    .filter((r) => r.adGroup?.campaign)
    .map((r) => ({ expression: r.expressionValue, campaignName: r.adGroup!.campaign!.name, campaignId: r.adGroup!.campaign!.id }))
}

export interface ApplyRequest {
  blueprintId: string
  target: ApplyTarget
  marketplace: string
  options?: ApplyOptions
  dryRun?: boolean
  actor?: string
}

/**
 * AX2.7 — can this marketplace actually receive writes? Verified state, not a
 * guess: 5 of the 9 connections are sandbox with no writesEnabledAt, and FR/ES
 * are production but have never had a single AD_* write reach Amazon.
 */
export async function marketContext(marketplace: string) {
  const conn = await prisma.amazonAdsConnection.findFirst({
    where: { marketplace, isActive: true },
    orderBy: { mode: 'asc' }, // 'production' sorts before 'sandbox'
    select: { mode: true, writesEnabledAt: true, lastWriteAt: true },
  })
  return {
    marketplace,
    writable: conn?.mode === 'production' && !!conn.writesEnabledAt,
    everWritten: !!conn?.lastWriteAt,
  }
}

export async function planApply(req: ApplyRequest): Promise<{ plan: ApplyPlan; blueprintName: string }> {
  const bp = await prisma.adBlueprint.findUnique({ where: { id: req.blueprintId } })
  if (!bp) throw new Error('blueprint not found')
  const existing = await loadExistingTargets(req.marketplace)
  const market = await marketContext(req.marketplace)
  const plan = planApplication(bp.doc as unknown as BlueprintDoc, req.target, existing, { ...(req.options ?? {}), market })
  return { plan, blueprintName: bp.name }
}

export interface ApplyResult {
  applicationId: string
  status: 'PLANNED' | 'APPLIED' | 'PARTIAL' | 'FAILED'
  plan: ApplyPlan
  created: { campaigns: number; adGroups: number; targets: number; negatives: number; productAds: number }
  /** PAT/product targets the blueprint carries but this phase cannot create. */
  skippedNonKeyword: number
  /** Campaigns that landed locally but never got an Amazon id. */
  notOnAmazon: string[]
  errors: string[]
}

export async function applyBlueprint(req: ApplyRequest): Promise<ApplyResult> {
  const dryRun = req.dryRun !== false // default TRUE — executing is opt-in
  const { plan } = await planApply(req)

  const application = await prisma.adBlueprintApplication.create({
    data: {
      blueprintId: req.blueprintId,
      productToken: req.target.productToken,
      marketplace: req.marketplace,
      asins: req.target.asins,
      status: 'PLANNED',
      plan: plan as unknown as object,
      acceptedConflicts: (req.options?.acceptSharedTargets ?? []),
      skippedTargets: (req.options?.skipSharedTargets ?? []),
      actor: req.actor ?? null,
    },
  })

  if (dryRun) {
    return { applicationId: application.id, status: 'PLANNED', plan, created: { campaigns: 0, adGroups: 0, targets: 0, negatives: 0, productAds: 0 }, skippedNonKeyword: 0, notOnAmazon: [], errors: [] }
  }
  if (!plan.allowed) {
    // Belt and braces: the route also refuses, but the gate must hold even if
    // some future caller forgets to check.
    await prisma.adBlueprintApplication.update({ where: { id: application.id }, data: { status: 'FAILED', errors: plan.blockers } })
    throw new Error(`refused: ${plan.blockers.join(' | ')}`)
  }

  const { createCampaignLocal, createAdGroupLocal, createKeywordLocal, bulkNegativeKeywords, createProductAdLocal } = await import('./ads-create.service.js')
  const created = { campaigns: 0, adGroups: 0, targets: 0, negatives: 0, productAds: 0 }
  let skippedNonKeyword = 0
  const createdCampaignIds: string[] = []
  const notOnAmazon: string[] = []
  const errors: string[] = []

  for (const c of plan.campaigns) {
    try {
      const camp = await createCampaignLocal({
        name: c.name,
        type: 'SP',
        marketplace: req.marketplace,
        dailyBudgetEur: Number(c.dailyBudget ?? 0),
        biddingStrategy: c.biddingStrategy === 'AUTO_FOR_SALES' ? 'autoForSales' : c.biddingStrategy === 'MANUAL' ? 'manual' : 'legacyForSales',
        userId: req.actor,
      })
      created.campaigns++
      createdCampaignIds.push(camp.id)
      // Read-back: no external id ⇒ it never reached Amazon (gate closed,
      // sandbox, or a rejected create). Say so instead of implying success.
      if (!camp.externalCampaignId) notOnAmazon.push(c.name)

      for (const g of c.adGroups) {
        const grp = await createAdGroupLocal({
          campaignId: camp.id, name: g.name,
          defaultBidEur: (g.defaultBidCents ?? 50) / 100, userId: req.actor,
        })
        created.adGroups++

        // AX2.9 — NEGATIVES FIRST. A campaign that goes live with its positives
        // but not its exclusions immediately buys the traffic the template pays
        // to avoid. Creating them before the positives means that even a run
        // that fails part-way is narrower than its source, never wider.
        // Amazon negatives are EXACT or PHRASE only; the blueprint encodes them
        // with a leading underscore (_EXACT / _PHRASE). bulkNegativeKeywords is
        // the existing idempotent path — it skips one that already exists.
        const negItems = g.targets
          .filter((t) => t.isNegative && t.kind?.toUpperCase() === 'KEYWORD')
          .map((t) => ({ adGroupId: grp.id, keywordText: t.expression, matchType: (t.expressionType ?? 'EXACT').toUpperCase().replace(/^_/, '') as 'EXACT' | 'PHRASE' }))
          .filter((n) => n.matchType === 'EXACT' || n.matchType === 'PHRASE')
        if (negItems.length) {
          const nr = await bulkNegativeKeywords(negItems, req.actor)
          created.negatives += nr.created
          if (nr.failed) errors.push(`${nr.failed} negative(s) failed: ${nr.errors.slice(0, 2).join('; ').slice(0, 160)}`)
        }

        for (const t of g.targets) {
          if (t.isNegative) continue // handled above
          if (t.kind?.toUpperCase() !== 'KEYWORD') {
            // PAT / product targets need a different API surface — count them
            // so the gap is visible rather than silently dropped.
            skippedNonKeyword++
            continue
          }
          const mt = (t.expressionType ?? 'EXACT').toUpperCase().replace(/^_/, '')
          if (mt !== 'EXACT' && mt !== 'PHRASE' && mt !== 'BROAD') continue
          try {
            await createKeywordLocal({
              adGroupId: grp.id, keywordText: t.expression,
              matchType: mt, bidEur: (t.bidCents ?? g.defaultBidCents ?? 50) / 100, userId: req.actor,
            })
            created.targets++
          } catch (e) { errors.push(`keyword "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
        }

        for (const asin of g.asins) {
          try {
            await createProductAdLocal({ adGroupId: grp.id, asin, userId: req.actor })
            created.productAds++
          } catch (e) { errors.push(`productAd ${asin}: ${(e as Error).message.slice(0, 120)}`) }
        }
      }
    } catch (e) {
      errors.push(`campaign "${c.name}": ${(e as Error).message.slice(0, 160)}`)
    }
  }

  const status: ApplyResult['status'] =
    created.campaigns === 0 ? 'FAILED'
    : (errors.length || notOnAmazon.length) ? 'PARTIAL'
    : 'APPLIED'

  await prisma.adBlueprintApplication.update({
    where: { id: application.id },
    data: { status, createdCampaignIds, errors, appliedAt: new Date(), notOnAmazon },
  })
  logger.info('[AX2.5] blueprint applied', { applicationId: application.id, status, created, errors: errors.length })

  return { applicationId: application.id, status, plan, created, skippedNonKeyword, notOnAmazon, errors }
}

/**
 * Undo one replication as a single unit. Archives every campaign the run
 * created (soft, reversible on Amazon's side) via the gated mutation path.
 */
export async function rollbackApplication(applicationId: string, actor?: string): Promise<{ archived: number; errors: string[] }> {
  const app = await prisma.adBlueprintApplication.findUnique({ where: { id: applicationId } })
  if (!app) throw new Error('application not found')
  if (app.status === 'ROLLED_BACK') return { archived: 0, errors: ['already rolled back'] }

  const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
  const errors: string[] = []
  let archived = 0
  // AdsActor is a prefixed template type — an operator-supplied actor already
  // carries "user:", anything else is attributed to the rollback automation.
  const rollbackActor = (actor?.startsWith('user:') || actor?.startsWith('automation:')
    ? actor
    : 'automation:ax25-blueprint-rollback') as `user:${string}` | `automation:${string}`
  for (const id of app.createdCampaignIds) {
    try {
      const r = await updateCampaignWithSync({
        campaignId: id, patch: { status: 'ARCHIVED' },
        actor: rollbackActor, reason: `rollback of blueprint application ${applicationId}`,
        applyImmediately: true,
      })
      if (r.ok) archived++; else errors.push(`${id}: ${r.error ?? 'archive failed'}`)
    } catch (e) { errors.push(`${id}: ${(e as Error).message.slice(0, 120)}`) }
  }
  await prisma.adBlueprintApplication.update({
    where: { id: applicationId },
    data: { status: 'ROLLED_BACK', rolledBackAt: new Date(), errors: [...app.errors, ...errors] },
  })
  return { archived, errors }
}
