/**
 * B-3 — the run of a one-off SP Super Wizard set Claude asked for (build-sp-wizard-campaigns), DETACHED as the ads
 * playbook's build runs (ads-playbook/build.ts): a set is hundreds of sequential Amazon writes and takes minutes, so it
 * never runs inside the approval. The approval claims a run row and records the change (the run's id) at once; the work
 * runs on its own, recording each campaign it makes as it goes, so undo (archive-ads buildRunId) always finds them.
 *
 *   row        AdBlueprintApplication — the table Replicate and the playbook's builds keep their runs in — with
 *              `options.source` 'sp-wizard' (CLAUDE_BUILD_RUN), no blueprint, no live source and no playbook: Replicate's
 *              history leaves it out and its raise and rollback refuse it (ads-blueprint-apply.service.ts WIZARD_RUN).
 *              `plan` holds the wizard launch body the person approved.
 *   one set    one run at a time per set name and market: a run still in flight is answered with its id. One that
 *              stopped advancing (no progress for 30 minutes: a deploy or a restart killed it) is marked FAILED with
 *              every campaign its change set's audit rows say it made when the same set is asked for again or when it
 *              is archived (archive-ads buildRunId); until then approval-status says it stopped. It never resumes.
 *   launch     the wizard's own launch (ads-sp-wizard-launch.service.ts) with the playbook build's options: born at the
 *              2¢ floor with the planned bids remembered (suppressed by the person who asked, never paused), off the
 *              live-write allowlist, the approval as change set on every audit row, no placements (kept on the row).
 *   end        APPLIED · PARTIAL · FAILED with what reached Amazon and why not; a campaign Amazon never took is archived
 *              in Nexus (nothing is sent), so its name is free for the next set.
 */
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import type { AdsActor } from './ads-mutation.service.js'
import type { SpwLaunchBody } from './ads-sp-wizard-launch.service.js'
import { archiveLocalOnly, campaignsMadeBy, settleStoppedBuild } from './ads-playbook/build.js'

export const WIZARD_RUN_SOURCE = 'sp-wizard'

/** What the run row keeps of its set, beside the launch body (`plan`). */
export interface WizardRunOptions {
  source: typeof WIZARD_RUN_SOURCE
  changeSetId: string
  /** Whose request it is: the campaigns are flagged suppressed by them. */
  requester: AdsActor
  structure: string
  /** After the run: each campaign's placements as set-placement-multipliers takes them, to ask once it is on the allowlist. */
  placementsToAsk?: Array<{ campaignId: string; topOfSearchPct?: number; productPagesPct?: number; restOfSearchPct?: number }>
}

const PLACEMENT_ARG: Record<string, 'topOfSearchPct' | 'productPagesPct' | 'restOfSearchPct'> = { PLACEMENT_TOP: 'topOfSearchPct', PLACEMENT_PRODUCT_PAGE: 'productPagesPct', PLACEMENT_REST_OF_SEARCH: 'restOfSearchPct' }

/** Every RUNNING wizard run of this set in this market that stopped is settled (FAILED, with what it made). */
async function settleStoppedSets(market: string, setName: string): Promise<void> {
  const running = await prisma.adBlueprintApplication.findMany({
    where: { status: 'RUNNING', marketplace: market, productToken: { equals: setName, mode: 'insensitive' }, options: { path: ['source'], equals: WIZARD_RUN_SOURCE } },
    select: { id: true },
  })
  for (const r of running) await settleStoppedBuild(r.id)
}

/**
 * Claim the run row and run the set detached. `actor`: the approver (every write is theirs); `requester`: who asked.
 * Answers the id of a run already in flight for this set name and market (any builder's) instead of a second one.
 */
