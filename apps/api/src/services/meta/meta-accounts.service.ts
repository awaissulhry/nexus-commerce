/**
 * Meta ads — which Meta assets a business reads through its Meta connection (step 1, 2026-10-20), mirroring Google's
 * accounts service (C1–C3). Read-only towards Meta: the only Meta calls are the discovery reads
 * (cx/connectors/meta/discovery.ts) and the token check, both GET through the gateway.
 *
 *   listMetaConnections()  C1 — this business's Meta connections: the system user, the app, the token's health (valid,
 *                          expiry and renewal, permissions, type), the chosen ad account, Page and Instagram account
 *   getMetaChoices()       C2 — what the system user can see; read from Meta at most once per 5 minutes per connection
 *                          (unless forced), the answer kept in between
 *   metaChoicesAnswer()    C2 as answered: each asset also says whether another business in Nexus already picked it
 *                          (read fresh every time, never naming that business)
 *   saveMetaSelection()    C3 — one ad account (required), at most one Page and one Instagram account, only ids Meta
 *                          offered THIS business's system user; recorded in the connection ledger (`accounts_linked`)
 *   metaConnectionHealth() the Settings › Channels health of each Meta connection, from its C1 state
 *
 * No app secret and no token ever leaves the token service: this file sees the app id (not a secret) and the health
 * Nexus kept of the last token check (`connectionMetadata.metaToken`).
 */
import type { MetaAccountLink, Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceContext, workspaceIdForQuery, workspaceKey } from '../../lib/workspace-context.js'
import { connectionLabel } from '../connection-label.js'
import { CONNECTION_PUBLIC_SELECT, isOwnConnection, listManagedConnections, type ConnectionRow } from '../connection-resolver.service.js'
import { recordConnectionEventInTx } from '../cx/events.service.js'
import { metaAppIdOf } from '../cx/token.service.js'
import { storedTokenHealth, META_RENEW_WITHIN_SEC } from '../cx/connectors/meta/spec.js'
import { discoverMetaChoices, metaAdAccountId, metaObjectId, MetaConnectionNotFound, type MetaChoices } from '../cx/connectors/meta/discovery.js'
import { metaPermissionGaps, type MetaPermissionGap } from '../cx/connectors/meta/scopes.js'
import type { MetaTokenHealth } from '../cx/connectors/meta/token-check.js'

export { MetaConnectionNotFound } from '../cx/connectors/meta/discovery.js'

// ── the contract (apps/web/src/lib/meta-ads/contract.ts is the web's copy) ────────────────────────────────────────

export type MetaConnectionState = 'sign_in_needed' | 'token_problem' | 'permission_missing' | 'choose_account' | 'ok'

export interface MetaTokenView {
  /** When Nexus last asked Meta about the token (debug_token); null = never. */
  checkedAt: string | null
  isValid: boolean | null
  /** ISO day-time; null with neverExpires = a token that does not expire by date. */
  expiresAt: string | null
  neverExpires: boolean
  /** When Nexus renews a 60-day token (30 days before it expires); null for a never-expiring one. */
  renewsFrom: string | null
  /** When Nexus last renewed or stored it. */
  lastRenewedAt: string | null
  /** SYSTEM_USER, … — or null when Meta did not report a type ("token type not reported"). */
  type: string | null
  typeText: string
  scopes: string[]
  missing: MetaPermissionGap[]
  problem: string | null
}

export interface MetaConnection {
  connectionId: string
  /** A person's name for this connection. Never an id. */
  label: string
  state: MetaConnectionState
  stateText: string
  authStatus: string
  /** The system user the token acts as (its id is Meta's, not a secret). */
  systemUser: { id: string; name: string | null } | null
  /** The business's Meta app id (not a secret: Meta shows it on every app page). The secret is never shown. */
  appId: string | null
  token: MetaTokenView
  adAccount: { adAccountId: string; name: string | null; currency: string | null; timeZone: string | null; statusText: string | null; businessId: string | null } | null
  page: { pageId: string; name: string | null } | null
  instagram: { instagramId: string; username: string | null } | null
  /** The last error the connection recorded (a renewal that failed, a refused check), in words. */
  lastError: string | null
}

