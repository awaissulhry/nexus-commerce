/**
 * ADS AUTONOMY W3-1 — the Amazon ad engines' output, carried out by id (design 6 §4 "W3-1").
 *
 *   apply-ad-recommendations   a CONTROL tool (like submit-change-plan): it writes nothing. Its dry run reads the
 *                              recommendations by the ids ad-recommendations gave (the same feed, the same window) and
 *                              the rules' waiting suggestions, and returns ONE change plan of the existing change tools,
 *                              each step with the value the engine recommended (or the caller's override) frozen into
 *                              its arguments and the recommendation named as its `source` (ads-change-source.ts). The
 *                              door then dry-runs every step as the caller, at that step tool's own level and limits,
 *                              and stores one approval (change-plan.service.ts): the value the limits judge is the
 *                              value that lands, and each step re-checks its starting values when it runs.
 *                                bid:     all of them → ONE bulk-ad-bid-change (one run of the daily cap); one alone →
 *                                         set-target-bid
 *                                neg:     create-negative-keyword (an exact negative in the ad group it spent in)
 *                                grad:    graduate-keyword, at the harvest's own starting bid (the term's cost per click)
 *                                budget:  set-campaign-budget
 *                                retail:  suppress-campaign — every bid to the stop bid (stock problems lower bids; Nexus
 *                                         never pauses), put back by restore-campaign
 *                                rule:    ONE decide-automation-suggestions (apply), which settles the suggestion rows
 *                                sov:     refused: information, not a change (the service's apply is null)
 *                                autopilot: / kt:   refused for now (W3-5)
 *                              Refused as a whole, naming each id's reason, before anything waits: an id whose row this
 *                              business does not have (not found), one no longer in the feed (the data moved), one muted
 *                              or already carried out, one a waiting request already carries out, and a rule's
 *                              suggestion for the same target, campaign or search term as an engine's recommendation in
 *                              the same request (the later step would find its facts moved and be skipped). Undo:
 *                              undo-change of the plan's approvalId (each step's own undo).
 *   mute-ad-recommendations    Nexus only: mute or unmute engine recommendations by id (SG.9's third verb: the feed stops
 *                              offering one until it is unmuted). Undo: the opposite op. It changes no spend, so a
 *                              business may let it run by its rule, inside how many it may mute at once.
 *
 * Nothing here calls Amazon: every write is a step's own change tool, through the mutation services and the write gate.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import type { Recommendation } from '../../advertising/ads-recommendations.service.js'
import {
  familyOfRecommendationId,
  isEngineFamily,
  muteRecommendations,
  recommendationMuteStates,
  unmuteRecommendations,
  type MuteState,
  type RecommendationFamily,
} from '../../advertising/ads-recommendation-mutes.service.js'
import type { HarvestCandidate } from '../../advertising/ads-harvest.service.js'
import { adGroupsByExternalId } from '../../advertising/ads-entity-lookup.service.js'
import { approvedRun, canonical, notRun } from './ads-change-kit.js'
import { sourceOf, type AdChangeSource } from './ads-change-source.js'
import type { AgentTool, ToolContext, ToolRequest, ToolResult, ToolUndo } from '../tool-types.js'

const MAX_IDS = 100
/** The lowest bid a bid change takes (set-target-bid, graduate-keyword). */
const BID_FLOOR_CENTS = 5
const ID = z.string().trim().min(1).max(400)
const daysArg = z.coerce.number().int().min(1).max(90).default(30).describe('the window the engines judge, as in ad-recommendations (default 30)')
const whyArg = z.string().trim().min(3).max(300)

