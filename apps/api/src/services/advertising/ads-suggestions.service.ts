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

// ── S.1 — Navigation resolver ────────────────────────────────────────────────
// A suggestion records WHICH entity it touches (entityType + entityId), but the
// Suggestions page needs to deep-link the operator to the exact sub-page that
// entity lives on. We resolve that link at READ time (no migration, no writes) so
// it also fixes historical rows — notably AD_TARGET rows, whose entityName was
// stored null (the operator otherwise saw a raw cuid).
const ADS_BASE = '/marketing/ads'

export interface SuggestionSource {
  /** Deep link to the source sub-page, or null when the entity can't be resolved. */
  href: string | null
  /** Human label for the entity (campaign name · keyword text · search query · marketplace). */
  label: string
  campaignId?: string
  campaignName?: string
  adGroupId?: string
  adGroupName?: string
  /** Keyword/target text (AD_TARGET) or the search query (SEARCH_TERM). */
  keyword?: string
  /** Match type for AD_TARGET (EXACT | PHRASE | BROAD | …). */
  matchType?: string
  marketplace?: string | null
}

/** The minimal suggestion shape the resolver reads. */
export interface SourceRow {
  entityType: string
  entityId: string
  entityName: string | null
  marketplace: string | null
}

/** Pre-fetched lookups, keyed for O(1) resolution (see attachSourceLinks). */
export interface SourceLookups {
  /** Campaign by internal id (CAMPAIGN entities). */
  campaign: Map<string, { id: string; name: string }>
  /** AdTarget by internal id, flattened with its ad-group + campaign (AD_TARGET entities). */
  adTarget: Map<string, {
    expressionValue: string; expressionType: string; adGroupId: string
    adGroupName: string | null; campaignId: string | null; campaignName: string | null
  }>
  /** Campaign by `${externalCampaignId}|${marketplace}` and a bare `${externalCampaignId}` fallback (SEARCH_TERM entities). */
  extCampaign: Map<string, { id: string; name: string }>
}

const emptyLookups = (): SourceLookups => ({ campaign: new Map(), adTarget: new Map(), extCampaign: new Map() })

/**
 * Pure: map one suggestion row + the pre-fetched lookups → a SuggestionSource.
 * Degrades gracefully (href:null, best-effort label) when the entity is gone.
 */
export function resolveSourceLink(row: SourceRow, lk: SourceLookups): SuggestionSource {
  const fallback = row.entityName ?? row.entityId
  switch (row.entityType) {
    case 'CAMPAIGN': {
      const c = lk.campaign.get(row.entityId)
      if (!c) return { href: null, label: fallback, marketplace: row.marketplace }
      return { href: `${ADS_BASE}/campaigns/${c.id}`, label: c.name, campaignId: c.id, campaignName: c.name, marketplace: row.marketplace }
    }
    case 'SEARCH_TERM': {
      // entityId is `${externalCampaignId}:${query}` — the query itself may contain ':'.
      const idx = row.entityId.indexOf(':')
      const ext = idx >= 0 ? row.entityId.slice(0, idx) : row.entityId
      const query = (idx >= 0 ? row.entityId.slice(idx + 1) : '') || row.entityName || ''
      const c = lk.extCampaign.get(`${ext}|${row.marketplace ?? ''}`) ?? lk.extCampaign.get(ext)
      if (!c) return { href: null, label: query || fallback, keyword: query || undefined, marketplace: row.marketplace }
      return { href: `${ADS_BASE}/campaigns/${c.id}?tab=search-terms`, label: query || c.name, keyword: query || undefined, campaignId: c.id, campaignName: c.name, marketplace: row.marketplace }
    }
    case 'AD_TARGET': {
      const t = lk.adTarget.get(row.entityId)
      if (!t) return { href: null, label: fallback, marketplace: row.marketplace }
      const href = t.campaignId ? `${ADS_BASE}/campaigns/${t.campaignId}/ad-groups/${t.adGroupId}?tab=targets` : null
      return {
        href, label: t.expressionValue || fallback, keyword: t.expressionValue || undefined,
        matchType: t.expressionType || undefined, campaignId: t.campaignId ?? undefined, campaignName: t.campaignName ?? undefined,
        adGroupId: t.adGroupId, adGroupName: t.adGroupName ?? undefined, marketplace: row.marketplace,
      }
    }
    case 'MARKETPLACE':
      // Marketplace-scope rules (e.g. budget caps) → the Ad Manager grid (market lives in a shared store, not the URL).
      return { href: `${ADS_BASE}/campaigns`, label: row.entityId, marketplace: row.entityId }
    default:
      return { href: null, label: fallback, marketplace: row.marketplace }
  }
}

/**
 * Batch-resolve a list of suggestions: three `findMany`s (campaign / adTarget / ext-campaign),
 * one per entity family, then a pure per-row map. O(1) DB round-trips regardless of list size.
 */
export async function attachSourceLinks<T extends SourceRow>(items: T[]): Promise<Array<T & { source: SuggestionSource }>> {
  if (items.length === 0) return []
  const campaignIds = new Set<string>()
  const adTargetIds = new Set<string>()
  const extIds = new Set<string>()
  for (const it of items) {
    if (it.entityType === 'CAMPAIGN') campaignIds.add(it.entityId)
    else if (it.entityType === 'AD_TARGET') adTargetIds.add(it.entityId)
    else if (it.entityType === 'SEARCH_TERM') {
      const idx = it.entityId.indexOf(':')
      extIds.add(idx >= 0 ? it.entityId.slice(0, idx) : it.entityId)
    }
  }

  const [campaigns, adTargets, extCampaigns] = await Promise.all([
    campaignIds.size
      ? prisma.campaign.findMany({ where: { id: { in: [...campaignIds] } }, select: { id: true, name: true } })
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    adTargetIds.size
      ? prisma.adTarget.findMany({
          where: { id: { in: [...adTargetIds] } },
          select: { id: true, expressionValue: true, expressionType: true, adGroupId: true, adGroup: { select: { name: true, campaign: { select: { id: true, name: true } } } } },
        })
      : Promise.resolve([] as Array<{ id: string; expressionValue: string; expressionType: string; adGroupId: string; adGroup: { name: string; campaign: { id: string; name: string } | null } | null }>),
    extIds.size
      ? prisma.campaign.findMany({ where: { externalCampaignId: { in: [...extIds] } }, select: { id: true, name: true, externalCampaignId: true, marketplace: true } })
      : Promise.resolve([] as Array<{ id: string; name: string; externalCampaignId: string | null; marketplace: string | null }>),
  ])

  const lk = emptyLookups()
  for (const c of campaigns) lk.campaign.set(c.id, { id: c.id, name: c.name })
  for (const t of adTargets) {
    lk.adTarget.set(t.id, {
      expressionValue: t.expressionValue, expressionType: t.expressionType, adGroupId: t.adGroupId,
      adGroupName: t.adGroup?.name ?? null, campaignId: t.adGroup?.campaign?.id ?? null, campaignName: t.adGroup?.campaign?.name ?? null,
    })
  }
  for (const c of extCampaigns) {
    if (!c.externalCampaignId) continue
    lk.extCampaign.set(`${c.externalCampaignId}|${c.marketplace ?? ''}`, { id: c.id, name: c.name })
    if (!lk.extCampaign.has(c.externalCampaignId)) lk.extCampaign.set(c.externalCampaignId, { id: c.id, name: c.name }) // bare-ext fallback → first seen
  }

  return items.map((it) => ({ ...it, source: resolveSourceLink(it, lk) }))
}
