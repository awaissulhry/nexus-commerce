/**
 * P1.2 — which account an access token belongs to. The token service records every access token it
 * hands out (a SHA-256 of it, never the token) with its account; the gateway reads it when a call site
 * holds only the token. A token Nexus did not hand out has no account here, and the gateway then refuses
 * the call (it never guesses the primary account).
 */
import { createHash } from 'node:crypto'

const MAX_ENTRIES = 5000
const TTL_MS = 6 * 3600_000
const byHash = new Map<string, { connectionId: string; expiresAt: number }>()
const keyOf = (token: string) => createHash('sha256').update(token).digest('base64url')

export function rememberTokenAccount(token: string, connectionId: string): void {
  if (!token || !connectionId) return
  const key = keyOf(token)
  byHash.delete(key)
  byHash.set(key, { connectionId, expiresAt: Date.now() + TTL_MS })
  if (byHash.size > MAX_ENTRIES) byHash.delete(byHash.keys().next().value!)
}

export function accountOfToken(token: string): string | null {
  const hit = byHash.get(keyOf(token))
  if (!hit) return null
  if (hit.expiresAt < Date.now()) { byHash.delete(keyOf(token)); return null }
  return hit.connectionId
}

export const __tokenAccountsTest = { clear: () => byHash.clear(), size: () => byHash.size }
