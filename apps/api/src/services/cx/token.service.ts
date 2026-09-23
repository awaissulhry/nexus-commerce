/**
 * CX.1 — the token service: the ONLY module that decrypts a connection's
 * credentials (docs/2026-08-29-cx1-connection-core.md §4).
 *
 * What it guarantees:
 *   • one refresh at a time per connection, across every process — a DB lease
 *     (`refreshLeaseUntil/Owner`, CAS UPDATE) + an in-process in-flight map +
 *     a double-check re-read after the lease. No advisory lock is ever held
 *     across an HTTP call (pgbouncer-safe). Nango uses a Redis SET NX it calls
 *     "not a distributed lock"; a row lease in the system of record is.
 *   • rotation done right: a refresh token in the response replaces the old
 *     one (Etsy, TikTok); no refresh token in the response keeps the old one
 *     (eBay, Amazon — verified in research R1/R2).
 *   • honest state: refresh success writes `lastRefreshAt`, never `lastSyncAt`
 *     — the "Last sync" that was really "last token refresh" ends here.
 *   • an authStatus state machine with consecutive-failure counting (not
 *     calendar days), write-pausing on `needs_reauth`, a ledger row for every
 *     transition, and operator alerts.
 *
 * Callers never see credentials: connectors get a `ConnectionHandle` whose
 * `token()` closure calls back in here.
 */

import { rememberTokenAccount } from '../gateway/token-accounts.js'
import { randomUUID } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { encryptCredentials, decryptCredentials, isCredentialsBlob, onCredentialsKmsFallback } from '../../lib/crypto.js'
import { workspaceIdForQuery, WorkspaceError } from '../../lib/workspace-context.js'
import { recordConnectionEvent, SYSTEM_ACTOR, type Actor } from './events.service.js'
import { getChannelApp } from './apps.service.js'
import {
  channelKeyOf,
  classifyAuthError,
  getChannelSpec,
  type ChannelKey,
  type ConnectionHandle,
  type ConnectionIdentity,
  type ErrorClass,
} from './catalog.js'
import { alertService, AlertType } from '../monitoring/alert.service.js'
import { parseTokenResponse, tokenLifetime, TOKEN_REQUEST_TIMEOUT_MS } from './token-response.js'
import { clearLegacyChannelCredentials } from './legacy-channel-credentials.js'
import { EbayGrantInspectionError, introspectEbayRefreshToken } from './ebay-grant-introspection.js'

// ── types ────────────────────────────────────────────────────────────────────

export interface Credentials {
  accessToken: string
  refreshToken?: string | null
  /** ISO timestamps — the blob is JSON. */
  accessTokenExpiresAt?: string | null
  refreshTokenExpiresAt?: string | null
  extra?: Record<string, unknown>
}

export interface GrantResult {
  accessToken: string
  refreshToken?: string | null
  /** null for a provider-issued non-expiring access token. */
  expiresInSec: number | null
  /** Seconds, when the channel reports it (eBay `refresh_token_expires_in`). */
  refreshExpiresInSec?: number | null
  grantedScopes: string[]
  identity: ConnectionIdentity | null
  region?: string | null
  tokenResponseMetadata?: Record<string, unknown>
}

export type AuthStatus = 'connected' | 'degraded' | 'needs_reauth' | 'revoked' | 'disconnected' | 'unknown'

export class ConnectionNeedsReauth extends Error {
  readonly code = 'CONNECTION_NEEDS_REAUTH'
  constructor(readonly connectionId: string, readonly authStatus: AuthStatus) {
    super(`Connection ${connectionId} is ${authStatus}; writes are paused until the operator reconnects.`)
    this.name = 'ConnectionNeedsReauth'
  }
}
export class RefreshContended extends Error {
  readonly code = 'REFRESH_CONTENDED'
  constructor(readonly connectionId: string) {
    super(`Another worker holds the refresh lease for ${connectionId} and did not finish in time.`)
    this.name = 'RefreshContended'
  }
}
export class RefreshFailed extends Error {
  readonly code = 'REFRESH_FAILED'
  constructor(readonly connectionId: string, readonly errorClass: ErrorClass, message: string) {
    super(message)
    this.name = 'RefreshFailed'
  }
}

// ── constants ────────────────────────────────────────────────────────────────

const DEFAULT_BUFFER_SEC = 15 * 60
const LEASE_SEC = 30
const LEASE_WAIT_MS = 12_000
const LEASE_POLL_MS = 250
const FAILURE_COOLDOWN_MS = 30_000
const DEGRADED_AFTER = 3
const OWNER = `${process.env.RAILWAY_REPLICA_ID ?? process.env.HOSTNAME ?? 'local'}:${process.pid}:${randomUUID().slice(0, 8)}`

const inflight = new Map<string, Promise<string>>()
const lastFailureAt = new Map<string, number>()

export function tokenServiceEnabled(): boolean {
  return process.env.NEXUS_CX_TOKEN_SERVICE !== '0'
}

