/**
 * Meta ads step 41 (2026-10-25) — what a people or partner access change reads LIVE before it is drafted (GET only, through
 * the gateway), at the preview, at the approval's re-check and again when the approved change runs (the kit builds it again
 * from these reads). Step 3's meta-account-access reads the same edges for people (live-account.ts accessView); this is the
 * change's own read of them, complete (to 500, refused beyond) and raw, so the preview, the re-check, the run and undo
 * compare the same values. Reuses step 34's portfolio people and Nexus's own system user (live-catalog-admin.ts).
 *
 * ONLY the business's chosen assets: the chosen ad account; the chosen Facebook Page and the chosen Instagram account's
 * business asset, each only when the chosen ad account's portfolio OWNS it (a client's asset is its owner's to share);
 * the portfolio itself for a relationship. A partner portfolio another business in Nexus uses is its id and the flag only.
 *
 * Checked 2026-10-25: ad-account (account_status, disable_reason, business), ad-account/assigned_users, page/assigned_users,
 * the Instagram business asset's assigned_users (`business` required on each read; tasks "all unpacked roles/tasks"),
 * ad-account/agencies and page/agencies (Business nodes + access_status, permitted_tasks), the Instagram business asset's
 * agencies (v26 reference/instagram-business-asset/agencies: Business nodes, no extra field — so access_status and
 * permitted_tasks are asked as extras that may be refused: review B-F2), business/owned_pages, business/owned_instagram_assets
 * and client_instagram_assets (InstagramBusinessAsset id, ig_user_id — SDK), business/owned_ad_accounts, business/agencies
 * and business/clients (adaccount_permissions, application_permissions, page_permissions, productcatalog_permissions —
 * list<…Permission>, their shape on no page: LIVE-PROBES ST41-06; read fail closed, meta/meta-access-lists.ts
 * metaPermissionIds).
 * The access tier: Meta's `ads_api_access_tier` in the usage headers of the account read (cx/rate-readings.ts).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { metaCall } from '../../gateway/meta.js'
import type { GatewayResponse } from '../../gateway/gateway.js'
import { metaUsageOf } from '../../cx/rate-readings.js'
import { failureOfAnswer, failureOfThrow, localFailure, MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal, type MetaChosenAccount } from './live.js'
import { listPaged, listWithFallback } from './paging.js'
import { metaReadOne } from './read-client.js'
import { takenIds } from './taken.js'
import { ownSignalPixel } from './signals-rule.js'
import { metaPermissionIds, type MetaAccessAsset } from '../../meta/meta-access-lists.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && s.trim() !== '') : [])
/** How many rows of a list a change reads; a list longer than this is refused (a change is never judged on part of it). */
export const ACCESS_MAX_ROWS = 500

/** The chosen ad account as an access change stands on it: its status (step 40's refusal), its portfolio, Meta's tier. */
export interface AccessAccountState {
  adAccountId: string
  name: string | null
  status: number | null
  disableReason: number | null
  /** The ad account's business portfolio, read now (its owner). */
  portfolioId: string | null
  /** Meta's Marketing API access tier as the answer named it (`standard_access` = Full, `development_access` = Limited). */
  tier: string | null
}

/** The business's chosen ad account (refused in words when another one is chosen now). */
export async function accessAccount(target: { connectionId: string; adAccountId: string }): Promise<MetaChosenAccount> {
  const chosen = await metaChosenAccount(target.connectionId)
  if (chosen.adAccountId !== target.adAccountId) throw new MetaLiveRefusal('The Meta ad account this business chose changed while Nexus read it: ask again.')
  return chosen
}

/**
 * The account's status, portfolio and Meta's access tier, in ONE read (the usage headers of its answer name the tier).
 * Through the gateway like every read; a refusal is a MetaReadError, as metaReadOne throws it.
 */
export async function liveAccessState(account: MetaChosenAccount): Promise<AccessAccountState> {
  const operation = 'accessChange.account'
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId: account.connectionId, operation, path: `act_${account.adAccountId}`, query: { fields: 'id,name,account_status,disable_reason,business{id}' } })
  } catch (err) {
    const failure = failureOfThrow(err)
    if (failure) throw new MetaReadError(failure, operation, 0)
    throw err
  }
  if (!answer.ok) throw new MetaReadError(failureOfAnswer(answer), operation, 1)
  const body = answer.json<Row>()
  if (!body || typeof body !== 'object') throw new MetaReadError(localFailure('Meta answered with something that is not JSON.', 'NOT_JSON'), operation, 1)
  let tier: string | null = null
  try { tier = metaUsageOf(answer.headers).tier } catch { tier = null }
  return {
    adAccountId: account.adAccountId,
    name: text(body.name),
    status: num(body.account_status),
    disableReason: num(body.disable_reason),
    portfolioId: metaObjectId(obj(body.business)?.id),
    tier,
  }
}