export interface MetaSelectionInput {
  adAccountId: string
  pageId: string | null
  instagramId: string | null
}

export class MetaSelectionError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly code: 'invalid' | 'not_found' | 'not_offered' | 'account_taken' | 'taken_by_other_business',
    message: string,
    readonly product: MetaProduct | null = null,
  ) {
    super(message)
    this.name = 'MetaSelectionError'
  }
}

/** MetaAccountLink.product values. */
export const META_PRODUCT = { adAccount: 'AD_ACCOUNT', page: 'PAGE', instagram: 'INSTAGRAM' } as const
export type MetaProduct = typeof META_PRODUCT[keyof typeof META_PRODUCT]

const SIGNED_OUT = new Set(['needs_reauth', 'revoked', 'disconnected'])
const DAY_MS = 86_400_000

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
const day = (value: string | null): string | null => (value ? value.slice(0, 10) : null)

// ── C1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The token as a person reads it, from the last check Nexus kept and the connection's own dates. Pure. */
export function metaTokenView(health: MetaTokenHealth | null, row: { accessTokenExpiresAt?: Date | null; lastRefreshAt?: Date | null; grantedScopes?: string[] }): MetaTokenView {
  // The stored expiry moves on every renewal; the check may be older.
  const expiresAt = iso(row.accessTokenExpiresAt ?? null) ?? health?.expiresAt ?? null
  const neverExpires = !expiresAt && (health?.neverExpires ?? false)
  const scopes = health?.scopes ?? row.grantedScopes ?? []
  const type = health?.type ?? null
  return {
    checkedAt: health?.checkedAt ?? null,
    isValid: health ? health.isValid : null,
    expiresAt,
    neverExpires,
    renewsFrom: expiresAt ? new Date(Date.parse(expiresAt) - META_RENEW_WITHIN_SEC * 1000).toISOString() : null,
    lastRenewedAt: iso(row.lastRefreshAt ?? null),
    type,
    typeText: type === 'SYSTEM_USER' ? 'System-user token' : type ? `${type.toLowerCase().replace(/_/g, ' ')} token` : 'Token type not reported by Meta',
    scopes,
    missing: metaPermissionGaps(scopes),
    problem: health?.problem ?? null,
  }
}

/** The state and its sentence, from the connection, its token and the choice. Pure. */
export function metaConnectionState(input: { isActive: boolean; authStatus: string; token: MetaTokenView; adAccountLinked: boolean; accountName: string | null; now?: Date }): { state: MetaConnectionState; stateText: string } {
  const now = input.now ?? new Date()
  if (!input.isActive || input.authStatus === 'disconnected') {
    return { state: 'sign_in_needed', stateText: 'Meta is not connected for this business. Enter the Meta app id, app secret and a system-user token in Settings › Channels › Meta.' }
  }
  if (SIGNED_OUT.has(input.authStatus)) {
    return { state: 'sign_in_needed', stateText: 'Meta no longer accepts this business\'s system-user token. Make a new token in Meta Business settings and enter it in Settings › Channels › Meta.' }
  }
  if (input.token.isValid === false) {
    return { state: 'token_problem', stateText: `${input.token.problem ?? 'Meta says the token is not valid.'} Enter a new system-user token in Settings › Channels › Meta.` }
  }
  if (input.token.expiresAt && Date.parse(input.token.expiresAt) <= now.getTime()) {
    return { state: 'token_problem', stateText: `The Meta token expired on ${day(input.token.expiresAt)}. Make a new system-user token and enter it in Settings › Channels › Meta.` }
  }
  const required = input.token.missing.filter((m) => m.required)
  if (required.length) {
    return { state: 'permission_missing', stateText: `The token does not carry ${required.map((m) => m.scope).join(', ')}, which Nexus needs to ${required[0].neededFor}. Generate the token again with it ticked.` }
  }
  if (!input.adAccountLinked) return { state: 'choose_account', stateText: 'Choose the Meta ad account Nexus reads for this business.' }
  const name = input.accountName ? `“${input.accountName}”` : 'the chosen ad account'
  const expiry = input.token.neverExpires
    ? 'The token does not expire by date.'
    : input.token.expiresAt
      ? `The token expires on ${day(input.token.expiresAt)}; Nexus renews it from ${day(input.token.renewsFrom)}.`
      : 'Nexus has not checked the token\'s expiry yet.'
  const soon = input.token.expiresAt && Date.parse(input.token.expiresAt) - now.getTime() < 14 * DAY_MS
    ? ' Nexus could not renew it yet: if that goes on, make a new token before it expires.'
    : ''
  return { state: 'ok', stateText: `Nexus reads ${name} through this connection (read only). ${expiry}${soon}` }
}

