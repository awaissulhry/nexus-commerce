/**
 * ADS PLAYBOOK PB-5a — BUILD one product's playbook in one market, through the SP Super Wizard's own launch (Owner rule 1:
 * build only with Nexus's own campaign builders; ads-sp-wizard-launch.service.ts). Nothing here creates a campaign by
 * itself: the plan is PB-4's dry run (build-preview.ts `planBuild`, judged by the blueprint gate), and the launch is the
 * wizard's, with the playbook's options.
 *
 *   start     `startPlaybookBuild` (in the approved request): one build per product at a time — a run of this product or
 *             this playbook still RUNNING is answered with its id. One that stopped advancing (no progress for 30
 *             minutes: a deploy or a restart killed it) is marked FAILED with every campaign it made (from the audit
 *             rows of its change set), so it can be archived (archive-ads buildRunId) and built again; it never resumes
 *             by itself. It claims the run row (AdBlueprintApplication, playbookId set, launchMode floor) and returns
 *             its id; the work runs detached, recording each campaign it makes as it goes.
 *   run       `runPlaybookBuild`: the portfolio (reused, else created — one Amazon does not hold stops the run before any
 *             campaign), then the wizard's launch: born OFF the live-write allowlist, every bid at the 2¢ floor with the
 *             planned bid remembered (suppressed by the person who asked, never paused), the approval's change set on
 *             every audit row, no placements (kept on the run for START), progress into the row. Then the slot links
 *             (origin built) and the portfolio link, the artifacts hook (artifacts.ts; empty in PB-5a), the run's status
 *             (APPLIED · PARTIAL · FAILED, from the launch's answer and its read-back) and the row's state (BUILT). A
 *             campaign Amazon never took (a FAILED record with no Amazon id) is archived in Nexus, so its name is free
 *             for the next build.
 *
 * Nothing spends until START (PB-5b): a campaign at 2¢ serves next to nothing (not nothing), and off the allowlist no
 * engine, rule or later edit writes to it.
 */
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import type { PlannedCampaign } from '../../ads-core/ads-blueprint-apply.js'
import type { AdsActor } from '../ads-mutation.service.js'
import type { SpwLaunchBody } from '../ads-sp-wizard-launch.service.js'
import { ARTIFACT_COMPILERS, compileArtifacts, type ArtifactCompiler, type ArtifactSlot } from './artifacts.js'
import type { BuildPlan } from './build-preview.js'
import type { TemplateDoc } from './doc.js'
import { recordPlaybookApply, type PlaybookApplyWriter } from './write.js'

export { planBuild, type BuildPlan } from './build-preview.js'

/** A RUNNING build with no progress for this long stopped (a deploy or a restart): it is marked FAILED, never resumed. */
export const STALE_RUN_MS = 30 * 60_000

/** What the run row keeps of its build, beside the plan (options). */
export interface BuildRunOptions {
  source: 'playbook'
  changeSetId: string
  playbookId: string
  productId: string
  compiledVersion: number
  compiledTemplateVersion: number | null
  portfolio: BuildPlan['portfolio']
  productAds: BuildPlan['productAds']
  /** Whose request it is: the campaigns are flagged suppressed by them. */
  requester: AdsActor
  writer: PlaybookApplyWriter
  /** The resolved template doc the build compiled (the artifacts compile from it). */
  doc: TemplateDoc
  /** The slots it builds. */
  slots: string[]
  /** After the run: each built slot's placements, applied at START (a campaign off the allowlist is refused them). */
  deferredPlacements?: Array<{ slot: string; campaignId: string; placementBidding: PlannedCampaign['placementBidding'] }>
  /** After the run: the portfolio the campaigns joined. */
  portfolioId?: string | null
}

const kindOf = (c: PlannedCampaign): 'auto' | 'keyword' | 'pat' => {
  if (c.targetingType === 'AUTO') return 'auto'
  const positives = c.adGroups.flatMap((g) => g.targets.filter((t) => !t.isNegative))
  return positives.some((t) => (t.kind ?? '').toUpperCase() === 'PRODUCT') ? 'pat' : 'keyword'
}
const eur = (cents: number | null | undefined) => (cents ?? 0) / 100
const STRATEGIES = ['LEGACY_FOR_SALES', 'AUTO_FOR_SALES', 'MANUAL'] as const

