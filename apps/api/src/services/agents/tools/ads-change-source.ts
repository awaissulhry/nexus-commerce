/**
 * ADS AUTONOMY W3-1 — where an ad change came from (its provenance), the same way on every Amazon ad change tool that
 * carries out an engine's output: set-target-bid, bulk-ad-bid-change (per row), create-negative-keyword,
 * graduate-keyword, set-campaign-budget and suppress-campaign.
 *
 *   arg        `source: { kind, id }` — optional. apply-ad-recommendations sets it on every step it asks for; Claude may
 *              set it too when it carries a recommendation out with the change tool itself.
 *   checked    in the dry run: a source names THIS change's recommendation (`bid:<the target>` …), or the request is
 *              refused. A rule's suggestion is applied with decide-automation-suggestions, never named as a source.
 *   kept       in the preview (`source`, `sourceNote`: the person approving reads which engine asked for it) and on
 *              the ads audit row of every write it makes (AdWriteEvidence.source): ad-changes and Claude's report say
 *              "from the bid optimizer".
 *   settled    once the write ran, the recommendation is settled (ads-recommendation-mutes.service.ts): the feed does
 *              not offer it again until the data the engines read is a day past the change. A settle that fails is
 *              logged, never a failed change: the write ran. The change records the ids it settled (`before.sources`);
 *              when the change is put back, its tool's `undo.undone` (`unsettleChange`) removes those settles, so the
 *              recommendations are offered again at once.
 *
 * ADS AUTONOMY W4-9 — an autopilot plan's decision (`kind: autopilot`, id `autopilot:<decisionId>`) and a Keyword
 * Tracker proposal (`kind: tracker`, id `kt:<proposalId>`) ride the same way, on the tools that do what they decide:
 *   taken      autopilot on set-target-bid and bulk-ad-bid-change (a BID decision's bids), set-campaign-budget (a BUDGET
 *              decision) and set-placement-multipliers (a PLACEMENT decision); tracker on the two bid tools (the
 *              proposal's one bid on each of its targets). Any other tool refuses them (sourceRefusal).
 *   checked    against its row once the change's campaign is known (heldSources): a decision of this business, still
 *              waiting, of a plan that runs, of the module this change is, on this campaign, asking this value; a
 *              proposal still waiting, naming this target at this bid. In the request's own re-check (when a person
 *              approves, and before it runs) an autopilot decision the plan's 15-minute tick replaced is still carried
 *              out with the values frozen in the request; one dismissed or decided meanwhile, or whose plan was
 *              switched off, refuses it.
 *   kept       the preview names it (`sourceNote`) and freezes its facts (`sourceFacts`): what the person approves.
 *   settled    once the write ran — the one hook (settleSources): the decision is APPLIED (autopilot/decisions.ts
 *              settleDecisionsCarried) and the proposal APPLIED (kt6-proposal.service.ts settleProposalsCarried), each
 *              naming the request. Put back (unsettleChange): the proposal's commitment is given back to today's
 *              ceiling, and the decision's history says it was put back.
 */
import { z } from 'zod'
import type { AdWriteEvidence } from '../../advertising/ads-evidence.js'
import { familyOfRecommendationId, isEngineFamily, settleRecommendations, unsettleRecommendations } from '../../advertising/ads-recommendation-mutes.service.js'
import type { DecisionFacts } from '../../advertising/autopilot/decisions.js'
import type { ToolChange } from '../tool-types.js'
import { logger } from '../../../utils/logger.js'

