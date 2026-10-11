/**
 * Bid page R4 (2026-10-11) — POST /advertising/bid-rules/:id/asks/undo: undo approved asks of one rule, putting things back
 * as they were — never as a person's bid.
 *
 * An approved ask is the RULE's decision a person agreed to: its write carries the rule's actor, automation:<ruleId>
 * (ads-suggestion-decide.service.ts applySuggestion). Its undo is the rule's too (lead decision R4):
 *   · a write               the value it replaced goes back through the normal write path as the rule
 *                           (rollback.service.ts reverseRuleWrite: the write gate asked first, the undo marked
 *                           `evidence.undoOf`, the write marked undone). It is no person's write: no BidHold (the brain does
 *                           not leave the keyword for 60 days), not a person's bid of the last 60 days (personBidTargetIds),
 *                           never "You" as the owner. The write and its undo fold out of "who sets it" and the 7-day counts
 *                           (bid-owner.ts withoutUndonePairs): the owner is again the one before the approval.
 *   · a brain input (BB-9)  on a campaign the brain runs, the approval stored the rule's ask as a BidDirective, never a
 *                           write: that row ends now (its `until`), as archive ends them. Nothing goes to Amazon.
 *   · nothing changed       the approval found the value already in place: nothing to put back.
 * Refused per ask, with the reason, and nothing written: not this rule's ask, not approved, no write of it found, older than
 * the undo window, a later change on the keyword since (the old value would overwrite it), the largest change of one step
 * holds the way back, or the write gate refuses it now (ads halted, a locked campaign, the brain runs the campaign now …).
 *
 * Then the ask waits again — pending, as reject's restore puts a rejected one back — unless it is too old to wait (its
 * rule's expiry window since the rule last asked it, ads-suggestions.service.ts expiryWindowMs) or its rule is archived: it
 * then expires (the lifecycle's own state; the rule asking again brings it back), and the answer says so. A refused ask
 * stays approved. Who clicked is in the write's reason and in one audit row of the rule (`undo_rule_asks`, as archive's).
 */
import prisma from '../../../db.js'
import { expiryWindowMs } from '../ads-suggestions.service.js'
import { ARCHIVED_ADS_DOMAIN, isBidRule } from './pure.js'
import { BRAIN_ROW_ID, ruleActors } from './read.js'

export interface AskUndoResult {
  suggestionId: string
  /** The value is back as it was before the approval (or the approval had changed nothing). */
  restored: boolean
  /** The ask waits again (pending). */
  reopened: boolean
  /** Why not, or what happened besides the plain case, in one line; null for a write put back and an ask waiting again. */
  reason: string | null
}

export interface AskUndoAnswer { results: AskUndoResult[]; undone: number; reopened: number }
export type AskUndoOutcome = { data: AskUndoAnswer } | { error: string; status: 400 | 404 }

/** An approval's write is looked for this long around its decision (ads-suggestions.service.ts attachDeliveryData). */
const MATCH_BEFORE_MS = 60_000
const MATCH_AFTER_MS = 60_000

/** The write gate's one-writer refusal on a campaign the brain runs (ads-write-gate.ts brainOwnedRefusal), in the page's words. */
const BRAIN_RUNS = /is run by the bid brain \(one writer per campaign\)/
const BRAIN_RUNS_WORDS = 'The brain runs this campaign now and sets its bids, so the rule\'s change is not put back. Nothing was written.'

const STATUS_WORD: Readonly<Record<string, string>> = { pending: 'still waiting', dismissed: 'rejected', expired: 'expired' }

type Ask = {
  id: string
  ruleId: string
  status: string
  entityType: string
  entityId: string
  appliedResult: unknown
  decidedAt: Date | null
  lastSeenAt: Date
}

type Rule = { id: string; name: string; domain: string; actions: unknown }