function connectionOf(row: ConnectionRow, links: MetaAccountLink[], appId: string | null, now: Date): MetaConnection {
  const health = storedTokenHealth(row.connectionMetadata)
  const token = metaTokenView(health, row)
  const link = (product: MetaProduct) => links.find((l) => l.product === product) ?? null
  const adLink = link(META_PRODUCT.adAccount)
  const pageLink = link(META_PRODUCT.page)
  const igLink = link(META_PRODUCT.instagram)
  const adMeta = record(adLink?.metadata)
  const identity = record(row.identity)
  const adAccount = adLink
    ? { adAccountId: adLink.externalId, name: text(adMeta.name) ?? null, currency: text(adMeta.currency), timeZone: text(adMeta.timeZone), statusText: text(adMeta.statusText), businessId: text(adMeta.businessId) }
    : null
  const { state, stateText } = metaConnectionState({ isActive: row.isActive, authStatus: row.authStatus, token, adAccountLinked: !!adLink, accountName: adAccount?.name ?? null, now })
  return {
    connectionId: row.id,
    label: connectionLabel(row).label,
    state,
    stateText,
    authStatus: row.authStatus,
    systemUser: text(identity.userId) ? { id: String(identity.userId), name: text(identity.username) } : null,
    appId,
    token,
    adAccount,
    page: pageLink ? { pageId: pageLink.externalId, name: text(record(pageLink.metadata).name) } : null,
    instagram: igLink ? { instagramId: igLink.externalId, username: text(record(igLink.metadata).username) } : null,
    lastError: row.lastError ?? null,
  }
}

/** C1 — this business's live Meta connections (0 or 1 normally); the one with an ad account chosen comes first. */
export async function listMetaConnections(now: Date = new Date()): Promise<MetaConnection[]> {
  const rows = (await listManagedConnections(false)).filter((row) => row.channelType === 'META' && isOwnConnection(row))
  if (rows.length === 0) return []
  const links = await prisma.metaAccountLink.findMany({ where: { connectionId: { in: rows.map((row) => row.id) } } })
  const out: MetaConnection[] = []
  for (const row of rows) out.push(connectionOf(row, links.filter((l) => l.connectionId === row.id), await metaAppIdOf(row.id), now))
  return out.sort((a, b) => Number(!!b.adAccount) - Number(!!a.adAccount))
}

// ── C2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Meta is asked again at most this often per connection. */
export const CHOICES_TTL_MS = 5 * 60_000
const choicesCache = new Map<string, { at: number; choices: MetaChoices }>()
const choicesInFlight = new Map<string, Promise<MetaChoices>>()

export function __clearMetaChoicesCache(): void {
  choicesCache.clear()
  choicesInFlight.clear()
}

/** A Meta connection of THIS business, or MetaConnectionNotFound. */
async function ownConnection(connectionId: string): Promise<ConnectionRow> {
  const row = await prisma.channelConnection.findFirst({ where: { id: connectionId, channelType: 'META' }, select: CONNECTION_PUBLIC_SELECT })
  if (!row || !isOwnConnection(row)) throw new MetaConnectionNotFound()
  return row
}

