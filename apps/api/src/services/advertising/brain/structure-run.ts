/**
 * ONE BRAIN AB-16 — the structure lever's run and its requests (design 2026-10-08-ads-one-brain/DESIGN.md §2.9, §4 step 3
 * "structure (weekly)", §5, §8 row AB-16, §10 D1 = B, D2 = A). Inside one business, for every enrolled product whose
 * structure lever is OBSERVE, PROPOSE or locked (brain/structure-load.ts structureDue). Per product, in this order:
 *
 *   1 pending   every day: what earlier runs asked. A build a person approved → BUILT, with the campaigns it made (the
 *               create's change, the playbook build's run, each replicate run of a split's change plan); declined or expired
 *               → DECLINED (not asked again for 30 days). A BUILT campaign's go-live is asked once (LIVE_PROPOSED), and it is
 *               LIVE once every campaign serves (enabled, on the live-write allowlist, its bids no longer at the floor it was
 *               born at) — its bids are the bid brain's from there. A split that is LIVE asks for the shared campaign's low
 *               bids (suppress-campaign) and is DONE once the shared campaign no longer serves. A move a person approved is
 *               DONE once every campaign sits in the portfolio. Asked only at PROPOSE under the live ceiling; never alone.
 *   2 decide    weekly (Monday in the market's time zone; `force` for a person's dry run and the tests): the facts
 *               (structure-load.ts), the decisions (structure.ts decideStructure), each stored on its key's row.
 *   3 act       OBSERVE (or a shadow ceiling, or the kill switch): stored as SHADOW, what it would ask in words. PROPOSE:
 *               the builder's own request through the normal approval gate, as "Nexus ads brain" (forceAsk: always a
 *               person, never by rule) — one tool call, or one change plan for a split (one replicate per product). A
 *               builder's refusal is stored as HELD with its own words. Held: HELD with why.
 *   store       one row per market × key (AdsBrainStructure): an unchanged shadow or held decision is only stamped; a
 *               standing one (asked, built, live, done) is never decided again — a campaign is built once.
 *   kept        shadow and held rows no run checked for 30 days, and ended ones (declined, failed) older than 90 days, are
 *               deleted; the others stay (the go-live's code rule reads them).
 *
 * Production as AB-16 ships: no product is enrolled → nothing is read past the enrollments; enrolled at OBSERVE (the
 * default) → shadow rows only; PROPOSE asks only under NEXUS_ADS_BRAIN_STRUCTURE_MODE=live. Nothing here writes to Amazon:
 * every build, go-live, move and low-bid stop is a request a person approves.
 */
import { createHash, randomUUID } from 'node:crypto'
import { Prisma } from '@nexus/database'
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { localDayHour } from './hours-research.js'
import { leverKillWhy } from './kill-switch.js'
import { loadStructureFacts, structureCeiling, structureDue, type StructureDue, type StructureDueProduct } from './structure-load.js'
import {
  COOLDOWN_DAYS, decideStructure, STRUCTURE_ASKER, STRUCTURE_TOOLS,
  type StructureDecision, type StructureProductFacts, type StructureRequest, type StructureStatus,
} from './structure.js'

export const STRUCTURE_SHADOW_DAYS_KEPT = 30
export const STRUCTURE_ENDED_DAYS_KEPT = 90
/** The day of the week the decisions run on, in the market's time zone (design §4: weekly, Monday). */
export const STRUCTURE_WEEKDAY = 1
const DAY_MS = 86_400_000
const AGENT_KEY = 'ads-brain-structure'

/** Approval statuses that end a request without running it. */
const NOT_RUN = ['rejected', 'expired', 'superseded', 'cancelled']
const json = (v: unknown) => v as Prisma.InputJsonValue
const digestOf = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('base64url').slice(0, 22)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const obj = (v: unknown): Record<string, any> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : {})

/** Is the weekly decision due in this market now (Monday in its time zone)? Pure. */
export function weeklyDue(now: Date, market: string): boolean {
  const { day } = localDayHour(now, MARKET_TIME_ZONE[market] ?? 'Europe/Rome')
  return new Date(`${day}T00:00:00Z`).getUTCDay() === STRUCTURE_WEEKDAY
}