/**
 * The wizard's body for a build (pure): one campaign per slot (its id is the slot key, so the launch's `slots` answer
 * maps each slot to its campaign and ad group), the products by seller SKU (the template's FBA / FBM choice), no
 * placements (START), no rules (the harvest rule is the playbook's own, PB-6), no bid strategy rules (the engines and the
 * ads strategy steer bids).
 */
export function wizardBodyOf(plan: Pick<BuildPlan, 'market' | 'nameToken' | 'campaigns' | 'productAds'>, portfolioId: string | null): SpwLaunchBody {
  return {
    market: plan.market,
    productGroupName: plan.nameToken ?? undefined,
    products: plan.productAds.flatMap((a) => a.skus.map((sku) => ({ sku, asin: a.asin }))),
    campaigns: plan.campaigns.map((c) => {
      const g = c.adGroups[0]
      const targets = g?.targets ?? []
      const positive = targets.filter((t) => !t.isNegative)
      const negative = targets.filter((t) => t.isNegative)
      const kind = (t: { kind: string }) => (t.kind ?? '').toUpperCase()
      const strategy = (STRATEGIES as readonly string[]).includes(c.biddingStrategy ?? '') ? (c.biddingStrategy as (typeof STRATEGIES)[number]) : undefined
      return {
        id: c.role,
        name: c.name,
        adGroupName: g?.name ?? c.name,
        kind: kindOf(c),
        bidEur: eur(g?.defaultBidCents),
        budgetEur: Number(c.dailyBudget ?? 0),
        keywords: positive.filter((t) => kind(t) === 'KEYWORD').map((t) => ({ text: t.expression, matchType: t.expressionType as 'BROAD' | 'PHRASE' | 'EXACT', bidEur: eur(t.bidCents ?? g?.defaultBidCents) })),
        productTargets: positive.filter((t) => kind(t) === 'PRODUCT').map((t) => ({ asin: t.expression })),
        autoGroups: positive.filter((t) => kind(t) === 'AUTO' && t.autoClause).map((t) => ({ key: t.autoClause as string, enabled: true, bidEur: eur(t.bidCents ?? g?.defaultBidCents) })),
        negKeywords: negative.filter((t) => kind(t) === 'KEYWORD').map((t) => ({ text: t.expression, matchType: t.expressionType === 'PHRASE' ? 'PHRASE' as const : 'EXACT' as const })),
        negProducts: negative.filter((t) => kind(t) === 'PRODUCT').map((t) => ({ asin: t.expression })),
        ...(strategy ? { biddingStrategy: strategy } : {}),
      }
    }),
    ...(portfolioId ? { portfolioId } : {}),
  }
}

type RunRow = { id: string; status: string; progress: unknown; createdAt: Date; startedAt: Date | null; createdCampaignIds: string[]; errors: string[]; options: unknown }
const RUN_SELECT = { id: true, status: true, progress: true, createdAt: true, startedAt: true, createdCampaignIds: true, errors: true, options: true } as const

/** When a run last moved: its progress stamp, else when it started. */
function lastMoved(row: Pick<RunRow, 'progress' | 'startedAt' | 'createdAt'>): number {
  const at = (row.progress as { at?: unknown } | null)?.at
  const stamp = typeof at === 'string' ? Date.parse(at) : NaN
  return Number.isFinite(stamp) ? stamp : (row.startedAt ?? row.createdAt).getTime()
}

/** A RUNNING row that has not moved for STALE_RUN_MS: its build stopped (a deploy or a restart killed it). */
export const stoppedRunning = (row: Pick<RunRow, 'status' | 'progress' | 'startedAt' | 'createdAt'>, now = Date.now()) =>
  row.status === 'RUNNING' && now - lastMoved(row) > STALE_RUN_MS

/**
 * Every campaign a build made: the ids it recorded, and every campaign its change set's audit rows say it created (a
 * build killed mid-way recorded none of the last ones it made).
 */