/** One of the chosen assets as a change names it: its node, what a person reads. */
export interface AccessAssetNow { asset: MetaAccessAsset; nodeId: string; label: string }

/** The portfolio's own Instagram business asset of the chosen Instagram account, or null (the list read in full). */
async function ownInstagramAssetOf(account: MetaChosenAccount, portfolioId: string, instagramId: string): Promise<string | null> {
  const list = await listPaged(account.connectionId, 'accessChange.ownedInstagram', `${portfolioId}/owned_instagram_assets`, { fields: 'id,ig_user_id' }, ACCESS_MAX_ROWS)
  const row = list.rows.find((r) => metaObjectId(r.ig_user_id) === instagramId)
  if (!row && list.more) throw new MetaLiveRefusal(`The business portfolio has more Instagram accounts than Nexus reads (${ACCESS_MAX_ROWS}): change this access in Meta Business settings.`)
  return row ? metaObjectId(row.id) : null
}

/** Is the chosen Page one of the portfolio's own Pages (the list read in full)? */
async function ownsPage(account: MetaChosenAccount, portfolioId: string, pageId: string): Promise<boolean> {
  const list = await listPaged(account.connectionId, 'accessChange.ownedPages', `${portfolioId}/owned_pages`, { fields: 'id' }, ACCESS_MAX_ROWS)
  if (list.rows.some((r) => metaObjectId(r.id) === pageId)) return true
  if (list.more) throw new MetaLiveRefusal(`The business portfolio has more Pages than Nexus reads (${ACCESS_MAX_ROWS}): change this access in Meta Business settings.`)
  return false
}

/**
 * Owner option 1 — a dataset (pixel) whose people and partners this business may change: one of the chosen ad account's
 * pixels that no other Nexus business uses (step 11's verdict through step 32's ownSignalPixel) AND owned by the chosen ad
 * account's business portfolio (its owner_business): a dataset only shared with the portfolio is its owner's to share.
 */
export async function liveAccessPixel(account: MetaChosenAccount, pixelId: string, portfolioId: string): Promise<AccessAssetNow> {
  const id = await ownSignalPixel(account, pixelId)
  const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'accessChange.pixel', path: id, query: { fields: 'id,name,owner_business{id}' } })
  const body = (read.body ?? {}) as Row
  if (metaObjectId(obj(body.owner_business)?.id) !== portfolioId) {
    throw new MetaLiveRefusal(`Dataset ${id} is not owned by the chosen ad account's business portfolio (it is shared with it, or Meta does not say whose it is): its people and partners are its owner's to change.`)
  }
  const name = text(body.name)
  return { asset: 'pixel', nodeId: id, label: `dataset ${id}${name ? ` ("${name}")` : ''}` }
}

/**
 * The asset a change names: the chosen ad account; the chosen Page or Instagram account — each only when the chosen ad
 * account's portfolio owns it (a client's asset is its owner's to share: refused in words); a dataset (liveAccessPixel).
 */
export async function liveAccessAsset(account: MetaChosenAccount, asset: MetaAccessAsset, portfolioId: string, pixelId?: string | null): Promise<AccessAssetNow> {
  if (asset === 'pixel') {
    if (!pixelId) throw new MetaLiveRefusal('Name the dataset (pixelId: meta-datasets view list shows the chosen ad account\'s).')
    return liveAccessPixel(account, pixelId, portfolioId)
  }
  if (asset === 'ad-account') return { asset, nodeId: `act_${account.adAccountId}`, label: `ad account ${account.adAccountId}${account.name ? ` ("${account.name}")` : ''}` }
  if (asset === 'page') {
    if (!account.pageId) throw new MetaLiveRefusal('No Facebook Page is chosen for this business (Settings › Channels › Meta, or set-meta-connection).')
    if (!(await ownsPage(account, portfolioId, account.pageId))) throw new MetaLiveRefusal('The chosen Facebook Page is not one of the ad account\'s business portfolio\'s own Pages (a client\'s Page): its people and partners are its owner\'s to change.')
    const name = account.connection.page?.name ?? null
    return { asset, nodeId: account.pageId, label: `Facebook Page ${account.pageId}${name ? ` ("${name}")` : ''}` }
  }
  if (!account.instagramId) throw new MetaLiveRefusal('No Instagram account is chosen for this business (Settings › Channels › Meta, or set-meta-connection).')
  const assetId = await ownInstagramAssetOf(account, portfolioId, account.instagramId)
  if (!assetId) throw new MetaLiveRefusal('The chosen Instagram account is not one of the ad account\'s business portfolio\'s own Instagram accounts (a client\'s account): its people and partners are its owner\'s to change.')
  const username = account.connection.instagram?.username ?? null
  return { asset, nodeId: assetId, label: `Instagram account ${username ? `@${username} ` : ''}(${account.instagramId}; its business asset ${assetId})` }
}

