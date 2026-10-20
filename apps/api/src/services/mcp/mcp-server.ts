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
 *
 * MCP full control C3 — the business is named everywhere Claude looks: the server's title ("Nexus — Xavia
 * Racing"), its instructions, and every change tool's schema, which gains a REQUIRED `business` argument: the
 * business's name, as a check. The door (mcp-tool-call.ts) refuses a change whose name is not this connection's,
 * and strips the name before the tool runs: it never selects anything. Every result carries `business`.
 *
 * MCP full control C5 — a tool the business turned off for Claude (its trust level `off`) is not offered, and the
 * door refuses it by name. The list is read fresh for each request, in the token's business.
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
import { claudeOffTools } from '../agents/claude-trust.service.js'
import { inputJsonSchema } from '../agents/tool-loop.service.js'
import type { AgentTool } from '../agents/tool-types.js'
import { argumentNames } from '../agents/tool-arguments.js'
import type { McpScope } from '../oauth/oauth-config.js'
import { BUSINESS_ARGUMENT, principalOf, type McpBusiness, type McpPrincipal } from './mcp-auth.js'
import { runToolForClaude } from './mcp-tool-call.js'

let build: string | null = null

/**
 * Claude Code and the claude.ai connector keep only the first 4,096 characters of a server's instructions and cut the
 * rest. Every rule below must reach Claude, so the whole text fits in them, with a business name of 80 characters
 * (mcp-server.vitest.test.ts holds it). What one tool does, reads or needs belongs in that tool's own description, which
 * Claude always gets in full; only rules that cross tools, or that a person or the Owner set, are told here.
 */
export const INSTRUCTIONS_LIMIT = 4096

/**
 * C3 — what Claude is told, naming the one business this connection works in. N3 — it also carries the rules every
 * Nexus skill used to repeat (one copy here instead of 18): read first and ask, one plan for many changes, follow a
 * change to its end, and the never-rules. What a client needs while Nexus is NOT connected stays in the skills.
 */
export function mcpInstructions(business: McpBusiness): string {
  return [
    'Nexus is the back office for selling on Amazon, eBay, Shopify and Etsy.',
    `This connection works in the business "${business.name}" only: every tool reads and changes that business, and`,
    'every result says so (business). The same SKU can exist in another business; never reuse an id, a SKU or an approvalId',
    `read on another connection. Every change tool needs business: "${business.name}" — a check: any other name is refused —`,
    'and so do submit-change-plan, undo-change and confirm-change.',
    'Read business-overview (markets, channel accounts and the exact codes and ids tools take) before naming a market',
    'or an account.',
    'Before any change: tell the person which business it is for, read what is there now, show the plan (what changes',
    'from → to, how many, and where: Nexus only, a marketplace or a buyer), and go on only after a clear yes.',
    'Several changes go in ONE submit-change-plan (up to 200 steps; a bulk tool is one step) or one bulk tool, never a',
    'loop of single requests.',
    'A change tool changes nothing from here: it returns a preview and an approvalId; a person approves it on Nexus\'s',
    'Approvals page (approveAt; it expires at expiresAt), unless the business set that change to run by its rule (status',
    'runs_by_rule): it then runs at runsAt, after a window when a person can stop it (stopAt). You cannot approve',
    'changes, and you cannot change what may run by rule. A change set to "confirm in Claude" is approved by the person who',
    'asked: they read the 6-digit code in their authenticator app; you pass it with confirm-change (approvalId,',
    'planHash, code); never guess, store or reuse a code.',
    'Never say a change ran until approval-status says so, and repeat its meaning; undo-change asks to put a change back.',
    'Never change an Amazon FBA quantity. Never send anyone to the old Amazon or eBay flat-file',
    'pages: edit products in the product sheet, publish from the product studio. When a tool is refused or',
    'off for Claude, pass the reason on in plain words and carry on. In a daily or unattended run read',
    'platform-health-checks first, name every check not ok as a problem, and make no change that rests on a feed',
    'it calls late or failing.',
    'The Amazon ads strategy (ads-strategy) only narrows what this business lets Claude do alone per kind of ad action,',
    'never widens it.',
    'To stop an ad for a while, lower its bids (suppress-campaign, or a lower bid): it serves again about a minute after',
    'they go back. Pause an ad (pause-ads) only when the person means a real pause: it serves again only about an hour after',
    'it is switched on. Archive an ad (archive-ads) only when it is meant for good: Amazon cannot switch an archived',
    'ad on again.',
    'Amazon campaigns are built only with Nexus\'s own builders (apply-ads-playbook, build-sp-wizard-campaigns,',
    'replicate-ad-structure, create-ai-goal-campaigns, create-ad-campaign).',
    'Never by rule, always a person\'s decision: every Google Ads and Merchant Center change (approved in Nexus), a raise of',
    'the ads strategy, a harvest, any change to the ads or bid brain or an hourly plan the brain painted, a copy',
    'of campaigns into another market, and switching on an ad no Claude request paused (enable-ads includePeoplesPauses).',
    'Google checks a Google change first (validate_only), except apply-google-recommendations,',
    'dismiss-google-recommendations, set-google-user-access, set-google-account-links (not an unlink),',
    'set-google-billing (a billing setup), enable-google-pmax-brand-guidelines and set-google-merchant-…: their preview',
    'says so. What can make the account spend more is marked SPENDS MONEY in the preview. A new campaign is always made paused;',
    'enabling anything is set-google-status (SPENDS MONEY); remove-google-… tools delete only what the person asked to',
    'delete. New parts that point at new parts are ONE call (build-google-campaigns, copy-google-campaign,',
    'build-google-pmax, copy-google-pmax, create-google-…-campaign), never steps of a change plan.',
    'Meta changes go through set-meta-… tools; never take a Meta app secret or token in chat.',
  ].join(' ')
}

