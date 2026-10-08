/**
 * ONE BRAIN AB-20 — `retire-ads-writers`: switch off, for one product × market, the configuration rows of the writers the
 * product's brain replaces — and switch them on again (design 2026-10-08-ads-one-brain/DESIGN.md §3, §8 row AB-20; the rules
 * are advertising/brain/retire.ts, the reads and writes advertising/brain/retire-run.ts):
 *
 *   op retire     only when every lever of the product is AUTO or the Owner's own choice under the live server switch: each
 *                 enabled ads rule, budget schedule, budget pool, classic dayparting schedule, coverage set or autopilot plan
 *                 whose whole reach is the product's own campaigns there, and whose every lever the brain (or the Owner's
 *                 lock) holds on them, is switched off — never deleted — with a record of what it was. The preview lists
 *                 exactly what is switched off and what stays, each with why. The brain also asks for it by itself once a
 *                 product is ready, only under NEXUS_ADS_BRAIN_RETIRE=ask.
 *   op give-back  switch the retired rows of the product on again (all, or retirementIds), each only while nobody changed it
 *                 since (else left as the person made it). It also happens by itself when the product leaves the brain, a
 *                 lever goes back from AUTO or from the Owner's choice, a kill switch stops a lever, or the server switch
 *                 leaves live (set-ads-brain and set-brain-kill-switch at once; the 15-minute tick for the rest).
 *
 * Nexus only: nothing is sent to Amazon (the rows that stay on, and the brain, write as before). A person approves every op in
 * Nexus; nothing changes until then. It runs on the plan it was approved on (its basis): anything moved since refuses it.
 * Its undo is the other op on the same rows.
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import { RETIRE_TOOL, WRITER_WORDS, isRetireWriter } from '../../advertising/brain/retire.js'
import { giveBackPreview, giveBackRetirements, loadRetireFacts, runRetirement } from '../../advertising/brain/retire-run.js'
import { approvedRun, notRun } from './ads-change-kit.js'
import { isLiveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import type { AgentTool, PlanEntities, ToolContext, ToolResult } from '../tool-types.js'

const OPS = ['retire', 'give-back'] as const
type Op = (typeof OPS)[number]
const ID = z.string().trim().min(1).max(64)

/** What the tool records as a change (its undo reads it). */
interface RetireChange { op: Op; productId: string; market: string; retirementIds: string[]; rows: Array<{ writer: string; id: string; name: string }> }

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '')

