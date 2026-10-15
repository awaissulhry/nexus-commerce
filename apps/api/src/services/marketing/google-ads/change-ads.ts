/**
 * Google Ads changes (2026-10-15) — PR 5, responsive search ads: make up to 10 in ONE Search ad group, or pause ads of
 * that ad group (the undo of a make, and nothing else: only ads, only a pause). One atomic request.
 *
 * Status (Owner's rule): a new ad is made so it cannot spend by itself. In a campaign that is not enabled it is made
 * ENABLED (nothing serves until the campaign is). In an ENABLED campaign it is made PAUSED — even when its ad group is
 * paused, so enabling the ad group later never switches ads on unseen — unless the request says `enable: true`: then it
 * is ENABLED and that is SPENDS MONEY (the person's decision; said when the ad group is paused and nothing serves yet).
 * `enable: false` makes it PAUSED anywhere.
 *
 * Every problem of the text is refused BEFORE Google is asked, all of them at once (which ad, which headline, how long).
 * Google's own check (validate_only) then judges the rest, and its review of the ad's content (policy) runs after the
 * ad is made: google-ads-live view ads shows it.
 *
 * Checked 2026-10-15 in Google's v25 reference (developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   AdGroupAdOperation   create AdGroupAd { ad_group, status, ad }: "no resource name is expected for the new ad";
 *                        update with update_mask; the resource name is customers/{c}/adGroupAds/{ad_group_id}~{ad_id}.
 *   Ad                   final_urls[], responsive_search_ad (ResponsiveSearchAdInfo).
 *   ResponsiveSearchAdInfo  headlines[] and descriptions[] (AdTextAsset { text, pinned_field }), path1, path2 ("can
 *                        only be set when path1 is also set"; AdError CANNOT_SET_PATH2_WITHOUT_PATH1).
 *   ServedAssetFieldType the pins: HEADLINE_1, HEADLINE_2, HEADLINE_3, DESCRIPTION_1, DESCRIPTION_2.
 *   AdGroupAdStatus      ENABLED, PAUSED, REMOVED.  MutateOperationResponse: ad_group_ad_result (JSON adGroupAdResult).
 *   AssetLinkError       NOT_ENOUGH_AVAILABLE_ASSET_LINKS_FOR_VALID_COMBINATION: pins can leave a position empty.
 * Google Ads Help (support.google.com/google-ads): 3 to 15 headlines, 2 to 4 descriptions (answer 7684791); headline 30,
 *   description 90, path 15 characters, and "each character in double-width languages like Korean, Japanese, or
 *   Chinese counts as two toward the limit instead of one" (answer 1704389); "3 enabled responsive search ads per ad
 *   group" (account limits, answer 6372658); headline 1, headline 2 and description 1 always show (answer 7684791).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { LiveAd } from './live.js'
import type { LiveAdGroupPlace } from './live-ads-assets.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

// ── Google's text rules, shared with the assets (change-assets.ts) ──────────────────────────────────────────────────

/**
 * Unicode East Asian Width "Wide" and "Fullwidth" blocks: CJK ideographs and punctuation, kana, Hangul, fullwidth forms
 * (and the emoji blocks, which Google's policy refuses anyway).
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf],
  [0xa960, 0xa97f], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
]
const isWide = (codePoint: number) => WIDE_RANGES.some(([from, to]) => codePoint >= from && codePoint <= to)
/** Insertion tags with a default text show it when they cannot fill in: `{KeyWord:Moto jackets}` counts "Moto jackets". */
const DEFAULT_TAG = /\{(?:keyword|location\([^)]*\)|customizer\.[^:}]+):([^{}]*)\}/gi
/** Any other tag (`{COUNTDOWN(…)}`, `{LOCATION(City)}` …): Google fills it in when the ad serves; Nexus does not count it. */
const OTHER_TAG = /\{[^{}]*\}/g
/** What Nexus counts of a text: NFC (a letter and its accent are one character), default texts for their tags, no other tag. */
const countedText = (text: string) => text.normalize('NFC').replace(DEFAULT_TAG, '$1').replace(OTHER_TAG, '')

