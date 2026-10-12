/**
 * HARVEST ENGINE — `apply-harvest`: the ONE request a harvest change set (or its undo) goes out as. The Keyword Harvest
 * page (POST /api/advertising/harvest/apply and /undo) and Claude (MCP) ask for the same tool, so a harvest is the same
 * change set whoever asks: one approval for everything — new portfolio, new campaign, keywords, source and funnel blocks.
 *
 *   op harvest  the preview body (items, newCampaigns, newPortfolios): planned again from the facts read now; refused, not
 *               queued, when nothing can be harvested or the plan moved since `planHash` (the page's review). Runs as the
 *               approver (`manual`: his approval passes his own limits, the allowlist and pins as his own click would),
 *               its approval the change set of every write; a refusal of the write gate blocks its item whole.
 *   op undo     harvestIds: the blocks each harvest added lifted, then its keyword PAUSED (never archived).
 *
 * Always a person (ceiling ask): the business's rule never runs a harvest change set alone (the brain and the harvest
 * rules run inside their own caps). undo-change of an applied change set asks for op undo of its harvests.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { checkAdsWriteGate } from '../ads-write-gate.js'
import { approvedRun, notRun, reachNote, recheck, storedReach, type StoredReach } from '../../agents/tools/ads-change-kit.js'
import { gateRefusal } from '../../agents/tools/ads-change-kit.js'
import { liveReachOf, type AdWriteIntent } from '../../agents/tools/ads-tool-guards.js'
import { fingerprint, reachOver } from '../../agents/tools/ads-targeting-kit.js'
import { codeGate } from '../../agents/tools/ads-code-rule.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../../agents/tool-types.js'
import { ENGINE_TOOL } from './constants.js'
import { executeChangeSet } from './execute.js'
import { NEW_CAMPAIGN_INPUT, NEW_PORTFOLIO_INPUT, ITEM_INPUT, MAX_ITEMS, previewChangeSet, type PreviewAnswer } from './preview.js'
import { previewUndo, undoOneHarvest } from './undo.js'
import type { ActorKind } from './plan.js'
import { blocksOf, type Who } from './write.js'

export const MAX_UNDO = 200

const INPUT = z.object({
  op: z.enum(['harvest', 'undo']).default('harvest').describe('harvest (default): one change set of harvests; undo: put harvests back (their blocks lifted, their keywords paused)'),
  items: z.array(ITEM_INPUT).max(MAX_ITEMS).optional().describe('op harvest: the terms to harvest (harvest-candidates ids), each to its suggested place or one named'),
  newCampaigns: z.array(NEW_CAMPAIGN_INPUT).max(20).optional().describe('op harvest: new campaigns of this change set (the product\'s funnel campaign for the match: one ad group, in its portfolio)'),
  newPortfolios: z.array(NEW_PORTFOLIO_INPUT).max(10).optional().describe('op harvest: new portfolios a new campaign is born in'),
  planHash: z.string().trim().max(64).optional().describe('op harvest: the preview\'s planHash — refused when the plan moved since'),
  harvestIds: z.array(z.string().trim().min(1).max(64)).max(MAX_UNDO).optional().describe('op undo: the harvests to put back'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})
type Args = z.infer<typeof INPUT>

/** What a person approves (the material the run re-checks): the plan's fingerprint and where it lands. */
const MATERIAL = ['basis', 'reach'] as const

/** The person behind a request (the asker, else the approver), and whether it came from Claude. */
const actorOf = (ctx: Pick<ToolContext, 'via'>): ActorKind => (ctx.via === 'claude' ? 'CLAUDE' : 'PERSON')
const previewWho = (ctx: Pick<ToolContext, 'userId'>): Who => ({ actor: `user:${ctx.userId?.trim() || 'anonymous'}`, manual: true, confirmOwnLimits: true, changeSetId: null, reason: 'harvest preview' })

/**
 * Where the change set lands (live at Amazon on which profile, or sandbox), asked of the gate for EVERY write it makes (M2:
 * each keyword at its own bid, each negative with its term — a protected product's check per term), and the person's own
 * limits it goes past — each keyword's, each negative's, each new campaign's budget and portfolio cap (the preview's) — so
 * the card warns of every one.
 */