/** The change tools a recommendation is carried out with, and the rules' suggestion tool. */
const SOURCE_TOOLS = ['set-target-bid', 'bulk-ad-bid-change', 'create-negative-keyword', 'graduate-keyword', 'set-campaign-budget', 'suppress-campaign'] as const
const RULE_TOOL = 'decide-automation-suggestions'
/** A request that has not run yet (or is running): it still carries out what it names. */
const WAITING = ['pending', 'scheduled', 'executing']

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The feed, as ad-recommendations reads it. Imported where used: loading it registers rule-action handlers. */
async function feedById(windowDays: number): Promise<Map<string, Recommendation>> {
  const { buildRecommendations } = await import('../../advertising/ads-recommendations.service.js')
  const feed = await buildRecommendations({ windowDays })
  return new Map(feed.recommendations.map((r) => [r.id, r]))
}

/**
 * The engine ids whose row is not in this business (another business's, or gone): their target (bid:), campaign
 * (budget:, retail:) or ad group (neg:, grad:), each with its refusal. Share of voice names no row. Read only.
 */
async function notInBusiness(ids: string[]): Promise<Map<string, string>> {
  const rowOf = (id: string) => id.slice(id.indexOf(':') + 1)
  const groupOf = (id: string) => rowOf(id).split(':')[0]
  const of = (family: string) => ids.filter((id) => familyOfRecommendationId(id) === family)
  const targetIds = of('bid').map(rowOf)
  const campaignIds = [...of('budget'), ...of('retail')].map(rowOf)
  const groupIds = [...of('negative'), ...of('graduate')].map(groupOf)
  const [targets, campaigns, groups] = await Promise.all([
    targetIds.length ? prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true } }) : [],
    campaignIds.length ? prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { id: true } }) : [],
    groupIds.length ? adGroupsByExternalId(groupIds) : new Map<string, unknown>(),
  ])
  const found = new Set([...targets.map((t) => t.id), ...campaigns.map((c) => c.id), ...groups.keys()])
  const out = new Map<string, string>()
  for (const id of ids) {
    const family = familyOfRecommendationId(id)
    const row = family === 'negative' || family === 'graduate' ? groupOf(id) : rowOf(id)
    const what = family === 'bid' ? 'target' : family === 'budget' || family === 'retail' ? 'campaign' : family === 'negative' || family === 'graduate' ? 'ad group' : null
    if (what && !found.has(row)) out.set(id, `${id}: its ${what} is not found in this business`)
  }
  return out
}

/** Why an id that is not in the feed now is not there, in the words its refusal uses. */
function goneWords(id: string, state: { state: MuteState; by: string | null }): string {
  if (state.state === 'muted') return `${id}: it is muted (mute-ad-recommendations with op unmute shows it again)`
  if (state.state === 'settled') return `${id}: ${state.by?.replace('request:', 'request ') ?? 'a request'} already carried it out; it is offered again once the data is a day past that change`
  return `${id}: no longer recommended — the data moved (read ad-recommendations again)`
}

/** The recommendation and rule ids a request (one change, or a plan step) carries out. */
function idsCarried(toolName: string, args: unknown): string[] {
  const a = obj(args)
  const out: string[] = []
  const own = sourceOf(a.source)
  if (own) out.push(own.id)
  for (const row of list(a.bids)) {
    const rowSource = sourceOf(obj(row).source)
    if (rowSource) out.push(rowSource.id)
  }
  if (toolName === RULE_TOOL && a.kind === 'amazon-ads') {
    for (const d of list(a.decisions)) {
      const decision = obj(d)
      if (decision.decide === 'apply' && typeof decision.suggestionId === 'string') out.push(`rule:${decision.suggestionId}`)
    }
  }
  return out
}