/** What the approval did, from its stored result: a brain input, nothing, or a write (its queue row, if it names one). */
function approvalOutput(a: Ask): { brainInput: { campaignId: string; sample: Array<{ targetId: string | null; lane: string | null; kind: string }> } | null; noChange: boolean; queueId: string | null } {
  const out = ((a.appliedResult as { output?: Record<string, unknown> } | null)?.output ?? {}) as Record<string, unknown>
  const brain = out.bidBrain as { stored?: unknown; sample?: unknown } | undefined
  const brainInput = brain && typeof brain === 'object' && typeof brain.stored === 'string' && typeof out.campaignId === 'string'
    ? { campaignId: out.campaignId, sample: (Array.isArray(brain.sample) ? brain.sample : []) as Array<{ targetId: string | null; lane: string | null; kind: string }> }
    : null
  return { brainInput, noChange: out.noChange === true, queueId: typeof out.outboundQueueId === 'string' ? out.outboundQueueId : null }
}

/** The approval's write: the rule's action log row on its queue row, else the rule's row on the ask's entity nearest the decision. */
async function approvalWrite(a: Ask, queueId: string | null): Promise<string | null> {
  const actors = ruleActors(a.ruleId)
  if (queueId) {
    const hit = await prisma.advertisingActionLog.findFirst({ where: { outboundQueueId: queueId, userId: { in: actors } }, select: { id: true } })
    if (hit) return hit.id
  }
  if (!a.decidedAt) return null
  const t = a.decidedAt.getTime()
  const near = await prisma.advertisingActionLog.findMany({
    where: { entityId: a.entityId, userId: { in: actors }, createdAt: { gte: new Date(t - MATCH_BEFORE_MS), lte: new Date(t + MATCH_AFTER_MS) } },
    select: { id: true, createdAt: true },
  })
  near.sort((x, y) => Math.abs(x.createdAt.getTime() - t) - Math.abs(y.createdAt.getTime() - t))
  return near[0]?.id ?? null
}

/** Put back what one approved ask did. */
async function putBack(a: Ask, person: string, now: Date): Promise<{ restored: boolean; reason: string | null }> {
  const did = approvalOutput(a)
  if (did.brainInput) {
    // The rule's input this approval stored (same campaign, rule, keyword or lane and kind), still open, made by it.
    const t = a.decidedAt?.getTime() ?? now.getTime()
    const keys = did.brainInput.sample
    const open = await prisma.bidDirective.findMany({
      where: {
        campaignId: did.brainInput.campaignId, source: `rule:${a.ruleId}`, OR: [{ until: null }, { until: { gt: now } }],
        createdAt: { gte: new Date(t - MATCH_BEFORE_MS), lte: new Date(t + MATCH_AFTER_MS) },
      },
      select: { id: true, targetId: true, lane: true, kind: true },
    })
    const mine = keys.length ? open.filter((d) => keys.some((k) => k.targetId === d.targetId && k.lane === d.lane && k.kind === d.kind)) : open
    if (!mine.length) return { restored: false, reason: 'Its input to the brain has ended, or a newer ask of the rule replaced it: nothing to put back.' }
    await prisma.bidDirective.updateMany({ where: { id: { in: mine.map((d) => d.id) } }, data: { until: now } })
    return { restored: true, reason: 'Its input to the brain ended: the brain no longer reads it. Nothing had been sent to Amazon.' }
  }
  if (did.noChange) return { restored: true, reason: 'The approval changed nothing, so nothing had to be put back.' }
  const write = await approvalWrite(a, did.queueId)
  if (!write) return { restored: false, reason: 'Nexus found no change of this approval to put back.' }
  const { reverseRuleWrite } = await import('../rollback.service.js')
  const r = await reverseRuleWrite({ actionLogId: write, ruleId: a.ruleId, reason: `Undo: approved ask ${a.id} put back as the rule, by ${person}`, now })
  if ('reason' in r) return { restored: false, reason: BRAIN_RUNS.test(r.reason) ? BRAIN_RUNS_WORDS : r.reason }
  return { restored: true, reason: r.nothing ?? null }
}

const CHANGED_MEANWHILE = 'The ask changed meanwhile, so it was left as it is.'