/** C2 — what this connection's system user can see (each list fails on its own, in words). */
export async function getMetaChoices(connectionId: string, options: { force?: boolean; now?: number } = {}): Promise<MetaChoices> {
  await ownConnection(connectionId)
  const key = `${workspaceIdForQuery()}:${connectionId}`
  const now = options.now ?? Date.now()
  const kept = choicesCache.get(key)
  if (!options.force && kept && now - kept.at < CHOICES_TTL_MS) return kept.choices
  const running = choicesInFlight.get(key)
  if (running) return running
  const read = discoverMetaChoices(connectionId)
    .then((choices) => { choicesCache.set(key, { at: Date.now(), choices }); return choices })
    .finally(() => choicesInFlight.delete(key))
  choicesInFlight.set(key, read)
  return read
}

/**
 * Which of the ids Meta offered ANOTHER business has already picked, per product (the global unique index on
 * (product, externalId) refuses them on Save): `nexus_meta_links_taken` (packages/database/workspaces/meta-links-taken.sql)
 * answers yes or no per id, never which business. Read fresh on every answer.
 */
async function takenByOtherBusinesses(choices: MetaChoices): Promise<Map<MetaProduct, Set<string>>> {
  const ads = choices.adAccounts.items.map((a) => a.adAccountId)
  const pages = choices.pages.items.map((p) => p.pageId)
  const instagram = choices.instagram.items.map((i) => i.instagramId)
  const taken = new Map<MetaProduct, Set<string>>([[META_PRODUCT.adAccount, new Set()], [META_PRODUCT.page, new Set()], [META_PRODUCT.instagram, new Set()]])
  if (ads.length + pages.length + instagram.length === 0) return taken
  const rows = await prisma.$queryRaw<Array<{ product: MetaProduct; id: string }>>`
    SELECT ${META_PRODUCT.adAccount}::text AS product, t.id FROM nexus_meta_links_taken(${META_PRODUCT.adAccount}, ${ads}::text[]) AS t(id)
    UNION ALL
    SELECT ${META_PRODUCT.page}::text, t.id FROM nexus_meta_links_taken(${META_PRODUCT.page}, ${pages}::text[]) AS t(id)
    UNION ALL
    SELECT ${META_PRODUCT.instagram}::text, t.id FROM nexus_meta_links_taken(${META_PRODUCT.instagram}, ${instagram}::text[]) AS t(id)`
  for (const row of rows) taken.get(row.product)?.add(row.id)
  return taken
}

/** C2 as answered: every asset with `takenByAnotherBusiness`. */
export async function metaChoicesAnswer(choices: MetaChoices) {
  const taken = await takenByOtherBusinesses(choices)
  const isTaken = (product: MetaProduct, id: string) => taken.get(product)?.has(id) ?? false
  return {
    systemUser: choices.systemUser,
    adAccounts: { items: choices.adAccounts.items.map((a) => ({ ...a, takenByAnotherBusiness: isTaken(META_PRODUCT.adAccount, a.adAccountId) })), error: choices.adAccounts.error },
    pages: { items: choices.pages.items.map((p) => ({ ...p, takenByAnotherBusiness: isTaken(META_PRODUCT.page, p.pageId) })), error: choices.pages.error },
    instagram: { items: choices.instagram.items.map((i) => ({ ...i, takenByAnotherBusiness: isTaken(META_PRODUCT.instagram, i.instagramId) })), error: choices.instagram.error },
  }
}

