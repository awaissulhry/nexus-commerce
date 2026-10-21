/**
 * Meta ads, step 11 — the business's audiences, read LIVE from Meta (GET only, through the gateway). Nothing here stores
 * or changes anything (audience changes are step 31).
 *
 *   meta-audiences  the chosen ad account's custom and lookalike audiences (its own and the ones shared with it): size as
 *                   Meta's range, status, type, source, rule, integrity flags, expiry, the ads that use one (grouped by ad
 *                   set), its upload sessions, the value data shared through the Audience API, what it may be used for,
 *                   who it is shared with, the business portfolio's audience-sharing requests and permissions, saved
 *                   audiences, and whether the Custom Audience terms are signed (and the "existing customers" list).
 *
 * ALLOW-LISTS ONLY (lesson from steps 1–2): the caller never names a Graph path, field or parameter; every view sends a
 * fixed request with a fixed field list per node type, and every answer keeps only the keys named here. Every audience
 * id a caller gives is the chosen ad account's own (its `account_id`) or one Meta lists as shared with it; every pixel is
 * one of the chosen ad account's (`/act_<id>/adspixels`: pixels live on the ad account). An ad account another business
 * in Nexus uses (an owner of a shared-in audience, a recipient of a share, the account of an ad that uses an audience)
 * appears as `{ adAccountId, takenByAnotherBusiness: true }` only. A shared-in audience (another account owns it) is
 * read only for what the chosen account needs to use it — name, type, size range, status and its own labels; its rule,
 * source, seeds, uploads, value data and sharing are its owner's and are never asked (review A1). Customer-list
 * audiences: Meta never gives their members (only upload counts), and Nexus never asks (no `/users`, no `/salts`).
 *
 * Checked 2026-10-21 with `curl -sL <page>.md` (developers.facebook.com/documentation/ads-commerce/marketing-api/…) and
 * Meta's Python Business SDK (github.com/facebook/facebook-python-business-sdk, main, facebook_business/adobjects):
 *   - reference/ad-account/customaudiences (GET: fields — default ids only —, filtering [{field, operator, value}],
 *     pixel_id, business_id, fetch_primary_audience); audiences/guides/custom-audiences FAQ (error 1 "Please reduce the
 *     amount of data" → a limit of 20 with paging; acting_account_id reads the labels a shared-in account set);
 *   - reference/custom-audience (fields account_id, approximate_count_lower_bound / _upper_bound — -1 for inactive
 *     lookalikes —, customer_file_source, data_source, delivery_status, description, external_event_source — errors
 *     without pixel permission, so never asked —, fields_violating_integrity_policy, is_value_based,
 *     lookalike_audience_ids, lookalike_spec, name, operation_status, opt_out_link, permission_for_actions, pixel_id,
 *     retention_days, rule, rule_aggregation, sharing_status, subtype, time_created / _updated / _content_updated;
 *     param ad_account_id = the recipient ad account's view); SDK customaudience.py adds delete_time and audience_labels;
 *   - audiences/overview#custom-audiences-deletion (expiring after 2 years unused: operation_status 100 and delete_time =
 *     90 days after the flag; the filter `delete_time GREATER_THAN 0`; saved audiences the same) and
 *     audiences/guides/lookalike-audiences (#inactive: 450, size -1 after 90 days unused; "no size … -1 for all lookalike
 *     audiences" since the size change; refresh about every 3 days);
 *   - custom-audience/ads (effective_status, status), /sessions (session_id; SDK customaudiencesession.py: session_id,
 *     start_time, end_time, num_received, num_matched, num_invalid_entries, progress, stage), /health (calculated_date,
 *     processed_date, value_aggregation_duration, value_country, value_currency, value_version — the value data shared
 *     through the Audience API, not delivery), /capabilities (no params; the page is a stub, so its meaning is not
 *     documented), /shared_account_info (SDK: account_id, account_name, business_id, business_name, sharing_status),
 *     /shared_account_campaign_info (SDK: account_id, account_name, adset_including_count, adset_excluding_count,
 *     campaign_delivery_status, campaign_objective, campaign_schedule), /adaccounts (permissions targeting |
 *     targeting_and_insights); there is no public /{audience}/adsets edge (Meta's own MCP has one; Nexus groups the ads by
 *     ad set — RECHECK AU-006);
 *   - reference/ad-account/saved_audiences (fields, filtering, business_id; read only) and saved-audience (SDK
 *     savedaudience.py: id, name, description, targeting, sentence_lines, approximate_count_lower_bound / _upper_bound,
 *     run_status, operation_status, delete_time, time_created, time_updated, account);
 *   - audiences/reference/custom-audience-terms-of-service (GET act_<id>?fields=tos_accepted → {custom_audience_tos: 1};
 *     user_tos_accepted only for a person's token; system users cannot sign: a person signs at
 *     business.facebook.com/ads/manage/customaudiences/tos/?act=<id>), reference/ad-account/customaudiencestos (no params);
 *     advantage-shopping-campaigns (existing_customers: the audience ids of the account's existing customers);
 *   - reference/business/initiated_audience_sharing_requests (recipient_id, request_status) and
 *     received_audience_sharing_requests (initiator_id, request_status): BusinessAssetSharingAgreement (SDK: id, initiator,
 *     recipient, relationship_type, request_status, request_type) plus custom_audiences; accepting one is UI-only;
 *     business/shared_audience_permissions and received_audience_permissions (partner_id): AudiencePermission (SDK:
 *     audience, share_account_id, share_account_name).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { AD_STATUSES_READ } from './mappers.js'
import { takenIds } from './taken.js'

export const AUDIENCE_VIEWS = [
  'list', 'detail', 'expiring', 'flagged', 'lookalikes', 'ads-using', 'sessions', 'health', 'sharing', 'business-sharing', 'saved', 'terms',
] as const
export type AudienceView = typeof AUDIENCE_VIEWS[number]

/** Meta's custom audience subtypes (reference/custom-audience `subtype`; Nexus filters the rows it read by it). */
export const AUDIENCE_SUBTYPES = [
  'CUSTOM', 'WEBSITE', 'APP', 'OFFLINE_CONVERSION', 'CLAIM', 'MANAGED', 'PARTNER', 'VIDEO', 'LOOKALIKE', 'ENGAGEMENT', 'BAG_OF_ACCOUNTS',
  'STUDY_RULE_AUDIENCE', 'FOX', 'MEASUREMENT', 'REGULATED_CATEGORIES_AUDIENCE', 'BIDDING', 'EXCLUSION', 'PRIMARY', 'IG_BUSINESS', 'FB_EVENT',
  'EXPERIMENTAL', 'MULTI_DATA',
] as const
/** BusinessAssetSharingAgreement request_status (reference/business/initiated_audience_sharing_requests). */
export const SHARING_REQUEST_STATUSES = [
  'APPROVE', 'DECLINE', 'IN_PROGRESS', 'EXPIRED', 'PENDING', 'PENDING_INTEGRITY_REVIEW', 'PENDING_EMAIL_VERIFICATION', 'CANCELED',
  'MMA_DIRECT_ASSETS_PENDING', 'MMA_DIRECT_ASSETS_APPROVED', 'MMA_DIRECT_ASSETS_DECLINED', 'MMA_DIRECT_ASSETS_EXPIRED',
] as const
export const SHARE_PERMISSIONS = ['targeting', 'targeting_and_insights'] as const