/** Of these ids, the ones a waiting request (a change, or a step of a plan) already carries out, with that request. */
async function waitingRequestsFor(ids: string[]): Promise<Map<string, string>> {
  const tools = [...SOURCE_TOOLS, RULE_TOOL]
  const [single, steps] = await Promise.all([
    prisma.agentApproval.findMany({
      where: { status: { in: WAITING }, toolName: { in: tools } },
      select: { id: true, toolName: true, args: true }, orderBy: { requestedAt: 'desc' }, take: 500,
    }),
    prisma.agentPlanStep.findMany({
      where: { status: { in: ['pending', 'executing'] }, toolName: { in: tools }, approval: { status: { in: WAITING } } },
      select: { approvalId: true, toolName: true, args: true }, orderBy: { createdAt: 'desc' }, take: 2000,
    }),
  ])
  const wanted = new Set(ids)
  const found = new Map<string, string>()
  for (const r of [...single.map((a) => ({ approvalId: a.id, toolName: a.toolName, args: a.args })), ...steps]) {
    for (const id of idsCarried(r.toolName, r.args)) if (wanted.has(id) && !found.has(id)) found.set(id, r.approvalId)
  }
  return found
}

// ── apply-ad-recommendations ─────────────────────────────────────────────────────────────────────────

interface Override { id: string; proposedBidCents?: number; proposedBudgetCents?: number }
interface ApplyArgs { recommendationIds: string[]; overrides?: Override[]; days: number; why: string }

/** The source a step carries: the recommendation, and the window the feed was read over when it is not the default. */
const sourceFor = (id: string, days: number): AdChangeSource => ({ kind: 'recommendation', id, ...(days !== 30 ? { windowDays: days } : {}) })
const harvestOf = (r: Recommendation): HarvestCandidate | null => {
  const p = r.apply?.payload as { negatives?: HarvestCandidate[]; graduations?: HarvestCandidate[] } | undefined
  return p?.negatives?.[0] ?? p?.graduations?.[0] ?? null
}
const firstChange = (r: Recommendation) =>
  (r.apply?.payload as { changes?: Array<{ targetId?: string; campaignId?: string; proposedBidCents?: number; proposedBudgetCents?: number }> } | undefined)?.changes?.[0]

/** Which override field each kind of recommendation takes. */
const OVERRIDE_FIELD: Partial<Record<RecommendationFamily, keyof Omit<Override, 'id'>>> = {
  bid: 'proposedBidCents',
  graduate: 'proposedBidCents',
  budget: 'proposedBudgetCents',
}

/** An override's problem, or null. Pure. */
function overrideProblem(o: Override, family: RecommendationFamily | null): string | null {
  const field = family ? OVERRIDE_FIELD[family] : undefined
  const given = (['proposedBidCents', 'proposedBudgetCents'] as const).filter((k) => o[k] != null)
  if (!field) return `${o.id}: this kind of recommendation takes no value of its own`
  if (!given.length) return `${o.id}: the override names no value (${field})`
  if (given.some((k) => k !== field)) return `${o.id}: it takes ${field}, not ${given.filter((k) => k !== field).join(', ')}`
  return null
}

/**
 * A rule's suggestion and an engine's recommendation that change the same target (a bid; a retail stop floors its
 * campaign's), the same campaign (its budget; a retail stop) or the same search term of a campaign (a negative, a
 * graduation): in one plan the later step would find its facts moved and be skipped (or do the same thing twice), so the
 * request names both instead. Read only.
 */
