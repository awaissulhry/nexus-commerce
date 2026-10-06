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
 *   6. B-1 — a run Claude asked for (replicate-ad-structure, `bornSafe`) is the
 *      same run, born safe whatever the screen chose: at the floor, suppressed by
 *      the person who asked, OFF the live-write allowlist, placements kept for
 *      later, every create on the approval's change set. The screen's run is
 *      unchanged.
 */

import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { BlueprintDoc } from '../ads-core/ads-blueprint.js'
import { planApplication, materialise, negativeMatchOf, type ApplyPlan, type ApplyOptions, type ApplyTarget, type ExistingTarget, type PlanEdits } from '../ads-core/ads-blueprint-apply.js'
import type { PortfolioVerifyResult } from './ads-create.service.js'
import type { LaunchVerification } from './ads-launch-verify.service.js'
import type { AdsActor } from './ads-mutation.service.js'

/**
 * Every positive keyword we currently target in this marketplace — the surface
 * a replication could collide with — with the ASINs its ad group advertises, so
 * the gate can tell the target product's own campaigns from other products'
 * (rule 3: only the same product's clash blocks). Archived campaigns and
 * archived product ads are excluded: they are not in any auction.
 */
export async function loadExistingTargets(marketplace: string): Promise<ExistingTarget[]> {
  const rows = await prisma.adTarget.findMany({
    where: {
      isNegative: false,
      status: { not: 'ARCHIVED' },
      orphanedAt: null,
      adGroup: { campaign: { marketplace, status: { not: 'ARCHIVED' } } },
    },
    select: {
      expressionValue: true,
      adGroup: { select: {
        campaign: { select: { id: true, name: true } },
        productAds: { where: { status: { not: 'ARCHIVED' }, asin: { not: null } }, select: { asin: true } },
      } },
    },
  })
  return rows
    .filter((r) => r.adGroup?.campaign)
    .map((r) => ({
      expression: r.expressionValue, campaignName: r.adGroup!.campaign!.name, campaignId: r.adGroup!.campaign!.id,
      asins: r.adGroup!.productAds.map((a) => a.asin!),
    }))
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
  /**
   * AX3.8 — execute against an application row the caller already created.
   *
   * The detached-run path has to hand the browser an id BEFORE the work starts,
   * so it claims the row first. Without this, applyBlueprint would open a second
   * record and the run the operator is watching would never move.
   */
  existingApplicationId?: string
  /** AX3.0 — the portfolio the replicated campaigns should join. */
  portfolioId?: string
  /**
   * AX3.5 — how the run goes out.
   *
   * `floor` (the DEFAULT) creates everything at Amazon's 2c minimum and records
   * each planned bid as the restore point, so the structure exists, syncs and
   * reads back normally but cannot meaningfully spend until someone raises it.
   * `live` creates at the planned bids.
   *
   * Never a pause: pausing disrupts Amazon's optimisation and forces re-learning,
   * which is why this account suppresses with bids instead. A floored launch is
   * the same mechanism as no-pause suppression, so the console shows it as a
   * suppressed campaign and `restoreCampaignBids` un-does it.
   */
  launchMode?: 'live' | 'floor'
  /**
   * B-1 — Claude's run (replicate-ad-structure), born safe whatever the screen does. Absent: the screen's run, unchanged.
   * At the floor only (`launchMode` 'floor'), each campaign flagged suppressed by `by` the moment it exists (so
   * restore-campaign may give its planned bids back); OFF the live-write allowlist, so every part of it passes
   * `creationFlow` (its negatives too); its placements are not written (a campaign off the allowlist is refused them) but
   * kept on the run (`options.deferredPlacements`); every create's audit row carries `changeSetId`, so its undo finds
   * what it made (archive-ads buildRunId). Replicate creates no rules.
   */
  bornSafe?: { by: AdsActor; changeSetId: string }
}

/** B-1 — what a run born safe keeps on its row, beside the naming, scope and policies. */
interface BornSafeOptions {
  source: 'claude'
  changeSetId: string
  /** Whose request it is: the campaigns are flagged suppressed by them. */
  requester: AdsActor
  /** After the run: the placements it did not write, per campaign (set once the campaign is live). */
  deferredPlacements?: Array<{ campaignId: string; campaign: string; placementBidding: Array<{ placement: string; percentage: number }> }>
}

/** The run row's `options` (AX3.4: the naming rules, copy scope and value policies; B-1: what a safe run was born with). */
function rowOptions(req: ApplyRequest): object | undefined {
  const own = req.options ? {
    naming: req.options.naming, include: req.options.include,
    bidPolicy: req.options.bidPolicy, budgetPolicy: req.options.budgetPolicy,
    dailyBudgetCapEur: req.options.dailyBudgetCapEur,
  } : undefined
  if (!req.bornSafe) return own
  const safe: BornSafeOptions = { source: 'claude', changeSetId: req.bornSafe.changeSetId, requester: req.bornSafe.by }
  return { ...(own ?? {}), ...safe }
}