/** Who produced what a change carries out. */
export const SOURCE_KINDS = ['recommendation', 'rule', 'autopilot', 'tracker'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
export interface AdChangeSource { kind: SourceKind; id: string; windowDays?: number }

const sourceShape = z.object({
  kind: z.enum(SOURCE_KINDS).describe('recommendation: an engine\'s recommendation; autopilot: an autopilot plan\'s decision; tracker: a Keyword Tracker proposal (each from ad-recommendations)'),
  id: z.string().trim().min(1).max(400).describe('its recommendationId from ad-recommendations, e.g. bid:<targetId>, autopilot:<decisionId> or kt:<proposalId>'),
  windowDays: z.coerce.number().int().min(1).max(90).optional().describe('the window ad-recommendations was read over (its days), when not 30'),
})

/** The `source` argument of a change tool. */
export const sourceArg = sourceShape.optional()
  .describe('what this change carries out, from ad-recommendations (apply-ad-recommendations sets it): kept in the preview and the ads audit; once it runs, an engine\'s recommendation is not offered again until the data shows what the change did, and an autopilot decision or a Keyword Tracker proposal is marked applied')

/** A source from a tool's (parsed) arguments, or null. */
export function sourceOf(value: unknown): AdChangeSource | null {
  const parsed = sourceShape.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** The engine behind each kind of recommendation, as a person reads it. */
const ENGINE_WORDS: Record<string, string> = {
  bid: 'the bid optimizer',
  negative: 'the search-term harvester',
  graduate: 'the search-term harvester',
  budget: 'budget pacing',
  retail: 'the retail-readiness check',
}

/**
 * The recommendation id this change carries out, as ad-recommendations builds it (ads-recommendations.service.ts):
 * `bid:<targetId>`, `budget:<campaignId>`, `retail:<campaignId>`, `neg:<externalAdGroupId>:<query>`,
 * `grad:<externalAdGroupId>:<query>`.
 */
export const recommendationIdFor = {
  bid: (targetId: string) => `bid:${targetId}`,
  budget: (campaignId: string) => `budget:${campaignId}`,
  retail: (campaignId: string) => `retail:${campaignId}`,
  negative: (externalAdGroupId: string, query: string) => `neg:${externalAdGroupId}:${query}`,
  graduate: (externalAdGroupId: string, query: string) => `grad:${externalAdGroupId}:${query}`,
}

// ── W4-9 — an autopilot decision or a keyword-tracker proposal (a "held" source: a row of its own) ───────────

/** What a change that may carry out a held source changes. */
export type HeldChange = 'bid' | 'budget' | 'placement'
type HeldKind = 'autopilot' | 'tracker'
const HELD_PREFIX: Record<HeldKind, string> = { autopilot: 'autopilot:', tracker: 'kt:' }
const isHeld = (kind: SourceKind): kind is HeldKind => kind === 'autopilot' || kind === 'tracker'
const HELD_TOOLS = 'set-target-bid, bulk-ad-bid-change, set-campaign-budget or set-placement-multipliers'
/** The row id behind a held source's id (`autopilot:<id>` → `<id>`). */
const rowIdOf = (source: AdChangeSource) => source.id.slice(HELD_PREFIX[source.kind as HeldKind].length)

/**
 * Why a source cannot ride on this change (it names another one, or a kind this tool does not carry out); null when it
 * may. Pure. `held` — W4-9: what this tool changes, when it carries out autopilot decisions or tracker proposals (their
 * rows are checked by heldSources once the change's campaign is known).
 */
export function sourceRefusal(source: AdChangeSource | null, expectedId: string, opts: { held?: HeldChange } = {}): string | null {
  if (!source) return null
  if (source.kind === 'rule') return 'a rule\'s suggestion is applied with decide-automation-suggestions (or apply-ad-recommendations with its rule: id), not named as the source of this change'
  if (isHeld(source.kind)) {
    const prefix = HELD_PREFIX[source.kind]
    if (!source.id.startsWith(prefix) || source.id.length === prefix.length) return `a source of kind ${source.kind} names its id as ${prefix}<id>, from ad-recommendations`
    if (!opts.held) return `an autopilot decision or a Keyword Tracker proposal is carried out with ${HELD_TOOLS} (or apply-ad-recommendations with its id), not named as the source of this change`
    if (source.kind === 'tracker' && opts.held !== 'bid') return 'a Keyword Tracker proposal changes bids: it is carried out with set-target-bid or bulk-ad-bid-change'
    return null
  }
  if (source.id !== expectedId) return `the source names recommendation ${source.id}, but this change carries out ${expectedId}`
  return null
}

/** What the preview freezes about a held source: what the person approves, and what settles its row once it ran. */
export type SourceFact =
  | { kind: 'autopilot'; id: string; decision: DecisionFacts }
  | { kind: 'tracker'; id: string; proposal: { id: string; term: string; marketplace: string; requestedBidCents: number; targets: number } }

/** The change a held source rides on, as its row is checked against it. */
export interface HeldSubject {
  change: HeldChange
  campaignId: string
  /** A bid: the target, and the bid it asks. */
  targetId?: string
  /** A bid or a budget: the value it asks, in minor units of the campaign's currency. */
  valueCents?: number
  /** A placement: top of search from → to, and whether only top of search moves. */
  placement?: { fromPct: number; toPct: number; onlyTopOfSearch: boolean }
}

const cents = (v: unknown): number | null => {
  const c = (v as { cents?: unknown } | null)?.cents
  return typeof c === 'number' && Number.isFinite(c) ? c : null
}
const money = (minor: number) => (minor / 100).toFixed(2)
const WHAT: Record<HeldChange, string> = { bid: 'bid', budget: 'daily budget', placement: 'placement adjustment' }

/**
 * The top-of-search adjustment a PLACEMENT decision lands on from the one now: its nudge (`after.raiseTosPct` /
 * `lowerTosPct`) on the current adjustment, held to 0–200 % — the same arithmetic the plan's AUTO apply uses
 * (autopilot/apply.ts). Pure.
 */
export function decidedTopOfSearchPct(after: unknown, currentPct: number): number {
  const a = (after ?? {}) as { raiseTosPct?: number; lowerTosPct?: number }
  return Math.min(200, Math.max(0, Math.round(currentPct + (a.raiseTosPct ?? -(a.lowerTosPct ?? 0)))))
}

/**
 * W4-9 — the rows behind these sources, against what each change does: the facts the preview freezes, or every reason
 * the change may not carry them out. Read only. `recheck` (the request's own re-check: a person approving it, or its
 * run — ToolContext.approvalId): an autopilot decision whose row the plan's 15-minute tick replaced is still carried out
 * with the values frozen in the request (it has no fact now; the request's stored preview keeps the one it was asked
 * with). Engine recommendations pass through (sourceRefusal checked them).
 */
export async function heldSources(items: ReadonlyArray<{ source: AdChangeSource | null; subject: HeldSubject }>, recheck: boolean): Promise<{ refusal: string } | { facts: SourceFact[] }> {
  const held = items.filter((i): i is { source: AdChangeSource; subject: HeldSubject } => !!i.source && isHeld(i.source.kind))
  if (!held.length) return { facts: [] }
  const decisionIds = held.filter((i) => i.source.kind === 'autopilot').map((i) => rowIdOf(i.source))
  const proposalIds = held.filter((i) => i.source.kind === 'tracker').map((i) => rowIdOf(i.source))
  const [decisions, proposals] = await Promise.all([
    decisionIds.length ? import('../../advertising/autopilot/decisions.js').then((m) => m.decisionFacts(decisionIds)) : new Map<string, DecisionFacts>(),
    proposalIds.length ? import('../../advertising/kt6-proposal.service.js').then((m) => m.proposalFacts(proposalIds)) : new Map(),
  ])
  const problems: string[] = []
  const facts = new Map<string, SourceFact>()
  for (const { source, subject } of held) {
    const id = rowIdOf(source)
    if (source.kind === 'autopilot') {
      const d = decisions.get(id)
      if (!d) {
        // The tick replaced it: the request carries out what it froze. A fresh request needs it waiting now.
        if (!recheck) problems.push(`${source.id}: no such autopilot decision waits in this business — a plan replaces its proposals every 15 minutes: read ad-recommendations again`)
        continue
      }
      const asked = d.module === 'budget' ? cents(d.after) : null
      if (d.source !== 'autopilot') problems.push(`${source.id}: a rule's suggestion shown in the plan's feed: decide it with its rule: id`)
      else if (d.status !== 'PROPOSED') problems.push(`${source.id}: no longer waiting — ${d.status === 'DISMISSED' ? 'it was dismissed' : `it is ${d.status.toLowerCase()}`}`)
      else if (!d.planOn) problems.push(`${source.id}: its plan${d.planName ? ` "${d.planName}"` : ''} is off, so its proposals are stale`)
      else if (d.module !== subject.change) problems.push(`${source.id}: a ${d.module} decision, but this change sets a ${WHAT[subject.change]}`)
      else if (d.campaignId !== subject.campaignId) problems.push(`${source.id}: it decides campaign ${d.campaignId ?? '(none)'}, not ${subject.campaignId}`)
      else if (subject.change === 'budget' && asked !== subject.valueCents) problems.push(`${source.id}: it decides a daily budget of ${asked == null ? '(none)' : money(asked)}, not ${money(subject.valueCents ?? 0)}`)
      else if (subject.change === 'placement' && (!subject.placement?.onlyTopOfSearch || subject.placement.toPct !== decidedTopOfSearchPct(d.after, subject.placement.fromPct))) {
        problems.push(`${source.id}: it moves top of search only, from ${subject.placement?.fromPct ?? 0} % to ${decidedTopOfSearchPct(d.after, subject.placement?.fromPct ?? 0)} %`)
      } else facts.set(source.id, { kind: 'autopilot', id: source.id, decision: d })
      continue
    }
    const p = proposals.get(id)
    if (!p) problems.push(`${source.id}: no such Keyword Tracker proposal in this business`)
    else if (p.status !== 'PROPOSED') problems.push(`${source.id}: no longer waiting — it is ${p.status.toLowerCase()}`)
    else if (!subject.targetId || !p.targetIds.includes(subject.targetId)) problems.push(`${source.id}: it does not name target ${subject.targetId ?? '(none)'}`)
    else if (subject.valueCents !== p.requestedBidCents) problems.push(`${source.id}: it asks for a bid of ${money(p.requestedBidCents)} on its targets, not ${money(subject.valueCents ?? 0)}`)
    else facts.set(source.id, { kind: 'tracker', id: source.id, proposal: { id: p.id, term: p.term, marketplace: p.marketplace, requestedBidCents: p.requestedBidCents, targets: p.targetIds.length } })
  }
  if (problems.length) return { refusal: [...new Set(problems)].join('; ') }
  return { facts: [...facts.values()] }
}

/** What the preview says about a held source, for the person approving. */
function heldNote(source: AdChangeSource, fact: SourceFact | undefined): string {
  if (fact?.kind === 'autopilot') {
    const d = fact.decision
    return `From the autopilot plan${d.planName ? ` "${d.planName}"` : ''}: its decision ${fact.id} (${d.action} — ${d.reason}). Once this runs the decision is marked applied on the A.I. Bids tab, naming this request.`
  }
  if (fact?.kind === 'tracker') {
    const p = fact.proposal
    return `From the Keyword Tracker proposal ${fact.id}: "${p.term}" in ${p.marketplace} at ${money(p.requestedBidCents)} on ${p.targets} target${p.targets === 1 ? '' : 's'}. Once this runs the proposal is marked applied, naming this request.`
  }
  return `From the autopilot decision ${source.id}: its plan has proposed again since this was asked; the values frozen in this request stand, and once it runs the decision is marked applied on the A.I. Bids tab.`
}

/** What the preview says about a source, for the person approving. */
export function sourceNote(source: AdChangeSource, facts: readonly SourceFact[] = []): string {
  if (isHeld(source.kind)) return heldNote(source, facts.find((f) => f.id === source.id))
  const engine = ENGINE_WORDS[familyOfRecommendationId(source.id) ?? ''] ?? 'an ad engine'
  return `From ${engine}'s recommendation ${source.id}. Once this runs it is not offered again until the data shows what the change did.`
}

/** The preview's keys for a source: nothing without one; W4-9 — a held source's frozen facts too. */
export function sourcePreview(source: AdChangeSource | null, facts: readonly SourceFact[] = []): { source?: AdChangeSource; sourceNote?: string; sourceFacts?: SourceFact[] } {
  if (!source) return {}
  const own = facts.filter((f) => f.id === source.id)
  return { source, sourceNote: sourceNote(source, facts), ...(own.length ? { sourceFacts: own } : {}) }
}

/**
 * Whether ad-recommendations offers this recommendation now (the same feed, over the window it was read): a sentence
 * when it does not — the data moved, or it is muted or already carried out. Read only; the feed is computed live.
 */
export async function notOfferedRefusal(source: AdChangeSource): Promise<string | null> {
  const { buildRecommendations } = await import('../../advertising/ads-recommendations.service.js')
  const feed = await buildRecommendations({ windowDays: source.windowDays ?? 30 })
  if (feed.recommendations.some((r) => r.id === source.id)) return null
  return `the source names recommendation ${source.id}, which ad-recommendations does not offer now (the data moved, or it is muted or already carried out): read it again`
}

/** What a change records about what it settled (`before.sources`): nothing without one. */
export function sourcesRecord(sources: ReadonlyArray<AdChangeSource | null | undefined>): { sources?: string[] } {
  const ids = sources.filter((s): s is AdChangeSource => !!s && s.kind !== 'rule').map((s) => s.id)
  return ids.length ? { sources: [...new Set(ids)] } : {}
}

/**
 * `undo.undone` of every tool here: the change was put back, so the recommendations it settled (`before.sources`, under
 * the request it ran as, `before.changeSetId`) are offered again at once — a person's mute stays. W4-9 — a Keyword
 * Tracker proposal it carried out gives its commitment back to today's ceiling; an autopilot decision's history says it
 * was put back. Never throws for those: the undo ran.
 */
export async function unsettleChange(change: ToolChange): Promise<void> {
  const before = (change.before ?? {}) as { sources?: unknown; changeSetId?: unknown }
  const ids = Array.isArray(before.sources) ? before.sources.filter((id): id is string => typeof id === 'string') : []
  if (!ids.length || typeof before.changeSetId !== 'string') return
  const changeSetId = before.changeSetId
  const engine = ids.filter((id) => isEngineFamily(familyOfRecommendationId(id)))
  if (engine.length) await unsettleRecommendations(engine, changeSetId)
  const rows = (prefix: string) => ids.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length))
  try {
    const decisions = rows(HELD_PREFIX.autopilot)
    const proposals = rows(HELD_PREFIX.tracker)
    if (decisions.length) await (await import('../../advertising/autopilot/decisions.js')).noteDecisionsUndone(decisions, changeSetId)
    if (proposals.length) await (await import('../../advertising/kt6-proposal.service.js')).releaseProposalCommitments(proposals, changeSetId)
  } catch (error) {
    logger.warn('[ads-change-source] could not note an undo on the decisions or proposals a change carried out', { changeSetId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** The audit evidence of a write that carries a source out, on top of what the write already records. */
export function withSource(evidence: AdWriteEvidence | null | undefined, source: AdChangeSource | null): AdWriteEvidence | null {
  if (!source) return evidence ?? null
  return { ...(evidence ?? {}), source: { kind: source.kind, id: source.id } }
}

/** The facts a stored preview froze (`sourceFacts`, on the preview itself or on its rows' lines). */
function frozenFacts(preview: unknown): SourceFact[] {
  const facts = (preview as { sourceFacts?: unknown } | null | undefined)?.sourceFacts
  return Array.isArray(facts) ? facts.filter((f): f is SourceFact => !!f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string') : []
}

/**
 * After the write ran — the one settle hook: each recommendation it carried out is settled under the request it ran
 * as; W4-9 — each autopilot decision and Keyword Tracker proposal is marked APPLIED, naming the request (one source per
 * write: a bulk change's rows count the bids each wrote). `approvedPreview`: the preview the person approved, whose
 * frozen facts settle a decision the plan's tick replaced meanwhile. `by`: the approver (`user:<id>`). Never throws —
 * the change ran, and a settle that failed only means the feed or the tab may offer it again.
 */
export async function settleSources(
  sources: ReadonlyArray<AdChangeSource | null | undefined>,
  approvalId: string | undefined,
  opts: { approvedPreview?: unknown; by?: string | null } = {},
): Promise<number> {
  const given = sources.filter((s): s is AdChangeSource => !!s)
  if (!given.length || !approvalId) return 0
  const recommendationIds = given.filter((s) => s.kind === 'recommendation').map((s) => s.id)
  const writes = new Map<string, number>()
  for (const s of given.filter((x) => isHeld(x.kind))) writes.set(s.id, (writes.get(s.id) ?? 0) + 1)
  let settled = 0
  try {
    if (recommendationIds.length) settled += await settleRecommendations(recommendationIds, approvalId)
    const decisionIds = [...writes.keys()].filter((id) => id.startsWith(HELD_PREFIX.autopilot))
    const proposalIds = [...writes.keys()].filter((id) => id.startsWith(HELD_PREFIX.tracker))
    if (decisionIds.length) {
      const m = await import('../../advertising/autopilot/decisions.js')
      const frozen = new Map(frozenFacts(opts.approvedPreview).filter((f) => f.kind === 'autopilot').map((f) => [f.id, (f as Extract<SourceFact, { kind: 'autopilot' }>).decision]))
      const now = await m.decisionFacts(decisionIds.map((id) => id.slice(HELD_PREFIX.autopilot.length)))
      const carried = decisionIds
        .map((id) => ({ facts: frozen.get(id) ?? now.get(id.slice(HELD_PREFIX.autopilot.length)), targets: writes.get(id) }))
        .filter((c): c is { facts: DecisionFacts; targets: number } => !!c.facts)
      settled += await m.settleDecisionsCarried(carried, approvalId)
    }
    if (proposalIds.length) {
      const m = await import('../../advertising/kt6-proposal.service.js')
      settled += await m.settleProposalsCarried(proposalIds.map((id) => ({ id: id.slice(HELD_PREFIX.tracker.length), targets: writes.get(id) ?? 0 })), approvalId, opts.by ?? null)
    }
    return settled
  } catch (error) {
    logger.warn('[ads-change-source] could not settle what a change carried out', { approvalId, ids: given.length, error: error instanceof Error ? error.message : String(error) })
    return settled
  }
}
