/**
 * Google Ads changes (2026-10-15) — ad groups of ONE Search or Standard Shopping campaign: make ad groups (name, default
 * max CPC), rename them, change their default max CPC. One atomic request.
 *
 * Checked on 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 * - AdGroup: `campaign` (immutable), `name` (required on create, fewer than 255 characters, no NUL / line feed /
 *   carriage return), `type` (immutable; AdGroupType SEARCH_STANDARD = "the default ad group type for Search campaigns",
 *   SHOPPING_PRODUCT_ADS = "Shopping campaigns serving standard product ads"), `status` (AdGroupStatus ENABLED / PAUSED),
 *   `cpc_bid_micros` (the max CPC under Manual CPC). Resource name `customers/{customer_id}/adGroups/{ad_group_id}`.
 * - AdGroupOperation create / update + update_mask; a field in the mask is written (snake_case: `name`, `cpc_bid_micros`).
 * - AdGroupAd: `ad_group`, `status` (AdGroupAdStatus), `ad` (immutable); Ad.`shopping_product_ad` is a
 *   ShoppingProductAdInfo, which "has no fields" — `ad: { shoppingProductAd: {} }` (guide "Create a Shopping product
 *   ad": a SHOPPING_PRODUCT_ADS ad group needs one). Resource name `customers/{customer_id}/adGroupAds/{ad_group_id}~{ad_id}`.
 * - A new ad group and its ad go in one request: the ad points at the ad group by a temporary id (a negative number).
 *
 * Money (Owner's rules): a new ad group inside a campaign that is not ENABLED is made ENABLED (nothing serves); inside an
 * ENABLED campaign it is made PAUSED unless the request says `enable: true` — then it is named in `spendsMoney`. A raise
 * of a default max CPC is named in `spendsMoney`. Duplicate names in one campaign are refused here (Google refuses them).
 */
import { changeLines, money, plural, type GoogleChangeDraft } from './change-draft.js'
import { idOf, microsOfCents, type LiveCampaign } from './live.js'
import type { LiveAdGroup } from './live-keywords.js'
import type { GoogleMutateOperation, GoogleMutateResponse } from './write-client.js'

// ── shared by the ad group, keyword and negative keyword changes ───────────────────────────────────────────────────

export type ChangeableCampaignKind = 'SEARCH' | 'SHOPPING'

/** A campaign sub type that is not a special kind (Google leaves it out, or says UNSPECIFIED / UNKNOWN). */
const PLAIN_SUB_TYPE = new Set([null, 'UNSPECIFIED', 'UNKNOWN'])

/** The campaign of a change: it must exist (not removed) and be a Search or a Standard Shopping campaign. */
export function changeableCampaign(campaigns: LiveCampaign[], campaignId: string): { campaign: LiveCampaign; kind: ChangeableCampaignKind } | { refusal: string } {
  const campaign = campaigns.find((c) => c.campaignId === campaignId)
  if (!campaign || campaign.status === 'REMOVED') return { refusal: `Campaign ${campaignId} is not in this account (or it is removed). google-ads-live view campaigns lists them.` }
  if ((campaign.type === 'SEARCH' || campaign.type === 'SHOPPING') && PLAIN_SUB_TYPE.has(campaign.subType)) return { campaign, kind: campaign.type }
  return { refusal: `Campaign "${campaign.name}" is a ${campaign.type ?? 'campaign of unknown type'}${campaign.subType && !PLAIN_SUB_TYPE.has(campaign.subType) ? ` (${campaign.subType})` : ''} campaign: only Search and Standard Shopping campaigns are changed here.` }
}

/** "" when the campaign is enabled; else why nothing spends yet. */
export const campaignPausedNote = (c: LiveCampaign): string =>
  c.status === 'ENABLED' ? '' : ` (the campaign is ${String(c.status ?? 'not enabled').toLowerCase()}: nothing spends until it is enabled)`

/** Under a bid strategy other than Manual CPC, Google may not use the max CPCs a change sets. */
export const biddingNote = (c: LiveCampaign, what: string): string | null =>
  c.bidding && c.bidding !== 'MANUAL_CPC' ? `Campaign "${c.name}" bids with ${c.bidding}, not Manual CPC: Google may not use ${what}.` : null

/** One SPENDS MONEY sentence for raises: how many (`count`, "3 keywords"), and from → to for up to 20 of them. */
export function raiseSentence(what: string, count: string, raises: Array<{ label: string; from: string; to: string }>, note: string): string {
  const shown = raises.slice(0, 20).map((r) => `${r.label} ${r.from} → ${r.to}`).join('; ')
  const more = raises.length > 20 ? `; +${raises.length - 20} more` : ''
  return `Raises the ${what} of ${count}: ${shown}${more}${note}.`
}