// Wire the crypto fallback notice to the ledger + an alert, once per process.
onCredentialsKmsFallback((reason) => {
  void recordConnectionEvent({ channelKey: 'SYSTEM', type: 'kms_fallback', detail: { reason } })
  void alertService.createAlert(
    AlertType.CONNECTION_HEALTH,
    'Credential encryption is running on the env key, not KMS',
    `NEXUS_KMS_KEY_ID is unset or KMS is unreachable (${reason}). Credentials are still encrypted (v1) but the enterprise bar is KMS envelope encryption.`,
    1,
  )
})

// ── credential access ────────────────────────────────────────────────────────

type ConnRow = NonNullable<Awaited<ReturnType<typeof prisma.channelConnection.findUnique>>>

/**
 * BP.S1b — a READ grant must never yield a usable credential.
 *
 * Until migration `20260916a` a connection row was visible only to its owning
 * business, so "I am holding this row" implied "I own it" and nothing here had to
 * check. `nexus_workspace_grant_read` breaks that implication: a guest business can
 * now SELECT a shared account.
 *
 * RLS cannot close this one. Owner and guest share the single database role
 * `nexus_workspace_runtime`, so a column-level GRANT cannot tell them apart, and
 * row access therefore carries the credential columns with it. That leaves exactly
 * one place to refuse — this module, the only one that decrypts (see the file
 * header). `CONNECTION_PUBLIC_SELECT` keeps credentials out of what every other
 * caller reads; this keeps them out of what a guest can USE.
 *
 * Fail-closed deliberately. With business profiles on and NO context the adapter
 * sets `nexus.workspace_id` to '' (packages/database/workspace-adapter.ts:18), so
 * RLS returns no rows and this cannot be reached today; `workspaceIdForQuery()`
 * throws there rather than passing, so a future unscoped caller is refused instead
 * of silently trusted.
 *
 * BP.S3 — a `mode = 'publish'` grant now admits a guest as well, because publishing
 * IS reaching the channel and a publish grant that could not mint a token would be a
 * button that never works. A `read` grant still cannot, and that is the whole
 * difference between the two modes.
 *
 * 🔴 This is the one place a guest's right to the channel is decided, so it is also
 * the one place that must stay async-safe: the grant is re-read on every call rather
 * than cached, so a revoked share stops working on the next push and not at the next
 * restart.
 */
async function assertCredentialOwner(row: Pick<ConnRow, 'id' | 'workspaceId'>): Promise<void> {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return
  const current = workspaceIdForQuery()
  if (row.workspaceId === current) return
  const publishGrant = await prisma.channelAccountGrant.findFirst({
    where: { connectionId: row.id, workspaceId: current, mode: 'publish', revokedAt: null },
    select: { connectionId: true },
  })
  if (publishGrant) return
  throw new WorkspaceError(
    'account_not_owned',
    'This seller account is shared with your business for reading only. Ask its owner for permission to publish.',
    403,
  )
}

/** Read credentials: the envelope first, the legacy plaintext columns as fallback until the backfill nulls them. */
async function readCredentials(row: ConnRow): Promise<Credentials | null> {
  await assertCredentialOwner(row)
  if (row.credentialsEnc && isCredentialsBlob(row.credentialsEnc)) {
    const c = (await decryptCredentials(row.credentialsEnc)) as unknown as Credentials
    return c.accessToken ? c : null
  }
  const accessToken = row.accessToken ?? row.ebayAccessToken
  if (!accessToken) return null
  return {
    accessToken,
    refreshToken: row.refreshToken ?? row.ebayRefreshToken ?? null,
    accessTokenExpiresAt: (row.tokenExpiresAt ?? row.ebayTokenExpiresAt)?.toISOString() ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt?.toISOString() ?? null,
  }
}

/** Write credentials as an envelope and null every plaintext column in the same UPDATE. */
async function writeCredentials(connectionId: string, creds: Credentials, extraData: Record<string, unknown> = {}, expected?: ConnRow, persistRelated?: (tx: Prisma.TransactionClient) => Promise<void>) {
  const { blob, keyId } = await encryptCredentials(creds as unknown as Record<string, unknown>)
  const data = {
    credentialsEnc: blob,
    credentialsKeyId: keyId,
    accessTokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
    refreshTokenExpiresAt: creds.refreshTokenExpiresAt ? new Date(creds.refreshTokenExpiresAt) : null,
    // Legacy display/expiry columns keep a DATE (not a secret) so pre-CX.2 readers still render.
    tokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
    ebayTokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
    accessToken: null,
    refreshToken: null,
    ebayAccessToken: null,
    ebayRefreshToken: null,
    ...extraData,
  }
  if (expected) {
    const saved = await prisma.channelConnection.updateMany({ where: refreshSnapshot(expected), data })
    if (saved.count !== 1) throw new RefreshContended(connectionId)
  } else if (persistRelated) {
    await prisma.$transaction(async (tx) => {
      await tx.channelConnection.update({ where: { id: connectionId }, data })
      await persistRelated(tx)
    })
  } else {
    await prisma.channelConnection.update({ where: { id: connectionId }, data })
  }
}