/**
 * The length Google counts for ad and asset text. What Nexus implements: the text in NFC, every character (a Unicode
 * code point, so an accented letter is 1) counts 1, and a character of the double-width blocks above counts 2 — Google's
 * rule for "double-width languages like Korean, Japanese, or Chinese". A tag with a default text counts that text; a tag
 * without one counts 0 (uncountedTags names it, and Google's check judges it). Google's check (validate_only) is the
 * last word: anything this count misses, it refuses before the change is queued.
 */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of countedText(text)) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1
  return width
}

/** The tags of a text Nexus did not count (no default text): Google's check judges their length. */
export const uncountedTags = (text: string | null | undefined): string[] =>
  (text ?? '').normalize('NFC').replace(DEFAULT_TAG, '$1').match(OTHER_TAG) ?? []

/** The warning for a text with tags Nexus did not count, or null. */
export function tagWarning(where: string, text: string | null | undefined): string | null {
  const tags = uncountedTags(text)
  return tags.length ? `${where}: Nexus did not count ${tags.join(', ')} (a tag without default text); Google's check judges its length.` : null
}

/** Two texts are the same when they are exactly the same once trimmed and their spaces collapsed (case counts). */
export const textKey = (text: string | null | undefined): string => (text ?? '').normalize('NFC').trim().replace(/\s+/g, ' ')

const clip = (text: string, max = 40) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** "headline 3 "…" is 34 characters long: Google allows 30", or null when it fits. */
export function widthProblem(where: string, text: string | null | undefined, max: number): string | null {
  const t = (text ?? '').trim()
  if (!t) return `${where} is empty`
  const width = displayWidth(t)
  if (width <= max) return null
  const doubled = [...countedText(t)].some((ch) => isWide(ch.codePointAt(0) ?? 0)) ? ' (a double-width character counts 2)' : ''
  return `${where} "${clip(t)}" is ${width} characters long${doubled}: Google allows ${max}`
}

/** A final URL Nexus sends: a whole https web address. */
export function httpsUrlProblem(where: string, url: string | null | undefined): string | null {
  const u = (url ?? '').trim()
  if (!u) return `${where}: the final URL is missing`
  let parsed: URL
  try { parsed = new URL(u) } catch { return `${where}: "${clip(u)}" is not a web address` }
  if (parsed.protocol !== 'https:') return `${where}: "${clip(u)}" is not an https address (Nexus sends https only)`
  if (!parsed.hostname.includes('.')) return `${where}: "${clip(u)}" is not a web address`
  return null
}

// ── responsive search ads ───────────────────────────────────────────────────────────────────────────────────────

export const HEADLINE_PINS = ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3'] as const
export const DESCRIPTION_PINS = ['DESCRIPTION_1', 'DESCRIPTION_2'] as const
export type RsaPin = typeof HEADLINE_PINS[number] | typeof DESCRIPTION_PINS[number]

export const RSA_LIMITS = {
  headlineWidth: 30, descriptionWidth: 90, pathWidth: 15,
  minHeadlines: 3, maxHeadlines: 15, minDescriptions: 2, maxDescriptions: 4,
  adsPerRequest: 10, enabledPerAdGroup: 3,
} as const

export interface RsaText { text: string; pin?: RsaPin | null }
export interface RsaAd {
  headlines: RsaText[]
  descriptions: RsaText[]
  path1?: string | null
  path2?: string | null
  finalUrl: string
}

export interface AdsChangeRequest {
  campaignId: string
  adGroupId: string
  /** Responsive search ads to make (up to 10). */
  ads?: RsaAd[]
  /** true: ENABLED even in an enabled ad group of an enabled campaign (SPENDS MONEY); false: PAUSED anywhere. */
  enable?: boolean
  /** The undo form: pause these ads of the ad group. Only ads, only a pause. */
  pauseAdIds?: string[]
}

