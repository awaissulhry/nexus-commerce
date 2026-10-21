/**
 * Meta step 32 — the live reads a dataset, custom conversion or event source group change stands on (GET only, through
 * the gateway; fixed paths and field lists). Step 11's reads (live-audiences.ts, live-datasets.ts) are reused for the
 * pixel lists and the verdict; these add only what a change needs to say "from → to" and to undo: a pixel's settings, the
 * businesses allowed to send its server events, its partners and people, the ad sets that optimise on a pixel or a custom
 * conversion, the account's custom conversions with Meta's 100-per-account count.
 *
 * Checked 2026-10-21: reference/ads-pixel.md (fields name, enable_automatic_matching, automatic_matching_fields,
 * first_party_cookie_status, data_use_setting, owner_business, is_unavailable), ads-pixel/server_events_permitted_business.md
 * (no params; Business nodes), ads-pixel/assigned_users (business required; SDK id, name, user_type, tasks), SDK
 * adspixel.py get_agencies / get_shared_agencies, reference/ad-campaign.md (promoted_object; SDK adpromotedobject.py
 * pixel_id, custom_conversion_id), ad-account/customconversions (max 100), custom-conversion (fields).
 */
import { metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaChosenAccount } from './live.js'
import { act, bool, part, readRows, text } from './live-audiences.js'
import { metaReadOne } from './read-client.js'

const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? metaObjectId((v as { id?: unknown }).id) : metaObjectId(v))
const strings = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v as string[]] : null)

export interface PixelSettings {
  id: string
  name: string | null
  enableAutomaticMatching: boolean | null
  automaticMatchingFields: string[] | null
  firstPartyCookieStatus: string | null
  dataUseSetting: string | null
  ownerBusinessId: string | null
  isUnavailable: boolean | null
}

export const PIXEL_SETTINGS_FIELDS = 'id,name,enable_automatic_matching,automatic_matching_fields,first_party_cookie_status,data_use_setting,owner_business{id},is_unavailable'

/** A pixel's settings (call only after the pixel was checked: signals-rule.ts ownSignalPixel). */
export async function livePixelSettings(account: MetaChosenAccount, pixelId: string): Promise<PixelSettings> {
  const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'signals.pixelSettings', path: pixelId, query: { fields: PIXEL_SETTINGS_FIELDS } })).body as Record<string, unknown>
  return {
    id: pixelId,
    name: text(body.name),
    enableAutomaticMatching: bool(body.enable_automatic_matching),
    automaticMatchingFields: strings(body.automatic_matching_fields),
    firstPartyCookieStatus: text(body.first_party_cookie_status),
    dataUseSetting: text(body.data_use_setting),
    ownerBusinessId: idOf(body.owner_business),
    isUnavailable: bool(body.is_unavailable),
  }
}


/** The business portfolios a pixel lets send server events (SG-014), or null when Meta does not show them. */
export async function liveServerEventBusinesses(account: MetaChosenAccount, pixelId: string): Promise<string[] | null> {
  const read = await part(() => readRows(account.connectionId, 'signals.serverEventBusinesses', `${pixelId}/server_events_permitted_business`, { fields: 'id' }, 100))
  if ('refused' in read || read.more) return null
  return read.rows.map((r) => idOf(r.id)).filter((id): id is string => !!id).sort()
}

/** The partner portfolios a pixel is shared with (agencies ∪ shared_agencies), or null when Meta does not show them. */
export async function livePixelPartners(account: MetaChosenAccount, pixelId: string): Promise<string[] | null> {
  const [agencies, shared] = await Promise.all([
    part(() => readRows(account.connectionId, 'signals.pixelAgencies', `${pixelId}/agencies`, { fields: 'id' }, 100)),
    part(() => readRows(account.connectionId, 'signals.pixelAgencies', `${pixelId}/shared_agencies`, { fields: 'id' }, 100)),
  ])
  if ('refused' in agencies || 'refused' in shared || agencies.more || shared.more) return null
  return [...new Set([...agencies.rows, ...shared.rows].map((r) => idOf(r.id)).filter((id): id is string => !!id))].sort()
}

/** Is the chosen ad account among the pixel's ad accounts in the portfolio? null when Meta does not say. */
export async function livePixelConnected(account: MetaChosenAccount, pixelId: string, portfolio: string): Promise<boolean | null> {
  const read = await part(() => readRows(account.connectionId, 'signals.pixelAccounts', `${pixelId}/shared_accounts`, { business: portfolio, fields: 'account_id' }, 200))
  if ('refused' in read) return null
  const found = read.rows.some((r) => String(r.account_id ?? r.id ?? '').replace(/^act_/, '') === account.adAccountId)
  return found ? true : read.more ? null : false
}

