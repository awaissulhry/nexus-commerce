/**
 * Bid page (2026-10-10) — POST /advertising/bid-rules/:id/archive and …/:id/unarchive: archive replaces delete on the page.
 *
 * Archive keeps everything the rule left behind — its runs (AutomationRuleExecution), its changes (the action log and the
 * bid history), its decided asks — and makes it inert and out of every list: the rule moves to ARCHIVED_ADS_DOMAIN
 * (pure.ts), which no evaluator, board, level dial or gate reads, at level Off (auto-undo still judges its changes). What
 * would otherwise keep acting for it is closed with it:
 *   · its asks still waiting expire (status `expired`, decided by `system:archived` — the Suggestions lifecycle's own
 *     state: an ask the rule makes again after a restore comes back as pending; approving one says it is archived);
 *   · its inputs to the bid brain (BidDirective rows `rule:<id>`, which steer the brain for up to 7 days) end now: their
 *     `until` is set to now, so the brain's loader skips them and the next write on their campaign prunes them — kept, not
 *     hard-deleted, so what it asked stays readable until then;
 *   · its writes still queued and not sent are cancelled through the queue's own cancel (cancelPendingMutation: Nexus's
 *     copy put back, the action log marked CANCELLED); a write already taken by the worker or past its hold is not.
 * Unarchive puts it back among the rules at level Off: nothing is armed again until a person picks a level.
 *
 * Both are idempotent (archiving an archived rule changes nothing and says so). The rule's change and its audit row
 * (`archive_rule` / `restore_rule`, entity RULE, naming the person and the rule before and after) are one transaction.
 */
import prisma from '../../../db.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { ARCHIVED_ADS_DOMAIN, isBidRule } from './pure.js'
import { BRAIN_ROW_ID } from './read.js'

export interface ArchiveResult {
  id: string
  name: string
  archived: boolean
  /** The level it has now (Off: archived, or restored and waiting for a person's pick). */
  level: 'OFF'
  /** Nothing changed: it already was in the state asked. */
  already: boolean
  /** Asks of this rule that were waiting and expired with the archive. */
  expiredAsks: number
  /** Inputs this rule had given the bid brain, ended with the archive. */
  endedBrainInputs: number
  /** Its writes still queued and not sent, cancelled with the archive. */
  cancelledWrites: number
}

export type ArchiveAnswer = { data: ArchiveResult } | { error: string; status: 400 | 404 }

export async function setBidRuleArchived(id: string, archived: boolean, actor: AdsActor): Promise<ArchiveAnswer> {
  if (id === BRAIN_ROW_ID) return { error: 'The brain is not a rule: it cannot be archived.', status: 400 }
  const rule = await prisma.automationRule.findUnique({
    where: { id },
    select: { id: true, name: true, domain: true, actions: true, enabled: true, dryRun: true, autonomyLevel: true },
  })
  if (!rule || (rule.domain !== 'advertising' && rule.domain !== ARCHIVED_ADS_DOMAIN) || !isBidRule(rule.actions)) {
    return { error: `No bid rule ${id} in this business.`, status: 404 }
  }
  const isArchived = rule.domain === ARCHIVED_ADS_DOMAIN
  const base = { id: rule.id, name: rule.name, archived, level: 'OFF' as const, expiredAsks: 0, endedBrainInputs: 0, cancelledWrites: 0 }
  if (isArchived === archived) return { data: { ...base, already: true } }

  const before = { domain: rule.domain, enabled: rule.enabled, dryRun: rule.dryRun, autonomyLevel: rule.autonomyLevel }
  const after = { domain: archived ? ARCHIVED_ADS_DOMAIN : 'advertising', enabled: false, dryRun: true, autonomyLevel: 'OFF' }
  const now = new Date()
  const done = await prisma.$transaction(async (tx) => {
    await tx.automationRule.update({ where: { id }, data: after })
    let expiredAsks = 0
    let endedBrainInputs = 0
    if (archived) {
      expiredAsks = (await tx.adsRuleSuggestion.updateMany({ where: { ruleId: id, status: 'pending' }, data: { status: 'expired', decidedAt: now, decidedBy: 'system:archived' } })).count
      endedBrainInputs = (await tx.bidDirective.updateMany({ where: { source: `rule:${id}`, OR: [{ until: null }, { until: { gt: now } }] }, data: { until: now } })).count
    }
    await tx.advertisingActionLog.create({
      data: {
        userId: actor, actionType: archived ? 'archive_rule' : 'restore_rule', entityType: 'RULE', entityId: id,
        payloadBefore: before, payloadAfter: after, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_rule_edit', note: archived ? `${rule.name} archived (runs and changes kept; ${expiredAsks} waiting asks expired, ${endedBrainInputs} brain inputs ended)` : `${rule.name} restored at Off` },
      },
    })
    return { expiredAsks, endedBrainInputs }
  })

  // Its writes still queued and not sent: each through the queue's own cancel, after the archive holds (a cancel never
  // fails the archive; a write the worker already took, or past its hold, is left to land and is judged like any other).
  let cancelledWrites = 0
  if (archived) {
    const queued = await prisma.advertisingActionLog.findMany({
      where: { userId: { in: [`automation:${id}`, `automation:automation:${id}`] }, amazonResponseStatus: 'PENDING', outboundQueueId: { not: null } },
      select: { outboundQueueId: true },
    })
    const { cancelPendingMutation } = await import('../ads-mutation.service.js')
    for (const queueId of new Set(queued.map((q) => q.outboundQueueId as string))) {
      const r = await cancelPendingMutation(queueId).catch(() => ({ ok: false }))
      if (r.ok) cancelledWrites++
    }
  }
  return { data: { ...base, already: false, ...done, cancelledWrites } }
}