// ── small helpers (live-datasets.ts uses them too) ───────────────────────────────────────────────────────────────

export const act = (id: string) => `act_${id}`
export const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
export const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}
export const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
export function refuse(message: string): never { throw new MetaLiveRefusal(message) }
const camel = (key: string) => key.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase())
const idText = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? metaObjectId(v) : null)

/** A Unix time in seconds (Meta's audience times) → ISO; null for none or 0. */
export function unixToIso(v: unknown): string | null {
  const n = num(v)
  return n && n > 0 ? new Date(n * 1000).toISOString() : null
}

const MAX_TEXT = 4000

/**
 * Meta's nested answer as plain values only (objects at most six levels deep — a saved audience's targeting with its
 * flexible_spec interests fits —, lists of at most 100, strings of at most 4,000 characters), keys in camelCase: no
 * Graph paging, no key naming a token or secret, nothing deeper.
 */
export function plain(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string') return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT - 1)}…` : value
  if (depth >= 6) return undefined
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => plain(v, depth + 1)).filter((v) => v !== undefined)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'paging' || /token|secret/i.test(key)) continue
      const clean = plain(child, depth + 1)
      if (clean !== undefined) out[camel(key)] = clean
    }
    return out
  }
  return undefined
}

/** One answer row with only the keys named (camelCase), as plain values. */
export function pickRow(row: unknown, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (!row || typeof row !== 'object') return out
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(row, key)) continue
    const value = plain((row as Record<string, unknown>)[key], 1)
    if (value !== undefined) out[camel(key)] = value
  }
  return out
}

/** Meta's error 1 ("Please reduce the amount of data you're asking for"): ask again with smaller pages. */
const lessData = (err: unknown) => err instanceof MetaReadError && err.failure.origin === 'meta' && (err.failure.code ?? '').split('/')[0] === '1'

/** Every row of a list, at most maxRows (pages of 100, or 20 when Meta asks for less data at once). */
export async function readRows(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number, pageSize = 100) {
  const read = async (size: number) => {
    const rows: Record<string, unknown>[] = []
    const result = await metaReadAll({ connectionId }, { operation, path, query: { limit: size, ...query }, maxPages: Math.ceil(maxRows / size) }, (page) => { rows.push(...page) })
    return { rows: rows.slice(0, maxRows), more: result.truncated || rows.length > maxRows }
  }
  const size = Math.max(1, Math.min(pageSize, maxRows))
  try {
    return await read(size)
  } catch (err) {
    if (size > 20 && lessData(err)) return read(20)
    throw err
  }
}

/**
 * Rows of a list kept by `keep`, read page by page until `want` rows are kept or the list ends — at most `maxPages`
 * pages (then `capped`: more may match; never said to be all of them).
 */
export async function scanRows(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, opts: { want: number; keep: (row: Record<string, unknown>) => boolean; pageSize: number; maxPages: number }) {
  let size = Math.max(1, opts.pageSize)
  const kept: Record<string, unknown>[] = []
  let after: string | null = null
  let scanned = 0
  let pages = 0
  while (pages < opts.maxPages) {
    let body: { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } }
    try {
      body = (await metaReadOne({ connectionId }, { operation, path, query: { limit: size, ...query, ...(after ? { after } : {}) } })).body as typeof body
    } catch (err) {
      // Meta's "reduce the amount of data" on the first page: the same list in pages of 20.
      if (pages === 0 && size > 20 && lessData(err)) { size = 20; continue }
      throw err
    }
    pages++
    const data = Array.isArray(body.data) ? body.data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : []
    scanned += data.length
    for (const row of data) if (opts.keep(row)) kept.push(row)
    const next = typeof body.paging?.cursors?.after === 'string' && body.paging?.next ? body.paging.cursors.after : null
    if (!next) return { rows: kept.slice(0, opts.want), scanned, more: kept.length > opts.want, capped: false }
    if (kept.length >= opts.want) return { rows: kept.slice(0, opts.want), scanned, more: true, capped: false }
    after = next
  }
  return { rows: kept.slice(0, opts.want), scanned, more: true, capped: true }
}

/**
 * One part of a view that reads several things: its answer, or the refusal in words (that part alone) — Meta's, or
 * Nexus's own before a call (e.g. no business portfolio for a per-portfolio read). A lost token, a throttle or a gateway
 * refusal ends the whole view.
 */
export async function part<T>(work: () => Promise<T>): Promise<T | { refused: string }> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refused: err.message }
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled && err.failure.origin === 'meta') return { refused: err.failure.sentence }
    throw err
  }
}

/**
 * Rows naming an ad account: one another business in Nexus uses is reduced to its id and the flag (never its name or
 * anything else of the row); every other row says it is not.
 */
export async function maskedAccounts<T extends Record<string, unknown>>(rows: T[], idKey: string): Promise<Array<(T & { takenByAnotherBusiness: false }) | { adAccountId: string; takenByAnotherBusiness: true }>> {
  const ids = rows.map((r) => metaAdAccountId(r[idKey])).filter((id): id is string => !!id)
  const taken = await takenIds('AD_ACCOUNT', ids)
  return rows.map((r) => {
    const id = metaAdAccountId(r[idKey])
    return id && taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true as const } : { ...r, takenByAnotherBusiness: false as const }
  })
}

// ── pixels of the chosen ad account (live-datasets.ts too) ────────────────────────────────────────────────────────

/** The ids of the chosen ad account's pixels (Meta: pixels live on the ad account, /act_<id>/adspixels). */
export async function chosenPixelIds(account: MetaChosenAccount): Promise<string[]> {
  const read = await readRows(account.connectionId, 'datasets.chosenPixels', `${act(account.adAccountId)}/adspixels`, { fields: 'id' }, 200)
  return read.rows.map((r) => idText(r.id)).filter((id): id is string => !!id)
}

/**
 * The ad accounts a pixel is connected to inside the chosen account's business portfolio (shared_accounts: `business`
 * is required), and whether one of them is an ad account another business in Nexus uses (then that account is its id
 * and the flag only).
 */
export async function pixelAccounts(account: MetaChosenAccount, pixelId: string, maxRows = 200) {
  if (!account.businessId) refuse('the chosen ad account belongs to no business portfolio Nexus knows, and Meta lists a pixel\'s ad accounts per portfolio')
  const read = await readRows(account.connectionId, 'datasets.sharedAccounts', `${pixelId}/shared_accounts`, { business: account.businessId, fields: 'account_id,name' }, maxRows)
  const ids = read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('AD_ACCOUNT', ids)
  return {
    items: read.rows.map((r) => {
      const id = metaAdAccountId(r.account_id ?? r.id)
      if (id && taken.has(id)) return { adAccountId: id, takenByAnotherBusiness: true as const }
      return { adAccountId: id, name: text(r.name), chosenHere: id === account.adAccountId, takenByAnotherBusiness: false as const }
    }),
    usedByAnotherBusiness: taken.size > 0,
    more: read.more,
  }
}

