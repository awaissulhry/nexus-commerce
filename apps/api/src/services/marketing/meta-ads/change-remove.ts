/**
 * Meta step 22 — remove-meta-ads-items as a draft: what a person asked to DELETE (campaigns, ad sets, ads, creatives, images
 * of the ad account's library by their hash, videos of that library, caption languages of such a video, parts of an
 * Instant Experience of the chosen Page), checked against the live state (live-remove.ts) and turned into one request per
 * object, in order. Pure: no reads.
 *
 *   - EVERY ad set and ad that goes with a campaign or an ad set is listed (alsoDeleted), archived ones too, with what
 *     delivers now; an ad set or ad whose campaign or ad set is deleted in the same change goes with it (not sent twice).
 *   - Refused in words, the whole change (nothing is deleted): what Meta refuses — an ad of an ad set with an ad sequence,
 *     a dynamic creative ad alone (1340029), a creative an ad uses that this change does not delete, an image a creative
 *     uses that this change does not delete — and what Nexus refuses on its own: a video an ad shows that this change does
 *     not delete (review B1; Meta does not document it), anything Nexus cannot place in the chosen ad account (or Page).
 *   - Skipped in words: what is already deleted or no longer there; caption languages the video does not have. A caption
 *     delete names the ads that show the video (they change at once).
 *   - Order: ads, ad sets, campaigns, then creatives (each after the deletes of the ads that use it: `needs`), images
 *     (after the creatives that use them), caption languages, videos (after the ads that show them), Instant Experience
 *     parts. Meta has no
 *     all-or-nothing request: each is its own, and one that stands on an earlier step goes only when that step happened.
 *   - A deletion is final: no undo (reversibility 'none'). Nothing here can make the account spend more.
 *
 * Meta facts: live-remove.ts and gateway/meta-remove-rules.ts headers (checked 2026-10-21).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { REMOVE_WORD, type AdsUsing, type CreativeUser, type RemoveCreative, type RemoveImage, type RemoveObject, type RemoveObjectKind } from './live-remove.js'

export const REMOVE_KINDS = ['campaign', 'adset', 'ad', 'creative', 'image', 'video', 'captions', 'canvaselement'] as const
export type RemoveKind = typeof REMOVE_KINDS[number]

/** One thing to delete: a campaign, ad set, ad, creative, video or Instant Experience part by its id; an image by its hash; caption languages of a video. */
export interface RemoveItem { kind: RemoveKind; id?: string; hash?: string; locales?: string[] }
export interface RemoveRequest { items: RemoveItem[] }

/** The most images and videos one request takes out of the library (Nexus paces them 30 s apart, see below). */
export const MAX_LIBRARY_ITEMS = 10
/** The most other creatives Nexus reads to tell whether a creative Meta lists on an image is deleted already. */
export const MAX_IMAGE_CREATIVES = 10

/** What the reads found (live-remove.ts), for the items asked. */
export interface RemoveLive {
  adAccountId: string
  objects: Map<string, RemoveObject>
  creatives: Map<string, RemoveCreative>
  /**
   * The account's ads by the creative they use (read when a creative is named), and by the videos their creatives show
   * (`byVideo`, read when a video or its captions are named).
   */
  adsByCreative: AdsUsing | null
  /** The library's images by hash (read when an image is named). */
  images: Map<string, RemoveImage>
  /** Creatives Meta lists on a named image that this change does not delete: their status now (null: unread). */
  imageCreatives: Map<string, { status: string | null; ours: boolean } | null>
  /** Which of the named videos are in the chosen ad account's library (read when a video or captions are named). */
  library: { has: Set<string>; more: boolean } | null
  /** A named video's caption languages, or Meta's words. */
  captions: Map<string, { locales: string[] } | { unread: string }>
  /** The chosen Page and which of the named Instant Experience parts are its own (read when one is named). */
  page: { pageId: string; has: Set<string>; more: boolean } | { unread: string } | null
  /** Problems of the reads, in words (the change is then refused). */
  problems: string[]
}

/** What a delete records (AgentChange before / after): every object it deleted, with what went with it. */
export interface RemoveRecord {
  op: 'remove'
  items: Array<{ kind: RemoveKind; id: string; name?: string | null; status?: string | null; locales?: string[]; adSets?: number; ads?: number }>
}

