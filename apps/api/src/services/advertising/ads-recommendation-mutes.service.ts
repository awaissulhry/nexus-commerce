/**
 * ADS AUTONOMY W3-1 — what hides a recommendation of the computed feed (ads-recommendations.service.ts), in one place.
 * The feed has no row per recommendation: it is computed from live data on every read, and each recommendation has a
 * deterministic id (`bid:<targetId>` …). What hides one is an AdsSuggestionMute row (scope `recommendations`, entity
 * RECOMMENDATION, entityId = that id), of one of two kinds:
 *
 *   mute      "stop recommending this" (SG.9, the Recommendations tab's third verb; Claude's mute-ad-recommendations):
 *             hidden until someone unmutes it.
 *   settle    a request carried the recommendation out by its id (a change step whose `source` named it, e.g. through
 *             apply-ad-recommendations): hidden so the next read of the same data does not offer it again — but only
 *             until the newest day the engines read (the settled window, ads-settled-window.ts) is a whole day after
 *             the change. From then on the data shows what the change did, and the engine may recommend again. No
 *             number of its own: the ad product's attribution lag decides (7 days for Sponsored Products).
 *
 * A settle is told from a mute by its `createdBy` (`request:<approvalId>`). A mute is never turned into a settle; a mute
 * replaces a settle. Nothing here reaches Amazon.
 */
import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { settledBounds } from './ads-settled-window.js'

export const RECOMMENDATION_SCOPE = 'recommendations'
export const RECOMMENDATION_ENTITY = 'RECOMMENDATION'
const SETTLED_BY = 'request:'

/** The categories of the feed, by the prefix of their ids (ads-recommendations.service.ts builds them). */
const ENGINE_PREFIX = { bid: 'bid', neg: 'negative', grad: 'graduate', budget: 'budget', sov: 'sov', retail: 'retail' } as const
export type EngineCategory = (typeof ENGINE_PREFIX)[keyof typeof ENGINE_PREFIX]
/** Ids ad-recommendations gives that are not the computed feed's: a rule's suggestion; an autopilot decision and a keyword-tracker proposal (W3-5). */
const OTHER_PREFIX = { rule: 'rule', autopilot: 'autopilot', kt: 'tracker' } as const
export type RecommendationFamily = EngineCategory | (typeof OTHER_PREFIX)[keyof typeof OTHER_PREFIX]

/** What a recommendation id is, by its prefix; null when it is none Nexus gives. Pure. */
export function familyOfRecommendationId(id: string): RecommendationFamily | null {
  const at = id.indexOf(':')
  if (at <= 0 || at === id.length - 1) return null
  const prefix = id.slice(0, at)
  return (ENGINE_PREFIX as Record<string, EngineCategory>)[prefix] ?? (OTHER_PREFIX as Record<string, RecommendationFamily>)[prefix] ?? null
}

export const isEngineFamily = (family: RecommendationFamily | null): family is EngineCategory =>
  !!family && (Object.values(ENGINE_PREFIX) as string[]).includes(family)

/** Whether a mute row is a settle (a request carried the recommendation out), not a person's mute. */
export const isSettle = (createdBy: string | null | undefined): boolean => !!createdBy && createdBy.startsWith(SETTLED_BY)

/** The start of the newest day the engines read now: a settle made before it has a whole day of data after it. */
export function settledDataFrom(now = new Date()): Date {
  const start = new Date(settledBounds(1, 'SPONSORED_PRODUCTS', { now }).until)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

/** Pure — whether a row hides its recommendation now: a mute always, a settle until the data is a day past it. */
export function hidesNow(row: { createdBy: string | null; createdAt: Date }, now = new Date()): boolean {
  return !isSettle(row.createdBy) || row.createdAt.getTime() >= settledDataFrom(now).getTime()
}

/**
 * What the feed drops now, as `RECOMMENDATION|<id>` keys: `hidden` (a mute, or a settle still in force) and `muted` (the
 * mutes alone: the Muted view lists them, and a settle is not a mute — it was carried out). As mutedKeys
 * (ads-suggestions.service.ts): a table that cannot be read logs and hides nothing this read, rather than failing the feed.
 */
export async function recommendationMuteKeys(now = new Date()): Promise<{ hidden: Set<string>; muted: Set<string> }> {
  try {
    const rows = await prisma.adsSuggestionMute.findMany({
      where: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY },
      select: { entityId: true, createdBy: true, createdAt: true },
    })
    const key = (r: { entityId: string }) => `${RECOMMENDATION_ENTITY}|${r.entityId}`
    return { hidden: new Set(rows.filter((r) => hidesNow(r, now)).map(key)), muted: new Set(rows.filter((r) => !isSettle(r.createdBy)).map(key)) }
  } catch {
    logger.warn('[ads-recommendations] mute lookup failed — showing every recommendation this read')
    return { hidden: new Set(), muted: new Set() }
  }
}