/**
 * The whole picture of several raises (Owner 2026-10-15: not only item by item — many small raises add up): how much
 * they go up together and the average move; null for one raise (its own sentence says it all).
 */
export function raiseTotal(what: string, count: string, raises: Array<{ fromCents: number | null; toCents: number }>, currency: string, lowered = 0): string | null {
  if (raises.length < 2) return null
  const sum = (pick: (r: { fromCents: number | null; toCents: number }) => number) => raises.reduce((s, r) => s + pick(r), 0)
  const up = sum((r) => r.toCents - (r.fromCents ?? 0))
  const avg = (n: number) => money(Math.round(n / raises.length), currency)
  return `In all, the ${what} of ${count} go up by ${money(up, currency)} together (on average ${avg(sum((r) => r.fromCents ?? 0))} → ${avg(sum((r) => r.toCents))})`
    + `${lowered ? `, while ${lowered} other${lowered === 1 ? ' goes' : 's go'} down` : ''}: each click on them can cost more.`
}

const NAME_BAD = /[\u0000\n\r]/
/** Google compares names within a campaign; Nexus compares them without case and outer spaces (stricter, never looser). */
const nameKey = (name: string) => name.trim().toLowerCase()

// ── set-google-ad-groups ───────────────────────────────────────────────────────────────────────────────────────────

export interface AdGroupChangeRequest {
  campaignId: string
  /** New ad groups: a name (unique in the campaign) and a default max CPC. */
  create?: Array<{ name: string; defaultBidCents: number }>
  /** Existing ad groups of the campaign: a new name, a new default max CPC, or both. */
  change?: Array<{ adGroupId: string; name?: string; defaultBidCents?: number }>
  /** In an ENABLED campaign: make the new ad groups ENABLED (they can spend at once) instead of PAUSED. */
  enable?: boolean
}

export interface AdGroupLiveState {
  campaigns: LiveCampaign[]
  /** The campaign's ad groups that are not removed. */
  adGroups: LiveAdGroup[]
}

/** What a change of ad groups replaced (before) and wrote (after): the fields it changed, and what it made. */
export interface AdGroupChangeRecord {
  campaignId: string
  adGroups: Array<{ adGroupId: string; name?: string; defaultBidCents?: number | null }>
  /** after only: the ad groups it made; their ids are Google's after the run (`new:<operation index>` before). */
  created?: Array<{ adGroupId: string; name: string; type: string; status: string; defaultBidCents: number; adId?: string }>
}

const NEW = 'new:'

