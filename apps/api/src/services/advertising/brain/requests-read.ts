/**
 * Ads brain page A5 — the requests that wait on the brain (row 17, GET …/brain/requests?market=&productId=), and the check
 * the decide route (row 25) uses: it decides only a request this list holds.
 *
 *   brain asked    what a product's brain asked a person for, read from each lever's own log (control.ts
 *                  brainRequestsWaiting: money, state, negatives, harvest, hours, bidding strategy), and its structure
 *                  builds, go-lives and moves (AdsBrainStructure) and its retirements (AdsBrainRetirement)
 *   asked of it    a brain tool a person asked for on the page, or Claude (set-ads-brain, set-brain-kill-switch,
 *                  set-bid-brain-enrollment, apply-brain-hourly-plan, apply-brain-harvest, retire-ads-writers), matched to
 *                  its product and market by its own arguments
 *   brain door     [PLUG-IN, lane B1] a request the brain's own door scheduled to run alone (decisionVia 'brain'): it runs
 *                  at its executeAfter unless a person stops it — see brainDoorRequests below
 *
 * Each waits for a person (pending, not expired) or sits in its 20-second undo window (scheduled), with when it expires or
 * runs, and whether approving it needs the approver's authenticator code. The preview is the raw one: the route filters it
 * for the person reading (call-tool.ts storedOutputOf), as the Approvals page does. Read only.
 */
import prisma from '../../../db.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { brainRequestsWaiting } from './control.js'
import { productFamily, resolveCampaignOwnership } from './ownership.js'

/** The brain's own write tools (the routes of rows 19–24 ask for exactly these). */
export const BRAIN_WRITE_TOOLS = ['set-ads-brain', 'set-brain-kill-switch', 'set-bid-brain-enrollment', 'apply-brain-hourly-plan', 'apply-brain-harvest', 'retire-ads-writers'] as const

export type AskedBy = 'brain' | 'person' | 'claude' | 'system'

export interface BrainRequest {
  approvalId: string
  tool: string
  /** The lever it moves (a brain-asked request names its lever's log; a tool request its `lever` argument), else null. */
  lever: string | null
  askedBy: AskedBy
  status: 'pending' | 'scheduled'
  requestedAt: string
  expiresAt: string | null
  /** A scheduled request runs at this time unless someone stops it (the undo window, or the brain door's). */
  executeAfter: string | null
  /** Approving it needs the approver's authenticator code (its preview carries `stepUp`). */
  needsCode: boolean
  productId: string | null
  market: string | null
  summary: string | null
  /** Raw: the route filters it for the person reading. */
  preview: unknown
  /** Lane B1 — set on a request the brain's own door scheduled: when it runs alone, in words. */
  brainDoor?: { runsAloneAt: string | null; words: string }
}

const OPEN = ['pending', 'scheduled']
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {})

/**
 * ── PLUG-IN PLACE: the brain door (lane B1) ───────────────────────────────────────────────────────────────────────────
 * Lane B1 adds the requests the brain's own door schedules (AgentApproval.decisionVia 'brain', status 'scheduled'): read
 * them here for the products of the scope and return them; each row is marked with brainDoorRow (when it runs alone).
 * Nothing else in this file or the routes changes. Until then the brain door schedules nothing: none.
 */
async function brainDoorRequests(_scope: { products: ReadonlyArray<{ productId: string; market: string }> }): Promise<BrainRequest[]> {
  return []
}

/** How a brain-door request reads: it runs alone at its time unless a person stops it. Pure. */
export function brainDoorRow(executeAfter: Date | string | null): { runsAloneAt: string | null; words: string } {
  const at = executeAfter ? new Date(executeAfter).toISOString() : null
  return { runsAloneAt: at, words: at ? `runs alone at ${at.slice(0, 16).replace('T', ' ')} UTC unless a person stops it` : 'runs alone by the business\'s rule unless a person stops it' }
}

/** Who asked, from the request's run (AgentRun.via): a person on the page, Claude, or something in-process. Pure. */
const askedByOf = (via: string | null | undefined, brain: boolean): AskedBy => (brain ? 'brain' : via === 'app' ? 'person' : via === 'claude' ? 'claude' : 'system')

interface ToolScope { productId: string | null; market: string | null; lever: string | null; everyProduct: boolean; everyMarket: boolean }

