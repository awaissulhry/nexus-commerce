/**
 * MCP.5 — the settings of the OAuth 2.1 server that lets a person connect Claude to Nexus.
 *
 * Off unless NEXUS_MCP_ENABLED=1: every /api/oauth route answers 404 then, so shipping this
 * changes nothing until the Owner turns it on. The rules below follow the MCP authorization
 * spec (2026-07-28) and Claude's connector requirements:
 *   · PKCE S256 only; public clients only (token_endpoint_auth_method "none").
 *   · Clients register by Client ID Metadata Document (preferred) or dynamic registration.
 *   · A redirect is exact, except loopback (Claude Code), which matches on any port.
 *   · Every token names the one MCP URL it is for (RFC 8707), and the server refuses any other: the plain
 *     URL, or (C4) one business's own URL, which also locks the consent to that business.
 */

import { publicApiOrigin } from '../public-api-origin.js'

/**
 * nexus.read reads; nexus.write asks for changes (each waits for a person, or for the business's rule). C5 — nexus.run
 * lets the business's rules run a change Claude asked for without a person (the tools a business set to auto): without
 * it every change waits for a person, whatever the level. A token only ever narrows what the person's role allows.
 */
export const MCP_SCOPES = ['nexus.read', 'nexus.write', 'nexus.run'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export const ACCESS_TOKEN_SECONDS = 3600
export const REFRESH_TOKEN_SECONDS = 30 * 24 * 3600
export const CODE_SECONDS = 60
/** W4-3 — how long after its first use the same app may present a refresh token again (a lost answer, two at once). */
export const REFRESH_GRACE_SECONDS = 120

/** Where Claude's hosted apps (web, Desktop, mobile, Cowork) return after sign-in. */
const HOSTED_CALLBACKS = ['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback']
/** Claude Code: a loopback callback on a port that changes every session (RFC 8252). */
const LOOPBACK_CALLBACKS = ['http://localhost/callback', 'http://127.0.0.1/callback']

const list = (value: string | undefined) =>
  (value ?? '').split(',').map((part) => part.trim()).filter(Boolean)

const withoutTrailingSlash = (url: string) => url.replace(/\/+$/, '')

export function mcpEnabled(): boolean {
  return process.env.NEXUS_MCP_ENABLED === '1'
}

/** The issuer: the web app, where a person signs in and consents. */
export function oauthIssuer(): string {
  const issuer = process.env.NEXUS_OAUTH_ISSUER?.trim()
  if (!issuer) throw new Error('NEXUS_OAUTH_ISSUER is not set (the web app origin, e.g. https://…railway.app)')
  const url = new URL(issuer)
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('NEXUS_OAUTH_ISSUER must be https')
  }
  return withoutTrailingSlash(url.origin)
}

/** The API origin that serves the token, registration and revocation endpoints. */
export function oauthApiOrigin(): string {
  const configured = process.env.NEXUS_OAUTH_API_ORIGIN?.trim()
  if (configured) return withoutTrailingSlash(configured)
  const derived = publicApiOrigin()
  if ('error' in derived) throw new Error(`the API's public origin is unknown: ${derived.error}`)
  return withoutTrailingSlash(derived.origin)
}

/** The canonical MCP URL. A token is issued for it, or for one business's URL under it (`mcpResourceFor`). */
export function mcpResource(): string {
  return withoutTrailingSlash(process.env.NEXUS_MCP_RESOURCE?.trim() || `${oauthApiOrigin()}/mcp`)
}

/** C4 — a business id as a business's MCP URL may carry it (the shape the workspace hook accepts, any length). */
const BUSINESS_ID = /^[A-Za-z0-9_-]{1,100}$/

export function isMcpBusinessId(value: string): boolean {
  return BUSINESS_ID.test(value)
}

/**
 * MCP full control C4 (D2 = A) — one connection per business: the business's own MCP URL, `<mcp>/w/<business id>`.
 * A token issued for it works there and nowhere else, and only for that business; the plain URL keeps working.
 */
export function mcpResourceFor(workspaceId: string): string {
  return `${mcpResource()}/w/${workspaceId}`
}

/**
 * C4 — which of our MCP URLs a `resource` is: the plain one (`workspaceId: null`) or one business's (its id). Null when
 * it is not one of ours. A trailing slash is the same URL.
 */
export function mcpResourceTarget(resource: string): { resource: string; workspaceId: string | null } | null {
  const value = withoutTrailingSlash(resource)
  const plain = mcpResource()
  if (value === plain) return { resource: plain, workspaceId: null }
  const prefix = `${plain}/w/`
  if (!value.startsWith(prefix)) return null
  const id = value.slice(prefix.length)
  return isMcpBusinessId(id) ? { resource: value, workspaceId: id } : null
}

/** Businesses allowed to connect Claude, when the rollout names them. Null = every business. */
export function mcpWorkspaceAllowList(): Set<string> | null {
  const ids = list(process.env.NEXUS_MCP_WORKSPACES)
  return ids.length ? new Set(ids) : null
}

/** C4 — may a business's own MCP URL be served at all: a well-formed id inside the allow-list (the outer ceiling). */
export function mcpBusinessUrlAllowed(workspaceId: string): boolean {
  const allow = mcpWorkspaceAllowList()
  return isMcpBusinessId(workspaceId) && (!allow || allow.has(workspaceId))
}

/** Hosts a Client ID Metadata Document may live on. */
export function cimdHosts(): Set<string> {
  const hosts = list(process.env.NEXUS_OAUTH_CIMD_HOSTS)
  return new Set(hosts.length ? hosts : ['claude.ai', 'claude.com'])
}

/** Redirect URIs a client may register: Claude's, plus any the Owner adds. */
export function allowedRedirectUris(): string[] {
  return [...HOSTED_CALLBACKS, ...LOOPBACK_CALLBACKS, ...list(process.env.NEXUS_OAUTH_REDIRECT_URIS)]
}

function isLoopback(url: URL): boolean {
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}

/**
 * Does `candidate` match `registered`? Exactly — except a loopback registration, which matches
 * the same scheme, host and path on any port (RFC 8252 §7.3; Claude Code picks a new port per run).
 */
export function redirectMatches(registered: string, candidate: string): boolean {
  if (registered === candidate) return true
  let a: URL
  let b: URL
  try {
    a = new URL(registered)
    b = new URL(candidate)
  } catch {
    return false
  }
  if (!isLoopback(a) || !isLoopback(b)) return false
  return a.hostname === b.hostname && a.pathname === b.pathname && !b.search && !b.hash && !b.username && !b.password
}

/** May a client register this redirect URI at all? */
export function redirectUriAllowed(candidate: string): boolean {
  return allowedRedirectUris().some((allowed) => redirectMatches(allowed, candidate))
}

/** RFC 8414 authorization server metadata, served at the issuer's /.well-known path. */
export function authorizationServerMetadata(): Record<string, unknown> {
  const issuer = oauthIssuer()
  const api = oauthApiOrigin()
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${api}/api/oauth/token`,
    registration_endpoint: `${api}/api/oauth/register`,
    revocation_endpoint: `${api}/api/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  }
}

/** Parse a space-separated scope string into known scopes. Unknown ones are dropped; none = all. */
export function parseScopes(raw: unknown): McpScope[] {
  if (typeof raw !== 'string' || !raw.trim()) return [...MCP_SCOPES]
  const asked = new Set(raw.trim().split(/\s+/))
  return MCP_SCOPES.filter((scope) => asked.has(scope))
}