export interface StructureRunSummary {
  ran: boolean
  why: string
  runId?: string
  products: number
  markets: string[]
  decided: { skc: number; split: number; portfolio: number; held: number }
  acted: { logged: number; proposed: number }
  pending: { synced: number; built: number; liveAsked: number; live: number; retireAsked: number; done: number; declined: number; failed: number }
  notDue: number
  skipped: Array<{ productId: string; market: string; why: string }>
  failed: Array<{ productId: string; market: string; error: string }>
  pruned: number
}

const blank = (): Pick<StructureRunSummary, 'decided' | 'acted' | 'pending'> => ({
  decided: { skc: 0, split: 0, portfolio: 0, held: 0 },
  acted: { logged: 0, proposed: 0 },
  pending: { synced: 0, built: 0, liveAsked: 0, live: 0, retireAsked: 0, done: 0, declined: 0, failed: 0 },
})

// ── Requests a person decides ───────────────────────────────────────────────────────────────────────────────────

/**
 * Ask a person through the normal approval gate as Nexus's ads brain (forceAsk: never by rule): one tool, or a change
 * plan of several (one approval). A refusal comes back with the builder's own words.
 */
export async function askPerson(request: StructureRequest, label: string): Promise<{ approvalId: string } | { error: string }> {
  const { systemPrincipal } = await import('../../agents/call-tool.js')
  const run = await prisma.agentRun.create({ data: { agentKey: AGENT_KEY, trigger: 'schedule', status: 'running', input: json({ label, request }) } })
  let approvalId: string | null = null
  let error: string | null = null
  if ('plan' in request) {
    const { queuePlan } = await import('../../agents/change-plan.service.js')
    const asked = await queuePlan({ title: request.plan.title, steps: request.plan.steps }, systemPrincipal(STRUCTURE_ASKER), run.id)
    if (asked.mode === 'queued' && asked.approvalId) approvalId = asked.approvalId
    else error = asked.error ?? 'the change plan was not queued'
  } else {
    const { runOrQueueTool } = await import('../../agents/approval-gate.service.js')
    const asked = await runOrQueueTool(request.tool, request.args, systemPrincipal(STRUCTURE_ASKER), run.id, { forceAsk: true })
    if (asked.mode === 'queued' && asked.approvalId) approvalId = asked.approvalId
    else error = asked.error ?? 'the request was not queued'
  }
  await prisma.agentRun.update({
    where: { id: run.id },
    data: approvalId ? { status: 'done', ok: true, endedAt: new Date(), output: json({ mode: 'queued', approvalId }) } : { status: 'failed', ok: false, endedAt: new Date(), errorMessage: error },
  })
  return approvalId ? { approvalId } : { error: error ?? 'not queued' }
}

/** The go-live request of a built proposal: the playbook's START of a hero, else the allowlist and the restore of each campaign. */
export function goLiveRequest(r: { kind: string; builder: string | null; term: string | null; productId: string; marketplace: string; builtCampaignIds: readonly string[]; label: string }): StructureRequest {
  const why = `Ads brain (D1 = B): ${r.label} goes live — a normal approval inside the caps`.slice(0, 300)
  if (r.kind === 'SKC' && r.builder === STRUCTURE_TOOLS.playbook && r.term) {
    return { tool: STRUCTURE_TOOLS.playbook, args: { op: 'start', market: r.marketplace, productId: r.productId, slots: [`hero:${r.term}`], why } }
  }
  return {
    plan: {
      title: `Ads brain — ${r.label} goes live`.slice(0, 120),
      steps: r.builtCampaignIds.flatMap((campaignId) => [
        { tool: STRUCTURE_TOOLS.liveWrites, args: { campaignId, enabled: true, why } },
        { tool: STRUCTURE_TOOLS.restore, args: { campaignId, why } },
      ]),
    },
  }
}

// ── Storing ──────────────────────────────────────────────────────────────────────────────────────────────────────

