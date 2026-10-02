/**
 * MCP.7 — the MCP endpoint Claude connects to (services/mcp/*).
 *
 *   POST   /mcp                                        Streamable HTTP, stateless: one exchange per request
 *   GET    /mcp, DELETE /mcp                           405: there is no session to stream from or to end
 *   GET    /.well-known/oauth-protected-resource/mcp   RFC 9728: where Claude signs in (also at the root)
 *
 * PUBLIC in the RBAC manifest, like /api/oauth/*: Claude has no session cookie, so the workspace,
 * RBAC, CSRF and API-key hooks step aside and this route guards itself with the Bearer token. The
 * business comes ONLY from that token: a request that names one (header or query) is refused, not
 * ignored. The person's own permissions, the token's scopes and the one door (call-tool.ts) decide
 * the rest. Everything answers 404 unless NEXUS_MCP_ENABLED=1. HTTP service only.
 *
 * MCP.11 — each connection and each business has a count per minute (services/mcp/mcp-rate.ts);
 * over it, 429 with Retry-After.
 *
 * MCP full control C4 (D2 = A) — one connection per business:
 *
 *   POST   /mcp/w/:workspaceId                                       the same endpoint, at one business's own URL
 *   GET    /.well-known/oauth-protected-resource/mcp/w/:workspaceId  its RFC 9728 document
 *
 * A token is issued for one URL (its `resource`) and works there only: a business's URL refuses a token of the plain
 * URL or of another business (401 with that business's challenge). The path names the business only as the URL the
 * token was issued for: the business still comes from the token, and a header or query naming one is still refused.
 * NEXUS_MCP_WORKSPACES stays the outer allow-list: a business outside it has no URL (404).
 */

import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { originValidation } from '@modelcontextprotocol/fastify'
import { withAuthenticatedUser } from '../lib/auth/identity-context.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { mcpBusinessUrlAllowed, mcpEnabled, mcpResource, mcpResourceFor } from '../services/oauth/oauth-config.js'
import {
  authenticateMcp,
  mcpAllowedOriginHosts,
  metadataResourceOf,
  protectedResourceMetadata,
} from '../services/mcp/mcp-auth.js'
import { takeMcpRequest } from '../services/mcp/mcp-rate.js'
import { createNexusMcpHandler } from '../services/mcp/mcp-server.js'

/** Set by Node for the connection it writes; never copied from the SDK's answer. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'content-length'])
/** Not handed to the SDK: it verifies nothing itself, and has no use for credentials. */
const WITHHELD = new Set(['authorization', 'cookie', 'content-length', 'transfer-encoding', 'connection'])

function jsonRpcError(reply: FastifyReply, status: number, code: number, message: string) {
  return reply.code(status).send({ jsonrpc: '2.0', error: { code, message }, id: null })
}

/** Does the request try to choose a business? Only the token may. */
function namesBusiness(request: FastifyRequest): boolean {
  const query = request.query as Record<string, unknown> | undefined
  return request.headers['x-nexus-workspace-id'] !== undefined || query?.workspaceId !== undefined
}

/** The Fastify request as the web-standard Request the MCP SDK serves. */
function webRequest(request: FastifyRequest, signal: AbortSignal): Request {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || WITHHELD.has(name)) continue
    for (const item of Array.isArray(value) ? value : [value]) headers.append(name, item)
  }
  return new Request(new URL(request.url, mcpResource()), {
    method: request.method,
    headers,
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    signal,
  })
}

/** The SDK's answer, through Fastify's reply (so the API's own headers and hooks still apply). */
async function send(reply: FastifyReply, response: Response) {
  reply.code(response.status)
  response.headers.forEach((value, name) => {
    if (!HOP_BY_HOP.has(name)) reply.header(name, value)
  })
  if (!response.body) return reply.send()
  // A stream is passed through as it is written; any other answer is sent whole.
  if (response.headers.get('content-type')?.startsWith('text/event-stream')) return reply.send(response.body)
  return reply.send(Buffer.from(await response.arrayBuffer()))
}

const mcpRoutes: FastifyPluginAsync = async (fastify) => {
  const handler = createNexusMcpHandler()
  fastify.addHook('onClose', async () => handler.close())

  fastify.addHook('onRequest', async (_request, reply) => {
    if (!mcpEnabled()) return reply.code(404).send({ error: 'Not found' })
  })

  const metadata = async (request: FastifyRequest, reply: FastifyReply) => {
    const resource = metadataResourceOf(request.url.split('?')[0])
    if (!resource) return reply.code(404).send({ error: 'Not found' })
    reply.header('Cache-Control', 'public, max-age=300').header('Access-Control-Allow-Origin', '*')
    return protectedResourceMetadata(resource)
  }
  fastify.get('/.well-known/oauth-protected-resource', metadata)
  fastify.get('/.well-known/oauth-protected-resource/*', metadata)

  // The MCP transport rule: a browser Origin must be one of ours (a missing one is fine).
  const origin = { onRequest: (request: FastifyRequest, reply: FastifyReply) => originValidation(mcpAllowedOriginHosts())(request, reply) }

  /** One MCP exchange at `resource`: the plain URL, or one business's own (C4). */
  const serve = async (request: FastifyRequest, reply: FastifyReply, resource: string) => {
    reply.header('Cache-Control', 'no-store')
    if (namesBusiness(request)) {
      return jsonRpcError(reply, 400, -32600, 'The business comes from your Nexus connection. Do not name one.')
    }
    const auth = await authenticateMcp(request.headers.authorization, resource)
    if ('refusal' in auth) {
      const { status, challenge, body } = auth.refusal
      return reply.code(status).header('WWW-Authenticate', challenge).send(body)
    }
    const { principal, authInfo } = auth.caller

    // MCP.11 — per connection and per business, before anything reaches a tool.
    const rate = await takeMcpRequest({ workspaceId: principal.workspace.workspaceId, grantId: principal.oauthGrantId })
    if (!rate.ok) {
      const who = rate.limitedBy === 'connection' ? 'this Claude connection' : 'this business'
      reply.header('Retry-After', String(rate.retryAfterSec))
      return jsonRpcError(reply, 429, -32000, `Too many requests from ${who} (at most ${rate.limit} a minute). Try again in ${rate.retryAfterSec} s.`)
    }

    // Stops the SDK's work if Claude goes away before the answer is written.
    const aborted = new AbortController()
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) aborted.abort()
    })
    const response = await withAuthenticatedUser(principal.userId, () =>
      withWorkspace(principal.workspace, () =>
        handler.fetch(webRequest(request, aborted.signal), { authInfo, parsedBody: request.body }),
      ),
    )
    return send(reply, response)
  }

  fastify.post('/mcp', origin, (request, reply) => serve(request, reply, mcpResource()))

  // C4 — a business's own URL: its id well formed and inside the allow-list, else there is no such URL.
  fastify.post<{ Params: { workspaceId: string } }>('/mcp/w/:workspaceId', origin, (request, reply) => {
    const { workspaceId } = request.params
    if (!mcpBusinessUrlAllowed(workspaceId)) return reply.code(404).send({ error: 'Not found' })
    return serve(request, reply, mcpResourceFor(workspaceId))
  })

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('Allow', 'POST')
    return jsonRpcError(reply, 405, -32000, 'Method not allowed.')
  }
  fastify.get('/mcp', methodNotAllowed)
  fastify.delete('/mcp', methodNotAllowed)
  fastify.get('/mcp/w/:workspaceId', methodNotAllowed)
  fastify.delete('/mcp/w/:workspaceId', methodNotAllowed)
}

export default mcpRoutes
