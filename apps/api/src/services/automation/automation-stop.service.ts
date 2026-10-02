/**
 * R12 (MCP full control, part 06 §3) — stop and resume, per area: the brakes Claude may pull at once and a person
 * releases.
 *
 *   amazon-ads      the account ads halt (haltAutomation / resumeAutomation): every rule and gated engine stops writing
 *   ebay-ads        the eBay ads dial's halt
 *   agent-fleet     the fleet halt (haltFleet / resumeFleet)
 *   review-mailer   the review request mailer's pause (customer messages are never automated: pause, and a person resumes)
 *   rules           every enabled rule of one domain switched off (the emergency disable-all), the ids recorded so a
 *                   resume re-enables exactly those
 *
 * A stop is always inside its limits (it only lowers); a resume never is (after a breaker trip, a person decides).
 * Every move leaves its area's audit row. Nothing here writes an env value.
 */
import prisma from '../../db.js'
import { FEATURES } from '@nexus/shared/permissions'
import type { ToolPermission } from '../agents/tool-types.js'

export const STOP_AREAS = ['amazon-ads', 'ebay-ads', 'agent-fleet', 'review-mailer', 'rules'] as const
export type StopArea = (typeof STOP_AREAS)[number]
export const RULE_DOMAINS = ['replenishment', 'listings', 'marketing', 'bulk-operations', 'reviews', 'advertising'] as const
export type RuleDomain = (typeof RULE_DOMAINS)[number]

const AREA_NAME: Record<StopArea, string> = {
  'amazon-ads': 'Amazon ads automation', 'ebay-ads': 'eBay ads automation', 'agent-fleet': 'the agent fleet', 'review-mailer': 'the review request mailer', rules: 'rules',
}
const DOMAIN_MANAGE: Record<RuleDomain, ToolPermission> = {
  replenishment: FEATURES.replenishmentRun, listings: FEATURES.listingsEdit, marketing: FEATURES.marketingAutomationManage,
  'bulk-operations': FEATURES.productsBulkRun, reviews: FEATURES.reviewsManage, advertising: FEATURES.adsAutomationManage,
}

/** The permission a person needs to stop or resume this area. */
export function stopPermission(area: StopArea, domain: RuleDomain | undefined): ToolPermission {
  if (area === 'rules') return DOMAIN_MANAGE[domain ?? 'replenishment']
  return area === 'agent-fleet' ? FEATURES.aiRun : area === 'review-mailer' ? FEATURES.reviewsManage : FEATURES.adsAutomationManage
}

/** What a stop or resume changed: the area, and the halt or the rules it switched. */
export interface StopChange { area: StopArea; domain?: RuleDomain; halted?: boolean; ruleIds?: string[] }

interface AreaState { stopped: boolean; reason: string | null; basis: string | null; enabledRuleIds?: string[]; names?: string[] }

async function stateOf(area: StopArea, domain: RuleDomain, ruleIds?: string[]): Promise<AreaState> {
  if (area === 'amazon-ads') {
    const { readHaltState } = await import('../advertising/ads-automation-state.service.js')
    const s = await readHaltState()
    return { stopped: s.halted, reason: s.haltReason, basis: s.basis }
  }
  if (area === 'ebay-ads') {
    const { ebayHaltState } = await import('../marketing/ebay-ads-rule-crud.service.js')
    const s = await ebayHaltState()
    return { stopped: s.halted, reason: s.haltReason, basis: s.basis }
  }
  if (area === 'agent-fleet') {
    const row = await prisma.agentFleetState.findFirst()
    return { stopped: row?.halted ?? false, reason: row?.haltReason ?? null, basis: row?.updatedAt.toISOString() ?? null }
  }
  if (area === 'review-mailer') {
    const { findReviewMailerState } = await import('../reviews/review-mailer-state.service.js')
    const row = await findReviewMailerState()
    return { stopped: row?.isPaused ?? false, reason: row?.pausedReason ?? null, basis: row?.updatedAt?.toISOString() ?? null }
  }
  const rows = await prisma.automationRule.findMany({ where: { domain, enabled: true, ...(ruleIds ? { id: { in: ruleIds } } : {}) }, select: { id: true, name: true }, orderBy: { name: 'asc' } })
  return { stopped: rows.length === 0, reason: null, basis: null, enabledRuleIds: rows.map((r) => r.id), names: rows.map((r) => r.name) }
}