/**
 * The product (family root) and market a brain tool's request reaches, from its own arguments. A kill of every product (or
 * in every market) reaches each; a product or market that cannot be told is null and matches no filter on it.
 */
async function scopeOfToolRequests(rows: ReadonlyArray<{ id: string; toolName: string; args: unknown }>): Promise<Map<string, ToolScope>> {
  const out = new Map<string, ToolScope>()
  const productIds = new Set<string>()
  const campaignIds = new Set<string>()
  const planIds = new Set<string>()
  const harvestIds = new Set<string>()
  for (const r of rows) {
    const a = rec(r.args)
    if (str(a.productId)) productIds.add(str(a.productId)!)
    if (r.toolName === 'set-bid-brain-enrollment' && str(a.campaignId)) campaignIds.add(str(a.campaignId)!)
    if (r.toolName === 'apply-brain-hourly-plan' && str(a.planId)) planIds.add(str(a.planId)!)
    if (r.toolName === 'apply-brain-harvest' && str(a.harvestId)) harvestIds.add(str(a.harvestId)!)
  }
  const [roots, owners, plans, harvests] = await Promise.all([
    Promise.all([...productIds].map(async (id) => [id, (await productFamily(id))?.root ?? id] as const)).then((pairs) => new Map(pairs)),
    campaignIds.size ? resolveCampaignOwnership([...campaignIds]) : Promise.resolve(new Map()),
    planIds.size ? prisma.adsBrainHourProposal.findMany({ where: { planId: { in: [...planIds] } }, select: { planId: true, productId: true, marketplace: true }, orderBy: { createdAt: 'desc' } }) : Promise.resolve([]),
    harvestIds.size ? prisma.adsBrainHarvest.findMany({ where: { id: { in: [...harvestIds] } }, select: { id: true, productId: true, marketplace: true } }) : Promise.resolve([]),
  ])
  for (const r of rows) {
    const a = rec(r.args)
    if (r.toolName === 'set-bid-brain-enrollment') {
      const o = owners.get(str(a.campaignId) ?? '')
      out.set(r.id, { productId: o?.owner.kind === 'product' ? o.owner.productId : null, market: o?.market ?? null, lever: 'bids', everyProduct: false, everyMarket: false })
    } else if (r.toolName === 'apply-brain-hourly-plan') {
      const p = plans.find((x) => x.planId === str(a.planId))
      out.set(r.id, { productId: p?.productId ?? null, market: p?.marketplace ?? null, lever: 'hours', everyProduct: false, everyMarket: false })
    } else if (r.toolName === 'apply-brain-harvest') {
      const h = harvests.find((x) => x.id === str(a.harvestId))
      out.set(r.id, { productId: h?.productId ?? null, market: h?.marketplace ?? null, lever: 'harvest', everyProduct: false, everyMarket: false })
    } else {
      const productId = str(a.productId)
      const kill = r.toolName === 'set-brain-kill-switch'
      out.set(r.id, {
        productId: productId ? roots.get(productId) ?? productId : null, market: str(a.market) ? strategyMarket(str(a.market)!) : null, lever: str(a.lever),
        everyProduct: kill && !productId, everyMarket: kill && !str(a.market),
      })
    }
  }
  return out
}

/**
 * The brain's requests in a scope: one product (any member of its family) and/or one market; neither = every one. A
 * product of another business is not found.
 */
