/**
 * Meta step 20 — set-meta-placements as a draft. Pure: the request and the live state (live-targeting-change.ts) in, the
 * draft (or a refusal in words) out. Placements are keys of an ad set's targeting, which goes WHOLE (Q7,
 * targeting-merge.ts; the gateway's rule `adset.placements` lets only the placement keys differ from the live spec), plus
 * one top-level ad set field, placement_soft_opt_out. Master rows (facts F1 M4-17; placement-targeting.md; v26 changelog):
 *   TG-080  Advantage+ placements: every placement key left out — "Facebook considers all default publisher_platforms …
 *           may also automatically consider new positions or platforms"; with an account onboarded to WhatsApp marketing
 *           messages, Meta adds those too (marketing-messages.md; step 19's read of marketing_messages_settings)
 *   TG-081  platforms: facebook, instagram, threads, messenger, audience_network, whatsapp (Audience Network never alone)
 *   TG-082  Facebook positions (story / notification never alone: they need Facebook feed or Instagram story)
 *   TG-083  Instagram positions (v26 removed `explore`) · TG-084 Threads (needs Instagram stream and both platforms)
 *   TG-085  Audience Network positions · TG-086 Messenger (v26 removed `story`; sponsored_messages goes with nothing else)
 *   TG-087  WhatsApp positions: status (needs Instagram story), marketing_messages (only an account onboarded to them)
 *   TG-077  people whose age is unknown (WhatsApp Status only; Meta defaults it on since 2026-07-29 with that placement)
 *   TG-088  limited spend on excluded placements (up to 5% per excluded placement Meta may still spend)
 *   TG-090  in-stream: skippable ads out (instream_video_skippable_excluded), sponsorship placements (values undocumented)
 * Spending: more placements, Advantage+ placements (Meta may add new ones), people of unknown age, skippable in-stream back
 * in, limited spend allowed on an excluded placement — on an ad set that is on — is SPENDS MONEY. Fewer is safe. Every
 * placement change sends the ad set's ads back to review. An edit that leaves Advantage+ placements turns an Advantage+
 * campaign off (step 18 rule: said). Devices (mobile, desktop, connected TV) are set-meta-targeting's (TG-071).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { mergeTargeting } from './targeting-merge.js'
import {
  PLACEMENT_TARGETING_KEYS, POSITIONS_OF, PUBLISHER_PLATFORMS, SOFT_OPT_OUT_KEYS, placementWholeProblem, sameTargeting, targetingValueProblem, targetingView,
  type PublisherPlatform,
} from '../../gateway/meta-targeting-rules.js'
import { MAX_TARGETING_BODY, sameJson } from '../../gateway/meta-brand-safety-rules.js'
import { adSetWho, retiredPlacements, REVIEW_SENTENCE, spendOf, targetingJudge, valueWords, WHOLE_SENTENCE, type TargetingRecord } from './change-targeting.js'
import type { TargetingAdSetState } from './live-targeting-change.js'

type Row = Record<string, unknown>
const plainObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const uniq = <T>(items: T[]): T[] => [...new Set(items)]

export interface SoftOptOutAsk { facebookPositions?: string[]; instagramPositions?: string[]; threadsPositions?: string[]; messengerPositions?: string[]; audienceNetworkPositions?: string[] }
const SOFT_ARGS: ReadonlyArray<[keyof SoftOptOutAsk, string]> = [
  ['facebookPositions', 'facebook_positions'], ['instagramPositions', 'instagram_positions'], ['threadsPositions', 'threads_positions'],
  ['messengerPositions', 'messenger_positions'], ['audienceNetworkPositions', 'audience_network_positions'],
]

export interface PlacementsAsk {
  adSetId: string
  /** Advantage+ placements: every placement key left out (Meta places the ads; it may add new placements). */
  advantagePlacements?: boolean
  /** The platforms (the whole list; [] = every platform). */
  platforms?: PublisherPlatform[]
  facebookPositions?: string[]
  instagramPositions?: string[]
  threadsPositions?: string[]
  audienceNetworkPositions?: string[]
  messengerPositions?: string[]
  whatsappPositions?: string[]
  userAgeUnknown?: boolean
  instreamSkippableExcluded?: boolean
  instreamSponsorshipPlacements?: string[]
  /** Limited spend on excluded placements (the whole setting; null clears it). */
  softOptOut?: SoftOptOutAsk | null
  /** Undo: placement keys put back as they were (null removes one), and the limited spend as it was. */
  restore?: Record<string, unknown>
  restoreSoftOptOut?: Record<string, unknown> | null
}

