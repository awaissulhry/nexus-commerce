import type { PresenceRow } from './types'
export type ConnectionHealth = PresenceRow['connection']
const stringOrNull = (value: unknown): string | null => typeof value === 'string' ? value : null
/** A stored auth report is evidence; a failed discovery read has no such evidence. */
export function connectionHealth(raw: Record<string, unknown>, now: number): ConnectionHealth {
  const authStatus = stringOrNull(raw.authStatus)
  const expiry = stringOrNull(raw.accessTokenExpiresAt)
  const expiryMs = expiry == null ? null : Date.parse(expiry)
  const expired = expiryMs != null && Number.isFinite(expiryMs) && expiryMs <= now
  const invalidExpiry = expiryMs != null && !Number.isFinite(expiryMs)
  const knownDisconnected = raw.isActive === false || ['revoked', 'expired', 'disconnected'].includes(authStatus ?? '')
  const state = knownDisconnected || expired ? 'not-connected'
    : !invalidExpiry && raw.isActive === true && authStatus === 'connected' ? 'connected' : 'unknown'
  const refusal = authStatus === 'revoked' ? 'Connection revoked. Stored listings remain visible.'
    : expired || authStatus === 'expired' ? 'Connection grant expired. Stored listings remain visible.'
      : state === 'not-connected' ? 'Connection disconnected. Stored listings remain visible.'
        : state === 'unknown' ? 'Connection health could not be established from this report.' : null
  return { state, asOf: stringOrNull(raw.lastHeartbeatAt), via: 'ChannelConnection', refusal,
    authStatus, accessTokenExpiresAt: expiry, lastErrorAt: stringOrNull(raw.lastErrorAt), lastError: stringOrNull(raw.lastError) }
}
export const DISCOVERY_FAILURE = 'Channel availability could not be read. This does not mean the product has no listings.'

export function connectionScopePolicy(health: ConnectionHealth | null | undefined, channel: string, discoveryFailed: boolean) {
  const needsReconnect = health?.authStatus === 'expired' || health?.refusal?.startsWith('Connection grant expired.') === true
  const disconnected = health?.state === 'not-connected' && !needsReconnect
  const reason = discoveryFailed ? DISCOVERY_FAILURE : disconnected
    ? `The ${channel} account is disconnected. Reconnect it in Settings → Channels to work on this listing.` : null
  return { disabled: reason != null, disabledReason: reason, needsReconnect,
    note: reason ?? (needsReconnect ? `The ${channel} account needs reconnecting. Content editing remains available; the channel could not be checked.` : health?.refusal ?? null) }
}
