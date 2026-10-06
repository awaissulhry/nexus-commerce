/**
 * ADS AUTONOMY W3-1 — where an ad change came from (its provenance), the same way on every Amazon ad change tool that
 * carries out an engine's output: set-target-bid, bulk-ad-bid-change (per row), create-negative-keyword,
 * graduate-keyword, set-campaign-budget and suppress-campaign.
 *
 *   arg        `source: { kind, id }` — optional. apply-ad-recommendations sets it on every step it asks for; Claude may
 *              set it too when it carries a recommendation out with the change tool itself.
 *   checked    in the dry run: a source names THIS change's recommendation (`bid:<the target>` …), or the request is
 *              refused. Today only an engine's recommendation is taken (`kind: recommendation`); a rule's suggestion
 *              is applied with decide-automation-suggestions, and the other kinds wait for W3-5.
 *   kept       in the preview (`source`, `sourceNote`: the person approving reads which engine asked for it) and on
 *              the ads audit row of every write it makes (AdWriteEvidence.source): ad-changes and Claude's report say
 *              "from the bid optimizer".
 *   settled    once the write ran, the recommendation is settled (ads-recommendation-mutes.service.ts): the feed does
 *              not offer it again until the data the engines read is a day past the change. A settle that fails is
 *              logged, never a failed change: the write ran.
 */
import { z } from 'zod'
import type { AdWriteEvidence } from '../../advertising/ads-evidence.js'
import { familyOfRecommendationId, settleRecommendations } from '../../advertising/ads-recommendation-mutes.service.js'
import { logger } from '../../../utils/logger.js'

/** Who produced what a change carries out (W3-5 takes the last three). */
export const SOURCE_KINDS = ['recommendation', 'rule', 'autopilot', 'tracker'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
export interface AdChangeSource { kind: SourceKind; id: string }

const sourceShape = z.object({
  kind: z.enum(SOURCE_KINDS).describe('recommendation: an engine\'s recommendation from ad-recommendations (the only kind taken today)'),
  id: z.string().trim().min(1).max(400).describe('its recommendationId from ad-recommendations, e.g. bid:<targetId>'),
})

/** The `source` argument of a change tool. */
export const sourceArg = sourceShape.optional()
  .describe('the engine recommendation this change carries out (apply-ad-recommendations sets it): kept in the preview and the ads audit, and once it runs the recommendation is not offered again until the data shows what the change did')

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

/** Why a source cannot ride on this change (it names another one, or a kind not taken yet); null when it may. Pure. */
export function sourceRefusal(source: AdChangeSource | null, expectedId: string): string | null {
  if (!source) return null
  if (source.kind === 'rule') return 'a rule\'s suggestion is applied with decide-automation-suggestions (or apply-ad-recommendations with its rule: id), not named as the source of this change'
  if (source.kind !== 'recommendation') return `a source of kind ${source.kind} is not taken yet: only an engine's recommendation (kind recommendation) is`
  if (source.id !== expectedId) return `the source names recommendation ${source.id}, but this change carries out ${expectedId}`
  return null
}

/** What the preview says about it, for the person approving. */
export function sourceNote(source: AdChangeSource): string {
  const engine = ENGINE_WORDS[familyOfRecommendationId(source.id) ?? ''] ?? 'an ad engine'
  return `From ${engine}'s recommendation ${source.id}. Once this runs it is not offered again until the data shows what the change did.`
}

/** The preview's keys for a source: nothing without one. */
export function sourcePreview(source: AdChangeSource | null): { source?: AdChangeSource; sourceNote?: string } {
  return source ? { source, sourceNote: sourceNote(source) } : {}
}

/** The audit evidence of a write that carries a source out, on top of what the write already records. */
export function withSource(evidence: AdWriteEvidence | null | undefined, source: AdChangeSource | null): AdWriteEvidence | null {
  if (!source) return evidence ?? null
  return { ...(evidence ?? {}), source: { kind: source.kind, id: source.id } }
}

/**
 * After the write ran: settle each recommendation it carried out, under the request it ran as. Never throws — the
 * change ran, and a settle that failed only means the feed may offer it again.
 */
export async function settleSources(sources: ReadonlyArray<AdChangeSource | null | undefined>, approvalId: string | undefined): Promise<number> {
  const ids = sources.filter((s): s is AdChangeSource => !!s && s.kind === 'recommendation').map((s) => s.id)
  if (!ids.length || !approvalId) return 0
  try {
    return await settleRecommendations(ids, approvalId)
  } catch (error) {
    logger.warn('[ads-change-source] could not settle the recommendations a change carried out', { approvalId, ids: ids.length, error: error instanceof Error ? error.message : String(error) })
    return 0
  }
}
