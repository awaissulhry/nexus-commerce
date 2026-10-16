/**
 * Google Ads changes (2026-10-16, programme 2 group G14b) — a page feed (URL inclusions) of the account: make one, add page
 * URLs to it (with their custom labels), take URLs away. Pure: request + live state → ONE atomic request, or a refusal.
 * Linking a page feed to a Performance Max campaign is set-google-pmax's (change-pmax.ts); build-google-pmax links one to a
 * new campaign.
 *
 * Checked 2026-10-16 with curl in Google's v25 reference and guides (developers.google.com/google-ads/api/…):
 *   docs/dynamic-search-ads/dsa-page-feeds  "In Performance Max campaigns, page feeds are also known as URL inclusions":
 *                     an Asset with a PageFeedAsset (page_feed_asset.page_url and optional labels) for each URL, an AssetSet
 *                     with type PAGE_FEED ("all the URLs to consider for a particular campaign; an Asset can belong to
 *                     multiple AssetSet objects"), an AssetSetAsset linking each asset to the set, a CampaignAssetSet linking
 *                     the set to a campaign. "Newly added page feed URLs must be crawled and reviewed before ads begin
 *                     serving for those pages."
 *   rpc/v25 PageFeedAsset  page_url (Required: "The webpage that advertisers want to target"), labels[] ("Labels used to
 *                     group the page urls"). AssetSet: name Required (1–128), type Required + Immutable (AssetSetType
 *                     PAGE_FEED "Page asset set"). AssetSetAsset: asset, asset_set Immutable;
 *                     customers/{c}/assetSetAssets/{asset_set_id}~{asset_id}. AssetSetOperation create | update | remove;
 *                     AssetSetAssetOperation create | remove; MutateOperation asset_set_operation, asset_set_asset_operation;
 *                     MutateOperationResponse asset_set_result, asset_result.
 *   ListingGroupFilterDimension.WebpageCondition custom_label: "A custom label can be added to a campaign by creating an
 *                     AssetSet of type PAGE_FEED and linking it to the campaign using CampaignAssetSet."
 * Google does not document a limit on labels per URL or their length in the reference: Nexus bounds a request (10 labels of
 * at most 100 characters) and Google's check (validate_only) judges the rest.
 *
 * Money. A page URL added to a feed linked to a campaign that serves (ENABLED) lets Google send people to that page and
 * write ads from it: SPENDS MONEY. A URL taken away narrows (a warning). A new feed is linked to nothing: it cannot spend.
 * Undo takes away the URLs it added and adds back the URLs it took away (as new assets of the same URL and labels); a
 * feed it made stays in the account, empty (Nexus removes no asset set).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import type { PageFeedRef, PageFeedUrl } from './live-pmax.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

export const MAX_PAGE_FEED_URLS = 250
export const PAGE_FEED_LABEL_LIMITS = { perUrl: 10, length: 100 } as const

export interface PageFeedUrlAsk { url: string; labels?: string[] | null }
export interface PageFeedRequest {
  /** An existing page feed of the account; left out = a new one (name needed). */
  pageFeedId?: string | null
  /** A new feed's name (1–128 characters). */
  name?: string | null
  addUrls?: PageFeedUrlAsk[] | null
  removeUrls?: string[] | null
}
export interface PageFeedLive {
  /** The account's page feeds. */
  feeds: PageFeedRef[]
  /** The feed's URLs among those the request names (an existing feed). */
  urls: PageFeedUrl[]
  /** The campaigns the feed is linked to (an existing feed). */
  campaigns: Array<{ campaignId: string; name: string; status: string | null; type: string | null }>
}
export interface PageFeedEntry { url: string; labels: string[]; assetId: string | null }
export interface PageFeedRecord {
  pageFeedId: string | null
  name: string
  created: boolean
  added: PageFeedEntry[]
  removed: PageFeedEntry[]
  /** Where the operations that made things are (Google's answers name their ids, in order). */
  ops: { feed: number | null; assets: number[] }
}

const GOOGLE_ID = /^\d{1,20}$/