/** C3 — the server's own name and title, naming the business ("Nexus — Xavia Racing"). */
export function mcpServerInfo(business: McpBusiness): { name: string; title: string; version: string } {
  return { name: 'nexus', title: `Nexus — ${business.name}`, version: (build ??= servingBuild()) }
}


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
 * C3 — the JSON Schema Claude is given: the tool's own (the one the in-app assistant also gets), plus, for a change
 * tool, the required `business` name. N1 — it says no other argument is taken (the door refuses one, naming the
 * argument it likely meant), so Claude knows before it calls.
 */
export function mcpInputSchema(tool: AgentTool, business: McpBusiness): Record<string, unknown> {
  const own: Record<string, unknown> = { ...inputJsonSchema(tool), ...(argumentNames(tool) ? { additionalProperties: false } : {}) }
  if (tool.readOnly) return own
  const properties = (own.properties ?? {}) as Record<string, unknown>
  const required = Array.isArray(own.required) ? (own.required as string[]) : []
  return {
    ...own,
    properties: {
      ...properties,
      [BUSINESS_ARGUMENT]: {
        type: 'string',
        description: `the name of the business this change is for: "${business.name}". A check only — any other name is refused and nothing is queued`,
      },
    },
    required: [...required, BUSINESS_ARGUMENT],
  }
}

/**
 * The tool's schema as the SDK needs it: the JSON Schema Claude is given, and no second
 * validation. call-tool.ts parses every call with the zod schema and words its own refusals.
 */
function doorSchema(tool: AgentTool, business: McpBusiness): StandardSchemaWithJSON<Record<string, unknown>> {
  const schema = mcpInputSchema(tool, business)
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


/** One request's server: the person's tools, and nothing else. C5: minus the tools the business turned off for Claude. */
export function buildMcpServer(principal: McpPrincipal, off: ReadonlySet<string> = new Set()): McpServer {
  const tools = toolsFor(principal).filter((tool) => !off.has(tool.name))
  const server = new McpServer(
    mcpServerInfo(principal.business),
    {
      // Nothing is pushed later: the list changes only with the person's permissions. A person
      // with no tool is not told there are tools (the SDK answers tools/list once one exists).
      capabilities: tools.length > 0 ? { tools: { listChanged: false } } : {},
      instructions: mcpInstructions(principal.business),
    },
  )
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: doorSchema(tool, principal.business),
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
    async ({ authInfo }) => {
      // The route authenticates before this runs; a request without a principal is a bug.
      const principal = principalOf(authInfo)
      if (!principal) throw new Error('MCP request reached the server without an authenticated caller')
      // Inside the route's binding to the token's business: that business's levels only.
      return buildMcpServer(principal, await claudeOffTools())
    },
    {
      onerror: (error) => logger.warn('[mcp] request refused or failed', { error: error.message }),
    },
  )
}