async function campaignsMadeBy(row: Pick<RunRow, 'createdCampaignIds' | 'options'>): Promise<string[]> {
  const changeSetId = (row.options as Partial<BuildRunOptions> | null)?.changeSetId
  const logged = changeSetId
    ? (await prisma.advertisingActionLog.findMany({ where: { executionId: changeSetId, actionType: 'create_campaign', entityType: 'CAMPAIGN' }, select: { entityId: true } })).map((l) => l.entityId)
    : []
  return [...new Set([...row.createdCampaignIds, ...logged])]
}

/** Campaigns Amazon never took (no Amazon id) are archived in Nexus only — nothing is sent — so their names are free again. */
async function archiveLocalOnly(campaignIds: readonly string[]): Promise<number> {
  if (!campaignIds.length) return 0
  const r = await prisma.campaign.updateMany({ where: { id: { in: [...campaignIds] }, externalCampaignId: null, status: { not: 'ARCHIVED' } }, data: { status: 'ARCHIVED' } })
  return r.count
}

/**
 * A build that stopped: marked FAILED with every campaign it made and why, its Nexus-only records archived. Never
 * resumed: what it made is archived (archive-ads buildRunId) or adopted, then the playbook is built again.
 */
async function settleStopped(row: RunRow): Promise<void> {
  const made = await campaignsMadeBy(row)
  const campaign = (row.progress as { campaign?: unknown } | null)?.campaign
  const local = await archiveLocalOnly(made)
  await prisma.adBlueprintApplication.updateMany({
    where: { id: row.id, status: 'RUNNING' },
    data: {
      status: 'FAILED', appliedAt: new Date(), createdCampaignIds: made,
      errors: [
        ...row.errors,
        `the build stopped without finishing${typeof campaign === 'string' ? ` at "${campaign}"` : ''}: no progress for ${STALE_RUN_MS / 60_000} minutes (a deploy or a restart). `
          + `It does not resume: archive what it made (archive-ads buildRunId ${row.id}) or adopt it, then build again.`
          + (local ? ` ${local} campaign record(s) Amazon never took were archived in Nexus.` : ''),
      ],
    },
  })
  logger.warn('[PB-5] a playbook build stopped and was marked FAILED', { applicationId: row.id, campaigns: made.length })
}

/** Every RUNNING playbook build of this product (by its name token) in this market, or of this playbook, that stopped. */
export async function settleStoppedBuilds(where: { market: string; productToken: string; playbookId?: string | null }, now = Date.now()): Promise<number> {
  const rows = await prisma.adBlueprintApplication.findMany({
    where: {
      status: 'RUNNING', playbookId: { not: null },
      OR: [{ marketplace: where.market, productToken: { equals: where.productToken, mode: 'insensitive' } }, ...(where.playbookId ? [{ playbookId: where.playbookId }] : [])],
    },
    select: RUN_SELECT,
  })
  const stopped = rows.filter((r) => stoppedRunning(r, now))
  for (const row of stopped) await settleStopped(row)
  return stopped.length
}

/** One stopped playbook build, settled (FAILED, with what it made); a no-op for any other run. The execute paths call it. */
export async function settleStoppedBuild(applicationId: string, now = Date.now()): Promise<boolean> {
  const row = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: { not: null } }, select: RUN_SELECT })
  if (!row || !stoppedRunning(row, now)) return false
  await settleStopped(row)
  return true
}

/**
 * A build in flight for this product (by its name token) in this market, or for this playbook; null when none.
 * `settle` (the execute path and the guards): a build that stopped is marked FAILED first and holds nothing. Without it
 * (a dry run, which writes nothing) a stopped one is only said: `stopped: true`.
 */
export async function inFlightRefusal(market: string, productToken: string, playbookId: string, opts: { settle?: boolean; now?: number } = {}): Promise<{ applicationId: string; campaign: string | null; stopped: boolean } | null> {
  const now = opts.now ?? Date.now()
  if (opts.settle) await settleStoppedBuilds({ market, productToken, playbookId }, now)
  const row = await prisma.adBlueprintApplication.findFirst({
    where: { status: 'RUNNING', OR: [{ marketplace: market, productToken: { equals: productToken, mode: 'insensitive' } }, { playbookId }] },
    orderBy: { createdAt: 'desc' },
    select: { id: true, status: true, progress: true, startedAt: true, createdAt: true },
  })
  if (!row) return null
  const campaign = (row.progress as { campaign?: unknown } | null)?.campaign
  return { applicationId: row.id, campaign: typeof campaign === 'string' ? campaign : null, stopped: stoppedRunning(row, now) }
}

