/**
 * MCP.1 — the one door every agent tool runs through.
 *
 * The in-app assistant, the approval gate, the fleet and the MCP endpoint all
 * reach a tool's `handler` or `execute` through this file and nowhere else
 * (call-tool-guard.vitest.test.ts holds that). For a person it:
 *
 *   1. refuses unless they hold `ai.run` and every permission in the tool's
 *      `requires` — resolved for the business they are acting in;
 *   2. runs the tool inside THEIR business, taken from the principal and never
 *      from a header, and refuses when a different business is already bound;
 *   3. hands back a copy without the money fields they may not see. The raw
 *      result stays with a caller that must store it: an approval keeps the
 *      raw preview, and each reader of that row is filtered when it is read.
 *
 * A system principal (crons, the fleet, the re-check of an approval a person
 * already decided) skips 1 and 3. It is built in-process only, never from a
 * request.
 */

import type { FastifyRequest } from 'fastify'
import { FEATURES } from '@nexus/shared/permissions'
import { ensureLoaded } from '../../lib/auth/guards.js'
import { resolvePermissions, type ResolvedPermissions } from '../../lib/auth/rbac.js'
import { financialPayloadCopy } from '../../lib/auth/field-filter.js'
import { withAuthenticatedUser } from '../../lib/auth/identity-context.js'
import {
  withWorkspace,
  workspaceContext,
  type WorkspaceContext,
} from '../../lib/workspace-context.js'
import { getTool, listTools } from './tool-registry.js'
import type { AgentTool, ToolResult } from './tool-types.js'

/** Which front door a person came through — recorded, never trusted for access. */
export type ToolVia = 'app' | 'claude'

export interface UserPrincipal {
  kind: 'user'
  userId: string
  /** Stored and shown as the decider: a name if there is one, never a bare id. */
  label: string
  permissions: ResolvedPermissions
  /** The verified business. Absent only while business profiles are off. */
  workspace?: WorkspaceContext
  via: ToolVia
}

export interface SystemPrincipal {
  kind: 'system'
  label: string
  userId: null
}

export type ToolPrincipal = UserPrincipal | SystemPrincipal

/** Every tool call by a person also needs this: the gate the assistant's own routes use. */
export const TOOL_BASE_PERMISSION = FEATURES.aiRun

export class ToolAccessError extends Error {
  constructor(
    readonly code: 'unknown_tool' | 'forbidden' | 'workspace_required' | 'workspace_mismatch',
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ToolAccessError'
  }
}

export interface ToolCall {
  tool: AgentTool
  /** Exactly what the tool returned. Store it; never hand it to a person. */
  raw: ToolResult
  /** What this principal may see. */
  visible: ToolResult
}

/** For in-process callers only: crons, the fleet, re-checks of a decision a person already took. */
export function systemPrincipal(label: string): SystemPrincipal {
  return { kind: 'system', label, userId: null }
}

/** What a decision is stored under: a display name, then the email, then the id. */
export function actorLabel(user?: { id?: string; email?: string; displayName?: string }): string {
  if (!user?.id) return 'unattributed'
  return user.displayName?.trim() || user.email || user.id
}

/**
 * The signed-in person behind a request, with the permissions already resolved
 * for the business the workspace hook verified. An API key has no person and
 * is refused: attribution never falls back to a shared or caller-supplied user.
 */
export async function requestPrincipal(
  request: FastifyRequest,
  via: ToolVia = 'app',
): Promise<UserPrincipal> {
  await ensureLoaded(request)
  const user = request.authUser
  if (!user?.id) {
    throw new ToolAccessError('forbidden', 'A signed-in user is required to use the assistant.', 403)
  }
  const permissions = request.__rbacResolved ?? (await resolvePermissions(user))
  request.__rbacResolved = permissions
  return {
    kind: 'user',
    userId: user.id,
    label: actorLabel(user),
    permissions,
    workspace: request.workspace,
    via,
  }
}