async function reachOf(answer: PreviewAnswer, markets: string[]): Promise<{ reach: StoredReach } | { refusal: string }> {
  const intents: Array<AdWriteIntent & { label: string }> = []
  const seen = new Set<string>()
  for (const s of answer.steps) {
    const cid = s.campaign?.id
    if (!cid || cid.startsWith('new:')) continue
    const item = answer.items.find((i) => i.candidateId === s.candidateId)
    const keywordStep = s.kind === 'keyword' || s.kind === 'enable'
    const key = `${cid}|${s.adGroup?.id ?? ''}|${keywordStep ? `k${s.bidCents}` : `n${s.match}`}|${s.term ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    intents.push(keywordStep
      ? { campaignId: cid, adGroupId: s.adGroup?.id ?? null, marketplace: item?.market ?? null, changes: [{ field: 'bid', valueCents: s.bidCents ?? null }], label: `campaign "${s.campaign?.name ?? cid}"` }
      : { campaignId: cid, marketplace: item?.market ?? null, changes: [{ field: 'negativeKeyword', valueCents: null }], isNegation: true, keywordText: s.term ?? '', label: `campaign "${s.campaign?.name ?? cid}"` })
  }
  let reach: StoredReach
  if (intents.length) {
    const reached = await reachOver(intents)
    if ('refused' in reached) return { refusal: `${reached.label}: ${gateRefusal(reached.refused)}` }
    reach = reached.reach
  } else {
    // Only new campaigns: the market's gate, as a launch asks it.
    const r = liveReachOf(await checkAdsWriteGate({ marketplace: markets[0] ?? null, payloadValueCents: 0 } as never))
    if (r.reach === 'refused') return { refusal: gateRefusal(r) }
    reach = storedReach(r)
  }
  // The new campaigns' budgets and portfolio caps past his own limits (the preview asked the gate for them).
  const past = new Map((reach.reach === 'live' ? reach.pastOwnLimits ?? [] : []).map((l) => [l.reason, l]))
  for (const l of answer.pastOwnLimits) if (!past.has(l.reason)) past.set(l.reason, l)
  return { reach: past.size ? { ...reach, pastOwnLimits: [...past.values()] } as StoredReach : reach }
}

async function harvestPreview(a: Args, ctx: Pick<ToolContext, 'userId' | 'via' | 'approvalId'>): Promise<ToolResult & { engine?: Awaited<ReturnType<typeof previewChangeSet>> }> {
  if (!a.items?.length) return { ok: false, error: 'items: name at least one term to harvest (harvest-candidates gives their ids).' }
  // H1 — at execute the request itself is open (executing): it is never "waiting" for its own items.
  const got = await previewChangeSet({ items: a.items, newCampaigns: a.newCampaigns, newPortfolios: a.newPortfolios }, { actor: actorOf(ctx), who: previewWho(ctx), exceptApprovalId: ctx.approvalId ?? null })
  if ('error' in got) return { ok: false, error: got.error }
  const d = got.data
  if (!d.totals.ok) return { ok: false, error: `Not queued: nothing can be harvested — ${d.blocked.slice(0, 5).map((b) => `"${b.term}": ${b.reason}`).join('; ')}` }
  if (a.planHash && a.planHash !== d.planHash) return { ok: false, error: 'Not queued: the plan moved since your review (a term, a place, a bid or a block changed). Review it again.' }
  const reach = await reachOf(d, got.plan.markets)
  if ('refusal' in reach) return { ok: false, error: `Not queued: ${reach.refusal}` }
  const changes = d.steps.slice(0, 200).map((s) => ({
    label: `${s.kind === 'portfolio' || s.kind === 'portfolioCap' ? `portfolio "${s.portfolio?.name}"` : s.kind === 'campaign' ? `campaign "${s.campaign?.name}"` : `"${s.term}" · ${s.adGroup?.name ?? ''} (${s.campaign?.name ?? ''})`}`,
    fromLabel: s.from, toLabel: s.to,
  }))
  return {
    ok: true,
    preview: {
      action: ENGINE_TOOL, op: 'harvest', markets: got.plan.markets,
      steps: d.steps, items: d.items, totals: d.totals, blocked: d.blocked, planHash: d.planHash,
      changes, raises: d.raises, basis: d.planHash, reach: reach.reach, reachNote: reachNote(reach.reach), effect: d.effect,
      approvals: d.approvals, pastOwnLimits: d.pastOwnLimits,
      // M3 — a new campaign going live: the approver's authenticator code (code rule A); the gate reads it here.
      ...(d.stepUp ? { stepUp: d.stepUp } : {}),
      undoNote: 'Undo (undo-change, or Undo on the Keyword Harvest page) lifts the blocks each harvest added, then pauses its keyword (never archives).',
    },
    engine: got,
  }
}

async function undoPreview(a: Args): Promise<ToolResult> {
  if (!a.harvestIds?.length) return { ok: false, error: 'harvestIds: name at least one harvest to put back.' }
  const { rows, basis } = await previewUndo(a.harvestIds)
  const ok = rows.filter((r) => r.ok)
  if (!ok.length) return { ok: false, error: `Not queued: nothing to put back — ${rows.slice(0, 5).map((r) => `${r.term || r.harvestId}: ${r.refusal}`).join('; ')}` }
  const markets = [...new Set(ok.map((r) => r.market))]
  const intents: Array<AdWriteIntent & { label: string }> = []
  for (const r of ok) {
    if (r.pause?.campaign) intents.push({ campaignId: r.pause.campaign.id, marketplace: r.market, changes: [{ field: 'status', valueCents: null }], label: `campaign "${r.pause.campaign.name}"` })
    for (const l of r.lift) if (l.campaign) intents.push({ campaignId: l.campaign.id, marketplace: r.market, changes: [{ field: 'status', valueCents: null }], label: `campaign "${l.campaign.name}"` })
  }
  const reached = intents.length ? await reachOver(intents) : { reach: storedReach(liveReachOf(await checkAdsWriteGate({ marketplace: markets[0], payloadValueCents: 0 } as never)) as never) }
  if ('refused' in reached) return { ok: false, error: `Not queued: ${reached.label}: ${gateRefusal(reached.refused)}` }
  const changes = ok.flatMap((r) => [
    ...(r.pause ? [{ label: `"${r.term}" · ${r.pause.adGroup?.name ?? ''}`, fromLabel: 'Enabled', toLabel: 'Paused' }] : []),
    ...r.lift.map((l) => ({ label: `negative "${r.term}" · ${l.adGroup?.name ?? ''}`, fromLabel: 'Standing', toLabel: 'Lifted' })),
  ])
  return {
    ok: true,
    preview: {
      action: ENGINE_TOOL, op: 'undo', rows, changes: changes.slice(0, 200),
      raises: ok.flatMap((r) => r.lift.map((l) => `negative "${r.term}" · ${l.adGroup?.name ?? ''} lifted (the term shows these ads there again)`)).slice(0, 50),
      basis: fingerprint(basis), reach: reached.reach, reachNote: reachNote(reached.reach),
      effect: `Puts back ${ok.length} harvest${ok.length === 1 ? '' : 's'}: their blocks lifted, then their keywords paused (never archived).`,
    },
  }
}

async function preview(raw: Record<string, unknown>, ctx: Pick<ToolContext, 'userId' | 'via' | 'approvalId'>) {
  const parsed = INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') } as ToolResult
  return parsed.data.op === 'undo' ? undoPreview(parsed.data) : harvestPreview(parsed.data, ctx)
}

/** What the change set's harvests hold now, in the shape of `change.after` (the undo guard compares the two). */
async function nowOf(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; harvestIds?: unknown }
  if (after.op !== 'harvest' || !Array.isArray(after.harvestIds)) return change.after
  const ids = after.harvestIds.map(String)
  const rows = ids.length ? await prisma.adsBrainHarvest.findMany({ where: { id: { in: ids } }, select: { id: true, keywordTargetId: true, sources: true, funnel: true } }) : []
  return {
    op: 'harvest', harvestIds: ids,
    keywords: rows.map((r) => r.keywordTargetId).filter((x): x is string => !!x).sort(),
    negatives: rows.flatMap((r) => [...blocksOf(r.sources), ...blocksOf(r.funnel)].map((s) => s.negativeTargetId).filter((x): x is string => !!x)).sort(),
  }
}

export const HARVEST_UNDO: ToolUndo = {
  current: nowOf,
  request(change) {
    const after = (change.after ?? {}) as { op?: unknown; harvestIds?: unknown }
    if (after.op === 'undo') return { refusal: 'An undo of a harvest is not put back: harvest the term again.' }
    if (!Array.isArray(after.harvestIds) || !after.harvestIds.length) return { refusal: 'This change set harvested nothing that can be put back.' }
    return { tool: ENGINE_TOOL, args: { op: 'undo', harvestIds: after.harvestIds.map(String), why: 'undo of a harvest change set: its blocks lifted, its keywords paused' } }
  },
}

async function askerOf(ctx: ToolContext): Promise<string | null> {
  if (!ctx.approvalId) return ctx.userId ?? null
  const a = await prisma.agentApproval.findFirst({ where: { id: ctx.approvalId }, select: { agentRun: { select: { userId: true } } } })
  return a?.agentRun?.userId ?? ctx.userId ?? null
}

export const applyHarvestTool: AgentTool = {
  name: ENGINE_TOOL,
  title: 'Harvest search terms',
  input: INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: { money: FIELDS.financialsAdspendView },
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: HARVEST_UNDO,
  description:
    'Harvest Amazon Sponsored Products search terms as ONE change set, through the same harvest engine as the Keyword '
    + 'Harvest page (its Harvest and Harvest to… ask for this same request). op harvest — items (≤ 200): each term by its '
    + 'candidateId (harvest-candidates), with optional choices: to: { adGroupId } (an ad group of the product\'s own '
    + 'campaigns: harvest-destinations lists them with held and suggested) or to: { newCampaign: key } (absent = its '
    + 'suggested place); match EXACT (default) or PHRASE (an ASIN is always a product target); bidCents (default: the bid '
    + 'brain\'s goal bid, else the term\'s cost per click inside the strategy\'s bid limits); negateSource (default: the '
    + 'negative in EVERY ad group of the product where the term ran — negative exact, or negative phrase for a phrase '
    + 'harvest in a broad or auto source; false leaves the sources running; true overrides the Owner\'s saved '
    + 'negateAtSource=false, which otherwise wins); funnel (default: exact → negative exact in the product\'s phrase, '
    + 'broad and auto ad groups; phrase → negative phrase in broad and auto; false leaves them out). newCampaigns (≤ 20): '
    + '{ key, productId, match, name (default: the SP Super Wizard\'s naming), dailyBudgetCents (default: the product\'s '
    + 'usual), portfolio: { id } (an Amazon portfolio id) | { newPortfolio: key } | null (default: the product\'s '
    + 'portfolio) } — the product\'s funnel campaign for the match: one manual campaign, one ad group, its products, born '
    + 'serving at the bids planned, so a change set that builds one is a big door a person approves. newPortfolios (≤ 10):{ key, name, capMonthlyCents } — a portfolio a new campaign is '
    + 'born in. planHash: the preview\'s, to refuse a plan that moved since a review. The preview lists every step in '
    + 'order (portfolio → campaign → keyword → source negatives → funnel negatives), each item harvestable or blocked with '
    + 'why (never dropped), the totals, raises and planHash. op undo — harvestIds (harvest-history, or a candidate\'s '
    + 'lastHarvest): each harvest\'s source and funnel blocks lifted, then its keyword paused (never archived; a keyword '
    + 'that stood before the harvest keeps running). The negatives are written only once each keyword stands; an item the '
    + 'write gate refuses is not written at all. Nothing changes until a person approves it in Nexus (the Approvals page, '
    + 'or the Keyword Harvest page\'s Waiting tile); it never runs by rule, and Claude cannot approve it. Follow it with '
    + 'approval-status; once it ran, harvest-history shows each harvest and, after the attribution window + 72 hours, its '
    + 'verdict (better, worse, too early). undo-change of an applied change set asks for op undo of its harvests. New '
    + 'keywords and new campaigns add spend: listed in raises.',
  handler: (args, ctx) => applyHarvestDryRun(args, ctx),
  execute: (args, ctx) => applyHarvestRun(args, ctx),
}

/**
 * The request's dry run and its run, as functions (lane HMCP): apply-harvest's own handler and execute, and the older
 * names that ask for the same change set (agents/tools/ads-harvest-alias.ts: harvest-search-term, graduate-keyword) —
 * one code path. Called only from a tool's own handler or execute, behind call-tool.ts (the one door).
 */
export async function applyHarvestDryRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const out = await preview(args, ctx)
  delete (out as { engine?: unknown }).engine
  return out
}

export async function applyHarvestRun(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  {
    const parsed = INPUT.safeParse(args)
    if (!parsed.success) return notRun(`Not run: ${parsed.error.issues[0]?.message ?? 'wrong arguments'}.`)
    const a = parsed.data
    const fresh = await preview(a, ctx)
    const plan = (fresh as unknown as { engine?: Awaited<ReturnType<typeof previewChangeSet>> }).engine
    delete (fresh as { engine?: unknown }).engine
    const refusal = recheck(ctx, fresh, MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { effect: string; reach: StoredReach }
    const run = approvedRun(ctx, String(a.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    // M3 — a change set that builds a new campaign runs only with the approver's fresh authenticator code (code rule A).
    const coded = await codeGate(ctx, fresh.preview)
    if ('refusal' in coded) return notRun(coded.refusal)
    const who: Who = { actor: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, reason: run.reason }
    if (a.op === 'undo') {
      const outs = []
      for (const id of a.harvestIds ?? []) outs.push(await undoOneHarvest(id, who).catch((e: unknown) => ({ harvestId: id, paused: false, retired: 0, complete: false, alreadyBack: 0, actionLogIds: [], problems: [e instanceof Error ? e.message : String(e)] })))
      const back = outs.filter((o) => o.paused || o.retired)
      if (!back.length) return notRun(`Not run: nothing was put back — ${outs.flatMap((o) => o.problems).slice(0, 3).join('; ') || 'nothing was left to put back'}.`)
      return {
        ok: true,
        data: { op: 'undo', results: outs.map((o) => ({ harvestId: o.harvestId, paused: o.paused, lifted: o.retired, complete: o.complete, problems: o.problems })), reach: p.reach, changeSetId: run.changeSetId },
        change: { before: { changeSetId: run.changeSetId, op: 'undo', harvestIds: a.harvestIds }, after: { op: 'undo', harvestIds: back.map((o) => o.harvestId) } },
      }
    }
    if (!plan || 'error' in plan) return notRun('Not run: the change set could not be planned again.')
    const asker = await askerOf(ctx)
    const out = await executeChangeSet(plan.plan, { actor: actorOf(ctx), actorId: asker, who })
    if (!out.ok && !out.campaigns.some((c) => c.ok) && !out.portfolios.some((x) => x.ok)) {
      return notRun(`Not run: nothing was harvested — ${out.items.slice(0, 3).map((i) => `"${i.term}": ${i.why}`).join('; ')}.`)
    }
    const keywords = out.items.map((i) => i.keywordTargetId).filter((x): x is string => !!x).sort()
    const negatives = out.items.flatMap((i) => i.negatives).sort()
    return {
      ok: true,
      data: {
        op: 'harvest', changeSetId: run.changeSetId, harvested: out.ok, notHarvested: out.failed, harvestIds: out.harvestIds,
        items: out.items, campaigns: out.campaigns, portfolios: out.portfolios, reach: p.reach,
        ...(out.failed ? { partial: true, problem: out.items.filter((i) => i.status !== 'DONE').slice(0, 5).map((i) => `"${i.term}": ${i.why}`).join('; ') } : {}),
        note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
      },
      change: {
        before: { changeSetId: run.changeSetId, op: 'harvest', harvestIds: [], keywords: [], negatives: [] },
        after: { op: 'harvest', harvestIds: out.harvestIds, keywords, negatives },
      },
    }
  }
}

export const HARVEST_ENGINE_TOOLS: AgentTool[] = [applyHarvestTool]
