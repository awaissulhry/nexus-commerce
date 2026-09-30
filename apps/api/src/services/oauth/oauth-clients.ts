/**
 * MCP.5 — the apps that may ask a person to connect them (OAuthClient rows).
 *
 * Two ways in, both public clients (no secret; PKCE protects the code):
 *   · Client ID Metadata Document (CIMD): the client_id IS an https URL on an allowed host
 *     (claude.ai, claude.com). We fetch it — public address only, pinned DNS, no redirects,
 *     5 s, 64 KB — check it names itself, and keep it for a day.
 *   · Dynamic registration (RFC 7591): only Claude's own redirect URIs may be registered, so a
 *     stranger cannot register a look-alike app that sends codes somewhere else.
 */

import { randomUUID } from 'node:crypto'
import https from 'node:https'
import prisma from '../../db.js'
import { guardedLookup } from '../../lib/outbound-webhook.js'
import { logger } from '../../utils/logger.js'
import { cimdHosts, redirectMatches, redirectUriAllowed } from './oauth-config.js'

const CIMD_TTL_MS = 24 * 3600 * 1000
const CIMD_MAX_BYTES = 64 * 1024
const CIMD_TIMEOUT_MS = 5000

export interface OAuthClientRecord {
  id: string
  clientId: string
  clientName: string
  redirectUris: string[]
}

export class OAuthClientError extends Error {
  constructor(
    readonly code: 'invalid_client' | 'invalid_client_metadata' | 'invalid_redirect_uri',
    message: string,
  ) {
    super(message)
    this.name = 'OAuthClientError'
  }
}

type Fetcher = (url: URL) => Promise<unknown>

/** GET a metadata document over https, from a public address only. Never follows redirects. */
export const fetchMetadataDocument: Fetcher = (url) =>
  new Promise((resolve, reject) => {
    const request = https.get(url, {
      lookup: guardedLookup() as never,
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
      headers: { accept: 'application/json', 'accept-encoding': 'identity' },
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`metadata document answered ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > CIMD_MAX_BYTES) {
          request.destroy(new Error('metadata document is too large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('metadata document is not JSON'))
        }
      })
      response.on('error', reject)
    })
    request.on('error', reject)
  })

let fetcher: Fetcher = fetchMetadataDocument
export const __clientTest = { useFetcher(next: Fetcher | null) { fetcher = next ?? fetchMetadataDocument } }

function stringList(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null
}

/** A client_id that is a CIMD URL on an allowed host, or null. */
function cimdUrl(clientId: string): URL | null {
  let url: URL
  try {
    url = new URL(clientId)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port) return null
  return cimdHosts().has(url.hostname) ? url : null
}

function validRedirects(uris: string[] | null): string[] {
  if (!uris || uris.length === 0 || uris.length > 10) {
    throw new OAuthClientError('invalid_redirect_uri', 'redirect_uris must list 1 to 10 URIs')
  }
  const refused = uris.filter((uri) => !redirectUriAllowed(uri))
  if (refused.length) {
    throw new OAuthClientError('invalid_redirect_uri', `redirect URI not allowed: ${refused.join(', ')}`)
  }
  return uris
}

/** MCP.12 — what the person reads when an app's details could not be fetched from its host. */
export const cimdUnreachable = (host: string) =>
  `Nexus could not reach ${host} to check which app is asking to connect, so it cannot be connected right now. Start the connection again from Claude in a few minutes.`

async function loadCimdClient(clientId: string, url: URL): Promise<OAuthClientRecord> {
  const existing = await prisma.oAuthClient.findUnique({ where: { clientId } })
  if (existing?.disabledAt) throw new OAuthClientError('invalid_client', 'this app has been disabled')
  const fetchedAt = Date.parse(String((existing?.metadata as { fetchedAt?: unknown } | null)?.fetchedAt ?? ''))
  if (existing && Date.now() - fetchedAt < CIMD_TTL_MS) return existing

  let document: Record<string, unknown>
  try {
    document = (await fetcher(url)) as Record<string, unknown>
  } catch (error) {
    // A cached document keeps working through a brief outage of its host.
    if (existing) return existing
    // MCP.12 — the consent page shows this sentence to a person, so it names the app's host and what to do; the
    // network detail ("…:443 blocked", a DNS or TLS error) goes to the server log only.
    logger.warn('[oauth] could not read a client metadata document', { host: url.hostname, error: String((error as Error)?.message ?? error) })
    throw new OAuthClientError('invalid_client', cimdUnreachable(url.hostname))
  }
  if (!document || typeof document !== 'object' || document.client_id !== clientId) {
    throw new OAuthClientError('invalid_client_metadata', 'the metadata document must name itself as client_id')
  }
  const method = document.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') throw new OAuthClientError('invalid_client_metadata', 'only public clients are supported')
  const redirectUris = validRedirects(stringList(document.redirect_uris))
  const clientName = typeof document.client_name === 'string' && document.client_name.trim()
    ? document.client_name.trim().slice(0, 100)
    : url.hostname
  const data = {
    registration: 'cimd',
    clientName,
    redirectUris,
    metadata: { fetchedAt: new Date().toISOString(), document } as object,
  }
  return prisma.oAuthClient.upsert({ where: { clientId }, create: { clientId, ...data }, update: data })
}

/** The client behind a client_id, fetching or refreshing a CIMD document when needed. */
export async function resolveClient(clientId: unknown): Promise<OAuthClientRecord> {
  if (typeof clientId !== 'string' || !clientId || clientId.length > 500) {
    throw new OAuthClientError('invalid_client', 'client_id is missing')
  }
  const url = cimdUrl(clientId)
  if (url) return loadCimdClient(clientId, url)
  const client = await prisma.oAuthClient.findUnique({ where: { clientId } })
  if (!client || client.registration !== 'dcr') throw new OAuthClientError('invalid_client', 'unknown client')
  if (client.disabledAt) throw new OAuthClientError('invalid_client', 'this app has been disabled')
  return client
}

/** RFC 7591 dynamic registration. Returns the RFC 7591 response body. */
export async function registerClient(body: unknown): Promise<Record<string, unknown>> {
  const request = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const method = request.token_endpoint_auth_method ?? 'none'
  if (method !== 'none') throw new OAuthClientError('invalid_client_metadata', 'only public clients are supported (token_endpoint_auth_method "none")')
  const grants = stringList(request.grant_types) ?? ['authorization_code']
  if (grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token')) {
    throw new OAuthClientError('invalid_client_metadata', 'only authorization_code and refresh_token are supported')
  }
  const redirectUris = validRedirects(stringList(request.redirect_uris))
  const clientName = typeof request.client_name === 'string' && request.client_name.trim()
    ? request.client_name.trim().slice(0, 100)
    : 'Claude'
  const clientId = `nxc_${randomUUID().replace(/-/g, '')}`
  const created = await prisma.oAuthClient.create({
    data: { clientId, registration: 'dcr', clientName, redirectUris, metadata: request as object },
  })
  return {
    client_id: created.clientId,
    client_id_issued_at: Math.floor(created.createdAt.getTime() / 1000),
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: grants,
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  }
}

/** Is this redirect URI one the client registered? */
export function clientRedirects(client: OAuthClientRecord, redirectUri: string): boolean {
  return client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))
}