/** A late response must never overwrite a new grant or resurrect a disconnected account. */
function refreshSnapshot(row: ConnRow): Prisma.ChannelConnectionWhereInput {
  return {
    id: row.id, credentialsEnc: row.credentialsEnc, accessToken: row.accessToken,
    refreshToken: row.refreshToken, ebayAccessToken: row.ebayAccessToken, ebayRefreshToken: row.ebayRefreshToken,
    isActive: row.isActive, authStatus: row.authStatus, refreshLeaseOwner: row.refreshLeaseOwner,
    grantVersion: row.grantVersion,
  }
}

/** Representation-only maintenance must not restore an obsolete credential/expiry tuple. */
function credentialMaintenanceSnapshot(row: ConnRow): Prisma.ChannelConnectionWhereInput {
  return { ...refreshSnapshot(row), tokenExpiresAt: row.tokenExpiresAt,
    ebayTokenExpiresAt: row.ebayTokenExpiresAt, accessTokenExpiresAt: row.accessTokenExpiresAt,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt }
}

function assertRefreshable(row: ConnRow): void {
  if (!row.isActive || ['disconnected', 'revoked', 'needs_reauth'].includes(row.authStatus)) {
    throw new ConnectionNeedsReauth(row.id, row.authStatus as AuthStatus)
  }
}

/**
 * CX.3a — the ONE narrow public read of a stored credential, and deliberately
 * only one field of it.
 *
 * `readCredentials` stays private: nothing outside this module may hold a
 * connection's access token. The Amazon Ads client is not on the leased refresh
 * yet — it runs its own LWA exchange behind its own in-process token cache
 * (`services/advertising/ads-api-client.ts`), and CX.3b is what moves it onto
 * `getAccessToken`. This also supplies the verified seller grant required by
 * the SP-API SDK constructor even when its automatic token renewal is disabled.
 * Returns only the refresh token; decryption remains owned by the token service.
 */
export async function readRefreshToken(connectionId: string): Promise<string | null> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row || row.isActive === false || ['disconnected', 'revoked', 'needs_reauth'].includes(row.authStatus)) return null
  const creds = await readCredentials(row)
  return creds?.refreshToken ?? null
}

export interface EbayRefreshGrantEvidence {
  readonly connectionId: string
  readonly workspaceId: string
  readonly grantVersion: number
  readonly active: boolean
}

/** Read-only evidence; the domain writer must compare this version under its account lock. */
export async function inspectEbayRefreshGrant(connectionId: string): Promise<Readonly<EbayRefreshGrantEvidence>> {
  if (!tokenServiceEnabled()) throw new EbayGrantInspectionError('canonical_service_required')
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new EbayGrantInspectionError('account_unavailable')
  // Unlike publishing, lifecycle inspection is never available through a guest share.
  if (row.workspaceId !== workspaceIdForQuery()) throw new WorkspaceError('account_not_owned', 'This account belongs to another business profile.', 403)
  if (row.channelType !== 'EBAY' || row.managedBy !== 'oauth' || !row.isActive
    || ['revoked', 'disconnected'].includes(row.authStatus)
    || !Number.isSafeInteger(row.grantVersion) || row.grantVersion < 0) {
    throw new EbayGrantInspectionError('account_unavailable')
  }
  let creds: Credentials | null
  try { creds = await readCredentials(row) }
  catch { throw new EbayGrantInspectionError('credential_unavailable') }
  if (typeof creds?.refreshToken !== 'string' || !creds.refreshToken.trim()) throw new EbayGrantInspectionError('credential_missing')
  const environment = environmentOf(row)
  let url: string
  let app: Awaited<ReturnType<typeof getChannelApp>>
  try {
    const { spec } = specFor(row)
    const endpoint = spec.auth.introspectUrl?.({ environment })
    if (!endpoint) throw new EbayGrantInspectionError('configuration')
    url = endpoint
    app = await getChannelApp('EBAY', environment)
  }
  catch { throw new EbayGrantInspectionError('configuration') }
  const active = await introspectEbayRefreshToken({ url, clientId: app.clientId, clientSecret: app.clientSecret, refreshToken: creds.refreshToken })
  return Object.freeze({ connectionId: row.id, workspaceId: row.workspaceId, grantVersion: row.grantVersion, active })
}

function specFor(row: Pick<ConnRow, 'channelType'>) {
  const key = channelKeyOf(row.channelType)
  if (!key) throw new Error(`No catalogue entry for channelType ${row.channelType}`)
  return { key, spec: getChannelSpec(key) }
}

function environmentOf(row: Pick<ConnRow, 'connectionMetadata'>): 'production' | 'sandbox' {
  const meta = (row.connectionMetadata ?? {}) as Record<string, unknown>
  return meta.environment === 'sandbox' ? 'sandbox' : 'production'
}

// ── public API ───────────────────────────────────────────────────────────────