const statusOf = (d: StructureDecision): StructureStatus => (d.act === 'none' ? 'HELD' : d.act === 'log' ? 'SHADOW' : 'PROPOSED')

/** How many new campaigns a decision takes (an SKC one, a split one per product's copy, a move none). */
const takes = (d: StructureDecision): number => (d.kind === 'SKC' ? 1 : d.kind === 'SPLIT' ? ((d.request && 'plan' in d.request ? d.request.plan.steps.length : (d.evidence.products as unknown[] | undefined)?.length) ?? 1) : 0)

/**
 * Store one decision on its key's row (one per market × key). A shadow or held decision that did not change is only
 * stamped; anything else rewrites the row as a new decision. Returns the row's id and whether it changed.
 */
export async function storeStructure(args: { d: StructureDecision; market: string; level: string; runId: string; now: Date }): Promise<{ id: string; changed: boolean }> {
  const { d, market, level, runId, now } = args
  const status = statusOf(d)
  const plan = { reasons: d.reasons, request: d.request, owners: d.owners, migration: d.migration, campaigns: takes(d) }
  const content = { productId: d.productId, kind: d.kind, status, level, builder: d.builder, term: d.term, campaignId: d.campaignId, plan, evidence: d.evidence, heldBy: d.heldBy, why: d.why.slice(0, 2000) }
  const digest = digestOf(content)
  const key = { market_key: workspaceKey({ marketplace: market, key: d.key }) }
  const was = await prisma.adsBrainStructure.findUnique({ where: key as never, select: { id: true, digest: true, status: true } })
  if (was && was.digest === digest && was.status === status && (status === 'SHADOW' || status === 'HELD')) {
    await prisma.adsBrainStructure.update({ where: { id: was.id }, data: { runId, checkedAt: now } })
    return { id: was.id, changed: false }
  }
  const data = {
    ...content, plan: json(plan), evidence: json(d.evidence), digest, runId, decidedAt: now, checkedAt: now, changedAt: now,
    // A new decision of this key: nothing of an earlier one carries over.
    approvalId: null, liveApprovalId: null, retireApprovalId: null, builtCampaignIds: [],
  }
  const row = was
    ? await prisma.adsBrainStructure.update({ where: { id: was.id }, data, select: { id: true } })
    : await prisma.adsBrainStructure.create({ data: { marketplace: market, key: d.key, ...data }, select: { id: true } })
  return { id: row.id, changed: true }
}

/** Store a decision and, at PROPOSE under the live ceiling, ask a person for its builder's request. */
async function actOn(d: StructureDecision, f: StructureProductFacts, runId: string, now: Date, s: ReturnType<typeof blank>): Promise<void> {
  if (d.act === 'none') s.decided.held++
  else if (d.kind === 'SKC') s.decided.skc++
  else if (d.kind === 'SPLIT') s.decided.split++
  else s.decided.portfolio++
  const level = f.level === 'LOCKED' ? 'LOCKED' : d.level ?? 'OBSERVE'
  const { id, changed } = await storeStructure({ d, market: f.market, level, runId, now })
  if (d.act === 'log') { if (changed) s.acted.logged++; return }
  if (d.act !== 'propose' || !d.request) return
  const asked = await askPerson(d.request, `${d.kind} ${d.key}`)
  if ('approvalId' in asked) {
    await prisma.adsBrainStructure.update({ where: { id }, data: { approvalId: asked.approvalId, changedAt: now } })
    s.acted.proposed++
  } else {
    await prisma.adsBrainStructure.update({ where: { id }, data: { status: 'HELD', heldBy: `${d.builder ?? 'the builder'} refused the request, nothing was asked: ${asked.error}`.slice(0, 2000), changedAt: now } })
  }
}

// ── Pending work ─────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Awaited<ReturnType<typeof prisma.adsBrainStructure.findMany>>[number]