export interface AdsLiveState {
  /** The ad group with its campaign; null when it is not in that campaign (or removed). */
  place: LiveAdGroupPlace | null
  /** The campaign's ads (not removed); the ad group's are taken from them. */
  ads: LiveAd[]
}

export type AdStatus = 'ENABLED' | 'PAUSED'

/** What the change wrote: the ads it made (`op:<index>` until Google gave their ids) and the ads it paused. */
export interface AdsChangeRecord {
  campaignId: string
  adGroupId: string
  created: Array<{ adId: string; status: AdStatus }>
  paused: string[]
}

/** What it replaced: the status each paused ad had (nothing, for ads it made). */
export interface AdsChangeBefore {
  campaignId: string
  adGroupId: string
  ads: Array<{ adId: string; status: string | null }>
}

const OP = 'op:'
const PIN_SHORT: Record<RsaPin, string> = { HEADLINE_1: 'H1', HEADLINE_2: 'H2', HEADLINE_3: 'H3', DESCRIPTION_1: 'D1', DESCRIPTION_2: 'D2' }

/** The pins of one list: each in its own family, and none leaving a position Google always fills with nothing. */
function pinProblems(where: string, items: RsaText[], family: 'headline' | 'description'): string[] {
  const allowed: readonly RsaPin[] = family === 'headline' ? HEADLINE_PINS : DESCRIPTION_PINS
  const problems: string[] = []
  items.forEach((t, i) => {
    if (t.pin && !allowed.includes(t.pin)) problems.push(`${where}, ${family} ${i + 1}: pin ${t.pin} is not a ${family} position (${allowed.join(', ')})`)
  })
  // Headline 1, headline 2 and description 1 always show: each needs a text pinned to it or one left unpinned.
  const always: RsaPin[] = family === 'headline' ? ['HEADLINE_1', 'HEADLINE_2'] : ['DESCRIPTION_1']
  const empty = always.filter((p) => !items.some((t) => t.pin === p))
  const free = items.filter((t) => !t.pin).length
  if (empty.length > free) problems.push(`${where}: the pins leave ${empty.join(' and ')} with no ${family} to show (pin one there, or leave more ${family}s unpinned)`)
  return problems
}

/** Every rule one ad breaks, each naming the ad, the text and how long it is. */
export function rsaProblems(ad: RsaAd, n: number): string[] {
  const where = `ad ${n}`
  const problems = rsaTextProblems(ad, where)
  const url = httpsUrlProblem(where, ad.finalUrl)
  if (url) problems.push(url)
  return problems
}

/**
 * Every rule an ad's texts break — how many headlines and descriptions, their lengths, duplicates, pins, path1 / path2 —
 * not its final URL (an edit checks a URL only when it changes it: change-edit-ads.ts).
 */