async function overlaps(subjects: Array<{ id: string; entityType: string; entityId: string }>, recs: Recommendation[]): Promise<string[]> {
  const byTarget = new Map<string, string>()
  const byCampaign = new Map<string, string>()
  const stops = new Map<string, string>()
  // A SEARCH_TERM suggestion's entity is `<externalCampaignId>:<query>`, as a harvested term is named here.
  const byTerm = new Map<string, string>()
  for (const r of recs) {
    const term = harvestOf(r)
    if (term) byTerm.set(`${term.externalCampaignId}:${term.query}`, r.id)
    const change = firstChange(r)
    if (r.category === 'bid' && change?.targetId) byTarget.set(String(change.targetId), r.id)
    if (r.category === 'budget' && change?.campaignId) byCampaign.set(String(change.campaignId), r.id)
    if (r.category === 'retail') {
      const campaignId = String((r.apply?.payload as { campaignIds?: string[] } | undefined)?.campaignIds?.[0] ?? '')
      byCampaign.set(campaignId, r.id)
      stops.set(campaignId, r.id)
    }
  }
  const targets = subjects.filter((s) => s.entityType === 'AD_TARGET').map((s) => s.entityId)
  const campaignOf = new Map(
    (stops.size && targets.length ? await prisma.adTarget.findMany({ where: { id: { in: targets } }, select: { id: true, adGroup: { select: { campaignId: true } } } }) : [])
      .map((t) => [t.id, t.adGroup.campaignId]),
  )
  const out: string[] = []
  for (const s of subjects) {
    const other = s.entityType === 'AD_TARGET'
      ? byTarget.get(s.entityId) ?? stops.get(campaignOf.get(s.entityId) ?? '')
      : s.entityType === 'CAMPAIGN' ? byCampaign.get(s.entityId)
        : s.entityType === 'SEARCH_TERM' ? byTerm.get(s.entityId) : undefined
    const what = s.entityType === 'AD_TARGET' ? 'target' : s.entityType === 'CAMPAIGN' ? 'campaign' : 'search term'
    if (other) out.push(`rule:${s.id} and ${other} both change the same ${what}: carry out one of them (the later one would find its facts moved and be skipped)`)
  }
  return out
}

/**
 * The dry run: the plan of change tools these ids are carried out with, or every reason it is refused. Pure read.
 * Exported for the tests; the door calls it through the tool.
 */
