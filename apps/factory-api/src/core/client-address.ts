import type { FastifyInstance, FastifyRequest } from 'fastify'
import {
  NO_TRUSTED_PROXIES,
  cameThroughTrustedProxy,
  clientAddress,
  type TrustedProxies,
} from '@nexus/factory-domain/core/client-address'

/**
 * THE client address of a request (B-W2b-F57): the ONE place the API decides whose address a request carries. The rate
 * limit (core/security.ts, every route and the routes' own limits), sessions (office, portal), sign-in codes, security
 * events, links, approvals and the abuse guard of the public routes all call `clientAddressOf`; nothing reads
 * `request.ip` (core/client-address.vitest.test.ts holds that).
 *
 * The rule (factory-domain core/client-address.ts): X-Forwarded-For counts only from a trusted proxy
 * (FACTORY_TRUSTED_PROXIES: `loopback` by default locally, where the web runs beside the API; set on Railway, see
 * apps/factory-api/CLAUDE.md "Client address"), read right to left, the right-most address that is not a trusted proxy.
 * Any other request keeps its TCP address whatever it sends. Fastify's own `trustProxy` stays off, so `request.ip`,
 * `request.host` and `request.protocol` never follow a forwarded header.
 */

declare module 'fastify' {
  interface FastifyInstance {
    /** The proxies whose X-Forwarded-For counts (core/client-address.ts). */
    readonly trustedProxies: TrustedProxies
  }
}

const decided = new WeakMap<FastifyRequest, string>()

/** Gives the app its trusted proxies (buildApp, before any hook reads an address). */
export function installClientAddress(app: FastifyInstance, trusted: TrustedProxies): void {
  app.decorate('trustedProxies', trusted)
}

function trustedOf(request: FastifyRequest): TrustedProxies {
  return (request.server as Partial<FastifyInstance> | undefined)?.trustedProxies ?? NO_TRUSTED_PROXIES
}

/** The address of the person (or device) behind a request, canonical (`unknown` without a TCP peer). Once per request. */
export function clientAddressOf(request: FastifyRequest): string {
  const known = decided.get(request)
  if (known !== undefined) return known
  const address = clientAddress({ socket: request.raw.socket?.remoteAddress, forwardedFor: request.headers['x-forwarded-for'] }, trustedOf(request))
  decided.set(request, address)
  return address
}

/** True when the request's TCP peer is a trusted proxy (a header only a proxy may set, such as the place, can count). */
export function cameThroughProxy(request: FastifyRequest): boolean {
  return cameThroughTrustedProxy({ socket: request.raw.socket?.remoteAddress }, trustedOf(request))
}
