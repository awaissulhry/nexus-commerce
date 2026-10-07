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
 *                                rule:    ONE decide-automation-suggestions (apply), which settles the suggestion rows;
 *                                         W4-9 — an override (a bid or a budget of its own) is the value its limits judge
 *                                sov:     refused: information, not a change (the service's apply is null)
 *                              W4-9 — an autopilot plan's decision and a Keyword Tracker proposal (never approveDecision /
 *                              applyProposal, which write as the plan or the page and decide their values when they run):
 *                                autopilot: BID → the bids the plan's optimizer computes now at the plan's target
 *                                         (planBidChanges, the plan's own computation), frozen into the one bid step;
 *                                         BUDGET → set-campaign-budget; PLACEMENT → set-placement-multipliers (top of
 *                                         search from its adjustment now, nudged by the decision's step)
 *                                kt:      the proposal's bid on each of its targets, frozen into the one bid step
 *                                         (bulk-ad-bid-change), after the Keyword Tracker's own re-checks (its target set
 *                                         unchanged, its ceiling — over the SUM of the request's proposals); the step
 *                                         re-checks both before it writes
 *                              When a step runs, its source settles the decision or the proposal (APPLIED, naming the
 *                              request — ads-change-source.ts settleSources).
 *                              Refused as a whole, naming each id's reason, before anything waits: an id whose row this
 *                              business does not have (not found), one no longer in the feed (the data moved), one muted
 *                              or already carried out, one a waiting request already carries out, and a rule's
 *                              suggestion for the same target, campaign or search term as an engine's recommendation in
 *                              the same request (the later step would find its facts moved and be skipped). Undo:
 *                              undo-change of the plan's approvalId (each step's own undo).
 *   mute-ad-recommendations    Nexus only: mute or unmute engine recommendations by id (SG.9's third verb: the feed stops
 *                              offering one until it is unmuted). W4-9 — dismiss or restore a rule's suggestion and an
 *                              autopilot decision as their screens do (dismissSuggestion, dismissDecision), and a Keyword
 *                              Tracker proposal (the proposal's own DISMISSED status; its page has no dismiss). Undo:
 *                              the opposite op. It changes no spend, so a
 *                              business may let it run by its rule, inside how many it may change at once.
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
import { decidedTopOfSearchPct, requestPreviews, sourceOf, type AdChangeSource } from './ads-change-source.js'
import type { AgentTool, ToolContext, ToolRequest, ToolResult, ToolUndo } from '../tool-types.js'

const MAX_IDS = 100
/** The lowest bid a bid change takes (set-target-bid, graduate-keyword). */
const BID_FLOOR_CENTS = 5
const ID = z.string().trim().min(1).max(400)
const daysArg = z.coerce.number().int().min(1).max(90).default(30).describe('the window the engines judge, as in ad-recommendations (default 30)')
const whyArg = z.string().trim().min(3).max(300)

/** The change tools a recommendation is carried out with, and the rules' suggestion tool. */
const SOURCE_TOOLS = ['set-target-bid', 'bulk-ad-bid-change', 'create-negative-keyword', 'graduate-keyword', 'set-campaign-budget', 'set-placement-multipliers', 'suppress-campaign'] as const
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
  // W4-9 — a rule's suggestion takes the Suggestions page's edit: a bid (one target's) or a budget (one campaign's);
  // decide-automation-suggestions checks it fits the suggestion.
  if (family === 'rule') {
    if (given.length === 1) return null
    return `${o.id}: a rule's suggestion takes one value of its own — proposedBidCents (a bid suggestion) or proposedBudgetCents (a budget suggestion)`
  }
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
async function overlaps(subjects: Array<{ id: string; entityType: string; entityId: string }>, recs: Recommendation[], held?: HeldPlan): Promise<string[]> {
  const byTarget = new Map<string, string>()
  const byCampaign = new Map<string, string>()
  // W4-9 — an autopilot decision's or a proposal's bids, budget and placements count the same.
  for (const b of held?.bids ?? []) byTarget.set(b.targetId, b.source.id)
  for (const b of [...(held?.budgets ?? []), ...(held?.placements ?? [])]) byCampaign.set(b.campaignId, b.source.id)
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

// ── W4-9 — an autopilot decision and a Keyword Tracker proposal ─────────────────────────────────────

/** What a set of autopilot and tracker ids becomes: the bid rows of the one bid step, budgets, placements — or why not. */
interface HeldPlan {
  problems: string[]
  bids: Array<{ targetId: string; bidCents: number; source: AdChangeSource }>
  budgets: Array<{ campaignId: string; dailyBudgetCents: number; source: AdChangeSource }>
  placements: Array<{ campaignId: string; topOfSearchPct: number; source: AdChangeSource }>
  /** What each id becomes, in words, for the person approving. */
  notes: string[]
}

const rowIdOf = (id: string) => id.slice(id.indexOf(':') + 1)
const DISMISS = 'dismiss it with mute-ad-recommendations (op dismiss)'
const centsOf = (v: unknown): number | null => {
  const c = (v as { cents?: unknown } | null)?.cents
  return typeof c === 'number' && Number.isFinite(c) ? c : null
}
const units = (minor: number) => (minor / 100).toFixed(2)

/**
 * Autopilot decisions, without approveDecision: a BID decision is the bids the plan's optimizer computes now at the
 * plan's target (planBidChanges, the plan's own computation), frozen here; a BUDGET decision its budget; a PLACEMENT
 * decision its top-of-search nudge on the adjustment now. Read only.
 */
async function planAutopilot(ids: string[], out: HeldPlan): Promise<void> {
  if (!ids.length) return
  const { decisionFacts, decisionBidChanges, APPLYABLE_MODULES } = await import('../../advertising/autopilot/decisions.js')
  const facts = await decisionFacts(ids.map(rowIdOf))
  for (const id of ids) {
    const d = facts.get(rowIdOf(id))
    const plan = d?.planName ? ` "${d.planName}"` : ''
    if (!d) { out.problems.push(`${id}: not found in this business — an autopilot plan replaces its waiting decisions every 15 minutes: read ad-recommendations again`); continue }
    if (d.source !== 'autopilot') { out.problems.push(`${id}: a rule's suggestion shown in the plan's feed — carry it out with its rule: id`); continue }
    if (d.status !== 'PROPOSED') { out.problems.push(`${id}: no longer waiting (it is ${d.status.toLowerCase()})`); continue }
    if (!d.planOn) { out.problems.push(`${id}: its plan${plan} is off, so its proposals are stale — ${DISMISS}`); continue }
    if (!d.campaignId) { out.problems.push(`${id}: it names no campaign to act on — ${DISMISS}`); continue }
    if (!APPLYABLE_MODULES.has(d.module)) { out.problems.push(`${id}: the ${d.module} module has no way to be carried out — ${DISMISS}`); continue }
    const source: AdChangeSource = { kind: 'autopilot', id }
    const campaign = await prisma.campaign.findFirst({ where: { id: d.campaignId }, select: { id: true, name: true, dailyBudget: true, dynamicBidding: true } })
    if (!campaign) { out.problems.push(`${id}: its campaign is not found in this business — ${DISMISS}`); continue }
    if (d.module === 'budget') {
      const to = centsOf(d.after)
      const now = Math.round(Number(campaign.dailyBudget) * 100)
      if (to == null || to <= 0) { out.problems.push(`${id}: it names no daily budget — ${DISMISS}`); continue }
      if (to === now) { out.problems.push(`${id}: ${campaign.name}'s daily budget is already ${units(to)} — ${DISMISS}`); continue }
      out.budgets.push({ campaignId: campaign.id, dailyBudgetCents: to, source })
      out.notes.push(`${id} (plan${plan}, ${d.action}): ${campaign.name}'s daily budget ${units(now)} → ${units(to)} with set-campaign-budget.`)
    } else if (d.module === 'placement') {
      const lanes = ((campaign.dynamicBidding as { placementBidding?: Array<{ placement?: string; percentage?: number }> } | null)?.placementBidding) ?? []
      const now = lanes.find((l) => l.placement === 'PLACEMENT_TOP')?.percentage ?? 0
      const to = decidedTopOfSearchPct(d.after, now)
      if (to === now) { out.problems.push(`${id}: top of search on ${campaign.name} is already at ${now} %, its bound — ${DISMISS}`); continue }
      out.placements.push({ campaignId: campaign.id, topOfSearchPct: to, source })
      out.notes.push(`${id} (plan${plan}, ${d.action}): top of search on ${campaign.name} ${now} % → ${to} % with set-placement-multipliers.`)
    } else {
      // The plan's effective target, as its own apply reads it: the campaign's signals (margin), the plan's guardrails.
      const planned = await decisionBidChanges(d)
      if (!planned) { out.problems.push(`${id}: its plan is not found in this business`); continue }
      if (!planned.changes.length) { out.problems.push(`${id}: at the plan's target the bid optimizer finds no bid in ${campaign.name} to move now — ${DISMISS}`); continue }
      out.bids.push(...planned.changes.map((c) => ({ targetId: c.targetId, bidCents: c.proposedBidCents, source })))
      const target = planned.used ? ` (${planned.used.targetAcosPct} % target ACoS)` : ''
      out.notes.push(`${id} (plan${plan}, ${d.action}): the bids the plan's optimizer computes now at the plan's target${target} — ${plural(planned.changes.length, 'bid')} in ${campaign.name}, frozen in the bid step (each line from → to).`)
    }
  }
}

/**
 * Keyword Tracker proposals, re-checked together as the Keyword Tracker's own apply re-checks one (recheckProposals):
 * the term's target set is the one it named (bids and the allowlist move: a moved set is refused, never a subset
 * applied), and its spend ceiling against today's ledger plus the proposals before it in this request (their sum, not
 * each alone). Its one bid on each of its targets is frozen into the bid step, which re-checks both before it writes.
 * Read only.
 */
async function planTracker(ids: string[], out: HeldPlan): Promise<void> {
  if (!ids.length) return
  const { proposalFacts, recheckProposals } = await import('../../advertising/kt6-proposal.service.js')
  const facts = await proposalFacts(ids.map(rowIdOf))
  const waiting: Array<{ id: string; p: NonNullable<ReturnType<typeof facts.get>> }> = []
  for (const id of ids) {
    const p = facts.get(rowIdOf(id))
    if (!p) { out.problems.push(`${id}: not found in this business`); continue }
    if (p.status !== 'PROPOSED') { out.problems.push(`${id}: no longer waiting (it is ${p.status.toLowerCase()})`); continue }
    waiting.push({ id, p })
  }
  const verdicts = await recheckProposals(waiting.map((w) => w.p))
  for (const { id, p } of waiting) {
    const why = verdicts.get(p.id)
    if (why) { out.problems.push(`${id}: ${why}: raise a new proposal on the Keyword Tracker, or ${DISMISS}`); continue }
    const source: AdChangeSource = { kind: 'tracker', id }
    out.bids.push(...p.targetIds.map((targetId) => ({ targetId, bidCents: p.requestedBidCents, source })))
    out.notes.push(`${id}: "${p.term}" in ${p.marketplace} at ${units(p.requestedBidCents)} on ${plural(p.targetIds.length, 'target')}, frozen in the bid step.`)
  }
}

/**
 * W4-9 — two ids of one request that change the same target's bid, campaign's budget or campaign's placements: the
 * later step would find its facts moved and be skipped, so the request names both instead. Pure.
 */
function sameSubjects(recs: Recommendation[], held: HeldPlan): string[] {
  const seen = new Map<string, string>()
  const out = new Set<string>()
  const claim = (key: string, what: string, id: string) => {
    const other = seen.get(key)
    if (other && other !== id) out.add(`${other} and ${id} both change the same ${what}: carry out one of them (the later one would find its facts moved and be skipped)`)
    else seen.set(key, id)
  }
  for (const r of recs) {
    const change = firstChange(r)
    if (r.category === 'bid' && change?.targetId) claim(`bid:${change.targetId}`, 'target', r.id)
    if (r.category === 'budget' && change?.campaignId) claim(`budget:${change.campaignId}`, 'campaign budget', r.id)
  }
  for (const b of held.bids) claim(`bid:${b.targetId}`, 'target', b.source.id)
  for (const b of held.budgets) claim(`budget:${b.campaignId}`, 'campaign budget', b.source.id)
  for (const pl of held.placements) claim(`placement:${pl.campaignId}`, 'campaign\'s placements', pl.source.id)
  return [...out]
}

/**
 * The dry run: the plan of change tools these ids are carried out with, or every reason it is refused. Pure read.
 * Exported for the tests; the door calls it through the tool.
 */
export async function planRecommendations(a: ApplyArgs): Promise<{ ok: true; title: string; steps: ToolRequest[]; byCategory: Record<string, number>; notes?: string[] } | { ok: false; error: string }> {
  const ids = a.recommendationIds
  const problems: string[] = []
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Each recommendation may be named once. Nothing was queued.' }
  const families = new Map(ids.map((id) => [id, familyOfRecommendationId(id)]))
  for (const [id, family] of families) {
    if (!family) problems.push(`${id}: not a recommendation id Nexus gives (take it from ad-recommendations)`)
    else if (family === 'sov') problems.push(`${id}: share of voice is information, not a change — decide it with set-target-bid, graduate-keyword or create-negative-keyword`)
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
  // W4-9 — autopilot decisions and Keyword Tracker proposals: their values, frozen now.
  const held: HeldPlan = { problems: [], bids: [], budgets: [], placements: [], notes: [] }
  await planAutopilot(ids.filter((id) => families.get(id) === 'autopilot'), held)
  await planTracker(ids.filter((id) => families.get(id) === 'tracker'), held)
  problems.push(...held.problems)

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
    problems.push(...(await overlaps(await suggestionSubjects(suggestionIds), engineIds.map((id) => feed.get(id)).filter((r): r is Recommendation => !!r), held)))
  }
  // W4-9 — two ids that change the same bid, budget or placement: the later step would find its facts moved.
  problems.push(...sameSubjects(engineIds.map((id) => feed.get(id)).filter((r): r is Recommendation => !!r), held))
  const waiting = await waitingRequestsFor(ids)
  for (const [id, approvalId] of waiting) problems.push(`${id}: already asked for — request ${approvalId} carries it out (approval-status follows it)`)
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }

  const why = a.why.trim()
  const source = (id: string) => sourceFor(id, a.days)
  const recs = engineIds.map((id) => feed.get(id)!)
  const of = (family: RecommendationFamily) => recs.filter((r) => families.get(r.id) === family)
  const steps: ToolRequest[] = []
  // Bids: one bulk change for all of them (one run of the business's daily cap), or set-target-bid for one. W4-9 — an
  // autopilot BID decision's and a proposal's bids join the same step.
  const bids = [
    ...of('bid').map((r) => {
      const change = firstChange(r)!
      return { targetId: String(change.targetId), bidCents: Math.round(overrides.get(r.id)?.proposedBidCents ?? Number(change.proposedBidCents)), source: source(r.id) }
    }),
    ...held.bids,
  ]
  // An autopilot decision's or a proposal's bids always go through bulk-ad-bid-change: its undo reverses through the
  // action log, where the A.I. Bids tab and the Keyword Tracker read a reversal.
  if (bids.length === 1 && bids[0].source.kind === 'recommendation') steps.push({ tool: 'set-target-bid', args: { targetId: bids[0].targetId, proposedBidCents: bids[0].bidCents, why, source: bids[0].source } })
  else if (bids.length) steps.push({ tool: 'bulk-ad-bid-change', args: { bids, why } })
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
  for (const b of held.budgets) steps.push({ tool: 'set-campaign-budget', args: { campaignId: b.campaignId, dailyBudgetCents: b.dailyBudgetCents, why, source: b.source } })
  for (const pl of held.placements) steps.push({ tool: 'set-placement-multipliers', args: { campaignId: pl.campaignId, topOfSearchPct: pl.topOfSearchPct, why, source: pl.source } })
  for (const r of of('retail')) {
    const campaignId = String((r.apply?.payload as { campaignIds?: string[] } | undefined)?.campaignIds?.[0] ?? '')
    steps.push({ tool: 'suppress-campaign', args: { campaignId, why, source: source(r.id) } })
  }
  // Rules: one decision of all their suggestions, through the Suggestions queue's own apply (it settles each row). W4-9 —
  // an override is the page's edit: the value the step's limits judge and the one that lands.
  if (ruleIds.length) {
    steps.push({
      tool: RULE_TOOL,
      args: {
        kind: 'amazon-ads',
        decisions: ruleIds.map((id) => {
          const own = overrides.get(id)
          const override = own?.proposedBidCents != null ? { bidCents: own.proposedBidCents } : own?.proposedBudgetCents != null ? { dailyBudgetCents: own.proposedBudgetCents } : null
          return { suggestionId: id.slice('rule:'.length), decide: 'apply', ...(override ? { override } : {}) }
        }),
      },
    })
  }

  const byCategory: Record<string, number> = {}
  for (const id of ids) byCategory[families.get(id)!] = (byCategory[families.get(id)!] ?? 0) + 1
  const parts = Object.entries(byCategory).map(([category, n]) => `${n} ${category}`).join(', ')
  return { ok: true, title: `Apply ${plural(ids.length, 'ad recommendation')} (${parts})`.slice(0, 120), steps, byCategory, ...(held.notes.length ? { notes: held.notes } : {}) }
}

const applyAdRecommendations: AgentTool = {
  name: 'apply-ad-recommendations',
  title: 'Apply ad recommendations',
  category: 'advertising',
  input: z.object({
    recommendationIds: z.array(ID).min(1).max(MAX_IDS)
      .describe(`the recommendationIds to carry out, from ad-recommendations: 1 to ${MAX_IDS} (bid:, neg:, grad:, budget:, retail:, rule:, autopilot: and kt: ids)`),
    overrides: z.array(z.object({
      id: ID.describe('one of recommendationIds'),
      proposedBidCents: z.coerce.number().int().min(BID_FLOOR_CENTS).max(100_000).optional()
        .describe('bid: a bid of your own instead of the engine\'s; grad: the starting bid; rule: a bid of your own for a rule\'s bid suggestion on one target — in minor units of the campaign\'s currency'),
      proposedBudgetCents: z.coerce.number().int().min(1).max(100_000_000).optional()
        .describe('budget: a daily budget of your own instead of the engine\'s; rule: one for a rule\'s budget suggestion on one campaign — in minor units of the campaign\'s currency'),
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
    + 'decide-automation-suggestions (a value of your own is the one its limits judge). An autopilot plan\'s decision '
    + '(autopilot:), its values fixed now: a bid decision → the bids the plan\'s optimizer computes now at the plan\'s '
    + 'target, in the one bid step; a budget decision → set-campaign-budget; a placement decision → '
    + 'set-placement-multipliers (top of search). A Keyword Tracker proposal (kt:) → its bid on each of its targets in the '
    + 'one bid step, after the Keyword Tracker\'s own checks (the same targets as when it was raised; its spend ceiling '
    + 'today, counting every proposal of the request together), checked again before it writes. Once a step ran, the '
    + 'decision or the proposal is marked applied, naming the request. '
    + 'Every step is checked now as you, at its own level and limits, as if asked alone. '
    + 'A person approves the plan in Nexus, or the person who asked confirms it in Claude with their authenticator code '
    + 'when the business set it so — or it runs by the business\'s rule, only when every step may (by default a raise or a '
    + 'new keyword needs a person). Each step names its recommendation (source), kept in the ads audit; once a step ran, '
    + 'its recommendation is not offered again until the data shows what the change did. Refused, each id with its reason, '
    + 'before anything waits: an id no longer recommended (the data moved), muted, or already carried out; one a waiting '
    + 'request already carries out; a share-of-voice id (information: decide it with set-target-bid, graduate-keyword or '
    + 'create-negative-keyword); an autopilot decision no longer waiting (its plan replaces them every 15 minutes) or whose '
    + 'plan is off; a proposal whose targets moved; two ids that change the same bid, budget or placement. approval-status '
    + 'follows the plan; undo-change with its approvalId puts it back.',
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
        // W4-9 — what each autopilot decision and Keyword Tracker proposal becomes.
        ...(planned.notes ? { notes: planned.notes } : {}),
      },
      plan: { title: planned.title, steps: planned.steps },
    }
  },
}

// ── mute-ad-recommendations ──────────────────────────────────────────────────────────────────────────

type MuteOp = 'mute' | 'unmute' | 'dismiss' | 'restore'
/** W4-9 — where a rule's suggestion, an autopilot decision or a Keyword Tracker proposal stands, as dismiss and restore move it. */
type DecideState = 'waiting' | 'dismissed'
/** An autopilot decision's identity (its plan + module|campaign|action, and when): a dismissal reaches the plan's re-proposal of it. */
interface DecisionIdentity { planId: string; module: string; campaignId: string | null; action: string; at: string }
interface MuteItem { id: string; category: string; title: string; from: MuteState | DecideState; to: MuteState | DecideState; identity?: DecisionIdentity }

/** How many recommendations Claude may mute, unmute, dismiss or restore in one request by the business's rule (it changes no spend). */
const MUTE_LIMITS = z.object({
  maxItems: z.number().int().min(0).max(MAX_IDS).default(25)
    .describe('the most recommendations one request may mute, unmute, dismiss or restore without a person'),
})

/** W4-9 — the ids a dismissal or a restore decides: their rows wait (or were dismissed) on their own screens. */
const DECIDED: ReadonlySet<RecommendationFamily> = new Set<RecommendationFamily>(['rule', 'autopilot', 'tracker'])
const KIND_WORDS: Record<string, string> = { rule: 'a rule\'s suggestion', autopilot: 'an autopilot decision', tracker: 'a Keyword Tracker proposal' }

/** The dry run of a mute: each id from its state now to the one it gets, or every reason it is refused. */
async function mutePlan(args: Record<string, unknown>, frozen: readonly MuteItem[] = []): Promise<{ ok: true; op: MuteOp; items: MuteItem[] } | { ok: false; error: string }> {
  const ids = (args.recommendationIds as string[]) ?? []
  const op = args.op as MuteOp
  if (new Set(ids).size !== ids.length) return { ok: false, error: 'Each recommendation may be named once. Nothing was queued.' }
  const deciding = op === 'dismiss' || op === 'restore'
  const problems: string[] = []
  for (const id of ids) {
    const family = familyOfRecommendationId(id)
    if (!family || (!isEngineFamily(family) && !DECIDED.has(family))) problems.push(`${id}: not a recommendation id Nexus gives (take it from ad-recommendations)`)
    else if (deciding && !DECIDED.has(family)) problems.push(`${id}: an engine's recommendation is ${op === 'dismiss' ? 'muted (op mute)' : 'unmuted (op unmute)'}, not ${op === 'dismiss' ? 'dismissed' : 'restored'}`)
    else if (!deciding && DECIDED.has(family)) problems.push(`${id}: ${KIND_WORDS[family]} is dismissed (op dismiss) and restored (op restore), not ${op}d${family === 'rule' ? ' — or decided with decide-automation-suggestions' : ''}`)
  }
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }
  if (deciding) return decidePlan(ids, op, frozen)
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

const decideStateOf = (status: string, waiting: string, dismissed: readonly string[]): DecideState | null =>
  status === waiting ? 'waiting' : dismissed.includes(status) ? 'dismissed' : null

/**
 * W4-9 — the dry run of a dismissal or a restore: each rule's suggestion, autopilot decision and Keyword Tracker proposal
 * from where it stands to where it goes, or every reason it is refused. Read only. `frozen`: the items the person
 * approved — an autopilot decision the plan's 15-minute tick replaced since is dismissed as its re-proposal (the same
 * decision: its plan, module, campaign and action, the screen's dismissal fingerprint).
 */
async function decidePlan(ids: string[], op: 'dismiss' | 'restore', frozen: readonly MuteItem[]): Promise<{ ok: true; op: MuteOp; items: MuteItem[] } | { ok: false; error: string }> {
  const of = (family: RecommendationFamily) => ids.filter((id) => familyOfRecommendationId(id) === family)
  const want: DecideState = op === 'dismiss' ? 'waiting' : 'dismissed'
  const to: DecideState = op === 'dismiss' ? 'dismissed' : 'waiting'
  const only = (what: string) => `only a ${op === 'dismiss' ? `waiting ${what} is dismissed` : `dismissed ${what} is restored`}`
  const problems: string[] = []
  const items = new Map<string, MuteItem>()
  const was = new Map(frozen.map((i) => [i.id, i]))

  const ruleIds = of('rule')
  if (ruleIds.length) {
    const { suggestionLabels } = await import('../../advertising/ads-suggestion-decide.service.js')
    const rows = await suggestionLabels(ruleIds.map(rowIdOf))
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const id of ruleIds) {
      const r = byId.get(rowIdOf(id))
      if (!r) { problems.push(`${id}: not found in this business`); continue }
      const state = decideStateOf(r.status, 'pending', ['dismissed', 'expired'])
      if (state !== want) problems.push(`${id}: it is ${r.status} — ${only('suggestion')}`)
      else items.set(id, { id, category: 'rule', title: was.get(id)?.title ?? `${r.ruleName ?? 'A rule'} on ${r.entityName ?? r.entityType}`, from: state, to })
    }
  }

  const decisionIds = of('autopilot')
  if (decisionIds.length) {
    const { decisionFacts, decisionStateNow } = await import('../../advertising/autopilot/decisions.js')
    const facts = await decisionFacts(decisionIds.map(rowIdOf))
    const campaigns = await prisma.campaign.findMany({ where: { id: { in: [...facts.values()].map((d) => d.campaignId).filter((c): c is string => !!c) } }, select: { id: true, name: true } })
    const nameOf = new Map(campaigns.map((c) => [c.id, c.name]))
    for (const id of decisionIds) {
      const d = facts.get(rowIdOf(id))
      const before = was.get(id)
      let state: DecideState | null
      let item: Omit<MuteItem, 'from' | 'to'>
      if (d) {
        if (d.source !== 'autopilot') { problems.push(`${id}: a rule's suggestion shown in the plan's feed — decide it with its rule: id`); continue }
        state = decideStateOf(d.status, 'PROPOSED', ['DISMISSED'])
        const identity = { planId: d.planId, module: d.module, campaignId: d.campaignId, action: d.action, at: d.at }
        item = { id, category: 'autopilot', title: before?.title ?? `${d.action} on ${(d.campaignId && nameOf.get(d.campaignId)) ?? d.campaignId ?? 'no campaign'} (plan${d.planName ? ` "${d.planName}"` : ''})`, identity }
      } else if (op === 'dismiss' && before?.identity) {
        // The tick replaced it since this was asked: its re-proposal is the same decision.
        const now = await decisionStateNow({ id: rowIdOf(id), ...before.identity })
        state = now.state === 'proposed' ? 'waiting' : now.state === 'dismissed' ? 'dismissed' : null
        if (state === 'waiting' && !now.planOn) state = null
        item = { id, category: 'autopilot', title: before.title, identity: before.identity }
      } else {
        problems.push(`${id}: not found in this business — an autopilot plan replaces its waiting decisions every 15 minutes: read ad-recommendations again`)
        continue
      }
      if (state !== want) problems.push(`${id}: ${state ? `it is ${state}` : 'it was decided'} — ${only('decision')}`)
      else items.set(id, { ...item, from: state, to })
    }
  }

  const proposalIds = of('tracker')
  if (proposalIds.length) {
    const { proposalFacts } = await import('../../advertising/kt6-proposal.service.js')
    const facts = await proposalFacts(proposalIds.map(rowIdOf))
    for (const id of proposalIds) {
      const p = facts.get(rowIdOf(id))
      if (!p) { problems.push(`${id}: not found in this business`); continue }
      const state = decideStateOf(p.status, 'PROPOSED', ['DISMISSED'])
      if (state !== want) problems.push(`${id}: it is ${p.status.toLowerCase()} — ${only('proposal')}`)
      else items.set(id, { id, category: 'tracker', title: was.get(id)?.title ?? `"${p.term}" in ${p.marketplace} on ${plural(p.targetIds.length, 'target')}`, from: state, to })
    }
  }
  if (problems.length) return { ok: false, error: `Nothing was queued — ${problems.join('; ')}.` }
  return { ok: true, op, items: ids.map((id) => items.get(id)!) }
}

/** W4-9 — what a dismissal or a restore does to each kind it names, in words. */
function decideWords(op: 'dismiss' | 'restore', items: MuteItem[]): string {
  const has = (category: string) => items.some((i) => i.category === category)
  const words = op === 'dismiss'
    ? [
        has('rule') ? 'a rule\'s suggestion leaves the Suggestions queue (restore puts it back)' : null,
        has('autopilot') ? 'an autopilot decision leaves the A.I. Bids tab, and its plan does not propose it again for 7 days' : null,
        has('tracker') ? 'a Keyword Tracker proposal is closed without a write' : null,
      ]
    : [
        has('rule') ? 'a rule\'s suggestion waits in the Suggestions queue again' : null,
        has('autopilot') ? 'an autopilot decision waits on the A.I. Bids tab again until its plan\'s next run (within 15 minutes) decides it afresh' : null,
        has('tracker') ? 'a Keyword Tracker proposal waits to be applied or dismissed again' : null,
      ]
  return words.filter(Boolean).join('; ')
}

function mutePreview(op: MuteOp, items: MuteItem[]) {
  const n = plural(items.length, 'recommendation')
  const it = items.length === 1 ? 'it' : 'them'
  const summary = op === 'mute'
    ? `Mutes ${n}: Nexus stops offering ${it} (on the Recommendations tab and to Claude) until unmuted. Nothing reaches Amazon.`
    : op === 'unmute'
      ? `Unmutes ${n}: Nexus offers ${it} again while the engines still recommend ${it}. Nothing reaches Amazon.`
      : `${op === 'dismiss' ? 'Dismisses' : 'Restores'} ${n} in Nexus: ${decideWords(op, items)}. Nothing reaches Amazon.`
  return {
    action: 'mute-ad-recommendations',
    op,
    items,
    // From → to per recommendation, as the person approves it (and as the run compares it).
    changes: Object.fromEntries(items.map((i) => [`${i.title} (${i.id})`, { from: i.from, to: i.to }])),
    totals: { [{ mute: 'muting', unmute: 'unmuting', dismiss: 'dismissing', restore: 'restoring' }[op]]: items.length },
    summary,
  }
}

interface MuteChange { op: MuteOp; items: Array<{ id: string; state: string }> }

/** W4-9 — where these rule suggestions, autopilot decisions and proposals stand now ('decided' or 'gone' otherwise). */
async function decideStatesNow(ids: string[]): Promise<Array<{ id: string; state: string }>> {
  const of = (family: RecommendationFamily) => ids.filter((id) => familyOfRecommendationId(id) === family).map(rowIdOf)
  const [rules, decisions, proposals] = await Promise.all([
    of('rule').length ? import('../../advertising/ads-suggestion-decide.service.js').then((m) => m.suggestionStatuses(of('rule'))) : [],
    of('autopilot').length ? import('../../advertising/autopilot/decisions.js').then((m) => m.decisionFacts(of('autopilot'))) : new Map(),
    of('tracker').length ? import('../../advertising/kt6-proposal.service.js').then((m) => m.proposalFacts(of('tracker'))) : new Map(),
  ])
  const ruleStatus = new Map(rules.filter((r) => r.status !== 'gone').map((r) => [r.id, r.status]))
  return ids.map((id) => {
    const family = familyOfRecommendationId(id)
    const status = family === 'rule' ? ruleStatus.get(rowIdOf(id)) : family === 'autopilot' ? decisions.get(rowIdOf(id))?.status : proposals.get(rowIdOf(id))?.status
    if (status == null) return { id, state: 'gone' }
    const state = family === 'rule' ? decideStateOf(status, 'pending', ['dismissed', 'expired']) : decideStateOf(status, 'PROPOSED', ['DISMISSED'])
    return { id, state: state ?? 'decided' }
  })
}

const OPPOSITE: Record<MuteOp, MuteOp> = { mute: 'unmute', unmute: 'mute', dismiss: 'restore', restore: 'dismiss' }

/**
 * C2 — a mute is put back by an unmute of the same ids, and an unmute by a mute (a settled one comes back muted). W4-9 —
 * a dismissal by a restore of the rows it dismissed, and a restore by a dismissal.
 */
export const MUTE_UNDO: ToolUndo = {
  async current(change) {
    const after = change.after as MuteChange
    const ids = after.items.map((i) => i.id)
    if (after.op === 'dismiss' || after.op === 'restore') return { op: after.op, items: await decideStatesNow(ids) }
    const now = await recommendationMuteStates(ids)
    return { op: after.op, items: now.map((s) => ({ id: s.id, state: s.state })) }
  },
  request(change) {
    const after = change.after as MuteChange
    if (!after?.items?.length) return { refusal: 'This change names no recommendation.' }
    return { tool: 'mute-ad-recommendations', args: { recommendationIds: after.items.map((i) => i.id), op: OPPOSITE[after.op] ?? 'unmute', why: `undo of an earlier ${after.op}` } }
  },
}

/**
 * W4-9 — one dismissal or restore, through the screen's own verb (a proposal: its own DISMISSED status), as the approver
 * (`by` as each row records a decider: a suggestion `user:<id>`, a proposal the plain id, as KT.7); the id of the row it
 * decided (a replaced decision's re-proposal).
 */
async function decideOne(item: MuteItem, op: 'dismiss' | 'restore', by: { actor: string; userId: string | null }): Promise<{ ok: boolean; id: string; error?: string }> {
  const rowId = rowIdOf(item.id)
  if (item.category === 'rule') {
    const svc = await import('../../advertising/ads-suggestion-decide.service.js')
    const out = op === 'dismiss' ? await svc.dismissSuggestion(rowId, by.actor) : await svc.restoreSuggestion(rowId)
    return { ok: out.ok, id: item.id, ...(out.ok ? {} : { error: out.error ?? 'refused' }) }
  }
  if (item.category === 'autopilot') {
    const m = await import('../../advertising/autopilot/decisions.js')
    if (op === 'restore') {
      const out = await m.restoreDecision(rowId)
      return { ok: out.ok, id: item.id, ...(out.ok ? {} : { error: out.error ?? 'refused' }) }
    }
    if (!item.identity) return { ok: false, id: item.id, error: 'its decision is not named' }
    const out = await m.dismissDecisionIdentity({ id: rowId, ...item.identity })
    return { ok: out.ok, id: out.rowId ? `autopilot:${out.rowId}` : item.id, ...(out.ok ? {} : { error: out.error ?? 'refused' }) }
  }
  const m = await import('../../advertising/kt6-proposal.service.js')
  const out = op === 'dismiss' ? await m.dismissProposal(rowId, by.userId) : await m.restoreProposal(rowId)
  return { ok: out.ok, id: item.id, ...(out.ok ? {} : { error: out.error ?? 'refused' }) }
}

const muteAdRecommendations: AgentTool = {
  name: 'mute-ad-recommendations',
  title: 'Mute ad recommendations',
  category: 'advertising',
  input: z.object({
    recommendationIds: z.array(ID).min(1).max(MAX_IDS).describe(`the recommendationIds from ad-recommendations, 1 to ${MAX_IDS}: bid:, neg:, grad:, budget:, sov:, retail: (mute, unmute); rule:, autopilot:, kt: (dismiss, restore)`),
    op: z.enum(['mute', 'unmute', 'dismiss', 'restore']).describe('mute: Nexus stops offering an engine\'s recommendation until it is unmuted; unmute: offer it again (also one a request already carried out); dismiss: a rule\'s suggestion or an autopilot decision is set aside as its screen dismisses it, a Keyword Tracker proposal is closed without a write; restore: a dismissed one waits again'),
    days: daysArg,
    why: whyArg.describe('why, in a sentence: kept with the mute'),
  }),
  requires: [F.adsCampaignsManage, FIELDS.financialsAdspendView],
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  // Nexus only: what the Recommendations tab, the Suggestions queue, the A.I. Bids tab, the Keyword Tracker and Claude are
  // offered; nothing reaches Amazon.
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
    + 'sov:, retail:), or dismiss or restore a rule\'s suggestion (rule:), an autopilot plan\'s decision (autopilot:) or a '
    + 'Keyword Tracker proposal (kt:) — in Nexus only, nothing reaches Amazon. A muted recommendation is not offered (on '
    + 'the Recommendations tab or to Claude) until it is unmuted; unmute also offers again one a request already carried '
    + 'out. A dismissed suggestion leaves the Suggestions queue and a dismissed autopilot decision the A.I. Bids tab (its '
    + 'plan does not propose it again for 7 days), as those screens dismiss them; a dismissed Keyword Tracker proposal is '
    + 'closed without a write (its own DISMISSED status: the Keyword Tracker page has no dismiss). restore puts a '
    + 'dismissed one back to waiting. A person approves it in Nexus, or the person who asked confirms it in Claude with '
    + 'their authenticator code when the business set it so — or it runs by the business\'s rule, inside its limits (how '
    + 'many at once). Refused before anything waits: an id not recommended now (to mute), one already muted (or not muted, '
    + 'to unmute), one not waiting (to dismiss) or not dismissed (to restore), an op that does not fit the id. undo-change '
    + 'puts it back.',
  async handler(args, ctx): Promise<ToolResult> {
    // W4-9 — the request's own re-check (a person approving it) reads the items it froze: a decision the plan's tick
    // replaced since is dismissed as its re-proposal, as the run does.
    const frozen = ctx.approvalId ? (await requestPreviews(ctx.approvalId, 'mute-ad-recommendations')).flatMap((p) => {
      const items = (p as { items?: unknown } | null)?.items
      return Array.isArray(items) ? (items as MuteItem[]) : []
    }) : []
    const planned = await mutePlan(args, frozen)
    if ('error' in planned) return { ok: false, error: planned.error }
    return { ok: true, preview: mutePreview(planned.op, planned.items) }
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    const approvedItems = (ctx.approvedPreview as { items?: unknown } | undefined)?.items
    const planned = await mutePlan(args, Array.isArray(approvedItems) ? (approvedItems as MuteItem[]) : [])
    if ('error' in planned) return notRun(`Not run: ${planned.error}`)
    const fresh = mutePreview(planned.op, planned.items)
    const approved = (ctx.approvedPreview as { changes?: unknown } | undefined)?.changes
    if (approved !== undefined && canonical(approved) !== canonical(fresh.changes)) {
      return notRun('Not run: what you approved has moved since — a recommendation was muted, unmuted or decided meanwhile. Ask for it again.')
    }
    const run = approvedRun(ctx, String(args.why ?? ''))
    if ('refusal' in run) return notRun(`Not run: ${run.refusal}.`)
    if (planned.op === 'dismiss' || planned.op === 'restore') {
      const op = planned.op
      const results: Array<{ item: MuteItem; out: { ok: boolean; id: string; error?: string } }> = []
      for (const item of planned.items) results.push({ item, out: await decideOne(item, op, { actor: run.actor, userId: ctx.userId ?? null }) })
      const done = results.filter((r) => r.out.ok)
      const refused = results.filter((r) => !r.out.ok).map((r) => `${r.item.id}: ${r.out.error}`)
      if (!done.length) return notRun(`Not run: ${refused.join('; ')}.`)
      return {
        ok: true,
        data: { op, decided: done.length, refused, changeSetId: run.changeSetId, note: fresh.summary },
        change: {
          before: { op, items: done.map((r) => ({ id: r.out.id, state: r.item.from })) },
          after: { op, items: done.map((r) => ({ id: r.out.id, state: r.item.to })) },
        },
      }
    }
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
