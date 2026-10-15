/**
 * Google Ads changes (2026-10-15, programme 2 group G3) — responsive search ads changed where they are:
 *
 *   rsaEditDraft   edit ads IN PLACE (headlines, descriptions, pins, path1 / path2, final URL, final mobile URL): the ad
 *                  keeps its id, so Google's reports keep its numbers under it. Google reviews the changed ad again — so
 *                  an ENABLED ad of an enabled ad group and campaign that Google has not approved now (disapproved,
 *                  limited) can start serving once the new text is approved: SPENDS MONEY (2026-10-15 review).
 *   adMoveDraft    move ads from one ad group to another of the same Search campaign: Google cannot move an ad, so it is
 *                  the same ad made in the other ad group and the old one removed, in ONE request. The numbers stay with
 *                  the removed ad (Google keeps it as history only); the new ad starts from nothing. A removal: only when
 *                  the person asked (the tool's confirmRemove). Owner's rule for anything new: an enabled ad moved into an
 *                  ENABLED ad group of the ENABLED campaign is made PAUSED unless the request says `enable: true` (then
 *                  SPENDS MONEY); elsewhere it keeps its status.
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   MutateOperation     has `ad_operation` (AdOperation, "An ad mutate operation"); its result is `ad_result`
 *                       (MutateOperationResponse; JSON adResult).
 *   AdOperation         `update` only ("The ad is expected to have a valid resource name in this format:
 *                       customers/{customer_id}/ads/{ad_id}"), `update_mask`, `policy_validation_parameter`.
 *   Ad                  `responsive_search_ad` is NOT marked Immutable (text_ad, image_ad, expanded_dynamic_search_ad
 *                       are); `final_urls`, `final_mobile_urls`, `tracking_url_template`, `final_url_suffix`,
 *                       `url_custom_parameters` are not Immutable either; `id` and `type` are output only.
 *   ResponsiveSearchAdInfo  headlines[], descriptions[] (AdTextAsset: text, pinned_field), path1, path2 ("can only be set
 *                       when path1 is also set").
 *   Google's v25 code example "Update responsive search ad" (developers.google.com/google-ads/api/docs/samples/
 *                       update-responsive-search-ad) sends AdOperation.update with final_urls, final_mobile_urls and
 *                       responsive_search_ad headlines / descriptions, the update mask = the fields set — the paths
 *                       `responsive_search_ad.headlines`, `final_urls`, … (snake_case; a masked field left out of the
 *                       body is cleared: PLAN.md "v25 facts").
 *   AdGroupAd           create (ad_group, status, ad) and remove (customers/{c}/adGroupAds/{ad_group_id}~{ad_id}); the
 *                       moved ad is a new AdGroupAd.
 * The text rules (lengths, pins, duplicates, paths) are change-ads.ts's, checked on the ad as it would be after the edit.
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import {
  DESCRIPTION_PINS, HEADLINE_PINS, httpsUrlProblem, RSA_LIMITS, rsaTextProblems, shown, tagWarning, textAsset, textKey,
  type RsaPin, type RsaText,
} from './change-ads.js'
import type { LiveAdGroupPlace } from './live-ads-assets.js'
import type { LiveAdText, LiveEditAd } from './live-edit.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

const PINS: readonly string[] = [...HEADLINE_PINS, ...DESCRIPTION_PINS]
/** A text as read from Google, as Nexus writes it (a pin Nexus does not know is left out: Google's own place). */
export const rsaTextOf = (t: LiveAdText): RsaText => ({ text: t.text, ...(t.pin && PINS.includes(t.pin) ? { pin: t.pin as RsaPin } : {}) })
const sameTexts = (a: RsaText[], b: RsaText[]) =>
  a.length === b.length && a.every((t, i) => textKey(t.text) === textKey(b[i].text) && (t.pin ?? null) === (b[i].pin ?? null))
const blank = (s: string | null | undefined) => (s ?? '').trim() || null
const clip = (text: string, max = 60) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// ── edit in place ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface RsaEdit {
  /** The ad: `adGroupId~adId`. */
  id: string
  /** The whole new list of headlines (each with its pin, or none). */
  headlines?: RsaText[]
  descriptions?: RsaText[]
  /** null = no path1 (path2 then needs null too). */
  path1?: string | null
  path2?: string | null
  finalUrl?: string
  /** null = no separate page for mobile. */
  finalMobileUrl?: string | null
}
export interface RsaEditRequest { ads: RsaEdit[] }

