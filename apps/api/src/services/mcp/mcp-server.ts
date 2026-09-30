/**
 * MCP.7 — the MCP server Claude talks to, built fresh for each request (stateless: any API
 * replica can answer any request, and no session outlives it).
 *
 *   tools/list   the tools this person may call over MCP: `toolsFor` (their permissions, and
 *                the 'mcp' surface, so no AI draft). Each one carries its title, annotations
 *                computed from the tool itself, and the same JSON Schema the in-app assistant
 *                is given (tool-loop.service.ts `inputJsonSchema`).
 *   tools/call   through `runToolForClaude` → the gate → `callTool`. The arguments are parsed
 *                there, by the tool's own zod schema, exactly as for the assistant.
 *   scopes       a read-only tool needs `nexus.read`, a change `nexus.write`. A missing scope is
 *                an HTTP 403 insufficient_scope challenge (MCP step-up), answered by the SDK
 *                before the call reaches us. A scope only narrows what the person's role allows.
 *
 * The 2026-07-28 protocol and the 2025 one are both served (the SDK's stateless fallback); GET and
 * DELETE get 405 in the route, because nothing here has a session or a stream to resume.
 */

import {
  createMcpHandler,
  McpServer,
  type McpHttpHandler,
  type ScopeChallengeHandler,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
} from '@modelcontextprotocol/server'
import { logger } from '../../utils/logger.js'
import { servingBuild } from '../health.service.js'
import { toolsFor } from '../agents/call-tool.js'
import { inputJsonSchema } from '../agents/tool-loop.service.js'
import type { AgentTool } from '../agents/tool-types.js'
import type { McpScope } from '../oauth/oauth-config.js'
import { principalOf, type McpPrincipal } from './mcp-auth.js'
import { runToolForClaude } from './mcp-tool-call.js'

const INSTRUCTIONS = [
  'Nexus is the back office for selling on Amazon, eBay, Shopify and Etsy: catalog, listings, stock, orders and advertising.',
  'Every tool works inside the one business this connection was approved for.',
  'Read-only tools answer from Nexus data. A change tool changes nothing from here: it returns a preview and an approvalId,',
  'and a person must approve it in the Nexus Approvals page (the link is in the result). You cannot approve changes.',
  'Use approval-status with the approvalId to see what became of one.',
].join(' ')

/** The scope a tool needs: reading, or asking for a change. */
export function requiredScope(tool: Pick<AgentTool, 'readOnly'>): McpScope {
  return tool.readOnly ? 'nexus.read' : 'nexus.write'
}

/** Annotations from the tool itself, never from configuration. */
export function toolAnnotations(tool: AgentTool): ToolAnnotations {
  return {
    title: tool.title,
    readOnlyHint: tool.readOnly,
    destructiveHint: !tool.readOnly || !!tool.alwaysAsk || tool.riskTier === 'high',
    openWorldHint: !!tool.openWorld,
  }
}

/**
 * The tool's schema as the SDK needs it: the JSON Schema the assistant also gets, and no second
 * validation. call-tool.ts parses every call with the zod schema and words its own refusals.
 */
function doorSchema(tool: AgentTool): StandardSchemaWithJSON<Record<string, unknown>> {
  const schema = inputJsonSchema(tool)
  return {
    '~standard': {
      version: 1,
      vendor: 'nexus',
      validate: (value) => ({ value: (value ?? {}) as Record<string, unknown> }),
      jsonSchema: { input: () => schema, output: () => schema },
    },
  }
}

/** A step-up challenge when the token lacks the tool's scope. */
function scopeChallenge(scope: McpScope): ScopeChallengeHandler {
  return ({ authInfo }) =>
    authInfo && !authInfo.scopes.includes(scope)
      ? { scopes: [scope], errorDescription: `This tool needs the ${scope} scope` }
      : undefined
}

let build: string | null = null

/** One request's server: the person's tools, and nothing else. */
export function buildMcpServer(principal: McpPrincipal): McpServer {
  const tools = toolsFor(principal)
  const server = new McpServer(
    { name: 'nexus', title: 'Nexus Commerce', version: (build ??= servingBuild()) },
    {
      // Nothing is pushed later: the list changes only with the person's permissions. A person
      // with no tool is not told there are tools (the SDK answers tools/list once one exists).
      capabilities: tools.length > 0 ? { tools: { listChanged: false } } : {},
      instructions: INSTRUCTIONS,
    },
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: doorSchema(tool),
        annotations: toolAnnotations(tool),
        scopeChallenge: scopeChallenge(requiredScope(tool)),
      },
      (args) => runToolForClaude(principal, tool, args),
    )
  }
  return server
}

/** The HTTP face of the MCP SDK, created once per API process. */
export function createNexusMcpHandler(): McpHttpHandler {
  return createMcpHandler(
    ({ authInfo }) => {
      // The route authenticates before this runs; a request without a principal is a bug.
      const principal = principalOf(authInfo)
      if (!principal) throw new Error('MCP request reached the server without an authenticated caller')
      return buildMcpServer(principal)
    },
    {
      onerror: (error) => logger.warn('[mcp] request refused or failed', { error: error.message }),
    },
  )
}
