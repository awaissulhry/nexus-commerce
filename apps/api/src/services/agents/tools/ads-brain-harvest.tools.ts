/**
 * ONE BRAIN AB-11 — `apply-brain-harvest`: the request a person decides for the ads brain's harvest (design
 * 2026-10-08-ads-one-brain/DESIGN.md §2.8, §6 PROPOSE; services/advertising/brain/harvest*.ts).
 *
 *   op harvest  ONE change set for one brain harvest (its harvestId, from ads-brain view harvest): the keyword (an ASIN:
 *               a product target) in the destination the brain chose, AND the negative exact (a negative product target)
 *               in every source where the term ran, so the source stops paying for it. Both halves are asked of the
 *               write gate first: any refusal and neither is written; the sources are negated only once the keyword
 *               stands; a negative that still fails leaves the pair half done, named, and the brain sends it again.
 *               At PROPOSE the brain asks for it itself; Claude may ask for one too (a shadow harvest the Owner wants).
 *   op undo     puts a harvest back as a pair: every source negative it made retired, so the term runs where it ran
 *               before, then the keyword paused (it stays at Amazon) — both halves asked of the gate first, and the keyword
 *               never paused while a source still blocks the term. The brain asks for it when its judgement after the
 *               attribution window + 72 h calls the harvest worse.
 *
 * Always a person — never by rule (ceiling ask): what runs alone is the brain itself at AUTO, inside its caps, once the
 * Owner turned the lever up. Refused, and not queued, when the harvest is not waiting for this, the destination cannot
 * take it now, the term found an exact home elsewhere meanwhile (one owner per term), or Amazon's write gate would refuse
 * either half. Its writes carry the approval as their change set; undo-change of a harvest asks for op undo.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { claimHarvest, executeClaimedPair, HARVEST_TOOL, undoHarvest, type Who } from '../../advertising/brain/harvest-write.js'
import { harvestRequestFacts, harvestStanding, markUndone, placeWords, WRITABLE } from '../../advertising/brain/harvest-request.js'
import { approvedRun, gateRefusal, notRun, reachNote, recheck, type RuleWrite, type StoredReach } from './ads-change-kit.js'
import { amountLabel, campaignCurrency } from './ads-tool-guards.js'
import { fingerprint, reachOver } from './ads-targeting-kit.js'
import type { AgentTool, ToolChange, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'

const INPUT = z.object({
  op: z.enum(['harvest', 'undo']).default('harvest')
    .describe('harvest (default): the keyword in its destination and the negative exact in every source, one change set; undo: put a harvest back (its keyword paused, its source negatives retired)'),
  harvestId: z.string().trim().min(1).max(64).describe('the brain harvest (its id, from ads-brain view harvest)'),
  why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the person who approves it and kept in the ads audit'),
})

/** What a person approves: the harvest, its destination, the bid, the sources still owed (or what an undo puts back), where it lands. */
const MATERIAL = ['basis', 'reach'] as const