/** B-1 — a born-safe run's own options, or null for a screen run. */
function bornSafeOf(row: { options: unknown }): BornSafeOptions | null {
  const o = (row.options ?? null) as Partial<BornSafeOptions> | null
  return o?.source === 'claude' && typeof o.changeSetId === 'string' ? (o as BornSafeOptions) : null
}

const SAFE_FLOOR_ONLY = 'refused: a run born safe is created at the floor (launchMode floor)'

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
 * AX3.6 — the most recent replication of this product into this market that was
 * not rolled back. Feeds the "you have already done this" warning.
 *
 * PB-5a — `excludePlaybookId`: a playbook's own earlier build is not "a SECOND
 * set": a re-build makes only the slots it is missing.
 */
export async function priorRunFor(productToken: string, marketplace: string, opts: { excludePlaybookId?: string | null } = {}) {
  const row = await prisma.adBlueprintApplication.findFirst({
    where: {
      productToken: { equals: productToken, mode: 'insensitive' },
      marketplace,
      // PLANNED rows are dry runs — they created nothing, so they are not a
      // duplicate of anything.
      status: { in: ['APPLIED', 'PARTIAL'] },
      ...(opts.excludePlaybookId ? { OR: [{ playbookId: null }, { playbookId: { not: opts.excludePlaybookId } }] } : {}),
    },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true, appliedAt: true, status: true, createdCampaignIds: true },
  })
  if (!row) return undefined
  return {
    when: (row.appliedAt ?? row.createdAt).toISOString().slice(0, 10),
    status: row.status,
    campaigns: row.createdCampaignIds.length,
  }
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
  const [existing, market, existingCampaignNames, priorRun] = await Promise.all([
    loadExistingTargets(req.marketplace),
    marketContext(req.marketplace),
    loadExistingCampaignNames(req.marketplace),
    priorRunFor(req.target.productToken, req.marketplace),
  ])
  const opts = { ...(req.options ?? {}), market, existingCampaignNames, priorRun }
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
  const [existing, market, existingCampaignNames, priorRun] = await Promise.all([
    loadExistingTargets(req.marketplace),
    marketContext(req.marketplace),
    loadExistingCampaignNames(req.marketplace),
    priorRunFor(req.target.productToken, req.marketplace),
  ])
  const plan = planApplication(doc, req.target, existing, {
    ...(req.options ?? {}), market, existingCampaignNames, priorRun,
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
  /**
   * AX-VT.1 — Amazon's own answer on whether the replicas joined the destination portfolio,
   * read back after the run. `null` when the run requested no portfolio. `repaired > 0` means
   * the create did not carry portfolioId and this step is what put them where they belong.
   */
  portfolioCheck?: PortfolioVerifyResult | null
  /**
   * AX-VT.4 — Amazon's own account of what the run produced, field by field. `ok: false` means
   * the replica does not match the blueprint, which also downgrades `status` to PARTIAL.
   */
  verification?: LaunchVerification | null
}

/**
 * AX3.8 — start a replication and hand back its id, without waiting for it.
 *
 * WHY THIS EXISTS. A replication is hundreds of sequential Amazon calls and
 * takes minutes. Run inside the HTTP request, the platform's edge proxy closes
 * the connection long before it finishes: the browser reports `Failed to fetch`
 * and the server carries on. On 2026-07-31 that produced ten live campaigns in
 * Amazon IT that the operator was told had not been created — and a second click
 * would have made ten more.
 *
 * So the request now does three things only: re-gate the plan, refuse if a run
 * for this product is already in flight, and claim the row. The work runs
 * detached against that row and reports into `progress`. The connection can die
 * whenever it likes; the run is a record, not a response.
 */
export async function startBlueprintRun(req: ApplyRequest): Promise<{
  applicationId: string
  status: 'RUNNING'
  alreadyRunning?: boolean
  plan: ApplyPlan
}> {
  if (req.bornSafe && req.launchMode === 'live') throw new Error(SAFE_FLOOR_ONLY)
  const { plan } = await planApply(req)
  if (!plan.allowed) throw new Error(`refused: ${plan.blockers.join(' | ')}`)

  // One run per product per market at a time. This is the guard that makes a
  // dropped connection safe: a browser that retries finds the run it lost.
  // PB-5a — a playbook build of this product that stopped (a deploy killed it) is marked FAILED first, so it never holds
  // this guard for ever. B-1 — so is a run Claude asked for (born safe) that stopped; a screen run is left as it is.
  const { settleStoppedBuilds } = await import('./ads-playbook/build.js')
  await settleStoppedBuilds({ market: req.marketplace, productToken: req.target.productToken })
  await settleStoppedReplicates({ market: req.marketplace, productToken: req.target.productToken })
  const inFlight = await prisma.adBlueprintApplication.findFirst({
    where: { marketplace: req.marketplace, productToken: req.target.productToken, status: 'RUNNING' },
    orderBy: { createdAt: 'desc' },
  })
  if (inFlight) return { applicationId: inFlight.id, status: 'RUNNING', alreadyRunning: true, plan }

  const application = await prisma.adBlueprintApplication.create({
    data: {
      blueprintId: req.blueprintId ?? null,
      sourceSelector: req.source ? ({ ...req.source, sourceProductToken: req.sourceProductToken } as object) : undefined,
      options: rowOptions(req),
      edits: req.edits ? (req.edits as object) : undefined,
      productToken: req.target.productToken,
      marketplace: req.marketplace,
      asins: req.target.asins,
      status: 'RUNNING',
      startedAt: new Date(),
      plan: plan as unknown as object,
      acceptedConflicts: (req.options?.acceptSharedTargets ?? []),
      skippedTargets: (req.options?.skipSharedTargets ?? []),
      launchMode: req.launchMode ?? 'floor',
      actor: req.actor ?? null,
      // B-1 — a safe run stamps its progress (`at`), so one a deploy killed is known to have stopped.
      progress: { done: 0, total: plan.campaigns.length, campaign: null, created: { campaigns: 0, adGroups: 0, targets: 0, negatives: 0, productAds: 0 }, ...(req.bornSafe ? { at: new Date().toISOString() } : {}) } as object,
    },
  })

  void applyBlueprint({ ...req, dryRun: false, existingApplicationId: application.id })
    .catch(async (e) => {
      logger.error('[AX3.8] detached replication threw', { applicationId: application.id, error: (e as Error).message })
      // A thrown run must not sit at RUNNING for ever — that would block the
      // next launch on the in-flight guard above.
      await prisma.adBlueprintApplication.update({
        where: { id: application.id },
        data: { status: 'FAILED', errors: [`the run stopped: ${(e as Error).message.slice(0, 300)}`], appliedAt: new Date() },
      }).catch(() => {})
    })

  return { applicationId: application.id, status: 'RUNNING', plan }
}

export async function applyBlueprint(req: ApplyRequest): Promise<ApplyResult> {
  const dryRun = req.dryRun !== false // default TRUE — executing is opt-in
  if (req.bornSafe && req.launchMode === 'live') throw new Error(SAFE_FLOOR_ONLY)
  const { plan } = await planApply(req)

  // AX3.8 — when the caller has already claimed a row (the detached-run path,
  // which needs an id to hand back before the work starts), execute against it
  // instead of opening a second one. A run must have exactly one record.
  const application = req.existingApplicationId
    ? await prisma.adBlueprintApplication.update({ where: { id: req.existingApplicationId }, data: { plan: plan as unknown as object } })
    : await prisma.adBlueprintApplication.create({
    data: {
      // AX3.4 — null when replicated straight from a live source.
      blueprintId: req.blueprintId ?? null,
      sourceSelector: req.source ? ({ ...req.source, sourceProductToken: req.sourceProductToken } as object) : undefined,
      // The naming rules, copy scope and value policies that produced these
      // names and bids. Without them, "why is this campaign called that" is
      // unanswerable a month later.
      options: rowOptions(req),
      edits: req.edits ? (req.edits as object) : undefined,
      productToken: req.target.productToken,
      marketplace: req.marketplace,
      asins: req.target.asins,
      status: 'PLANNED',
      plan: plan as unknown as object,
      acceptedConflicts: (req.options?.acceptSharedTargets ?? []),
      skippedTargets: (req.options?.skipSharedTargets ?? []),
      launchMode: req.launchMode ?? 'floor',
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
    createTargetLocal, createNegativeProductTargetLocal, updatePlacementBidding, linkAutoTargeting,
  } = await import('./ads-create.service.js')
  const created = { campaigns: 0, adGroups: 0, targets: 0, negatives: 0, productAds: 0 }
  let skippedNonKeyword = 0
  const createdCampaignIds: string[] = []
  const notOnAmazon: string[] = []
  /** Product ads whose row exists but which Amazon never accepted. */
  const notPushedAds: string[] = []
  const errors: string[] = []

  // AX3.5 — a floored launch creates AT the floor and remembers the planned bid,
  // rather than creating at the planned bid and lowering it afterwards. The
  // second order looks equivalent and is not: it puts real bids on Amazon for
  // however long the suppression writes take to land, which is exactly the spend
  // this option exists to avoid.
  const { SUPPRESSION_FLOOR_CENTS } = await import('./ads-bid-suppression.service.js')
  const floored = (req.launchMode ?? 'floor') === 'floor'
  // B-1 — Claude's run: every create on the approval's change set, every part of it inside this creation (off the
  // allowlist), its placements kept for later. Absent: the screen's run.
  const safe = req.bornSafe ?? null
  const cs = safe ? { changeSetId: safe.changeSetId } : {}
  const deferredPlacements: NonNullable<BornSafeOptions['deferredPlacements']> = []
  const bidEurFor = (cents: number | null | undefined, fallback: number) =>
    floored ? SUPPRESSION_FLOOR_CENTS / 100 : (cents ?? fallback) / 100
  /** Remember what this entity's bid WOULD have been, so restore is exact. */
  const rememberTarget = async (id: string, plannedCents: number | null | undefined) => {
    if (!floored) return
    const c = plannedCents ?? null
    if (c == null || c <= SUPPRESSION_FLOOR_CENTS) return
    try { await prisma.adTarget.update({ where: { id }, data: { suppressedFromBidCents: c } }) }
    catch (e) { errors.push(`remember bid: ${(e as Error).message.slice(0, 90)}`) }
  }

  // AX3.8 — report from inside the run. Best-effort by design: a progress write
  // that fails must never abort a launch that is halfway through creating real
  // campaigns.
  let campaignsDone = 0
  const report = async (campaign: string) => {
    try {
      await prisma.adBlueprintApplication.update({
        where: { id: application.id },
        data: { progress: { done: campaignsDone, total: plan.campaigns.length, campaign, created, ...(safe ? { at: new Date().toISOString() } : {}) } as object },
      })
    } catch { /* progress is not the work */ }
  }
  await prisma.adBlueprintApplication.update({
    where: { id: application.id },
    data: { status: 'RUNNING', startedAt: new Date(), progress: { done: 0, total: plan.campaigns.length, campaign: null, created, ...(safe ? { at: new Date().toISOString() } : {}) } as object },
  }).catch(() => {})

  for (const c of plan.campaigns) {
    await report(c.name)
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
        ...cs,
      })
      created.campaigns++
      createdCampaignIds.push(camp.id)
      // AX3.0 — allowlist the campaign the instant it exists, matching what the
      // SP Super Wizard's launch does. Placement writes and pushCampaignStructure
      // both check Campaign.liveBidWritesEnabled, and so does every later bid
      // write from rank-defend / autopilot / ToS-defense. A replica without it is
      // structurally identical to a wizard-built campaign but permanently frozen.
      // B-1 — Claude's run is born OFF it (every part below passes `creationFlow`): no engine, rule or later edit writes
      // to it until a person puts it on the list (set-campaign-live-writes). It is flagged suppressed by the person who
      // asked from the moment it exists, so restore-campaign may give its planned bids back.
      if (safe) {
        try { await prisma.campaign.update({ where: { id: camp.id }, data: { bidsSuppressedAt: new Date(), bidsSuppressedFloorCents: SUPPRESSION_FLOOR_CENTS, bidsSuppressedBy: safe.by } }) }
        catch (e) { errors.push(`suppression flag "${c.name}": ${(e as Error).message.slice(0, 90)}`) }
      } else {
        try {
          await prisma.campaign.update({ where: { id: camp.id }, data: { liveBidWritesEnabled: true } })
        } catch (e) { errors.push(`allowlist "${c.name}": ${(e as Error).message.slice(0, 120)}`) }
      }
      // Read-back: no external id ⇒ it never reached Amazon (gate closed,
      // sandbox, or a rejected create). Say so instead of implying success.
      if (!camp.externalCampaignId) notOnAmazon.push(c.name)

      for (const g of c.adGroups) {
        const grp = await createAdGroupLocal({
          campaignId: camp.id, name: g.name,
          // CM-20 — `creationFlow`: this run created the campaign; its policies are the plan's warnings, not blocks.
          defaultBidEur: bidEurFor(g.defaultBidCents, 50), userId: req.actor, creationFlow: true, ...cs,
        })
        created.adGroups++
        if (floored && (g.defaultBidCents ?? 0) > SUPPRESSION_FLOOR_CENTS) {
          try { await prisma.adGroup.update({ where: { id: grp.id }, data: { suppressedFromBidCents: g.defaultBidCents } }) }
          catch (e) { errors.push(`remember ad-group bid: ${(e as Error).message.slice(0, 90)}`) }
        }

        // AX2.9 — NEGATIVES FIRST. A campaign that goes live with its positives
        // but not its exclusions immediately buys the traffic the template pays
        // to avoid. Creating them before the positives means that even a run
        // that fails part-way is narrower than its source, never wider.
        // Amazon negatives are EXACT or PHRASE only; a source stores them as
        // EXACT / PHRASE (synced), NEGATIVE_EXACT / NEGATIVE_PHRASE (written by
        // Nexus) or _EXACT / _PHRASE (a blueprint): every spelling is read
        // (negativeMatchOf). bulkNegativeKeywords is the existing idempotent
        // path — it skips one that already exists.
        const negItems = g.targets
          .filter((t) => t.isNegative && t.kind?.toUpperCase() === 'KEYWORD')
          .map((t) => ({ adGroupId: grp.id, keywordText: t.expression, matchType: negativeMatchOf(t.expressionType) as 'EXACT' | 'PHRASE' }))
          .filter((n) => n.matchType === 'EXACT' || n.matchType === 'PHRASE')
        // B-1 — Claude's run: they are part of the creation (`creationFlow`), as its keywords and product ads are.
        if (negItems.length) {
          const nr = await bulkNegativeKeywords(negItems, req.actor, safe ? { creationFlow: true, ...cs } : {})
          created.negatives += nr.created
          if (nr.failed) errors.push(`${nr.failed} negative(s) failed: ${nr.errors.slice(0, 2).join('; ').slice(0, 160)}`)
        }

        // AX3.0 — negative PRODUCT targets, alongside the negative keywords above.
        for (const t of g.targets) {
          if (!t.isNegative || t.kind?.toUpperCase() !== 'PRODUCT') continue
          try {
            await createNegativeProductTargetLocal({ adGroupId: grp.id, asin: t.expression, userId: req.actor, ...(safe ? { creationFlow: true, ...cs } : {}) })
            created.negatives++
          } catch (e) { errors.push(`negative product "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
        }

        // W2-A (CC-1) — the auto groups this ad group asks for, linked to Amazon's own once its ads exist (below).
        const autoWishes: Array<{ key: string; bidEur: number; plannedCents: number }> = []
        for (const t of g.targets) {
          if (t.isNegative) continue // handled above
          const plannedCents = t.bidCents ?? g.defaultBidCents ?? 50
          const bidEur = bidEurFor(plannedCents, 50)
          const kind = t.kind?.toUpperCase()

          // AX3.0 — the two kinds that used to be counted and dropped.
          // PRODUCT: 613 live in this account; the PAT campaign was created empty.
          // AUTO: the four SP clauses; the Auto campaign was created with nothing.
          if (kind === 'PRODUCT' || kind === 'CATEGORY') {
            try {
              const r = await createTargetLocal({ adGroupId: grp.id, kind: kind === 'PRODUCT' ? 'PRODUCT' : 'CATEGORY', value: t.expression, bidEur, userId: req.actor, creationFlow: true, ...cs })
              await rememberTarget(r.id, plannedCents)
              created.targets++
            } catch (e) { errors.push(`${kind.toLowerCase()} target "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
            continue
          }
          if (kind === 'AUTO') {
            // An unidentifiable clause (SB/SD targeting) is still counted, not
            // silently swallowed — the plan warned about it already.
            if (!t.autoClause) { skippedNonKeyword++; continue }
            // Amazon CREATES the four SP auto clauses itself when an ad group is
            // added to an AUTO campaign, and POST /sp/targets rejects them
            // (INVALID_ARGUMENT on the clause value). Posting them anyway is what
            // put four failures on every replication of an Auto campaign and
            // downgraded an otherwise clean run to PARTIAL. W2-A (CC-1) — they are
            // linked to Amazon's own groups after the product ads (linkAutoTargeting,
            // the path every builder shares), and their bids are set there.
            autoWishes.push({ key: t.autoClause, bidEur, plannedCents })
            continue
          }
          if (kind !== 'KEYWORD') { skippedNonKeyword++; continue }

          const mt = (t.expressionType ?? 'EXACT').toUpperCase().replace(/^_/, '')
          if (mt !== 'EXACT' && mt !== 'PHRASE' && mt !== 'BROAD') continue
          try {
            const r = await createKeywordLocal({
              adGroupId: grp.id, keywordText: t.expression,
              matchType: mt, bidEur, userId: req.actor, creationFlow: true, ...cs,
            })
            await rememberTarget(r.id, plannedCents)
            created.targets++
          } catch (e) { errors.push(`keyword "${t.expression}": ${(e as Error).message.slice(0, 120)}`) }
        }

        for (const asin of g.asins) {
          try {
            const ad = await createProductAdLocal({ adGroupId: grp.id, asin, userId: req.actor, creationFlow: true, ...cs })
            // Count what reached AMAZON, not what reached our database. Counting
            // local rows is how a run with zero live product ads reported 200 of
            // them and looked like a success.
            if (ad.externalAdId) created.productAds++
            else notPushedAds.push(asin)
          } catch (e) { errors.push(`productAd ${asin}: ${(e as Error).message.slice(0, 160)}`) }
        }

        if (autoWishes.length) {
          try {
            const linked = await linkAutoTargeting({ adGroupId: grp.id, groups: autoWishes.map((w) => ({ key: w.key, enabled: true, bidEur: w.bidEur })), userId: req.actor, creationFlow: true, ...cs })
            for (const l of linked.links) {
              if (l.adTargetId) {
                created.targets++
                await rememberTarget(l.adTargetId, autoWishes.find((w) => w.key === l.key)?.plannedCents)
              }
              // A campaign Amazon does not hold is already reported in `notOnAmazon`; its groups do not exist there yet.
              if (!l.ok && camp.externalCampaignId) errors.push(`auto clause ${l.label}: ${(l.reason ?? 'not linked to Amazon').slice(0, 200)}`)
            }
          } catch (e) { errors.push(`auto clauses: ${(e as Error).message.slice(0, 120)}`) }
        }
      }

      // AX3.0 — placement bid modifiers. The blueprint has always captured these
      // and apply has always thrown them away. Every campaign in the template
      // structure this feature was built from carries PLACEMENT_TOP +75%, which
      // is a large part of why that structure performs; a replica without it is
      // not the same campaign. Applied last, because it needs the campaign to
      // exist on Amazon and the allowlist stamp above to be in place.
      // B-1 — Claude's run is off the allowlist, which refuses placements: they are kept on the run instead, for the day
      // the campaign goes live (set-placement-multipliers).
      if (c.placementBidding?.length && safe) deferredPlacements.push({ campaignId: camp.id, campaign: c.name, placementBidding: c.placementBidding })
      else if (c.placementBidding?.length) {
        try {
          await updatePlacementBidding({
            campaignId: camp.id,
            adjustments: c.placementBidding,
            biddingStrategy: c.biddingStrategy === 'AUTO_FOR_SALES' ? 'autoForSales' : c.biddingStrategy === 'MANUAL' ? 'manual' : 'legacyForSales',
            userId: req.actor,
          })
        } catch (e) { errors.push(`placement bidding "${c.name}": ${(e as Error).message.slice(0, 120)}`) }
      }

      // AX3.5 — mark a floored campaign as suppressed, using the same flag the
      // no-pause engine sets. That makes it read as suppressed everywhere in the
      // console and lets restoreCampaignBids un-do it with no special case.
      // B-1 — Claude's run flagged it (with who asked) the moment it existed.
      if (floored && !safe) {
        try { await prisma.campaign.update({ where: { id: camp.id }, data: { bidsSuppressedAt: new Date() } }) }
        catch (e) { errors.push(`suppression flag "${c.name}": ${(e as Error).message.slice(0, 90)}`) }
      }
    } catch (e) {
      errors.push(`campaign "${c.name}": ${(e as Error).message.slice(0, 160)}`)
    }
    campaignsDone++
  }
  await report('finishing up')

  // AX-VT.1 — the AX3.0 comment above ("join the destination portfolio") was right about
  // the intent and wrong about the layer: createCampaignLocal silently dropped portfolioId,
  // so every replica landed outside every portfolio anyway. The field now travels with the
  // create AND is read back here, because a create response cannot prove membership landed.
  // Any repair it had to perform is surfaced as an error so a PARTIAL run says why.
  const { settleLaunchPortfolios } = await import('./ads-create.service.js')
  const portfolioCheck = await settleLaunchPortfolios(createdCampaignIds)
  if (portfolioCheck?.repairFailed) {
    errors.push(`portfolio membership could not be set for ${portfolioCheck.repairFailed} campaign(s)`)
  }

  // AX-VT.4 — read the whole replica back. `notOnAmazon` only ever caught campaigns that got no
  // id at all; a replica whose bids or match types landed differently looked like a clean run.
  // Runs after the portfolio repair so the receipt describes the end state.
  const { verifyLaunch } = await import('./ads-launch-verify.service.js')
  const verification = await verifyLaunch(createdCampaignIds).catch((e) => {
    errors.push(`launch verification failed: ${(e as Error).message.slice(0, 120)}`)
    return null
  })
  if (notPushedAds.length) {
    errors.push(
      `${notPushedAds.length} product ad(s) were not accepted by Amazon, so those products are not `
      + `being advertised (${notPushedAds.slice(0, 3).join(', ')}${notPushedAds.length > 3 ? ', …' : ''}). `
      + 'Use "Push the missing pieces" to retry them.',
    )
  }
  if (verification && !verification.ok) {
    // Surfaced as errors so `status` downgrades to PARTIAL — a run whose result does not match
    // the blueprint is not an APPLIED run, and saying so is the entire point of this phase.
    //
    // The list is capped, and the CAP IS STATED. It silently kept the first 20 before, so a run
    // with 200 broken product ads and a run with 20 produced an identical receipt — and the first
    // one read as the smaller problem.
    const CAP = 20
    for (const p of verification.problems.slice(0, CAP)) errors.push(p)
    if (verification.problems.length > CAP) {
      errors.push(`…and ${verification.problems.length - CAP} more problem(s) not listed here — ${verification.problems.length} in total.`)
    }
  }

  const status: ApplyResult['status'] =
    created.campaigns === 0 ? 'FAILED'
    : (errors.length || notOnAmazon.length) ? 'PARTIAL'
    : 'APPLIED'

  await prisma.adBlueprintApplication.update({
    where: { id: application.id },
    data: {
      status, createdCampaignIds, errors, appliedAt: new Date(), notOnAmazon,
      progress: { done: plan.campaigns.length, total: plan.campaigns.length, campaign: null, created, ...(safe ? { at: new Date().toISOString() } : {}) } as object,
      ...(safe ? { options: { ...((application.options ?? {}) as object), deferredPlacements } } : {}),
    },
  })
  logger.info('[AX2.5] blueprint applied', { applicationId: application.id, status, created, errors: errors.length })

  return { applicationId: application.id, status, plan, created, skippedNonKeyword, notOnAmazon, errors, portfolioCheck, verification }
}

// ── B-1 — Claude's runs (replicate-ad-structure): followed, undone, and settled when a deploy killed them ──────────────

const REPLICATE_RUN_SELECT = { id: true, status: true, progress: true, createdAt: true, startedAt: true, createdCampaignIds: true, errors: true, options: true } as const
type ReplicateRunRow = { id: string; status: string; progress: unknown; createdAt: Date; startedAt: Date | null; createdCampaignIds: string[]; errors: string[]; options: unknown }

/**
 * Every campaign a Replicate run made: the ids it recorded at the end and, for a run born safe, every campaign its change
 * set's audit rows say it created (a run killed mid-way recorded none).
 */
async function replicateMadeBy(row: Pick<ReplicateRunRow, 'createdCampaignIds' | 'options'>): Promise<string[]> {
  const changeSetId = bornSafeOf(row)?.changeSetId
  const logged = changeSetId
    ? (await prisma.advertisingActionLog.findMany({ where: { executionId: changeSetId, actionType: 'create_campaign', entityType: 'CAMPAIGN' }, select: { entityId: true } })).map((l) => l.entityId)
    : []
  return [...new Set([...row.createdCampaignIds, ...logged])]
}

/** A run born safe that has not moved for STALE_RUN_MS (the playbook's measure): a deploy or a restart killed it. */
async function safeRunStopped(row: ReplicateRunRow, now: number): Promise<boolean> {
  if (!bornSafeOf(row)) return false
  const { stoppedRunning } = await import('./ads-playbook/build.js')
  return stoppedRunning(row, now)
}

/**
 * Claude's runs (born safe) of this product in this market — or the one named — that stopped advancing: marked FAILED with
 * every campaign they made, never resumed. What they made is archived (archive-ads buildRunId) or kept. A screen run is
 * never touched.
 */
export async function settleStoppedReplicates(where: { market: string; productToken: string } | { applicationId: string }, now = Date.now()): Promise<number> {
  const rows = await prisma.adBlueprintApplication.findMany({
    where: { status: 'RUNNING', playbookId: null, ...('applicationId' in where ? { id: where.applicationId } : { marketplace: where.market, productToken: where.productToken }) },
    select: REPLICATE_RUN_SELECT,
  })
  let settled = 0
  for (const row of rows) {
    if (!(await safeRunStopped(row, now))) continue
    const made = await replicateMadeBy(row)
    const campaign = (row.progress as { campaign?: unknown } | null)?.campaign
    const { STALE_RUN_MS } = await import('./ads-playbook/build.js')
    const r = await prisma.adBlueprintApplication.updateMany({
      where: { id: row.id, status: 'RUNNING' },
      data: {
        status: 'FAILED', appliedAt: new Date(), createdCampaignIds: made,
        errors: [...row.errors, `the run stopped without finishing${typeof campaign === 'string' ? ` at "${campaign}"` : ''}: no progress for ${STALE_RUN_MS / 60_000} minutes (a deploy or a restart). It does not resume: archive what it made (archive-ads buildRunId ${row.id}), or keep it.`],
      },
    })
    settled += r.count
  }
  if (settled) logger.warn('[B-1] a Replicate run Claude asked for stopped and was marked FAILED', { settled })
  return settled
}

/** The ad groups named that are not in these campaigns (a source narrowed to some of its ad groups); none when all are. */
export async function adGroupsOutside(campaignIds: readonly string[], adGroupIds: readonly string[]): Promise<string[]> {
  if (!adGroupIds.length) return []
  const rows = await prisma.adGroup.findMany({ where: { id: { in: [...adGroupIds] }, campaignId: { in: [...campaignIds] } }, select: { id: true } })
  return adGroupIds.filter((id) => !rows.some((r) => r.id === id))
}

/**
 * A run of this product in this market still RUNNING — the one startBlueprintRun's guard would answer with — and whether
 * it stopped (a run of Claude's a deploy killed: the next run settles it); null when none. Read only.
 */
export async function replicateInFlight(market: string, productToken: string, now = Date.now()): Promise<{ applicationId: string; stopped: boolean } | null> {
  const row = await prisma.adBlueprintApplication.findFirst({
    where: { marketplace: market, productToken, status: 'RUNNING' },
    orderBy: { createdAt: 'desc' },
    select: REPLICATE_RUN_SELECT,
  })
  return row ? { applicationId: row.id, stopped: await safeRunStopped(row, now) } : null
}

/**
 * The campaigns a Replicate run made that are not archived yet and that Amazon holds (archive-ads buildRunId, the undo of
 * replicate-ad-structure), or why they cannot be named; null when the id is no Replicate run of this business (a
 * playbook build's is the playbook's).
 */
export async function replicateRunCampaigns(applicationId: string, now = Date.now()): Promise<{ campaignIds: string[]; status: string; stopped?: true } | { refusal: string } | null> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: null }, select: REPLICATE_RUN_SELECT })
  if (!run) return null
  // Read only: a run that stopped holds nothing and names what it made (archive-ads' execute settles it first).
  const stopped = await safeRunStopped(run, now)
  if (run.status === 'RUNNING' && !stopped) return { refusal: 'Not queued: that Replicate run is still running. Follow it with approval-status, and archive what it made once it ends.' }
  const made = await replicateMadeBy(run)
  const live = made.length
    ? await prisma.campaign.findMany({ where: { id: { in: made }, status: { not: 'ARCHIVED' }, externalCampaignId: { not: null } }, select: { id: true } })
    : []
  return { campaignIds: live.map((c) => c.id), status: stopped ? 'FAILED' : run.status, ...(stopped ? { stopped: true as const } : {}) }
}