/**
 * Is this pixel also used by another business in Nexus? Checked every time, never assumed (reviews A-N1, A-N6). Nexus
 * knows the ad accounts another business chose and their business portfolios (nexus_meta_links_taken AD_ACCOUNT and
 * PORTFOLIO, step 10), and Meta lists a pixel's ad accounts only per portfolio (shared_accounts, `business` required;
 * ads-pixel reference: owner_business, edge shared_agencies "Agencies or other businesses this pixel is shared with";
 * the sharing guides and SDK also read /agencies). So:
 *   - taken: its owner portfolio or a portfolio it is shared with (shared_agencies or agencies) is one another
 *     business's chosen ad account belongs to — whatever Meta's ad-account lists say —, or an ad account it is
 *     connected to in the chosen portfolio or a partner portfolio is one another business chose. (The chosen portfolio
 *     itself is not judged as a whole: two businesses may share one; its ad-account list is read in full instead);
 *   - unchecked (every view refuses it): it is owned by another portfolio; the chosen ad account is not among its ad
 *     accounts in the chosen portfolio; any of these reads is refused or cut; it is shared with more portfolios than
 *     Nexus checks at once;
 *   - free: all of these read in full, and none of them hit.
 * One answer checks each pixel once (review S2: verdicts are kept per chosen-account read, i.e. per answer).
 */
export function pixelVerdict(account: MetaChosenAccount, pixelId: string): Promise<{ taken: boolean } | { unchecked: string }> {
  let cache = VERDICTS.get(account)
  if (!cache) { cache = new Map(); VERDICTS.set(account, cache) }
  let verdict = cache.get(pixelId)
  if (!verdict) { verdict = checkPixel(account, pixelId); cache.set(pixelId, verdict) }
  return verdict
}

/** Verdicts per chosen-account object (one per answer: metaChosenAccount reads a fresh one each time). */
const VERDICTS = new WeakMap<MetaChosenAccount, Map<string, Promise<{ taken: boolean } | { unchecked: string }>>>()

async function checkPixel(account: MetaChosenAccount, pixelId: string): Promise<{ taken: boolean } | { unchecked: string }> {
  if (!account.businessId) return { unchecked: 'the chosen ad account belongs to no business portfolio Nexus knows, and Meta lists a pixel\'s ad accounts per portfolio' }
  const [owner, sharedAgencies, agencies] = await Promise.all([
    part(async () => {
      const body = (await metaReadOne({ connectionId: account.connectionId }, { operation: 'datasets.pixelOwner', path: pixelId, query: { fields: 'owner_business{id}' } })).body as { owner_business?: { id?: unknown } | null }
      return { ownerId: body.owner_business && typeof body.owner_business === 'object' ? idText(body.owner_business.id) : null }
    }),
    part(() => readRows(account.connectionId, 'datasets.pixelAgencies', `${pixelId}/shared_agencies`, { fields: 'id' }, MAX_PIXEL_AGENCIES + 1)),
    part(() => readRows(account.connectionId, 'datasets.pixelAgencies', `${pixelId}/agencies`, { fields: 'id' }, MAX_PIXEL_AGENCIES + 1)),
  ])
  if ('refused' in owner) return { unchecked: owner.refused }
  if ('refused' in sharedAgencies) return { unchecked: sharedAgencies.refused }
  if ('refused' in agencies) return { unchecked: agencies.refused }
  const { ownerId } = owner
  const partners = [...new Set([...sharedAgencies.rows, ...agencies.rows].map((r) => idText(r.id)).filter((id): id is string => !!id && id !== account.businessId))]
  // Review A-N6 — a portfolio another business's chosen ad account belongs to: taken, before any of Meta's lists.
  const portfolios = [...partners, ...(ownerId && ownerId !== account.businessId ? [ownerId] : [])]
  if ((await takenIds('PORTFOLIO', portfolios)).size > 0) return { taken: true }
  if (ownerId !== account.businessId) return { unchecked: ownerId ? 'the pixel is owned by another business portfolio' : 'Meta names no owner portfolio for the pixel' }
  const accounts = await part(() => pixelAccounts(account, pixelId, 200))
  if ('refused' in accounts) return { unchecked: accounts.refused }
  if (accounts.usedByAnotherBusiness) return { taken: true }
  if (accounts.more) return { unchecked: 'the pixel is connected to more ad accounts than Nexus reads at once (200)' }
  if (!accounts.items.some((a) => a.adAccountId === account.adAccountId)) return { unchecked: 'Meta does not list the chosen ad account among the pixel\'s ad accounts in its portfolio, so where else it is used cannot be seen' }
  if (sharedAgencies.more || agencies.more || partners.length > MAX_PIXEL_AGENCIES) return { unchecked: `the pixel is shared with more business portfolios than Nexus checks at once (${MAX_PIXEL_AGENCIES})` }
  // The partner portfolios: their ad accounts it is connected to, each read like the chosen portfolio's.
  for (const businessId of partners) {
    const read = await part(() => readRows(account.connectionId, 'datasets.sharedAccounts', `${pixelId}/shared_accounts`, { business: businessId, fields: 'account_id' }, 200))
    if ('refused' in read) return { unchecked: `the pixel is shared with another business portfolio whose ad accounts Meta does not show (${read.refused})` }
    if (read.more) return { unchecked: 'the pixel is connected to more ad accounts of a partner portfolio than Nexus reads at once (200)' }
    const taken = await takenIds('AD_ACCOUNT', read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id))
    if (taken.size > 0) return { taken: true }
  }
  return { taken: false }
}

/** Portfolio rows (`{ id, name }`): one another business in Nexus uses is its id and the flag only (review A-N7). */
export async function maskedPortfolios(rows: unknown[]): Promise<unknown[]> {
  const ids = rows.map((r) => (r && typeof r === 'object' ? idText((r as { id?: unknown }).id) : null)).filter((id): id is string => !!id)
  const taken = await takenIds('PORTFOLIO', ids)
  return rows.map((r) => {
    const id = r && typeof r === 'object' ? idText((r as { id?: unknown }).id) : null
    if (!id) return r
    return taken.has(id) ? { id, takenByAnotherBusiness: true } : { ...(plain(r, 1) as Record<string, unknown>), takenByAnotherBusiness: false }
  })
}

/** At most this many partner portfolios of a pixel are checked (each one more read). */
const MAX_PIXEL_AGENCIES = 5

export const TAKEN_PIXEL = 'That pixel is also connected to an ad account another business in Nexus uses, so Nexus does not read it here (its events belong to both businesses). Use a pixel of this business\'s own, or disconnect the other account from it in Meta\'s Events Manager.'