async function preview(args: Record<string, unknown>): Promise<ToolResult> {
  const op: Op = args.op === 'give-back' ? 'give-back' : 'retire'
  const productId = text(args.productId)
  const market = text(args.market).toUpperCase()
  // MCP.12 — a product named by id is checked first: a deleted or unknown one is not found, before anything else is asked.
  if (!productId || !(await isLiveProduct(productId))) return { ok: false, error: PRODUCT_NOT_FOUND }
  const facts = await loadRetireFacts(productId, market)
  if ('refusal' in facts) return { ok: false, error: facts.refusal === PRODUCT_NOT_FOUND ? PRODUCT_NOT_FOUND : `Not queued: ${facts.refusal}` }
  const where = `${facts.name ? `"${facts.name}" (${facts.productId})` : `product ${facts.productId}`} in ${facts.market}`
  if (op === 'retire') {
    if (!facts.readiness.ready) return { ok: false, error: `Not queued: the writers of ${where} cannot retire yet — ${facts.readiness.why} (ads-brain view retire lists every lever)` }
    if (!facts.plan.retire.length) return { ok: false, error: `Not queued: nothing to retire for ${where} — no writer the brain replaces has a row of its own on its campaigns (${facts.plan.keep.length} stay, each with why: ads-brain view retire)` }
    const rows = facts.plan.retire.map((r) => ({ writer: r.writer, what: WRITER_WORDS[r.writer], id: r.id, name: r.name, setUp: r.scope, levers: r.levers, campaigns: r.campaignIds, why: r.why }))
    const effect = `Switches off ${rows.length} configuration row${rows.length === 1 ? '' : 's'} of writers the brain replaces on the own campaigns of ${where}: `
      + `${rows.map((r) => `the ${r.what} "${r.name}" (${r.levers.join(', ')})`).join('; ')}. Each is kept, never deleted, with a record of what it was, and switched on again if the product leaves the brain, `
      + `a lever goes back from AUTO, a kill switch stops a lever or the server switch leaves live. ${facts.plan.keep.length} row${facts.plan.keep.length === 1 ? '' : 's'} stay on (each with why); the brain's run-time skip keeps them off its levers. Nothing is sent to Amazon.`
    return {
      ok: true,
      preview: {
        action: RETIRE_TOOL, op, product: { productId: facts.productId, name: facts.name, market: facts.market },
        switchesOff: rows,
        staysOn: facts.plan.keep.map((r) => ({ writer: r.writer, what: WRITER_WORDS[r.writer], id: r.id, name: r.name, why: r.why })),
        noRowOfTheirOwn: facts.plan.rowless.map((w) => ({ writer: w.writer, why: w.why })),
        ready: facts.readiness.why,
        basis: facts.plan.basis,
        summary: `Retire ${rows.length} duplicate writer${rows.length === 1 ? '' : 's'} of ${where}.`,
        effect,
        consequences: effect,
      },
    }
  }
  const wanted = Array.isArray(args.retirementIds) ? (args.retirementIds as unknown[]).map(String).filter(Boolean) : []
  const records = facts.retired.filter((r) => !wanted.length || wanted.includes(r.id))
  if (wanted.length && records.length !== new Set(wanted).size) return { ok: false, error: `Not queued: ${wanted.filter((id) => !facts.retired.some((r) => r.id === id)).join(', ')} ${wanted.length === 1 ? 'is' : 'are'} not a row this product's brain holds switched off (ads-brain view retire lists them)` }
  if (!records.length) return { ok: false, error: `Not queued: the brain of ${where} holds no row switched off: nothing to give back` }
  const would = await giveBackPreview(records)
  const on = would.filter((w) => w.act === 'switchOn')
  const effect = `Gives back ${records.length} retired row${records.length === 1 ? '' : 's'} of ${where}: ${on.length} switched on again exactly as before`
    + `${would.length - on.length ? `; ${would.filter((w) => w.act !== 'switchOn').map((w) => `the ${isRetireWriter(w.writer) ? WRITER_WORDS[w.writer] : w.writer} "${w.name}" ${w.why}`).join('; ')}` : ''}. Today's engines then write those campaigns as before, the run-time skip leaving whatever the brain still owns. Nothing is sent to Amazon by this change itself.`
  return {
    ok: true,
    preview: {
      action: RETIRE_TOOL, op, product: { productId: facts.productId, name: facts.name, market: facts.market },
      givesBack: would.map((w) => ({ retirementId: w.recordId, writer: w.writer, id: w.targetId, name: w.name, does: w.act, why: w.why })),
      basis: `give-back|${records.map((r) => `${r.id}:${r.left}`).sort().join(',')}`,
      summary: `Give back ${records.length} retired writer${records.length === 1 ? '' : 's'} of ${where}.`,
      effect,
      consequences: effect,
    },
  }
}

