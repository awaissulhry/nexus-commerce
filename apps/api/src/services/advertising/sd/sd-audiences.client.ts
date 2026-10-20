/**
 * SD-AUD (2026-10-20) — Amazon's audiences for Sponsored Display, so an `audienceSameAs` target can be filled with a real
 * audience id. Amazon Ads Audiences API (Audiences_prod_3p, "Discovery"):
 *
 *   POST /audiences/taxonomy/list   { adType: 'SD', categoryPath, countries }  → the categories one level under a path
 *                                   (In-market, Interest, Lifestyle, Life event at the top), each with its audience count
 *   POST /audiences/list            { adType: 'SD', filters, countries }       → the audiences matching every filter:
 *                                   audienceName (broad match, values OR-ed), category (a whole sub-tree), categoryPath
 *                                   (directly under that node), audienceId; `canTarget=true` keeps targetable ones only
 *
 * Both take `maxResults` (1–250) and Amazon's `nextToken` as query parameters and plain JSON. A POST …/list is a read for
 * the gateway and the quota (gateway/ads.ts). Read only; sandbox answers nothing (no audience is invented).
 */
import { adsMode, liveCall, type ClientContext } from '../ads-api-client.js'

export interface SdAudience {
  audienceId: string
  name: string
  description: string | null
  category: string | null
  subCategory: string | null
  status: string | null
  /** Amazon's forecast of people reached a day (`forecasts.inventoryForecasts.all.dailyReach`), when it gives one. */
  dailyReach: { from: number | null; to: number | null } | null
}

export interface SdAudienceSearch {
  /** ISO alpha-2 country of the profile's market (sd-read.ts sdCountryOf). */
  country: string
  /** Words in the audience name (Amazon matches broadly; several are OR-ed). */
  words?: readonly string[]
  /** A top category and everything under it: In-market, Interest, Lifestyle, Life event. */
  category?: string
  /** A path in the taxonomy: only the audiences directly under its last node. */
  categoryPath?: readonly string[]
  audienceIds?: readonly string[]
  maxResults: number
  nextToken?: string
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)

function query(maxResults: number, nextToken?: string, extra = ''): string {
  return `?maxResults=${maxResults}${nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : ''}${extra}`
}

/** One audience as Amazon lists it (AudienceV1), or null when it carries no id. */
function sdAudienceOf(raw: unknown): SdAudience | null {
  const a = (raw ?? {}) as Record<string, unknown>
  const id = str(a.audienceId)
  if (!id) return null
  const reach = (((a.forecasts as Record<string, unknown> | undefined)?.inventoryForecasts as Record<string, unknown> | undefined)?.all as Record<string, unknown> | undefined)?.dailyReach as Record<string, unknown> | undefined
  return {
    audienceId: id,
    name: str(a.audienceName) ?? id,
    description: str(a.description),
    category: str(a.category),
    subCategory: str(a.subCategory),
    status: str(a.status),
    dailyReach: reach ? { from: num(reach.lowerBoundInclusive), to: num(reach.upperBoundExclusive) } : null,
  }
}

export async function searchSdAudiences(ctx: ClientContext, s: SdAudienceSearch): Promise<{ audiences: SdAudience[]; nextToken: string | null; matchCount: number | null }> {
  if (adsMode() === 'sandbox') return { audiences: [], nextToken: null, matchCount: 0 }
  const filters: Array<{ field: string; values: string[] }> = []
  if (s.words?.length) filters.push({ field: 'audienceName', values: [...s.words] })
  if (s.category) filters.push({ field: 'category', values: [s.category] })
  if (s.categoryPath?.length) filters.push({ field: 'categoryPath', values: [...s.categoryPath] })
  if (s.audienceIds?.length) filters.push({ field: 'audienceId', values: [...s.audienceIds] })
  const res = await liveCall<{ audiences?: unknown[]; nextToken?: string; matchCount?: number }>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST',
    path: `/audiences/list${query(s.maxResults, s.nextToken, '&canTarget=true')}`,
    body: { adType: 'SD', countries: [s.country], filters },
    contentType: 'application/json', acceptHeader: 'application/json',
  })
  return {
    audiences: (res?.audiences ?? []).map(sdAudienceOf).filter((a): a is SdAudience => a != null),
    nextToken: str(res?.nextToken),
    matchCount: num(res?.matchCount),
  }
}

export async function sdAudienceTaxonomy(ctx: ClientContext, s: { country: string; categoryPath: readonly string[]; maxResults: number; nextToken?: string }): Promise<{ categoryPath: string[]; categories: Array<{ category: string; audienceCount: number | null }>; nextToken: string | null }> {
  if (adsMode() === 'sandbox') return { categoryPath: [...s.categoryPath], categories: [], nextToken: null }
  const res = await liveCall<{ categoryPath?: unknown[]; categories?: Array<Record<string, unknown>>; nextToken?: string }>({
    profileId: ctx.profileId, region: ctx.region, method: 'POST',
    path: `/audiences/taxonomy/list${query(s.maxResults, s.nextToken)}`,
    body: { adType: 'SD', countries: [s.country], categoryPath: [...s.categoryPath] },
    contentType: 'application/json', acceptHeader: 'application/json',
  })
  return {
    categoryPath: (res?.categoryPath ?? s.categoryPath).map((p) => String(p)),
    categories: (res?.categories ?? []).map((c) => ({ category: str(c.category) ?? '', audienceCount: num(c.audienceCount) })).filter((c) => c.category),
    nextToken: str(res?.nextToken),
  }
}