/** The permissions this principal lacks for the tool, `ai.run` first. Empty means allowed. */
export function missingPermissions(
  principal: ToolPrincipal,
  tool: Pick<AgentTool, 'requires'>,
): string[] {
  if (principal.kind === 'system' || principal.permissions.isOwner) return []
  const held = principal.permissions.permissions
  const missing: string[] = []
  if (!held.has(TOOL_BASE_PERMISSION)) missing.push(TOOL_BASE_PERMISSION)
  for (const permission of tool.requires) if (!held.has(permission)) missing.push(permission)
  return missing
}

/** The tools this principal may call — the only ones a model is offered. */
export function toolsFor(principal: ToolPrincipal): AgentTool[] {
  return listTools().filter((tool) => missingPermissions(principal, tool).length === 0)
}

/** Names of the tools this principal may approve; null when there is no limit. */
export function approvableToolNames(principal: ToolPrincipal): string[] | null {
  if (principal.kind === 'system' || principal.permissions.isOwner) return null
  return toolsFor(principal).map((tool) => tool.name)
}

export function permissionMessage(toolName: string, missing: readonly string[]): string {
  return `${toolName} needs the ${missing.join(' and ')} permission${missing.length > 1 ? 's' : ''}.`
}

function allowedTool(principal: ToolPrincipal, name: string): AgentTool {
  const tool = getTool(name)
  if (!tool) throw new ToolAccessError('unknown_tool', `unknown tool: ${name}`, 404)
  const missing = missingPermissions(principal, tool)
  if (missing.length > 0) throw new ToolAccessError('forbidden', permissionMessage(name, missing), 403)
  return tool
}

/** Run as the principal: in their business and under their identity. */
function asPrincipal<T>(principal: ToolPrincipal, work: () => Promise<T>): Promise<T> {
  if (principal.kind === 'system') return work()
  const workspace = principal.workspace
  if (workspace) {
    const bound = workspaceContext()
    if (bound && bound.workspaceId !== workspace.workspaceId) {
      throw new ToolAccessError('workspace_mismatch', 'This request is bound to a different business profile.', 403)
    }
    return withAuthenticatedUser(principal.userId, () => withWorkspace(workspace, work))
  }
  if (process.env.NEXUS_WORKSPACES_ENABLED === '1') {
    throw new ToolAccessError('workspace_required', 'Select a business profile.', 400)
  }
  return withAuthenticatedUser(principal.userId, work)
}

/** What the principal may see of a tool's output. Owners and money-cleared users get it as it is. */
export function visibleTo<T>(principal: ToolPrincipal, tool: Pick<AgentTool, 'restrictedFields'>, value: T): T {
  if (principal.kind === 'system') return value
  return financialPayloadCopy(value, principal.permissions, tool.restrictedFields)
}

/** The dry run: a tool's `handler`. It never changes anything. */
export async function callTool(
  principal: ToolPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const tool = allowedTool(principal, name)
  const raw = await asPrincipal(principal, () =>
    tool.handler(args, { userId: principal.kind === 'user' ? principal.userId : null }),
  )
  return { tool, raw, visible: visibleTo(principal, tool, raw) }
}

/**
 * The real action: a tool's `execute`. Only the approval gate calls this, after
 * a decision. A system principal here is the sweep running a decision a person
 * took earlier; its label is that person's, so the write keeps their name.
 */
export async function executeTool(
  principal: ToolPrincipal,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolCall> {
  const tool = allowedTool(principal, name)
  const execute = tool.execute
  if (!execute) throw new ToolAccessError('unknown_tool', `${name} is preview-only and cannot run`, 400)
  const raw = await asPrincipal(principal, () =>
    execute(args, { userId: principal.kind === 'user' ? principal.userId : principal.label }),
  )
  return { tool, raw, visible: visibleTo(principal, tool, raw) }
}