export async function planRecommendations(a: ApplyArgs): Promise<{ ok: true; title: string; steps: ToolRequest[]; byCategory: Record<string, number> } | { ok: false; error: string }> {
  const ids = a.recommendationIds
  const problems: string[] = []
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Each recommendation may be named once. Nothing was queued.' }
  const families = new Map(ids.map((id) => [id, familyOfRecommendationId(id)]))
  for (const [id, family] of families) {
    if (!family) problems.push(`${id}: not a recommendation id Nexus gives (take it from ad-recommendations)`)
    else if (family === 'sov') problems.push(`${id}: share of voice is information, not a change — decide it with set-target-bid, graduate-keyword or create-negative-keyword`)
    else if (family === 'autopilot' || family === 'tracker') problems.push(`${id}: an autopilot decision or a keyword-tracker proposal is not carried out from here yet`)
  }
  const overrides = new Map<string, Override>()
  for (const o of a.overrides ?? []) {
    if (overrides.has(o.id)) { problems.push(`${o.id}: overridden twice`); continue }
    overrides.set(o.id, o)
    if (!families.has(o.id)) { problems.push(`${o.id}: overridden, but not one of recommendationIds`); continue }
    const bad = overrideProblem(o, families.get(o.id) ?? null)
    if (bad) problems.push(bad)
  }
  const engineIds = ids.filter((id) => { const f = families.get(id) ?? null; return isEngineFamily(f) && f !== 'sov' })
  const ruleIds = ids.filter((id) => families.get(id) === 'rule')

  // The engines' recommendations, from the same feed ad-recommendations reads; the rules' suggestions, still waiting.
  const feed = engineIds.length ? await feedById(a.days) : new Map<string, Recommendation>()
  const missing = engineIds.filter((id) => !feed.has(id))
  const elsewhere = missing.length ? await notInBusiness(missing) : new Map<string, string>()
  problems.push(...elsewhere.values())
  const stale = missing.filter((id) => !elsewhere.has(id))
  if (stale.length) for (const state of await recommendationMuteStates(stale)) problems.push(goneWords(state.id, state))
  if (ruleIds.length) {
    const { suggestionStatuses, suggestionSubjects } = await import('../../advertising/ads-suggestion-decide.service.js')
    const suggestionIds = ruleIds.map((id) => id.slice('rule:'.length))
    for (const s of await suggestionStatuses(suggestionIds)) {
      if (s.status === 'gone') problems.push(`rule:${s.id}: not found in this business`)
      else if (s.status !== 'pending') problems.push(`rule:${s.id}: no longer waiting (it is ${s.status})`)
    }
    problems.push(...(await overlaps(await suggestionSubjects(suggestionIds), engineIds.map((id) => feed.get(id)).filter((r): r is Recommendation => !!r))))
  }
  const waiting = await waitingRequestsFor(ids)
  for (const [id, approvalId] of waiting) problems.push(`${id}: already asked for — request ${approvalId} carries it out (approval-status follows it)`)
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }

  const why = a.why.trim()
  const source = (id: string) => sourceFor(id, a.days)
  const recs = engineIds.map((id) => feed.get(id)!)
  const of = (family: RecommendationFamily) => recs.filter((r) => families.get(r.id) === family)
  const steps: ToolRequest[] = []
  // Bids: one bulk change for all of them (one run of the business's daily cap), or set-target-bid for one.
  const bids = of('bid').map((r) => {
    const change = firstChange(r)!
    return { targetId: String(change.targetId), bidCents: Math.round(overrides.get(r.id)?.proposedBidCents ?? Number(change.proposedBidCents)), source: source(r.id) }
  })
  if (bids.length === 1) steps.push({ tool: 'set-target-bid', args: { targetId: bids[0].targetId, proposedBidCents: bids[0].bidCents, why, source: bids[0].source } })
  else if (bids.length > 1) steps.push({ tool: 'bulk-ad-bid-change', args: { bids, why } })
  for (const r of of('negative')) {
    const term = harvestOf(r)!
    steps.push({ tool: 'create-negative-keyword', args: { externalCampaignId: term.externalCampaignId, externalAdGroupId: term.externalAdGroupId, keywordText: term.query, matchType: 'NEGATIVE_EXACT', why, source: source(r.id) } })
  }
  for (const r of of('graduate')) {
    const term = harvestOf(r)!
    // The harvest's own starting bid (applyHarvest): the term's cost per click over the window it was judged on.
    const own = overrides.get(r.id)?.proposedBidCents
    const bidCents = own ?? (term.clicks > 0 ? Math.max(BID_FLOOR_CENTS, Math.round(term.costCents / term.clicks)) : null)
    steps.push({ tool: 'graduate-keyword', args: { query: term.query, sourceExternalCampaignId: term.externalCampaignId, sourceExternalAdGroupId: term.externalAdGroupId, ...(bidCents != null ? { bidCents } : {}), why, source: source(r.id) } })
  }
  for (const r of of('budget')) {
    const change = firstChange(r)!
    steps.push({ tool: 'set-campaign-budget', args: { campaignId: String(change.campaignId), dailyBudgetCents: Math.round(overrides.get(r.id)?.proposedBudgetCents ?? Number(change.proposedBudgetCents)), why, source: source(r.id) } })
  }
  for (const r of of('retail')) {
    const campaignId = String((r.apply?.payload as { campaignIds?: string[] } | undefined)?.campaignIds?.[0] ?? '')
    steps.push({ tool: 'suppress-campaign', args: { campaignId, why, source: source(r.id) } })
  }
  // Rules: one decision of all their suggestions, through the Suggestions queue's own apply (it settles each row).
  if (ruleIds.length) steps.push({ tool: RULE_TOOL, args: { kind: 'amazon-ads', decisions: ruleIds.map((id) => ({ suggestionId: id.slice('rule:'.length), decide: 'apply' })) } })

  const byCategory: Record<string, number> = {}
  for (const id of ids) byCategory[families.get(id)!] = (byCategory[families.get(id)!] ?? 0) + 1
  const parts = Object.entries(byCategory).map(([category, n]) => `${n} ${category}`).join(', ')
  return { ok: true, title: `Apply ${plural(ids.length, 'ad recommendation')} (${parts})`.slice(0, 120), steps, byCategory }
}