/** Per ad, only the fields the change wrote: before what they were, after what it wrote. */
export interface RsaEditEntry {
  id: string
  campaignId: string
  headlines?: RsaText[]
  descriptions?: RsaText[]
  path1?: string | null
  path2?: string | null
  finalUrl?: string | null
  finalMobileUrl?: string | null
}
export interface RsaEditRecord { ads: RsaEditEntry[] }

export const MAX_EDIT_ADS = 20

/** An ad as it is now, in the shape of an edit entry with every field (undo reads the fields a record holds). */
export function rsaNow(ad: LiveEditAd): Required<RsaEditEntry> {
  return {
    id: ad.id,
    campaignId: ad.campaignId,
    headlines: ad.headlines.map(rsaTextOf),
    descriptions: ad.descriptions.map(rsaTextOf),
    path1: ad.path1,
    path2: ad.path2,
    finalUrl: ad.finalUrls[0] ?? null,
    finalMobileUrl: ad.finalMobileUrls[0] ?? null,
  }
}

const FIELD_WORD: Record<string, string> = { headlines: 'headlines', descriptions: 'descriptions', path1: 'path1', path2: 'path2', finalUrl: 'final URL', finalMobileUrl: 'final mobile URL' }

export function rsaEditDraft(customer: string, request: RsaEditRequest, live: { ads: LiveEditAd[] }): GoogleChangeDraft | { refusal: string } {
  const edits = request.ads ?? []
  if (!edits.length) return { refusal: 'Name at least one ad to edit (ads).' }
  if (edits.length > MAX_EDIT_ADS) return { refusal: `At most ${MAX_EDIT_ADS} ads in one request (${edits.length} asked).` }
  const byId = new Map(live.ads.map((a) => [a.id, a]))
  const seen = new Set<string>()
  const problems: string[] = []
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: RsaEditRecord = { ads: [] }
  const after: RsaEditRecord = { ads: [] }
  const touched = new Set<string>()

  for (const edit of edits) {
    if (seen.has(edit.id)) return { refusal: `Ad ${edit.id} is named twice.` }
    seen.add(edit.id)
    const ad = byId.get(edit.id)
    if (!ad) return { refusal: `Ad ${edit.id} is not in this account (or it is removed). google-ads-live view ads lists ads by adGroupId and adId.` }
    if (ad.type !== 'RESPONSIVE_SEARCH_AD') return { refusal: `Ad ${edit.id} is a ${ad.type ?? 'ad of unknown type'}: Nexus edits responsive search ads only.` }
    const asked = (['headlines', 'descriptions', 'path1', 'path2', 'finalUrl', 'finalMobileUrl'] as const).filter((k) => edit[k] !== undefined)
    if (!asked.length) return { refusal: `Ad ${edit.id}: say what changes (headlines, descriptions, path1, path2, finalUrl, finalMobileUrl).` }
    const now = rsaNow(ad)
    const where = `ad ${edit.id}`
    // The ad as it would be after the edit: Google's text rules are checked on it whole (a new pin can leave a
    // position empty; path2 needs path1 even when only path1 is cleared).
    const merged = {
      headlines: edit.headlines ?? now.headlines,
      descriptions: edit.descriptions ?? now.descriptions,
      path1: edit.path1 !== undefined ? blank(edit.path1) : now.path1,
      path2: edit.path2 !== undefined ? blank(edit.path2) : now.path2,
    }
    if (asked.some((k) => k !== 'finalUrl' && k !== 'finalMobileUrl')) problems.push(...rsaTextProblems(merged, where))
    if (edit.finalUrl !== undefined) { const p = httpsUrlProblem(where, edit.finalUrl); if (p) problems.push(p) }
    if (edit.finalMobileUrl) { const p = httpsUrlProblem(`${where}, mobile`, edit.finalMobileUrl); if (p) problems.push(p) }
    if (problems.length) continue

    const update: Record<string, unknown> = { resourceName: `${customer}/ads/${ad.adId}` }
    const rsa: Record<string, unknown> = {}
    const mask: string[] = []
    const was: RsaEditEntry = { id: ad.id, campaignId: ad.campaignId }
    const is: RsaEditEntry = { id: ad.id, campaignId: ad.campaignId }
    const label = `ad ${ad.id} ("${clip(now.headlines[0]?.text ?? '', 30)}")`
    if (edit.headlines && !sameTexts(edit.headlines, now.headlines)) {
      rsa.headlines = edit.headlines.map(textAsset)
      mask.push('responsive_search_ad.headlines')
      was.headlines = now.headlines
      is.headlines = edit.headlines.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pin: t.pin } : {}) }))
      lines.push([`${label} headlines`, shown(now.headlines), shown(edit.headlines)])
    }
    if (edit.descriptions && !sameTexts(edit.descriptions, now.descriptions)) {
      rsa.descriptions = edit.descriptions.map(textAsset)
      mask.push('responsive_search_ad.descriptions')
      was.descriptions = now.descriptions
      is.descriptions = edit.descriptions.map((t) => ({ text: t.text.trim(), ...(t.pin ? { pin: t.pin } : {}) }))
      lines.push([`${label} descriptions`, shown(now.descriptions), shown(edit.descriptions)])
    }
    for (const key of ['path1', 'path2'] as const) {
      if (edit[key] === undefined || merged[key] === now[key]) continue
      if (merged[key]) rsa[key] = merged[key]
      mask.push(`responsive_search_ad.${key}`)
      was[key] = now[key]
      is[key] = merged[key]
      lines.push([`${label} ${key}`, now[key] ?? '(none)', merged[key] ?? '(none)'])
    }
    if (mask.length) update.responsiveSearchAd = rsa
    if (edit.finalUrl !== undefined && edit.finalUrl.trim() !== now.finalUrl) {
      update.finalUrls = [edit.finalUrl.trim()]
      mask.push('final_urls')
      was.finalUrl = now.finalUrl
      is.finalUrl = edit.finalUrl.trim()
      lines.push([`${label} final URL`, now.finalUrl ?? '(none)', edit.finalUrl.trim()])
    }
    const mobile = edit.finalMobileUrl === undefined ? undefined : blank(edit.finalMobileUrl)
    if (mobile !== undefined && mobile !== now.finalMobileUrl) {
      if (mobile) update.finalMobileUrls = [mobile]
      mask.push('final_mobile_urls')
      was.finalMobileUrl = now.finalMobileUrl
      is.finalMobileUrl = mobile
      lines.push([`${label} final mobile URL`, now.finalMobileUrl ?? '(none)', mobile ?? '(none: the final URL on every device)'])
    }
    if (!mask.length) { skipped.push(`Ad ${ad.id} already reads so (${asked.map((k) => FIELD_WORD[k]).join(', ')}).`); continue }
    operations.push({ adOperation: { update, updateMask: mask.join(',') } })
    before.ads.push(was)
    after.ads.push(is)
    touched.add(ad.id)
    const texts: Array<[string, string | null | undefined]> = [
      ...(is.headlines ?? []).map((t, j): [string, string] => [`${where}, headline ${j + 1}`, t.text]),
      ...(is.descriptions ?? []).map((t, j): [string, string] => [`${where}, description ${j + 1}`, t.text]),
      [`${where}, path1`, is.path1], [`${where}, path2`, is.path2],
    ]
    for (const [w, text] of texts) { const t = tagWarning(w, text); if (t) warnings.push(t) }
  }
  if (problems.length) return { refusal: `Not queued — the edits break Google's rules (nothing was sent): ${problems.join('; ')}.` }
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  const n = after.ads.length
  // An edit sends the ad to Google's review again: one Google does not approve now, enabled where it can serve, may start
  // serving once the new text is approved.
  const spendsMoney = live.ads.filter((a) => touched.has(a.id) && a.status === 'ENABLED' && a.adGroupStatus === 'ENABLED' && a.campaignStatus === 'ENABLED' && a.approval !== 'APPROVED')
    .map((a) => `Ad ${a.id} ("${clip(a.headlines[0]?.text ?? '', 30)}") is ENABLED in the enabled ad group "${a.adGroupName}" of the enabled campaign "${a.campaignName}", and Google has not approved it now (${a.approval ?? 'no verdict'}): the edit sends it to review again, and once approved it shows (and spends).`)
  warnings.unshift(`Each ad keeps its id, so its numbers stay with it. Google reviews ${n === 1 ? 'the changed ad' : `the ${n} changed ads`} again: google-ads-live view ads shows the review.`)
  const urlsChanged = after.ads.filter((a) => a.finalUrl !== undefined).length
  if (urlsChanged) warnings.push(`${plural(urlsChanged, 'ad')} ${urlsChanged === 1 ? 'leads' : 'lead'} to another page from now (final URL).`)
  const { changes, more } = changeLines(lines)
  const fields = [...new Set(after.ads.flatMap((a) => Object.keys(a).filter((k) => k in FIELD_WORD).map((k) => FIELD_WORD[k])))]
  return {
    summary: `Google Ads: edit ${plural(n, 'responsive search ad')} in place (${fields.join(', ')}); ${n === 1 ? 'it keeps its' : 'each keeps its'} id and numbers.`,
    changes,
    totals: { operations: operations.length, ads: n, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney,
    skipped,
    operations,
    // Each edited ad as it is now (the from side, and the record undo reads), with what the SPENDS MONEY words stand on.
    stands: live.ads.filter((a) => touched.has(a.id)).map((a) => ({ ...rsaNow(a), status: a.status, type: a.type, approval: a.approval, adGroupStatus: a.adGroupStatus, campaignStatus: a.campaignStatus })),
    before,
    after,
  }
}