/** The ask after its value is back: waiting again, or expired when it is too old to wait or its rule is archived. */
async function reopen(a: Ask, rule: Rule, now: Date): Promise<{ reopened: boolean; reason: string | null }> {
  const archived = rule.domain === ARCHIVED_ADS_DOMAIN
  const windowMs = expiryWindowMs(rule)
  const stale = a.lastSeenAt.getTime() + windowMs <= now.getTime()
  if (archived || stale) {
    const done = await prisma.adsRuleSuggestion.updateMany({ where: { id: a.id, status: 'applied' }, data: { status: 'expired', decidedAt: now, decidedBy: archived ? 'system:archived' : 'system:stale' } })
    if (!done.count) return { reopened: false, reason: CHANGED_MEANWHILE }
    return {
      reopened: false,
      reason: archived
        ? 'The rule is archived, so the ask does not wait again: it expired.'
        : `The rule last asked this more than ${Math.round(windowMs / 86_400_000)} days ago, so the ask does not wait again: it expired. If it still holds, the rule asks again.`,
    }
  }
  const done = await prisma.adsRuleSuggestion.updateMany({ where: { id: a.id, status: 'applied' }, data: { status: 'pending', decidedAt: null, decidedBy: null } })
  return done.count ? { reopened: true, reason: null } : { reopened: false, reason: CHANGED_MEANWHILE }
}

/**
 * Undo these approved asks of rule `ruleId`, one after another (two asks may touch one keyword). `person`: who clicked
 * (`user:<id>`), for the write's reason and the audit row; the writes are the rule's.
 */
export async function undoApprovedAsks(ruleId: string, suggestionIds: readonly string[], person: string, opts: { now?: Date } = {}): Promise<AskUndoOutcome> {
  if (ruleId === BRAIN_ROW_ID) return { error: 'The brain asks nothing: it has no approved asks to undo.', status: 400 }
  const rule = await prisma.automationRule.findUnique({ where: { id: ruleId }, select: { id: true, name: true, domain: true, actions: true } })
  if (!rule || (rule.domain !== 'advertising' && rule.domain !== ARCHIVED_ADS_DOMAIN) || !isBidRule(rule.actions)) {
    return { error: `No bid rule ${ruleId} in this business.`, status: 404 }
  }
  const ids = [...new Set(suggestionIds)]
  const found = await prisma.adsRuleSuggestion.findMany({
    where: { id: { in: ids } },
    select: { id: true, ruleId: true, status: true, entityType: true, entityId: true, appliedResult: true, decidedAt: true, lastSeenAt: true },
  })
  const byId = new Map(found.map((s) => [s.id, s as Ask]))
  const results: AskUndoResult[] = []
  for (const id of ids) {
    const now = opts.now ?? new Date()
    const a = byId.get(id)
    if (!a) { results.push({ suggestionId: id, restored: false, reopened: false, reason: 'No such ask in this business.' }); continue }
    if (a.ruleId !== ruleId) { results.push({ suggestionId: id, restored: false, reopened: false, reason: 'This ask is another rule\'s.' }); continue }
    if (a.status !== 'applied') {
      results.push({ suggestionId: id, restored: false, reopened: false, reason: `This ask is ${STATUS_WORD[a.status] ?? a.status}, not approved: nothing to undo.` })
      continue
    }
    const back = await putBack(a, person, now)
    if (!back.restored) { results.push({ suggestionId: id, restored: false, reopened: false, reason: back.reason }); continue }
    const again = await reopen(a, rule as Rule, now)
    // What happened to the value (put back, or why nothing had to be), then what became of the ask when it does not wait again.
    const reason = [back.reason ?? (again.reason ? 'Put back.' : null), again.reason].filter(Boolean).join(' ') || null
    results.push({ suggestionId: id, restored: true, reopened: again.reopened, reason })
  }
  const undone = results.filter((r) => r.restored).length
  const reopened = results.filter((r) => r.reopened).length
  if (undone) {
    await prisma.advertisingActionLog.create({
      data: {
        userId: person, actionType: 'undo_rule_asks', entityType: 'RULE', entityId: ruleId,
        payloadBefore: { applied: results.filter((r) => r.restored).map((r) => r.suggestionId) },
        payloadAfter: { results: results.map((r) => ({ id: r.suggestionId, restored: r.restored, reopened: r.reopened })) },
        amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_rule_edit', note: `${rule.name}: ${undone} approved ask${undone === 1 ? '' : 's'} put back as the rule, ${reopened} waiting again` },
      },
    })
  }
  return { data: { results, undone, reopened } }
}