// ── C3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function parseMetaSelection(body: unknown): MetaSelectionInput {
  const input = record(body)
  const adAccountId = metaAdAccountId(input.adAccountId)
  if (!adAccountId) throw new MetaSelectionError(400, 'invalid', 'Choose the Meta ad account Nexus reads.')
  const optional = (value: unknown, what: string): string | null => {
    if (value === null || value === undefined || value === '') return null
    const id = metaObjectId(value)
    if (!id) throw new MetaSelectionError(400, 'invalid', `The ${what} is not one Meta offered. Reload the choices and pick again.`)
    return id
  }
  return { adAccountId, pageId: optional(input.pageId, 'Facebook Page'), instagramId: optional(input.instagramId, 'Instagram account') }
}

const TAKEN: Record<MetaProduct, string> = {
  AD_ACCOUNT: 'Another business in Nexus already reads this Meta ad account. An ad account can belong to one business only. Choose another, or disconnect Meta in the other business first.',
  PAGE: 'Another business in Nexus already uses this Facebook Page. A Page can belong to one business only. Choose another, or disconnect Meta in the other business first.',
  INSTAGRAM: 'Another business in Nexus already uses this Instagram account. An Instagram account can belong to one business only. Choose another, or disconnect Meta in the other business first.',
}

async function linkRow(tx: Prisma.TransactionClient, product: MetaProduct, data: { connectionId: string; externalId: string; label: string; metadata: Prisma.InputJsonObject; selectedByUserId: string }) {
  try {
    return await tx.metaAccountLink.upsert({ where: { meta_link_product: workspaceKey({ product }) }, create: { product, ...data }, update: data })
  } catch (err) {
    // The index name is in `meta.target` (Prisma's engine) or `meta.driverAdapterError.cause.constraint` (the pg adapter).
    const e = err as { code?: string; meta?: unknown }
    if (e?.code === 'P2002' && JSON.stringify(e.meta ?? null).includes('externalId')) throw new MetaSelectionError(409, 'taken_by_other_business', TAKEN[product], product)
    throw err
  }
}

/**
 * C3 — save which ad account (and, optionally, which Page and Instagram account) this business reads through this
 * connection. Idempotent: the same choice again changes nothing and records nothing. Returns the connection as C1 shows it.
 */