export interface StopPlan {
  action: 'stop-automation' | 'resume-automation'
  area: StopArea
  domain: RuleDomain | null
  changes: Record<string, { from: unknown; to: unknown }>
  ruleIds: string[] | null
  basis: string | null
  effect: string
}

/** Rule ids, when given, must be rules of this business (of the domain, for area rules): never another business's. */
async function checkRuleIds(area: StopArea, domain: RuleDomain, ruleIds: string[] | undefined): Promise<string | null> {
  if (!ruleIds?.length) return null
  const rows = await prisma.automationRule.findMany({ where: { id: { in: ruleIds } }, select: { id: true, name: true, domain: true } })
  const found = new Set(rows.map((r) => r.id))
  const missing = ruleIds.filter((id) => !found.has(id))
  if (missing.length) return `Rules not found in this business: ${missing.join(', ')} (not found).`
  if (area !== 'rules') return `ruleIds (${rows.map((r) => r.name).join(', ')}) name rules: they apply to area rules only.`
  const other = rows.filter((r) => r.domain !== domain)
  return other.length ? `${other.map((r) => r.name).join(', ')}: not ${domain} rules.` : null
}

export async function planStop(direction: 'stop' | 'resume', area: StopArea, domain: RuleDomain = 'replenishment', ruleIds?: string[], reason?: string): Promise<{ ok: true; plan: StopPlan } | { ok: false; error: string }> {
  const bad = await checkRuleIds(area, domain, ruleIds)
  if (bad) return { ok: false, error: bad }
  const name = area === 'rules' ? `the ${domain} rules` : AREA_NAME[area]
  if (area === 'rules') {
    if (direction === 'resume' && !ruleIds?.length) return { ok: false, error: 'Name the rules to switch back on (ruleIds): a resume re-enables exactly the rules a stop switched off.' }
    if (direction === 'stop') {
      const s = await stateOf(area, domain, ruleIds)
      if (!s.enabledRuleIds!.length) return { ok: false, error: `No ${domain} rule${ruleIds ? ' of those named' : ''} is switched on: nothing to stop.` }
      return { ok: true, plan: { action: 'stop-automation', area, domain, ruleIds: s.enabledRuleIds!, basis: null, changes: { enabledRules: { from: s.enabledRuleIds!.length, to: 0 } }, effect: `Switches off ${s.enabledRuleIds!.length} ${domain} rule(s): ${s.names!.join(', ')}. Their level is kept for when they are switched back on.` } }
    }
    const off = await prisma.automationRule.findMany({ where: { id: { in: ruleIds! }, domain, enabled: false }, select: { id: true, name: true } })
    if (!off.length) return { ok: false, error: 'Every rule named is already switched on: nothing to resume.' }
    return { ok: true, plan: { action: 'resume-automation', area, domain, ruleIds: off.map((r) => r.id), basis: null, changes: { enabledRules: { from: 0, to: off.length } }, effect: `Switches ${off.length} ${domain} rule(s) back on, each at the level it had: ${off.map((r) => r.name).join(', ')}.` } }
  }
  const s = await stateOf(area, domain)
  if (direction === 'stop' && s.stopped) return { ok: false, error: `${name} is already stopped${s.reason ? ` (${s.reason})` : ''}.` }
  if (direction === 'resume' && !s.stopped) return { ok: false, error: `${name} is not stopped: nothing to resume.` }
  return {
    ok: true,
    plan: {
      action: direction === 'stop' ? 'stop-automation' : 'resume-automation', area, domain: null, ruleIds: null, basis: s.basis,
      changes: { [area === 'review-mailer' ? 'paused' : 'halted']: { from: s.stopped, to: direction === 'stop' } },
      effect: direction === 'stop'
        ? `Stops ${name}${reason ? `: ${reason}` : ''}. Nothing it governs writes until a person resumes it.`
        : `Resumes ${name}${s.reason ? ` (stopped: ${s.reason})` : ''}. Its automations act again at their own levels.`,
    },
  }
}