/**
 * A pixel id of the chosen ad account's (or its only pixel, when none is named) and whether another business in Nexus
 * uses it too; refused in words when it is not the chosen account's or Nexus could not check it.
 */
export async function ownPixelState(account: MetaChosenAccount, pixelId: string | null | undefined, allowDefault = true): Promise<{ pixelId: string; takenByAnotherBusiness: boolean }> {
  const ids = await chosenPixelIds(account)
  let id: string
  if (!pixelId) {
    if (!allowDefault) refuse('Name the pixel (pixelId from meta-datasets view list).')
    if (ids.length !== 1) {
      refuse(ids.length === 0
        ? 'The ad account this business chose has no pixel (dataset) yet. Meta creates one in Events Manager, or create-meta-dataset asks for it (a person approves it).'
        : `The ad account this business chose has ${ids.length} pixels: name one (pixelId from meta-datasets view list).`)
    }
    id = ids[0]
  } else {
    id = metaObjectId(pixelId) ?? refuse(`"${pixelId}" is not a Meta pixel id (digits).`)
    if (!ids.includes(id)) refuse('That pixel is not on the ad account this business chose, so it is not read (pixels live on the ad account; meta-datasets view list shows its pixels).')
  }
  const verdict = await pixelVerdict(account, id)
  if ('unchecked' in verdict) refuse(`Nexus could not check whether another business in Nexus also uses this pixel (${verdict.unchecked}), so it does not read it.`)
  return { pixelId: id, takenByAnotherBusiness: verdict.taken }
}

/** A pixel of the chosen ad account that no other business in Nexus uses, else refused in words. */
export async function ownPixel(account: MetaChosenAccount, pixelId: string | null | undefined, allowDefault = true): Promise<string> {
  const state = await ownPixelState(account, pixelId, allowDefault)
  if (state.takenByAnotherBusiness) refuse(TAKEN_PIXEL)
  return state.pixelId
}

// ── audiences ────────────────────────────────────────────────────────────────────────────────────────────────────

/** What every audience row is read with (reference/custom-audience; delete_time from audiences/overview). */
export const AUDIENCE_FIELDS = [
  'id', 'account_id', 'name', 'subtype', 'description', 'approximate_count_lower_bound', 'approximate_count_upper_bound', 'delivery_status',
  'operation_status', 'data_source', 'customer_file_source', 'retention_days', 'is_value_based', 'pixel_id', 'sharing_status',
  'fields_violating_integrity_policy', 'time_created', 'time_updated', 'time_content_updated', 'delete_time',
].join(',')
/** One audience in full: its rule, lookalike spec, seeds, permissions, opt-out link and labels too. */
export const AUDIENCE_DETAIL_FIELDS = `${AUDIENCE_FIELDS},rule,rule_aggregation,lookalike_spec,lookalike_audience_ids,permission_for_actions,opt_out_link,audience_labels`
const LOOKALIKE_FIELDS = `${AUDIENCE_FIELDS},lookalike_spec`
const AUDIENCE_ADS_FIELDS = 'id,name,account_id,campaign_id,adset_id,effective_status'
const SESSION_FIELDS = 'session_id,start_time,end_time,num_received,num_matched,num_invalid_entries,progress,stage'
const SHARED_INFO_FIELDS = 'account_id,account_name,business_id,business_name,sharing_status'
const SHARED_CAMPAIGN_FIELDS = 'account_id,account_name,adset_including_count,adset_excluding_count,campaign_delivery_status,campaign_objective,campaign_schedule'
const SHARING_REQUEST_FIELDS = 'id,initiator{id,name},recipient{id,name},relationship_type,request_status,request_type,custom_audiences'
const AUDIENCE_PERMISSION_FIELDS = 'audience{id,name,account_id},share_account_id,share_account_name'
/**
 * Review A1 — a SHARED-IN audience (another account owns it) is read only for what the chosen account needs to use it:
 * its name and type, its size range, whether it can deliver, and the labels the chosen account set on it. Its rule,
 * lookalike spec and seeds, source, pixel, opt-out link and description are its owner's: never asked.
 */
export const SHARED_IN_DETAIL_FIELDS = 'id,account_id,name,subtype,approximate_count_lower_bound,approximate_count_upper_bound,delivery_status,operation_status,audience_labels'
const SAVED_FIELDS = 'id,name,description,approximate_count_lower_bound,approximate_count_upper_bound,run_status,operation_status,delete_time,time_created,time_updated'
const SAVED_DETAIL_FIELDS = `${SAVED_FIELDS},targeting,sentence_lines`

/** operation_status codes Meta's pages explain (others: Meta's own description is shown). */
const OPERATION_WORDS: Readonly<Record<number, string>> = {
  100: 'Expiring: not used in an active ad set for over 2 years; Meta deletes it 90 days after it was flagged (delete_time) unless an active ad set uses it before then.',
  200: 'Normal: ready.',
  450: 'Inactive lookalike: not used in active ads for 90 days; it can still be used, but Meta gives no size or estimate until an ad using it is published.',
  471: 'Flagged for integrity: its name, description or rule may suggest information Meta does not allow (fieldsViolatingIntegrityPolicy); ad sets using it run WITH_ISSUES, and a flagged lookalike or customer-list audience cannot be edited.',
}

const status = (v: unknown) => {
  const o = v && typeof v === 'object' ? v as { code?: unknown; description?: unknown } : null
  return o ? { code: num(o.code), description: text(o.description) } : null
}

/**
 * Meta's size range (a lower and an upper bound; never one number). -1 (Meta's "no size": every lookalike since Meta's
 * size change, an inactive lookalike, an audience not ready) is null with the reason.
 */
export function audienceSize(lower: unknown, upper: unknown): { size: { lowerBound: number; upperBound: number } | null; sizeNote: string | null } {
  const lo = num(lower)
  const hi = num(upper)
  if (lo === null || hi === null) return { size: null, sizeNote: 'Meta gave no size for this audience.' }
  if (lo < 0 || hi < 0) return { size: null, sizeNote: 'Meta gives no size here (-1): every lookalike audience, an inactive lookalike, or an audience not ready yet. Its reach shows in a delivery estimate (meta-targeting-check) once it is ready.' }
  return { size: { lowerBound: lo, upperBound: hi }, sizeNote: 'A range from Meta, never an exact count.' }
}

function deliveryOf(v: unknown) {
  const s = status(v)
  if (!s) return null
  const usable = s.code === null ? null : s.code === 200
  const words = s.code === 200 ? 'Ready to be used in ads.' : s.code === 300 ? 'Too small to deliver ads yet.' : s.code !== null && s.code >= 400 ? 'Cannot be used in ads.' : null
  return { ...s, usableInAds: usable, words }
}

/** Is this raw audience row flagged for integrity (operation 471, or fields named)? */
const flaggedRaw = (row: Record<string, unknown>) => status(row.operation_status)?.code === 471
  || (Array.isArray(row.fields_violating_integrity_policy) && row.fields_violating_integrity_policy.length > 0)