/** Whether a campaign serves now: enabled, on the live-write allowlist, its bids not held at a floor. Else why not. */
export async function servingNow(campaignIds: readonly string[]): Promise<Map<string, string | null>> {
  const rows = campaignIds.length ? await prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, status: true, liveBidWritesEnabled: true, bidsSuppressedAt: true } }) : []
  const out = new Map<string, string | null>()
  for (const id of campaignIds) {
    const c = rows.find((r) => r.id === id)
    out.set(id, !c ? 'it is no longer in Nexus'
      : String(c.status) !== 'ENABLED' ? `it is ${String(c.status).toLowerCase()}`
        : !c.liveBidWritesEnabled ? 'it is not on the live-write allowlist yet'
          : c.bidsSuppressedAt ? 'its bids still sit at the floor it was born at' : null)
  }
  return out
}

/** The campaigns an approved build made: the create's change, the playbook build's run, each replicate run of a plan. */
async function builtBy(r: Row, approval: { id: string; toolName: string }): Promise<{ state: 'waiting'; why: string } | { state: 'built'; campaignIds: string[]; byStep: string[][] } | { state: 'failed'; why: string; campaignIds: string[] }> {
  if (r.builder === STRUCTURE_TOOLS.create) {
    const change = await prisma.agentChange.findFirst({ where: { approvalId: approval.id }, select: { after: true } })
    const campaignId = obj(change?.after).campaignId
    return typeof campaignId === 'string' && campaignId ? { state: 'built', campaignIds: [campaignId], byStep: [[campaignId]] } : { state: 'failed', why: `the approved request ${approval.id} ran, but names no campaign it made`, campaignIds: [] }
  }
  if (r.builder === STRUCTURE_TOOLS.playbook) {
    const change = await prisma.agentChange.findFirst({ where: { approvalId: approval.id }, select: { after: true } })
    const applicationId = obj(change?.after).applicationId
    if (typeof applicationId !== 'string') return { state: 'failed', why: `the approved request ${approval.id} ran, but names no build run`, campaignIds: [] }
    const { buildRunCampaigns } = await import('../ads-playbook/build.js')
    const run = await buildRunCampaigns(applicationId)
    if ('refusal' in run) return { state: 'waiting', why: `the playbook's build ${applicationId} is still running` }
    return run.campaignIds.length && run.status !== 'FAILED' ? { state: 'built', campaignIds: run.campaignIds, byStep: [run.campaignIds] } : { state: 'failed', why: `the playbook's build ${applicationId} ended ${run.status} with ${plural(run.campaignIds.length, 'campaign')}`, campaignIds: run.campaignIds }
  }
  // A split: one replicate run per step of the change plan.
  const steps = await prisma.agentPlanStep.findMany({ where: { approvalId: approval.id }, orderBy: { position: 'asc' }, select: { position: true, status: true, changeId: true, reason: true } })
  const changes = await prisma.agentChange.findMany({ where: { id: { in: steps.map((s) => s.changeId).filter((x): x is string => !!x) } }, select: { id: true, after: true } })
  const { replicateRunCampaigns } = await import('../ads-blueprint-apply.service.js')
  const byStep: string[][] = []
  const problems: string[] = []
  for (const step of steps) {
    const applicationId = obj(changes.find((c) => c.id === step.changeId)?.after).applicationId
    if (typeof applicationId !== 'string') { byStep.push([]); problems.push(`step ${step.position} ${step.status}${step.reason ? ` (${step.reason})` : ''}`); continue }
    const run = await replicateRunCampaigns(applicationId)
    if (!run) { byStep.push([]); problems.push(`step ${step.position}: its replicate run ${applicationId} is not in this business`); continue }
    if ('refusal' in run) return { state: 'waiting', why: `the copy of step ${step.position} is still being built` }
    byStep.push(run.campaignIds)
    if (!run.campaignIds.length || run.status === 'FAILED') problems.push(`step ${step.position} made ${plural(run.campaignIds.length, 'campaign')} (${run.status})`)
  }
  const campaignIds = byStep.flat()
  return problems.length || !steps.length ? { state: 'failed', why: `the split's change plan ${approval.id} did not build every copy: ${problems.join('; ') || 'no step ran'}`, campaignIds } : { state: 'built', campaignIds, byStep }
}