/** Why a page URL cannot go into a feed, or null: an http(s) address, at most 2048 characters, no quote, backslash or line break. */
export function pageUrlProblem(url: string): string | null {
  const u = url.trim()
  if (!u || u.length > 2048) return `"${u.slice(0, 60)}": a page URL is 1 to 2048 characters`
  if (/["\\\r\n]/.test(u)) return `"${u.slice(0, 60)}": a page URL holds no quote, backslash or line break`
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return `"${u.slice(0, 60)}" is not a web page (http:// or https://)`
  } catch { return `"${u.slice(0, 60)}" is not a web address` }
  return null
}

export function pageFeedDraft(customer: string, r: PageFeedRequest, live: PageFeedLive): GoogleChangeDraft | { refusal: string } {
  const problems: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const spends: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const adds = r.addUrls ?? []
  const removes = (r.removeUrls ?? []).map((u) => u.trim())
  if (!adds.length && !removes.length && r.pageFeedId) return { refusal: 'Name addUrls or removeUrls.' }
  if (adds.length > MAX_PAGE_FEED_URLS || removes.length > MAX_PAGE_FEED_URLS) return { refusal: `At most ${MAX_PAGE_FEED_URLS} URLs added and ${MAX_PAGE_FEED_URLS} taken away in one request: ask in parts.` }

  // The feed: an existing PAGE_FEED asset set, or a new one.
  const id = r.pageFeedId?.trim() || null
  let feed: PageFeedRef | null = null
  const name = r.name?.trim() ?? ''
  if (id) {
    if (!GOOGLE_ID.test(id)) return { refusal: `"${id}" is not a Google id.` }
    feed = live.feeds.find((f) => f.assetSetId === id) ?? null
    if (!feed) return { refusal: `Page feed ${id} is not a page feed of this account (or it is removed). google-ads-query: SELECT asset_set.id, asset_set.name FROM asset_set WHERE asset_set.type = 'PAGE_FEED'.` }
    if (r.name !== undefined && r.name !== null && name !== (feed.name ?? '')) problems.push('a page feed\'s name is not changed here (give name only for a new feed)')
  } else {
    if (!name || name.length > 128) problems.push('a new page feed needs a name of 1 to 128 characters')
    const same = live.feeds.find((f) => (f.name ?? '').trim().toLowerCase() === name.toLowerCase())
    if (same) problems.push(`a page feed named "${name}" exists (pageFeedId ${same.assetSetId}): add URLs to it`)
    if (removes.length) problems.push('a new page feed has no URL to take away')
    if (!adds.length) problems.push('a new page feed needs at least one URL (addUrls)')
  }

  let next = -1
  const feedRes = id ? `${customer}/assetSets/${id}` : `${customer}/assetSets/${next--}`
  const creates: GoogleMutateOperation[] = []
  const links: GoogleMutateOperation[] = []
  const unlinks: GoogleMutateOperation[] = []
  const added: Array<PageFeedEntry & { res: string }> = []
  const removed: PageFeedEntry[] = []
  const has = new Map(live.urls.map((u) => [u.url, u]))
  const seen = new Set<string>()
  for (const a of adds) {
    const url = a.url.trim()
    const p = pageUrlProblem(url)
    if (p) { problems.push(p); continue }
    if (seen.has(url)) continue
    seen.add(url)
    if (removes.includes(url)) { problems.push(`"${url}" is both added and taken away`); continue }
    const labels = [...new Set((a.labels ?? []).map((l) => l.trim()).filter(Boolean))]
    if (labels.length > PAGE_FEED_LABEL_LIMITS.perUrl) problems.push(`"${url}": ${labels.length} labels (Nexus sends at most ${PAGE_FEED_LABEL_LIMITS.perUrl} per URL)`)
    const long = labels.find((l) => l.length > PAGE_FEED_LABEL_LIMITS.length)
    if (long) problems.push(`"${url}": the label "${long.slice(0, 30)}…" is longer than ${PAGE_FEED_LABEL_LIMITS.length} characters`)
    const there = has.get(url)
    if (there) { skipped.push(`"${url}" is already in the feed${there.labels.length ? ` (labels ${there.labels.join(', ')})` : ''}`); continue }
    const res = `${customer}/assets/${next--}`
    creates.push({ assetOperation: { create: { resourceName: res, pageFeedAsset: { pageUrl: url, ...(labels.length ? { labels } : {}) } } } })
    links.push({ assetSetAssetOperation: { create: { assetSet: feedRes, asset: res } } })
    added.push({ url, labels, assetId: null, res })
    lines.push([`page ${url}`, '(none)', `in the feed${labels.length ? `, labels ${labels.join(', ')}` : ''}`])
  }
  for (const url of [...new Set(removes)]) {
    const p = pageUrlProblem(url)
    if (p) { problems.push(p); continue }
    const there = has.get(url)
    if (!there) { skipped.push(`"${url}" is not in the feed`); continue }
    unlinks.push({ assetSetAssetOperation: { remove: `${customer}/assetSetAssets/${id}~${there.assetId}` } })
    removed.push({ url, labels: there.labels, assetId: there.assetId })
    lines.push([`page ${url}`, 'in the feed', '(taken away)'])
  }
  if (problems.length) return { refusal: `Not queued (${plural(problems.length, 'problem')}): ${problems.slice(0, 20).join(' · ')}${problems.length > 20 ? ` · … ${problems.length - 20} more` : ''}. Nothing was sent.` }
  if (!added.length && !removed.length) return { refusal: `Nothing to change: ${skipped.slice(0, 8).join('; ')}.` }

  const feedName = feed?.name ?? name
  const operations: GoogleMutateOperation[] = [
    ...(id ? [] : [{ assetSetOperation: { create: { resourceName: feedRes, name, type: 'PAGE_FEED' } } }]),
    ...creates, ...unlinks, ...links,
  ]
  if (!id) lines.unshift(['new page feed', '(none)', `"${name}" (URL inclusions; linked to no campaign yet: set-google-pmax pageFeeds.link)`])
  const serving = live.campaigns.filter((c) => c.status === 'ENABLED')
  if (added.length && serving.length) {
    spends.push(`Adds ${plural(added.length, 'page')} to the page feed "${feedName}", which the enabled campaign${serving.length > 1 ? 's' : ''} ${serving.slice(0, 3).map((c) => `"${c.name}"`).join(', ')}${serving.length > 3 ? ` (+${serving.length - 3})` : ''} use${serving.length > 1 ? '' : 's'}: Google may send people to those pages and write ads from them.`)
  } else if (added.length && live.campaigns.length) {
    warnings.push(`The page feed "${feedName}" is linked to ${plural(live.campaigns.length, 'campaign')} that do not serve now: the new pages reach people once one is enabled.`)
  }
  if (removed.length) warnings.push(`${plural(removed.length, 'page')} taken out of "${feedName}": campaigns using the feed no longer send people there through it (narrower).`)
  if (added.length) warnings.push('Google crawls and reviews new page URLs before ads serve for them (docs/dynamic-search-ads/dsa-page-feeds).')
  const { changes, more } = changeLines(lines)
  const at = (op: GoogleMutateOperation) => operations.indexOf(op)
  const record: PageFeedRecord = {
    pageFeedId: id,
    name: feedName,
    created: !id,
    added: added.map(({ res: _r, ...e }) => e),
    removed,
    ops: { feed: id ? null : 0, assets: creates.map(at) },
  }
  return {
    summary: `Google Ads page feed "${feedName}"${id ? '' : ' (new)'}: ${[added.length && `add ${plural(added.length, 'page')}`, removed.length && `take ${plural(removed.length, 'page')} away`].filter(Boolean).join(', ')} — in one request.`,
    changes,
    totals: { operations: operations.length, pagesAdded: added.length, pagesRemoved: removed.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      feed: id ? `${id}:${feed?.name ?? ''}` : null,
      names: id ? null : live.feeds.map((f) => (f.name ?? '').trim().toLowerCase()).filter((n) => n === name.toLowerCase()),
      urls: live.urls.map((u) => `${u.assetId}:${u.url}:${u.labels.join('|')}`).sort(),
      campaigns: live.campaigns.map((c) => `${c.campaignId}:${c.status}`).sort(),
    },
    before: { pageFeedId: id, name: feedName, created: false, added: [], removed: [], ops: { feed: null, assets: [] } } satisfies PageFeedRecord,
    after: record,
  }
}

const idOfResult = (responses: GoogleMutateResponse[], op: number | null | undefined, kind: string): string | null => {
  if (op === null || op === undefined || op < 0) return null
  const name = responses[op]?.[kind]?.resourceName
  return name ? name.slice(name.lastIndexOf('/') + 1) : null
}

/** The record with the ids Google gave the feed it made and the page assets it added. */
export function pageFeedRecordAfterRun(after: PageFeedRecord, responses: GoogleMutateResponse[]): PageFeedRecord {
  return {
    ...after,
    pageFeedId: after.pageFeedId ?? idOfResult(responses, after.ops.feed, 'assetSetResult'),
    added: after.added.map((e, i) => ({ ...e, assetId: idOfResult(responses, after.ops.assets[i], 'assetResult') })),
  }
}

/** What of a record the live feed still holds (undo's compare): the pages it added still there, those it took away still gone. */
export function pageFeedNow(record: PageFeedRecord, urls: PageFeedUrl[]): PageFeedRecord {
  const there = new Map(urls.map((u) => [u.url, u]))
  return {
    ...record,
    added: record.added.filter((e) => there.get(e.url)?.assetId === e.assetId),
    removed: record.removed.filter((e) => !there.has(e.url)),
  }
}