export function rsaTextProblems(ad: Pick<RsaAd, 'headlines' | 'descriptions' | 'path1' | 'path2'>, where: string): string[] {
  const problems: string[] = []
  const L = RSA_LIMITS
  const count = (items: RsaText[], word: string, min: number, max: number) => {
    if (items.length < min) problems.push(`${where}: ${plural(items.length, word)} (Google needs at least ${min})`)
    if (items.length > max) problems.push(`${where}: ${plural(items.length, word)} (Google allows ${max})`)
  }
  count(ad.headlines, 'headline', L.minHeadlines, L.maxHeadlines)
  count(ad.descriptions, 'description', L.minDescriptions, L.maxDescriptions)
  const dupes = (items: RsaText[], word: string) => {
    const seen = new Map<string, number>()
    items.forEach((t, i) => {
      const key = textKey(t.text)
      if (!key) return
      const first = seen.get(key)
      if (first !== undefined) problems.push(`${where}, ${word} ${i + 1} "${clip(t.text.trim())}" repeats ${word} ${first + 1} exactly (Google refuses duplicates)`)
      else seen.set(key, i)
    })
  }
  ad.headlines.forEach((t, i) => { const p = widthProblem(`${where}, headline ${i + 1}`, t.text, L.headlineWidth); if (p) problems.push(p) })
  ad.descriptions.forEach((t, i) => { const p = widthProblem(`${where}, description ${i + 1}`, t.text, L.descriptionWidth); if (p) problems.push(p) })
  dupes(ad.headlines, 'headline')
  dupes(ad.descriptions, 'description')
  problems.push(...pinProblems(where, ad.headlines, 'headline'), ...pinProblems(where, ad.descriptions, 'description'))
  const path1 = ad.path1?.trim() ?? ''
  const path2 = ad.path2?.trim() ?? ''
  if (path2 && !path1) problems.push(`${where}: path2 needs path1 (Google shows path2 only after path1)`)
  if (path1) { const p = widthProblem(`${where}, path1`, path1, L.pathWidth); if (p) problems.push(p) }
  if (path2) { const p = widthProblem(`${where}, path2`, path2, L.pathWidth); if (p) problems.push(p) }
  return problems
}

/** A headline or description as Google takes it (AdTextAsset: text, pinned_field). */
export const textAsset = (t: RsaText) => ({ text: t.text.trim(), ...(t.pin ? { pinnedField: t.pin } : {}) })
/** Texts as a person reads them: "Moto Jackets [H1] | Free Returns". */
export const shown = (items: RsaText[]) => items.map((t) => `${t.text.trim()}${t.pin ? ` [${PIN_SHORT[t.pin]}]` : ''}`).join(' | ')
function displayPath(ad: RsaAd): string {
  const path = [ad.path1?.trim(), ad.path2?.trim()].filter(Boolean).join('/')
  if (!path) return ad.finalUrl.trim()
  let host = ''
  try { host = new URL(ad.finalUrl.trim()).hostname.replace(/^www\./, '') } catch { /* refused above */ }
  return `${ad.finalUrl.trim()} (shown as ${host}/${path})`
}
const firstHeadline = (ad: LiveAd | undefined) => (ad?.headlines[0]?.text ? ` ("${clip(ad.headlines[0].text, 30)}")` : '')