export async function startWizardBuild(input: {
  body: SpwLaunchBody; market: string; setName: string; asins: string[]; structure: string
  actor: AdsActor; requester: AdsActor; changeSetId: string
}): Promise<{ applicationId: string; alreadyRunning?: true }> {
  await settleStoppedSets(input.market, input.setName)
  const options: WizardRunOptions = { source: WIZARD_RUN_SOURCE, changeSetId: input.changeSetId, requester: input.requester, structure: input.structure }
  const total = input.body.campaigns?.length ?? 0
  // Check and claim in ONE transaction under a lock per set name and market: two approvals of one set that arrive
  // together never both start.
  const claimed = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(['nexus-playbook-build', workspaceIdForQuery(), input.market, input.setName.toLowerCase()])}, 0))`
    const running = await tx.adBlueprintApplication.findFirst({
      where: { status: 'RUNNING', marketplace: input.market, productToken: { equals: input.setName, mode: 'insensitive' } },
      orderBy: { createdAt: 'desc' },
      select: { id: true },
    })
    if (running) return { applicationId: running.id, alreadyRunning: true as const }
    const row = await tx.adBlueprintApplication.create({
      data: {
        blueprintId: null,
        productToken: input.setName,
        marketplace: input.market,
        asins: input.asins,
        status: 'RUNNING',
        startedAt: new Date(),
        plan: input.body as unknown as object,
        launchMode: 'floor',
        actor: input.actor,
        options: options as unknown as object,
        progress: { done: 0, total, campaign: null, created: 0, at: new Date().toISOString() } as object,
      },
      select: { id: true },
    })
    return { applicationId: row.id }
  })
  if ('alreadyRunning' in claimed) return claimed
  const id = claimed.applicationId
  void runWizardBuild(id).catch(async (e) => {
    logger.error('[B-3] detached SP Super Wizard build threw', { applicationId: id, error: (e as Error).message })
    // A thrown run must not sit at RUNNING: it names every campaign its change set made, and frees what Amazon never took.
    try {
      const made = await campaignsMadeBy({ createdCampaignIds: [], options })
      const freed = await archiveLocalOnly(made)
      await prisma.adBlueprintApplication.update({
        where: { id },
        data: {
          status: 'FAILED', appliedAt: new Date(), createdCampaignIds: made,
          errors: [`the build stopped: ${(e as Error).message.slice(0, 300)}${freed ? `; ${freed} campaign record(s) Amazon never took were archived in Nexus` : ''}`],
        },
      })
    } catch (err) {
      logger.error('[B-3] could not record a thrown SP Super Wizard build', { applicationId: id, error: (err as Error).message })
    }
  })
  return { applicationId: id }
}

type LaunchAnswer = {
  error?: string
  created?: Array<{ name: string; campaignId: string; externalCampaignId: string | null }>
  launch?: { campaigns?: Array<{ name: string; status: string; reason: string | null; failed?: Array<{ step: string; item: string; reason: string }> }> }
  verification?: { ok?: boolean; problems?: string[] } | null
  portfolioCheck?: { repairFailed?: number } | null
  deferredPlacements?: Array<{ campaignId: string; adjustments: Array<{ placement: string; percentage: number }> }>
}

/** The set itself, against its claimed row (detached). Every outcome is written to the row; nothing resumes by itself. */
export async function runWizardBuild(applicationId: string): Promise<void> {
  const row = await prisma.adBlueprintApplication.findUnique({ where: { id: applicationId } })
  if (!row || row.status !== 'RUNNING') return
  const options = row.options as unknown as WizardRunOptions
  const body = row.plan as unknown as SpwLaunchBody
  const total = body.campaigns?.length ?? 0
  const errors: string[] = []
  const finish = async (status: 'APPLIED' | 'PARTIAL' | 'FAILED', extra: { createdCampaignIds?: string[]; notOnAmazon?: string[]; created?: number; placementsToAsk?: WizardRunOptions['placementsToAsk'] } = {}) => {
    await prisma.adBlueprintApplication.update({
      where: { id: applicationId },
      data: {
        status, errors, appliedAt: new Date(),
        createdCampaignIds: extra.createdCampaignIds ?? [], notOnAmazon: extra.notOnAmazon ?? [],
        options: { ...options, ...(extra.placementsToAsk?.length ? { placementsToAsk: extra.placementsToAsk } : {}) } as unknown as object,
        progress: { done: total, total, campaign: null, created: extra.created ?? 0, at: new Date().toISOString() } as object,
      },
    })
  }

  const { spWizardLaunch } = await import('./ads-sp-wizard-launch.service.js')
  const { SUPPRESSION_FLOOR_CENTS } = await import('./ads-bid-suppression.service.js')
  const out = await spWizardLaunch(body, (row.actor ?? options.requester) as AdsActor, {
    allowlistAtBirth: false,
    bornSuppressed: { floorCents: SUPPRESSION_FLOOR_CENTS, by: options.requester },
    changeSetId: options.changeSetId,
    deferPlacements: true,
    // Each campaign it made is recorded as it goes: a run killed mid-way still names what it made.
    onProgress: async (p) => {
      const { campaignIds, ...progress } = p
      await prisma.adBlueprintApplication.update({ where: { id: applicationId }, data: { progress: { ...progress, at: new Date().toISOString() } as object, createdCampaignIds: campaignIds } })
    },
  })
  const answer = out.body as LaunchAnswer
  if (out.status !== 200) {
    errors.push(`the SP Super Wizard refused it: ${String(answer.error ?? 'no reason given')}. Nothing was created.`)
    return finish('FAILED')
  }

  const created = answer.created ?? []
  const onAmazon = created.filter((c) => c.externalCampaignId)
  const notOnAmazon = created.filter((c) => !c.externalCampaignId).map((c) => c.campaignId)
  for (const c of answer.launch?.campaigns ?? []) {
    if (c.status === 'live') continue
    errors.push(`"${c.name}": ${c.reason ?? c.status}${c.failed?.length ? ` (${c.failed.slice(0, 3).map((f) => `${f.step} ${f.item}: ${f.reason}`).join('; ')}${c.failed.length > 3 ? '; …' : ''})` : ''}`)
  }
  // Off the allowlist the launch's portfolio repair is refused: the six-hourly structural reconcile puts a campaign Amazon
  // holds outside its portfolio back in once it is on the allowlist (ads-structural-reconcile.service.ts).
  if (answer.portfolioCheck?.repairFailed) {
    errors.push(`${answer.portfolioCheck.repairFailed} campaign(s) are not in the portfolio at Amazon yet: the structural reconcile (every six hours) puts them in once each is on the live-write allowlist`)
  }
  if (answer.verification && answer.verification.ok === false) {
    const problems = answer.verification.problems ?? []
    errors.push(...problems.slice(0, 20), ...(problems.length > 20 ? [`…and ${problems.length - 20} more problem(s) — ${problems.length} in total.`] : []))
  }
  // A campaign Amazon never took is a FAILED record holding its name: archived in Nexus (nothing is sent), so the set can
  // be asked for again.
  const freed = await archiveLocalOnly(notOnAmazon)
  if (freed) errors.push(`${freed} campaign record(s) Amazon never took were archived in Nexus, so their names are free again`)
  const placementsToAsk = (answer.deferredPlacements ?? [])
    .filter((d) => d.adjustments.length && onAmazon.some((c) => c.campaignId === d.campaignId))
    .map((d) => ({ campaignId: d.campaignId, ...Object.fromEntries(d.adjustments.filter((x) => PLACEMENT_ARG[x.placement]).map((x) => [PLACEMENT_ARG[x.placement], x.percentage])) }))
  const status = !onAmazon.length ? 'FAILED' : (errors.length || notOnAmazon.length) ? 'PARTIAL' : 'APPLIED'
  await finish(status, { createdCampaignIds: created.map((c) => c.campaignId), notOnAmazon, created: created.length, placementsToAsk })
  logger.info('[B-3] SP Super Wizard set finished', { applicationId, status, created: created.length, onAmazon: onAmazon.length, errors: errors.length })
}