const quoted = (name: string | null) => (name ? `"${name}" ` : '')
const who = (o: { kind: RemoveObjectKind; id: string; name: string | null }) => `${REMOVE_WORD[o.kind]} ${quoted(o.name)}(${o.id})`
const cap = (s: string) => `${s[0].toUpperCase()}${s.slice(1)}`
const firstIds = (ids: string[], n = 5) => `${ids.slice(0, n).join(', ')}${ids.length > n ? `, … (${ids.length} in all)` : ''}`
/**
 * Every Nexus delete has no check (Meta documents validate_only on creates and campaign updates only) and no undo. A
 * request's `kind` is the kit's status kind (campaign, adset, ad); what a creative, library or Instant Experience request
 * deletes is named by `objectKind` (the gateway confirms it) and its `operation` — as step 19's background copy does.
 */
const deleteOf = (r: Omit<MetaChangeRequest, 'method' | 'check' | 'raisesSpend' | 'readBackInPost' | 'budget' | 'undoable'>): MetaChangeRequest => ({
  ...r, method: 'DELETE' as const, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false,
})

/** The totals' key per kind. */
const TOTAL_KEY: Readonly<Record<RemoveKind, string>> = {
  campaign: 'campaigns', adset: 'adSets', ad: 'ads', creative: 'creatives', image: 'images', video: 'videos', captions: 'videosCaptions', canvaselement: 'instantExperienceParts',
}

/** A key per item (the same thing asked twice is one). */
const keyOf = (i: RemoveItem) => (i.kind === 'image' ? `image:${i.hash}` : `${i.kind}:${i.id}`)