/** A person's tasks on a pixel (null: not assigned), or undefined when Meta does not show its people. */
export async function livePixelPersonTasks(account: MetaChosenAccount, pixelId: string, portfolio: string, userId: string): Promise<string[] | null | undefined> {
  const read = await part(() => readRows(account.connectionId, 'signals.pixelPeople', `${pixelId}/assigned_users`, { business: portfolio, fields: 'id,tasks' }, 500))
  if ('refused' in read) return undefined
  const row = read.rows.find((r) => idOf(r.id) === userId)
  if (!row) return read.more ? undefined : null
  return (strings(row.tasks) ?? []).sort()
}

/** An ad set that optimises on a pixel or a custom conversion (its promoted object), as a person reads it. */
export interface AdSetUsing { id: string; name: string | null; effectiveStatus: string | null }

/** The chosen ad account's ad sets with what their promoted object names (at most 500 read, one list for many checks). */
export async function livePromotedAdSets(account: MetaChosenAccount): Promise<{ rows: Array<AdSetUsing & { pixelId: string | null; customConversionId: string | null }>; more: boolean }> {
  const read = await readRows(account.connectionId, 'signals.adSetsUsing', `${act(account.adAccountId)}/adsets`, { fields: 'id,name,effective_status,promoted_object' }, 500)
  const rows = read.rows.map((r) => {
    const promoted = r.promoted_object && typeof r.promoted_object === 'object' ? r.promoted_object as Record<string, unknown> : {}
    return { id: idOf(r.id) ?? '', name: text(r.name), effectiveStatus: text(r.effective_status), pixelId: metaObjectId(promoted.pixel_id), customConversionId: metaObjectId(promoted.custom_conversion_id) }
  }).filter((r) => r.id)
  return { rows, more: read.more }
}

/** Of those, the ones that optimise on this pixel or custom conversion. */
export function adSetsUsing(read: Awaited<ReturnType<typeof livePromotedAdSets>>, match: { pixelId?: string; customConversionId?: string }): { adSets: AdSetUsing[]; more: boolean } {
  const adSets = read.rows.filter((r) => (match.pixelId && r.pixelId === match.pixelId) || (match.customConversionId && r.customConversionId === match.customConversionId))
    .map((r) => ({ id: r.id, name: r.name, effectiveStatus: r.effectiveStatus }))
  return { adSets, more: read.more }
}

/** The chosen ad account's ad sets whose promoted object names this pixel or custom conversion (at most 500 read). */
export async function liveAdSetsUsing(account: MetaChosenAccount, match: { pixelId?: string; customConversionId?: string }): Promise<{ adSets: AdSetUsing[]; more: boolean }> {
  return adSetsUsing(await livePromotedAdSets(account), match)
}

export interface ConversionRow {
  id: string
  name: string | null
  description: string | null
  customEventType: string | null
  /** Meta's default value as it answers it (a decimal of the account currency), or null. */
  defaultValue: string | null
  pixelId: string | null
  rule: string | null
  isArchived: boolean | null
  isUnavailable: boolean | null
}
export const CONVERSION_CHANGE_FIELDS = 'id,account_id,name,description,custom_event_type,default_conversion_value,pixel{id},rule,is_archived,is_unavailable'

const conversionRow = (r: Record<string, unknown>): ConversionRow => ({
  id: idOf(r.id) ?? '',
  name: text(r.name),
  description: text(r.description),
  customEventType: text(r.custom_event_type),
  defaultValue: typeof r.default_conversion_value === 'number' || typeof r.default_conversion_value === 'string' ? String(r.default_conversion_value) : null,
  pixelId: idOf(r.pixel),
  rule: text(r.rule),
  isArchived: bool(r.is_archived),
  isUnavailable: bool(r.is_unavailable),
})

/** The chosen ad account's custom conversions (Meta allows 100; read up to 200 so the count is whole). */
export async function liveConversions(account: MetaChosenAccount): Promise<{ rows: ConversionRow[]; complete: boolean }> {
  const read = await readRows(account.connectionId, 'signals.conversions', `${act(account.adAccountId)}/customconversions`, { fields: CONVERSION_CHANGE_FIELDS }, 200)
  return { rows: read.rows.map(conversionRow).filter((r) => r.id), complete: !read.more }
}

/** One custom conversion (call only after signals-rule.ts ownConversion checked it). */
export async function liveConversion(account: MetaChosenAccount, id: string): Promise<ConversionRow> {
  const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'signals.conversion', path: id, query: { fields: CONVERSION_CHANGE_FIELDS } })).body as Record<string, unknown>
  return { ...conversionRow(body), id }
}
