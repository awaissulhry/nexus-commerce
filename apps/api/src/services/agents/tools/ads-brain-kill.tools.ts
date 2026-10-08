/**
 * ONE BRAIN AB-15 — the kill switch per lever (services/advertising/brain/kill-switch.ts):
 *
 *   set-brain-kill-switch   op kill: stop ONE lever of the ads brain — for one product in one market, or for every product
 *                           (in one market, or in every market) — at once. The brain writes and asks nothing on that lever
 *                           (each lever's run holds, naming the kill), and Amazon's write gate refuses the brain's own actor
 *                           on it, a lowering by the brain included. The brain's other levers, a person's own edits, the
 *                           safety checks and every other engine are as before. op end: the kill ends and the brain writes
 *                           that lever again as its level says. Kept with who, when and why; the ads-brain map shows each.
 *
 * Nexus only (nothing is sent to Amazon by the switch itself). A person approves every op in Nexus (Claude asks with the
 * Owner's word); ending a kill needs no authenticator code (like resume-automation: the levels the brain returns to were
 * set with their own approvals). Its undo is the opposite op.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { strategyMarket } from '../../advertising/ads-strategy/bids.js'
import { BRAIN_LEVERS, type BrainLever } from '../../advertising/brain/levers.js'
import { endBrainKill, killScopeWords, killStanding, killTarget, killWords, setBrainKill, type BrainKill } from '../../advertising/brain/kill-switch.js'
import { productFamily } from '../../advertising/brain/ownership.js'
import { resolveBrainSettings, type OverrideRow } from '../../advertising/brain/settings.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { isLiveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import type { AgentTool, ToolContext, ToolResult } from '../tool-types.js'

export const KILL_TOOL = 'set-brain-kill-switch'
const OPS = ['kill', 'end'] as const
type Op = (typeof OPS)[number]

/** What the switch records as a change (its undo reads it). */
interface KillChange { op: Op; lever: BrainLever; productId: string | null; market: string | null; killed: boolean; reason: string | null }

const OVERRIDE_SELECT = { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true } as const

/** The enrolled products a kill of this target reaches, each with the lever's level there (what ending it gives back). */
async function reached(t: { lever: BrainLever; productId: string | null; market: string | null }): Promise<Array<{ productId: string; market: string; level: string }>> {
  const enrollments = await prisma.adsBrainEnrollment.findMany({
    where: { ...(t.productId ? { productId: t.productId } : {}), ...(t.market ? { marketplace: t.market } : {}) },
    select: { productId: true, marketplace: true }, take: 100, orderBy: [{ marketplace: 'asc' }, { productId: 'asc' }],
  })
  if (!enrollments.length) return []
  const overrides: OverrideRow[] = await prisma.adsBrainOverride.findMany({ where: { endedAt: null, scope: 'PRODUCT', productId: { in: enrollments.map((e) => e.productId) } }, select: OVERRIDE_SELECT })
  return enrollments.map((e) => ({ productId: e.productId, market: e.marketplace, level: resolveBrainSettings({ productId: e.productId, market: e.marketplace, enrolled: true, overrides }).levers[t.lever].effective }))
}

async function preview(args: Record<string, unknown>): Promise<ToolResult> {
  const op: Op = args.op === 'end' ? 'end' : 'kill'
  // MCP.12 — a product named by id is checked first: a deleted or unknown one is not found, before anything else is asked.
  if (typeof args.productId === 'string' && args.productId.trim() && !(await isLiveProduct(args.productId.trim()))) return { ok: false, error: PRODUCT_NOT_FOUND }
  const t = killTarget({ lever: args.lever, productId: args.productId as string | null, market: args.market as string | null, reason: (args.why as string | undefined) ?? null }, op)
  if ('refusal' in t) return { ok: false, error: t.refusal }
  let productId = t.productId
  let name: string | null = null
  if (productId) {
    const family = await productFamily(productId)
    if (!family) return { ok: false, error: `product ${productId} is not found here, or it has no single family: fix its family first (product-identity)` }
    productId = family.root
    name = (await prisma.product.findFirst({ where: { id: family.root }, select: { name: true } }))?.name ?? null
  }
  const target = { lever: t.lever, productId, market: t.market }
  const standing = await killStanding(target)
  if (op === 'end' && !standing) return { ok: false, error: `no kill switch stops the ${t.lever} lever of ${killScopeWords(target)}: nothing to end` }
  const products = await reached(target)
  const where = productId ? `${name ? `"${name}" (${productId})` : `product ${productId}`} in ${t.market}` : killScopeWords(target)
  const acting = products.filter((p) => p.level === 'AUTO' || p.level === 'PROPOSE')
  const effect = op === 'kill'
    ? `Stops the ${t.lever} lever of the ads brain for ${where}${standing ? ` (it replaces the kill set by ${standing.by} on ${standing.at.slice(0, 10)})` : ''}: the brain writes and asks nothing on it — each lever's run holds and names this kill — and Amazon's write gate refuses the brain's own actor on it, a lowering by the brain included. `
      + `${products.length ? `It reaches ${products.length} enrolled product${products.length === 1 ? '' : 's'}${acting.length ? `, ${acting.length} of them with the lever at PROPOSE or AUTO now` : ''}. ` : 'No enrolled product is reached now; the kill holds whatever is enrolled later in its scope. '}`
      + 'The brain\'s other levers, a person\'s own edits, the safety checks and every other engine are as before. Nothing is sent to Amazon by the switch itself.'
    : `Ends the kill switch on the ${t.lever} lever for ${where} (set by ${standing!.by} on ${standing!.at.slice(0, 10)}: "${standing!.reason}"): the brain writes that lever again as its level says`
      + `${acting.length ? ` — ${acting.map((p) => `${p.productId} in ${p.market} at ${p.level}`).slice(0, 5).join(', ')}${acting.length > 5 ? ` and ${acting.length - 5} more` : ''}` : ' — no reached product has it at PROPOSE or AUTO now, so nothing writes yet'}. Nothing is sent to Amazon by the switch itself.`
  return {
    ok: true,
    preview: {
      action: KILL_TOOL,
      op,
      kill: { lever: t.lever, productId, market: t.market, scope: killScopeWords(target), reason: op === 'kill' ? t.reason : standing!.reason },
      standing: standing ? { by: standing.by, at: standing.at, reason: standing.reason } : null,
      reached: products,
      // What the approval runs on: a change of the standing kill since the request refuses the run.
      basis: `${op}|${t.lever}|${productId ?? '*'}|${t.market ?? '*'}|${standing?.id ?? 'none'}`,
      summary: op === 'kill' ? `Stop the brain's ${t.lever} lever for ${where}.` : `End the kill switch on the brain's ${t.lever} lever for ${where}.`,
      effect,
    },
  }
}

