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
 * Paging follows `paging.cursors.after` (never `paging.next`, which carries the token) through every page, up to a hard
 * cap of MAX_PAGES (×100 rows); a list cut there says so in words. Each list asks `summary=total_count`, so its count is
 * Meta's own (developers.facebook.com/docs/graph-api/results: "summary=total_count").
 * Nested fields need their own permission (business{…}: business_management; instagram_business_account{…}:
 * instagram_basic): a nested field is asked for only when the token carries it, and a list Meta refuses for a missing
 * permission (codes 10, 200–299) is read again without its nested fields, so the list itself is never lost — the answer
 * says plainly what could not be read.
 */
import { metaCall } from '../../../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../../../gateway/gateway.js'
import prisma from '../../../../db.js'
import type { ScopeInput } from '../../catalog.js'
import { META_SCOPE } from './scopes.js'

export const MAX_PAGES = 50
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

/** One list as read: its items, Meta's own count when given, and what could not be read, in words (null = nothing). */
export interface MetaChoiceList<T> { items: T[]; total: number | null; error: string | null }

export interface MetaChoices {
  systemUser: { id: string; name: string | null } | null
  adAccounts: MetaChoiceList<MetaAdAccountChoice>
  pages: MetaChoiceList<MetaPageChoice>
  instagram: MetaChoiceList<MetaInstagramChoice>
}

export class MetaConnectionNotFound extends Error {
  constructor() {
    super('This Meta connection is not connected to this business.')
    this.name = 'MetaConnectionNotFound'
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

interface ListRead { rows: Record<string, unknown>[]; total: number | null; error: string | null; permissionDenied: boolean }

/** One list read page by page (all pages, up to the cap); the words of the first failure, or of the cut. */
async function readList(connectionId: string, operation: string, path: string, fields: string): Promise<ListRead> {
  const rows: Record<string, unknown>[] = []
  let after: string | null = null
  let total: number | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    let answer: GatewayResponse
    try {
      answer = await metaCall({ connectionId, operation, path, query: { fields, limit: PAGE_SIZE, summary: 'total_count', ...(after ? { after } : {}) }, timeoutMs: 30_000 })
    } catch (err) {
      if (err instanceof GatewayRefusal || err instanceof GatewayNoAnswer) return { rows, total, error: err.message, permissionDenied: false }
      throw err
    }
    if (answer.status === 0) return { rows, total, error: 'Meta did not answer.', permissionDenied: false }
    if (!answer.ok) {
      return { rows, total, error: answer.verdict?.channelMessage ? `Meta refused: ${answer.verdict.channelMessage}` : `Meta answered ${answer.status}.`, permissionDenied: answer.verdict?.errorClass === 'forbidden' }
    }
    const body = answer.json<{ data?: unknown[]; paging?: { cursors?: { after?: unknown }; next?: unknown }; summary?: { total_count?: unknown } }>()
    for (const row of Array.isArray(body?.data) ? body!.data : []) if (row && typeof row === 'object') rows.push(row as Record<string, unknown>)
    const count = Number(body?.summary?.total_count)
    if (Number.isFinite(count)) total = count
    const next = text(body?.paging?.cursors?.after)
    if (!next || !body?.paging?.next) return { rows, total, error: null, permissionDenied: false }
    after = next
  }
  return { rows, total, error: `Nexus read the first ${rows.length.toLocaleString('en-US')}${total !== null ? ` of ${total.toLocaleString('en-US')}` : ''}; the rest were not read.`, permissionDenied: false }
}

/**
 * A list with a nested field that needs its own permission: asked with it only when the token carries that permission;
 * refused for a permission (Meta codes 10, 200–299) → asked again without it, and the answer says what is missing.
 */
async function readWithNested(connectionId: string, operation: string, path: string, base: string, nested: string, granted: boolean, missing: string): Promise<ListRead> {
  if (!granted) {
    const plain = await readList(connectionId, operation, path, base)
    return { ...plain, error: [plain.error, missing].filter(Boolean).join(' ') }
  }
  const full = await readList(connectionId, operation, path, `${base},${nested}`)
  if (!full.permissionDenied) return full
  const plain = await readList(connectionId, operation, path, base)
  return { ...plain, error: [plain.error, missing].filter(Boolean).join(' ') }
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
  const granted = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { grantedScopes: true } })
  const scopes = new Set(granted?.grantedScopes ?? [])
  const accounts = await readWithNested(connectionId, 'discovery.adAccounts', 'me/adaccounts', 'account_id,name,currency,timezone_name,account_status', 'business{id,name}',
    scopes.has(META_SCOPE.business_management), 'The business portfolio of each ad account was not read: the token does not carry business_management.')
  const pages = await readWithNested(connectionId, 'discovery.pages', 'me/accounts', 'id,name', 'instagram_business_account{id,username}',
    scopes.has(META_SCOPE.instagram_basic), 'Instagram accounts were not read: the token does not carry instagram_basic (with pages_show_list).')
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
    adAccounts: { items: adAccounts, total: accounts.total, error: accounts.error },
    pages: { items: pageItems, total: pages.total, error: pages.error },
    instagram: { items: instagram, total: null, error: pages.error },
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