/**
 * Claim the run row and run the build detached. `actor`: the approver (every write is theirs); `requester`: who asked
 * (the campaigns are flagged suppressed by them). Answers the id of a run already in flight instead of a second one.
 */
export async function startPlaybookBuild(input: {
  plan: BuildPlan; actor: AdsActor; requester: AdsActor; changeSetId: string; writer: PlaybookApplyWriter
  /** Tests: the artifact compilers (default ARTIFACT_COMPILERS). */
  compilers?: readonly ArtifactCompiler[]
}): Promise<{ applicationId: string; alreadyRunning?: boolean } | { refusal: string }> {
  const { plan } = input
  if (!plan.playbook || !plan.applyPlan || !plan.doc || !plan.nameToken) return { refusal: 'the build has no compiled plan' }
  // A build that stopped is settled first (it holds nothing); the claim itself is below, under a lock.
  await settleStoppedBuilds({ market: plan.market, productToken: plan.nameToken, playbookId: plan.playbook.id })
  const options: BuildRunOptions = {
    source: 'playbook',
    changeSetId: input.changeSetId,
    playbookId: plan.playbook.id,
    productId: plan.product.productId,
    compiledVersion: plan.playbook.version,
    compiledTemplateVersion: plan.template?.version ?? null,
    portfolio: plan.portfolio,
    productAds: plan.productAds,
    requester: input.requester,
    writer: input.writer,
    doc: plan.doc,
    slots: plan.campaigns.map((c) => c.role),
  }
  // PB-6c (review) — check and claim in ONE transaction under a lock per product token and market: two approvals that
  // arrive together (a build and a hero of one product) can never both find nothing running and start two runs.
  const playbook = plan.playbook
  const nameToken = plan.nameToken
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-playbook-build', workspaceIdForQuery(), plan.market, nameToken.toLowerCase()])}, 0))`
    const running = await tx.adBlueprintApplication.findFirst({
      where: { status: 'RUNNING', OR: [{ marketplace: plan.market, productToken: { equals: nameToken, mode: 'insensitive' } }, { playbookId: playbook.id }] },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (running) return { applicationId: running.id, alreadyRunning: true as const }
    const row = await tx.adBlueprintApplication.create({
      data: {
        blueprintId: null,
        productToken: nameToken,
        marketplace: plan.market,
        asins: plan.productAds.map((a) => a.asin),
        status: 'RUNNING',
        startedAt: new Date(),
        plan: plan.applyPlan as unknown as object,
        launchMode: 'floor',
        actor: input.actor,
        playbookId: playbook.id,
        options: options as unknown as object,
        progress: { done: 0, total: plan.campaigns.length, campaign: null, created: 0, at: new Date().toISOString() } as object,
      },
      select: { id: true },
    })
    return { applicationId: row.id }
  })
  if ('alreadyRunning' in claimed) return claimed
  const row = { id: claimed.applicationId }
  void runPlaybookBuild(row.id, { compilers: input.compilers }).catch(async (e) => {
    logger.error('[PB-5] detached playbook build threw', { applicationId: row.id, error: (e as Error).message })
    // A thrown run must not sit at RUNNING for ever: it would block the next build on the in-flight guard.
    await prisma.adBlueprintApplication.update({
      where: { id: row.id },
      data: { status: 'FAILED', errors: [`the build stopped: ${(e as Error).message.slice(0, 300)}`], appliedAt: new Date() },
    }).catch(() => {})
  })
  return { applicationId: row.id }
}

