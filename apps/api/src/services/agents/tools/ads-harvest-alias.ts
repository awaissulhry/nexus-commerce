/**
 * Keyword Harvest page rebuild (2026-10-11, lane HMCP) — `harvest-search-term` and `graduate-keyword`, the older names a
 * harvest is asked with (Claude's habits, the engines' graduation recommendations through apply-ad-recommendations, the
 * agent fleet), kept as doors onto the ONE harvest engine (services/advertising/harvest/). Their arguments name the
 * candidate — the term × the product that owns the campaign it ran in × the market — and the request is then planned,
 * previewed, run and put back exactly as `apply-harvest`'s (harvest/tool.ts, the Keyword Harvest page's own request):
 *
 *   one change set  the keyword (exact by default) in the place named or the suggested one, at the start bid named or the
 *                   bid brain's goal bid; AND the negative in EVERY ad group of the product where the term ran (the
 *                   sources; the Owner's saved negateAtSource=false wins unless the request says otherwise); AND the
 *                   funnel blocks (exact → negative exact in the product's phrase / broad / auto ad groups; phrase →
 *                   negative phrase in broad / auto) — the Owner's 10-08 standard, one approval, the negatives written only
 *                   once the keyword stands. Judged after the attribution window + 72 h (harvest-history).
 *   undo            the engine's: every block it added lifted, then its keyword PAUSED (never archived), through
 *                   apply-harvest op undo (undo-change asks for it).
 *
 * Their own older rules are gone: one source only, never negating a source where the term converts, the 60-day cost per
 * click as the bid, the stop-bid or 5-cent undo. A change one of them made BEFORE the engine (no harvest record) is put
 * back the engine's way too — its keyword paused, its one source negative retired — through the engine's undo writer
 * (harvest/write.ts undoHarvestWrite), as `harvest-search-term` op undo.
 */
