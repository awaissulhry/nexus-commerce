/**
 * HARVEST ENGINE — undo of harvests (every actor's): the source and funnel blocks it added lifted, then the keyword PAUSED
 * (never archived; only a keyword the harvest created or enabled — one that stood before keeps running). Through the
 * `apply-harvest` request (op undo): its preview here, its run as the approver (harvest/write.ts undoHarvestWrite).
 */
import prisma from '../../../db.js'
import { adGroupRef, campaignRef, type Ref } from './ids.js'
import { PLACED } from './constants.js'
import { blocksOf, ownNegatives, undoHarvestWrite, type UndoOutcome, type Who } from './write.js'

export interface UndoPreviewRow {
  harvestId: string
  term: string
  market: string
  productId: string
  ok: boolean
  refusal: string | null
  pause: null | { keyword: Ref; adGroup: Ref | null; campaign: Ref | null }
  lift: Array<{ negativeTargetId: string; adGroup: Ref | null; campaign: Ref | null }>
}

const UNDOABLE = [...PLACED, 'UNDO_PROPOSED']

/** What an undo of these harvests would put back now (reads only). */
export async function previewUndo(harvestIds: readonly string[]): Promise<{ rows: UndoPreviewRow[]; basis: Record<string, unknown> }> {
  const ids = [...new Set(harvestIds)]
  const records = await prisma.adsBrainHarvest.findMany({ where: { id: { in: ids } }, select: { id: true, term: true, marketplace: true, productId: true, status: true, keywordTargetId: true, sources: true, funnel: true, evidence: true } })
  const byId = new Map(records.map((r) => [r.id, r]))
  const negIds = records.flatMap((r) => [...blocksOf(r.sources), ...blocksOf(r.funnel)].map((s) => s.negativeTargetId).filter((x): x is string => !!x))
  const kwIds = records.map((r) => r.keywordTargetId).filter((x): x is string => !!x)
  const targets = new Map(((negIds.length || kwIds.length) ? await prisma.adTarget.findMany({
    where: { id: { in: [...negIds, ...kwIds] } },
    select: { id: true, isNegative: true, status: true, expressionValue: true, adGroup: { select: { id: true, name: true, campaignId: true, campaign: { select: { id: true, name: true } } } } },
  }) : []).map((t) => [t.id, t]))
  // M1 (HCORE review) — an undo whose blocks cannot all be listed is refused: a negative of the term stands in one of its
  // sources (the ad group's, or its campaign's) that the record does not name — pausing the keyword then would leave the
  // term serving nowhere. A source the harvest found already blocked ('standing') was blocked before: it is not asked.
  // One read for every record (the history asks for hundreds at once).
  const openOf = new Map(records.map((r) => [r.id, blocksOf(r.sources).filter((b) => b.action !== 'standing' && b.action !== 'skipped')]))
  const asked = records.filter((r) => UNDOABLE.includes(r.status) && (openOf.get(r.id)?.length ?? 0) > 0)
  const strays: Array<{ id: string; expressionValue: string | null; adGroupId: string | null; negativeLevel: string | null; adGroup: { name: string; campaignId: string } | null }> = []
  for (let i = 0; i < asked.length; i += 200) {
    const chunk = asked.slice(i, i + 200)
    strays.push(...await prisma.adTarget.findMany({
      where: {
        isNegative: true, status: { not: 'ARCHIVED' }, retiredAt: null,
        OR: chunk.map((r) => {
          const open = openOf.get(r.id) ?? []
          return { expressionValue: { equals: r.term, mode: 'insensitive' as const }, OR: [{ adGroupId: { in: open.map((b) => b.adGroupId) } }, { negativeLevel: 'CAMPAIGN', adGroup: { campaignId: { in: open.map((b) => b.campaignId) } } }] }
        }),
      },
      select: { id: true, expressionValue: true, adGroupId: true, negativeLevel: true, adGroup: { select: { name: true, campaignId: true } } },
    }))
  }
  const rows: UndoPreviewRow[] = []
  for (const id of ids) {
    const r = byId.get(id)
    if (!r) { rows.push({ harvestId: id, term: '', market: '', productId: '', ok: false, refusal: 'Not found in this business.', pause: null, lift: [] }); continue }
    const base = { harvestId: r.id, term: r.term, market: r.marketplace, productId: r.productId }
    if (!UNDOABLE.includes(r.status)) { rows.push({ ...base, ok: false, refusal: `It is ${r.status.toLowerCase().replace(/_/g, ' ')}: there is nothing of it to put back.`, pause: null, lift: [] }); continue }
    const before = ((r.evidence ?? {}) as { keywordBefore?: string }).keywordBefore
    const kw = r.keywordTargetId ? targets.get(r.keywordTargetId) : undefined
    const pause = before !== 'stood' && kw && !kw.isNegative && String(kw.status) === 'ENABLED'
      ? { keyword: { id: kw.id, name: kw.expressionValue ?? r.term }, adGroup: kw.adGroup ? adGroupRef(kw.adGroup.id, kw.adGroup.name, kw.adGroup.campaignId) : null, campaign: kw.adGroup?.campaign ? campaignRef(kw.adGroup.campaign.id, kw.adGroup.campaign.name) : null }
      : null
    const lift = ownNegatives([...blocksOf(r.sources), ...blocksOf(r.funnel)])
      .map((nid) => targets.get(nid)).filter((t): t is NonNullable<typeof t> => !!t && t.isNegative && String(t.status) !== 'ARCHIVED')
      .map((t) => ({ negativeTargetId: t.id, adGroup: t.adGroup ? adGroupRef(t.adGroup.id, t.adGroup.name, t.adGroup.campaignId) : null, campaign: t.adGroup?.campaign ? campaignRef(t.adGroup.campaign.id, t.adGroup.campaign.name) : null }))
    const listed = new Set([...blocksOf(r.sources), ...blocksOf(r.funnel)].map((b) => b.negativeTargetId).filter((x): x is string => !!x))
    const open = openOf.get(r.id) ?? []
    const openGroups = new Set(open.map((b) => b.adGroupId))
    const openCampaigns = new Set(open.map((b) => b.campaignId))
    const stray = strays.find((n) => !listed.has(n.id) && (n.expressionValue ?? '').toLowerCase() === r.term.toLowerCase()
      && ((!!n.adGroupId && openGroups.has(n.adGroupId)) || (n.negativeLevel === 'CAMPAIGN' && openCampaigns.has(n.adGroup?.campaignId ?? ''))))
    if (stray) {
      rows.push({ ...base, ok: false, refusal: `A negative of "${r.term}" stands in its source "${stray.adGroup?.name ?? '?'}" that this harvest did not record: lift it first (Negatives), then undo — else the term would serve nowhere.`, pause: null, lift: [] })
      continue
    }
    if (!pause && !lift.length) { rows.push({ ...base, ok: false, refusal: 'Nothing of it is left to put back: its keyword is not running and its blocks are lifted.', pause: null, lift: [] }); continue }
    rows.push({ ...base, ok: true, refusal: null, pause, lift })
  }
  const basis = { rows: rows.filter((r) => r.ok).map((r) => ({ id: r.harvestId, pause: r.pause?.keyword.id ?? null, lift: r.lift.map((l) => l.negativeTargetId).sort() })) }
  return { rows, basis }
}