const POSITION_ARGS: ReadonlyArray<[keyof PlacementsAsk, string]> = [
  ['facebookPositions', 'facebook_positions'], ['instagramPositions', 'instagram_positions'], ['threadsPositions', 'threads_positions'],
  ['audienceNetworkPositions', 'audience_network_positions'], ['messengerPositions', 'messenger_positions'], ['whatsappPositions', 'whatsapp_positions'],
]
const ASKED: ReadonlyArray<keyof PlacementsAsk> = ['advantagePlacements', 'platforms', ...POSITION_ARGS.map(([a]) => a), 'userAgeUnknown', 'instreamSkippableExcluded', 'instreamSponsorshipPlacements', 'softOptOut', 'restore', 'restoreSoftOptOut']
const PLACEMENT_LIST_KEYS = ['publisher_platforms', ...POSITION_ARGS.map(([, k]) => k)]

/** Where a spec places ads: each platform:position it allows, and whether it is Advantage+ placements (no placement key). */
export function placementsOf(spec: Row): { positions: Set<string>; advantage: boolean } {
  const advantage = PLACEMENT_LIST_KEYS.every((k) => !list(spec[k]).length)
  const platforms = list(spec.publisher_platforms).length ? list(spec.publisher_platforms) as PublisherPlatform[] : [...PUBLISHER_PLATFORMS]
  const positions = new Set<string>()
  for (const p of platforms) {
    if (!POSITIONS_OF[p]) continue
    const own = list(spec[POSITIONS_OF[p].key])
    for (const pos of own.length ? own : POSITIONS_OF[p].positions) positions.add(`${p}:${pos}`)
  }
  return { positions, advantage }
}

/** How a placement change can reach more people or spend on more places, in words. */
export function placementWider(before: Row, after: Row, softBefore: Row | null, softAfter: Row | null): string[] {
  const out: string[] = []
  const b = placementsOf(before)
  const a = placementsOf(after)
  if (a.advantage && !b.advantage) out.push('Advantage+ placements (every placement, and new ones Meta adds)')
  else {
    const more = [...a.positions].filter((p) => !b.positions.has(p))
    if (more.length) out.push(`more placements (${more.slice(0, 6).join(', ')}${more.length > 6 ? ` +${more.length - 6}` : ''})`)
  }
  // Review A5 (c) — with WhatsApp Status, Meta reaches people of unknown age by default (since 2026-07-29): removing a
  // `false` lets them in as much as setting `true`.
  const whatsappStatus = a.positions.has('whatsapp:status')
  const unknownAge = (s: Row) => (s.user_age_unknown === undefined ? whatsappStatus : s.user_age_unknown === true)
  if (unknownAge(after) && !unknownAge(before)) out.push(`people whose age is unknown (WhatsApp Status${after.user_age_unknown === undefined ? ': Meta\'s default once the setting goes' : ''})`)
  if (before.instream_video_skippable_excluded === true && after.instream_video_skippable_excluded !== true) out.push('skippable in-stream ads back in')
  // Review A5 (b) — any change of the sponsorship placements, one added where there were none too (values undocumented).
  if (!sameTargeting(before.instream_video_sponsorship_placements ?? null, after.instream_video_sponsorship_placements ?? null)) out.push('in-stream sponsorship placements changed (their values are undocumented: Nexus cannot tell whether that narrows it)')
  const soft = (r: Row | null) => new Set(plainObject(r) ? Object.entries(r).flatMap(([k, v]) => list(v).map((x) => `${k}:${x}`)) : [])
  const moreSoft = [...soft(softAfter)].filter((x) => !soft(softBefore).has(x))
  if (moreSoft.length) out.push(`limited spend (up to 5% each) allowed on excluded ${moreSoft.join(', ')}`)
  return out
}

export interface PlacementsLive {
  adSets: Map<string, TargetingAdSetState>
  /** WhatsApp marketing messages: Meta's whatsapp_activation_status, or unread with Meta's words. */
  whatsapp: { status: string | null } | { unread: string }
}

