/**
 * Where a request came from, as the security events keep it (B-W2b-399; PLT-075): the client address's keyed hash (the
 * sessions' HMAC, platform/auth/sessions/secrets.ts `ipHash`), never the address. hooks.ts remembers it per request id when a
 * request arrives and forgets it when the answer is sent, so the security events a command writes inside command()
 * (ledgers.ts) carry the address of the request that ran it. Process-local and bounded: at most MAX requests at once (the
 * oldest is dropped first; its events then carry no address, never a wrong one).
 */

const MAX = 10_000
const origins = new Map<string, string | null>()

export function rememberOrigin(requestId: string, ipHash: string | null): void {
  if (origins.size >= MAX) {
    const oldest = origins.keys().next().value
    if (oldest !== undefined) origins.delete(oldest)
  }
  origins.set(requestId, ipHash)
}

export function forgetOrigin(requestId: string): void {
  origins.delete(requestId)
}

/** The address hash of a running request, or null (a job, a test without the app, or nothing known). */
export function originOf(requestId: string): string | null {
  return origins.get(requestId) ?? null
}