const applyAdRecommendations: AgentTool = {
  name: 'apply-ad-recommendations',
  title: 'Apply ad recommendations',
  category: 'advertising',
  input: z.object({
    recommendationIds: z.array(ID).min(1).max(MAX_IDS)
      .describe(`the recommendationIds to carry out, from ad-recommendations: 1 to ${MAX_IDS} (bid:, neg:, grad:, budget:, retail: and rule: ids)`),
    overrides: z.array(z.object({
      id: ID.describe('one of recommendationIds'),
      proposedBidCents: z.coerce.number().int().min(BID_FLOOR_CENTS).max(100_000).optional()
        .describe('bid: a bid of your own instead of the engine\'s; grad: the starting bid — in minor units of the campaign\'s currency'),
      proposedBudgetCents: z.coerce.number().int().min(1).max(100_000_000).optional()
        .describe('budget: a daily budget of your own instead of the engine\'s, in minor units of the campaign\'s currency'),
    })).max(MAX_IDS).optional().describe('a value of your own for some of them (the value then judged by the limits is the one that lands)'),
    days: daysArg,
    why: whyArg.describe('why, in a sentence: shown to the person who approves it and kept in the ads audit of every change'),
  }),
  requires: [F.adsView, FIELDS.financialsAdspendView],
  riskTier: 'high',
  readOnly: false,
  control: true,
  // Its steps reach Amazon (each says so in its own preview).
  openWorld: true,
  // Each step is undone with its own tool's undo; a keyword it created stays, and an ad spent meanwhile.
  reversibility: 'partial',
  // Judged step by step at each step tool's own level and limits: it runs by rule only when every step may.
  maxClaudeTrust: 'auto',
  description:
    `Carry out the Amazon ad engines' recommendations by id (from ad-recommendations; up to ${MAX_IDS}) as ONE change plan. `
    + 'Each id becomes the change tool that does it, with the value the engine recommended (or your override) fixed in the '
    + 'request: bid ids → one bulk-ad-bid-change (set-target-bid for one), neg → create-negative-keyword (exact, in the ad '
    + 'group it spent in), grad → graduate-keyword at the term\'s cost per click, budget → set-campaign-budget, retail → '
    + 'suppress-campaign (bids to the stop bid: Nexus never pauses; restore-campaign puts them back), rule → one '
    + 'decide-automation-suggestions. Every step is checked now as you, at its own level and limits, as if asked alone. '
    + 'A person approves the plan in Nexus, or the person who asked confirms it in Claude with their authenticator code '
    + 'when the business set it so — or it runs by the business\'s rule, only when every step may (by default a raise or a '
    + 'new keyword needs a person). Each step names its recommendation (source), kept in the ads audit; once a step ran, '
    + 'its recommendation is not offered again until the data shows what the change did. Refused, each id with its reason, '
    + 'before anything waits: an id no longer recommended (the data moved), muted, or already carried out; one a waiting '
    + 'request already carries out; a share-of-voice id (information: decide it with set-target-bid, graduate-keyword or '
    + 'create-negative-keyword); an autopilot or keyword-tracker id (not yet). approval-status follows the plan; undo-change '
    + 'with its approvalId puts it back.',
  async handler(args): Promise<ToolResult> {
    const planned = await planRecommendations(args as unknown as ApplyArgs)
    if ('error' in planned) return { ok: false, error: planned.error }
    return {
      ok: true,
      preview: {
        action: 'apply-ad-recommendations',
        title: planned.title,
        recommendations: (args.recommendationIds as string[]).length,
        byCategory: planned.byCategory,
        steps: planned.steps.map((step) => ({ tool: step.tool })),
      },
      plan: { title: planned.title, steps: planned.steps },
    }
  },
}

// ── mute-ad-recommendations ──────────────────────────────────────────────────────────────────────────

type MuteOp = 'mute' | 'unmute'
interface MuteItem { id: string; category: string; title: string; from: MuteState; to: MuteState }

/** How many recommendations Claude may mute or unmute in one request by the business's rule (it changes no spend). */
const MUTE_LIMITS = z.object({
  maxItems: z.number().int().min(0).max(MAX_IDS).default(25)
    .describe('the most recommendations one request may mute or unmute without a person'),
})