// ── move to another ad group ──────────────────────────────────────────────────────────────────────────────────────

export interface AdMoveRequest {
  campaignId: string
  /** The ad group the ads are in now. */
  adGroupId: string
  toAdGroupId: string
  /** The ads (their ad ids in adGroupId). */
  adIds: string[]
  /** An enabled ad moved into an enabled ad group of the enabled campaign stays ENABLED only with this (SPENDS MONEY). */
  enable?: boolean
  /** Only the undo of an earlier move: the status each ad had before it (by its ad id in adGroupId). */
  statusOf?: Record<string, 'ENABLED' | 'PAUSED'>
}

export interface AdMoveLiveState {
  from: LiveAdGroupPlace | null
  to: LiveAdGroupPlace | null
  fromAds: LiveEditAd[]
  toAds: LiveEditAd[]
}

export interface AdMoveRecord {
  campaignId: string
  fromAdGroupId: string
  toAdGroupId: string
  /** Each moved ad: its id in the ad group it left, its new id (`op:<index>` until Google gave it), its new status, the status it had. */
  moved: Array<{ fromAdId: string; toAdId: string; status: string; fromStatus: string }>
}
export interface AdMoveBefore { campaignId: string; fromAdGroupId: string; toAdGroupId: string; ads: Array<{ adId: string; status: string | null }> }

