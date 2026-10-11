/**
 * Negative Targeting page (2026-10-11) — the stop-waste rules' writes behind the RULES block of
 * routes/advertising-waste.routes.ts. Every one goes through the rules' own services and leaves their audit rows. Rules
 * are made and edited in the rule builder (POST/PATCH /advertising/automation-rules; wave 4, Owner 2026-10-11).
 *
 *   setWasteRulesMode  Off · Watch · Ask me · Auto for one or more rules, each through the level dial (setAdsRuleLevel:
 *                      the graduation ceiling — D1: a stop-waste kind may be Auto — and the gate's evidence)
 *   setWasteRuleArchived  archive (replaces delete) / restore. A Bid rule (a keyword pause rule is one) is archived by the
 *                      Bid page's own service; any other waste rule here, the same way: inert under ARCHIVED_ADS_DOMAIN at
 *                      Off, its waiting asks expired, its queued writes cancelled, runs and changes kept.
 * The pseudo-rows (brain, harvest) are refused: their own pages change them.
 */
import prisma from '../../../db.js'
import type { AdsActor } from '../ads-mutation.service.js'
import { ARCHIVED_ADS_DOMAIN, isBidRule } from '../bid-rules/pure.js'
import { findWasteRule, PSEUDO_ROWS } from './read.js'

const PSEUDO_REFUSAL = 'The brain and Harvest are shown here, never changed here: change them on their own pages.'

export type WriteAnswer<T> = { data: T } | { error: string; status: 400 | 404 | 409 }

const LEVEL_OF_MODE = { OFF: 'OFF', WATCH: 'OBSERVE', ASK: 'PROPOSE', AUTO: 'AUTO' } as const
export type PageMode = keyof typeof LEVEL_OF_MODE

/** POST /advertising/waste/rules/mode — each rule through the level dial; one refusal never stops the others. */
export async function setWasteRulesMode(ids: readonly string[], mode: PageMode, actor: AdsActor): Promise<{ data: { mode: PageMode; results: Array<{ id: string; ok: boolean; level?: string; error?: string }> } }> {
  const { setAdsRuleLevel } = await import('../ads-rule-crud.service.js')
  const { isRefused } = await import('../../automation/service-outcome.js')
  const results: Array<{ id: string; ok: boolean; level?: string; error?: string }> = []
  for (const id of [...new Set(ids)]) {
    if (PSEUDO_ROWS.has(id)) { results.push({ id, ok: false, error: PSEUDO_REFUSAL }); continue }
    const rule = await findWasteRule(id)
    if (!rule) { results.push({ id, ok: false, error: `No waste rule ${id} in this business.` }); continue }
    if (rule.domain === ARCHIVED_ADS_DOMAIN) { results.push({ id, ok: false, error: `${rule.name} is archived: restore it first.` }); continue }
    const out = await setAdsRuleLevel(id, LEVEL_OF_MODE[mode], actor)
    if (isRefused(out)) {
      const b = out.body as { message?: unknown; error?: unknown }
      results.push({ id, ok: false, error: String(b.message ?? b.error ?? 'refused') })
    } else results.push({ id, ok: true, level: out.value.rule.autonomyLevel })
  }
  return { data: { mode, results } }
}

export interface ArchiveResult { id: string; name: string; archived: boolean; level: 'OFF'; already: boolean; expiredAsks: number; cancelledWrites: number }

/** POST /advertising/waste/rules/:id/archive | /unarchive. */
export async function setWasteRuleArchived(id: string, archived: boolean, actor: AdsActor): Promise<WriteAnswer<ArchiveResult>> {
  if (PSEUDO_ROWS.has(id)) return { error: PSEUDO_REFUSAL, status: 400 }
  const rule = await findWasteRule(id)
  if (!rule) return { error: `No waste rule ${id} in this business.`, status: 404 }
  // A keyword pause rule is a Bid rule too: the Bid page's own archive (it also ends the rule's inputs to the bid brain).
  if (isBidRule(rule.actions)) {
    const { setBidRuleArchived } = await import('../bid-rules/write.js')
    const out = await setBidRuleArchived(id, archived, actor)
    if ('error' in out) return { error: out.error, status: out.status }
    const { endedBrainInputs: _ended, ...rest } = out.data
    return { data: rest }
  }
  const base = { id: rule.id, name: rule.name, archived, level: 'OFF' as const, expiredAsks: 0, cancelledWrites: 0 }
  if ((rule.domain === ARCHIVED_ADS_DOMAIN) === archived) return { data: { ...base, already: true } }
  const before = { domain: rule.domain, enabled: rule.enabled, dryRun: rule.dryRun, autonomyLevel: rule.autonomyLevel }
  const after = { domain: archived ? ARCHIVED_ADS_DOMAIN : 'advertising', enabled: false, dryRun: true, autonomyLevel: 'OFF' }
  const now = new Date()
  const expiredAsks = await prisma.$transaction(async (tx) => {
    await tx.automationRule.update({ where: { id }, data: after })
    const expired = archived
      ? (await tx.adsRuleSuggestion.updateMany({ where: { ruleId: id, status: 'pending' }, data: { status: 'expired', decidedAt: now, decidedBy: 'system:archived' } })).count
      : 0
    await tx.advertisingActionLog.create({
      data: {
        userId: actor, actionType: archived ? 'archive_rule' : 'restore_rule', entityType: 'RULE', entityId: id,
        payloadBefore: before, payloadAfter: after, amazonResponseStatus: 'SUCCESS',
        evidence: { metric: 'operator_rule_edit', note: archived ? `${rule.name} archived (runs and changes kept; ${expired} waiting asks expired)` : `${rule.name} restored at Off` },
      },
    })
    return expired
  })
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
  return { data: { ...base, already: false, expiredAsks, cancelledWrites } }
}