/** The dry run of a mute: each id from its state now to the one it gets, or every reason it is refused. */
async function mutePlan(args: Record<string, unknown>): Promise<{ ok: true; op: MuteOp; items: MuteItem[] } | { ok: false; error: string }> {
  const ids = (args.recommendationIds as string[]) ?? []
  const op = args.op as MuteOp
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Each recommendation may be named once. Nothing was queued.' }
  const problems: string[] = []
  for (const id of ids) {
    const family = familyOfRecommendationId(id)
    if (family === 'rule') problems.push(`${id}: a rule's suggestion is dismissed with decide-automation-suggestions (decide: dismiss), not muted here`)
    else if (family === 'autopilot' || family === 'tracker') problems.push(`${id}: an autopilot decision or a keyword-tracker proposal is not muted from here yet`)
    else if (!isEngineFamily(family)) problems.push(`${id}: not a recommendation id Nexus gives (take it from ad-recommendations)`)
  }
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }
  const elsewhere = await notInBusiness(ids)
  if (elsewhere.size) return { ok: false, error: `Nothing was queued — ${[...elsewhere.values()].join('; ')}.` }
  const states = await recommendationMuteStates(ids)
  const shown = states.filter((s) => s.state === 'shown').map((s) => s.id)
  const feed = op === 'mute' && shown.length ? await feedById(Number(args.days ?? 30)) : new Map<string, Recommendation>()
  const items: MuteItem[] = []
  for (const s of states) {
    const rec = feed.get(s.id)
    if (op === 'mute' && s.state === 'muted') problems.push(`${s.id}: it is muted already`)
    else if (op === 'mute' && s.state === 'shown' && !rec) problems.push(`${s.id}: not recommended now — there is nothing to mute (read ad-recommendations again)`)
    else if (op === 'unmute' && s.state === 'shown') problems.push(`${s.id}: it is not muted`)
    // The retail engine words its finding as a pause; Nexus does not pause, so the title states the finding (as ad-recommendations).
    const title = rec ? (rec.category === 'retail' ? rec.title.replace(/^Pause\s+/, '') : rec.title) : s.label ?? s.id
    items.push({ id: s.id, category: familyOfRecommendationId(s.id) ?? 'unknown', title, from: s.state, to: op === 'mute' ? 'muted' : 'shown' })
  }
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }
  return { ok: true, op, items }
}

function mutePreview(op: MuteOp, items: MuteItem[]) {
  const n = plural(items.length, 'recommendation')
  return {
    action: 'mute-ad-recommendations',
    op,
    items,
    // From → to per recommendation, as the person approves it (and as the run compares it).
    changes: Object.fromEntries(items.map((i) => [`${i.title} (${i.id})`, { from: i.from, to: i.to }])),
    totals: { [op === 'mute' ? 'muting' : 'unmuting']: items.length },
    summary: op === 'mute'
      ? `Mutes ${n}: Nexus stops offering ${items.length === 1 ? 'it' : 'them'} (on the Recommendations tab and to Claude) until unmuted. Nothing reaches Amazon.`
      : `Unmutes ${n}: Nexus offers ${items.length === 1 ? 'it' : 'them'} again while the engines still recommend ${items.length === 1 ? 'it' : 'them'}. Nothing reaches Amazon.`,
  }
}

interface MuteChange { op: MuteOp; items: Array<{ id: string; state: MuteState }> }

/** C2 — a mute is put back by an unmute of the same ids, and an unmute by a mute (a settled one comes back muted). */
export const MUTE_UNDO: ToolUndo = {
  async current(change) {
    const after = change.after as MuteChange
    const now = await recommendationMuteStates(after.items.map((i) => i.id))
    return { op: after.op, items: now.map((s) => ({ id: s.id, state: s.state })) }
  },
  request(change) {
    const after = change.after as MuteChange
    if (!after?.items?.length) return { refusal: 'This change names no recommendation.' }
    return { tool: 'mute-ad-recommendations', args: { recommendationIds: after.items.map((i) => i.id), op: after.op === 'mute' ? 'unmute' : 'mute', why: `undo of an earlier ${after.op}` } }
  },
}