/** Every campaign a Replicate run made (archived or not), for the places a change lands; null when there is no such run. */
export async function replicateRunCreated(applicationId: string): Promise<string[] | null> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: null }, select: REPLICATE_RUN_SELECT })
  return run ? replicateMadeBy(run) : null
}

/** A Replicate run as approval-status follows it: its status, how far it is, the campaigns it made, how many errors, the placements it left for later. */
export async function replicateRunDelivery(applicationId: string): Promise<{ status: string; done: number | null; total: number | null; createdCampaignIds: string[]; errors: number; deferredPlacements: number } | null> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: null }, select: REPLICATE_RUN_SELECT })
  if (!run) return null
  const progress = (run.progress ?? {}) as { done?: unknown; total?: unknown }
  return {
    status: run.status, done: typeof progress.done === 'number' ? progress.done : null, total: typeof progress.total === 'number' ? progress.total : null,
    createdCampaignIds: await replicateMadeBy(run), errors: run.errors.length, deferredPlacements: bornSafeOf(run)?.deferredPlacements?.length ?? 0,
  }
}

/**
 * B-1 — a run Claude asked for is born off the live-write allowlist: it goes live with set-campaign-live-writes, then
 * restore-campaign, each a request of its own. Replicate's raise refuses it (off the allowlist its bid writes would be
 * refused anyway, and the run would read "live").
 */