/**
 * One audience row as Nexus answers it (the chosen account's view). A shared-in audience (another account owns it)
 * keeps only what the chosen account needs to use it — review A1: id, name, type, size range, delivery and operation
 * status, and its owner account (only its id and the flag when another business in Nexus uses that account).
 */
export function audienceRow(row: Record<string, unknown>, chosenAdAccountId: string, takenOwners: ReadonlySet<string>) {
  const owner = metaAdAccountId(row.account_id)
  const operation = status(row.operation_status)
  const flaggedFields = Array.isArray(row.fields_violating_integrity_policy) ? row.fields_violating_integrity_policy.filter((f): f is string => typeof f === 'string') : []
  const deleteTime = unixToIso(row.delete_time)
  const { size, sizeNote } = audienceSize(row.approximate_count_lower_bound, row.approximate_count_upper_bound)
  const source = row.data_source && typeof row.data_source === 'object' ? row.data_source as Record<string, unknown> : null
  const sharedIn = owner !== null && owner !== chosenAdAccountId
  const common = {
    audienceId: idText(row.id),
    name: text(row.name),
    subtype: text(row.subtype),
    sharedIn,
    ownerAdAccount: owner && sharedIn ? (takenOwners.has(owner) ? { adAccountId: owner, takenByAnotherBusiness: true } : { adAccountId: owner, takenByAnotherBusiness: false }) : null,
    size,
    sizeNote,
    delivery: deliveryOf(row.delivery_status),
    operation: operation ? { ...operation, words: operation.code !== null ? OPERATION_WORDS[operation.code] ?? null : null } : null,
    flagged: operation?.code === 471 || flaggedFields.length > 0,
    expiring: operation?.code === 100 || deleteTime !== null,
  }
  if (sharedIn) return common
  return {
    ...common,
    description: text(row.description),
    dataSource: source ? { type: text(source.type), subType: text(source.sub_type) } : null,
    customerFileSource: text(row.customer_file_source),
    retentionDays: num(row.retention_days),
    isValueBased: bool(row.is_value_based),
    pixelId: idText(row.pixel_id),
    sharingStatus: plain(row.sharing_status, 1) ?? null,
    flaggedFields,
    deleteTime,
    createdTime: unixToIso(row.time_created),
    updatedTime: unixToIso(row.time_updated),
    peopleUpdatedTime: unixToIso(row.time_content_updated),
  }
}

async function audienceRows(account: MetaChosenAccount, rows: Record<string, unknown>[]) {
  const owners = rows.map((r) => metaAdAccountId(r.account_id)).filter((id): id is string => !!id && id !== account.adAccountId)
  const taken = await takenIds('AD_ACCOUNT', owners)
  return rows.map((r) => audienceRow(r, account.adAccountId, taken)).filter((r) => r.audienceId)
}

/**
 * Is this audience the chosen ad account's own (its account_id), or one Meta lists for the chosen account (shared with
 * it)? Else refused in words — never read for another account.
 */
export async function ownAudience(account: MetaChosenAccount, id: string): Promise<{ audienceId: string; sharedIn: boolean }> {
  const audienceId = metaObjectId(id) ?? refuse(`"${id}" is not a Meta audience id (digits).`)
  try {
    // `subtype` too: only an audience has one, so a campaign or ad set id of the account is never taken for an audience
    // (Meta refuses the field on another node type).
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'audiences.ownerCheck', path: audienceId, query: { fields: 'account_id,subtype' } })
    if (metaAdAccountId((read.body as { account_id?: unknown }).account_id) === account.adAccountId) return { audienceId, sharedIn: false }
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled || err.failure.origin !== 'meta') throw err
  }
  const listed = await readRows(account.connectionId, 'audiences.sharedCheck', `${act(account.adAccountId)}/customaudiences`, { fields: 'id' }, 1000)
  if (listed.rows.some((r) => idText(r.id) === audienceId)) return { audienceId, sharedIn: true }
  refuse('That audience is not the chosen ad account\'s, nor shared with it, so it is not read (view list shows the audiences it can use).')
}

/** Review B7 — at most this many pages (of 50) a filtered audience view reads. */
export const MAX_SCAN_PAGES = 40
const SHARED_IN_WORDS = 'Shared with the chosen ad account by its owner: Nexus shows only what the chosen account needs to use it (name, type, size range, status and the labels the chosen account set). Its rule, source, seeds, uploads, value data and sharing are its owner\'s.'
const SHARED_IN_REFUSAL = 'That audience is shared with the chosen ad account by its owner: its uploads, value data and sharing belong to its owner, so Nexus does not read them (view detail shows what the chosen account may see).'
const idOf = (v: unknown): string | null => (v && typeof v === 'object' ? idText((v as { id?: unknown }).id) : idText(v))

const TERMS_LINK = (adAccountId: string) => `https://business.facebook.com/ads/manage/customaudiences/tos/?act=${adAccountId}`

export interface AudiencesInput {
  connectionId?: string | null
  view: AudienceView
  audienceId?: string | null
  pixelId?: string | null
  subtype?: string | null
  sessionId?: string | null
  calculatedDate?: string | null
  processedDate?: string | null
  permissions?: string | null
  requestStatus?: string | null
  partnerBusinessId?: string | null
  savedAudienceId?: string | null
  maxRows?: number
}