/** The handle connectors receive — carries identity/scopes, never credentials. */
export function handleOf(row: {
  id: string
  channelType: string
  region: string | null
  grantedScopes: string[]
  identity: unknown
  connectionMetadata?: unknown
}): ConnectionHandle {
  const key = channelKeyOf(row.channelType) as ChannelKey
  return {
    id: row.id,
    channelKey: key,
    channelType: row.channelType,
    environment: (row.connectionMetadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production',
    region: row.region,
    grantedScopes: row.grantedScopes,
    identity: (row.identity as ConnectionIdentity | null) ?? null,
    token: () => getAccessToken(row.id),
  }
}

/** Throws when writes must not proceed for this connection. */
export async function assertWritable(connectionId: string): Promise<void> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { authStatus: true } })
  const status = (row?.authStatus ?? 'unknown') as AuthStatus
  if (status === 'needs_reauth' || status === 'revoked' || status === 'disconnected') {
    throw new ConnectionNeedsReauth(connectionId, status)
  }
}

/**
 * P1.2 — the access token for an account; the channel gateway is told which account it belongs to, so a
 * call site that holds only the token is still recorded and checked against the right account.
 */
export async function getAccessToken(connectionId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const token = await accessTokenFor(connectionId, opts)
  rememberTokenAccount(token, connectionId)
  return token
}

async function accessTokenFor(connectionId: string, opts: { forceRefresh?: boolean }): Promise<string> {
  if (typeof connectionId !== 'string' || !connectionId) {
    throw new Error(`getAccessToken expects a connection id string, got ${typeof connectionId}`)
  }
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
  if (row.isActive === false) throw new ConnectionNeedsReauth(connectionId, 'disconnected')
  // Checked HERE and not only in readCredentials: the env-managed Amazon branch
  // below mints a token from the environment and never reaches the decrypt path.
  await assertCredentialOwner(row)
  if (row.managedBy === 'env' && row.channelType === 'AMAZON') return (await import('../../lib/amazon-sp-client.js')).getAmazonAccessToken(row.id)
  if (row.managedBy === 'env') {
    throw new Error(`Connection ${connectionId} is env-managed; its token is minted by the channel client from env until CX.3.`)
  }
  // Authentication state also gates cached tokens. A later diagnostic can
  // replace lastError, but cannot make a rejected/disconnected grant usable.
  if (['needs_reauth', 'revoked', 'disconnected'].includes(row.authStatus)) {
    throw new ConnectionNeedsReauth(connectionId, row.authStatus as AuthStatus)
  }
  const creds = await readCredentials(row)
  if (!creds) throw new Error(`Connection ${connectionId} has no credentials — reconnect the account.`)

  const { spec } = specFor(row)
  if (!creds.accessTokenExpiresAt && spec.auth.accessTokenLifetimeSec === null) return creds.accessToken
  const bufferMs = (spec.tokenExpirationBufferSec ?? DEFAULT_BUFFER_SEC) * 1000
  const exp = creds.accessTokenExpiresAt ? Date.parse(creds.accessTokenExpiresAt) : 0
  if (!opts.forceRefresh && exp > Date.now() + bufferMs) return creds.accessToken

  // Collapse concurrent callers in this process.
  const pending = inflight.get(connectionId)
  if (pending && !opts.forceRefresh) return pending
  const p = refreshUnderLease(connectionId, creds, opts.forceRefresh === true).finally(() => inflight.delete(connectionId))
  inflight.set(connectionId, p)
  return p
}

export interface RefreshOutcome {
  refreshed: boolean
  accessTokenExpiresAt: Date | null
  reason?: 'still_valid' | 'refreshed' | 'refreshed_by_peer'
}

/** Manual / cron refresh. Returns what happened without leaking the token. */
export async function refreshNow(connectionId: string, actor: Actor = SYSTEM_ACTOR, force = false): Promise<RefreshOutcome> {
  const before = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { accessTokenExpiresAt: true } })
  await getAccessToken(connectionId, { forceRefresh: force })
  const after = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { accessTokenExpiresAt: true } })
  const advanced = !!after?.accessTokenExpiresAt && (!before?.accessTokenExpiresAt || after.accessTokenExpiresAt > before.accessTokenExpiresAt)
  if (advanced && actor.kind === 'operator') {
    await recordConnectionEvent({ connectionId, channelKey: 'SYSTEM', type: 'refresh', actor, detail: { manual: true } })
  }
  return { refreshed: advanced, accessTokenExpiresAt: after?.accessTokenExpiresAt ?? null, reason: advanced ? 'refreshed' : 'still_valid' }
}

// ── the leased refresh ───────────────────────────────────────────────────────

async function acquireLease(connectionId: string): Promise<boolean> {
  const n = await prisma.$executeRaw`
    UPDATE "ChannelConnection"
       SET "refreshLeaseUntil" = now() + make_interval(secs => ${LEASE_SEC}),
           "refreshLeaseOwner" = ${OWNER}
     WHERE "id" = ${connectionId}
       AND ("refreshLeaseUntil" IS NULL OR "refreshLeaseUntil" < now())`
  return n === 1
}

