/**
 * ES1 — Manual-rule Suggestions.
 *
 * Manual-control ads rules are propose-only (force dry-run). When one matches, the engine calls
 * generateSuggestionsFromExecution() to record each proposed action as an AdsRuleSuggestion the
 * operator can Approve (apply live) or Dismiss on the Suggestions page. Deduped per
 * rule×entity×change so a recurring 15-min tick doesn't pile up duplicates.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

interface Entity { type: string; id: string; name: string | null }
function extractEntity(context: unknown): Entity | null {
  const c = (context ?? {}) as { campaign?: { id?: string; name?: string }; searchTerm?: { query?: string; externalCampaignId?: string }; adTarget?: { id?: string }; marketplace?: string }
  if (c.campaign?.id) return { type: 'CAMPAIGN', id: c.campaign.id, name: c.campaign.name ?? null }
  if (c.searchTerm?.query) return { type: 'SEARCH_TERM', id: `${c.searchTerm.externalCampaignId ?? ''}:${c.searchTerm.query}`, name: c.searchTerm.query }
  if (c.adTarget?.id) return { type: 'AD_TARGET', id: c.adTarget.id, name: null }
  if (c.marketplace) return { type: 'MARKETPLACE', id: c.marketplace, name: c.marketplace }
  return null
}

// stable change-kind key (intent, not current value) so the same proposed change dedupes.
function proposedKey(action: Record<string, unknown>): string {
  const parts = [String(action.type ?? '')]
  if (action.op != null) parts.push(String(action.op))
  if (action.value != null) parts.push(String(action.value))
  if (action.placement != null) parts.push(String(action.placement))
  return parts.join(':')
}

export async function generateSuggestionsFromExecution(args: {
  ruleId: string; ruleName: string; trigger: string; executionId: string
  context: unknown
  actions: Array<Record<string, unknown>>
  actionResults: Array<{ type: string; ok?: boolean; output?: unknown }>
}): Promise<number> {
  try {
    const entity = extractEntity(args.context)
    if (!entity) return 0
    const marketplace = (args.context as { marketplace?: string })?.marketplace ?? null
    let written = 0
    for (let i = 0; i < args.actionResults.length; i++) {
      const res = args.actionResults[i]
      const action = args.actions[i] ?? {}
      // only surface ACTIONABLE proposals — skip failures, no-change, allowlist-skips
      const out = (res.output ?? {}) as { noChange?: boolean; skipped?: string; noActiveWindow?: boolean }
      if (res.ok === false || out.noChange || out.skipped || out.noActiveWindow) continue
      const key = proposedKey(action)
      // upsert on the dedupe key — keep one row per rule×entity×change; don't resurrect a
      // dismissed/applied row (the operator already decided).
      const proposal = { ...action, ...(res.output as object) } as object
      await prisma.adsRuleSuggestion.upsert({
        where: { ruleId_entityId_proposedKey: { ruleId: args.ruleId, entityId: entity.id, proposedKey: key } },
        create: {
          ruleId: args.ruleId, ruleName: args.ruleName, executionId: args.executionId, trigger: args.trigger, marketplace,
          entityType: entity.type, entityId: entity.id, entityName: entity.name,
          proposedAction: proposal, proposedKey: key, status: 'pending',
        },
        update: {
          // refresh the latest proposal + execution for a still-pending suggestion (no-op if decided)
          executionId: args.executionId, proposedAction: proposal,
        },
      })
      written++
    }
    return written
  } catch (e) {
    logger.warn('[ads-suggestions] generate failed', { ruleId: args.ruleId, error: (e as Error).message })
    return 0
  }
}