/** One person or system user assigned to the asset now: Meta's unpacked tasks, sorted. */
export interface AssigneeNow { id: string; name: string | null; tasks: string[] }

/** Who holds tasks on the asset now (asked in the portfolio that owns it, as Meta requires). */
export async function liveAssignees(account: MetaChosenAccount, nodeId: string, portfolioId: string): Promise<{ people: Map<string, AssigneeNow>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'accessChange.assignedUsers', `${nodeId}/assigned_users`, { business: portfolioId, fields: 'id,name,tasks' }, ACCESS_MAX_ROWS)
  const people = new Map<string, AssigneeNow>()
  for (const r of list.rows) {
    const id = metaObjectId(r.id)
    if (id) people.set(id, { id, name: text(r.name), tasks: strings(r.tasks).sort() })
  }
  return { people, more: list.more }
}

/** A partner portfolio with access, as read now; one another business in Nexus uses is its id and the flag only. */
/** `tasks` null: Meta did not list them (it refused permitted_tasks on this edge — re-review R-5), never "none". */
export interface PartnerNow { id: string; name: string | null; tasks: string[] | null; accessStatus: string | null; takenByAnotherBusiness: boolean }

/**
 * The partner portfolios the asset is shared with now (its agencies). Review B-F2 — `access_status` and `permitted_tasks`
 * are asked as extras (Meta documents them on the ad account's and the Page's edge, not on the Instagram asset's): refused,
 * the partners are read without them (their tasks then unknown: undo says it cannot share again as it was).
 */
