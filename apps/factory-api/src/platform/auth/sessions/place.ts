import type { FastifyRequest } from 'fastify'
import { placeOf, type SessionPlace } from '@nexus/factory-domain/auth/sessions/device'
import { readFactoryVariables } from '../../../env'

/**
 * Where a new session signs in from (B-W2b-404; PLT-064 "place (country, city from IP)"): the factory keeps no address
 * database and never the address, so the place comes only from an edge proxy that looks it up and that we trust to set
 * it: FACTORY_PLACE_HEADERS=cloudflare (Cloudflare's CF-IPCountry and, with its visitor-location headers, CF-IPCity) in
 * apps/factory-api's environment, and only on a request that came through the trusted proxies (FACTORY_TRUST_PROXY_HOPS
 * > 0: Fastify then reads the forwarded addresses). Unset, or any other request: no place (a client could write those
 * headers itself). The country also answers B-W2b-399's "IP in the table".
 */

const NO_PLACE: SessionPlace = Object.freeze({ ipCountry: null, ipCity: null })

let forced: boolean | undefined
let read: boolean | undefined

/** Tests: read the edge proxy's place headers or not; undefined goes back to the environment's. */
export function usePlaceHeaders(on: boolean | undefined): void {
  forced = on
}

function placeHeadersOn(): boolean {
  if (forced !== undefined) return forced
  if (read === undefined) read = readFactoryVariables().FACTORY_PLACE_HEADERS === 'cloudflare'
  return read
}

/** The place of a request for a new session (none unless the switch is on and the request came through the proxies). */
export function sessionPlaceOf(request: FastifyRequest): SessionPlace {
  if (!placeHeadersOn()) return NO_PLACE
  if (forced === undefined && !Array.isArray(request.ips)) return NO_PLACE
  return placeOf({ country: request.headers['cf-ipcountry'], city: request.headers['cf-ipcity'] })
}