export async function saveMetaSelection(connectionId: string, body: unknown, actor: { userId?: string | null } = {}): Promise<{ connection: MetaConnection; changed: boolean }> {
  const selection = parseMetaSelection(body)
  let row: ConnectionRow
  try {
    row = await ownConnection(connectionId)
  } catch {
    throw new MetaSelectionError(404, 'not_found', 'This Meta connection is not connected to this business.')
  }
  if (!row.isActive || SIGNED_OUT.has(row.authStatus)) throw new MetaSelectionError(409, 'not_offered', 'Meta needs a new system-user token for this business before its assets can be chosen.')
  const choices = await getMetaChoices(connectionId)
  const account = choices.adAccounts.items.find((a) => a.adAccountId === selection.adAccountId)
  if (!account) throw new MetaSelectionError(409, 'not_offered', 'Meta does not offer this ad account to this business\'s system user. Assign it to the system user in Meta Business settings, or reload the list.')
  const page = selection.pageId ? choices.pages.items.find((p) => p.pageId === selection.pageId) : null
  if (selection.pageId && !page) throw new MetaSelectionError(409, 'not_offered', 'Meta does not offer this Facebook Page to this business\'s system user. Reload the list and choose again.')
  const instagram = selection.instagramId ? choices.instagram.items.find((i) => i.instagramId === selection.instagramId) : null
  if (selection.instagramId && !instagram) throw new MetaSelectionError(409, 'not_offered', 'Meta does not offer this Instagram account to this business\'s system user. Reload the list and choose again.')

  // One ad account per business: another, still connected, Meta connection of this business that holds the choice keeps it.
  const existing = await prisma.metaAccountLink.findMany({ include: { connection: { select: { isActive: true } } } })
  if (existing.some((l) => l.product === META_PRODUCT.adAccount && l.connectionId !== connectionId && l.connection.isActive)) {
    throw new MetaSelectionError(409, 'account_taken', 'This business already reads a Meta ad account through another Meta connection. Change the choice there, or disconnect that connection first.')
  }
  const before = new Map(existing.map((l) => [l.product, l]))
  const same = (product: MetaProduct, externalId: string | null) => {
    const link = before.get(product)
    return externalId ? !!link && link.connectionId === connectionId && link.externalId === externalId : !link
  }
  const unchanged = same(META_PRODUCT.adAccount, account.adAccountId) && same(META_PRODUCT.page, page?.pageId ?? null) && same(META_PRODUCT.instagram, instagram?.instagramId ?? null)
  const userId = actor.userId ?? workspaceContext()?.actorUserId ?? 'system'
  if (!unchanged) {
    await prisma.$transaction(async (tx) => {
      await linkRow(tx, META_PRODUCT.adAccount, {
        connectionId, externalId: account.adAccountId, label: account.name ?? 'Unnamed Meta ad account', selectedByUserId: userId,
        metadata: { name: account.name, currency: account.currency, timeZone: account.timeZone, accountStatus: account.accountStatus, statusText: account.statusText, businessId: account.businessId },
      })
      if (page) await linkRow(tx, META_PRODUCT.page, { connectionId, externalId: page.pageId, label: page.name ?? 'Unnamed Facebook Page', metadata: { name: page.name }, selectedByUserId: userId })
      else await tx.metaAccountLink.deleteMany({ where: { product: META_PRODUCT.page } })
      if (instagram) await linkRow(tx, META_PRODUCT.instagram, { connectionId, externalId: instagram.instagramId, label: instagram.username ? `@${instagram.username}` : 'Instagram account', metadata: { username: instagram.username, pageId: instagram.pageId }, selectedByUserId: userId })
      else await tx.metaAccountLink.deleteMany({ where: { product: META_PRODUCT.instagram } })
      await recordConnectionEventInTx(tx, {
        connectionId, channelKey: 'META', type: 'accounts_linked', actor: { kind: 'operator', userId: actor.userId ?? workspaceContext()?.actorUserId ?? null },
        detail: {
          adAccount: account.name ?? 'Unnamed Meta ad account', adAccountId: account.adAccountId,
          page: page ? page.name ?? 'Unnamed Facebook Page' : 'none', pageId: page?.pageId ?? null,
          instagram: instagram ? (instagram.username ? `@${instagram.username}` : 'Instagram account') : 'none', instagramId: instagram?.instagramId ?? null,
          previousAdAccountId: before.get(META_PRODUCT.adAccount)?.externalId ?? null,
        },
      })
    })
  }
  const connection = (await listMetaConnections()).find((c) => c.connectionId === connectionId)
  if (!connection) throw new MetaSelectionError(404, 'not_found', 'This Meta connection is not connected to this business.')
  return { connection, changed: !unchanged }
}

// ── /api/accounts health ─────────────────────────────────────────────────────────────────────────────────────────

/** The Settings › Channels health of each Meta connection of this business, from its C1 state. */
export async function metaConnectionHealth(): Promise<Map<string, { health: 'ok' | 'warn' | 'error' | 'unknown'; healthReason: string | null }>> {
  const out = new Map<string, { health: 'ok' | 'warn' | 'error' | 'unknown'; healthReason: string | null }>()
  for (const c of await listMetaConnections()) {
    switch (c.state) {
      case 'choose_account': out.set(c.connectionId, { health: 'warn', healthReason: 'Choose a Meta ad account' }); break
      case 'permission_missing': out.set(c.connectionId, { health: 'warn', healthReason: c.stateText }); break
      case 'token_problem':
      case 'sign_in_needed': out.set(c.connectionId, { health: 'error', healthReason: c.stateText }); break
      case 'ok': {
        const soon = c.token.expiresAt && Date.parse(c.token.expiresAt) - Date.now() < 14 * DAY_MS
        out.set(c.connectionId, soon ? { health: 'warn', healthReason: c.stateText } : { health: 'ok', healthReason: null })
        break
      }
    }
  }
  return out
}
