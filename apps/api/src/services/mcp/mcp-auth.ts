/**
 * MCP.7 — who is calling /mcp, from the Bearer token alone.
 *
 * The access token (services/oauth) names the person, the business and the Claude connection;
 * `verifyAccessToken` re-checks all three on every call. Nothing else on the request may name a
 * business. A missing or bad token gets 401 with the challenge that tells Claude where to sign in:
 * RFC 6750's WWW-Authenticate carrying RFC 9728's `resource_metadata`.
 *
 * MCP full control C4 — one connection per business: besides the plain URL, each business has its own MCP URL
 * (`/mcp/w/<business id>`) with its own RFC 9728 document. A token works only at the URL it was issued for, and a
 * business's URL only for that business, so Claude shows one server per business ("Nexus — Xavia Racing").
 */

import { getOAuthProtectedResourceMetadataUrl, type AuthInfo } from '@modelcontextprotocol/server'
import type { UserPrincipal } from '../agents/call-tool.js'
import {
  MCP_SCOPES,
  mcpBusinessUrlAllowed,
  mcpResource,
  mcpResourceFor,
  oauthApiOrigin,
  oauthIssuer,
  type McpScope,
} from '../oauth/oauth-config.js'
import { verifyAccessToken } from '../oauth/oauth-server.js'

/** C3 — the argument every change tool takes over MCP: the business's name, checked by the door, never passed on. */
export const BUSINESS_ARGUMENT = 'business'

/** C3 — the business a connection works in, as Claude is told it: its id and its name now. */
export interface McpBusiness {
  id: string
  name: string
}

/** A person who came in through Claude: always in one verified business, over one connection. */
export type McpPrincipal = UserPrincipal & {
  workspace: NonNullable<UserPrincipal['workspace']>
  oauthGrantId: string
  /** C3 — the token's business (the same as `workspace`), named: every result carries it, every change checks it. */
  business: McpBusiness
  /** C5 — what the connection allows (OAuth scopes). Without nexus.run every change waits for a person. Absent = none. */
  scopes?: readonly McpScope[]
}

/** The person behind one /mcp request, and what their connection allows. */
export interface McpCaller {
  principal: McpPrincipal
  scopes: McpScope[]
  /** What the MCP SDK carries to the per-request server: the scopes, and the principal in `extra`. */
  authInfo: AuthInfo
}

/** Why a request was refused: 401, the challenge, and an OAuth-style body. */
export interface McpRefusal {
  status: 401
  challenge: string
  body: { error: string; error_description: string }
}

export type McpAuthResult = { caller: McpCaller } | { refusal: McpRefusal }

const PRINCIPAL = 'nexusPrincipal'

/** RFC 9728 §3.1: the well-known segment goes between the host and the resource's path. */
export function protectedResourceMetadataUrl(resource: string = mcpResource()): string {
  return getOAuthProtectedResourceMetadataUrl(new URL(resource))
}

/** The RFC 9728 document of one MCP URL: it, and the one authorization server that issues its tokens. */
export function protectedResourceMetadata(resource: string = mcpResource()): Record<string, unknown> {
  return {
    resource,
    authorization_servers: [oauthIssuer()],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
  }
}

/**
 * The MCP URL whose protected-resource document is at this path, or null: the plain URL's (path-aware, RFC 9728, or
 * at the origin's root), or (C4) one business's, while its id is well formed and inside the allow-list.
 */
export function metadataResourceOf(path: string): string | null {
  const plain = new URL(protectedResourceMetadataUrl()).pathname
  if (path === '/.well-known/oauth-protected-resource' || path === plain) return mcpResource()
  const prefix = `${plain}/w/`
  if (!path.startsWith(prefix)) return null
  const id = path.slice(prefix.length)
  return mcpBusinessUrlAllowed(id) ? mcpResourceFor(id) : null
}

const quoted = (value: string) => `"${value.replace(/[\\"]/g, '\\$&')}"`

/**
 * An RFC 6750 challenge. Without credentials it carries no error code (§3.1); with a bad token it
 * says `invalid_token`; a call beyond the token's scopes says `insufficient_scope` (MCP step-up).
 */
export function bearerChallenge(error?: { code: string; description?: string; scope?: string }, resource: string = mcpResource()): string {
  const parts: string[] = []
  if (error) {
    parts.push(`error=${quoted(error.code)}`)
    if (error.description) parts.push(`error_description=${quoted(error.description)}`)
    if (error.scope) parts.push(`scope=${quoted(error.scope)}`)
  }
  parts.push(`resource_metadata=${quoted(protectedResourceMetadataUrl(resource))}`)
  return `Bearer ${parts.join(', ')}`
}

/** Origins a browser may call /mcp from (MCP transport: validate Origin). Hostnames, any port. */
export function mcpAllowedOriginHosts(): string[] {
  const hosts = new Set([oauthIssuer(), oauthApiOrigin(), mcpResource()].map((url) => new URL(url).hostname))
  for (const host of (process.env.NEXUS_MCP_ALLOWED_ORIGINS ?? '').split(',')) {
    if (host.trim()) hosts.add(host.trim())
  }
  return [...hosts]
}

/** Authenticate one request from its Authorization header, at the MCP URL it came to (C4: plain, or a business's). */
export async function authenticateMcp(authorization: string | undefined, resource: string = mcpResource()): Promise<McpAuthResult> {
  const raw = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1]
  if (!raw) {
    return {
      refusal: {
        status: 401,
        challenge: bearerChallenge(undefined, resource),
        body: { error: 'unauthorized', error_description: 'Connect Claude to Nexus to use this server.' },
      },
    }
  }
  const access = await verifyAccessToken(raw, resource)
  if (!access) {
    const description = 'The access token is not valid. Sign in to Nexus again.'
    return {
      refusal: {
        status: 401,
        challenge: bearerChallenge({ code: 'invalid_token', description }, resource),
        body: { error: 'invalid_token', error_description: description },
      },
    }
  }
  const principal: McpPrincipal = {
    kind: 'user',
    userId: access.userId,
    label: access.label,
    permissions: access.permissions,
    workspace: access.workspace,
    business: { id: access.workspace.workspaceId, name: access.workspaceName },
    via: 'claude',
    oauthGrantId: access.grantId,
    scopes: access.scopes,
  }
  return {
    caller: {
      principal,
      scopes: access.scopes,
      authInfo: {
        token: raw,
        clientId: access.clientName,
        scopes: [...access.scopes],
        resource: new URL(resource),
        // The SDK's scope challenges advertise the same document as the 401s above.
        resourceMetadataUrl: protectedResourceMetadataUrl(resource),
        extra: { [PRINCIPAL]: principal },
      },
    },
  }
}

/** The principal `authenticateMcp` put on the SDK's auth info; null if there is none. */
export function principalOf(authInfo: AuthInfo | undefined): McpPrincipal | null {
  const principal = authInfo?.extra?.[PRINCIPAL] as McpPrincipal | undefined
  return principal?.kind === 'user' && principal.via === 'claude' ? principal : null
}