export const CLAUDE_RUN =
  'Claude asked for this run: it was born off the live-write allowlist and goes live with set-campaign-live-writes, then restore-campaign (each a request a person approves), not with Replicate\'s raise.'

/**
 * PB-5a — a run that built an ads playbook (playbookId set) is the playbook's: it starts with the playbook's START (the
 * allowlist first, then the planned bids and placements) and is undone with archive-ads buildRunId. Replicate's raise and
 * rollback refuse it, so a raise here never puts bids back on campaigns off the allowlist behind the playbook's back.
 */
export const PLAYBOOK_RUN =
  'This run built an ads playbook: it is started, stopped and undone only through the playbook (apply-ads-playbook; archive-ads with its buildRunId), not from Replicate.'

/**
 * AX3.5 — take a floored run up to the bids it was planned at.
 *
 * The counterpart to launching at the floor. Each entity remembered its planned
 * bid in `suppressedFromBidCents`, so this is the ordinary no-pause restore —
 * retry-safe, gated, and audited — applied across every campaign the run
 * created, rather than a bespoke path that would need its own correctness proof.
 */
export async function raiseApplicationBids(applicationId: string, actor?: string): Promise<{ raised: number; campaigns: number; errors: string[] }> {
  const app = await prisma.adBlueprintApplication.findUnique({ where: { id: applicationId } })
  if (!app) throw new Error('application not found')
  if (app.playbookId) throw new Error(PLAYBOOK_RUN)
  if (bornSafeOf(app)) throw new Error(CLAUDE_RUN)
  if (app.status === 'ROLLED_BACK') return { raised: 0, campaigns: 0, errors: ['this run was rolled back'] }

  const { restoreCampaignBids } = await import('./ads-bid-suppression.service.js')
  const who = (actor?.startsWith('user:') || actor?.startsWith('automation:')
    ? actor
    : 'automation:ax35-replication-raise') as `user:${string}` | `automation:${string}`
  const errors: string[] = []
  let raised = 0
  for (const id of app.createdCampaignIds) {
    try {
      raised += await restoreCampaignBids(id, { actor: who, reason: `raise replication ${applicationId} to its planned bids`, applyImmediately: true })
    } catch (e) { errors.push(`${id}: ${(e as Error).message.slice(0, 120)}`) }
  }
  await prisma.adBlueprintApplication.update({ where: { id: applicationId }, data: { launchMode: 'live' } })
  return { raised, campaigns: app.createdCampaignIds.length, errors }
}

/**
 * Undo one replication as a single unit. Archives every campaign the run
 * created (soft, reversible on Amazon's side) via the gated mutation path.
 */
export async function rollbackApplication(applicationId: string, actor?: string): Promise<{ archived: number; errors: string[] }> {
  const app = await prisma.adBlueprintApplication.findUnique({ where: { id: applicationId } })
  if (!app) throw new Error('application not found')
  if (app.playbookId) throw new Error(PLAYBOOK_RUN)
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