export const MAX_MOVE_ADS = 10
const OP = 'op:'

/** The ad as a new AdGroupAd's `ad`: every field of it a person set (texts, pins, paths, URLs and tracking). */
function adCopy(ad: LiveEditAd): Record<string, unknown> {
  return {
    finalUrls: ad.finalUrls,
    ...(ad.finalMobileUrls.length ? { finalMobileUrls: ad.finalMobileUrls } : {}),
    ...(ad.urls.trackingTemplate ? { trackingUrlTemplate: ad.urls.trackingTemplate } : {}),
    ...(ad.urls.finalUrlSuffix ? { finalUrlSuffix: ad.urls.finalUrlSuffix } : {}),
    ...(ad.urls.customParameters.length ? { urlCustomParameters: ad.urls.customParameters } : {}),
    responsiveSearchAd: {
      headlines: ad.headlines.map(rsaTextOf).map(textAsset),
      descriptions: ad.descriptions.map(rsaTextOf).map(textAsset),
      ...(ad.path1 ? { path1: ad.path1 } : {}),
      ...(ad.path1 && ad.path2 ? { path2: ad.path2 } : {}),
    },
  }
}

export function adMoveDraft(customer: string, request: AdMoveRequest, live: AdMoveLiveState): GoogleChangeDraft | { refusal: string } {
  const ids = [...new Set(request.adIds ?? [])]
  if (!ids.length) return { refusal: 'Name the ads to move (adIds).' }
  if (ids.length > MAX_MOVE_ADS) return { refusal: `At most ${MAX_MOVE_ADS} ads in one move (${ids.length} asked).` }
  if (request.adGroupId === request.toAdGroupId) return { refusal: 'The ads are in that ad group already: name another ad group (toAdGroupId).' }
  const { from, to } = live
  if (!from) return { refusal: `Ad group ${request.adGroupId} is not in campaign ${request.campaignId} (or one of them is removed). google-ads-live view campaign lists its ad groups.` }
  if (!to) return { refusal: `Ad group ${request.toAdGroupId} is not in campaign ${request.campaignId} (or it is removed): ads move within one campaign.` }
  const campaign = to.campaign
  if (campaign.type !== 'SEARCH') return { refusal: `Responsive search ads move between Search ad groups only: "${campaign.name}" is a ${campaign.type ?? 'campaign of unknown'} campaign.` }
  if (to.adGroup.type !== 'SEARCH_STANDARD') return { refusal: `Responsive search ads go in standard Search ad groups: "${to.adGroup.name}" is ${to.adGroup.type ?? 'of an unknown type'}.` }
  const byId = new Map(live.fromAds.map((a) => [a.adId, a]))
  const moving: LiveEditAd[] = []
  for (const adId of ids.sort((a, b) => (a.length - b.length) || a.localeCompare(b))) {
    const ad = byId.get(adId)
    if (!ad) return { refusal: `Ad ${adId} is not in ad group "${from.adGroup.name}" (or it is removed). google-ads-live view ads lists them.` }
    if (ad.type !== 'RESPONSIVE_SEARCH_AD') return { refusal: `Ad ${adId} is a ${ad.type ?? 'ad of unknown type'}: Nexus moves responsive search ads only.` }
    if (ad.status !== 'ENABLED' && ad.status !== 'PAUSED') return { refusal: `Ad ${adId} is ${String(ad.status ?? 'in an unknown state').toLowerCase()}: only an enabled or paused ad is moved.` }
    moving.push(ad)
  }
  // The status each new ad gets: the one it had (or, for an undo, the one the record says), but PAUSED where it would
  // serve at once (enabled ad group of the enabled campaign) unless the request says enable (Owner's rule for new things).
  const serves = campaign.status === 'ENABLED' && to.adGroup.status === 'ENABLED'
  const statusOf = new Map(moving.map((a) => {
    const wanted = request.statusOf?.[a.adId] ?? (a.status as 'ENABLED' | 'PAUSED')
    return [a.adId, wanted === 'ENABLED' && serves && !request.enable ? 'PAUSED' : wanted] as const
  }))
  const pausedByRule = moving.filter((a) => (request.statusOf?.[a.adId] ?? a.status) === 'ENABLED' && statusOf.get(a.adId) === 'PAUSED')
  const enabledThere = live.toAds.filter((a) => a.status === 'ENABLED' && a.type === 'RESPONSIVE_SEARCH_AD').length
  const enabledMoving = moving.filter((a) => statusOf.get(a.adId) === 'ENABLED').length
  if (enabledMoving && enabledThere + enabledMoving > RSA_LIMITS.enabledPerAdGroup) {
    return { refusal: `Google allows ${RSA_LIMITS.enabledPerAdGroup} enabled responsive search ads per ad group: "${to.adGroup.name}" has ${enabledThere} and this would move ${enabledMoving} enabled ones in. Pause some first (set-google-status), or move fewer.` }
  }

  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const record: AdMoveRecord = { campaignId: campaign.campaignId, fromAdGroupId: from.adGroup.adGroupId, toAdGroupId: to.adGroup.adGroupId, moved: [] }
  // The new ads first (a failure leaves the old ones: all or nothing anyway), the removals after.
  for (const ad of moving) {
    const status = statusOf.get(ad.adId)!
    operations.push({ adGroupAdOperation: { create: { adGroup: `${customer}/adGroups/${to.adGroup.adGroupId}`, status, ad: adCopy(ad) } } })
    record.moved.push({ fromAdId: ad.adId, toAdId: `${OP}${operations.length - 1}`, status, fromStatus: ad.status! })
    lines.push([`ad ${ad.adId} ("${clip(ad.headlines[0]?.text ?? '', 30)}")`, `in "${from.adGroup.name}", ${ad.status}`, `in "${to.adGroup.name}", ${status} (a new ad)`])
  }
  for (const ad of moving) operations.push({ adGroupAdOperation: { remove: `${customer}/adGroupAds/${from.adGroup.adGroupId}~${ad.adId}` } })

  const warnings = [
    `Google cannot move an ad: each is made again in "${to.adGroup.name}" (a new ad id) and REMOVED from "${from.adGroup.name}" in this one request. The numbers (clicks, cost, conversions) and labels stay with the removed ${moving.length === 1 ? 'ad' : 'ads'}, which Google keeps only as history (labels are not carried over); the new ${moving.length === 1 ? 'one starts' : 'ones start'} from nothing and Google reviews ${moving.length === 1 ? 'it' : 'them'}.`,
  ]
  if (pausedByRule.length) {
    warnings.push(`${plural(pausedByRule.length, 'enabled ad')} ${pausedByRule.length === 1 ? 'is' : 'are'} made PAUSED in "${to.adGroup.name}" (the campaign and that ad group are enabled): ${pausedByRule.length === 1 ? 'its' : 'their'} traffic stops until a person enables ${pausedByRule.length === 1 ? 'it' : 'them'} (set-google-status), or ask again with enable: true (SPENDS MONEY).`)
  }
  const leftEnabled = live.fromAds.filter((a) => a.status === 'ENABLED' && !moving.some((m) => m.adId === a.adId)).length
  if (leftEnabled === 0) warnings.push(`"${from.adGroup.name}" has no enabled ad left: it shows no ads until one is enabled or made.`)
  const spendsMoney: string[] = []
  if (enabledMoving && serves) {
    spendsMoney.push(`Moves ${plural(enabledMoving, 'enabled ad')} into the enabled ad group "${to.adGroup.name}" of the enabled campaign "${campaign.name}": ${enabledMoving === 1 ? 'it shows' : 'they show'} (and spend${enabledMoving === 1 ? 's' : ''}) there as soon as Google approves ${enabledMoving === 1 ? 'it' : 'them'}.`)
  }
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: move ${plural(moving.length, 'responsive search ad')} from "${from.adGroup.name}" to "${to.adGroup.name}" in "${campaign.name}" (made again there, removed here).`,
    changes,
    totals: { operations: operations.length, adsMoved: moving.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney,
    skipped: [],
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type },
      from: { adGroupId: from.adGroup.adGroupId, status: from.adGroup.status, ads: live.fromAds.map((a) => `${a.adId}:${a.status}`) },
      to: { adGroupId: to.adGroup.adGroupId, status: to.adGroup.status, type: to.adGroup.type, ads: live.toAds.map((a) => `${a.adId}:${a.status}:${a.type}`) },
      // What is copied: a later edit of a moved ad changes the request.
      moving: moving.map((a) => ({ ...rsaNow(a), urls: a.urls })),
    },
    before: { campaignId: campaign.campaignId, fromAdGroupId: from.adGroup.adGroupId, toAdGroupId: to.adGroup.adGroupId, ads: moving.map((a) => ({ adId: a.adId, status: a.status })) } satisfies AdMoveBefore,
    after: record,
  }
}

/** The record of a run, with the ad id Google gave each new ad (`adGroupAdResult` of the operation that made it). */
export function adMoveRecordAfterRun(after: AdMoveRecord, responses: GoogleMutateResponse[]): AdMoveRecord {
  const idAt = (index: number): string | null => {
    const name = responses[index]?.adGroupAdResult?.resourceName
    return name && name.includes('~') ? name.slice(name.lastIndexOf('~') + 1) : null
  }
  return {
    ...after,
    moved: after.moved.map((m) => ({ ...m, toAdId: m.toAdId.startsWith(OP) ? idAt(Number(m.toAdId.slice(OP.length))) ?? m.toAdId : m.toAdId })),
  }
}
