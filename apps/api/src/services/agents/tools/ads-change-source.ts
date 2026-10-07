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
 *   taken      autopilot on bulk-ad-bid-change (a BID decision's bids), set-campaign-budget (a BUDGET decision) and
 *              set-placement-multipliers (a PLACEMENT decision); tracker on bulk-ad-bid-change (the proposal's one bid on
 *              its targets) — the bid tool whose undo reverses through the action log, where the reversal is read. Any
 *              other tool refuses them (sourceRefusal).
 *   checked    against its row once the change's campaign is known (heldSources), exactly: a decision of this
 *              business, still waiting, of a plan that runs, of the module this change is, on this campaign, asking
 *              exactly this value (a BID decision: exactly the bids the plan's optimizer computes now, target for
 *              target); a proposal still waiting, its targets at its bid, re-checked as the Keyword Tracker re-checks one
 *              (its target set now, its spend ceiling — summed over the request's proposals). A row covering only some
 *              of a proposal's targets is taken, said, and does not settle it. In the request's own re-check (a person
 *              approving it, its run — by a person or by rule) an autopilot decision the plan's 15-minute tick replaced
 *              is carried out with the values frozen in the request, unless it was dismissed or decided meanwhile or
 *              its plan is off (its identity, frozen in the request's stored preview: decisionStateNow).
 *   kept       the preview names it (`sourceNote`) and freezes its facts (`sourceFacts`): what the person approves.
 *   settled    once the write ran — the one hook (settleSources): the decision is APPLIED with what the A.I. Bids tab
 *              reads (autopilot/decisions.ts settleDecisionsCarried) and the proposal APPLIED (kt6-proposal.service.ts
 *              settleProposalsCarried), each naming the request. An undo changes neither row: the reversal is read from
 *              the action log, as the Keyword Tracker reads its own.
 */
import { z } from 'zod'
import type { AdWriteEvidence } from '../../advertising/ads-evidence.js'
import { familyOfRecommendationId, isEngineFamily, settleRecommendations, unsettleRecommendations } from '../../advertising/ads-recommendation-mutes.service.js'
import type { DecisionFacts } from '../../advertising/autopilot/decisions.js'
import prisma from '../../../db.js'
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
const HELD_TOOLS = 'bulk-ad-bid-change (bids), set-campaign-budget or set-placement-multipliers'
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
    if (source.kind === 'tracker' && opts.held !== 'bid') return 'a Keyword Tracker proposal changes bids: it is carried out with bulk-ad-bid-change'
    return null
  }
  if (source.id !== expectedId) return `the source names recommendation ${source.id}, but this change carries out ${expectedId}`
  return null
}

/** What the preview freezes about a held source: what the person approves, and what settles its row once it ran. */
export type SourceFact =
  | { kind: 'autopilot'; id: string; decision: DecisionFacts }
  | { kind: 'tracker'; id: string; proposal: { id: string; term: string; marketplace: string; requestedBidCents: number; targets: number }; covers: { targets: number; of: number } }

/** The change a held source rides on, as its row is checked against it: one per write (a bulk change: one per row). */
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
 * The previews a request stored for this tool (its own, or its plan's steps of this tool): what the person approved,
 * as the approve re-check and the run read them (they are handed only the request's id). Read only.
 */
export async function requestPreviews(approvalId: string, toolName: string): Promise<unknown[]> {
  const [single, steps] = await Promise.all([
    prisma.agentApproval.findFirst({ where: { id: approvalId, toolName }, select: { preview: true } }),
    prisma.agentPlanStep.findMany({ where: { approvalId, toolName }, select: { preview: true } }),
  ])
  return [...(single ? [single.preview] : []), ...steps.map((s) => s.preview)]
}

/** The facts a stored preview froze (`sourceFacts`). */
function frozenFacts(previews: readonly unknown[]): SourceFact[] {
  return previews.flatMap((preview) => {
    const facts = (preview as { sourceFacts?: unknown } | null | undefined)?.sourceFacts
    return Array.isArray(facts) ? facts.filter((f): f is SourceFact => !!f && typeof f === 'object' && typeof (f as { id?: unknown }).id === 'string') : []
  })
}

const sameBids = (a: ReadonlyMap<string, number | undefined>, b: ReadonlyMap<string, number>) => a.size === b.size && [...b].every(([t, v]) => a.get(t) === v)

/**
 * W4-9 — the rows behind these sources, against what each change does: the facts the preview freezes, or every reason
 * the change may not carry them out. Read only. `approvalId` (the request's own re-check: a person approving it, or its
 * run — ToolContext.approvalId): an autopilot decision whose row the plan's 15-minute tick replaced is carried out with
 * the values frozen in the request, unless its identity (frozen in the request's stored preview) was dismissed or
 * decided since, or its plan is off; a BID decision's bids were matched to the optimizer when the request was made, and
 * are not computed again. `tool`: the change tool, whose stored previews hold the frozen facts.
 */
export async function heldSources(
  items: ReadonlyArray<{ source: AdChangeSource | null; subject: HeldSubject }>,
  opts: { approvalId?: string | null; tool: string },
): Promise<{ refusal: string } | { facts: SourceFact[] }> {
  const held = items.filter((i): i is { source: AdChangeSource; subject: HeldSubject } => !!i.source && isHeld(i.source.kind))
  if (!held.length) return { facts: [] }
  const recheck = !!opts.approvalId
  const bySource = new Map<string, { source: AdChangeSource; subjects: HeldSubject[] }>()
  for (const i of held) {
    const entry = bySource.get(i.source.id) ?? { source: i.source, subjects: [] }
    entry.subjects.push(i.subject)
    bySource.set(i.source.id, entry)
  }
  const sources = [...bySource.values()]
  const decisionIds = sources.filter((g) => g.source.kind === 'autopilot').map((g) => rowIdOf(g.source))
  const proposalIds = sources.filter((g) => g.source.kind === 'tracker').map((g) => rowIdOf(g.source))
  const decisions = decisionIds.length ? await import('../../advertising/autopilot/decisions.js') : null
  const kt = proposalIds.length ? await import('../../advertising/kt6-proposal.service.js') : null
  const [rows, proposals, frozen] = await Promise.all([
    decisions ? decisions.decisionFacts(decisionIds) : new Map<string, DecisionFacts>(),
    kt ? kt.proposalFacts(proposalIds) : new Map(),
    recheck && decisionIds.length ? requestPreviews(opts.approvalId!, opts.tool).then(frozenFacts) : Promise.resolve([] as SourceFact[]),
  ])
  const problems: string[] = []
  const facts: SourceFact[] = []
  const waiting: Array<Parameters<NonNullable<typeof kt>['recheckProposals']>[0][number]> = []
  for (const { source, subjects } of sources) {
    const id = rowIdOf(source)
    const subject = subjects[0]
    if (source.kind === 'autopilot') {
      const d = rows.get(id)
      if (!d) {
        // The tick replaced it: the request carries out what it froze — unless the decision was dismissed or decided
        // since, or its plan is off. A fresh request needs it waiting now.
        const was = frozen.find((f): f is Extract<SourceFact, { kind: 'autopilot' }> => f.kind === 'autopilot' && f.id === source.id)
        if (!recheck || !was) { problems.push(`${source.id}: no such autopilot decision waits in this business — a plan replaces its proposals every 15 minutes: read ad-recommendations again`); continue }
        const now = await decisions!.decisionStateNow(was.decision)
        if (!now.planOn) problems.push(`${source.id}: its plan${was.decision.planName ? ` "${was.decision.planName}"` : ''} is off, so its proposals are stale`)
        else if (now.state === 'dismissed') problems.push(`${source.id}: no longer waiting — it was dismissed`)
        else if (now.state === 'decided') problems.push(`${source.id}: no longer waiting — the plan's next run decided it (${(now.status ?? '').toLowerCase()})`)
        else facts.push(was)
        continue
      }
      const asked = d.module === 'budget' ? cents(d.after) : null
      if (d.source !== 'autopilot') problems.push(`${source.id}: a rule's suggestion shown in the plan's feed: decide it with its rule: id`)
      else if (d.status !== 'PROPOSED') problems.push(`${source.id}: no longer waiting — ${d.status === 'DISMISSED' ? 'it was dismissed' : `it is ${d.status.toLowerCase()}`}`)
      else if (!d.planOn) problems.push(`${source.id}: its plan${d.planName ? ` "${d.planName}"` : ''} is off, so its proposals are stale`)
      else if (d.module !== subject.change) problems.push(`${source.id}: a ${d.module} decision, but this change sets a ${WHAT[subject.change]}`)
      else if (subjects.some((s) => s.campaignId !== d.campaignId)) problems.push(`${source.id}: it decides campaign ${d.campaignId ?? '(none)'}, not ${subjects.find((s) => s.campaignId !== d.campaignId)!.campaignId}`)
      else if (subject.change === 'budget' && asked !== subject.valueCents) problems.push(`${source.id}: it decides a daily budget of ${asked == null ? '(none)' : money(asked)}, not ${money(subject.valueCents ?? 0)}`)
      else if (subject.change === 'placement' && (!subject.placement?.onlyTopOfSearch || subject.placement.toPct !== decidedTopOfSearchPct(d.after, subject.placement.fromPct))) {
        problems.push(`${source.id}: it moves top of search only, from ${subject.placement?.fromPct ?? 0} % to ${decidedTopOfSearchPct(d.after, subject.placement?.fromPct ?? 0)} %`)
      } else if (subject.change === 'bid' && !recheck) {
        // A bid decision names no target: it is the bids the plan's optimizer computes now, every one of them, exactly.
        const planned = await decisions!.decisionBidChanges(d)
        const want = new Map((planned?.changes ?? []).map((c) => [c.targetId, c.proposedBidCents]))
        const got = new Map(subjects.map((s) => [s.targetId ?? '', s.valueCents]))
        if (!want.size) problems.push(`${source.id}: at the plan's target the bid optimizer finds no bid to move in its campaign now`)
        else if (!sameBids(got, want)) problems.push(`${source.id}: it is these ${want.size} bids, exactly: ${[...want].slice(0, 10).map(([t, v]) => `${t} → ${money(v)}`).join(', ')}${want.size > 10 ? ' …' : ''} (apply-ad-recommendations asks for them)`)
        else facts.push({ kind: 'autopilot', id: source.id, decision: d })
      } else facts.push({ kind: 'autopilot', id: source.id, decision: d })
      continue
    }
    const p = proposals.get(id)
    const outside = subjects.filter((s) => !s.targetId || !p?.targetIds.includes(s.targetId))
    if (!p) problems.push(`${source.id}: no such Keyword Tracker proposal in this business`)
    else if (p.status !== 'PROPOSED') problems.push(`${source.id}: no longer waiting — it is ${p.status.toLowerCase()}`)
    else if (outside.length) problems.push(`${source.id}: it does not name target ${outside.map((s) => s.targetId ?? '(none)').join(', ')}`)
    else if (subjects.some((s) => s.valueCents !== p.requestedBidCents)) problems.push(`${source.id}: it asks for a bid of ${money(p.requestedBidCents)} on its targets, not ${money(subjects.find((s) => s.valueCents !== p.requestedBidCents)!.valueCents ?? 0)}`)
    else {
      waiting.push(p)
      const covered = new Set(subjects.map((s) => s.targetId)).size
      facts.push({ kind: 'tracker', id: source.id, proposal: { id: p.id, term: p.term, marketplace: p.marketplace, requestedBidCents: p.requestedBidCents, targets: p.targetIds.length }, covers: { targets: covered, of: p.targetIds.length } })
    }
  }
  // The Keyword Tracker's own re-checks, as its apply makes them before it writes: the target set now, and the ceiling —
  // over every proposal this change carries out together.
  if (waiting.length && kt) for (const [pid, why] of await kt.recheckProposals(waiting)) if (why) problems.push(`kt:${pid}: ${why}`)
  if (problems.length) return { refusal: [...new Set(problems)].join('; ') }
  return { facts }
}

/** What the preview says about a held source, for the person approving. */
function heldNote(source: AdChangeSource, fact: SourceFact | undefined): string {
  if (fact?.kind === 'autopilot') {
    const d = fact.decision
    return `From the autopilot plan${d.planName ? ` "${d.planName}"` : ''}: its decision ${fact.id} (${d.action} — ${d.reason}). Once this runs the decision is marked applied on the A.I. Bids tab, naming this request.`
  }
  if (fact?.kind === 'tracker') {
    const p = fact.proposal
    const all = fact.covers.targets === fact.covers.of
    return `From the Keyword Tracker proposal ${fact.id}: "${p.term}" in ${p.marketplace} at ${money(p.requestedBidCents)} on ${p.targets} target${p.targets === 1 ? '' : 's'}.`
      + (all ? ' Once this runs the proposal is marked applied, naming this request.' : ` This change sets ${fact.covers.targets} of its ${fact.covers.of} targets, so the proposal stays waiting: it is marked applied only by a change that sets all of them.`)
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
 * the request it ran as, `before.changeSetId`) are offered again at once. A person's mute stays. W4-9 — an autopilot
 * decision or a Keyword Tracker proposal it carried out stays APPLIED: the reversal is read from the action log.
 */
export async function unsettleChange(change: ToolChange): Promise<void> {
  const before = (change.before ?? {}) as { sources?: unknown; changeSetId?: unknown }
  const ids = Array.isArray(before.sources) ? before.sources.filter((id): id is string => typeof id === 'string' && isEngineFamily(familyOfRecommendationId(id))) : []
  if (ids.length && typeof before.changeSetId === 'string') await unsettleRecommendations(ids, before.changeSetId)
}

/** The audit evidence of a write that carries a source out, on top of what the write already records. */
export function withSource(evidence: AdWriteEvidence | null | undefined, source: AdChangeSource | null): AdWriteEvidence | null {
  if (!source) return evidence ?? null
  return { ...(evidence ?? {}), source: { kind: source.kind, id: source.id } }
}

/** What one write left behind (its action-log row, its queue row), beside the source it carried out. */
export interface WriteReceipt { actionLogId?: string | null; outboundQueueId?: string | null }

/**
 * After the write ran — the one settle hook: each recommendation it carried out is settled under the request it ran
 * as; W4-9 — each autopilot decision and Keyword Tracker proposal is marked APPLIED, naming the request. `sources` holds
 * one entry per write (null for a write that carried nothing out), `receipts` the same writes' action-log and queue
 * rows. `approvedPreview`: the preview the person approved, whose frozen facts settle a decision the plan's tick
 * replaced meanwhile, and say whether the change set all of a proposal's targets (only then is it settled). `by`: the
 * approver's id (a proposal records it as KT.7 does). Never throws — the change ran, and a settle that failed only means
 * the feed or the tab may offer it again.
 */
export async function settleSources(
  sources: ReadonlyArray<AdChangeSource | null | undefined>,
  approvalId: string | undefined,
  opts: { approvedPreview?: unknown; by?: string | null; receipts?: ReadonlyArray<WriteReceipt | null | undefined> } = {},
): Promise<number> {
  const given = sources.filter((s): s is AdChangeSource => !!s)
  if (!given.length || !approvalId) return 0
  const recommendationIds = given.filter((s) => s.kind === 'recommendation').map((s) => s.id)
  const writes = new Map<string, number[]>()
  sources.forEach((s, i) => { if (s && isHeld(s.kind)) writes.set(s.id, [...(writes.get(s.id) ?? []), i]) })
  const frozen = frozenFacts([opts.approvedPreview])
  let settled = 0
  try {
    if (recommendationIds.length) settled += await settleRecommendations(recommendationIds, approvalId)
    const decisionIds = [...writes.keys()].filter((id) => id.startsWith(HELD_PREFIX.autopilot))
    const proposalIds = [...writes.keys()].filter((id) => id.startsWith(HELD_PREFIX.tracker))
    if (decisionIds.length) {
      const m = await import('../../advertising/autopilot/decisions.js')
      const was = new Map(frozen.filter((f): f is Extract<SourceFact, { kind: 'autopilot' }> => f.kind === 'autopilot').map((f) => [f.id, f.decision]))
      const now = await m.decisionFacts(decisionIds.map((id) => id.slice(HELD_PREFIX.autopilot.length)))
      // The request changed nothing else (one step, every write this decision's): the tab may offer its own Undo.
      const steps = await prisma.agentPlanStep.count({ where: { approvalId } })
      const carried = decisionIds.flatMap((id) => {
        const facts = was.get(id) ?? now.get(id.slice(HELD_PREFIX.autopilot.length))
        if (!facts) return []
        const own = writes.get(id)!
        const receipts = own.map((i) => opts.receipts?.[i]).filter((r): r is WriteReceipt => !!r)
        return [{
          facts, targets: own.length,
          actionLogId: receipts.find((r) => r.actionLogId)?.actionLogId ?? null,
          outboundQueueId: own.length === 1 ? receipts[0]?.outboundQueueId ?? null : null,
          alone: steps <= 1 && sources.every((s) => s?.id === id),
        }]
      })
      settled += await m.settleDecisionsCarried(carried, approvalId)
    }
    if (proposalIds.length) {
      const m = await import('../../advertising/kt6-proposal.service.js')
      // Only a change that set every one of a proposal's targets carries it out.
      const whole = proposalIds.filter((id) => frozen.some((f) => f.kind === 'tracker' && f.id === id && f.covers.targets === f.covers.of))
      settled += await m.settleProposalsCarried(whole.map((id) => ({ id: id.slice(HELD_PREFIX.tracker.length), targets: writes.get(id)!.length })), approvalId, opts.by ?? null)
    }
    return settled
  } catch (error) {
    logger.warn('[ads-change-source] could not settle what a change carried out', { approvalId, ids: given.length, error: error instanceof Error ? error.message : String(error) })
    return settled
  }
}
