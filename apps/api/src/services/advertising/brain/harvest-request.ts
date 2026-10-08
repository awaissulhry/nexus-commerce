/**
 * ONE BRAIN AB-11 — what the `apply-brain-harvest` request reads and writes about a harvest (services/agents/tools/
 * ads-brain-harvest.tools.ts composes its preview from these facts; the advertising tables stay inside the advertising
 * context, scripts/check-context-boundary.mjs). Reads the harvest, its destination and its sources as they are NOW, so an
 * approval runs on what the person saw or not at all.
 */
import prisma from '../../../db.js'
import { productCampaigns } from './ownership.js'
import { sourcesOf, type SourceState } from './harvest-write.js'

type Place = { id: string; name: string; campaign: { id: string; name: string; marketplace: string | null } }
export type HarvestRecord = NonNullable<Awaited<ReturnType<typeof findHarvest>>>

/** A harvest the request may write: decided, asked for, or half done. */
export const WRITABLE = ['SHADOW', 'HELD', 'PROPOSED', 'HALF_DONE'] as const

function findHarvest(id: string) {
  return prisma.adsBrainHarvest.findUnique({ where: { id } })
}

export const placeWords = (g: { name: string; campaign: { name: string } }) => `ad group "${g.name}" of campaign "${g.campaign.name}"`

export type HarvestFacts =
  | { error: string }
  | {
    op: 'harvest'
    record: HarvestRecord
    dest: Place & { campaign: Place['campaign'] & { dailyBudgetCurrency: string | null } }
    owed: Array<SourceState & { place: Place }>
  }
  | { op: 'undo'; record: HarvestRecord; keyword: Place | null; pause: boolean; standing: Array<{ id: string; place: Place }> }

/** The facts of one request (op harvest or undo), as they are now; or why it cannot be asked for. */
export async function harvestRequestFacts(harvestId: string, op: 'harvest' | 'undo'): Promise<HarvestFacts> {
  const record = await findHarvest(harvestId)
  if (!record) return { error: `Not queued: ads brain harvest ${harvestId} was not found in this business (ads-brain view harvest lists them).` }
  const place = { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true } } } as const
  if (op === 'undo') {
    if (!['DONE', 'HALF_DONE', 'UNDO_PROPOSED'].includes(record.status) || !record.keywordTargetId) return { error: `Not queued: harvest ${record.id} of "${record.term}" is ${record.status}: there is nothing of it to put back.` }
    const negatives = sourcesOf(record.sources).map((s) => s.negativeTargetId).filter((x): x is string => !!x)
    const rows = await prisma.adTarget.findMany({ where: { id: { in: [record.keywordTargetId, ...negatives] } }, select: { id: true, isNegative: true, status: true, adGroup: { select: place } } })
    const keyword = rows.find((r) => r.id === record.keywordTargetId && !r.isNegative) ?? null
    const pause = !!keyword && String(keyword.status) === 'ENABLED'
    const standing = rows.filter((r) => r.isNegative && String(r.status) !== 'ARCHIVED').map((r) => ({ id: r.id, place: r.adGroup }))
    if (!pause && !standing.length) return { error: `Nothing of harvest ${record.id} is left to put back: its keyword is not enabled and its source negatives are retired.` }
    return { op, record, keyword: keyword?.adGroup ?? null, pause, standing }
  }
  if (record.destinationKind !== 'EXISTING') return { error: `Not queued: harvest ${record.id} of "${record.term}" needs a new campaign — the brain asked for it through create-ad-campaign; its sources are negated once that campaign is live.` }
  if (!(WRITABLE as readonly string[]).includes(record.status)) return { error: `Not queued: harvest ${record.id} of "${record.term}" is ${record.status}, not waiting to be written.` }
  if (!record.destAdGroupId || record.bidCents == null) return { error: `Not queued: harvest ${record.id} of "${record.term}" names no destination or start bid (${record.heldBy ?? record.why}).` }
  const dest = await prisma.adGroup.findUnique({ where: { id: record.destAdGroupId }, select: { id: true, name: true, status: true, campaign: { select: { id: true, name: true, marketplace: true, status: true, bidsSuppressedAt: true, dailyBudgetCurrency: true } } } })
  if (!dest) return { error: `Not queued: the destination ad group ${record.destAdGroupId} is no longer in Nexus.` }
  if (String(dest.campaign.status) !== 'ENABLED' || String(dest.status) !== 'ENABLED' || dest.campaign.bidsSuppressedAt) {
    return { error: `Not queued: ${placeWords(dest)} does not serve now (paused, or its bids suppressed): a harvest there would block the source for a keyword that does not show.` }
  }
  // A winner is never moved: a term that found a home in another of the product's ad groups meanwhile is not harvested.
  if (!record.keywordTargetId) {
    const owned = await productCampaigns(record.productId, record.marketplace)
    const groupIds = owned ? (await prisma.adGroup.findMany({ where: { campaignId: { in: owned.owned.map((o) => o.campaignId) } }, select: { id: true } })).map((g) => g.id).filter((id) => id !== dest.id) : []
    const home = groupIds.length ? await prisma.adTarget.findFirst({
      where: { adGroupId: { in: groupIds }, isNegative: false, status: { not: 'ARCHIVED' }, kind: record.isAsin ? 'PRODUCT' : 'KEYWORD', ...(record.isAsin ? {} : { expressionType: { in: ['EXACT', '_EXACT'] } }), expressionValue: { equals: record.term, mode: 'insensitive' } },
      select: { adGroup: { select: { name: true, campaign: { select: { name: true } } } } },
    }) : null
    if (home) return { error: `Not queued: "${record.term}" has a home now in ${placeWords(home.adGroup)}: a winner is never moved, so it is not harvested again.` }
  }
  const owed = sourcesOf(record.sources).filter((s) => s.action === 'negate' && s.result !== 'landed')
  const groups = new Map((owed.length ? await prisma.adGroup.findMany({ where: { id: { in: owed.map((s) => s.adGroupId) } }, select: place }) : []).map((g) => [g.id, g]))
  const missing = owed.find((s) => !groups.has(s.adGroupId))
  if (missing) return { error: `Not queued: the source ad group ${missing.adGroupId} is no longer in Nexus.` }
  return { op, record, dest, owed: owed.map((s) => ({ ...s, place: groups.get(s.adGroupId)! })) }
}

/** An approved undo ran: the harvest is put back (the brain decides the term again after its cooldown). */
export async function markUndone(harvestId: string, args: { approvalId: string; paused: boolean; retired: number; problems: string[]; now: Date }) {
  const done = [args.paused ? 'the keyword paused' : '', args.retired ? `${args.retired} source negative${args.retired === 1 ? '' : 's'} retired` : ''].filter(Boolean).join(', ')
  await prisma.adsBrainHarvest.update({
    where: { id: harvestId },
    data: { status: 'UNDONE', undoApprovalId: args.approvalId, why: `put back by approved request ${args.approvalId}: ${done}`, lastError: args.problems.length ? args.problems.join('; ') : null, changedAt: args.now },
  })
}

/** What a harvest holds now, in the shape a request's change records (the undo guard compares the two). */
export async function harvestStanding(harvestId: string) {
  const r = await findHarvest(harvestId)
  return { keywordTargetId: r?.keywordTargetId ?? null, negatives: sourcesOf(r?.sources).map((s) => s.negativeTargetId).filter((x): x is string => !!x).sort() }
}