/** One slot link of a playbook (or its portfolio link): replaced when the key is held by an archived campaign's link. */
async function writeLink(link: { playbookId: string; kind: string; key: string; refId: string; adGroupId?: string | null; origin: 'built' | 'adopted'; compiledVersion: number; updatedBy: string }): Promise<string | null> {
  try {
    const held = await prisma.adsPlaybookLink.findFirst({ where: { kind: link.kind, refId: link.refId }, select: { playbookId: true, key: true } })
    if (held && (held.playbookId !== link.playbookId || held.key !== link.key)) return `${link.kind} ${link.refId} is already linked to another playbook or slot: not linked`
    const data = { refId: link.refId, adGroupId: link.adGroupId ?? null, origin: link.origin, compiledVersion: link.compiledVersion, updatedBy: link.updatedBy }
    const mine = await prisma.adsPlaybookLink.findFirst({ where: { playbookId: link.playbookId, kind: link.kind, key: link.key }, select: { id: true } })
    if (mine) await prisma.adsPlaybookLink.update({ where: { id: mine.id }, data })
    else await prisma.adsPlaybookLink.create({ data: { playbookId: link.playbookId, kind: link.kind, key: link.key, ...data } })
    return null
  } catch (e) {
    return `link ${link.kind} ${link.key}: ${(e as Error).message.slice(0, 160)}`
  }
}

/** The rank role each slot plays (for the artifacts). */
const rankRoleOf = (doc: TemplateDoc, key: string): ArtifactSlot['rankRole'] => doc.structure.slots.find((s) => s.key === key)?.rankRole ?? 'none'

type LaunchAnswer = {
  ok?: boolean
  error?: string
  created?: Array<{ name: string; campaignId: string; externalCampaignId: string | null }>
  slots?: Record<string, { campaignId: string; adGroupId: string }>
  launch?: { campaigns?: Array<{ name: string; status: string; reason: string | null; failed?: Array<{ step: string; item: string; reason: string }> }> }
  verification?: { ok?: boolean; problems?: string[] } | null
  portfolioCheck?: { repairFailed?: number } | null
}