export type MuteState = 'muted' | 'settled' | 'shown'

export interface RecommendationMuteView {
  id: string
  /** muted: a mute hides it; settled: a request carried it out and it is hidden until the data moves; shown: neither. */
  state: MuteState
  label: string | null
  by: string | null
  at: string | null
}

/** Each id's state now, in the order asked. */
export async function recommendationMuteStates(ids: string[], now = new Date()): Promise<RecommendationMuteView[]> {
  const rows = ids.length
    ? await prisma.adsSuggestionMute.findMany({
      where: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId: { in: [...new Set(ids)] } },
      select: { entityId: true, entityName: true, createdBy: true, createdAt: true },
    })
    : []
  const byId = new Map(rows.map((r) => [r.entityId, r]))
  return ids.map((id) => {
    const row = byId.get(id)
    if (!row || !hidesNow(row, now)) return { id, state: 'shown' as const, label: row?.entityName ?? null, by: null, at: null }
    return { id, state: isSettle(row.createdBy) ? 'settled' as const : 'muted' as const, label: row.entityName ?? null, by: row.createdBy ?? null, at: row.createdAt.toISOString() }
  })
}

const keyOf = (entityId: string) => ({ scope_entityType_entityId: workspaceKey({ scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId }) })

/** Mute these recommendations (a settle of one becomes a mute: hidden until unmuted). */
export async function muteRecommendations(items: Array<{ id: string; label?: string | null }>, by: string, reason: string): Promise<number> {
  for (const item of items) {
    const label = item.label ? item.label.slice(0, 300) : null
    await prisma.adsSuggestionMute.upsert({
      where: keyOf(item.id),
      create: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId: item.id, entityName: label, reason, createdBy: by },
      update: { reason, createdBy: by, createdAt: new Date(), ...(label ? { entityName: label } : {}) },
    })
  }
  return items.length
}

/** Show these recommendations again: their mute (or settle) is removed. */
export async function unmuteRecommendations(ids: string[]): Promise<number> {
  if (!ids.length) return 0
  const { count } = await prisma.adsSuggestionMute.deleteMany({ where: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId: { in: [...new Set(ids)] } } })
  return count
}

/**
 * A request carried these recommendations out: settle each, so the feed does not offer it again until the data moves.
 * A person's mute stays as it is. Returns how many were settled.
 */
export async function settleRecommendations(ids: string[], approvalId: string): Promise<number> {
  const unique = [...new Set(ids.filter(Boolean))]
  if (!unique.length) return 0
  const existing = await prisma.adsSuggestionMute.findMany({
    where: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId: { in: unique } },
    select: { entityId: true, createdBy: true },
  })
  const muted = new Set(existing.filter((r) => !isSettle(r.createdBy)).map((r) => r.entityId))
  const by = `${SETTLED_BY}${approvalId}`
  const reason = `carried out by request ${approvalId}: shown again once the data is a day past the change`
  let settled = 0
  for (const id of unique) {
    if (muted.has(id)) continue
    await prisma.adsSuggestionMute.upsert({
      where: keyOf(id),
      create: { scope: RECOMMENDATION_SCOPE, entityType: RECOMMENDATION_ENTITY, entityId: id, reason, createdBy: by },
      update: { reason, createdBy: by, createdAt: new Date() },
    })
    settled++
  }
  return settled
}