export function adGroupChangeDraft(customer: string, currency: string, request: AdGroupChangeRequest, live: AdGroupLiveState): GoogleChangeDraft | { refusal: string } {
  const creates = request.create ?? []
  const changes = request.change ?? []
  if (!creates.length && !changes.length) return { refusal: 'Say what to change: create (new ad groups) or change (rename, default max CPC).' }
  const picked = changeableCampaign(live.campaigns, request.campaignId)
  if ('refusal' in picked) return picked
  const { campaign, kind } = picked
  const groupById = new Map(live.adGroups.map((g) => [g.adGroupId, g]))
  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const spends: string[] = []
  const warnings: string[] = []
  const skipped: string[] = []
  const before: AdGroupChangeRecord = { campaignId: campaign.campaignId, adGroups: [] }
  const after: AdGroupChangeRecord = { campaignId: campaign.campaignId, adGroups: [] }
  const campaignRes = `${customer}/campaigns/${campaign.campaignId}`
  const groupRes = (id: string | number) => `${customer}/adGroups/${id}`

  // 1. names: Google refuses two ad groups with one name in a campaign — checked on the names as they would be after.
  for (const name of [...creates.map((c) => c.name), ...changes.map((c) => c.name).filter((n): n is string => n !== undefined)]) {
    const t = name.trim()
    if (!t) return { refusal: 'An ad group name is empty.' }
    if (t.length > 254) return { refusal: `The ad group name "${t.slice(0, 40)}…" has ${t.length} characters (Google allows fewer than 255).` }
    if (NAME_BAD.test(t)) return { refusal: `The ad group name "${t.slice(0, 40)}" holds a line break or a NUL character (Google refuses them).` }
  }
  const seenChange = new Set<string>()
  for (const c of changes) {
    if (seenChange.has(c.adGroupId)) return { refusal: `Ad group ${c.adGroupId} is named twice in change.` }
    seenChange.add(c.adGroupId)
    if (!groupById.has(c.adGroupId)) return { refusal: `Ad group ${c.adGroupId} is not in campaign "${campaign.name}" (or it is removed). google-ads-live view campaign lists its ad groups.` }
    if (c.name === undefined && c.defaultBidCents === undefined) return { refusal: `Ad group ${c.adGroupId}: say what changes (name, defaultBidCents).` }
  }
  const finalName = new Map(live.adGroups.map((g) => [g.adGroupId, g.name]))
  const touched = new Set<string>()
  for (const c of changes) if (c.name !== undefined && c.name.trim() !== groupById.get(c.adGroupId)!.name) { finalName.set(c.adGroupId, c.name.trim()); touched.add(c.adGroupId) }
  creates.forEach((c, i) => { finalName.set(`${NEW}${i}`, c.name.trim()); touched.add(`${NEW}${i}`) })
  const byKey = new Map<string, string[]>()
  for (const [id, name] of finalName) byKey.set(nameKey(name), [...(byKey.get(nameKey(name)) ?? []), id])
  for (const [, ids] of byKey) {
    if (ids.length > 1 && ids.some((id) => touched.has(id))) {
      return { refusal: `Two ad groups would be named "${finalName.get(ids.find((id) => touched.has(id))!)}" in campaign "${campaign.name}": Google refuses duplicate ad group names in one campaign.` }
    }
  }

  // 2. new ad groups (a Shopping one with its product ad, in the same request)
  const on = campaign.status === 'ENABLED'
  const status = !on || request.enable ? 'ENABLED' : 'PAUSED'
  const type = kind === 'SEARCH' ? 'SEARCH_STANDARD' : 'SHOPPING_PRODUCT_ADS'
  const made: NonNullable<AdGroupChangeRecord['created']> = []
  creates.forEach((c, i) => {
    const temp = -(i + 1)
    const name = c.name.trim()
    const entry: NonNullable<AdGroupChangeRecord['created']>[number] = { adGroupId: `${NEW}${operations.length}`, name, type, status, defaultBidCents: c.defaultBidCents }
    operations.push({ adGroupOperation: { create: { resourceName: groupRes(temp), campaign: campaignRes, name, type, status, cpcBidMicros: microsOfCents(c.defaultBidCents) } } })
    if (kind === 'SHOPPING') {
      entry.adId = `${NEW}${operations.length}`
      operations.push({ adGroupAdOperation: { create: { adGroup: groupRes(temp), status: 'ENABLED', ad: { shoppingProductAd: {} } } } })
    }
    made.push(entry)
    lines.push([`new ad group "${name}"`, '(none)', `${status}, default max CPC ${money(c.defaultBidCents, currency)}${kind === 'SHOPPING' ? ', with its product ad' : ''}`])
  })
  if (made.length) {
    after.created = made
    if (on && request.enable) {
      spends.push(`${made.length === 1 ? `The new ad group "${made[0].name}" is` : `${made.length} new ad groups (${made.slice(0, 20).map((m) => `"${m.name}"`).join(', ')}${made.length > 20 ? ' …' : ''}) are`} made ENABLED in the enabled campaign "${campaign.name}": ${made.length === 1 ? 'it' : 'they'} can show ads (default max CPC ${[...new Set(made.map((m) => money(m.defaultBidCents, currency)))].join(' / ')}).`)
    } else if (on) {
      warnings.push(`New ad groups are made PAUSED because the campaign "${campaign.name}" is enabled: they show no ads until a person enables them (or ask again with enable: true).`)
    } else {
      warnings.push(`New ad groups are made ENABLED: the campaign "${campaign.name}" is ${String(campaign.status ?? 'not enabled').toLowerCase()}, so they show no ads until it is enabled.`)
    }
    if (kind === 'SHOPPING') warnings.push('Each new Shopping ad group gets its product ad in this request, but no product groups: those are set in a separate change.')
  } else if (request.enable) {
    warnings.push('enable: true changes nothing here: it applies to new ad groups only.')
  }

  // 3. renames and default max CPCs
  const raises: Array<{ label: string; from: string; to: string; fromCents: number | null; toCents: number; servingNote: string }> = []
  for (const c of changes) {
    const g = groupById.get(c.adGroupId)!
    const fields: string[] = []
    const update: Record<string, unknown> = { resourceName: groupRes(g.adGroupId) }
    const was: AdGroupChangeRecord['adGroups'][number] = { adGroupId: g.adGroupId }
    const now: AdGroupChangeRecord['adGroups'][number] = { adGroupId: g.adGroupId }
    if (c.name !== undefined) {
      const name = c.name.trim()
      if (name === g.name) skipped.push(`Ad group "${g.name}" already has that name.`)
      else {
        fields.push('name')
        update.name = name
        was.name = g.name
        now.name = name
        lines.push([`ad group "${g.name}" name`, g.name, name])
      }
    }
    if (c.defaultBidCents !== undefined) {
      if (c.defaultBidCents === g.cpcBidCents) skipped.push(`Ad group "${g.name}" already has that default max CPC.`)
      else {
        fields.push('cpc_bid_micros')
        update.cpcBidMicros = microsOfCents(c.defaultBidCents)
        was.defaultBidCents = g.cpcBidCents
        now.defaultBidCents = c.defaultBidCents
        lines.push([`ad group "${g.name}" default max CPC`, money(g.cpcBidCents, currency), money(c.defaultBidCents, currency)])
        if (g.cpcBidCents === null || c.defaultBidCents > g.cpcBidCents) {
          raises.push({ label: `"${g.name}"`, from: money(g.cpcBidCents, currency), to: money(c.defaultBidCents, currency), fromCents: g.cpcBidCents, toCents: c.defaultBidCents, servingNote: g.status === 'ENABLED' ? '' : 'paused' })
        }
      }
    }
    if (!fields.length) continue
    operations.push({ adGroupOperation: { update, updateMask: fields.join(',') } })
    before.adGroups.push(was)
    after.adGroups.push(now)
  }
  if (raises.length) {
    const pausedGroups = raises.filter((r) => r.servingNote).length
    const note = campaignPausedNote(campaign)
      || (pausedGroups === raises.length ? ' (the ad groups are paused: nothing spends until they are enabled)' : pausedGroups ? ` (${pausedGroups} of them paused)` : '')
    spends.push(raiseSentence('default max CPC', plural(raises.length, 'ad group'), raises, note))
    const total = raiseTotal('default max CPCs', plural(raises.length, 'ad group'), raises, currency)
    if (total) spends.push(total)
  }
  const bidNote = made.length || after.adGroups.some((g) => g.defaultBidCents !== undefined) ? biddingNote(campaign, 'the ad groups\' default max CPCs') : null
  if (bidNote) warnings.push(bidNote)

  if (operations.length === 0) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  const { changes: table, more } = changeLines(lines)
  const renamed = after.adGroups.filter((g) => g.name !== undefined).length
  const rebid = after.adGroups.filter((g) => g.defaultBidCents !== undefined).length
  const parts: string[] = []
  if (made.length) parts.push(`make ${plural(made.length, 'ad group')} (${status})`)
  if (renamed) parts.push(`rename ${plural(renamed, 'ad group')}`)
  if (rebid) parts.push(`change the default max CPC of ${plural(rebid, 'ad group')}`)
  return {
    summary: `Google Ads ad groups in "${campaign.name}": ${parts.join('; ')}.`,
    changes: table,
    totals: { operations: operations.length, adGroupsCreated: made.length, adGroupsRenamed: renamed, bidsChanged: rebid, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: spends,
    skipped,
    operations,
    stands: {
      campaign: { campaignId: campaign.campaignId, status: campaign.status, type: campaign.type, subType: campaign.subType, bidding: campaign.bidding },
      adGroups: live.adGroups.map((g) => ({ adGroupId: g.adGroupId, name: g.name, status: g.status, type: g.type, cpcBidCents: g.cpcBidCents }))
        .sort((x, y) => x.adGroupId.localeCompare(y.adGroupId)),
    },
    before,
    after,
  }
}

/** The record of a run, with the ids Google gave the ad groups (and product ads) it made, by operation index. */
export function adGroupRecordAfterRun(after: AdGroupChangeRecord, responses: GoogleMutateResponse[]): AdGroupChangeRecord {
  const at = (ref: string | undefined, kind: string): string | null => {
    if (!ref?.startsWith(NEW)) return ref ?? null
    const id = idOf(responses[Number(ref.slice(NEW.length))]?.[kind]?.resourceName)
    return id ? (id.includes('~') ? id.split('~')[1] : id) : null
  }
  return {
    campaignId: after.campaignId,
    adGroups: after.adGroups.map((g) => ({ ...g })),
    ...(after.created ? {
      created: after.created.map((c) => ({
        ...c,
        adGroupId: at(c.adGroupId, 'adGroupResult') ?? c.adGroupId,
        ...(c.adId !== undefined ? { adId: at(c.adId, 'adGroupAdResult') ?? c.adId } : {}),
      })),
    } : {}),
  }
}