/** The build itself, against its claimed row (detached). Every outcome is written to the row; nothing resumes by itself. */
export async function runPlaybookBuild(applicationId: string, opts: { compilers?: readonly ArtifactCompiler[] } = {}): Promise<void> {
  const row = await prisma.adBlueprintApplication.findUnique({ where: { id: applicationId } })
  if (!row || row.status !== 'RUNNING') return
  const options = row.options as unknown as BuildRunOptions
  const plan = row.plan as unknown as { campaigns: PlannedCampaign[] }
  const actor = (row.actor ?? options.requester) as AdsActor
  const errors: string[] = []
  const finish = async (status: 'APPLIED' | 'PARTIAL' | 'FAILED', extra: { createdCampaignIds?: string[]; notOnAmazon?: string[]; options?: Partial<BuildRunOptions>; created?: number } = {}) => {
    await prisma.adBlueprintApplication.update({
      where: { id: applicationId },
      data: {
        status, errors, appliedAt: new Date(),
        createdCampaignIds: extra.createdCampaignIds ?? [], notOnAmazon: extra.notOnAmazon ?? [],
        options: { ...options, ...(extra.options ?? {}) } as unknown as object,
        progress: { done: plan.campaigns.length, total: plan.campaigns.length, campaign: null, created: extra.created ?? 0, at: new Date().toISOString() } as object,
      },
    })
  }

  // 1 — the portfolio: reused, else created. One Amazon does not hold (a Nexus-only local-pf- id) stops the run here:
  // the launch would refuse it anyway, and campaigns outside their portfolio are worse than none.
  let portfolioId: string | null = null
  if (options.portfolio.does === 'reuse') portfolioId = options.portfolio.portfolioId ?? null
  else if (options.portfolio.does === 'create' && options.portfolio.name) {
    try {
      const { createPortfolio } = await import('../ads-portfolio.service.js')
      const made = await createPortfolio({ name: options.portfolio.name, marketplace: row.marketplace })
      portfolioId = made.portfolio.portfolioId
    } catch (e) {
      errors.push(`the portfolio "${options.portfolio.name}" could not be made: ${(e as Error).message.slice(0, 200)}. Nothing was built.`)
      return finish('FAILED')
    }
    if (portfolioId.startsWith('local-pf-')) {
      errors.push(`the portfolio "${options.portfolio.name}" could not be made at Amazon (writes to ${row.marketplace} are closed), so nothing was built: Amazon would refuse a campaign in a portfolio it does not know.`)
      return finish('FAILED', { options: { portfolioId } })
    }
  }

  // 2 — the wizard's own launch, with the playbook's options.
  const { spWizardLaunch } = await import('../ads-sp-wizard-launch.service.js')
  const { SUPPRESSION_FLOOR_CENTS } = await import('../ads-bid-suppression.service.js')
  const body = wizardBodyOf({ market: row.marketplace, nameToken: row.productToken, campaigns: plan.campaigns, productAds: options.productAds }, portfolioId)
  const out = await spWizardLaunch(body, actor, {
    allowlistAtBirth: false,
    bornSuppressed: { floorCents: SUPPRESSION_FLOOR_CENTS, by: options.requester },
    changeSetId: options.changeSetId,
    deferPlacements: true,
    // Each campaign it made is recorded as it goes: a build killed mid-way still names what it made.
    onProgress: async (p) => {
      const { campaignIds, ...progress } = p
      await prisma.adBlueprintApplication.update({ where: { id: applicationId }, data: { progress: { ...progress, at: new Date().toISOString() } as object, createdCampaignIds: campaignIds } })
    },
  })
  const answer = out.body as LaunchAnswer
  if (out.status !== 200) {
    errors.push(`the launch refused it: ${String(answer.error ?? 'no reason given')}`)
    return finish('FAILED', { options: { portfolioId } })
  }

  // 3 — the links: each campaign Amazon holds plays its slot (origin built); the portfolio is the playbook's.
  const roleByName = new Map(plan.campaigns.map((c) => [c.name, c.role]))
  const created = answer.created ?? []
  const onAmazon = created.filter((c) => c.externalCampaignId)
  const notOnAmazon = created.filter((c) => !c.externalCampaignId).map((c) => c.campaignId)
  const slots = answer.slots ?? {}
  const updatedBy = options.writer.updatedBy
  const linked: ArtifactSlot[] = []
  for (const c of onAmazon) {
    const key = roleByName.get(c.name)
    if (!key) continue
    const adGroupId = slots[key]?.campaignId === c.campaignId ? slots[key].adGroupId : null
    const failed = await writeLink({ playbookId: options.playbookId, kind: 'slot', key, refId: c.campaignId, adGroupId, origin: 'built', compiledVersion: options.compiledVersion, updatedBy })
    if (failed) errors.push(failed)
    else linked.push({ key, campaignId: c.campaignId, adGroupId, origin: 'built', rankRole: rankRoleOf(options.doc, key) })
  }
  if (portfolioId && onAmazon.length) {
    const failed = await writeLink({ playbookId: options.playbookId, kind: 'portfolio', key: 'portfolio', refId: portfolioId, origin: options.portfolio.does === 'reuse' ? 'adopted' : 'built', compiledVersion: options.compiledVersion, updatedBy })
    if (failed) errors.push(failed)
  }

  // What reached Amazon, campaign by campaign, and the read-back.
  for (const c of answer.launch?.campaigns ?? []) {
    if (c.status === 'live') continue
    errors.push(`"${c.name}": ${c.reason ?? c.status}${c.failed?.length ? ` (${c.failed.slice(0, 3).map((f) => `${f.step} ${f.item}: ${f.reason}`).join('; ')}${c.failed.length > 3 ? '; …' : ''})` : ''}`)
  }
  if (answer.portfolioCheck?.repairFailed) errors.push(`portfolio membership could not be set for ${answer.portfolioCheck.repairFailed} campaign(s); START repairs it`)
  if (answer.verification && answer.verification.ok === false) {
    const problems = answer.verification.problems ?? []
    errors.push(...problems.slice(0, 20), ...(problems.length > 20 ? [`…and ${problems.length - 20} more problem(s) — ${problems.length} in total.`] : []))
  }

  // 4 — the artifacts hook (PB-6b, PB-7, PB-8 plug in; empty in PB-5a): created disabled, after the slot links.
  const compilers = opts.compilers ?? ARTIFACT_COMPILERS
  if (compilers.length && linked.length) {
    const existing = await prisma.adsPlaybookLink.findMany({ where: { playbookId: options.playbookId, kind: { notIn: ['slot', 'portfolio'] } }, select: { kind: true, key: true, refId: true } })
    const allSlots = await prisma.adsPlaybookLink.findMany({ where: { playbookId: options.playbookId, kind: 'slot' }, select: { key: true, refId: true, adGroupId: true, origin: true } })
    const result = await compileArtifacts({
      playbookId: options.playbookId, market: row.marketplace, productId: options.productId, nameToken: row.productToken, doc: options.doc,
      slots: allSlots.map((s) => ({ key: s.key, campaignId: s.refId, adGroupId: s.adGroupId, origin: s.origin === 'adopted' ? 'adopted' : 'built', rankRole: rankRoleOf(options.doc, s.key) })),
      mode: 'build', actor, changeSetId: options.changeSetId, compiledVersion: options.compiledVersion,
    }, existing, compilers)
    errors.push(...result.errors)
    for (const l of result.links) {
      const failed = await writeLink({ playbookId: options.playbookId, kind: l.kind, key: l.key, refId: l.refId, origin: 'built', compiledVersion: options.compiledVersion, updatedBy })
      if (failed) errors.push(failed)
    }
  }

  // A campaign Amazon never took is a FAILED record holding its name: archived in Nexus (nothing is sent), so the next
  // build of that slot is not refused for a name only Nexus holds.
  const freed = await archiveLocalOnly(notOnAmazon)
  if (freed) errors.push(`${freed} campaign record(s) Amazon never took were archived in Nexus, so their names are free for the next build`)

  // 5 — the run's status and the row's state.
  const byRole = new Map(plan.campaigns.map((c) => [c.role, c]))
  const deferredPlacements = linked
    .filter((l) => (byRole.get(l.key)?.placementBidding ?? []).length)
    .map((l) => ({ slot: l.key, campaignId: l.campaignId, placementBidding: byRole.get(l.key)!.placementBidding }))
  const status = !onAmazon.length ? 'FAILED' : (errors.length || notOnAmazon.length) ? 'PARTIAL' : 'APPLIED'
  await finish(status, { createdCampaignIds: created.map((c) => c.campaignId), notOnAmazon, options: { portfolioId, deferredPlacements }, created: created.length })
  if (onAmazon.length) {
    try {
      const current = await prisma.adsPlaybook.findUnique({ where: { id: options.playbookId }, select: { state: true } })
      await recordPlaybookApply(options.playbookId, {
        op: 'build', state: current?.state === 'RUNNING' ? 'RUNNING' : 'BUILT',
        compiledVersion: options.compiledVersion, compiledTemplateVersion: options.compiledTemplateVersion,
        reason: `build ${applicationId}: ${onAmazon.length} campaign(s) at the floor, off the live-write allowlist`,
      }, { ...options.writer, approvalId: options.changeSetId })
    } catch (e) {
      logger.error('[PB-5] the playbook row did not record the build', { applicationId, error: (e as Error).message })
      await prisma.adBlueprintApplication.update({ where: { id: applicationId }, data: { errors: [...errors, `the playbook row did not record the build: ${(e as Error).message.slice(0, 160)}`] } }).catch(() => {})
    }
  }
  logger.info('[PB-5] playbook build finished', { applicationId, status, created: created.length, onAmazon: onAmazon.length, errors: errors.length })
}