export function metaRemoveDraft(request: RemoveRequest, live: RemoveLive): MetaChangeDraft | { refusal: string } {
  if (!request.items.length) return { refusal: 'Name at least one thing to delete.' }
  const items: RemoveItem[] = []
  for (const i of request.items) if (!items.some((x) => keyOf(x) === keyOf(i))) items.push(i)
  const library = items.filter((i) => i.kind === 'image' || i.kind === 'video').length
  if (library > MAX_LIBRARY_ITEMS) {
    return { refusal: `At most ${MAX_LIBRARY_ITEMS} images and videos in one request: Nexus sends each to the ad account's library 30 s after the one before (its own pacing — Meta documents one edit per object every 30 s, and whether the library counts as one object is not verified), so ${library} would take ${Math.ceil(library / 2)} minutes. Ask for the rest in another request.` }
  }
  const problems = [...live.problems]
  const skipped: string[] = []
  const warnings: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const requests: MetaChangeRequest[] = []
  const recorded: RemoveRecord['items'] = []
  const stands: Record<string, unknown> = {}
  const alsoDeleted: Array<{ deleting: string; adSets: Array<Omit<RemoveChildOut, 'kind'>>; ads: Array<Omit<RemoveChildOut, 'kind'>> }> = []

  // ── campaigns, ad sets, ads ──
  const named = (kind: RemoveObjectKind) => items.filter((i) => i.kind === kind).map((i) => live.objects.get(`${kind}:${i.id}`)).filter((o): o is RemoveObject => !!o)
  const alive = (o: RemoveObject) => o.status !== 'DELETED'
  for (const o of [...named('campaign'), ...named('adset'), ...named('ad')]) if (!alive(o)) skipped.push(`${cap(who(o))} is deleted already.`)
  const campaigns = named('campaign').filter(alive)
  const campaignIds = new Set(campaigns.map((c) => c.id))
  // An ad set or ad whose campaign (or ad set) is deleted in this change goes with it: said, not sent.
  const adSets = named('adset').filter(alive).filter((s) => {
    if (s.campaignId && campaignIds.has(s.campaignId)) { skipped.push(`${cap(who(s))} goes with its campaign (${s.campaignId}), deleted in this change.`); return false }
    return true
  })
  const adSetIds = new Set([...adSets.map((s) => s.id), ...named('adset').filter(alive).map((s) => s.id)])
  const ads = named('ad').filter(alive).filter((a) => {
    if (a.campaignId && campaignIds.has(a.campaignId)) { skipped.push(`${cap(who(a))} goes with its campaign (${a.campaignId}), deleted in this change.`); return false }
    if (a.adSetId && adSetIds.has(a.adSetId)) { skipped.push(`${cap(who(a))} goes with its ad set (${a.adSetId}), deleted in this change.`); return false }
    return true
  })
  for (const a of ads) if (a.undeletable) problems.push(`${cap(who(a))}: ${a.undeletable}`)
  for (const o of [...adSets, ...campaigns]) {
    if (o.childrenMore) problems.push(`${cap(who(o))} holds more ad sets or ads than Nexus lists at once (500 a list): Nexus deletes nothing without listing everything that goes with it — delete its ad sets in smaller requests first.`)
  }

  /** Which step deletes an ad (named, or under a campaign or ad set deleted in this change). */
  const adStep = new Map<string, number>()
  /** The ad sets this change deletes (review A4: a campaign budget's share moves only to ad sets that stay). */
  const goingAdSets = new Set(adSets.map((s) => s.id))
  const delivering: string[] = []
  const addObject = (o: RemoveObject) => {
    const step = requests.length + 1
    const childAdSets = o.children.filter((c) => c.kind === 'adset')
    const childAds = o.children.filter((c) => c.kind === 'ad')
    const withWords = o.kind === 'campaign' ? ` with its ${plural(childAdSets.length, 'ad set')} and ${plural(childAds.length, 'ad')}` : o.kind === 'adset' ? ` with its ${plural(childAds.length, 'ad')}` : ''
    requests.push(deleteOf({ step, label: `Delete ${who(o)}${withWords}`, kind: o.kind, objectId: o.id, params: {}, operation: `${o.kind}.delete` }))
    if (o.kind === 'ad') adStep.set(o.id, step)
    for (const c of childAds) adStep.set(c.id, step)
    lines.push([cap(who(o)), `${o.status ?? 'unknown'}${o.effectiveStatus && o.effectiveStatus !== o.status ? ` (${o.effectiveStatus})` : ''}`, `deleted${withWords}`])
    recorded.push({ kind: o.kind, id: o.id, name: o.name, status: o.status, ...(o.kind === 'ad' ? {} : { ads: childAds.length }), ...(o.kind === 'campaign' ? { adSets: childAdSets.length } : {}) })
    if (o.kind !== 'ad') {
      alsoDeleted.push({ deleting: who(o), adSets: childAdSets.map(childOut), ads: childAds.map(childOut) })
    }
    const selfOn = o.effectiveStatus === 'ACTIVE'
    const kidsOn = o.children.filter((c) => c.effectiveStatus === 'ACTIVE').length
    if (selfOn || kidsOn) delivering.push(`${who(o)}${selfOn ? ' (it delivers now)' : ''}${kidsOn ? `${selfOn ? ' and' : ','} ${plural(kidsOn, 'ad set or ad', 'ad sets and ads')} under it that deliver now` : ''}`)
    stands[`${o.kind}:${o.id}`] = { status: o.status, effectiveStatus: o.effectiveStatus, children: o.children.map((c) => `${c.kind}:${c.id}:${c.effectiveStatus}:${c.creativeId ?? ''}`).sort(), undeletable: !!o.undeletable, campaignBudget: o.campaignBudget }
    if (o.campaignBudget) {
      const b = o.campaignBudget
      const staying = b.otherAdSets.filter((s) => !goingAdSets.has(s.id))
      const going = b.otherAdSets.length - staying.length
      const others = staying.length
      const othersOn = staying.filter((s) => s.effectiveStatus === 'ACTIVE').length
      const alsoGoing = going ? ` (${plural(going, 'other ad set')} of it ${going === 1 ? 'goes' : 'go'} in this change too)` : ''
      warnings.push(others || b.more
        ? `${cap(who(o))} is under its campaign's budget (campaign ${quoted(b.name)}${b.campaignId}): Meta spreads that budget over the campaign's ${b.more ? 'other ad sets (more than 500)' : `${plural(others, 'ad set')} that stay${others === 1 ? 's' : ''}`}${b.more ? '' : ` (${othersOn} deliver${othersOn === 1 ? 's' : ''} now)`}${alsoGoing} — the campaign's total budget stays the same, its share moves to them. Should the campaign budget later be switched off, Meta asks budgets only for the ad sets that remain.`
        : `${cap(who(o))}${going ? ' and the other ad sets this change deletes are the last' : ' is the last ad set'} of its campaign (${quoted(b.name)}${b.campaignId}), which has a campaign budget: after this change the campaign has no ad set left to deliver (its budget stays set, nothing spends).`)
    }
    if (o.legacy) {
      warnings.push(`${cap(who(o))} is a legacy Advantage+ ${o.legacy === 'SMART_APP_PROMOTION' ? 'app' : 'shopping'} campaign (${o.legacy}): Meta blocks edits of these through its API in v26; whether a delete counts as one is not documented — Meta's answer will say.`)
    }
  }
  for (const o of [...ads, ...adSets, ...campaigns]) addObject(o)
  if (requests.length) {
    warnings.push(delivering.length
      ? `Stops delivering at once: ${delivering.join('; ')}.`
      : 'Nothing of what is deleted delivers now (paused, archived, in review or stopped by a parent).')
  }

  // ── creatives ──
  const creativeStep = new Map<string, number>()
  for (const i of items.filter((x) => x.kind === 'creative')) {
    const c = live.creatives.get(i.id!)
    if (!c) continue
    if (c.status === 'DELETED') { skipped.push(`Creative ${quoted(c.name)}(${c.id}) is deleted already.`); continue }
    if (!live.adsByCreative) { problems.push(`Nexus could not read which ads use creative ${c.id}.`); continue }
    const users = live.adsByCreative.byCreative.get(c.id) ?? []
    const blocking = users.filter((u) => !adStep.has(u.id))
    if (live.adsByCreative.more) {
      problems.push(`Creative ${quoted(c.name)}(${c.id}): the ad account has more than 500 ads, so Nexus cannot confirm no other ad uses it — Meta refuses to delete a creative active ads use, and Nexus deletes no creative an ad still uses.`)
      continue
    }
    if (blocking.length) {
      problems.push(`Creative ${quoted(c.name)}(${c.id}) is used by ${plural(blocking.length, 'ad')} this change does not delete (${firstIds(blocking.map((u) => `${u.id}${u.effectiveStatus ? ` ${u.effectiveStatus}` : ''}`))}): Meta refuses to delete a creative active ads use ("pause or delete the associated ads first"), and Nexus deletes no creative an ad still uses — delete those ads in the same request, or keep the creative.`)
      continue
    }
    const needs = [...new Set(users.map((u) => adStep.get(u.id)!))].sort((a, b) => a - b)
    const step = requests.length + 1
    requests.push(deleteOf({ step, label: `Delete creative ${quoted(c.name)}(${c.id})`, kind: 'ad', objectKind: 'creative', objectId: c.id, params: {}, operation: 'creative.delete', ...(needs.length ? { needs } : {}) }))
    creativeStep.set(c.id, step)
    lines.push([`Creative ${quoted(c.name)}(${c.id})`, c.status ?? 'unknown', `deleted${needs.length ? ` (after the ${plural(users.length, 'ad')} that use${users.length === 1 ? 's' : ''} it, step ${needs.join(', ')})` : ''}`])
    recorded.push({ kind: 'creative', id: c.id, name: c.name, status: c.status })
    stands[`creative:${c.id}`] = { status: c.status, users: users.map((u) => u.id).sort() }
  }
  if (creativeStep.size) warnings.push('A creative alone never spends: deleting one takes nothing off the air; an ad that used it is deleted first in this same change.')

  // ── images (by hash, out of the chosen ad account's library) ──
  for (const i of items.filter((x) => x.kind === 'image')) {
    const hash = i.hash!
    const image = live.images.get(hash)
    if (!image) { skipped.push(`Image ${hash} is not in the chosen ad account's library (deleted already, or never there): nothing to delete.`); continue }
    if (image.status === 'DELETED') { skipped.push(`Image ${quoted(image.name)}(${hash}) is deleted already.`); continue }
    const inChange = image.creatives.filter((c) => creativeStep.has(c))
    const others = image.creatives.filter((c) => !creativeStep.has(c))
    if (others.length > MAX_IMAGE_CREATIVES) { problems.push(`Image ${quoted(image.name)}(${hash}): Meta lists ${others.length} creatives that use it — Meta deletes only an image no creative uses.`); continue }
    // A creative Meta still lists on the image but deleted already (read now, or named here and found deleted) is no user.
    const statusOf = (c: string) => live.imageCreatives.get(c) ?? (live.creatives.get(c) ? { status: live.creatives.get(c)!.status, ours: true } : null)
    const blocking = others.filter((c) => statusOf(c)?.status !== 'DELETED')
    if (blocking.length) {
      problems.push(`Image ${quoted(image.name)}(${hash}) is used by ${plural(blocking.length, 'creative')} this change does not delete (${firstIds(blocking)}${blocking.some((c) => statusOf(c) === null) ? '; Nexus could not read some of them' : ''}): Meta deletes only an image no creative uses — delete those creatives in the same request (and the ads that use them), or keep the image.`)
      continue
    }
    const needs = inChange.map((c) => creativeStep.get(c)!).sort((a, b) => a - b)
    requests.push(deleteOf({ step: requests.length + 1, label: `Delete image ${quoted(image.name)}(${hash}) from the ad account's library`, kind: 'ad', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`, edge: 'adimages', params: { hash }, operation: 'image.delete', ...(needs.length ? { needs } : {}) }))
    lines.push([`Image ${quoted(image.name)}(${hash})`, 'in the library', 'deleted from the library'])
    recorded.push({ kind: 'image', id: hash, name: image.name, status: image.status })
    stands[`image:${hash}`] = { status: image.status, creatives: [...image.creatives].sort(), others: others.map((c) => `${c}:${statusOf(c)?.status ?? ''}`).sort() }
  }

  /** Review B1 — the ads that show a video (read with their creatives' video fields), or why Nexus cannot say. */
  const videoUsers = (id: string): { users: CreativeUser[] } | { problem: string } => {
    const a = live.adsByCreative
    if (!a?.byVideo) return { problem: `Nexus could not read which ads show video ${id}.` }
    if (a.more) return { problem: `Video ${id}: the ad account has more than 500 ads, so Nexus cannot confirm no other ad shows it — it removes no video an ad may still show.` }
    return { users: a.byVideo.get(id) ?? [] }
  }

  // ── caption languages of a video (POST /{video_id}/captions locales_to_delete) ──
  for (const i of items.filter((x) => x.kind === 'captions')) {
    const id = i.id!
    if (!live.library || !live.library.has.has(id)) {
      problems.push(`Video ${id} is not ${live.library?.more ? 'among the first 500 videos' : 'in the video library'} of the chosen ad account: Nexus changes the captions only of the account's own videos (Meta lets an advertiser of the account that owns the video change them).`)
      continue
    }
    const read = live.captions.get(id)
    if (!read || 'unread' in read) { problems.push(`Nexus could not read the caption languages of video ${id}${read && 'unread' in read ? `: ${read.unread}` : ''}.`); continue }
    const asked = [...new Set(i.locales ?? [])]
    const there = asked.filter((l) => read.locales.includes(l))
    for (const l of asked.filter((x) => !read.locales.includes(x))) skipped.push(`Video ${id} has no ${l} captions: nothing to delete.`)
    if (!there.length) continue
    requests.push({
      step: requests.length + 1, label: `Delete the ${there.join(', ')} captions of video ${id}`, kind: 'ad', objectKind: 'video', objectId: id, edge: 'captions',
      params: { locales_to_delete: JSON.stringify(there) }, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'captions.delete',
    })
    lines.push([`Captions of video ${id}`, read.locales.join(', ') || 'none', read.locales.filter((l) => !there.includes(l)).join(', ') || 'none'])
    recorded.push({ kind: 'captions', id, locales: there })
    // Review B1 — a caption language goes off every ad that shows the video, at once: those ads are named.
    const shown = live.adsByCreative?.byVideo ? live.adsByCreative.byVideo.get(id) ?? [] : null
    const moreAds = live.adsByCreative?.more ? ' (the account has more than 500 ads: Nexus looked at the first 500, others may show it too)' : ''
    warnings.push(shown === null
      ? `Nexus could not read which ads show video ${id}: every ad that shows it loses the ${there.join(', ')} captions at once.`
      : shown.length
        ? `Deleting the ${there.join(', ')} captions changes at once the ${plural(shown.length, 'ad')} that show${shown.length === 1 ? 's' : ''} video ${id} (${firstIds(shown.map((u) => `${u.id}${u.effectiveStatus ? ` ${u.effectiveStatus}` : ''}`))})${moreAds}.`
        : `No ad of the account shows video ${id}${moreAds}.`)
    stands[`captions:${id}`] = { locales: [...read.locales].sort(), shownBy: (shown ?? []).map((u) => u.id).sort() }
    warnings.push(`Caption languages come back only by uploading their caption file (SRT) again: Meta keeps no copy to restore (video ${id}).`)
  }

  // ── videos (out of the chosen ad account's library) ──
  const videos: string[] = []
  for (const i of items.filter((x) => x.kind === 'video')) {
    const id = i.id!
    if (!live.library) { problems.push(`Nexus could not read the chosen ad account's video library to find video ${id}.`); continue }
    if (!live.library.has.has(id)) {
      if (live.library.more) problems.push(`Video ${id} is not among the first 500 videos of the chosen ad account's library: Nexus cannot confirm it is there, so it removes nothing.`)
      else skipped.push(`Video ${id} is not in the chosen ad account's library (removed already, or never there): nothing to remove.`)
      continue
    }
    // Review B1 — the ads that show it (their creative's video_id, video_data or asset feed videos): refused while an ad
    // this change does not delete shows it, as for an image; after the ads deleted here (`needs`).
    const using = videoUsers(id)
    if ('problem' in using) { problems.push(using.problem); continue }
    const blocking = using.users.filter((u) => !adStep.has(u.id))
    if (blocking.length) {
      problems.push(`Video ${id} is shown by ${plural(blocking.length, 'ad')} this change does not delete (${firstIds(blocking.map((u) => `${u.id}${u.effectiveStatus ? ` ${u.effectiveStatus}` : ''}`))}): Nexus removes no video an ad still shows — delete those ads in the same request, or keep the video.`)
      continue
    }
    const needs = [...new Set(using.users.map((u) => adStep.get(u.id)!))].sort((a, b) => a - b)
    requests.push(deleteOf({ step: requests.length + 1, label: `Remove video ${id} from the ad account's library`, kind: 'ad', objectKind: 'adaccount', objectId: `act_${live.adAccountId}`, edge: 'advideos', params: { video_id: id }, operation: 'video.remove', ...(needs.length ? { needs } : {}) }))
    lines.push([`Video ${id}`, 'in the library', `removed from the ad account's library${needs.length ? ` (after the ${plural(using.users.length, 'ad')} that show${using.users.length === 1 ? 's' : ''} it, step ${needs.join(', ')})` : ''}`])
    recorded.push({ kind: 'video', id })
    stands[`video:${id}`] = { users: using.users.map((u) => u.id).sort() }
    videos.push(id)
  }
  if (videos.length) {
    // LIVE-PROBES MD-019: Meta's reference does not say whether a video a creative (with no ad) uses can be removed.
    warnings.push(`Meta "dissociates" a video from the ad account (reference/ad-account/advideos.md). Nexus checked the account's ads (their creatives' video_id, video_data and asset feed videos): no ad left after this change shows ${videos.length === 1 ? 'it' : 'them'}. A creative no ad uses may still name ${videos.length === 1 ? 'it' : 'one'}; Meta does not say whether it then refuses — its answer decides, in its own words.`)
  }

  // ── parts of an Instant Experience of the chosen Page ──
  const parts: string[] = []
  for (const i of items.filter((x) => x.kind === 'canvaselement')) {
    const id = i.id!
    if (!live.page) { problems.push('This business has no Facebook Page chosen, so there is no Instant Experience part to delete.'); continue }
    if ('unread' in live.page) { problems.push(`Nexus could not read the chosen Page's Instant Experience parts: ${live.page.unread}`); continue }
    if (!live.page.has.has(id)) {
      if (live.page.more) problems.push(`Instant Experience part ${id} is not among the first 500 parts of the chosen Page: Nexus cannot confirm it is the Page's, so it deletes nothing.`)
      else skipped.push(`Instant Experience part ${id} is not one of the chosen Page's parts (deleted already, or another Page's): nothing to delete.`)
      continue
    }
    requests.push(deleteOf({ step: requests.length + 1, label: `Delete Instant Experience part ${id} of the chosen Page`, kind: 'ad', objectKind: 'canvaselement', objectId: id, params: {}, operation: 'canvaselement.delete' }))
    lines.push([`Instant Experience part ${id}`, 'on the chosen Page', 'deleted'])
    recorded.push({ kind: 'canvaselement', id })
    stands[`canvaselement:${id}`] = true
    parts.push(id)
  }
  if (parts.length) {
    // LIVE-PROBES CR-487: the guide documents the DELETE; whether the system-user token is enough is not proven.
    warnings.push('Meta lets an Instant Experience change only while it is unpublished. Meta asks for the pages_manage_ads permission (with pages_read_engagement and pages_show_list) and the Page\'s ADVERTISE task (instant-experiences.md "Before you start"): if the system user\'s token lacks one, or a published Instant Experience uses this part, Meta\'s words say so and nothing is deleted.')
  }

  if (problems.length) return { refusal: `Nothing is deleted: ${problems.join(' ')}${skipped.length ? ` (Also: ${skipped.join(' ')})` : ''}` }
  const libraryRequests = requests.filter((r) => r.edge === 'adimages' || r.edge === 'advideos').length
  if (libraryRequests > 1) warnings.push(`The ${libraryRequests} images and videos go out of the ad account's library one every 30 s — Nexus's own pacing (Meta documents one edit per object every 30 s; whether the library counts as one object is not verified): about ${Math.ceil(libraryRequests / 2)} minute${libraryRequests > 2 ? 's' : ''}.`)
  warnings.unshift(
    'DELETING IS FINAL — there is no undo: a deleted campaign, ad set, ad or creative never comes back; only its name can still be changed. Its details and numbers stay readable by its own id (never again through its parent: keep the ids), and a campaign takes all its ad sets and ads with it, an ad set its ads. A deleted ad may still record results up to 28 days after its last delivery, so Meta advises deleting an ad 28 days after its last delivery, once its numbers are kept (manage-your-ad-object-status.md). To stop something for a while, lower its bids (set-meta-ad-set) or pause it (set-meta-status); archive only what is meant for good.',
  )
  const { changes, more } = changeLines(lines)
  const counts: Record<string, number> = {}
  for (const r of recorded) counts[r.kind] = (counts[r.kind] ?? 0) + 1
  const goneAdSets = alsoDeleted.reduce((n, a) => n + a.adSets.length, 0)
  const goneAds = alsoDeleted.reduce((n, a) => n + a.ads.length, 0)
  const words: Record<string, [string, string]> = {
    campaign: ['campaign', 'campaigns'], adset: ['ad set', 'ad sets'], ad: ['ad', 'ads'], creative: ['creative', 'creatives'], image: ['image', 'images'],
    video: ['video', 'videos'], captions: ['video\'s captions', 'videos\' captions'], canvaselement: ['Instant Experience part', 'Instant Experience parts'],
  }
  const what = Object.entries(counts).map(([k, n]) => plural(n, words[k][0], words[k][1])).join(', ')
  return {
    summary: `Meta: delete ${what} for good${goneAdSets || goneAds ? ` (with ${[goneAdSets ? plural(goneAdSets, 'ad set') : '', goneAds ? plural(goneAds, 'ad') : ''].filter(Boolean).join(' and ')} under them)` : ''} — asked explicitly; no undo.`,
    changes,
    totals: {
      requests: requests.length,
      ...Object.fromEntries(Object.entries(counts).map(([k, n]) => [TOTAL_KEY[k as RemoveKind], n])),
      ...(goneAdSets ? { adSetsThatGoWithThem: goneAdSets } : {}),
      ...(goneAds ? { adsThatGoWithThem: goneAds } : {}),
      ...(more ? { moreLines: more } : {}),
    },
    warnings,
    spendsMoney: [],
    skipped,
    requests,
    stands,
    before: { op: 'remove', items: recorded } satisfies RemoveRecord,
    after: { op: 'remove', items: [] } satisfies RemoveRecord,
    ...(alsoDeleted.length ? { alsoDeleted } : {}),
  }
}

/** A child as the preview lists it. */
interface RemoveChildOut { kind: 'adset' | 'ad'; id: string; name: string | null; status: string | null; effectiveStatus: string | null }
const childOut = (c: { id: string; name: string | null; status: string | null; effectiveStatus: string | null }) => ({ id: c.id, name: c.name, status: c.status, effectiveStatus: c.effectiveStatus })
