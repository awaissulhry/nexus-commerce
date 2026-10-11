/**
 * Negative Targeting page (2026-10-11) — the stop-waste rules' writes behind the RULES block of
 * routes/advertising-waste.routes.ts. Every one goes through the rules' own services and leaves their audit rows.
 *
 *   saveWasteRule      create a stop-waste rule from a body (one of the two starters, PLAN §2 defaults, or edited), or
 *                      edit one: the engine rule `ruleOfBody` makes, through ads-rule-crud's create / update. A new rule is
 *                      born OBSERVE (Watch); an edit of an Auto rule drops it to Ask me (a changed rule earns Auto again).
 *                      Its scope: market › portfolio › campaign › ONE ad group (stored in scopeAdGroupId, its campaign set
 *                      from it), or a product.
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
import { findWasteRule, PSEUDO_ROWS, type WasteRuleRecord } from './read.js'
import { bodyOfRule, bodyProblems, ruleOfBody, type WasteRuleBody, type WasteScope } from './pure.js'

const PSEUDO_REFUSAL = 'The brain and Harvest are shown here, never changed here: change them on their own pages.'

export type WriteAnswer<T> = { data: T } | { error: string; status: 400 | 404 | 409 }

/** Default caps of a page-saved rule: one daily run's matches; the writes a day before it falls back to a dry run. */
const CAPS = { PAUSE_KEYWORD: { maxExecutionsPerDay: 500, maxWritesPerDay: 50 }, NEGATE_TERM: { maxExecutionsPerDay: 500, maxWritesPerDay: 100 } } as const

const scopeOf = (r: WasteRuleRecord): WasteScope => ({
  ...(r.scopeMarketplace ? { marketplace: r.scopeMarketplace } : {}),
  ...(r.scopePortfolioId ? { portfolioId: r.scopePortfolioId } : {}),
  ...(r.scopeCampaignId ? { campaignId: r.scopeCampaignId } : {}),
  ...(r.scopeAdGroupId ? { adGroupId: r.scopeAdGroupId } : {}),
  ...(r.scopeProductId ? { productId: r.scopeProductId } : {}),
  ...(!r.scopeMarketplace && !r.scopePortfolioId && !r.scopeCampaignId && !r.scopeAdGroupId && !r.scopeProductId ? { wholeAccount: true } : {}),
})

export interface SavedWasteRule { id: string; name: string; created: boolean; level: string; scope: WasteScope; sentence: string }

/** POST /advertising/waste/rules (create) and PATCH /advertising/waste/rules/:id (edit: fields left out keep the rule's own). */
export async function saveWasteRule(input: { id?: string; body: Partial<WasteRuleBody> }, actor: AdsActor): Promise<WriteAnswer<SavedWasteRule>> {
  let existing: WasteRuleRecord | null = null
  let base: WasteRuleBody | null = null
  if (input.id) {
    if (PSEUDO_ROWS.has(input.id)) return { error: PSEUDO_REFUSAL, status: 400 }
    existing = await findWasteRule(input.id)
    if (!existing) return { error: `No waste rule ${input.id} in this business.`, status: 404 }
    if (existing.domain === ARCHIVED_ADS_DOMAIN) return { error: `${existing.name} is archived: restore it first.`, status: 409 }
    base = bodyOfRule({ name: existing.name, actions: existing.actions, scope: scopeOf(existing) })
    if (!base) return { error: `${existing.name} was not made as a stop-waste rule here: edit it in its own builder.`, status: 409 }
    if (input.body.kind && input.body.kind !== base.kind) return { error: 'A rule keeps its kind: make a new rule for the other one.', status: 400 }
  }
  const body: WasteRuleBody = { ...(base ?? {}), ...input.body, kind: (input.body.kind ?? base?.kind)! } as WasteRuleBody
  const problems = bodyProblems(body)
  if (problems.length) return { error: `Not saved — ${problems.join('; ')}.`, status: 400 }

  // The scope as stored: an ad group carries its campaign; every id must exist here (the save tool's own checks).
  const { withAdGroupCampaign, amazonReach } = await import('../../automation/ad-rule-save.service.js')
  const grain = await withAdGroupCampaign(body.scope ?? {})
  if ('error' in grain) return { error: `Not saved — ${grain.error}.`, status: 400 }
  // N4 — a scope inside one market stores that market, so every reader (the tab counts too) shows it in that market only.
  const { marketOfScope } = await import('./contexts.js')
  const derived = await marketOfScope(grain.scope)
  const scope: WasteScope = derived ? { ...grain.scope, marketplace: derived } : grain.scope
  const reach = await amazonReach(scope)
  if ('error' in reach) return { error: `Not saved — ${reach.error}.`, status: 400 }

  const rule = ruleOfBody({ ...body, scope })
  const crud = await import('../ads-rule-crud.service.js')
  const note = 'saved on the Negative Targeting page'
  const scopeCols = { scopePortfolioId: scope.portfolioId ?? null, scopeCampaignId: scope.campaignId ?? null, scopeProductId: scope.productId ?? null }
  const out = existing
    ? await crud.updateAdsRule(existing.id, { name: rule.name, conditions: rule.conditions, actions: rule.actions, scopeMarketplace: scope.marketplace ?? null }, actor, {
      ...scopeCols, note,
      // A changed Auto rule earns Auto again: it asks until a person turns it back up.
      ...(existing.autonomyLevel === 'AUTO' ? { autonomyLevel: 'PROPOSE' as const, dryRun: true } : {}),
    })
    : await crud.createAdsRule({
      name: rule.name, trigger: rule.trigger, conditions: rule.conditions, actions: rule.actions,
      maxExecutionsPerDay: CAPS[body.kind].maxExecutionsPerDay, maxWritesPerDay: CAPS[body.kind].maxWritesPerDay,
      scopeMarketplace: scope.marketplace ?? undefined,
    }, actor, { ...scopeCols, enabled: true, dryRun: true, autonomyLevel: 'OBSERVE', note })
  const { isRefused } = await import('../../automation/service-outcome.js')
  if (isRefused(out)) return { error: `Not saved — ${String((out.body as { message?: unknown; error?: unknown }).message ?? (out.body as { error?: unknown }).error)}`, status: 400 }
  const saved = out.value.rule
  const wantGroup = scope.adGroupId ?? null
  const hadGroup = (saved as { scopeAdGroupId?: string | null }).scopeAdGroupId ?? null
  if (hadGroup !== wantGroup) {
    await prisma.automationRule.update({ where: { id: saved.id }, data: { scopeAdGroupId: wantGroup } })
    await crud.auditRule(actor, 'update_rule', saved.id, { scopeAdGroupId: hadGroup }, { scopeAdGroupId: wantGroup }, `${saved.name}: scopeAdGroupId (${note})`)
  }
  const { resolveAutonomy } = await import('../ads-autonomy.js')
  const { wasteSentence } = await import('./pure.js')
  const { ruleSentence } = await import('../bid-rules/pure.js')
  return {
    data: {
      id: saved.id, name: saved.name, created: !existing, level: resolveAutonomy(saved), scope,
      sentence: wasteSentence({ actions: rule.actions, trigger: rule.trigger, conditions: rule.conditions }, ruleSentence),
    },
  }
}

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