const retireAdsWriters: AgentTool = {
  name: RETIRE_TOOL,
  title: 'Retire duplicate ad writers',
  category: 'advertising',
  description:
    'Retire, for one product in one Amazon market, the duplicate writers its ads brain replaces — or give them back. op retire: '
    + 'only once every lever of the product\'s brain is AUTO or the Owner\'s own choice under the live server switch; then each enabled '
    + 'ads rule, budget schedule, budget pool, classic dayparting schedule, coverage set or autopilot plan whose whole reach is the '
    + 'product\'s own campaigns there, and whose every lever the brain (or the Owner\'s lock) holds on them, is switched off — never '
    + 'deleted — with a record of what it was. A row that also reaches another product, a shared campaign, another market or the whole '
    + 'business stays on, and so does a rule whose bid asks are the bid brain\'s inputs, one that also notifies, or a schedule still '
    + 'holding what its window set; the preview lists exactly what is switched off and what stays, each with why. op give-back: the '
    + 'retired rows switched on again (all, or retirementIds), each only while nobody changed it since. Leaving the brain, a lever going '
    + 'back from AUTO, a kill switch or the server switch leaving live gives them back by itself. Nexus only: nothing is sent to Amazon. '
    + 'A person approves every op in Nexus; nothing changes until then, and an approved change runs only on the facts it was approved on. '
    + 'ads-brain view retire shows what would retire, what is retired and why.',
  input: z.object({
    op: z.enum(OPS).describe('retire: switch off the rows the preview lists; give-back: switch the retired rows on again'),
    productId: ID.describe('the product, its Nexus id (a variation names its parent\'s brain)'),
    market: z.string().trim().toUpperCase().min(2).max(20).describe('one Amazon market code, e.g. IT (business-overview lists them)'),
    retirementIds: z.array(ID).max(100).optional().describe('give-back: only these retired rows (ads-brain view retire, retiredNow[].recordId); omitted, every one of the product'),
    why: z.string().trim().max(300).optional().describe('why, in a sentence: shown to the approver and kept with the record'),
  }),
  requires: [F.adsAutomationManage, F.adsCampaignsManage],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  requiresApprovalDefault: true,
  // Nexus rows only: the engines and the brain write Amazon as before.
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: {
    async current(change) {
      const after = (change.after ?? {}) as RetireChange
      const facts = after.productId ? await loadRetireFacts(after.productId, after.market) : null
      const retired = facts && !('refusal' in facts) ? facts.retired.map((r) => r.id) : []
      return { ...after, retirementIds: after.op === 'retire' ? after.retirementIds.filter((id) => retired.includes(id)) : after.retirementIds }
    },
    request(change) {
      const after = (change.after ?? {}) as RetireChange
      if (!after.productId || !after.market) return { refusal: 'This change does not record the product it retired writers of.' }
      return after.op === 'retire'
        ? { tool: RETIRE_TOOL, args: { op: 'give-back', productId: after.productId, market: after.market, retirementIds: after.retirementIds, why: 'undo of a retirement' } }
        : { tool: RETIRE_TOOL, args: { op: 'retire', productId: after.productId, market: after.market, why: 'undo of a give-back: retire again' } }
    },
  },
  planEntities: (args): PlanEntities => {
    const productId = text(args.productId)
    const market = text(args.market).toUpperCase()
    const keys = productId && market ? [`ads-brain:${productId}@${market}` as const] : []
    return { reads: keys, writes: keys }
  },
  async handler(args) {
    return preview(args)
  },
  async execute(args, ctx: ToolContext) {
    const fresh = await preview(args)
    if (!fresh.ok) return notRun((fresh.error ?? 'it is no longer a valid change').replace(/^Not queued/, 'Not run'))
    const p = fresh.preview as { op: Op; basis: string; summary: string; product: { productId: string; market: string } }
    const approved = ctx.approvedPreview as { basis?: unknown } | undefined
    if (approved?.basis !== undefined && approved.basis !== p.basis) return notRun('Not run: what you approved changed since (a row it switches off, or what it reaches, moved). Nothing changed: preview it again.')
    const run = approvedRun(ctx, text(args.why) || p.summary)
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    if (p.op === 'retire') {
      const done = await runRetirement({ productId: p.product.productId, market: p.product.market, by: run.actor, approvalId: ctx.approvalId ?? null, expectBasis: p.basis })
      if ('refusal' in done) return notRun(`Not run: ${done.refusal}`)
      const rows = done.retired.map((r) => ({ writer: r.writer, id: r.targetId, name: r.name }))
      const change: RetireChange = { op: 'retire', productId: p.product.productId, market: p.product.market, retirementIds: done.retired.map((r) => r.recordId), rows }
      return {
        ok: true,
        data: { op: 'retire', productId: p.product.productId, market: p.product.market, retired: done.retired, note: 'ads-brain view retire shows each retired row and what a give-back would do with it.' },
        change: { before: { ...change, op: 'give-back' }, after: change },
      }
    }
    const wanted = Array.isArray(args.retirementIds) ? (args.retirementIds as unknown[]).map(String) : null
    const back = await giveBackRetirements({ productId: p.product.productId, market: p.product.market, by: run.actor, why: run.reason, recordIds: wanted })
    const change: RetireChange = { op: 'give-back', productId: p.product.productId, market: p.product.market, retirementIds: back.map((b) => b.recordId), rows: back.map((b) => ({ writer: b.writer, id: b.targetId, name: b.name })) }
    return {
      ok: true,
      data: { op: 'give-back', productId: p.product.productId, market: p.product.market, gaveBack: back.map((b) => ({ retirementId: b.recordId, writer: b.writer, id: b.targetId, name: b.name, did: b.act, why: b.why })) },
      change: { before: { ...change, op: 'retire' }, after: change },
    }
  },
}

export const ADS_BRAIN_RETIRE_TOOLS: AgentTool[] = [retireAdsWriters]
