/**
 * Google sign-in: WHO consented, from the `id_token` in the token answer (OpenID Connect), with no extra
 * call to Google.
 *
 * The token answer comes straight from Google's token endpoint over TLS, in exchange for our own code,
 * so its signature is not checked here (OpenID Connect Core 3.1.3.7, item 6: TLS validation of the
 * issuer MAY stand in for the signature on a token received this way). The claims still are: the issuer
 * must be Google, the audience our own client id, and the token not expired. Anything else → null, and the
 * connect flow refuses the grant (`identityRequired`).
 */
import type { ConnectionIdentity } from '../../catalog.js'

export const GOOGLE_ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
/** Clock leeway for `exp`, in seconds. */
const LEEWAY_SEC = 60

function decodePayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split('.')
  if (parts.length !== 3 || !parts[1]) return null
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** `{ userId: sub, username: email }` when the id token is Google's, for our client, and not expired; else null. */
export function identityFromGoogleIdToken(idToken: unknown, ctx: { clientId: string; nowMs?: number }): ConnectionIdentity | null {
  if (typeof idToken !== 'string' || !idToken || !ctx.clientId) return null
  const claims = decodePayload(idToken)
  if (!claims) return null
  if (typeof claims.iss !== 'string' || !GOOGLE_ISSUERS.has(claims.iss)) return null
  const aud = claims.aud
  const audienceOk = typeof aud === 'string'
    ? aud === ctx.clientId
    // Several audiences: ours must be one of them and the token must have been issued to us (`azp`).
    : Array.isArray(aud) && aud.includes(ctx.clientId) && (aud.length === 1 || claims.azp === ctx.clientId)
  if (!audienceOk) return null
  const now = Math.floor((ctx.nowMs ?? Date.now()) / 1000)
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp + LEEWAY_SEC < now) return null
  if (typeof claims.sub !== 'string' || !claims.sub.trim()) return null
  const email = typeof claims.email === 'string' && claims.email.trim() && claims.email_verified !== false ? claims.email.trim() : undefined
  return {
    userId: claims.sub.trim(),
    username: email,
    extra: {
      // A Google Workspace login carries its domain: it decides whether the app can stay "Internal".
      hostedDomain: typeof claims.hd === 'string' ? claims.hd : null,
    },
  }
}