/** What earlier runs asked, for one product (see the header, step 1). */
async function pendingWork(p: StructureDueProduct, now: Date, canAsk: { yes: boolean; why: string }, s: ReturnType<typeof blank>): Promise<void> {
  const rows = await prisma.adsBrainStructure.findMany({ where: { marketplace: p.market, productId: p.productId, status: { in: ['PROPOSED', 'BUILT', 'LIVE_PROPOSED', 'LIVE'] } } })
  if (!rows.length) return
  const ids = [...new Set(rows.flatMap((r) => [r.approvalId, r.liveApprovalId, r.retireApprovalId]).filter((x): x is string => !!x))]
  const approvals = new Map((ids.length ? await prisma.agentApproval.findMany({ where: { id: { in: ids } }, select: { id: true, status: true, toolName: true } }) : []).map((a) => [a.id, a]))
  const product = await prisma.product.findFirst({ where: { id: p.productId }, select: { name: true, sku: true } })
  const label = product?.name?.trim() || product?.sku || p.productId
  for (const r of rows) {
    const update = async (data: Prisma.AdsBrainStructureUpdateInput) => { await prisma.adsBrainStructure.update({ where: { id: r.id }, data: { ...data, changedAt: now, checkedAt: now } }); s.pending.synced++ }
    const plan = obj(r.plan)
    if (r.status === 'PROPOSED') {
      const a = r.approvalId ? approvals.get(r.approvalId) : undefined
      if (!a || NOT_RUN.includes(a.status)) { await update({ status: 'DECLINED', heldBy: null, why: `${r.why} — the request ${r.approvalId ?? ''} was ${a?.status ?? 'not found'}: not asked again for ${COOLDOWN_DAYS} days`.replace('  ', ' ').slice(0, 2000) }); s.pending.declined++; continue }
      if (a.status !== 'executed' && a.status !== 'failed') continue
      if (r.kind === 'PORTFOLIO') {
        const wanted = (plan.request?.args?.campaigns ?? []) as Array<{ campaignId: string; portfolioId: string }>
        const now_ = wanted.length ? await prisma.campaign.findMany({ where: { id: { in: wanted.map((w) => w.campaignId) } }, select: { id: true, name: true, portfolioId: true } }) : []
        const notIn = wanted.filter((w) => now_.find((c) => c.id === w.campaignId)?.portfolioId !== w.portfolioId)
        if (!notIn.length) { await update({ status: 'DONE', heldBy: null }); s.pending.done++ }
        else if (a.status === 'failed') { await update({ status: 'FAILED', heldBy: `the approved move ${a.id} failed: ${plural(notIn.length, 'campaign')} not in the portfolio` }); s.pending.failed++ }
        else if (r.heldBy !== 'waiting: the move is queued for Amazon (5-minute cancel window)') await update({ heldBy: 'waiting: the move is queued for Amazon (5-minute cancel window)' })
        continue
      }
      const built = await builtBy(r, a)
      if (built.state === 'waiting') { if (r.heldBy !== `waiting: ${built.why}`) await update({ heldBy: `waiting: ${built.why}` }); continue }
      if (built.state === 'failed' || a.status === 'failed') {
        const why = built.state === 'failed' ? built.why : `the approved request ${a.id} failed`
        await update({ status: 'FAILED', builtCampaignIds: built.campaignIds, heldBy: `${why}${built.campaignIds.length ? ` — what it made (${plural(built.campaignIds.length, 'campaign')}) waits for a person: archive-ads, or its go-live by hand` : ''}`.slice(0, 2000) })
        s.pending.failed++
        continue
      }
      await update({ status: 'BUILT', builtCampaignIds: built.campaignIds, plan: json({ ...plan, built: built.byStep }), heldBy: null })
      s.pending.built++
      r.status = 'BUILT'; r.builtCampaignIds = built.campaignIds; r.plan = { ...plan, built: built.byStep }
    }
    if (r.status === 'BUILT' || r.status === 'LIVE_PROPOSED') {
      const serving = await servingNow(r.builtCampaignIds)
      const notYet = [...serving].filter(([, why]) => why)
      if (!notYet.length) { await update({ status: 'LIVE', heldBy: null }); s.pending.live++; if (r.kind !== 'SPLIT') continue; r.status = 'LIVE' }
      else if (r.status === 'LIVE_PROPOSED') {
        const a = r.liveApprovalId ? approvals.get(r.liveApprovalId) : undefined
        if (!a || NOT_RUN.includes(a.status) || a.status === 'failed' || a.status === 'executed') {
          const why = a?.status === 'executed' ? `its go-live ran, but ${notYet[0][1]}` : `its go-live request ${r.liveApprovalId ?? ''} was ${a?.status ?? 'not found'}`.replace('  ', ' ')
          await update({ status: 'BUILT', liveApprovalId: null, plan: json({ ...obj(r.plan), liveDeclinedAt: now.toISOString() }), heldBy: `${why}: asked again after ${COOLDOWN_DAYS} days` })
        }
        continue
      } else {
        const declinedAt = obj(r.plan).liveDeclinedAt
        if (typeof declinedAt === 'string' && now.getTime() - Date.parse(declinedAt) < COOLDOWN_DAYS * DAY_MS) continue
        if (!canAsk.yes) { const h = `built, born at the floor and off the allowlist; its go-live waits: ${canAsk.why}`; if (r.heldBy !== h) await update({ heldBy: h }); continue }
        const asked = await askPerson(goLiveRequest({ ...r, label: r.kind === 'SKC' ? `the single-keyword campaign for "${r.term}" (${label})` : `the split copies (${plural(r.builtCampaignIds.length, 'campaign')})` }), `go-live ${r.key}`)
        if ('approvalId' in asked) { await update({ status: 'LIVE_PROPOSED', liveApprovalId: asked.approvalId, heldBy: null }); s.pending.liveAsked++ }
        else await update({ heldBy: `its go-live could not be asked: ${asked.error}`.slice(0, 2000) })
        continue
      }
    }
    if (r.status === 'LIVE' && r.kind === 'SPLIT' && r.campaignId) {
      const [old] = [...(await servingNow([r.campaignId]))]
      if (old[1]) { await update({ status: 'DONE', heldBy: null, why: `${r.why} — every copy is live and the shared campaign no longer serves (${old[1]})`.slice(0, 2000) }); s.pending.done++; continue }
      const a = r.retireApprovalId ? approvals.get(r.retireApprovalId) : undefined
      if (a && !NOT_RUN.includes(a.status) && a.status !== 'failed') continue
      const declinedAt = obj(r.plan).retireDeclinedAt
      if (a && typeof declinedAt !== 'string') { await update({ retireApprovalId: null, plan: json({ ...obj(r.plan), retireDeclinedAt: now.toISOString() }), heldBy: `the shared campaign's low bids were ${a.status}: asked again after ${COOLDOWN_DAYS} days` }); continue }
      if (typeof declinedAt === 'string' && now.getTime() - Date.parse(declinedAt) < COOLDOWN_DAYS * DAY_MS) continue
      if (!canAsk.yes) { const h = `every copy is live; the shared campaign's low bids wait: ${canAsk.why}`; if (r.heldBy !== h) await update({ heldBy: h }); continue }
      const asked = await askPerson({ tool: STRUCTURE_TOOLS.suppress, args: { campaignId: r.campaignId, why: `Ads brain split (D2 = A): every product's own copy is live — the shared campaign goes to low bids (the migration's last step)` } }, `retire ${r.key}`)
      if ('approvalId' in asked) { await update({ retireApprovalId: asked.approvalId, heldBy: null }); s.pending.retireAsked++ }
      else await update({ heldBy: `the shared campaign's low bids could not be asked: ${asked.error}`.slice(0, 2000) })
    }
  }
}

