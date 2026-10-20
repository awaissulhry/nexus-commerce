/**
 * Meta (M1, 2026-10-20) — what a business's system user can see: its ad accounts, its Facebook Pages and the Instagram
 * accounts linked to them. Read through the gateway (GET only). Each list fails on its own, in words.
 *
 * Checked 2026-10-20 on developers.facebook.com:
 *   - /documentation/ads-commerce/marketing-api/reference/ad-account: fields account_id (numeric string), name,
 *     currency, timezone_name, account_status (1 ACTIVE, 2 DISABLED, 3 UNSETTLED, 7 PENDING_RISK_REVIEW,
 *     8 PENDING_SETTLEMENT, 9 IN_GRACE_PERIOD, 100 PENDING_CLOSURE, 101 CLOSED), business { id, name };
 *     a user's (system user's) ad accounts are `/me/adaccounts` (research R1 AA1)
 *   - /docs/graph-api/reference/user/accounts: "Pages the User has a role on" — `/{user-id}/accounts`
 *   - a Page's `instagram_business_account` { id, username } is its linked Instagram professional account
 *     (UNVERIFIED for every system-user set-up: when Meta lists none, the picker says so in words)
 * Paging follows `paging.cursors.after` (never `paging.next`, which carries the token), at most MAX_PAGES pages.
 */
import { metaCall } from '../../../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../../../gateway/gateway.js'
import type { ScopeInput } from '../../catalog.js'

export const MAX_PAGES = 5
export const PAGE_SIZE = 100

/** Meta's ad account id, digits only: `act_1234567890` or `1234567890` → `1234567890`; anything else → null. */
export function metaAdAccountId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim().replace(/^act_/, '')
  return /^\d{1,25}$/.test(text) ? text : null
}

/** A Meta object id (Page, Instagram account, campaign …): digits only. */
export function metaObjectId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const text = String(value).trim()
  return /^\d{1,25}$/.test(text) ? text : null
}

export const AD_ACCOUNT_STATUS_WORDS: Readonly<Record<number, string>> = {
  1: 'Active', 2: 'Disabled', 3: 'Unsettled (a payment is due)', 7: 'Pending risk review', 8: 'Pending settlement',
  9: 'In grace period', 100: 'Pending closure', 101: 'Closed',
}

export interface MetaAdAccountChoice {
  adAccountId: string
  name: string | null
  currency: string | null
  timeZone: string | null
  accountStatus: number | null
  statusText: string
  businessId: string | null
  businessName: string | null
}
export interface MetaPageChoice { pageId: string; name: string | null; instagram: { id: string; username: string | null } | null }
export interface MetaInstagramChoice { instagramId: string; username: string | null; pageId: string }

export interface MetaChoices {
  systemUser: { id: string; name: string | null } | null
  adAccounts: { items: MetaAdAccountChoice[]; error: string | null }
  pages: { items: MetaPageChoice[]; error: string | null }
  instagram: { items: MetaInstagramChoice[]; error: string | null }
}

export class MetaConnectionNotFound extends Error {
  constructor() {
    super('This Meta connection is not connected to this business.')
    this.name = 'MetaConnectionNotFound'
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

/** One list read page by page; the words of the first failure, or null. */
async function readList(connectionId: string, operation: string, path: string, fields: string): Promise<{ rows: Record<string, unknown>[]; error: string | null }> {
  const rows: Record<string, unknown>[] = []
  let after: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: GatewayResponse
    try {
      answer = await metaCall({ connectionId, operation, path, query: { fields, limit: PAGE_SIZE, ...(after ? { after } : {}) }, timeoutMs: 30_000 })
    } catch (err) {
      if (err instanceof GatewayRefusal || err instanceof GatewayNoAnswer) return { rows, error: err.message }
      throw err
    }
    if (answer.status === 0) return { rows, error: 'Meta did not answer.' }
    if (!answer.ok) return { rows, error: answer.verdict?.channelMessage ? `Meta refused: ${answer.verdict.channelMessage}` : `Meta answered ${answer.status}.` }
    const body = answer.json<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown } }>()
    for (const row of Array.isArray(body?.data) ? body!.data : []) if (row && typeof row === 'object') rows.push(row as Record<string, unknown>)
    const next = text(body?.paging?.cursors?.after)
    if (!next || !body?.paging?.next) break
    after = next
  }
  return { rows, error: null }
}