/** placement_soft_opt_out as Nexus sends it: only lists with positions (an empty object clears it). */
const softOf = (ask: SoftOptOutAsk | null): Row => {
  const out: Row = {}
  if (ask) for (const [arg, key] of SOFT_ARGS) if (ask[arg]?.length) out[key] = uniq(ask[arg]!)
  return out
}

export function placementsDraft(request: PlacementsAsk[], live: PlacementsLive): MetaChangeDraft | { refusal: string } {
  if (!request.length) return { refusal: 'Name at least one ad set.' }
  const seen = new Set<string>()
  for (const item of request) {
    if (seen.has(item.adSetId)) return { refusal: `Ad set ${item.adSetId} is named twice: name each ad set once.` }
    seen.add(item.adSetId)
    if (!ASKED.some((k) => item[k] !== undefined)) return { refusal: `Say what to change on ad set ${item.adSetId} (advantagePlacements, platforms, positions, limited spend, …).` }
    if (item.advantagePlacements && (item.platforms || POSITION_ARGS.some(([a]) => item[a] !== undefined))) return { refusal: `Ad set ${item.adSetId}: Advantage+ placements leave every platform and position to Meta — name either advantagePlacements or the platforms and positions.` }
    if (item.advantagePlacements === false) return { refusal: `Ad set ${item.adSetId}: to leave Advantage+ placements, name the platforms and positions it should use.` }
  }
  const refusals: string[] = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const before: NonNullable<TargetingRecord['adSets']> = []
  const after: NonNullable<TargetingRecord['adSets']> = []
  const stands: unknown[] = []
  for (const item of request) {
    const state = live.adSets.get(item.adSetId)
    if (!state) { refusals.push(`Nexus could not read ad set ${item.adSetId} from Meta.`); continue }
    const who = adSetWho(state)
    const t = state.targeting
    const set: Row = {}
    if (item.restore) {
      const bad = Object.keys(item.restore).find((k) => !(PLACEMENT_TARGETING_KEYS as readonly string[]).includes(k))
      if (bad) { refusals.push(`${who}: targeting.${bad} is not a key set-meta-placements puts back.`); continue }
      Object.assign(set, Object.fromEntries(Object.entries(item.restore).map(([k, v]) => [k, v ?? null])))
    }
    if (item.advantagePlacements) for (const k of PLACEMENT_LIST_KEYS) if (t[k] !== undefined) set[k] = null
    if (item.platforms) set.publisher_platforms = item.platforms.length ? uniq(item.platforms) : null
    for (const [arg, key] of POSITION_ARGS) {
      const v = item[arg] as string[] | undefined
      if (v) set[key] = v.length ? uniq(v) : null
    }
    if (item.userAgeUnknown !== undefined) set.user_age_unknown = item.userAgeUnknown
    if (item.instreamSkippableExcluded !== undefined) set.instream_video_skippable_excluded = item.instreamSkippableExcluded
    if (item.instreamSponsorshipPlacements) set.instream_video_sponsorship_placements = item.instreamSponsorshipPlacements.length ? uniq(item.instreamSponsorshipPlacements) : null
    const judged = Object.entries(set).filter(([, v]) => v !== null).map(([k, v]) => targetingValueProblem(k, v)).find(Boolean)
    if (judged) { refusals.push(`${who}: ${judged}.`); continue }
    const merge = mergeTargeting(t, set)
    const whole = merge.changed.length ? placementWholeProblem(merge.spec) : null
    if (whole) { refusals.push(`${who}: ${whole} (placement-targeting.md).`); continue }
    if (new URLSearchParams({ targeting: merge.sent }).toString().length > MAX_TARGETING_BODY) { refusals.push(`${who}'s targeting is too large for one Nexus change (Meta takes it only whole); change its placements in Ads Manager.`); continue }
    // TG-088 — the limited spend on excluded placements (a top-level field, read on its own).
    const softAsked = item.softOptOut !== undefined || item.restoreSoftOptOut !== undefined
    const softRead = state.softOptOut
    if (softAsked && softRead && 'unread' in softRead) { refusals.push(`${who}: Meta did not let Nexus read its limited spend on excluded placements (${String(softRead.unread)}), so Nexus does not change it (it could not put it back).`); continue }
    const softNow = softRead && !('unread' in softRead) ? softRead as Row : null
    let softNext: Row | null = softNow
    if (item.restoreSoftOptOut !== undefined) softNext = item.restoreSoftOptOut
    if (item.softOptOut !== undefined) softNext = softOf(item.softOptOut)
    const softChanged = softAsked && !sameTargeting(softNow ?? {}, softNext ?? {})
    if (softChanged && softNext) {
      for (const [k, v] of Object.entries(softNext)) {
        const platform = PUBLISHER_PLATFORMS.find((p) => POSITIONS_OF[p].key === k)
        if (!(SOFT_OPT_OUT_KEYS as readonly string[]).includes(k) || !platform || !list(v).every((x) => POSITIONS_OF[platform].positions.includes(x))) { refusals.push(`${who}: limited spend takes ${SOFT_OPT_OUT_KEYS.join(', ')} with their own positions (not ${k} ${JSON.stringify(v)}).`); break }
      }
      if (refusals.length) continue
    }
    if (!merge.changed.length && !softChanged) { skipped.push(`${who} already has these placements.`); continue }
    // TG-087 — WhatsApp marketing messages only for an account onboarded to them.
    const wantsMessages = list(merge.spec.whatsapp_positions).includes('marketing_messages') && !list(t.whatsapp_positions).includes('marketing_messages')
    if (wantsMessages) {
      if ('unread' in live.whatsapp) warnings.push(`Meta did not say whether this ad account is onboarded to WhatsApp marketing messages (${live.whatsapp.unread}): Meta refuses the placement if it is not.`)
      else if (live.whatsapp.status !== 'MARKETING_MESSAGE_ONBOARDED') { refusals.push(`${who}: the WhatsApp marketing messages placement needs the ad account onboarded to marketing messages (Meta reads ${live.whatsapp.status ?? 'none'}); a person onboards it in Meta.`); continue }
    }
    // Review B5 — v26-removed placements an old ad set still holds: said, with the way out (name the lists without them).
    const retired = retiredPlacements(merge.spec)
    if (retired.length) warnings.push(`${who} still holds placement${retired.length === 1 ? '' : 's'} Meta removed in v26 (${retired.join(', ')}): Meta may refuse changes of it until ${retired.length === 1 ? 'it goes' : 'they go'} — name its Instagram or Messenger positions without ${retired.length === 1 ? 'it' : 'them'} (or advantagePlacements).`)
    const nowPlaces = placementsOf(t)
    const nextPlaces = placementsOf(merge.spec)
    if (nextPlaces.advantage && !nowPlaces.advantage) {
      warnings.push(`${who} goes to Advantage+ placements: Meta picks among every placement and may add new positions or platforms later${'unread' in live.whatsapp || live.whatsapp.status === 'MARKETING_MESSAGE_ONBOARDED' ? ' — WhatsApp marketing messages included, since the account is (or may be) onboarded to them' : ''}.`)
    }
    if (!nextPlaces.advantage && nowPlaces.advantage && state.campaign?.advantageState && state.campaign.advantageState !== 'DISABLED') {
      warnings.push(`${who}'s campaign is ${state.campaign.advantageState}: choosing placements by hand turns Advantage+ off for the campaign (Meta does it without a warning).`)
    }
    if (list(merge.spec.whatsapp_positions).includes('status') && merge.spec.user_age_unknown === undefined && t.user_age_unknown === undefined) {
      warnings.push(`${who}: with WhatsApp Status Meta reaches people whose age is unknown by default (since 2026-07-29); userAgeUnknown false keeps them out.`)
    }
    const keys = merge.changed.map((c) => c.key)
    const wider = placementWider(t, merge.spec, softNow, softChanged ? softNext : softNow)
    const spends = spendOf(state, wider)
    if (spends.spends) spendsMoney.push(spends.spends)
    if (spends.warning) warnings.push(spends.warning)
    for (const c of merge.changed) lines.push([`${who}: ${c.key}`, valueWords(c.key, c.from), valueWords(c.key, c.to)])
    if (softChanged) lines.push([`${who}: limited spend on excluded placements`, softNow ? JSON.stringify(softNow) : 'none', softNext && Object.keys(softNext).length ? JSON.stringify(softNext) : 'none'])
    const softParam = softChanged ? { placement_soft_opt_out: JSON.stringify(softNext ?? {}) } : {}
    const setKeys = Object.fromEntries(keys.map((k) => [k, merge.spec[k] ?? null]))
    const base = { step: requests.length + 1, kind: 'adset' as const, objectId: state.id, check: 'none' as const, raisesSpend: spends.raises, readBackInPost: false, budget: false, undoable: true }
    if (keys.length) {
      requests.push({
        ...base, label: `Placements of ${who}`, objectKind: 'adsetplacement', params: { targeting: merge.sent, ...softParam }, targetingKeys: keys,
        operation: 'adset.placements', readBackFields: softChanged ? 'id,targeting,placement_soft_opt_out' : 'id,targeting',
        judge: targetingJudge(setKeys, new Set(), softChanged ? { softOptOut: softNext && Object.keys(softNext).length ? softNext : null } : undefined),
      })
    } else {
      requests.push({
        ...base, label: `Limited spend on excluded placements of ${who}`, params: softParam,
        operation: 'adset.placementSoftOptOut', readBackFields: 'id,placement_soft_opt_out',
        judge: targetingJudge({}, new Set(), { softOptOut: softNext && Object.keys(softNext).length ? softNext : null }),
      })
    }
    before.push({ id: state.id, name: state.name, keys: Object.fromEntries(keys.map((k) => [k, t[k] ?? null])), ...(softChanged ? { softOptOut: softNow } : {}) })
    after.push({ id: state.id, name: state.name, keys: Object.fromEntries(keys.map((k) => [k, targetingView(merge.spec[k] ?? null)])), ...(softChanged ? { softOptOut: targetingView(softNext && Object.keys(softNext).length ? softNext : null) } : {}) })
    stands.push({ id: state.id, status: state.status, campaign: state.campaign?.status ?? null, placements: targetingView(Object.fromEntries(PLACEMENT_TARGETING_KEYS.map((k) => [k, t[k] ?? null]))), softOptOut: targetingView(softNow) })
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  if (!requests.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  if (requests.some((r) => r.operation === 'adset.placements')) warnings.push(REVIEW_SENTENCE, WHOLE_SENTENCE)
  const { changes, more } = changeLines(lines)
  return {
    summary: requests.length <= 3 ? `Meta: ${requests.map((r) => r.label).join('; ')}.` : `Meta: the placements of ${plural(requests.length, 'ad set')} — one request per ad set.`,
    changes,
    totals: { adSets: requests.length, requests: requests.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: uniq(warnings), spendsMoney, skipped, requests,
    stands: { adSets: stands, whatsapp: 'unread' in live.whatsapp ? 'unread' : live.whatsapp.status },
    before: { adSets: before } satisfies TargetingRecord,
    after: { adSets: after } satisfies TargetingRecord,
  }
}

/** Undo — each ad set's placement keys and limited spend put back from the record (keys whose view moved). */
export function placementRestoreArgs(before: TargetingRecord, after: TargetingRecord): Array<{ adSetId: string; restore?: Record<string, unknown>; restoreSoftOptOut?: Record<string, unknown> | null }> | { refusal: string } {
  const afterById = new Map((after.adSets ?? []).map((a) => [a.id, a]))
  const items: Array<{ adSetId: string; restore?: Record<string, unknown>; restoreSoftOptOut?: Record<string, unknown> | null }> = []
  for (const b of before.adSets ?? []) {
    const a = afterById.get(b.id)
    if (!a) continue
    const restore: Record<string, unknown> = {}
    for (const key of uniq([...Object.keys(b.keys), ...Object.keys(a.keys)])) {
      if (sameJson(targetingView(b.keys[key] ?? null), a.keys[key] ?? null)) continue
      if (!(PLACEMENT_TARGETING_KEYS as readonly string[]).includes(key)) return { refusal: `Undo cannot put ad set ${b.id}'s ${key} back with set-meta-placements.` }
      restore[key] = b.keys[key] ?? null
    }
    const item: { adSetId: string; restore?: Record<string, unknown>; restoreSoftOptOut?: Record<string, unknown> | null } = { adSetId: b.id }
    if (Object.keys(restore).length) item.restore = restore
    if ('softOptOut' in b && !sameJson(targetingView(b.softOptOut ?? null), a.softOptOut ?? null)) item.restoreSoftOptOut = plainObject(b.softOptOut) ? b.softOptOut : null
    if (item.restore || 'restoreSoftOptOut' in item) items.push(item)
  }
  return items.length ? items : { refusal: 'This change left every ad set\'s placements as they were: nothing to put back.' }
}
