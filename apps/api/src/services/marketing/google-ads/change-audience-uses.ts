/**
 * Google Ads programme 2, G14a (2026-10-16) — what changing an audience can make the account spend: an audience spends
 * nothing by itself; the campaigns that use it do. A change that lets an audience hold more people (or, for one used as
 * an exclusion, fewer) widens who the ads of the campaigns using it reach: SPENDS MONEY when one of them serves (the
 * campaign enabled, its ad group or asset group enabled, the criterion not paused), a warning when they are all paused.
 * Uses are direct (campaign and ad group criteria, asset group signals) or through what holds the audience: a reusable
 * audience (Audience) that holds the segment or leaves the user list out, a combination list (logical_user_list: a list
 * in an ALL or ANY rule passes the combination's uses through; in a NONE rule they swap, since the combination holds the
 * people NOT in it), or a lookalike seeded from the list (it grows and shrinks with its seeds: its uses pass through).
 */
import { plural } from './change-draft.js'
import type { AudienceUse, LiveReusableAudience, LiveUserList, UsedKind } from './live-goals-audiences.js'

export interface UseContext {
  uses: AudienceUse[]
  audiences: LiveReusableAudience[]
  /** The account's user lists (combinations and lookalikes a list feeds); none = only direct and audience uses. */
  lists?: LiveUserList[]
}

/** A use that can spend now. */
export const serving = (u: AudienceUse) => u.campaignStatus === 'ENABLED' && (u.levelStatus === null || u.levelStatus === 'ENABLED') && u.status !== 'PAUSED'

export interface Places { positive: AudienceUse[]; negative: AudienceUse[] }

/**
 * Where an audience is used: targeted or observed (positive), excluded (negative) — directly, and through what holds it
 * (each such use carries `via`, the path it came through).
 */
export function placesOf(ctx: UseContext, kind: UsedKind, id: string, seen: Set<string> = new Set()): Places {
  const key = `${kind}|${id}`
  if (seen.has(key)) return { positive: [], negative: [] }
  seen.add(key)
  const positive = ctx.uses.filter((u) => u.kind === kind && u.id === id && !u.negative)
  const negative = ctx.uses.filter((u) => u.kind === kind && u.id === id && u.negative)
  const through = (places: Places, via: string, swap: boolean) => {
    const tag = (u: AudienceUse) => ({ ...u, via: u.via ? `${via} > ${u.via}` : via })
    positive.push(...(swap ? places.negative : places.positive).map(tag))
    negative.push(...(swap ? places.positive : places.negative).map(tag))
  }
  if (kind !== 'AUDIENCE') {
    for (const a of ctx.audiences) {
      const inside = a.definition.segments.some((s) => s.kind === kind && s.id === id)
      const left = kind === 'USER_LIST' && a.definition.excludeUserLists.includes(id)
      if (!inside && !left) continue
      const places = placesOf(ctx, 'AUDIENCE', a.audienceId, seen)
      if (inside) through(places, `audience ${a.audienceId}`, false)
      if (left) through(places, `audience ${a.audienceId} (left out)`, true)
    }
  }
  if (kind === 'USER_LIST') {
    for (const l of ctx.lists ?? []) {
      if (l.userListId === id) continue
      const rules = (l.combination ?? []).filter((r) => r.userListIds.includes(id))
      const seeded = (l.lookalike?.seedUserListIds ?? []).includes(id)
      if (!rules.length && !seeded) continue
      const places = placesOf(ctx, 'USER_LIST', l.userListId, seen)
      if (rules.some((r) => r.operator !== 'NONE') || seeded) through(places, `${seeded ? 'lookalike' : 'combination'} ${l.userListId}`, false)
      if (rules.some((r) => r.operator === 'NONE')) through(places, `combination ${l.userListId} (NONE)`, true)
    }
  }
  return { positive, negative }
}

/** The places as the facts a change stands on (campaign, statuses, the path). */
export const placeKeys = (p: Places): string[] => [
  ...p.positive.map((u) => `+${u.campaignId}/${u.campaignStatus}/${u.levelStatus}/${u.status}/${u.channel}${u.via ? `/${u.via}` : ''}`),
  ...p.negative.map((u) => `-${u.campaignId}/${u.campaignStatus}/${u.levelStatus}/${u.status}/${u.channel}${u.via ? `/${u.via}` : ''}`),
].sort()

const campaignNames = (uses: AudienceUse[]) => {
  const names = [...new Set(uses.map((u) => u.campaignName || u.campaignId))]
  return `${plural(names.length, 'campaign')} (${names.slice(0, 5).map((n) => `"${n}"`).join(', ')}${names.length > 5 ? ` and ${names.length - 5} more` : ''})`
}

/**
 * The money line (or warning) of a change that widens who an audience brings in: `uses` are the places where that
 * widening reaches more people (positive uses for "holds more people", negative ones for "leaves out fewer").
 */
export function widenLines(what: string, why: string, uses: AudienceUse[]): { spends: string[]; warnings: string[] } {
  if (!uses.length) return { spends: [], warnings: [] }
  const live = uses.filter(serving)
  if (live.length) return { spends: [`${what} ${why}: it is used by ${campaignNames(live)} that serve now, whose ads can reach more people.`], warnings: [] }
  return { spends: [], warnings: [`${what} ${why}: the ${campaignNames(uses)} that use it are paused, so nothing spends more until they serve.`] }
}

/** The warning of a change that narrows who an audience brings in. */
export function narrowLine(what: string, why: string, uses: AudienceUse[]): string[] {
  const live = uses.filter(serving)
  return live.length ? [`${what} ${why}: the ${campaignNames(live)} that use it reach fewer people.`] : []
}

/** The places in words, for a refusal ("it is used by …"). */
export const placesWords = (uses: AudienceUse[]) => campaignNames(uses)