const muteAdRecommendations: AgentTool = {
  name: 'mute-ad-recommendations',
  title: 'Mute ad recommendations',
  category: 'advertising',
  input: z.object({
    recommendationIds: z.array(ID).min(1).max(MAX_IDS).describe(`the recommendationIds from ad-recommendations (bid:, neg:, grad:, budget:, sov:, retail:), 1 to ${MAX_IDS}`),
    op: z.enum(['mute', 'unmute']).describe('mute: Nexus stops offering it until it is unmuted; unmute: offer it again (also one a request already carried out)'),
    days: daysArg,
    why: whyArg.describe('why, in a sentence: kept with the mute'),
  }),
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: what the Recommendations tab and Claude are offered; nothing reaches Amazon.
  openWorld: false,
  reversibility: 'full',
  // It changes no spend: a business may let it run by its rule, inside how many at once.
  maxClaudeTrust: 'auto',
  limits: MUTE_LIMITS,
  withinLimits(preview, limits) {
    const p = preview as { action?: string; op?: string; items?: unknown[] } | null
    if (p?.action !== 'mute-ad-recommendations' || !Array.isArray(p.items)) return 'there is no preview of this mute to check'
    const max = typeof limits.maxItems === 'number' ? limits.maxItems : 0
    return p.items.length <= max ? null : `it would ${p.op} ${plural(p.items.length, 'recommendation')}, more than the ${max} this business lets Claude ${p.op} at once without a person`
  },
  undo: MUTE_UNDO,
  description:
    'Mute or unmute recommendations of the Amazon ad engines by id (from ad-recommendations: bid:, neg:, grad:, budget:, '
    + 'sov:, retail:), in Nexus only — nothing reaches Amazon. A muted recommendation is not offered (on the Recommendations '
    + 'tab or to Claude) until it is unmuted; unmute also offers again one a request already carried out. A person approves '
    + 'it in Nexus, or the person who asked confirms it in Claude with their authenticator code when the business set it so '
    + '— or it runs by the business\'s rule, inside its limits (how many at once). Refused before anything waits: an id not '
    + 'recommended now (to mute), one already muted (or not muted, to unmute), a rule\'s suggestion (dismiss it with '
    + 'decide-automation-suggestions). undo-change puts it back.',
  async handler(args): Promise<ToolResult> {
    const planned = await mutePlan(args)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: mutePreview(planned.op, planned.items) }
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const planned = await mutePlan(args)
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    const fresh = mutePreview(planned.op, planned.items)
    const approved = (ctx.approvedPreview as { changes?: unknown } | undefined)?.changes
    if (approved !== undefined && canonical(approved) !== canonical(fresh.changes)) {
      return notRun('Not run: what you approved has moved since — a recommendation was muted or unmuted meanwhile. Ask for it again.')
    }
    const run = approvedRun(ctx, String(args.why ?? ''))
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    const ids = planned.items.map((i) => i.id)
    if (planned.op === 'mute') await muteRecommendations(planned.items.map((i) => ({ id: i.id, label: i.title })), run.actor, run.reason)
    else await unmuteRecommendations(ids)
    return {
      ok: true,
      data: { op: planned.op, recommendations: ids.length, changeSetId: run.changeSetId, note: fresh.summary },
      change: {
        before: { op: planned.op, items: planned.items.map((i) => ({ id: i.id, state: i.from })) },
        after: { op: planned.op, items: planned.items.map((i) => ({ id: i.id, state: i.to })) },
      },
    }
  },
}

export const ADS_RECOMMENDATION_TOOLS: AgentTool[] = [applyAdRecommendations, muteAdRecommendations]