export async function brainRequests(args: { market?: string; productId?: string }, now: Date = new Date()): Promise<{ data: { requests: BrainRequest[] } & Record<string, unknown> } | { error: string }> {
  const market = args.market ? strategyMarket(args.market) : null
  if (args.market && (!market || !/^[A-Z]{2}$/.test(market))) return { error: `${args.market} is not a market code` }
  let root: string | null = null
  if (args.productId) {
    const family = await productFamily(args.productId)
    if (!family) return { error: 'Product not found' }
    root = family.root
  }
  const enrolled = await prisma.adsBrainEnrollment.findMany({
    where: { ...(market ? { marketplace: market } : {}), ...(root ? { productId: root } : {}) },
    select: { productId: true, marketplace: true }, take: 200,
  })
  const products = enrolled.map((e) => ({ productId: e.productId, market: e.marketplace }))
  const roots = [...new Set(products.map((p) => p.productId))]

  // Brain asked: each lever's log (pending), and its structure and retirement requests.
  const [waiting, structures, retirements, toolRows, door] = await Promise.all([
    Promise.all(products.map(async (p) => (await brainRequestsWaiting(p.productId, p.market)).map((w) => ({ ...w, ...p })))).then((x) => x.flat()),
    roots.length ? prisma.adsBrainStructure.findMany({ where: { productId: { in: roots }, ...(market ? { marketplace: market } : {}) }, select: { productId: true, marketplace: true, approvalId: true, liveApprovalId: true, retireApprovalId: true } }) : Promise.resolve([]),
    roots.length ? prisma.adsBrainRetirement.findMany({ where: { productId: { in: roots }, ...(market ? { marketplace: market } : {}), approvalId: { not: null } }, select: { productId: true, marketplace: true, approvalId: true } }) : Promise.resolve([]),
    prisma.agentApproval.findMany({
      where: { toolName: { in: [...BRAIN_WRITE_TOOLS] }, status: { in: OPEN } },
      select: { id: true, toolName: true, args: true }, orderBy: { requestedAt: 'asc' }, take: 200,
    }),
    brainDoorRequests({ products }),
  ])
  const brainAsked = new Map<string, { lever: string | null; productId: string; market: string }>()
  for (const w of waiting) brainAsked.set(w.approvalId, { lever: w.lever, productId: w.productId, market: w.market })
  for (const s of structures) for (const id of [s.approvalId, s.liveApprovalId, s.retireApprovalId]) if (id) brainAsked.set(id, { lever: 'structure', productId: s.productId, market: s.marketplace })
  for (const r of retirements) brainAsked.set(r.approvalId!, { lever: null, productId: r.productId, market: r.marketplace })

  // Asked of it: the brain tools' open requests, kept when they reach the scope (a kill of every product reaches each).
  const toolScope = await scopeOfToolRequests(toolRows)
  const inScope = (s: ToolScope) => (!root || s.productId === root || s.everyProduct) && (!market || s.market === market || s.everyMarket)
  const asked = new Map<string, ToolScope>()
  for (const r of toolRows) {
    const s = toolScope.get(r.id)!
    if (!brainAsked.has(r.id) && inScope(s)) asked.set(r.id, s)
  }

  const ids = [...new Set([...brainAsked.keys(), ...asked.keys()])]
  const approvals = ids.length ? await prisma.agentApproval.findMany({
    where: { id: { in: ids }, status: { in: OPEN } },
    select: { id: true, toolName: true, status: true, requestedAt: true, expiresAt: true, executeAfter: true, preview: true, summary: true, decisionVia: true, agentRun: { select: { via: true } } },
    orderBy: { requestedAt: 'asc' },
  }) : []
  const requests: BrainRequest[] = approvals
    .filter((a) => !(a.status === 'pending' && a.expiresAt && a.expiresAt <= now))
    .map((a) => {
      const brain = brainAsked.get(a.id)
      const s = brain ?? asked.get(a.id)!
      const preview = rec(a.preview)
      return {
        approvalId: a.id, tool: a.toolName, lever: s.lever, askedBy: askedByOf(a.agentRun?.via, !!brain), status: a.status as 'pending' | 'scheduled',
        requestedAt: a.requestedAt.toISOString(), expiresAt: a.expiresAt?.toISOString() ?? null, executeAfter: a.executeAfter?.toISOString() ?? null,
        needsCode: !!preview.stepUp, productId: s.productId, market: s.market,
        summary: a.summary ?? str(preview.summary), preview: a.preview,
        ...(a.decisionVia === 'brain' ? { brainDoor: brainDoorRow(a.executeAfter) } : {}),
      }
    })
  const all = [...requests, ...door.filter((d) => !requests.some((r) => r.approvalId === d.approvalId))]
  return {
    data: {
      view: 'requests', scope: { market: market ?? 'every market', ...(root ? { productId: root } : {}) },
      requests: all,
      note: all.length
        ? 'Each waits for a person (pending) or runs at executeAfter (scheduled: the 20-second undo window, or the brain door) unless stopped. POST …/brain/requests/:approvalId/decide approves or rejects one; needsCode: approving it takes the approver\'s authenticator code.'
        : 'Nothing waits on the brain here.',
    },
  }
}

/** Is this approval one the brain's requests list holds now (the decide route decides only those)? */
export async function isBrainRequest(approvalId: string, now: Date = new Date()): Promise<boolean> {
  const out = await brainRequests({}, now)
  return 'data' in out && out.data.requests.some((r) => r.approvalId === approvalId)
}