/**
 * The campaigns a playbook build made that are not archived yet (archive-ads buildRunId, the undo of a build), or why
 * they cannot be named: no such build, or one still running (it is not undone while it creates).
 */
export async function buildRunCampaigns(applicationId: string, now = Date.now()): Promise<{ campaignIds: string[]; status: string; stopped?: true } | { refusal: string }> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: { not: null } }, select: RUN_SELECT })
  if (!run) return { refusal: `Playbook build ${applicationId} not found in this business (buildRunId: the applicationId apply-ads-playbook answered).` }
  // Read only: a build that stopped holds nothing and names what it made (archive-ads' execute settles it first).
  const stopped = stoppedRunning(run, now)
  if (run.status === 'RUNNING' && !stopped) return { refusal: 'Not queued: that build is still running. Follow it with ads-playbook view build, and archive what it made once it ends.' }
  const made = await campaignsMadeBy(run)
  // Only what Amazon holds is archived at Amazon; a record Amazon never took is archived in Nexus by the build itself.
  const live = made.length
    ? await prisma.campaign.findMany({ where: { id: { in: made }, status: { not: 'ARCHIVED' }, externalCampaignId: { not: null } }, select: { id: true } })
    : []
  return { campaignIds: live.map((c) => c.id), status: stopped ? 'FAILED' : run.status, ...(stopped ? { stopped: true as const } : {}) }
}