export async function liveAssetPartners(account: MetaChosenAccount, nodeId: string, asset?: MetaAccessAsset): Promise<{ partners: Map<string, PartnerNow>; more: boolean }> {
  // Option-1 review SF4 — a dataset's agencies edge documents permitted_tasks (and permitted_roles), never access_status.
  const list = await listWithFallback(account.connectionId, 'accessChange.agencies', `${nodeId}/agencies`, 'id,name', asset === 'pixel' ? 'permitted_tasks' : 'access_status,permitted_tasks', {}, ACCESS_MAX_ROWS)
  const ids = list.rows.map((r) => metaObjectId(r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('PORTFOLIO', ids)
  const partners = new Map<string, PartnerNow>()
  for (const r of list.rows) {
    const id = metaObjectId(r.id)
    if (!id) continue
    partners.set(id, taken.has(id)
      ? { id, name: null, tasks: null, accessStatus: null, takenByAnotherBusiness: true }
      : { id, name: text(r.name), tasks: 'permitted_tasks' in r ? strings(r.permitted_tasks).sort() : null, accessStatus: text(r.access_status), takenByAnotherBusiness: false })
  }
  return { partners, more: list.more }
}

/** What a relationship holds, as Meta lists it (ids only; a kind Meta did not answer is null). */
export interface RelationshipShares { adAccounts: string[] | null; pages: string[] | null; catalogs: string[] | null; apps: string[] | null }
export interface RelationshipNow { id: string; name: string | null; takenByAnotherBusiness: boolean; shares: RelationshipShares | null }

const SHARE_FIELDS: Readonly<Record<keyof RelationshipShares, string>> = { adAccounts: 'adaccount_permissions', pages: 'page_permissions', catalogs: 'productcatalog_permissions', apps: 'application_permissions' }

/** The portfolio's agencies (who it shares with) or clients (who share with it), with what each relationship holds. */
export async function livePortfolioRelationships(account: MetaChosenAccount, portfolioId: string, relationship: 'agency' | 'client'): Promise<{ partners: Map<string, RelationshipNow>; more: boolean; sharesNote: string | null }> {
  const edge = relationship === 'agency' ? 'agencies' : 'clients'
  const read = await listWithFallback(account.connectionId, `accessChange.${edge}`, `${portfolioId}/${edge}`, 'id,name', Object.values(SHARE_FIELDS).join(','), {}, ACCESS_MAX_ROWS)
  const ids = read.rows.map((r) => metaObjectId(r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('PORTFOLIO', ids)
  const partners = new Map<string, RelationshipNow>()
  for (const r of read.rows) {
    const id = metaObjectId(r.id)
    if (!id) continue
    if (taken.has(id)) { partners.set(id, { id, name: null, takenByAnotherBusiness: true, shares: null }); continue }
    const asked = Object.values(SHARE_FIELDS).some((f) => f in r)
    partners.set(id, {
      id, name: text(r.name), takenByAnotherBusiness: false,
      shares: asked ? Object.fromEntries(Object.entries(SHARE_FIELDS).map(([k, f]) => [k, metaPermissionIds(r[f])])) as unknown as RelationshipShares : null,
    })
  }
  return { partners, more: read.more, sharesNote: read.note ?? null }
}

/** Are the chosen Page and Instagram account the portfolio's own ('none': none chosen)? Ending a client relationship needs it. */
export async function liveChosenAssetsOwned(account: MetaChosenAccount, portfolioId: string): Promise<{ page: boolean | 'none'; instagram: boolean | 'none' }> {
  const page = account.pageId ? await ownsPage(account, portfolioId, account.pageId) : 'none' as const
  const instagram = account.instagramId ? !!(await ownInstagramAssetOf(account, portfolioId, account.instagramId)) : 'none' as const
  return { page, instagram }
}

/**
 * Review A-MF1 — the Instagram accounts this portfolio holds as a CLIENT (its client_instagram_assets: their ig_user_id), read
 * in full; null when Meta did not answer or there are more than Nexus reads. Meta names no Instagram account for a
 * relationship, so a client relationship's end looks at all of them.
 */
export async function liveClientInstagramIds(account: MetaChosenAccount, portfolioId: string): Promise<string[] | null> {
  try {
    const list = await listPaged(account.connectionId, 'accessChange.clientInstagram', `${portfolioId}/client_instagram_assets`, { fields: 'id,ig_user_id' }, ACCESS_MAX_ROWS)
    if (list.more) return null
    return list.rows.map((r) => metaObjectId(r.ig_user_id)).filter((id): id is string => !!id)
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null
    throw err
  }
}

/** One list of the portfolio read in full (these fields), or null when Meta did not answer it or there is more than Nexus reads. */
async function fullList(account: MetaChosenAccount, operation: string, path: string, fields: string): Promise<Record<string, unknown>[] | null> {
  try {
    const list = await listPaged(account.connectionId, operation, path, { fields }, ACCESS_MAX_ROWS)
    return list.more ? null : list.rows
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null
    throw err
  }
}

/**
 * Review A-N3, re-review R-1 — the portfolio's OWN ad accounts (owned_ad_accounts), Pages (owned_pages) and Instagram
 * accounts (owned_instagram_assets ig_user_id), each read in full (null when not readable or cut): one another business in
 * Nexus chose makes the portfolio shared — even when that business's link names no portfolio, or it reaches the asset
 * through a partner of this portfolio.
 */
export async function livePortfolioOwnAssets(account: MetaChosenAccount, portfolioId: string): Promise<{ adAccounts: string[] | null; pages: string[] | null; instagram: string[] | null }> {
  const accounts = await fullList(account, 'accessChange.ownedAdAccounts', `${portfolioId}/owned_ad_accounts`, 'account_id')
  const pages = await fullList(account, 'accessChange.ownedPagesAll', `${portfolioId}/owned_pages`, 'id')
  const instagram = await fullList(account, 'accessChange.ownedInstagramAll', `${portfolioId}/owned_instagram_assets`, 'id,ig_user_id')
  return {
    adAccounts: accounts ? accounts.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id) : null,
    pages: pages ? pages.map((r) => metaObjectId(r.id)).filter((id): id is string => !!id) : null,
    instagram: instagram ? instagram.map((r) => metaObjectId(r.ig_user_id)).filter((id): id is string => !!id) : null,
  }
}

/** A business allowed to send a dataset's server events, as read now (one another Nexus business uses: its id and the flag). */
export interface ServerEventBusinessNow { id: string; name: string | null; takenByAnotherBusiness: boolean }

/**
 * Owner option 1 (SG-014) — the businesses allowed to send this dataset's server events (GET
 * /{pixel}/server_events_permitted_business: Business nodes), read in full (to 500; more is refused by the draft).
 */
export async function liveServerEventBusinesses(account: MetaChosenAccount, pixelId: string): Promise<{ businesses: Map<string, ServerEventBusinessNow>; more: boolean }> {
  const list = await listPaged(account.connectionId, 'accessChange.serverEventBusinesses', `${pixelId}/server_events_permitted_business`, { fields: 'id,name' }, ACCESS_MAX_ROWS)
  const ids = list.rows.map((r) => metaObjectId(r.id)).filter((id): id is string => !!id)
  const taken = await takenIds('PORTFOLIO', ids)
  const businesses = new Map<string, ServerEventBusinessNow>()
  for (const r of list.rows) {
    const id = metaObjectId(r.id)
    if (id) businesses.set(id, taken.has(id) ? { id, name: null, takenByAnotherBusiness: true } : { id, name: text(r.name), takenByAnotherBusiness: false })
  }
  return { businesses, more: list.more }
}