/** Delete shadow and held rows no run checked for 30 days, and ended ones older than 90 days. */
export async function pruneStructure(now: Date): Promise<number> {
  const [a, b] = await Promise.all([
    prisma.adsBrainStructure.deleteMany({ where: { status: { in: ['SHADOW', 'HELD'] }, checkedAt: { lt: new Date(now.getTime() - STRUCTURE_SHADOW_DAYS_KEPT * DAY_MS) } } }),
    prisma.adsBrainStructure.deleteMany({ where: { status: { in: ['DECLINED', 'FAILED'] }, changedAt: { lt: new Date(now.getTime() - STRUCTURE_ENDED_DAYS_KEPT * DAY_MS) } } }),
  ])
  return a.count + b.count
}

/**
 * One run in the business the caller is in. Nothing due: nothing read past the enrollments, nothing written but the prune.
 * `force` decides whatever the weekday (a person's dry run, the tests).
 */
export async function runStructureOnce(opts: { now?: Date; due?: StructureDue; force?: boolean } = {}): Promise<StructureRunSummary> {
  const now = opts.now ?? new Date()
  const due = opts.due ?? await structureDue()
  if (!due.due) return { ran: false, why: due.why, products: 0, markets: [], ...blank(), notDue: 0, skipped: [], failed: [], pruned: await pruneStructure(now) }
  const runId = randomUUID()
  const s = blank()
  const out: StructureRunSummary = { ran: true, why: due.why, runId, products: 0, markets: [...new Set(due.products.map((p) => p.market))].sort(), ...s, notDue: 0, skipped: [], failed: [], pruned: 0 }
  // The market's week of new campaigns is shared: what one product logs in shadow in this run counts for the next.
  const shadowTaken = new Map<string, number>()
  for (const p of due.products) {
    out.products++
    try {
      const ceiling = structureCeiling()
      const killed = await leverKillWhy('structure', p.productId, p.market)
      const level = p.settings.levers.structure.effective
      const canAsk = level !== 'PROPOSE' ? { yes: false, why: `the structure lever is ${level} for this product` } : killed ? { yes: false, why: `the structure lever is ${killed}` } : ceiling.live ? { yes: true, why: '' } : { yes: false, why: ceiling.why }
      await pendingWork(p, now, canAsk, s)
      if (!opts.force && !weeklyDue(now, p.market)) { out.notDue++; continue }
      const facts = await loadStructureFacts(p, now)
      if ('skipped' in facts) { out.skipped.push({ productId: p.productId, market: p.market, why: facts.skipped }); continue }
      const f = { ...facts, used: { ...facts.used, marketCampaignsThisWeek: facts.used.marketCampaignsThisWeek + (shadowTaken.get(p.market) ?? 0) } }
      const decisions = decideStructure(f, now)
      shadowTaken.set(p.market, (shadowTaken.get(p.market) ?? 0) + decisions.filter((d) => d.act === 'log').reduce((n, d) => n + takes(d), 0))
      for (const d of decisions) await actOn(d, f, runId, now, s)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      out.failed.push({ productId: p.productId, market: p.market, error: message })
      logger.error('[ads-brain-structure] one product failed; the others go on', { productId: p.productId, market: p.market, error: message })
    }
  }
  out.pruned = await pruneStructure(now)
  logger.info('[ads-brain-structure] run', { runId, products: out.products, decided: s.decided, acted: s.acted, pending: s.pending, notDue: out.notDue, skipped: out.skipped.length, failed: out.failed.length, pruned: out.pruned })
  return out
}

/** The run in one line (the cron's record). */
export function structureSummaryLine(s: StructureRunSummary): string {
  if (!s.ran) return `not run: ${s.why}`
  const p = s.pending
  return `products=${s.products} markets=${s.markets.join(',') || '-'} skc=${s.decided.skc} split=${s.decided.split} portfolio=${s.decided.portfolio} held=${s.decided.held} logged=${s.acted.logged} proposed=${s.acted.proposed} `
    + `synced=${p.synced} built=${p.built} liveAsked=${p.liveAsked} live=${p.live} retireAsked=${p.retireAsked} done=${p.done} declined=${p.declined} failedPending=${p.failed} notDue=${s.notDue} skipped=${s.skipped.length} failed=${s.failed.length} pruned=${s.pruned}`
}

