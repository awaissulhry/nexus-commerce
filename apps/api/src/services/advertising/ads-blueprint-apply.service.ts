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
import { planApplication, materialise, type ApplyPlan, type ApplyOptions, type ApplyTarget, type ExistingTarget, type PlanEdits } from '../ads-core/ads-blueprint-apply.js'

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

/**
 * AX3.0 — every campaign name live in this marketplace, for the collision gate.
 * Archived names are excluded: Amazon frees an archived name for re-use.
 */
export async function loadExistingCampaignNames(marketplace: string): Promise<string[]> {
  const rows = await prisma.campaign.findMany({
    where: { marketplace, status: { not: 'ARCHIVED' } },
    select: { name: true },
  })
  return rows.map((r) => r.name)
}

export interface ApplyRequest {
  /**
   * AX3.4 — a saved blueprint, OR a live `source` below. Exactly one is
   * required; a replication no longer has to be preceded by saving something.
   */
  blueprintId?: string
  source?: import('./ads-blueprint.service.js').CampaignSelector
  /** The token to parameterise OUT of a live source. Ignored with blueprintId. */
  sourceProductToken?: string
  competitorTokens?: string[]
  target: ApplyTarget
  marketplace: string
  options?: ApplyOptions
  /** AX3.4 — the review step's changes. Re-validated server-side, always. */
  edits?: PlanEdits
  dryRun?: boolean
  actor?: string
  /** AX3.0 — the portfolio the replicated campaigns should join. */
  portfolioId?: string
}

/**
 * AX3.4 — the doc a run is based on, from either kind of source.
 *
 * Rebuilt from the LIVE source on every call, including the launch. The client
 * sends a selector and its edits, never a plan, so what gets created is always
 * derived server-side from what is actually in the account right now.
 */