export async function applyStop(direction: 'stop' | 'resume', area: StopArea, domain: RuleDomain = 'replenishment', ruleIds: string[] | undefined, reason: string | undefined, actorUserId: string | null): Promise<{ ok: true; plan: StopPlan; change: { before: StopChange; after: StopChange } } | { ok: false; error: string }> {
  const planned = await planStop(direction, area, domain, ruleIds, reason)
  if ('error' in planned) return planned
  const plan = planned.plan
  const by = `user:${actorUserId ?? 'anonymous'}`
  const why = reason ?? 'stopped by Claude'
  if (area === 'amazon-ads') {
    const state = await import('../advertising/ads-automation-state.service.js')
    if (direction === 'stop') await state.haltAutomation(why, by)
    else await state.resumeAutomation(by)
    await prisma.advertisingActionLog.create({
      data: { userId: by, actionType: direction === 'stop' ? 'halt_automation' : 'resume_automation', entityType: 'AUTOMATION', entityId: 'amazon-ads', payloadBefore: { halted: direction !== 'stop' }, payloadAfter: { halted: direction === 'stop', reason: direction === 'stop' ? why : null }, amazonResponseStatus: 'SUCCESS', evidence: { metric: 'operator_autonomy', note: `ads automation ${direction === 'stop' ? 'halted' : 'resumed'}` } },
    }).catch(() => { /* an audit row never fails the change */ })
  } else if (area === 'ebay-ads') {
    const { setEbayHalt } = await import('../marketing/ebay-ads-rule-crud.service.js')
    await setEbayHalt(direction === 'stop', why, actorUserId)
  } else if (area === 'agent-fleet') {
    const fleet = await import('../agent-fleet/fleet-state.service.js')
    if (direction === 'stop') await fleet.haltFleet(why, actorUserId)
    else await fleet.resumeFleet(actorUserId)
  } else if (area === 'review-mailer') {
    const mailer = await import('../reviews/review-mailer-state.service.js')
    if (direction === 'stop') await mailer.pauseReviewMailer({ reason: why, pausedBy: actorUserId })
    else await mailer.resumeReviewMailer()
  } else {
    await prisma.automationRule.updateMany({ where: { id: { in: plan.ruleIds! }, domain }, data: { enabled: direction === 'resume' } })
  }
  if (area !== 'amazon-ads' && area !== 'ebay-ads') {
    const { auditLogService } = await import('../audit-log.service.js')
    await auditLogService.write({ userId: actorUserId, entityType: 'Automation', entityId: area === 'rules' ? `rules:${domain}` : area, action: direction, before: plan.changes, after: { reason: direction === 'stop' ? why : null, ruleIds: plan.ruleIds } })
  }
  const base = { area, ...(area === 'rules' ? { domain } : {}) }
  const change = area === 'rules'
    ? { before: { ...base, ruleIds: plan.ruleIds!, halted: direction !== 'stop' }, after: { ...base, ruleIds: plan.ruleIds!, halted: direction === 'stop' } }
    : { before: { ...base, halted: direction !== 'stop' }, after: { ...base, halted: direction === 'stop' } }
  return { ok: true, plan, change }
}

/** What is stored now, in a change's shape (undo compares it with what the move left). */
export async function stopStateNow(change: StopChange): Promise<StopChange> {
  if (change.area === 'rules') {
    const rows = await prisma.automationRule.findMany({ where: { id: { in: change.ruleIds ?? [] } }, select: { enabled: true } })
    return { ...change, halted: rows.length > 0 && rows.every((r) => !r.enabled) }
  }
  const s = await stateOf(change.area, change.domain ?? 'replenishment')
  return { ...change, halted: s.stopped }
}
