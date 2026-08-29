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

import { randomUUID } from 'node:crypto'
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'
import { encryptCredentials, decryptCredentials, isCredentialsBlob, onCredentialsKmsFallback } from '../../lib/crypto.js'
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
  expiresInSec: number
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
const NEEDS_REAUTH_AFTER = 10
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

/** Read credentials: the envelope first, the legacy plaintext columns as fallback until the backfill nulls them. */
async function readCredentials(row: ConnRow): Promise<Credentials | null> {
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
async function writeCredentials(connectionId: string, creds: Credentials, extraData: Record<string, unknown> = {}) {
  const { blob, keyId } = await encryptCredentials(creds as unknown as Record<string, unknown>)
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      credentialsEnc: blob,
      credentialsKeyId: keyId,
      accessTokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
      refreshTokenExpiresAt: creds.refreshTokenExpiresAt ? new Date(creds.refreshTokenExpiresAt) : undefined,
      // Legacy display/expiry columns keep a DATE (not a secret) so pre-CX.2 readers still render.
      tokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
      ebayTokenExpiresAt: creds.accessTokenExpiresAt ? new Date(creds.accessTokenExpiresAt) : null,
      accessToken: null,
      refreshToken: null,
      ebayAccessToken: null,
      ebayRefreshToken: null,
      ...extraData,
    },
  })
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
}): ConnectionHandle {
  const key = channelKeyOf(row.channelType) as ChannelKey
  return {
    id: row.id,
    channelKey: key,
    channelType: row.channelType,
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

export async function getAccessToken(connectionId: string, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  if (typeof connectionId !== 'string' || !connectionId) {
    throw new Error(`getAccessToken expects a connection id string, got ${typeof connectionId}`)
  }
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
  if (row.managedBy === 'env') {
    throw new Error(`Connection ${connectionId} is env-managed; its token is minted by the channel client from env until CX.3.`)
  }
  const creds = await readCredentials(row)
  if (!creds) throw new Error(`Connection ${connectionId} has no credentials — reconnect the account.`)

  const { spec } = specFor(row)
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
    const creds = await readCredentials(row)
    if (!creds) throw new Error(`Connection ${connectionId} has no credentials`)
    const { key, spec } = specFor(row)
    const bufferMs = (spec.tokenExpirationBufferSec ?? DEFAULT_BUFFER_SEC) * 1000
    const exp = creds.accessTokenExpiresAt ? Date.parse(creds.accessTokenExpiresAt) : 0
    if (!force && exp > Date.now() + bufferMs) return creds.accessToken

    if (!creds.refreshToken) {
      await failRefresh(row, 'auth_expired', 'No refresh token stored — the grant must be renewed by the operator.')
      throw new RefreshFailed(connectionId, 'auth_expired', 'No refresh token stored')
    }
    if (creds.refreshTokenExpiresAt && Date.parse(creds.refreshTokenExpiresAt) < Date.now()) {
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
      if (app.clientSecret) body.set('client_secret', app.clientSecret)
    }
    const started = Date.now()
    let res: Response
    try {
      res = await fetch(url, { method: 'POST', headers, body: body.toString() })
    } catch (err) {
      await failRefresh(row, 'network', err instanceof Error ? err.message : String(err))
      throw new RefreshFailed(connectionId, 'network', 'Token endpoint unreachable')
    }
    const text = await res.text()
    if (!res.ok) {
      const cls = classifyAuthError(res.status, text)
      await failRefresh(row, cls, `Token endpoint ${res.status}: ${text.slice(0, 300)}`)
      throw new RefreshFailed(connectionId, cls, `Token refresh failed with ${res.status}`)
    }
    const json = JSON.parse(text) as Record<string, unknown>
    const accessToken = String(json.access_token ?? '')
    if (!accessToken) {
      await failRefresh(row, 'unknown', 'Token endpoint returned no access_token')
      throw new RefreshFailed(connectionId, 'unknown', 'No access_token in refresh response')
    }
    const expiresIn = Number(json.expires_in ?? spec.auth.accessTokenLifetimeSec ?? 3600)
    const rotated = typeof json.refresh_token === 'string' && json.refresh_token.length > 0
    const next: Credentials = {
      accessToken,
      refreshToken: rotated ? String(json.refresh_token) : creds.refreshToken,
      accessTokenExpiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      refreshTokenExpiresAt:
        rotated && spec.auth.refreshTokenLifetimeSec
          ? new Date(Date.now() + spec.auth.refreshTokenLifetimeSec * 1000).toISOString()
          : creds.refreshTokenExpiresAt ?? null,
      extra: creds.extra,
    }
    await writeCredentials(connectionId, next, {
      lastRefreshAt: new Date(),
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
    })
    await transition(row, 'connected', 'refresh succeeded')
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

async function failRefresh(row: ConnRow, errorClass: ErrorClass, message: string): Promise<void> {
  lastFailureAt.set(row.id, Date.now())
  const failures = row.consecutiveFailures + 1
  await prisma.channelConnection.update({
    where: { id: row.id },
    data: { consecutiveFailures: failures, lastError: `${errorClass}: ${message}`.slice(0, 500), lastErrorAt: new Date() },
  })
  const { key } = specFor(row)
  await recordConnectionEvent({ connectionId: row.id, channelKey: key, type: 'refresh_failed', detail: { errorClass, message, failures } })
  const next: AuthStatus =
    errorClass === 'auth_revoked' || errorClass === 'auth_expired'
      ? 'needs_reauth'
      : failures >= NEEDS_REAUTH_AFTER
        ? 'needs_reauth'
        : failures >= DEGRADED_AFTER
          ? 'degraded'
          : (row.authStatus as AuthStatus)
  await transition({ ...row, consecutiveFailures: failures }, next, message)
  logger.warn('[cx-token] refresh failed', { connectionId: row.id, errorClass, failures })
}

// ── state machine ────────────────────────────────────────────────────────────

export async function transition(row: Pick<ConnRow, 'id' | 'channelType' | 'authStatus' | 'displayName'> & { consecutiveFailures?: number }, next: AuthStatus, reason: string, actor: Actor = SYSTEM_ACTOR): Promise<void> {
  const prev = row.authStatus as AuthStatus
  if (prev === next) return
  // Terminal states are left only by a new grant (storeGrant) or a disconnect.
  if ((prev === 'revoked' || prev === 'disconnected') && next !== 'connected' && next !== 'disconnected' && next !== 'revoked') return
  await prisma.channelConnection.update({ where: { id: row.id }, data: { authStatus: next } })
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
): Promise<void> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId } })
  if (!row) throw new Error(`ChannelConnection not found: ${connectionId}`)
  const { key, spec } = specFor(row)
  const now = Date.now()
  const refreshLife = grant.refreshExpiresInSec ?? spec.auth.refreshTokenLifetimeSec ?? null
  const creds: Credentials = {
    accessToken: grant.accessToken,
    refreshToken: grant.refreshToken ?? null,
    accessTokenExpiresAt: new Date(now + grant.expiresInSec * 1000).toISOString(),
    refreshTokenExpiresAt: refreshLife ? new Date(now + refreshLife * 1000).toISOString() : null,
    extra: grant.tokenResponseMetadata,
  }
  const identity = grant.identity
  await writeCredentials(connectionId, creds, {
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
  })
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
      isActive: false,
      isPrimary: false,
      authStatus: next,
      refreshLeaseUntil: null,
      refreshLeaseOwner: null,
    },
  })
  await recordConnectionEvent({ connectionId, channelKey: key, type: reason === 'channel' ? 'revoke' : 'disconnect', actor, detail: { reason, revokedAtChannel } })
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
    where: { id: connectionId, credentialsEnc: null },
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
  await prisma.channelConnection.update({
    where: { id: connectionId },
    data: {
      accessToken: c.accessToken,
      refreshToken: c.refreshToken ?? null,
      tokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null,
      ...(row.channelType === 'EBAY'
        ? { ebayAccessToken: c.accessToken, ebayRefreshToken: c.refreshToken ?? null, ebayTokenExpiresAt: c.accessTokenExpiresAt ? new Date(c.accessTokenExpiresAt) : null }
        : {}),
    },
  })
  return true
}

export const __tokenTest = {
  OWNER,
  clearInflight: () => {
    inflight.clear()
    lastFailureAt.clear()
  },
}