async function resolveDoc(req: ApplyRequest): Promise<{ doc: BlueprintDoc; name: string }> {
  if (req.blueprintId) {
    const bp = await prisma.adBlueprint.findUnique({ where: { id: req.blueprintId } })
    if (!bp) throw new Error('blueprint not found')
    return { doc: bp.doc as unknown as BlueprintDoc, name: bp.name }
  }
  if (!req.source) throw new Error('either blueprintId or source is required')
  if (!req.sourceProductToken) throw new Error('sourceProductToken is required when replicating from a live source')
  const { previewBlueprint } = await import('./ads-blueprint.service.js')
  const { doc } = await previewBlueprint({
    ...req.source,
    productToken: req.sourceProductToken,
    competitorTokens: req.competitorTokens,
  })
  return { doc, name: 'live source' }
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

/**
 * AX3.3 — plan a replication straight from a live source, with no saved
 * blueprint in between.
 *
 * The builder's step 1 changes the source, the naming and the copy scope
 * continuously; persisting an AdBlueprint on every keystroke would fill the
 * library with throwaway rows. Extraction is pure and cheap, so the doc is built
 * per request and discarded. Saving one stays an explicit action.
 *
 * Read-only: nothing here creates an AdBlueprintApplication or touches Amazon.
 */
export interface PlanFromSourceRequest {
  source: import('./ads-blueprint.service.js').CampaignSelector
  /** The token to parameterise OUT of the source (e.g. 'AIREON'). */
  sourceProductToken: string
  competitorTokens?: string[]
  target: ApplyTarget
  /** Destination marketplace — not necessarily the source's. */
  marketplace: string
  options?: ApplyOptions
  /** AX3.4 — the review step's changes, applied on top of the freshly-built plan. */
  edits?: PlanEdits
}

export async function planFromSource(req: PlanFromSourceRequest): Promise<{
  /**
   * The plan BEFORE the review-step edits. This is what the review tree renders,
   * so a removed campaign still shows (struck through, restorable) and every
   * node keeps the stable id an edit addresses it by.
   */
  plan: ApplyPlan
  /**
   * The plan AFTER them — the verdict that actually matters. Present only when
   * edits were supplied. Returning both in one round trip is what stops the tree
   * and the totals from ever disagreeing about the same replication.
   */
  edited?: ApplyPlan
  source: { campaigns: number; adGroups: number; positives: number; negatives: number; productAds: number; orphanedInSource: number }
  sharedTargets: BlueprintDoc['sharedTargets']
  /** Every campaign's source name next to what it will be called — the rename preview. */
  renames: Array<{ from: string; to: string }>
}> {
  const { previewBlueprint } = await import('./ads-blueprint.service.js')
  const { doc } = await previewBlueprint({
    ...req.source,
    productToken: req.sourceProductToken,
    competitorTokens: req.competitorTokens,
  })
  const [existing, market, existingCampaignNames] = await Promise.all([
    loadExistingTargets(req.marketplace),
    marketContext(req.marketplace),
    loadExistingCampaignNames(req.marketplace),
  ])
  const opts = { ...(req.options ?? {}), market, existingCampaignNames }
  const plan = planApplication(doc, req.target, existing, opts)
  // Edits are evaluated as a SECOND plan rather than folded into the first, so
  // the tree keeps every node (a removed campaign stays visible and restorable)
  // while the totals and blockers describe what would actually be created.
  const hasEdits = !!req.edits && Object.values(req.edits).some((v) => Array.isArray(v) && v.length > 0)
  const edited = hasEdits ? planApplication(doc, req.target, existing, opts, req.edits) : undefined
  // The doc holds patterns; the plan holds finished names. Pair them by index —
  // planApplication maps campaigns 1:1 and preserves order.
  const renames = doc.campaigns.map((c, i) => ({
    from: materialise(c.namePattern, req.sourceProductToken),
    to: plan.campaigns[i]?.name ?? '',
  }))
  return {
    plan,
    edited,
    source: {
      campaigns: doc.stats.campaigns, adGroups: doc.stats.adGroups,
      positives: doc.stats.positives, negatives: doc.stats.negatives,
      productAds: doc.stats.productAds, orphanedInSource: doc.stats.orphanedInSource,
    },
    sharedTargets: doc.sharedTargets,
    renames,
  }
}

export async function planApply(req: ApplyRequest): Promise<{ plan: ApplyPlan; blueprintName: string }> {
  const { doc, name } = await resolveDoc(req)
  const [existing, market, existingCampaignNames] = await Promise.all([
    loadExistingTargets(req.marketplace),
    marketContext(req.marketplace),
    loadExistingCampaignNames(req.marketplace),
  ])
  const plan = planApplication(doc, req.target, existing, {
    ...(req.options ?? {}), market, existingCampaignNames,
  }, req.edits)
  return { plan, blueprintName: name }
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
      // AX3.4 — null when replicated straight from a live source.
      blueprintId: req.blueprintId ?? null,
      sourceSelector: req.source ? ({ ...req.source, sourceProductToken: req.sourceProductToken } as object) : undefined,
      // The naming rules, copy scope and value policies that produced these
      // names and bids. Without them, "why is this campaign called that" is
      // unanswerable a month later.
      options: req.options ? ({
        naming: req.options.naming, include: req.options.include,
        bidPolicy: req.options.bidPolicy, budgetPolicy: req.options.budgetPolicy,
        dailyBudgetCapEur: req.options.dailyBudgetCapEur,
      } as object) : undefined,
      edits: req.edits ? (req.edits as object) : undefined,
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

  const {
    createCampaignLocal, createAdGroupLocal, createKeywordLocal, bulkNegativeKeywords, createProductAdLocal,
    createTargetLocal, createNegativeProductTargetLocal, updatePlacementBidding,
  } = await import('./ads-create.service.js')
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
        // AX3.0 — an Auto campaign has to BE auto. Previously omitted, so
        // createCampaignLocal defaulted every replica to MANUAL and the Auto
        // role was created as a manual campaign that could never self-target.
        targetingType: c.targetingType,
        dailyBudgetEur: Number(c.dailyBudget ?? 0),
        biddingStrategy: c.biddingStrategy === 'AUTO_FOR_SALES' ? 'autoForSales' : c.biddingStrategy === 'MANUAL' ? 'manual' : 'legacyForSales',
        // AX3.0 — join the destination portfolio. Without it replicas landed
        // outside every portfolio, invisible to portfolio budgets and rollups.
        portfolioId: req.portfolioId,
        userId: req.actor,
      })
      created.campaigns++
      createdCampaignIds.push(camp.id)
      // AX3.0 — allowlist the campaign the instant it exists, matching what the
      // SP Super Wizard's launch does. Placement writes and pushCampaignStructure
      // both check Campaign.liveBidWritesEnabled, and so does every later bid
      // write from rank-defend / autopilot / ToS-defense. A replica without it is
      // structurally identical to a wizard-built campaign but permanently frozen.
      try {
        await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } })
      } catch (e) { errors.push(`allowlist "${c.name}": ${(e as Error).message.slice(0, 120)}`) }
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

        // AX3.0 — negative PRODUCT targets, alongside the negative keywords above.
        for (const t of g.targets) {
          if (!t.isNegative || t.kind?.toUpperCase() !== 'PRODUCT') continue
          try {
            await createNegativeProductTargetLocal({ adGroupId: grp.id, asin: t.expression, userId: req.actor })
            created.negatives++
          } catch (e) { errors.push(`negative product "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
        }

        for (const t of g.targets) {
          if (t.isNegative) continue // handled above
          const bidEur = (t.bidCents ?? g.defaultBidCents ?? 50) / 100
          const kind = t.kind?.toUpperCase()

          // AX3.0 — the two kinds that used to be counted and dropped.
          // PRODUCT: 613 live in this account; the PAT campaign was created empty.
          // AUTO: the four SP clauses; the Auto campaign was created with nothing.
          if (kind === 'PRODUCT' || kind === 'CATEGORY') {
            try {
              await createTargetLocal({ adGroupId: grp.id, kind: kind === 'PRODUCT' ? 'PRODUCT' : 'CATEGORY', value: t.expression, bidEur, userId: req.actor })
              created.targets++
            } catch (e) { errors.push(`${kind.toLowerCase()} target "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
            continue
          }
          if (kind === 'AUTO') {
            // An unidentifiable clause (SB/SD targeting) is still counted, not
            // silently swallowed — the plan warned about it already.
            if (!t.autoClause) { skippedNonKeyword++; continue }
            try {
              await createTargetLocal({ adGroupId: grp.id, kind: 'AUTO', value: t.autoClause, bidEur, userId: req.actor })
              created.targets++
            } catch (e) { errors.push(`auto clause ${t.autoClause}: ${(e as Error).message.slice(0, 120)}`) }
            continue
          }
          if (kind !== 'KEYWORD') { skippedNonKeyword++; continue }

          const mt = (t.expressionType ?? 'EXACT').toUpperCase().replace(/^_/, '')
          if (mt !== 'EXACT' && mt !== 'PHRASE' && mt !== 'BROAD') continue
          try {
            await createKeywordLocal({
              adGroupId: grp.id, keywordText: t.expression,
              matchType: mt, bidEur, userId: req.actor,
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

      // AX3.0 — placement bid modifiers. The blueprint has always captured these
      // and apply has always thrown them away. Every campaign in the template
      // structure this feature was built from carries PLACEMENT_TOP +75%, which
      // is a large part of why that structure performs; a replica without it is
      // not the same campaign. Applied last, because it needs the campaign to
      // exist on Amazon and the allowlist stamp above to be in place.
      if (c.placementBidding?.length) {
        try {
          await updatePlacementBidding({
            campaignId: camp.id,
            adjustments: c.placementBidding,
            biddingStrategy: c.biddingStrategy === 'AUTO_FOR_SALES' ? 'autoForSales' : c.biddingStrategy === 'MANUAL' ? 'manual' : 'legacyForSales',
            userId: req.actor,
          })
        } catch (e) { errors.push(`placement bidding "${c.name}": ${(e as Error).message.slice(0, 120)}`) }
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
