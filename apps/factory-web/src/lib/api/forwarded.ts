import { forwardedForChain, trustedProxies, TrustedProxiesError, type TrustedProxies } from '@nexus/factory-domain/core/client-address'

/**
 * The browser's address on its way to the API (B-W2b-F57). Every browser call reaches the API through this web (the
 * `/api/*` proxy route, src/app/api/[...path]/route.ts) and every server render calls it from here (lib/api/server.ts,
 * the portal's loaders), so the API's TCP peer is this web. The web therefore sends X-Forwarded-For: the chain it
 * received ONLY when its own peer is a trusted edge (FACTORY_TRUSTED_PROXIES of this web: on Railway `private`, the edge;
 * locally none, a browser talks to `next dev` itself), then that peer's address; from anybody else the peer alone. A
 * browser's own X-Forwarded-For never travels on (factory-domain core/client-address.ts `forwardedForChain`).
 *
 * The peer's address: Next.js keeps no socket for route handlers or server components, but it writes the TCP peer into
 * `x-forwarded-for` when the request has none (next/dist/server/base-server.js, pinned by forwarded.vitest.test.ts).
 * So src/proxy.ts moves the received header aside (RECEIVED_FORWARDED_FOR) on every request first; what Next then writes
 * into `x-forwarded-for` is the peer.
 */

export const FORWARDED_FOR = 'x-forwarded-for'
/** The X-Forwarded-For the web received, set aside by src/proxy.ts (a browser's own copy of this header is dropped there). */
export const RECEIVED_FORWARDED_FOR = 'x-factory-received-forwarded-for'

/**
 * The edges in front of this web, from FACTORY_TRUSTED_PROXIES (factory-domain's syntax). A bad list refuses, in words;
 * on Railway (RAILWAY_ENVIRONMENT) the list must be set (`private` there; `none` is a choice, unset is not): next.config.ts
 * calls this, so `next dev`, `next build` and `next start` refuse to start.
 */
export function readWebTrustedProxies(value: string | undefined, railwayEnvironment: string | undefined): TrustedProxies {
  if ((value === undefined || value.trim() === '') && railwayEnvironment !== undefined && railwayEnvironment !== '') {
    throw new Error('FACTORY_TRUSTED_PROXIES is not set: on Railway the factory web names the edge in front of it (`private`), or `none`.')
  }
  try {
    return trustedProxies(value)
  } catch (error) {
    if (error instanceof TrustedProxiesError) throw new Error(`FACTORY_TRUSTED_PROXIES is not valid: ${error.message}`)
    throw error
  }
}

let configured: TrustedProxies | undefined

/** This web's trusted edges (read once). */
export function webTrustedProxies(): TrustedProxies {
  configured ??= readWebTrustedProxies(process.env.FACTORY_TRUSTED_PROXIES, process.env.RAILWAY_ENVIRONMENT)
  return configured
}

/** Tests: forget the list read, so the next call reads the environment again. */
export function forgetWebTrustedProxies(): void {
  configured = undefined
}

interface HeaderReader {
  get(name: string): string | null
}

/**
 * The X-Forwarded-For to send to the API for this request (headers after src/proxy.ts and Next.js): null when the peer
 * is unknown (then nothing is sent, and the API sees this web).
 */
export function forwardedForOf(headers: HeaderReader, trusted: TrustedProxies = webTrustedProxies()): string | null {
  return forwardedForChain({ socket: headers.get(FORWARDED_FOR), forwardedFor: headers.get(RECEIVED_FORWARDED_FOR) }, trusted)
}

/** src/proxy.ts: the request's headers with the received X-Forwarded-For set aside (and any copy of the aside header dropped). */
export function withReceivedForwardedForAside(headers: Headers): Headers {
  const next = new Headers(headers)
  next.delete(RECEIVED_FORWARDED_FOR)
  next.delete(FORWARDED_FOR)
  const received = headers.get(FORWARDED_FOR)
  if (received !== null && received.trim() !== '') next.set(RECEIVED_FORWARDED_FOR, received)
  return next
}