async function preview(raw: Record<string, unknown>): Promise<ToolResult> {
  const parsed = INPUT.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'arguments'}: ${i.message}`).join('; ') }
  const facts = await harvestRequestFacts(parsed.data.harvestId, parsed.data.op)
  if ('error' in facts) return { ok: false, error: facts.error }
  const record = facts.record
  if (facts.op === 'undo') {
    const { keyword, pause, standing } = facts
    const writes: Array<RuleWrite & { label: string }> = [
      ...(pause && keyword ? [{ campaignId: keyword.campaign.id, adGroupId: keyword.id, marketplace: keyword.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${keyword.campaign.name}"` }] : []),
      ...standing.map((n) => ({ campaignId: n.place.campaign.id, marketplace: n.place.campaign.marketplace, changes: [{ field: 'status', valueCents: null }], label: `campaign "${n.place.campaign.name}"` })),
    ]
    const reached = await reachOver(writes)
    if ('refused' in reached) return { ok: false, error: `Not queued: ${reached.label}: ${gateRefusal(reached.refused)}` }
    const effect = `Puts back the ads brain's harvest of "${record.term}": `
      + [pause && keyword ? `the keyword in ${placeWords(keyword)} paused (it stays at Amazon)` : '', standing.length ? `${standing.length === 1 ? 'its source negative' : `its ${standing.length} source negatives`} retired (${standing.map((n) => placeWords(n.place)).join(', ')}), so the term runs where it ran before` : ''].filter(Boolean).join(', and ')
      + `.${record.verdict === 'WORSE' ? ` The brain's judgement: ${String(((record.judgement ?? {}) as { why?: string }).why ?? 'worse after its attribution window')}` : ''}`
    return {
      ok: true,
      preview: {
        action: HARVEST_TOOL, op: 'undo', harvestId: record.id, term: record.term, market: record.marketplace, productId: record.productId,
        changes: [
          ...(pause && keyword ? [{ label: `"${record.term}" · ${placeWords(keyword)}`, fromLabel: 'Enabled', toLabel: 'Paused' }] : []),
          ...standing.map((n) => ({ label: `negative "${record.term}" · ${placeWords(n.place)}`, fromLabel: 'Standing', toLabel: 'Retired' })),
        ],
        // Lifting a negative lets the term show the source's ads again: a raise, listed (a day-to-day change, no code).
        raises: standing.map((n) => `negative "${record.term}" · ${placeWords(n.place)} retired (the term shows these ads there again)`),
        basis: fingerprint({ harvestId: record.id, pause, negatives: standing.map((n) => n.id).sort() }),
        reach: reached.reach,
        reachNote: reachNote(reached.reach),
        effect,
      },
    }
  }
  const { dest, owed } = facts
  const bidCents = record.bidCents!
  const term = record.isAsin ? record.term.toUpperCase() : record.term
  const writes: Array<RuleWrite & { label: string }> = [
    ...(!record.keywordTargetId ? [{ campaignId: dest.campaign.id, adGroupId: dest.id, marketplace: dest.campaign.marketplace, changes: [{ field: 'bid', valueCents: bidCents }], label: `campaign "${dest.campaign.name}"` }] : []),
    ...owed.map((s) => ({ campaignId: s.place.campaign.id, marketplace: s.place.campaign.marketplace, changes: [{ field: 'negativeKeyword', valueCents: null }], isNegation: true, keywordText: term, label: `campaign "${s.place.campaign.name}"` })),
  ]
  if (!writes.length) return { ok: false, error: `Not queued: nothing of harvest ${record.id} is left to write.` }
  const reached = await reachOver(writes)
  if ('refused' in reached) return { ok: false, error: `Not queued: ${reached.label}: ${gateRefusal(reached.refused)}` }
  const currency = campaignCurrency(dest.campaign)
  const what = record.isAsin ? 'product target' : 'exact keyword'
  const effect = `${record.keywordTargetId ? `The ${what} "${record.term}" stands in ${placeWords(dest)}; ` : `Harvests "${record.term}": an ${what} at ${amountLabel(bidCents, currency)} in ${placeWords(dest)} (the ads brain's choice); `}`
    + (owed.length ? `then a negative exact of it in ${owed.map((s) => placeWords(s.place)).join(', ')}, so ${owed.length === 1 ? 'that ad group stops' : 'those ad groups stop'} paying for it — only once the keyword stands, and both halves or neither.` : 'no source is left to negate.')
  return {
    ok: true,
    preview: {
      action: HARVEST_TOOL, op: 'harvest', harvestId: record.id, term: record.term, market: record.marketplace, productId: record.productId, currency,
      destinationAdGroup: { id: dest.id, name: dest.name, campaign: dest.campaign.name, how: record.destHow },
      campaign: { id: dest.campaign.id, name: dest.campaign.name, marketplace: dest.campaign.marketplace },
      changes: [
        ...(!record.keywordTargetId ? [{ label: `${what} "${record.term}" · ${placeWords(dest)}`, fromLabel: 'none', toLabel: `at ${amountLabel(bidCents, currency)}` }] : []),
        ...owed.map((s) => ({ label: `negative exact "${record.term}" · ${placeWords(s.place)}`, fromLabel: 'none', toLabel: record.isAsin ? 'negative product target' : 'negative exact' })),
      ],
      raises: !record.keywordTargetId ? [`${what} "${record.term}" at ${amountLabel(bidCents, currency)}`] : [],
      sources: owed.map((s) => ({ adGroupId: s.adGroupId, action: s.action, why: s.why, ...(s.result ? { result: s.result } : {}) })),
      why: record.why,
      basis: fingerprint({ harvestId: record.id, term: record.term, dest: dest.id, bidCents, keyword: record.keywordTargetId, owed: owed.map((s) => s.adGroupId).sort() }),
      reach: reached.reach,
      reachNote: reachNote(reached.reach),
      effect,
      undoNote: 'Undo (undo-change) asks this tool for op undo: the keyword paused (it stays at Amazon) and its source negatives retired, so the term runs where it ran before.',
    },
  }
}

/** What a harvest's record holds now (the undo guard compares it with `after`). */
async function harvestNow(change: ToolChange): Promise<unknown> {
  const after = (change.after ?? {}) as { op?: unknown; harvestId?: unknown }
  if (after.op !== 'harvest' || typeof after.harvestId !== 'string') return change.after
  return { op: 'harvest', harvestId: after.harvestId, ...(await harvestStanding(after.harvestId)) }
}

/** C2 — undo of a brain harvest: this tool's own op undo (the keyword paused, the source negatives retired). */
export const BRAIN_HARVEST_UNDO: ToolUndo = {
  current: harvestNow,
  request(change) {
    const after = (change.after ?? {}) as { op?: unknown; harvestId?: unknown }
    if (after.op === 'undo') return { refusal: 'An undo of a harvest is not put back: the brain decides the term again after its cooldown.' }
    if (typeof after.harvestId !== 'string') return { refusal: 'This change does not name the harvest it made.' }
    return { tool: HARVEST_TOOL, args: { op: 'undo', harvestId: after.harvestId, why: 'undo of an ads brain harvest: its keyword paused, its source negatives retired' } }
  },
}