const setBrainKillSwitch: AgentTool = {
  name: KILL_TOOL,
  title: 'Stop or restart a brain lever',
  category: 'advertising',
  description:
    'The ads brain\'s kill switch, one lever at a time. op kill: stop ONE lever of the brain (bids, adGroupBids, hours, placements, '
    + 'state, budgets, portfolioCap, negatives, harvest, structure, biddingStrategy, offAmazon) for one product in one market '
    + '(productId and market), or for every product (leave productId out; with market, in that market; without, in every market) — at '
    + 'once. The brain then writes and asks nothing on that lever (each lever\'s run holds and names the kill) and Amazon\'s write gate '
    + 'refuses the brain\'s own writer on it, a lowering by the brain included; the brain\'s other levers, a person\'s own edits, the '
    + 'safety checks and every other engine are as before. Say why (why): it is kept with who and when, and shown in the ads-brain map. '
    + 'op end: the kill ends and the brain writes that lever again as its level says. Nothing is sent to Amazon by the switch itself. '
    + 'A person approves every op in Nexus; nothing changes until then. Its undo is the opposite op.',
  input: z.object({
    op: z.enum(OPS).describe('kill: stop the lever; end: end the kill (the brain writes the lever again as its level says)'),
    lever: z.enum(BRAIN_LEVERS).describe('the one lever of the brain to stop or restart'),
    productId: z.string().trim().min(1).max(64).optional().describe('one product (any member of its family; its family root is used); leave out to stop the lever for every product'),
    market: z.string().trim().min(2).max(16).optional().describe('the Amazon market code (business-overview): required with productId; without productId, only that market (leave out: every market)'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence (op kill: required, 3 characters or more): kept with the kill and shown wherever the lever holds'),
  }),
  requires: [F.adsAutomationManage],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // The switch writes Nexus only: the brain's writes to Amazon stop (or resume, through the brain's own runs).
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as KillChange
      const standing = after.lever ? await killStanding({ lever: after.lever, productId: after.productId, market: after.market }) : null
      return { ...after, killed: !!standing, reason: standing?.reason ?? null }
    },
    request(change) {
      const before = (change.before ?? {}) as KillChange
      if (!before.lever) return { refusal: 'This change does not record the lever it stopped.' }
      const target = { lever: before.lever, ...(before.productId ? { productId: before.productId } : {}), ...(before.market ? { market: before.market } : {}) }
      return before.killed
        ? { tool: KILL_TOOL, args: { op: 'kill', ...target, why: (before.reason ?? 'undo: the kill switch set again').slice(0, 300) } }
        : { tool: KILL_TOOL, args: { op: 'end', ...target, why: 'undo of a kill switch' } }
    },
  },
  async handler(args) {
    return preview(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await preview(args)
    if (!fresh.ok) return notRun(`Not run: ${fresh.error}`)
    const p = fresh.preview as { op: Op; kill: { lever: BrainLever; productId: string | null; market: string | null; reason: string }; standing: { reason: string } | null; basis: string; effect: string }
    const approved = ctx.approvedPreview as { basis?: unknown } | undefined
    if (approved?.basis && approved.basis !== p.basis) return notRun('Not run: the kill switch of that lever changed since it was approved. Nothing changed.')
    const run = approvedRun(ctx, String(args.why ?? '') || p.effect)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const target = { lever: p.kill.lever, productId: p.kill.productId, market: p.kill.market }
    const before: KillChange = { op: p.op, ...target, killed: !!p.standing, reason: p.standing?.reason ?? null }
    let kill: BrainKill
    if (p.op === 'kill') {
      const out = await setBrainKill({ ...target, reason: p.kill.reason, by: run.actor })
      if ('refusal' in out) return notRun(`Not run: ${out.refusal}`)
      kill = out.kill
    } else {
      const out = await endBrainKill({ ...target, by: run.actor })
      if ('refusal' in out) return notRun(`Not run: ${out.refusal}`)
      kill = out.ended
    }
    const after: KillChange = { op: p.op, ...target, killed: p.op === 'kill', reason: p.op === 'kill' ? kill.reason : null }
    return {
      ok: true,
      data: { op: p.op, lever: kill.lever, productId: kill.productId, market: strategyMarket(kill.market) ?? kill.market, words: p.op === 'kill' ? killWords(kill) : `the kill switch on the ${kill.lever} lever of ${killScopeWords(kill)} ended`, by: run.actor },
      change: { before, after },
    }
  },
}

export const ADS_BRAIN_KILL_TOOLS: AgentTool[] = [setBrainKillSwitch]
