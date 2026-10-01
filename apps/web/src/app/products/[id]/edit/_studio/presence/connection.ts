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
  // Audit P12 (2026-10-01) — each state says what it is, or nothing: "could not be established" showed for a login that
  // needs reconnecting (which blocks publishing), one that is retrying by itself, and one with no report alike.
  const refusal = authStatus === 'revoked' ? 'Connection revoked. Stored listings remain visible.'
    : expired || authStatus === 'expired' ? 'Connection grant expired. Stored listings remain visible.'
      : state === 'not-connected' ? 'Connection disconnected. Stored listings remain visible.'
        : authStatus === 'needs_reauth' ? 'This account needs reconnecting.'
          : authStatus === 'degraded' ? CONNECTION_DEGRADED : null
  return { state, asOf: stringOrNull(raw.lastHeartbeatAt), via: 'ChannelConnection', refusal,
    authStatus, accessTokenExpiresAt: expiry, lastErrorAt: stringOrNull(raw.lastErrorAt), lastError: stringOrNull(raw.lastError) }
}
export const DISCOVERY_FAILURE = 'Channel availability could not be read. This does not mean the product has no listings.'
export const CONNECTION_DEGRADED = 'Nexus could not refresh this account\'s login; it retries on its own.'
/** Where an account is reconnected. A workspace `Link` keeps the business prefix. */
export const CHANNELS_SETTINGS = { href: '/settings/channels', label: 'Settings → Channels' } as const

/**
 * `account`: the account's own name, so the note says WHICH account to reconnect. `link`: where to do it (the footer
 * renders it); only for a state the person must act on.
 */
export function connectionScopePolicy(health: ConnectionHealth | null | undefined, channel: string, discoveryFailed: boolean, account?: string | null) {
  const needsReconnect = health?.authStatus === 'expired' || health?.authStatus === 'needs_reauth' || health?.refusal?.startsWith('Connection grant expired.') === true
  const disconnected = health?.state === 'not-connected' && !needsReconnect
  const reason = discoveryFailed ? DISCOVERY_FAILURE : disconnected
    ? `The ${channel} account is disconnected. Reconnect it in Settings → Channels to work on this listing.` : null
  const note = reason ?? (needsReconnect ? `Reconnect ${account?.trim() || `the ${channel} account`} in Settings → Channels.`
    : health?.authStatus === 'degraded' ? CONNECTION_DEGRADED : null)
  return { disabled: reason != null, disabledReason: reason, needsReconnect, note,
    link: !discoveryFailed && (needsReconnect || disconnected) ? CHANNELS_SETTINGS : null }
}