export function adsChangeDraft(customer: string, request: AdsChangeRequest, live: AdsLiveState): GoogleChangeDraft | { refusal: string } {
  const ads = request.ads ?? []
  const pause = [...new Set(request.pauseAdIds ?? [])]
  if (!ads.length && !pause.length) return { refusal: 'Say what to do: ads (responsive search ads to make) or pauseAdIds (ads of the ad group to pause).' }
  if (ads.length && pause.length) return { refusal: 'Give ads (to make) or pauseAdIds (to pause), not both.' }
  if (pause.length && request.enable !== undefined) return { refusal: 'enable is for ads to make; pauseAdIds only pauses.' }
  if (ads.length > RSA_LIMITS.adsPerRequest) return { refusal: `At most ${RSA_LIMITS.adsPerRequest} ads in one request (${ads.length} asked).` }
  const place = live.place
  if (!place) {
    return { refusal: `Ad group ${request.adGroupId} is not in campaign ${request.campaignId} (or one of them is removed). google-ads-live view campaign lists the campaign's ad groups.` }
  }
  const { campaign, adGroup } = place
  if (campaign.type !== 'SEARCH') return { refusal: `Responsive search ads go in Search campaigns only: "${campaign.name}" is a ${campaign.type ?? 'campaign of unknown'} campaign.` }
  if (adGroup.type !== 'SEARCH_STANDARD') return { refusal: `Responsive search ads go in standard Search ad groups: "${adGroup.name}" is ${adGroup.type ?? 'of an unknown type'}.` }
  const groupAds = live.ads.filter((a) => a.adGroupId === adGroup.adGroupId)
  const stands = {
    campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type },
    adGroup: { adGroupId: adGroup.adGroupId, status: adGroup.status, type: adGroup.type },
    ads: groupAds.map((a) => ({ adId: a.adId, status: a.status, type: a.type })).sort((x, y) => x.adId.localeCompare(y.adId)),
  }
  const where = `ad group "${adGroup.name}" of campaign "${campaign.name}"`
  const record: AdsChangeRecord = { campaignId: campaign.campaignId, adGroupId: adGroup.adGroupId, created: [], paused: [] }
  const before: AdsChangeBefore = { campaignId: campaign.campaignId, adGroupId: adGroup.adGroupId, ads: [] }
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const skipped: string[] = []

  // ── the undo form: pause ads of the ad group ──
  if (pause.length) {
    for (const adId of pause) {
      const ad = groupAds.find((a) => a.adId === adId)
      if (!ad) return { refusal: `Ad ${adId} is not in ${where} (or it is removed). google-ads-live view ads lists them.` }
      if (ad.status === 'PAUSED') { skipped.push(`Ad ${adId}${firstHeadline(ad)} is already paused.`); continue }
      operations.push({ adGroupAdOperation: { update: { resourceName: `${customer}/adGroupAds/${adGroup.adGroupId}~${adId}`, status: 'PAUSED' }, updateMask: 'status' } })
      lines.push([`ad ${adId}${firstHeadline(ad)}`, ad.status, 'PAUSED'])
      before.ads.push({ adId, status: ad.status })
      record.paused.push(adId)
    }
    if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
    const stillEnabled = groupAds.filter((a) => a.status === 'ENABLED' && !record.paused.includes(a.adId)).length
    if (stillEnabled === 0) warnings.push(`"${adGroup.name}" has no enabled ad left: it shows no ads until one is enabled.`)
    const { changes, more } = changeLines(lines)
    return {
      summary: `Google Ads: pause ${plural(record.paused.length, 'ad')} of ${where}.`,
      changes,
      totals: { operations: operations.length, adsPaused: record.paused.length, ...(more ? { linesNotShown: more } : {}) },
      warnings,
      spendsMoney: [],
      skipped,
      operations,
      stands,
      before,
      after: record,
    }
  }

  // ── make responsive search ads ──
  const campaignOn = campaign.status === 'ENABLED'
  const groupOn = adGroup.status === 'ENABLED'
  const status: AdStatus = campaignOn ? (request.enable === true ? 'ENABLED' : 'PAUSED') : (request.enable === false ? 'PAUSED' : 'ENABLED')
  const problems = ads.flatMap((ad, i) => rsaProblems(ad, i + 1))
  const enabledNow = groupAds.filter((a) => a.status === 'ENABLED' && a.type === 'RESPONSIVE_SEARCH_AD').length
  if (status === 'ENABLED' && enabledNow + ads.length > RSA_LIMITS.enabledPerAdGroup) {
    problems.push(`Google allows ${RSA_LIMITS.enabledPerAdGroup} enabled responsive search ads per ad group: "${adGroup.name}" has ${enabledNow} enabled and this would add ${ads.length} more enabled (pause some first with pauseAdIds, ask with enable: false, or ask for fewer)`)
  }
  if (problems.length) return { refusal: `Not queued — the ads break Google's rules (nothing was sent): ${problems.join('; ')}.` }

  ads.forEach((ad, i) => {
    const path1 = ad.path1?.trim()
    const path2 = ad.path2?.trim()
    operations.push({
      adGroupAdOperation: {
        create: {
          adGroup: `${customer}/adGroups/${adGroup.adGroupId}`,
          status,
          ad: {
            finalUrls: [ad.finalUrl.trim()],
            responsiveSearchAd: {
              headlines: ad.headlines.map(textAsset),
              descriptions: ad.descriptions.map(textAsset),
              ...(path1 ? { path1 } : {}),
              ...(path1 && path2 ? { path2 } : {}),
            },
          },
        },
      },
    })
    lines.push([`ad ${i + 1} headlines (${ad.headlines.length})`, '(none)', shown(ad.headlines)])
    lines.push([`ad ${i + 1} descriptions and URL`, '(none)', `${shown(ad.descriptions)} — ${displayPath(ad)} — ${status}`])
    record.created.push({ adId: `${OP}${operations.length - 1}`, status })
  })
  const spendsMoney: string[] = []
  const one = ads.length === 1
  const showSpend = one ? 'it shows (and spends)' : 'they show (and spend)'
  const lower = (value: string | null) => String(value ?? 'not enabled').toLowerCase()
  if (status === 'ENABLED' && campaignOn) {
    spendsMoney.push(groupOn
      ? `Makes ${plural(ads.length, 'responsive search ad')} ENABLED in the enabled ${where}: ${showSpend} as soon as Google approves ${one ? 'it' : 'them'}.`
      : `Makes ${plural(ads.length, 'responsive search ad')} ENABLED in ad group "${adGroup.name}" of the enabled campaign "${campaign.name}": the ad group is ${lower(adGroup.status)}, so nothing serves until it is enabled; then ${showSpend}.`)
  } else if (status === 'ENABLED') {
    warnings.push(`The new ads are made ENABLED: campaign "${campaign.name}" is ${lower(campaign.status)}, so they show nothing until it is enabled (enabling it is a change of its own, and spends money).`)
  } else if (campaignOn) {
    warnings.push(groupOn
      ? `The new ads are made PAUSED: campaign "${campaign.name}" and ad group "${adGroup.name}" are enabled, so enabled ads would show at once. Ask with enable: true to make them enabled (that spends money).`
      : `The new ads are made PAUSED: campaign "${campaign.name}" is enabled, so enabled ads would show as soon as ad group "${adGroup.name}" is enabled. Ask with enable: true to make them enabled (that spends money).`)
  }
  ads.forEach((ad, i) => {
    const texts: Array<[string, string | null | undefined]> = [
      ...ad.headlines.map((t, j): [string, string] => [`ad ${i + 1}, headline ${j + 1}`, t.text]),
      ...ad.descriptions.map((t, j): [string, string] => [`ad ${i + 1}, description ${j + 1}`, t.text]),
      [`ad ${i + 1}, path1`, ad.path1], [`ad ${i + 1}, path2`, ad.path2],
    ]
    for (const [label, text] of texts) { const w = tagWarning(label, text); if (w) warnings.push(w) }
  })
  const { changes, more } = changeLines(lines)
  return {
    summary: `Google Ads: make ${plural(ads.length, 'responsive search ad')} in ${where}, ${status === 'ENABLED' ? 'enabled' : 'paused'}.`,
    changes,
    totals: {
      operations: operations.length,
      ads: ads.length,
      headlines: ads.reduce((n, a) => n + a.headlines.length, 0),
      descriptions: ads.reduce((n, a) => n + a.descriptions.length, 0),
      ...(more ? { linesNotShown: more } : {}),
    },
    warnings,
    spendsMoney,
    skipped,
    operations,
    stands,
    before,
    after: record,
  }
}

/** The record of a run, with the ad id Google gave each new ad (`adGroupAdResult` of the operation that made it). */
export function adsRecordAfterRun(after: AdsChangeRecord, responses: GoogleMutateResponse[]): AdsChangeRecord {
  const idAt = (index: number): string | null => {
    const name = responses[index]?.adGroupAdResult?.resourceName
    return name && name.includes('~') ? name.slice(name.lastIndexOf('~') + 1) : null
  }
  return {
    ...after,
    created: after.created.map((c) => ({ adId: c.adId.startsWith(OP) ? idAt(Number(c.adId.slice(OP.length))) ?? c.adId : c.adId, status: c.status })),
    paused: [...after.paused],
  }
}

/** True when an id in a record is a real Google id (not an operation index Google never answered for). */
export const isGoogleId = (id: string): boolean => /^\d+$/.test(id)