/** One view of meta-audiences. */
export async function audiencesView(input: AudiencesInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const maxRows = Math.min(1000, Math.max(1, input.maxRows ?? 200))
  const base = { adAccountId }
  const listPath = `${act(adAccountId)}/customaudiences`
  const needAudience = async () => {
    if (!input.audienceId) refuse(`view ${input.view} reads one audience: name it (audienceId from view list).`)
    return ownAudience(account, input.audienceId)
  }

  switch (input.view) {
    case 'list':
    case 'flagged':
    case 'lookalikes': {
      const pixelId = input.pixelId ? await ownPixel(account, input.pixelId, false) : null
      const fields = input.view === 'lookalikes' ? LOOKALIKE_FIELDS : AUDIENCE_FIELDS
      const query = { fields, ...(pixelId ? { pixel_id: pixelId } : {}) }
      const subtype = input.view === 'lookalikes' ? 'LOOKALIKE' : input.subtype ?? null
      // AU-001 — the account's own and shared-in audiences, pages of 50 (an audience row is wide; Meta suggests 20 when
      // it asks for less data, which both readers do). Review B7 — a filtered view reads on until it has enough matches
      // or MAX_SCAN_PAGES pages, and says so when the cap stopped it.
      const filtered = input.view === 'flagged' || !!subtype
      const read = filtered
        ? await scanRows(connectionId, `audiences.${input.view}`, listPath, query, {
          want: maxRows, pageSize: 50, maxPages: MAX_SCAN_PAGES,
          keep: (r) => (!subtype || r.subtype === subtype) && (input.view !== 'flagged' || flaggedRaw(r)),
        })
        : { ...(await readRows(connectionId, `audiences.${input.view}`, listPath, query, maxRows, 50)), scanned: null, capped: false }
      const items = await audienceRows(account, read.rows)
      const out = input.view === 'lookalikes'
        ? items.map((item) => {
          // Review A1 — a shared-in lookalike's spec (its seeds, countries) is its owner's: not shown.
          if (item.sharedIn) return item
          const raw = read.rows.find((r) => idText(r.id) === item.audienceId)
          return { ...item, lookalikeSpec: plain(raw?.lookalike_spec, 1) ?? null }
        })
        : items
      return {
        ...base, view: input.view, ...(pixelId ? { pixelId } : {}), ...(subtype ? { subtype } : {}),
        items: out, more: read.more,
        ...(read.scanned !== null ? { audiencesScanned: read.scanned } : {}),
        ...(read.capped ? { stoppedAtPageCap: `Nexus read the first ${read.scanned} audiences of the account (${MAX_SCAN_PAGES} pages) and stopped there: more may match.` } : {}),
        note: input.view === 'flagged'
          ? 'Audiences Meta flagged for integrity (operation 471, or fields named in flaggedFields): change the flagged name, description or rule (an edit that leaves them is refused, 100/1713231); a flagged lookalike or customer-list audience cannot be edited, and since v24 a campaign using one cannot be created or updated.'
          : input.view === 'lookalikes'
            ? 'Lookalike audiences of the chosen account with their spec (type, ratio, countries, origin). Meta gives no size for lookalikes (-1); one unused in active ads for 90 days is inactive (450); Meta refreshes a lookalike about every 3 days while an ad set uses it. A seed\'s lookalikes: view detail of the seed (lookalikeAudienceIds).'
            : 'Sizes are Meta\'s ranges (lowerBound to upperBound), never an exact number. sharedIn: shared with the chosen account by its owner — only its name, type, size and status are shown (the rest is its owner\'s); its owner account is its id only when another business in Nexus uses it. Customer-list members are never shown (Meta does not give them).',
      }
    }
    case 'expiring': {
      // AU-003 — Meta's own filter for expiring audiences (audiences/overview#custom-audiences-deletion).
      const read = await readRows(connectionId, 'audiences.expiring', listPath, {
        fields: AUDIENCE_FIELDS, filtering: [{ field: 'delete_time', operator: 'GREATER_THAN', value: 0 }],
      }, maxRows, 50)
      return {
        ...base, view: 'expiring', items: await audienceRows(account, read.rows), more: read.more,
        note: 'Audiences Meta flagged as expiring (not used in an active ad set for over 2 years): Meta deletes each at deleteTime (90 days after the flag). To keep one, use it in an ACTIVE ad set before then; to let it go, do nothing.',
      }
    }
    case 'detail': {
      const own = await needAudience()
      if (own.sharedIn) {
        // AU-002 / AU-014, review A1 — a shared-in audience as the chosen account sees it (ad_account_id) with the labels
        // the chosen account set on it (acting_account_id): its name, type, size, status and those labels only.
        const read = await metaReadOne({ connectionId }, { operation: 'audiences.detail', path: own.audienceId, query: { fields: SHARED_IN_DETAIL_FIELDS, ad_account_id: adAccountId, acting_account_id: adAccountId } })
        const body = read.body as Record<string, unknown>
        const [row] = await audienceRows(account, [{ ...body, id: body.id ?? own.audienceId }])
        return {
          ...base, view: 'detail',
          audience: { ...row, labels: plain(body.audience_labels, 1) ?? null, labelsOf: 'the chosen ad account (acting_account_id)' },
          note: SHARED_IN_WORDS,
        }
      }
      // AU-002 — the account's own audience in full; AU-009 what Meta says it may be used for.
      const read = await metaReadOne({ connectionId }, { operation: 'audiences.detail', path: own.audienceId, query: { fields: AUDIENCE_DETAIL_FIELDS } })
      const body = read.body as Record<string, unknown>
      const [row] = await audienceRows(account, [{ ...body, id: body.id ?? own.audienceId }])
      const capabilities = await part(async () => {
        // Review B6 — the node's one documented field (CustomAudienceCapabilities.capabilities, SDK).
        const caps = await readRows(connectionId, 'audiences.capabilities', `${own.audienceId}/capabilities`, { fields: 'capabilities' }, 50)
        return caps.rows.map((r) => plain(r, 1))
      })
      return {
        ...base, view: 'detail',
        audience: {
          ...row,
          rule: text(body.rule) ? (body.rule as string).slice(0, MAX_TEXT) : null,
          ruleAggregation: text(body.rule_aggregation),
          lookalikeSpec: plain(body.lookalike_spec, 1) ?? null,
          lookalikeAudienceIds: Array.isArray(body.lookalike_audience_ids) ? body.lookalike_audience_ids.map(idText).filter(Boolean) : [],
          permissionForActions: plain(body.permission_for_actions, 1) ?? null,
          optOutLink: text(body.opt_out_link),
          labels: plain(body.audience_labels, 1) ?? null,
          labelsOf: 'the owner (the chosen ad account)',
        },
        capabilities,
        capabilitiesNote: 'What Meta says the audience may be used for (custom-audience/capabilities; Meta documents no meaning for its fields).',
      }
    }
    case 'ads-using': {
      const own = await needAudience()
      // AU-005 / AU-006 — the ads that use it (Meta documents no /{audience}/adsets edge: grouped by ad set here).
      const read = await readRows(connectionId, 'audiences.ads', `${own.audienceId}/ads`, { fields: AUDIENCE_ADS_FIELDS, effective_status: AD_STATUSES_READ }, maxRows)
      const mine = read.rows.filter((r) => metaAdAccountId(r.account_id) === adAccountId)
      const others = read.rows.filter((r) => metaAdAccountId(r.account_id) !== adAccountId)
      const adSets = new Map<string, { adSetId: string; campaignId: string | null; ads: number; activeAds: number; adIds: string[] }>()
      for (const ad of mine) {
        const adSetId = idText(ad.adset_id) ?? 'unknown'
        const entry = adSets.get(adSetId) ?? { adSetId, campaignId: idText(ad.campaign_id), ads: 0, activeAds: 0, adIds: [] }
        entry.ads++
        if (ad.effective_status === 'ACTIVE') entry.activeAds++
        if (entry.adIds.length < 50) entry.adIds.push(idText(ad.id) ?? '')
        adSets.set(adSetId, entry)
      }
      // Ads of other ad accounts (the audience is shared there): a count per account, never their names.
      const byAccount = new Map<string, number>()
      for (const ad of others) {
        const id = metaAdAccountId(ad.account_id)
        if (id) byAccount.set(id, (byAccount.get(id) ?? 0) + 1)
      }
      const taken = await takenIds('AD_ACCOUNT', [...byAccount.keys()])
      return {
        ...base, view: 'ads-using', audienceId: own.audienceId,
        ads: mine.map((r) => ({ adId: idText(r.id), name: text(r.name), adSetId: idText(r.adset_id), campaignId: idText(r.campaign_id), effectiveStatus: text(r.effective_status) })),
        adSets: [...adSets.values()],
        // Review A1 — an account another business in Nexus uses: its id and the flag only (not even how many ads).
        otherAccounts: [...byAccount.entries()].map(([id, ads]) => (taken.has(id) ? { adAccountId: id, takenByAnotherBusiness: true } : { adAccountId: id, ads, takenByAnotherBusiness: false })),
        more: read.more,
        note: 'Deleting, unsharing or editing this audience changes these ads: a deleted audience stops them for good. Ads of other ad accounts it is shared with are counted only (another business\'s account: its id only).',
      }
    }
    case 'sessions': {
      const own = await needAudience()
      if (own.sharedIn) refuse(SHARED_IN_REFUSAL)
      // AU-007 — did the upload batches land (received / matched / invalid counts; never the people).
      const sessionId = input.sessionId ? (metaObjectId(input.sessionId) ?? refuse('sessionId is digits.')) : null
      const read = await readRows(connectionId, 'audiences.sessions', `${own.audienceId}/sessions`, { fields: SESSION_FIELDS, ...(sessionId ? { session_id: sessionId } : {}) }, maxRows)
      return {
        ...base, view: 'sessions', audienceId: own.audienceId,
        items: read.rows.map((r) => ({
          sessionId: idText(r.session_id), stage: text(r.stage), progress: num(r.progress), received: num(r.num_received), matched: num(r.num_matched),
          invalidEntries: num(r.num_invalid_entries), startTime: unixToIso(r.start_time) ?? text(r.start_time), endTime: unixToIso(r.end_time) ?? text(r.end_time),
        })),
        more: read.more,
        note: 'Upload sessions of a customer list: how many rows Meta received, matched and found invalid. Meta never gives the people themselves.',
      }
    }
    case 'health': {
      const own = await needAudience()
      if (own.sharedIn) refuse(SHARED_IN_REFUSAL)
      // AU-008 — the value data shared through the Audience API (custom-audience/health), not delivery health.
      const day = (v: string | null | undefined, what: string) => (v ? (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : refuse(`${what} is YYYY-MM-DD (UTC).`)) : null)
      const calculated = day(input.calculatedDate, 'calculatedDate')
      const processed = day(input.processedDate, 'processedDate')
      const read = await readRows(connectionId, 'audiences.health', `${own.audienceId}/health`, { fields: 'health', ...(calculated ? { calculated_date: calculated } : {}), ...(processed ? { processed_date: processed } : {}) }, maxRows)
      return {
        ...base, view: 'health', audienceId: own.audienceId,
        valueHealth: read.rows.map((r) => plain(r, 1)), more: read.more,
        note: 'Meta\'s aggregated value data shared for this audience through the Audience API (custom-audience/health) — not whether it can deliver (that is delivery and operation in view detail).',
      }
    }
    case 'sharing': {
      const own = await needAudience()
      if (own.sharedIn) refuse(SHARED_IN_REFUSAL)
      // AU-010 / AU-011 / AU-012 — per recipient, its campaigns, and the ad accounts it is shared with. Each recipient
      // account another business in Nexus uses is its id and the flag only.
      const perms = input.permissions && (SHARE_PERMISSIONS as readonly string[]).includes(input.permissions) ? input.permissions : null
      const [info, campaigns, accounts] = await Promise.all([
        part(async () => {
          const read = await readRows(connectionId, 'audiences.sharedAccountInfo', `${own.audienceId}/shared_account_info`, { fields: SHARED_INFO_FIELDS }, maxRows)
          return maskedAccounts(read.rows.map((r) => ({ adAccountId: metaAdAccountId(r.account_id), accountName: text(r.account_name), businessId: idText(r.business_id), businessName: text(r.business_name), sharingStatus: plain(r.sharing_status, 1) ?? null })), 'adAccountId')
        }),
        part(async () => {
          const read = await readRows(connectionId, 'audiences.sharedCampaigns', `${own.audienceId}/shared_account_campaign_info`, { fields: SHARED_CAMPAIGN_FIELDS }, maxRows)
          return maskedAccounts(read.rows.map((r) => ({
            adAccountId: metaAdAccountId(r.account_id), accountName: text(r.account_name), adSetsIncluding: num(r.adset_including_count), adSetsExcluding: num(r.adset_excluding_count),
            campaignDeliveryStatus: plain(r.campaign_delivery_status, 1) ?? null, campaignObjective: plain(r.campaign_objective, 1) ?? null, campaignSchedule: plain(r.campaign_schedule, 1) ?? null,
          })), 'adAccountId')
        }),
        part(async () => {
          const read = await readRows(connectionId, 'audiences.sharedAdAccounts', `${own.audienceId}/adaccounts`, { fields: 'id', ...(perms ? { permissions: perms } : {}) }, maxRows)
          return maskedAccounts(read.rows.map((r) => ({ adAccountId: metaAdAccountId(r.id) })), 'adAccountId')
        }),
      ])
      return {
        ...base, view: 'sharing', audienceId: own.audienceId, sharedIn: own.sharedIn, recipients: info, recipientCampaigns: campaigns, sharedWithAdAccounts: accounts,
        ...(perms ? { permissions: perms } : {}),
        note: 'Who this audience is shared with: per recipient outside the business (Meta answers nothing here for shares inside the business), the recipients\' campaigns using it, and every ad account it is shared with. Unsharing stops the recipients\' ads that use it.',
      }
    }
    case 'business-sharing': {
      // AU-067 / AU-068 / AU-069 — the business portfolio's audience-sharing requests and permissions (business_management).
      const businessId = account.businessId ?? refuse('The chosen ad account belongs to no business portfolio Nexus knows (meta-ad-accounts list chosen shows it), so its audience sharing cannot be read.')
      const partner = input.partnerBusinessId ? (metaObjectId(input.partnerBusinessId) ?? refuse('partnerBusinessId is digits.')) : null
      const requestStatus = input.requestStatus && (SHARING_REQUEST_STATUSES as readonly string[]).includes(input.requestStatus) ? input.requestStatus : null
      const requests = (edge: 'initiated_audience_sharing_requests' | 'received_audience_sharing_requests', partnerKey: string) => part(async () => {
        const read = await readRows(connectionId, `audiences.${edge}`, `${businessId}/${edge}`, { fields: SHARING_REQUEST_FIELDS, ...(partner ? { [partnerKey]: partner } : {}), ...(requestStatus ? { request_status: requestStatus } : {}) }, maxRows)
        // Review A-N7 — the initiator and recipient portfolios: one another business in Nexus uses is its id and the flag.
        const parties = await maskedPortfolios(read.rows.flatMap((r) => [r.initiator ?? null, r.recipient ?? null]))
        return read.rows.map((r, i) => ({
          requestId: idText(r.id), initiator: parties[2 * i] ?? null, recipient: parties[2 * i + 1] ?? null, relationshipType: plain(r.relationship_type, 1) ?? null,
          requestStatus: text(r.request_status), requestType: text(r.request_type),
          // Review A3 / A-N3 — the audiences of a sharing request (sent or received): their ids only.
          customAudiences: Array.isArray(r.custom_audiences) ? r.custom_audiences.map((a) => ({ audienceId: idOf(a) })).filter((a) => a.audienceId) : [],
        }))
      })
      const permissions = (edge: 'shared_audience_permissions' | 'received_audience_permissions') => part(async () => {
        const read = await readRows(connectionId, `audiences.${edge}`, `${businessId}/${edge}`, { fields: AUDIENCE_PERMISSION_FIELDS, ...(partner ? { partner_id: partner } : {}) }, maxRows)
        // Review A3 — an audience that is not the chosen account's own is its id (and the flag when its account is
        // another business's in Nexus); never its name.
        const owners = read.rows.map((r) => metaAdAccountId((r.audience as { account_id?: unknown } | undefined)?.account_id)).filter((id): id is string => !!id && id !== adAccountId)
        const takenOwners = await takenIds('AD_ACCOUNT', owners)
        const own = read.rows.filter((r) => metaAdAccountId((r.audience as { account_id?: unknown } | undefined)?.account_id) === adAccountId)
        const ownRows = await maskedAccounts(own.map((r) => {
          const a = r.audience as Record<string, unknown>
          return { adAccountId: metaAdAccountId(r.share_account_id), accountName: text(r.share_account_name), audience: { audienceId: idOf(a), name: text(a.name) } }
        }), 'adAccountId')
        // Review A-N4 — a row whose audience is not the chosen account's own is its audience's id only (and the flag
        // when its account is another business's in Nexus): no account, no name.
        return read.rows.map((r) => {
          const a = (r.audience && typeof r.audience === 'object' ? r.audience : {}) as Record<string, unknown>
          const owner = metaAdAccountId(a.account_id)
          if (owner === adAccountId) return ownRows[own.indexOf(r)]
          return owner && takenOwners.has(owner) ? { audience: { audienceId: idOf(a), takenByAnotherBusiness: true } } : { audience: { audienceId: idOf(a) } }
        })
      })
      const [sent, received, sharedOut, sharedIn] = await Promise.all([
        requests('initiated_audience_sharing_requests', 'recipient_id'), requests('received_audience_sharing_requests', 'initiator_id'),
        permissions('shared_audience_permissions'), permissions('received_audience_permissions'),
      ])
      return {
        ...base, view: 'business-sharing', businessId, requestsSent: sent, requestsReceived: received, permissionsShared: sharedOut, permissionsReceived: sharedIn,
        note: 'Audience sharing between business portfolios. Accepting or declining a request is Meta\'s screens only (the received edge is read only); an ad account another business in Nexus uses is its id only.',
      }
    }
    case 'saved': {
      // AU-015 / AU-016 — saved audiences (a targeting spec kept for later; read only: Meta has no API to create or edit one).
      if (input.savedAudienceId) {
        const id = metaObjectId(input.savedAudienceId) ?? refuse('savedAudienceId is digits.')
        const listed = await readRows(connectionId, 'audiences.savedCheck', `${act(adAccountId)}/saved_audiences`, { fields: 'id' }, 1000)
        if (!listed.rows.some((r) => idText(r.id) === id)) refuse('That saved audience is not the chosen ad account\'s, so it is not read.')
        const read = await metaReadOne({ connectionId }, { operation: 'audiences.savedOne', path: id, query: { fields: SAVED_DETAIL_FIELDS } })
        return { ...base, view: 'saved', savedAudience: savedRow(read.body as Record<string, unknown>, true), note: SAVED_NOTE }
      }
      const read = await readRows(connectionId, 'audiences.saved', `${act(adAccountId)}/saved_audiences`, { fields: SAVED_FIELDS }, maxRows)
      return { ...base, view: 'saved', items: read.rows.map((r) => savedRow(r, false)), more: read.more, note: SAVED_NOTE }
    }
    case 'terms': {
      // AU-017 / AU-018 — the Custom Audience terms, as the ad account sees them, and its "existing customers" audiences.
      // Each on its own read: a field Meta refuses (user_tos_accepted for a system user) never hides the others.
      const read = await metaReadOne({ connectionId }, { operation: 'audiences.terms', path: act(adAccountId), query: { fields: 'tos_accepted' } })
      const body = read.body as Record<string, unknown>
      const tos = body.tos_accepted && typeof body.tos_accepted === 'object' ? body.tos_accepted as Record<string, unknown> : {}
      const [userTos, tosList, existing] = await Promise.all([
        part(async () => {
          const r = await metaReadOne({ connectionId }, { operation: 'audiences.userTerms', path: act(adAccountId), query: { fields: 'user_tos_accepted' } })
          return plain((r.body as Record<string, unknown>).user_tos_accepted, 1) ?? null
        }),
        part(async () => (await readRows(connectionId, 'audiences.termsList', `${act(adAccountId)}/customaudiencestos`, { fields: 'id,type' }, 50)).rows.map((r) => plain(r, 1))),
        part(async () => {
          const r = await metaReadOne({ connectionId }, { operation: 'audiences.existingCustomers', path: act(adAccountId), query: { fields: 'existing_customers' } })
          const list = (r.body as Record<string, unknown>).existing_customers
          return Array.isArray(list) ? list.map(idText).filter((id): id is string => !!id) : []
        }),
      ])
      return {
        ...base, view: 'terms',
        customAudienceTermsSigned: tos.custom_audience_tos === 1 || tos.custom_audience_tos === '1',
        termsAccepted: plain(tos, 1) ?? {},
        personTermsAccepted: userTos,
        termsSigned: tosList,
        existingCustomerAudienceIds: existing,
        signLink: TERMS_LINK(adAccountId),
        note: 'A person (never a system user) signs the Custom Audience terms in Meta for the business that owns the ad account, at signLink; customer-list audiences work only after that. An ad account acting on behalf of another business also answers 1 — then the terms are that business\'s. Value-based lookalikes have terms of their own. personTermsAccepted is answered for a person\'s token only, so a system user may see Meta refuse it. existingCustomerAudienceIds: the audiences Advantage+ campaigns count as existing customers.',
      }
    }
  }
}

const SAVED_NOTE = 'Saved audiences are a targeting spec kept for later. Meta has no API to create or edit one (Ads Manager only); a saved audience unused for 2 years expires like a custom audience. Sizes are Meta\'s ranges.'

function savedRow(r: Record<string, unknown>, full: boolean) {
  const { size, sizeNote } = audienceSize(r.approximate_count_lower_bound, r.approximate_count_upper_bound)
  return {
    savedAudienceId: idText(r.id), name: text(r.name), description: text(r.description), size, sizeNote, runStatus: text(r.run_status),
    operation: status(r.operation_status), deleteTime: unixToIso(r.delete_time) ?? text(r.delete_time), createdTime: text(r.time_created), updatedTime: text(r.time_updated),
    ...(full ? { targeting: plain(r.targeting, 1) ?? null, sentenceLines: plain(r.sentence_lines, 1) ?? null } : {}),
  }
}
