/**
 * R4 (MCP full control, part 06) — an eBay ads rule's life: create, edit, delete.
 *
 * Moved unchanged out of `routes/ebay-ads.routes.ts` (POST /ebay-ads/automation/rules, POST …/rules/:id,
 * DELETE …/rules/:id) so Claude's rule tool (R9) saves through the same validation and the same version history. The
 * routes answer byte for byte as before (automation-routes-parity.vitest.test.ts).
 *
 * New here: every create, edit and delete leaves a `CampaignAction` row (channel EBAY, entity `RULE`, `create_rule` /
 * `update_rule` / `delete_rule`) naming the person and the rule before and after. The version table (ER5) records
 * config only; a switch on or off, a mode change and a delete were recorded nowhere. An audit row never fails the
 * change it describes.
 */
import type { EbayAdsRule } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { done, refused, type ServiceOutcome } from '../automation/service-outcome.js'
import type { RuleAction, RuleBody, RuleTrigger } from './ebay-ads-automation.service.js'

/** What a rule IS, for its audit rows. */
const AUDIT_KEYS = ['name', 'enabled', 'mode', 'marketplace', 'scope', 'trigger', 'action', 'guardrails', 'cooldownHours', 'version'] as const
function config(rule: Partial<EbayAdsRule> | null, keys: readonly string[] = AUDIT_KEYS): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!rule) return out
  for (const key of keys) if (key in rule) out[key] = (rule as Record<string, unknown>)[key] ?? null
  return out
}

async function audit(actorUserId: string | null, actionType: string, ruleId: string, before: object, after: object): Promise<void> {
  await prisma.campaignAction.create({
    data: {
      userId: actorUserId, channel: 'EBAY', actionType, entityType: 'RULE', entityId: ruleId,
      payloadBefore: before as object, payloadAfter: { ...after, _mode: 'local' } as object, channelResponseStatus: 'SUCCESS',
    },
  }).catch((error: unknown) => logger.warn('[EBAY-RULE-AUDIT] audit row not written', { ruleId, actionType, error: String(error) }))
}

export interface EbayRuleCreateInput {
  name: string
  trigger: unknown
  action: unknown
  guardrails?: unknown
  scope?: unknown
  marketplace?: string | null
  cooldownHours?: number
}

/** A new eBay rule is born OFF and in PROPOSE, at version 1. */
export async function createEbayAdsRule(body: EbayRuleCreateInput, actorUserId: string | null): Promise<ServiceOutcome<EbayAdsRule>> {
  const auto = await import('./ebay-ads-automation.service.js')
  const errs = auto.validateRuleBody(body as Partial<RuleBody>)
  if (errs.length) return refused(400, { error: errs.join(' · ') })
  const row = await prisma.ebayAdsRule.create({ data: {
    name: body.name.trim(), enabled: false, mode: 'PROPOSE',
    trigger: body.trigger as object, action: body.action as object,
    guardrails: (body.guardrails ?? undefined) as object | undefined, scope: (body.scope ?? undefined) as object | undefined,
    marketplace: body.marketplace ?? null, cooldownHours: body.cooldownHours ?? 24,
  } })
  await auto.snapshotRuleVersion(row.id, 1, auto.ruleConfigOf(row), actorUserId) // ER5
  await audit(actorUserId, 'create_rule', row.id, {}, config(row))
  return done(row)
}

export interface EbayRuleUpdateInput {
  enabled?: boolean
  mode?: 'PROPOSE' | 'AUTOPILOT'
  name?: string
  trigger?: unknown
  action?: unknown
  guardrails?: unknown
  scope?: unknown
  marketplace?: string | null
  cooldownHours?: number
}

/**
 * ER3.2 — full edit: config fields validated against the merged rule; the original enabled/mode toggles keep their
 * exact semantics. ER5 — only a REAL config change makes a new version.
 */