/** Everything the system user of this connection can see, list by list. Throws MetaConnectionNotFound for a foreign id. */
export async function discoverMetaChoices(connectionId: string): Promise<MetaChoices> {
  let me: { id: string; name: string | null } | null = null
  try {
    const answer = await metaCall({ connectionId, operation: 'identity.me', path: 'me', query: { fields: 'id,name' }, timeoutMs: 20_000 })
    const body = answer.ok ? answer.json<{ id?: unknown; name?: unknown }>() : null
    if (body?.id) me = { id: String(body.id), name: text(body.name) }
  } catch (err) {
    if (err instanceof GatewayRefusal && err.code === 'ACCOUNT_NOT_FOUND') throw new MetaConnectionNotFound()
    if (!(err instanceof GatewayRefusal) && !(err instanceof GatewayNoAnswer)) throw err
  }
  const accounts = await readList(connectionId, 'discovery.adAccounts', 'me/adaccounts', 'account_id,name,currency,timezone_name,account_status,business{id,name}')
  const pages = await readList(connectionId, 'discovery.pages', 'me/accounts', 'id,name,instagram_business_account{id,username}')
  const adAccounts: MetaAdAccountChoice[] = []
  for (const row of accounts.rows) {
    const adAccountId = metaAdAccountId(row.account_id ?? row.id)
    if (!adAccountId) continue
    const status = Number(row.account_status)
    const business = row.business && typeof row.business === 'object' ? row.business as Record<string, unknown> : null
    adAccounts.push({
      adAccountId,
      name: text(row.name),
      currency: text(row.currency),
      timeZone: text(row.timezone_name),
      accountStatus: Number.isFinite(status) ? status : null,
      statusText: Number.isFinite(status) ? AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}` : 'Status not given',
      businessId: business?.id == null ? null : String(business.id),
      businessName: text(business?.name),
    })
  }
  const pageItems: MetaPageChoice[] = []
  const instagram: MetaInstagramChoice[] = []
  for (const row of pages.rows) {
    const pageId = metaObjectId(row.id)
    if (!pageId) continue
    const ig = row.instagram_business_account && typeof row.instagram_business_account === 'object' ? row.instagram_business_account as Record<string, unknown> : null
    const igId = metaObjectId(ig?.id)
    pageItems.push({ pageId, name: text(row.name), instagram: igId ? { id: igId, username: text(ig?.username) } : null })
    if (igId && !instagram.some((i) => i.instagramId === igId)) instagram.push({ instagramId: igId, username: text(ig?.username), pageId })
  }
  return {
    systemUser: me,
    adAccounts: { items: adAccounts, error: accounts.error },
    pages: { items: pageItems, error: pages.error },
    instagram: { items: instagram, error: pages.error },
  }
}

/** The connection's scope rows (Settings › Channels lists them): ad accounts, Pages and Instagram accounts it reaches. */
export function metaScopeRows(choices: MetaChoices): ScopeInput[] {
  return [
    ...choices.adAccounts.items.map((a): ScopeInput => ({
      kind: 'meta_ad_account', externalId: a.adAccountId, label: a.name ?? `Ad account ${a.adAccountId.slice(-4)}`,
      isActive: a.accountStatus === 1, metadata: { currency: a.currency, timeZone: a.timeZone, accountStatus: a.accountStatus, businessId: a.businessId },
    })),
    ...choices.pages.items.map((p): ScopeInput => ({ kind: 'meta_page', externalId: p.pageId, label: p.name ?? `Page ${p.pageId.slice(-4)}`, metadata: { instagramId: p.instagram?.id ?? null } })),
    ...choices.instagram.items.map((i): ScopeInput => ({ kind: 'meta_instagram_account', externalId: i.instagramId, label: i.username ? `@${i.username}` : `Instagram ${i.instagramId.slice(-4)}`, metadata: { pageId: i.pageId } })),
  ]
}