async function releaseLease(connectionId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "ChannelConnection" SET "refreshLeaseUntil" = NULL, "refreshLeaseOwner" = NULL
     WHERE "id" = ${connectionId} AND "refreshLeaseOwner" = ${OWNER}`
}

async function refreshUnderLease(connectionId: string, stale: Credentials, force: boolean): Promise<string> {
  const cooled = lastFailureAt.get(connectionId)
  if (!force && cooled && Date.now() - cooled < FAILURE_COOLDOWN_MS) {
    throw new RefreshFailed(connectionId, 'unknown', `Refresh for ${connectionId} failed ${Math.round((Date.now() - cooled) / 1000)}s ago; cooling down.`)
  }

  const got = await acquireLease(connectionId)
  if (!got) {
    // A peer is refreshing. Wait for its result rather than racing it.
    const deadline = Date.now() + LEASE_WAIT_MS
    const staleExp = stale.accessTokenExpiresAt ? Date.parse(stale.accessTokenExpiresAt) : 0
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, LEASE_POLL_MS))
      const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
      if (!row) break
      assertRefreshable(row)
      const exp = row.accessTokenExpiresAt?.getTime() ?? 0
      if (exp > staleExp && exp > Date.now()) {
        const fresh = await readCredentials(row)
        if (fresh) return fresh.accessToken
      }
      const leaseGone = !row.refreshLeaseUntil || row.refreshLeaseUntil.getTime() < Date.now()
      if (leaseGone && (await acquireLease(connectionId))) return refreshOwned(connectionId, force)
    }
    throw new RefreshContended(connectionId)
  }
  return refreshOwned(connectionId, force)
}

async function refreshOwned(connectionId: string, force: boolean): Promise<string> {
  try {
    // Double-check: a peer may have refreshed between our read and our lease.
    const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
    if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
    assertRefreshable(row)
    const creds = await readCredentials(row)
    if (!creds) throw new Error(`Connection ${connectionId} has no credentials`)
    const { key, spec } = specFor(row)
    if (!creds.accessTokenExpiresAt && spec.auth.accessTokenLifetimeSec === null) return creds.accessToken
    const bufferMs = (spec.tokenExpirationBufferSec ?? DEFAULT_BUFFER_SEC) * 1000
    const exp = creds.accessTokenExpiresAt ? Date.parse(creds.accessTokenExpiresAt) : 0
    if (!force && exp > Date.now() + bufferMs) return creds.accessToken

    if (!creds.refreshToken) {
      await failRefresh(row, 'auth_expired', 'No refresh token stored — the grant must be renewed by the operator.')
      throw new RefreshFailed(connectionId, 'auth_expired', 'No refresh token stored')
    }
    // Earlier private imports assigned the public-app annual consent lifetime
    // to an existing token. That local estimate is not an Amazon expiry.
    const privateAmazon = key === 'AMAZON_SP' && creds.extra?.authorizationMode === 'self'
    const refreshTokenExpiresAt = privateAmazon ? null : creds.refreshTokenExpiresAt
    if (refreshTokenExpiresAt && Date.parse(refreshTokenExpiresAt) < Date.now()) {
      await failRefresh(row, 'auth_expired', 'The refresh token has expired — the operator must reconnect.')
      throw new RefreshFailed(connectionId, 'auth_expired', 'Refresh token expired')
    }

    const environment = environmentOf(row)
    const app = await getChannelApp(key, environment)
    const url = spec.auth.tokenUrl({ region: row.region, environment })
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.refreshToken, ...(spec.auth.refreshParams ?? {}) })
    const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
    if (spec.auth.tokenRequestAuth === 'basic') {
      headers.Authorization = `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`
    } else {
      body.set('client_id', app.clientId)
      if (app.clientSecret && spec.auth.includeClientSecretInTokenRequest !== false) body.set('client_secret', app.clientSecret)
    }
    const started = Date.now()
    let res: Response
    let text: string
    try {
      res = await fetch(url, { method: 'POST', headers, body: body.toString(), signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS), redirect: 'error' })
      text = await res.text()
    } catch (err) {
      await failRefresh(row, 'network', err instanceof Error ? err.message : String(err))
      throw new RefreshFailed(connectionId, 'network', 'Token endpoint unreachable')
    }
    if (!res.ok) {
      const cls = classifyAuthError(res.status, text)
      // Provider error bodies can echo credentials; keep them out of logs and account cards.
      await failRefresh(row, cls, `Token endpoint ${res.status} rejected the refresh (${cls}).`)
      throw new RefreshFailed(connectionId, cls, `Token refresh failed with ${res.status}`)
    }
    let json: ReturnType<typeof parseTokenResponse>
    try {
      json = parseTokenResponse(text)
    } catch {
      await failRefresh(row, 'unknown', 'Token endpoint returned an invalid JSON response')
      throw new RefreshFailed(connectionId, 'unknown', 'Invalid token response')
    }
    const accessToken = json.access_token
    let expiresIn: number
    let refreshLife: number | null
    try {
      expiresIn = tokenLifetime(json.expires_in, spec.auth.accessTokenLifetimeSec ?? 3600)!
      refreshLife = tokenLifetime(json.refresh_token_expires_in, spec.auth.refreshTokenLifetimeSec ?? null)
    } catch {
      await failRefresh(row, 'unknown', 'Token endpoint returned an invalid access-token lifetime')
      throw new RefreshFailed(connectionId, 'unknown', 'Invalid access-token lifetime')
    }
    const rotated = typeof json.refresh_token === 'string' && json.refresh_token.length > 0
    if (spec.auth.rotatesRefreshToken && !rotated) {
      await failRefresh(row, 'unknown', 'Token endpoint did not return the required rotated refresh token')
      throw new RefreshFailed(connectionId, 'unknown', 'No rotated refresh token in response')
    }
    const next: Credentials = {
      accessToken,
      refreshToken: rotated ? String(json.refresh_token) : creds.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt:
        privateAmazon ? null : rotated && refreshLife
          ? new Date(Date.now() + refreshLife * 1000).toISOString()
          : creds.refreshTokenExpiresAt ?? null,
      extra: creds.extra,
    }
    await saveRefreshedCredentials(connectionId, next, {
      lastRefreshAt: new Date(),
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      authStatus: 'connected',
      ...(typeof json.scope === 'string' ? { grantedScopes: json.scope.split(/[\s,]+/).filter(Boolean) } : {}),
    }, row, spec.auth.rotatesRefreshToken && rotated)
    if (row.authStatus !== 'connected') await announceTransition(row, 'connected', 'refresh succeeded', SYSTEM_ACTOR)
    await recordConnectionEvent({
      connectionId,
      channelKey: key,
      type: 'refresh',
      detail: { latencyMs: Date.now() - started, rotated, expiresInSec: expiresIn },
    })
    lastFailureAt.delete(connectionId)
    return accessToken
  } finally {
    await releaseLease(connectionId).catch(() => undefined)
  }
}

/**
 * P6.3 (docs/channel-connections/FINAL-PLAN.md) — a rotating channel (Etsy) invalidates the old refresh
 * token the moment it answers, so a save that is refused or fails loses the only working refresh token
 * and the operator must reconnect. For a rotated token: when the row moved underneath but the GRANT did
 * not (same stored credentials, still active, not disconnected or revoked — e.g. the heartbeat changed
 * the status or the failure count), save against the fresh row; retry a failed write. A grant replaced
 * meanwhile (a reconnect) or an account disconnected meanwhile still wins, as before. Every other
 * refresh keeps the strict one-shot compare-and-set.
 */
async function saveRefreshedCredentials(connectionId: string, next: Credentials, extraData: Record<string, unknown>, row: ConnRow, rotatedMustLand: boolean): Promise<void> {
  if (!rotatedMustLand) return writeCredentials(connectionId, next, extraData, row)
  const sameGrant = (fresh: ConnRow) =>
    fresh.isActive && !['disconnected', 'revoked'].includes(fresh.authStatus) &&
    fresh.credentialsEnc === row.credentialsEnc && fresh.accessToken === row.accessToken && fresh.refreshToken === row.refreshToken &&
    fresh.ebayAccessToken === row.ebayAccessToken && fresh.ebayRefreshToken === row.ebayRefreshToken
  let expected = row
  let lastError: unknown
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await writeCredentials(connectionId, next, extraData, expected)
      if (attempt > 1) logger.info('[cx-token] rotated refresh token saved on retry', { connectionId, attempt })
      return
    } catch (err) {
      lastError = err
      const fresh = (await prisma.channelConnection.findUnique({ where: { id: connectionId } }).catch(() => null)) as ConnRow | null
      if (fresh && !sameGrant(fresh)) throw err
      if (fresh) expected = fresh
      if (!(err instanceof RefreshContended)) await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
    }
  }
  const { key } = specFor(row)
  await recordConnectionEvent({ connectionId, channelKey: key, type: 'refresh_failed', detail: { errorClass: 'unknown', message: 'A rotated refresh token could not be saved.' } })
  await alertService.createAlert(
    AlertType.CONNECTION_HEALTH,
    `${row.channelType} account "${row.displayName ?? row.id}": a new refresh token could not be saved`,
    'The channel issued a new refresh token and Nexus could not store it after three attempts. The account may need to be reconnected in Settings → Channels.',
    1,
    [row.id],
  ).catch(() => null)
  throw lastError
}

async function failRefresh(row: ConnRow, errorClass: ErrorClass, message: string): Promise<void> {
  const failures = row.consecutiveFailures + 1
  const next = statusAfterConnectionFailure(row.authStatus as AuthStatus, errorClass, failures)
  const saved = await prisma.channelConnection.updateMany({
    where: refreshSnapshot(row),
    data: { ...(row.authStatus !== next ? { authStatus: next } : {}), consecutiveFailures: failures, lastError: `${errorClass}: ${message}`.slice(0, 500), lastErrorAt: new Date() },
  })
  if (saved.count !== 1) return
  lastFailureAt.set(row.id, Date.now())
  const { key } = specFor(row)
  await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'refresh_failed', detail: { errorClass, message, failures } })
  if (row.authStatus !== next) await announceTransition(row, next, message, SYSTEM_ACTOR)
  logger.warn('[cx-token] refresh failed', { connectionId: row.id, errorClass, failures })
}

// ── state machine ────────────────────────────────────────────────────────────

/** Both refresh and heartbeat report the same recovery action for a failure. */
export function statusAfterConnectionFailure(current: AuthStatus, errorClass: ErrorClass, failures: number): AuthStatus {
  if (['needs_reauth', 'revoked', 'disconnected'].includes(current)) return current
  if (errorClass === 'auth_revoked' || errorClass === 'auth_expired' || errorClass === 'identity_mismatch') return 'needs_reauth'
  if (errorClass === 'configuration' || failures >= DEGRADED_AFTER) return 'degraded'
  return current
}

export async function transition(row: Pick<ConnRow, 'id' | 'channelType' | 'authStatus' | 'displayName'> & { consecutiveFailures?: number }, next: AuthStatus, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<void> {
  const prev = row.authStatus as AuthStatus
  if (prev === next) return
  // Terminal states are left only by a new grant (storeGrant) or a disconnect.
  if ((prev === 'revoked' || prev === 'disconnected') && next !== 'disconnected' && next !== 'revoked') return
  const saved = await prisma.channelConnection.updateMany({ where: { id: row.id, authStatus: prev }, data: { authStatus: next } })
  if (saved.count !== 1) return
  await announceTransition(row, next, reason, actor)
}

async function announceTransition(row: Pick<ConnRow, 'id' | 'channelType' | 'authStatus' | 'displayName'>, next: AuthStatus, reason: string, actor: Actor): Promise<void> {
  const prev = row.authStatus as AuthStatus
  const key = channelKeyOf(row.channelType) ?? row.channelType
  await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'status_change', actor, detail: { from: prev, to: next, reason } })
  const label = row.displayName ?? row.id
  if (next === 'needs_reauth' || next === 'revoked') {
    await alertService.createAlert(
      AlertType.CONNECTION_HEALTH,
      `${row.channelType} account "${label}" needs reconnecting`,
      `${reason}. Writes to this account are paused until the operator reconnects it in Settings → Channels.`,
      1,
      [row.id],
    )
  } else if (next === 'degraded') {
    await alertService.createAlert(AlertType.CONNECTION_HEALTH, `${row.channelType} account "${label}" is degraded`, reason, 1, [row.id])
  } else if (next === 'connected' && (prev === 'degraded' || prev === 'needs_reauth')) {
    await alertService.createAlert(AlertType.CONNECTION_HEALTH, `${row.channelType} account "${label}" recovered`, reason, 1, [row.id])
  }
}

// ── grants and revocation ────────────────────────────────────────────────────

/** Persist a fresh grant (connect / re-consent / adopt) onto a connection row. */
export async function storeGrant(
  connectionId: string,
  grant: GrantResult,
  actor: Actor,
  event: 'grant' | 'reconsent' | 'adopt',
  persistRelated?: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<void> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
  const { key, spec } = specFor(row)
  if (key === 'AMAZON_SP' && row.region && grant.region && row.region !== grant.region) {
    throw new Error('Reconnect Amazon in the existing account region.')
  }
  const now = Date.now()
  const refreshLife = key === 'AMAZON_SP' && grant.tokenResponseMetadata?.authorizationMode === 'self'
    ? null
    : grant.refreshExpiresInSec ?? spec.auth.refreshTokenLifetimeSec ?? null
  const creds: Credentials = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken ?? null,
    accessTokenExpiresAt: grant.expiresInSec === null ? null : new Date(now + grant.expiresInSec * 1000).toISOString(),
    refreshTokenExpiresAt: refreshLife ? new Date(now + refreshLife * 1000).toISOString() : null,
    extra: grant.tokenResponseMetadata,
  }
  const identity = grant.identity
  await writeCredentials(connectionId, creds, {
    // Same row write as credential replacement: concurrent reconsents cannot
    // share a generation. This is local ordering, not provider issuance time.
    grantVersion: { increment: 1 },
    isActive: true,
    managedBy: 'oauth',
    authStatus: 'connected',
    grantedScopes: grant.grantedScopes,
    region: grant.region ?? row.region ?? spec.defaultRegion ?? null,
    identity: identity ? (identity as unknown as Record<string, unknown>) : undefined,
    // MAP identity columns + the legacy display columns pre-CX.2 readers use.
    ...(identity?.userId ? { externalAccountId: identity.userId } : {}),
    ...(identity?.username ? { displayName: identity.username, ebaySignInName: identity.username } : {}),
    ...(identity?.storeName ? { ebayStoreName: identity.storeName } : {}),
    ...(identity?.storeUrl ? { ebayStoreFrontUrl: identity.storeUrl } : {}),
    apiVersion: spec.apiVersion,
    consecutiveFailures: 0,
    lastError: null,
    lastErrorAt: null,
    lastRefreshAt: new Date(),
    refreshLeaseUntil: null,
    refreshLeaseOwner: null,
  }, undefined, persistRelated)
  lastFailureAt.delete(connectionId)
  await recordConnectionEvent({
    connectionId,
    channelKey: key,
    type: event,
    actor,
    detail: { scopes: grant.grantedScopes.length, identity: identity?.username ?? identity?.userId ?? null, region: grant.region ?? null },
  })
  if (row.authStatus !== 'connected') {
    await recordConnectionEvent({ connectionId, channelKey: key, type: 'status_change', actor, detail: { from: row.authStatus, to: 'connected', reason: event } })
  }
}

/** Revoke at the channel (best effort), null credentials, deactivate. */
export async function revoke(connectionId: string, actor: Actor, reason: 'operator' | 'channel' | 'reauth'): Promise<{ revokedAtChannel: boolean }> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
  const { key, spec } = specFor(row)
  let revokedAtChannel = false
  if (row.managedBy === 'oauth' && spec.auth.revokeUrl) {
    try {
      const creds = await readCredentials(row)
      const token = creds?.refreshToken ?? creds?.accessToken
      if (token) {
        const app = await getChannelApp(key, environmentOf(row))
        const res = await fetch(spec.auth.revokeUrl({ environment: environmentOf(row) }), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
          },
          body: new URLSearchParams({ token, token_type_hint: creds?.refreshToken ? 'refresh_token' : 'access_token' }).toString(),
        })
        revokedAtChannel = res.ok
        if (!res.ok) logger.warn('[cx-token] channel revoke returned non-2xx', { connectionId, status: res.status })
      }
    } catch (err) {
      logger.warn('[cx-token] channel revoke failed; nulling locally', { connectionId, error: err instanceof Error ? err.message : String(err) })
    }
  }
  const next: AuthStatus = reason === 'channel' ? 'revoked' : 'disconnected'
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      credentialsEnc: null,
      credentialsKeyId: null,
      accessToken: null,
      refreshToken: null,
      ebayAccessToken: null,
      ebayRefreshToken: null,
      tokenExpiresAt: null,
      ebayTokenExpiresAt: null,
      accessTokenExpiresAt: null,
      refreshTokenExpiresAt: null,
      isActive: false,
      isPrimary: false,
      authStatus: next,
      refreshLeaseUntil: null,
      refreshLeaseOwner: null,
    },
  })
  // P4.5e — the update above reaches `ChannelConnection` only. Amazon Ads keeps its
  // own `credentialsEncrypted` on `AmazonAdsConnection`, and the client falls back to
  // it the moment the core has no usable grant — which a revoke is exactly what
  // creates. Without this, Ads calls carried on after the operator disconnected.
  const legacy = await clearLegacyChannelCredentials(key)
  await recordConnectionEvent({ connectionId, channelKey: key, type: reason === 'channel' ? 'revoke' : 'disconnect', actor, detail: { reason, revokedAtChannel, legacy } })
  await recordConnectionEvent({ connectionId, channelKey: key, type: 'status_change', actor, detail: { from: row.authStatus, to: next, reason } })
  return { revokedAtChannel }
}

/** Encrypt legacy plaintext rows (the one-shot backfill). Returns what happened. */
export async function encryptLegacyRow(connectionId: string): Promise<'encrypted' | 'skipped' | 'no_tokens'> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) return 'skipped'
  if (row.credentialsEnc) return 'skipped'
  const accessToken = row.accessToken ?? row.ebayAccessToken
  if (!accessToken) return 'no_tokens'
  const creds: Credentials = {
    accessToken,
    refreshToken: row.refreshToken ?? row.ebayRefreshToken ?? null,
    accessTokenExpiresAt: (row.tokenExpiresAt ?? row.ebayTokenExpiresAt)?.toISOString() ?? null,
    refreshTokenExpiresAt: row.refreshTokenExpiresAt?.toISOString() ?? null,
  }
  const { blob, keyId } = await encryptCredentials(creds as unknown as Record<string, unknown>)
  // Verified round-trip before the plaintext is nulled.
  const back = (await decryptCredentials(blob)) as unknown as Credentials
  if (back.accessToken !== creds.accessToken || (back.refreshToken ?? null) !== (creds.refreshToken ?? null)) {
    throw new Error(`Round-trip mismatch for ${connectionId}; plaintext left in place`)
  }
  const n = await prisma.channelConnection.updateMany({
    where: credentialMaintenanceSnapshot(row),
    data: {
      credentialsEnc: blob,
      credentialsKeyId: keyId,
      accessTokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
      accessToken: null,
      refreshToken: null,
      ebayAccessToken: null,
      ebayRefreshToken: null,
    },
  })
  return n.count === 1 ? 'encrypted' : 'skipped'
}

/** The counterpart for rollback: restore plaintext from the envelope (never nulls the blob). */
export async function restorePlaintextRow(connectionId: string): Promise<boolean> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row?.credentialsEnc) return false
  const c = (await decryptCredentials(row.credentialsEnc)) as unknown as Credentials
  const saved = await prisma.channelConnection.updateMany({
    where: credentialMaintenanceSnapshot(row),
    data: {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken ?? null,
      tokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null,
      ...(row.channelType === 'EBAY'
        ? { ebayAccessToken: c.accessToken, ebayRefreshToken: c.refreshToken ?? null, ebayTokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null }
        : {}),
    },
  })
  return saved.count === 1
}

export const __tokenTest = {
  OWNER,
  clearInflight: () => {
    inflight.clear()
    lastFailureAt.clear()
  },
}