export async function updateEbayAdsRule(id: string, b: EbayRuleUpdateInput, actorUserId: string | null): Promise<ServiceOutcome<EbayAdsRule>> {
  const rule = await prisma.ebayAdsRule.findUnique({ where: { id } })
  if (!rule) return refused(404, { error: 'rule not found' })
  const touchesConfig = b.name !== undefined || b.trigger !== undefined || b.action !== undefined || b.guardrails !== undefined || b.scope !== undefined || b.marketplace !== undefined || b.cooldownHours !== undefined
  const changedKeys = Object.keys(b).filter((key) => (b as Record<string, unknown>)[key] !== undefined && (AUDIT_KEYS as readonly string[]).includes(key))
  if (touchesConfig) {
    const auto = await import('./ebay-ads-automation.service.js')
    const merged = {
      name: b.name ?? rule.name,
      trigger: (b.trigger ?? rule.trigger) as RuleTrigger,
      action: (b.action ?? rule.action) as RuleAction,
      guardrails: (b.guardrails ?? rule.guardrails) as Record<string, unknown> | null,
      scope: (b.scope ?? rule.scope) as { campaignIds?: string[] } | null,
      marketplace: b.marketplace !== undefined ? b.marketplace : rule.marketplace,
      cooldownHours: b.cooldownHours ?? rule.cooldownHours,
    }
    const errs = auto.validateRuleBody(merged)
    if (errs.length) return refused(400, { error: errs.join(' · ') })
    // ER5 — version only REAL config changes (not no-op saves, not enabled/mode)
    // Part 06 fix — the version stores the name the rule stores (trimmed), and spaces alone are no config change.
    const mergedCfg = { name: merged.name.trim(), marketplace: merged.marketplace ?? null, scope: merged.scope ?? null, trigger: merged.trigger, action: merged.action, guardrails: merged.guardrails ?? null, cooldownHours: merged.cooldownHours }
    if (auto.ruleConfigChanged(auto.ruleConfigOf(rule), mergedCfg)) {
      const next = rule.version + 1
      const updated = await prisma.ebayAdsRule.update({ where: { id }, data: {
        ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
        ...(b.mode ? { mode: b.mode } : {}),
        name: merged.name.trim(), trigger: merged.trigger as object, action: merged.action as object,
        guardrails: (merged.guardrails ?? undefined) as object | undefined, scope: (merged.scope ?? undefined) as object | undefined,
        marketplace: merged.marketplace, cooldownHours: merged.cooldownHours, version: next,
      } })
      await auto.snapshotRuleVersion(rule.id, next, mergedCfg, actorUserId)
      await audit(actorUserId, 'update_rule', rule.id, config(rule, [...changedKeys, 'version']), config(updated, [...changedKeys, 'version']))
      return done(updated)
    }
  }
  const updated = await prisma.ebayAdsRule.update({ where: { id }, data: {
    ...(b.enabled !== undefined ? { enabled: b.enabled } : {}),
    ...(b.mode ? { mode: b.mode } : {}),
    ...(b.name !== undefined ? { name: b.name.trim() } : {}),
    ...(b.trigger !== undefined ? { trigger: b.trigger as object } : {}),
    ...(b.action !== undefined ? { action: b.action as object } : {}),
    ...(b.guardrails !== undefined ? { guardrails: b.guardrails as object } : {}),
    ...(b.scope !== undefined ? { scope: b.scope as object } : {}),
    ...(b.marketplace !== undefined ? { marketplace: b.marketplace } : {}),
    ...(b.cooldownHours !== undefined ? { cooldownHours: b.cooldownHours } : {}),
  } })
  if (changedKeys.length) await audit(actorUserId, 'update_rule', rule.id, config(rule, changedKeys), config(updated, changedKeys))
  return done(updated)
}

/** Executions cascade; proposals keep their ruleId (history survives); the audit row keeps what the rule was. */
export async function deleteEbayAdsRule(id: string, actorUserId: string | null): Promise<ServiceOutcome<{ ok: true }>> {
  const rule = await prisma.ebayAdsRule.findUnique({ where: { id } })
  if (!rule) return refused(404, { error: 'rule not found' })
  await prisma.ebayAdsRule.delete({ where: { id } }) // executions cascade; proposals keep ruleId (history survives)
  await audit(actorUserId, 'delete_rule', id, config(rule), {})
  return done({ ok: true as const })
}

/** R9 — an eBay rule as Claude's save-ad-rule reads and restores it (its undo puts exactly this back). Null when absent. */
export async function ebayRuleForSave(id: string): Promise<{
  id: string; name: string; enabled: boolean; mode: string; trigger: unknown; action: unknown; guardrails: unknown
  marketplace: string | null; campaignIds: string[] | null; cooldownHours: number; updatedAt: Date
} | null> {
  const rule = await prisma.ebayAdsRule.findUnique({ where: { id } })
  if (!rule) return null
  const ids = (rule.scope as { campaignIds?: unknown } | null)?.campaignIds
  return {
    id: rule.id, name: rule.name, enabled: rule.enabled, mode: rule.mode, trigger: rule.trigger, action: rule.action,
    guardrails: rule.guardrails, marketplace: rule.marketplace, campaignIds: Array.isArray(ids) ? ids.map(String) : null,
    cooldownHours: rule.cooldownHours, updatedAt: rule.updatedAt,
  }
}

/** R9 — eBay's own checks of a rule body (validateRuleBody), for a preview before anything is saved. */
export async function ebayRuleProblems(body: Partial<RuleBody>): Promise<string[]> {
  const auto = await import('./ebay-ads-automation.service.js')
  return auto.validateRuleBody(body)
}

// ── R11 — eBay proposals decided by Claude (decide-automation-suggestions) ────────────────────────────────