import prisma from '../../../db.js'
import { adGroupCampaignId } from '../../advertising/ads-entity-lookup.service.js'
import { strategyMarket } from '../../advertising/ads-strategy/bids.js'
import { resolveCampaignOwnership } from '../../advertising/brain/ownership.js'
import { applyHarvestDryRun, applyHarvestRun, HARVEST_UNDO as ENGINE_UNDO } from '../../advertising/harvest/tool.js'
import { candidateIdOf, normTerm, parseCandidateId } from '../../advertising/harvest/ids.js'
import { undoHarvestWrite, type BlockState } from '../../advertising/harvest/write.js'
import { ENGINE_TOOL } from '../../advertising/harvest/constants.js'
import { approvedRun, gateRefusal, notRun, reachNote, recheck, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { fingerprint, reachOver } from './ads-targeting-kit.js'
import type { ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

/** The two older names, and the engine's. */
export const ALIAS = { harvest: 'harvest-search-term', graduate: 'graduate-keyword' } as const
export type AliasName = (typeof ALIAS)[keyof typeof ALIAS]

/** What a harvest's approver must still find (the engine's: its plan's fingerprint and where it lands). */
export const ALIAS_MATERIAL = ['basis', 'reach'] as const

/** One item of the engine's change set, as apply-harvest takes it. */
export interface EngineItem {
  candidateId: string
  to?: { adGroupId: string }
  match?: 'EXACT' | 'PHRASE'
  bidCents?: number
  negateSource?: boolean
  funnel?: boolean
}

/** The candidate a term that ran in a campaign is (the product that owns the campaign, its market), or why not. */
export async function candidateInCampaign(campaignId: string, query: string): Promise<{ candidateId: string; market: string; productId: string; term: string } | { refusal: string }> {
  const term = normTerm(query)
  if (!term) return { refusal: 'name the search term (query)' }
  const owners = await resolveCampaignOwnership([campaignId])
  const own = owners.get(campaignId)
  if (!own) return { refusal: `campaign ${campaignId} is not a campaign of this business` }
  const market = strategyMarket(own.market)
  if (!market) return { refusal: `campaign "${own.name}" names no market Nexus knows` }
  if (own.owner.kind === 'shared') return { refusal: `campaign "${own.name}" advertises several products (a shared campaign is no product's), so the term has no one product to harvest it into: find it under its product in harvest-candidates and harvest that candidateId with apply-harvest` }
  if (own.owner.kind !== 'product') return { refusal: `campaign "${own.name}" advertises no product Nexus can tie to one product family: a harvest goes into a product's own campaigns` }
  return { candidateId: candidateIdOf(market, own.owner.productId, term), market, productId: own.owner.productId, term }
}

/** The candidate a term that ran in an ad group (Nexus id) is, or why not. */
export async function candidateInAdGroup(adGroupId: string, query: string): Promise<{ candidateId: string; market: string; productId: string; term: string } | { refusal: string }> {
  const campaignId = await adGroupCampaignId(adGroupId)
  if (!campaignId) return { refusal: `ad group ${adGroupId} is not an ad group of this business (adGroupId in ad-search-terms or ad-groups)` }
  return candidateInCampaign(campaignId, query)
}

/** A candidate id the caller named, checked. */
export function namedCandidate(raw: string): { candidateId: string } | { refusal: string } {
  const c = parseCandidateId(raw)
  return c ? { candidateId: candidateIdOf(c.market, c.productId, c.term) } : { refusal: `${raw} is not a candidate id (market|productId|term, from harvest-candidates)` }
}

type EngineArgs = { op: 'harvest'; items: EngineItem[]; why?: string } | { op: 'undo'; harvestIds: string[]; why?: string }

/**
 * The engine's dry run of this request (apply-harvest's own preview), marked as asked through an older name: `action` is
 * that name, `engine` the request it is the same as, `asked` the arguments read. `extra` adds what a caller's card reads.
 */
export async function aliasPreview(name: AliasName, engine: EngineArgs, ctx: ToolContext, asked: Record<string, unknown>, extra: (preview: Record<string, unknown>) => Record<string, unknown> = () => ({})): Promise<ToolResult> {
  const out = await applyHarvestDryRun(engine as unknown as Record<string, unknown>, ctx)
  if (!out.ok) return out
  const preview = (out.preview ?? {}) as Record<string, unknown>
  return {
    ok: true,
    preview: {
      ...preview,
      action: name,
      engine: ENGINE_TOOL,
      asked,
      ...extra(preview),
      sameAs: `The same change set as ${ENGINE_TOOL} (the Keyword Harvest page's own request): ${name} names the term by where it ran; the harvest engine plans it, one approval.`,
    },
  }
}

/** What a request asked before the harvest engine says when it is run anyway (the approval sweep closes it first). */
export const PRE_ENGINE_REFUSAL = 'Not run: it was asked before the harvest engine and no longer describes the change set this tool runs. Ask for the harvest again (apply-harvest) to see every write it makes.'

/** The engine's run of this request (apply-harvest's own execute), as the approver: one change set. */
export async function aliasExecute(engine: EngineArgs, ctx: ToolContext): Promise<ToolResult> {
  // An approved preview that is not the engine's (asked before it) never runs: its re-check would skip the plan it lacks.
  const approved = ctx.approvedPreview as { engine?: unknown } | undefined
  if (approved !== undefined && approved?.engine !== ENGINE_TOOL) return notRun(PRE_ENGINE_REFUSAL)
  return applyHarvestRun(engine as unknown as Record<string, unknown>, ctx)
}

// ── Undo ────────────────────────────────────────────────────────────────────────────────────────────

/** A change the engine recorded (harvestIds), or one an older tool made before the engine (its keyword, its negative). */
const engineChange = (change: ToolChange) => Array.isArray((change.after as { harvestIds?: unknown } | null)?.harvestIds)

/** The keyword and the one negative an older harvest made (harvest-search-term: keyword + negative; graduate-keyword: targetId). */
function legacyMade(change: ToolChange): { keywordId: string | null; negativeId: string | null } {
  const after = (change.after ?? {}) as { op?: unknown; keyword?: { targetId?: unknown } | null; negative?: { targetId?: unknown } | null; targetId?: unknown }
  const keywordId = typeof after.keyword?.targetId === 'string' ? after.keyword.targetId : typeof after.targetId === 'string' ? after.targetId : null
  const negativeId = typeof after.negative?.targetId === 'string' ? after.negative.targetId : null
  return { keywordId, negativeId }
}

/**
 * The undo of a harvest asked through an older name: a change the engine made is put back by apply-harvest op undo (its
 * harvests' blocks lifted, their keywords paused); one made before the engine by harvest-search-term op undo (its keyword
 * paused, its one negative retired — the engine's writer). `legacyCurrent` reads what an older change's undo guard compares.
 */
export function aliasUndo(legacyCurrent: (change: ToolChange) => Promise<unknown>, undone?: ToolUndo['undone']): ToolUndo {
  return {
    current: (change) => (engineChange(change) ? ENGINE_UNDO.current(change) : legacyCurrent(change)),
    request(change) {
      if (engineChange(change)) return ENGINE_UNDO.request(change)
      const after = (change.after ?? {}) as { op?: unknown }
      if (after.op === 'undo') return { refusal: 'An undo of a harvest is not put back: harvest the term again (apply-harvest).' }
      const before = (change.before ?? {}) as { changeSetId?: unknown }
      const made = legacyMade(change)
      if (typeof before.changeSetId !== 'string' || !made.keywordId) return { refusal: 'This change does not name the keyword it made.' }
      return {
        tool: ALIAS.harvest,
        args: { op: 'undo', changeSetId: before.changeSetId, keywordId: made.keywordId, ...(made.negativeId ? { negativeId: made.negativeId } : {}), why: 'undo of a harvest: its source negative retired, then its keyword paused (never archived)' },
      }
    },
    ...(undone ? { undone } : {}),
  }
}

/**
 * op undo of harvest-search-term: a harvest it made BEFORE the engine, named by the request that made it (changeSetId) and
 * what it made. A harvest the engine recorded is put back by apply-harvest op undo (its harvestIds), the one undo the
 * Keyword Harvest page counts as waiting.
 */
export interface UndoAsk { changeSetId?: string; keywordId?: string; negativeId?: string; why?: string }

/** The harvests a change set of the engine made (its records), narrowed to one keyword when named. */
async function recordsOf(changeSetId: string, keywordId?: string): Promise<string[]> {
  const rows = await prisma.adsBrainHarvest.findMany({ where: { changeSetId, ...(keywordId ? { keywordTargetId: keywordId } : {}) }, select: { id: true } })
  return rows.map((r) => r.id).sort()
}

/** The older change a legacy undo names: one harvest-search-term or graduate-keyword change that made this keyword. */
async function legacyChange(changeSetId: string, keywordId: string) {
  const recorded = await prisma.agentChange.findMany({ where: { approvalId: changeSetId, toolName: { in: [ALIAS.harvest, ALIAS.graduate] } }, select: { id: true, toolName: true, after: true, undoneAt: true } })
  return recorded.find((c) => legacyMade({ before: null, after: c.after }).keywordId === keywordId) ?? null
}

/** The dry run of an undo asked through harvest-search-term. */
export async function aliasUndoPreview(a: UndoAsk, _ctx: ToolContext): Promise<ToolResult> {
  if (!a.changeSetId) return { ok: false, error: 'Name the harvest to put back: changeSetId (its approvalId) and keywordId — undo-change fills them in. A harvest of the harvest engine is put back by apply-harvest op undo (its harvestIds, from harvest-history).' }
  const ids = await recordsOf(a.changeSetId, a.keywordId)
  if (ids.length) return { ok: false, error: `Not queued: ${a.changeSetId} is a harvest of the harvest engine — put it back with apply-harvest op undo (harvestIds: ${ids.join(', ')}), or undo-change of that request.` }
  if (!a.keywordId) return { ok: false, error: `Not queued: ${a.changeSetId} made no harvest the engine recorded; name the keyword it made (keywordId) — undo-change fills it in.` }
  return legacyUndoPreview({ changeSetId: a.changeSetId, keywordId: a.keywordId, negativeId: a.negativeId ?? null })
}

/** The run of an undo asked through harvest-search-term, as the approver. */
export async function aliasUndoExecute(a: UndoAsk, ctx: ToolContext): Promise<ToolResult> {
  if (!a.changeSetId || !a.keywordId) return notRun('Not run: it names no harvest to put back.')
  if ((await recordsOf(a.changeSetId, a.keywordId)).length) return notRun('Not run: it is a harvest of the harvest engine — apply-harvest op undo puts it back.')
  return legacyUndoExecute({ changeSetId: a.changeSetId, keywordId: a.keywordId, negativeId: a.negativeId ?? null, why: a.why }, ctx)
}

interface LegacyAsk { changeSetId: string; keywordId: string; negativeId: string | null }

/** An older harvest (before the engine), put back the engine's way: what is left of what it made, as the preview. */
async function legacyUndoPreview(a: LegacyAsk): Promise<ToolResult> {
  const change = await legacyChange(a.changeSetId, a.keywordId)
  if (!change) return { ok: false, error: `Not queued: ${a.changeSetId} is no harvest-search-term or graduate-keyword request that made the keyword ${a.keywordId} in this business (undo-change names it).` }
  const recordedNegative = legacyMade({ before: null, after: change.after }).negativeId
  if ((a.negativeId ?? null) !== recordedNegative) {
    return { ok: false, error: `Not queued: that harvest ${recordedNegative ? `made the negative ${recordedNegative}` : 'made no negative'}, so op undo names ${recordedNegative ? 'exactly that one' : 'none'} (undo-change fills it in).` }
  }
  if (change.undoneAt) return { ok: false, error: `Nothing of harvest ${a.changeSetId} is left to put back: it was undone already.` }
  const ids = [a.keywordId, ...(a.negativeId ? [a.negativeId] : [])]
  const rows = await prisma.adTarget.findMany({ where: { id: { in: ids } }, select: { id: true, isNegative: true, status: true, expressionValue: true, adGroup: { select: { id: true, name: true, campaign: { select: { id: true, name: true, marketplace: true } } } } } })
  const keyword = rows.find((r) => r.id === a.keywordId && !r.isNegative) ?? null
  const negative = a.negativeId ? rows.find((r) => r.id === a.negativeId && r.isNegative) ?? null : null
  if (!keyword) return { ok: false, error: `Not queued: the keyword ${a.keywordId} that harvest made is no longer in Nexus.` }
  const pause = String(keyword.status) === 'ENABLED'
  const lift = !!negative && String(negative.status) !== 'ARCHIVED'
  if (!pause && !lift) return { ok: false, error: `Nothing of harvest ${a.changeSetId} is left to put back: its keyword is not running and ${negative ? 'its negative is retired' : 'it made no negative'}.` }
  const place = (g: { name: string; campaign: { name: string } }) => `"${g.name}" (${g.campaign.name})`
  const writes: Array<RuleWrite & { label: string }> = [
    ...(pause ? [{ campaignId: keyword.adGroup.campaign.id, adGroupId: keyword.adGroup.id, marketplace: keyword.adGroup.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${keyword.adGroup.campaign.name}"` }] : []),
    ...(lift ? [{ campaignId: negative!.adGroup.campaign.id, marketplace: negative!.adGroup.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${negative!.adGroup.campaign.name}"` }] : []),
  ]
  const reached = await reachOver(writes)
  if ('refused' in reached) return { ok: false, error: `Not queued: ${reached.label}: ${gateRefusal(reached.refused)}` }
  const effect = `Puts back harvest ${a.changeSetId} (made before the harvest engine), the engine's way: `
    + [lift ? `the negative "${negative!.expressionValue}" in ${place(negative!.adGroup)} retired, so the term runs there again` : '', pause ? `then "${keyword.expressionValue}" in ${place(keyword.adGroup)} paused (it stays at Amazon; never archived)` : ''].filter(Boolean).join(', ')
    + '.'
  return {
    ok: true,
    preview: {
      action: ALIAS.harvest,
      op: 'undo',
      legacy: true,
      undoes: a.changeSetId,
      undoesChangeId: change.id,
      changes: [
        ...(lift ? [{ label: `negative "${negative!.expressionValue}" · ${place(negative!.adGroup)}`, fromLabel: 'Standing', toLabel: 'Retired' }] : []),
        ...(pause ? [{ label: `"${keyword.expressionValue}" · ${place(keyword.adGroup)}`, fromLabel: 'Enabled', toLabel: 'Paused' }] : []),
      ],
      // Lifting the negative lets the term show the source's ads again: a raise, listed (a day-to-day change, no code).
      raises: lift ? [`negative "${negative!.expressionValue}" · ${place(negative!.adGroup)} retired (the term shows these ads there again)`] : [],
      basis: fingerprint({ change: change.id, keyword: [keyword.id, String(keyword.status)], negative: negative ? [negative.id, String(negative.status)] : null }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
    },
  }
}

/** The run of an older harvest's undo, as the approver: the engine's undo writer (blocks lifted, then the keyword paused). */
async function legacyUndoExecute(a: LegacyAsk & { why?: string }, ctx: ToolContext): Promise<ToolResult> {
  const fresh = await legacyUndoPreview(a)
  const refusal = recheck(ctx, fresh, ALIAS_MATERIAL)
  if (refusal) return notRun(refusal)
  const p = fresh.preview as { effect: string; reach: StoredReach; undoes: string; undoesChangeId: string }
  const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
  if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
  const blocks: BlockState[] = a.negativeId ? [{ adGroupId: '', campaignId: '', role: null, action: 'negate', why: 'the source negative an older harvest made', negativeTargetId: a.negativeId }] : []
  const out = await undoHarvestWrite({ keywordTargetId: a.keywordId, pauseKeyword: true, blocks }, { actor: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, reason: run.reason })
  if (!out.paused && !out.retired) return notRun(`Not run: nothing was put back — ${out.problems.join('; ') || 'nothing was left to put back'}.`)
  // Asked for directly (not through undo-change, which claims the change and marks it undone with its event), the harvest
  // it put back is marked undone here, so it is not put back twice. A claimed change is left to the record.
  await prisma.agentChange.updateMany({ where: { id: p.undoesChangeId, undoneAt: null, undoneByApprovalId: null }, data: { undoneAt: new Date(), undoneByApprovalId: run.changeSetId } })
  return {
    ok: true,
    data: { paused: out.paused, lifted: out.retired, complete: out.complete, ...(out.problems.length ? { partial: true, problem: `Not put back: ${out.problems.join('; ')}.` } : {}), reach: p.reach, changeSetId: run.changeSetId },
    change: { before: { changeSetId: run.changeSetId, op: 'undo', undoes: p.undoes }, after: { op: 'undo', undoes: p.undoes, paused: out.paused, lifted: out.retired } },
  }
}