/** Every campaign a playbook build made (archived or not), for the places a change lands; null when there is no such build. */
export async function buildRunCreated(applicationId: string): Promise<string[] | null> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: { not: null } }, select: RUN_SELECT })
  return run ? campaignsMadeBy(run) : null
}

/** A build's run as approval-status follows it: its status, how far it is, the campaigns it made and how many errors. */
export async function buildRunDelivery(applicationId: string): Promise<{ status: string; done: number | null; total: number | null; createdCampaignIds: string[]; errors: number } | null> {
  const run = await prisma.adBlueprintApplication.findFirst({ where: { id: applicationId, playbookId: { not: null } }, select: { status: true, progress: true, createdCampaignIds: true, errors: true } })
  if (!run) return null
  const progress = (run.progress ?? {}) as { done?: unknown; total?: unknown }
  return {
    status: run.status, done: typeof progress.done === 'number' ? progress.done : null, total: typeof progress.total === 'number' ? progress.total : null,
    createdCampaignIds: run.createdCampaignIds, errors: run.errors.length,
  }
}

/** A build run as the playbook's read shows it (view build): no plan, no money. */
export async function buildRunsOf(where: { applicationId: string } | { playbookIds: string[] }, limit = 10) {
  const rows = await prisma.adBlueprintApplication.findMany({
    where: 'applicationId' in where ? { id: where.applicationId, playbookId: { not: null } } : { playbookId: { in: where.playbookIds } },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { id: true, playbookId: true, marketplace: true, productToken: true, status: true, progress: true, createdCampaignIds: true, notOnAmazon: true, errors: true, startedAt: true, appliedAt: true, createdAt: true, launchMode: true, options: true },
  })
  const ids = [...new Set(rows.flatMap((r) => r.createdCampaignIds))]
  const campaigns = ids.length
    ? await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, status: true, externalCampaignId: true, liveBidWritesEnabled: true, bidsSuppressedAt: true } })
    : []
  const byId = new Map(campaigns.map((c) => [c.id, c]))
  return rows.map((r) => {
    const o = (r.options ?? {}) as Partial<BuildRunOptions>
    return {
      applicationId: r.id, playbookId: r.playbookId, market: r.marketplace, status: r.status, launchMode: r.launchMode,
      startedAt: r.startedAt?.toISOString() ?? null, finishedAt: r.appliedAt?.toISOString() ?? null,
      progress: r.progress, changeSetId: o.changeSetId ?? null, compiledVersion: o.compiledVersion ?? null, slots: o.slots ?? [],
      ...(stoppedRunning(r) ? { stopped: `no progress for ${STALE_RUN_MS / 60_000} minutes: it stopped and will not resume (the next build, or archive-ads buildRunId, marks it FAILED)` } : {}),
      created: r.createdCampaignIds.map((id) => {
        const c = byId.get(id)
        return { campaignId: id, name: c?.name ?? null, status: c ? String(c.status) : 'NOT_FOUND', atAmazon: !!c?.externalCampaignId, liveWrites: c?.liveBidWritesEnabled ?? false, atFloor: !!c?.bidsSuppressedAt }
      }),
      notOnAmazon: r.notOnAmazon, errors: r.errors,
      placementsAtStart: (o.deferredPlacements ?? []).map((d) => ({ slot: d.slot, campaignId: d.campaignId, placements: d.placementBidding.length })),
    }
  })
}