/** The dry run of eBay proposal decisions: found here, still PENDING, and never approving a removal or a re-activation. */
export async function planEbayProposalDecisions(decisions: Array<{ suggestionId: string; decide: 'apply' | 'dismiss' | 'restore' }>): Promise<{ ok: true; items: Array<Record<string, unknown>> } | { ok: false; error: string }> {
  const ids = [...new Set(decisions.map((d) => d.suggestionId))]
  if (ids.length !== decisions.length) return { ok: false, error: 'Each proposal may be named once.' }
  const rows = await prisma.ebayAdsProposal.findMany({ where: { id: { in: ids } } })
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length) return { ok: false, error: `eBay proposals not found in this business: ${missing.join(', ')} (not found).` }
  const { refusedActionsOf } = await import('../automation/no-pause.js')
  const problems: string[] = []
  for (const d of decisions) {
    const p = byId.get(d.suggestionId)!
    if (d.decide === 'restore') problems.push(`${p.kind} ${p.id}: an eBay proposal cannot be restored once decided`)
    if (p.status !== 'PENDING') problems.push(`${p.kind} ${p.id}: it is ${p.status}`)
    if (d.decide === 'apply') for (const refused of refusedActionsOf([p.kind])) problems.push(`${p.kind} ${p.id}: refused — ${refused.why}; dismiss it and use ${refused.instead}`)
  }
  if (problems.length) return { ok: false, error: `Not decided — ${problems.join('; ')}.` }
  return { ok: true, items: decisions.map((d) => { const p = byId.get(d.suggestionId)!; return { suggestionId: p.id, decide: d.decide, kind: p.kind, entity: p.entityRef, proposed: p.proposedAction, status: p.status } }) }
}

export async function applyEbayProposalDecisions(decisions: Array<{ suggestionId: string; decide: 'apply' | 'dismiss' | 'restore' }>, actorUserId: string | null): Promise<Array<{ suggestionId: string; decide: string; ok: boolean; status: string; detail: string | null }>> {
  const auto = await import('./ebay-ads-automation.service.js')
  const out = []
  for (const d of decisions) {
    const [r] = await auto.decideProposals(actorUserId, [d.suggestionId], d.decide === 'apply' ? 'approve' : 'reject')
    const now = await prisma.ebayAdsProposal.findUnique({ where: { id: d.suggestionId }, select: { status: true } })
    out.push({ suggestionId: d.suggestionId, decide: d.decide, ok: r.ok, status: now?.status ?? 'gone', detail: r.detail })
  }
  return out
}

export async function ebayProposalStatuses(ids: string[]): Promise<Array<{ id: string; status: string }>> {
  const rows = await prisma.ebayAdsProposal.findMany({ where: { id: { in: ids } }, select: { id: true, status: true } })
  const byId = new Map(rows.map((r) => [r.id, r.status]))
  return ids.map((id) => ({ id, status: byId.get(id) ?? 'gone' }))
}

// ── R12 — the eBay ads dial's halt, for stop-automation / resume-automation ────────────────────────────

/** The eBay dial's halt now, read without creating the row. */
export async function ebayHaltState(): Promise<{ halted: boolean; haltReason: string | null; basis: string | null }> {
  const row = await prisma.marketingAutomationState.findFirst({ where: { channel: 'EBAY' } })
  return { halted: row?.halted ?? false, haltReason: row?.haltReason ?? null, basis: row?.updatedAt.toISOString() ?? null }
}

/** Halt or resume eBay ads automation, as `POST /ebay-ads/automation/state` does, with a CampaignAction audit row. */
export async function setEbayHalt(halted: boolean, reason: string | null, actorUserId: string | null): Promise<void> {
  const { workspaceKey } = await import('@nexus/database/workspace-context')
  const before = await ebayHaltState()
  await prisma.marketingAutomationState.upsert({
    where: { workspace_channel: workspaceKey({ channel: 'EBAY' }) },
    create: { channel: 'EBAY', globalMode: 'OFF', halted, haltReason: halted ? reason ?? 'operator halt' : null, haltedBy: halted ? actorUserId ?? 'operator' : null },
    update: { halted, haltReason: halted ? reason ?? 'operator halt' : null, haltedBy: halted ? actorUserId ?? 'operator' : null },
  })
  await prisma.campaignAction.create({
    data: {
      userId: actorUserId, channel: 'EBAY', actionType: halted ? 'halt_automation' : 'resume_automation', entityType: 'AUTOMATION', entityId: 'ebay-ads',
      payloadBefore: { halted: before.halted }, payloadAfter: { halted, reason, _mode: 'local' }, channelResponseStatus: 'SUCCESS',
    },
  }).catch(() => { /* an audit row never fails the change it describes */ })
}