/** Put back one harvest (its record any actor's) and mark it: UNDONE when whole, else what went back and what did not. */
export async function undoOneHarvest(id: string, who: Who, now: Date = new Date()): Promise<UndoOutcome & { harvestId: string }> {
  const r = await prisma.adsBrainHarvest.findUniqueOrThrow({ where: { id } })
  const before = ((r.evidence ?? {}) as { keywordBefore?: string }).keywordBefore
  const out = await undoHarvestWrite({ keywordTargetId: r.keywordTargetId, pauseKeyword: before !== 'stood', blocks: [...blocksOf(r.sources), ...blocksOf(r.funnel)] }, who)
  const done = [out.retired ? `${out.retired} block${out.retired === 1 ? '' : 's'} lifted` : '', out.paused ? 'the keyword paused' : ''].filter(Boolean).join(', ')
  if (out.complete) {
    await prisma.adsBrainHarvest.update({ where: { id }, data: { status: 'UNDONE', ...(who.changeSetId ? { undoApprovalId: who.changeSetId } : {}), why: `put back by ${who.reason.slice(0, 200)}${done ? `: ${done}` : ''}`.slice(0, 2000), lastError: null, changedAt: now } })
  } else if (out.paused || out.retired) {
    await prisma.adsBrainHarvest.update({ where: { id }, data: { lastError: `put back in part (${done}); the rest is sent again with another undo: ${out.problems.join('; ')}`.slice(0, 2000), changedAt: now } })
  }
  return { ...out, harvestId: id }
}

/** L3 — the harvest ids that are not this business's records (another business's or unknown): the route answers 404. */
export async function unknownHarvests(ids: readonly string[]): Promise<string[]> {
  const list = [...new Set(ids)]
  if (!list.length) return []
  const known = new Set((await prisma.adsBrainHarvest.findMany({ where: { id: { in: list } }, select: { id: true } })).map((r) => r.id))
  return list.filter((id) => !known.has(id))
}