const applyBrainHarvest: AgentTool = {
  name: HARVEST_TOOL,
  title: 'Apply an ads brain harvest',
  input: INPUT,
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  restrictedFields: { money: FIELDS.financialsAdspendView },
  category: 'advertising',
  riskTier: 'high',
  readOnly: false,
  requiresApprovalDefault: true,
  // A keyword and its negatives are created at Amazon at once (no cancel window).
  openWorld: true,
  // Undo pauses the keyword (it served meanwhile) and retires the source negatives.
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: BRAIN_HARVEST_UNDO,
  description:
    'Apply ONE Amazon Sponsored Products harvest the ads brain decided (harvestId, from ads-brain view harvest), as one '
    + 'change set: the keyword (EXACT; an ASIN becomes a product target) in the destination the brain chose — the Owner\'s '
    + 'stored harvest destination, the product\'s playbook exact slot, or its exact ad group — at the brain\'s start bid, '
    + 'and the negative exact of the term in every ad group of the product where it ran, so those stop paying for it. '
    + 'Both halves are asked of Amazon\'s write gate first: any refusal and neither is written; the sources are negated '
    + 'only once the keyword stands; a negative that still fails leaves the pair half done and the brain sends it again. '
    + 'op undo puts a harvest back as a pair: its source negatives retired, then its keyword paused (it stays at Amazon). Nothing '
    + 'changes until a person approves it in Nexus; it never runs by rule (the brain itself writes at AUTO, inside its '
    + 'caps). A new keyword adds spend: listed in raises, a day-to-day change with no authenticator code. Refused, and not '
    + 'queued, when the harvest is not waiting for this, the destination does not serve now, the term found a home in '
    + 'another ad group of the product meanwhile (one owner per term), or the write gate would refuse either half.',
  async handler(args) {
    return preview(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await preview(args)
    const refusal = recheck(ctx, fresh, MATERIAL)
    if (refusal) return notRun(refusal)
    const p = fresh.preview as { op: 'harvest' | 'undo'; harvestId: string; term: string; reach: StoredReach; effect: string }
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const who: Who = { actor: run.actor, manual: run.manual, confirmOwnLimits: run.confirmOwnLimits, changeSetId: run.changeSetId, reason: run.reason }
    const now = new Date()
    if (p.op === 'undo') {
      const u = await undoHarvest(p.harvestId, who)
      if (!u.paused && !u.retired) return notRun(`Not run: nothing was put back — ${u.problems.join('; ') || 'nothing was left to put back'}.`)
      await markUndone(p.harvestId, { approvalId: run.changeSetId, paused: u.paused, retired: u.retired, problems: u.problems, now })
      return {
        ok: true,
        data: { harvestId: p.harvestId, paused: u.paused, retired: u.retired, ...(u.problems.length ? { partial: true, problem: `Not put back: ${u.problems.join('; ')}.` } : {}), reach: p.reach, changeSetId: run.changeSetId },
        change: { before: { changeSetId: run.changeSetId, op: 'undo', harvestId: p.harvestId }, after: { op: 'undo', harvestId: p.harvestId, paused: u.paused, retired: u.retired } },
      }
    }
    if (!(await claimHarvest(p.harvestId, WRITABLE, now))) return notRun(`Not run: the harvest of "${p.term}" is being written by the brain right now, or it is no longer waiting. Nothing changed.`)
    const o = await executeClaimedPair(p.harvestId, who, now, { retryRefused: true })
    if (o.status !== 'DONE' && o.status !== 'HALF_DONE') return notRun(`Not run: ${o.why}.`)
    const negatives = o.sources.map((s) => s.negativeTargetId).filter((x): x is string => !!x).sort()
    return {
      ok: true,
      data: {
        harvestId: p.harvestId, status: o.status, keywordTargetId: o.keyword?.targetId ?? null, negatives,
        ...(o.status === 'HALF_DONE' ? { partial: true, problem: o.why } : {}),
        reach: p.reach, changeSetId: run.changeSetId,
        note: p.reach.reach === 'live' ? 'Created at Amazon at once (no cancel window).' : 'Sandbox: recorded in Nexus only; nothing reached Amazon.',
      },
      change: {
        before: { changeSetId: run.changeSetId, op: 'harvest', harvestId: p.harvestId, keyword: null, negatives: [] },
        after: { op: 'harvest', harvestId: p.harvestId, keywordTargetId: o.keyword?.targetId ?? null, negatives },
      },
    }
  },
}

export const ADS_BRAIN_HARVEST_TOOLS: AgentTool[] = [applyBrainHarvest]
