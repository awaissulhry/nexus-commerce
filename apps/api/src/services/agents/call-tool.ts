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
 *
 * MCP.7 — a person is offered, and may call, only the tools of their door's
 * surface (`AgentTool.surfaces`): the AI drafts are not offered to Claude.
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
import { takeToolCall } from './tool-rate.js'
import { PLAN_TOOL, type AgentTool, type ToolContext, type ToolDoor, type ToolPermission, type ToolResult, type ToolSurface } from './tool-types.js'

/** Which front door a person came through — recorded, never trusted for access. */
export type ToolVia = 'app' | 'claude'

/** MCP.7 — the surface a person's front door offers tools on. */
export function surfaceOf(via: ToolVia): ToolSurface {
  return via === 'claude' ? 'mcp' : 'app'
}

/** MCP.7 — is the tool offered on this surface? A tool without `surfaces` is offered on all. */
export function offeredOn(tool: Pick<AgentTool, 'surfaces'>, surface: ToolSurface): boolean {
  return !tool.surfaces || tool.surfaces.includes(surface)
}

export interface UserPrincipal {
  kind: 'user'
  userId: string
  /** Stored and shown as the decider: a name if there is one, never a bare id. */
  label: string
  permissions: ResolvedPermissions
  /** The verified business. Absent only while business profiles are off. */
  workspace?: WorkspaceContext
  via: ToolVia
  /** MCP.4 — the Claude connection (OAuthGrant.id) a 'claude' call came through. */
  oauthGrantId?: string
}

/** What an AgentRun records about the person's front door (AgentRun.via / oauthGrantId). */
export function runOrigin(principal: UserPrincipal): { via: ToolVia; oauthGrantId: string | null } {
  return { via: principal.via, oauthGrantId: principal.oauthGrantId ?? null }
}

export interface SystemPrincipal {
  kind: 'system'
  label: string
  userId: null
  /** C1 — which in-process door: a fleet worker, or anything else (crons, autonomous agents, re-checks). */
  via?: Extract<ToolDoor, 'fleet' | 'system'>
}

export type ToolPrincipal = UserPrincipal | SystemPrincipal

/** Every tool call by a person also needs this: the gate the assistant's own routes use. */
export const TOOL_BASE_PERMISSION = FEATURES.aiRun

export class ToolAccessError extends Error {
  constructor(
    readonly code:
      | 'unknown_tool'
      | 'forbidden'
      | 'workspace_required'
      | 'workspace_mismatch'
      | 'rate_limited'
      | 'invalid_arguments',
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
export function systemPrincipal(label: string, via: Extract<ToolDoor, 'fleet' | 'system'> = 'system'): SystemPrincipal {
  return { kind: 'system', label, userId: null, via }
}

/** C1 — the front door a principal's calls come through (ToolContext.via). */
export function doorOf(principal: ToolPrincipal): ToolDoor {
  return principal.kind === 'user' ? principal.via : (principal.via ?? 'system')
}

/** C1 — ToolContext.can: the principal's permissions in the business the call runs in. A system caller holds all. */
export function canFor(principal: ToolPrincipal): (permission: ToolPermission) => boolean {
  if (principal.kind === 'system' || principal.permissions.isOwner) return () => true
  const held = principal.permissions.permissions
  return (permission) => held.has(permission)
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

/** C6/C7 — tools that mean nothing to a person who may not ask for any change. */
const ONLY_WITH_CHANGES = new Set([PLAN_TOOL, 'confirm-change'])

/**
 * The tools this principal may call — the only ones a model is offered. MCP.7: for a person,
 * only those offered on the surface of their front door.
 */
export function toolsFor(principal: ToolPrincipal): AgentTool[] {
  const offered = listTools().filter(
    (tool) =>
      missingPermissions(principal, tool).length === 0 &&
      (principal.kind === 'system' || offeredOn(tool, surfaceOf(principal.via))),
  )
  // C6/C7 — a change plan, and confirming a change, only to a person who may ask for at least one change.
  const mayChange = offered.some((tool) => !tool.readOnly && !tool.control && !!tool.execute)
  return mayChange ? offered : offered.filter((tool) => !ONLY_WITH_CHANGES.has(tool.name))
}

/**
 * Names of the tools this principal may approve; null when there is no limit. Permissions
 * only: a person approves in Nexus whatever came in through any door.
 */
export function approvableToolNames(principal: ToolPrincipal): string[] | null {
  if (principal.kind === 'system' || principal.permissions.isOwner) return null
  return listTools()
    .filter((tool) => missingPermissions(principal, tool).length === 0)
    .map((tool) => tool.name)
}

export function permissionMessage(toolName: string, missing: readonly string[]): string {
  return `${toolName} needs the ${missing.join(' and ')} permission${missing.length > 1 ? 's' : ''}.`
}

/** The arguments as the tool's schema reads them, or a 400 naming every problem. */
function parsedArgs(tool: AgentTool, args: Record<string, unknown>): Record<string, unknown> {
  const parsed = tool.input.safeParse(args ?? {})
  if (parsed.success) return parsed.data as Record<string, unknown>
  const problems = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'arguments'}: ${issue.message}`)
    .join('; ')
  throw new ToolAccessError('invalid_arguments', `${tool.name} was called wrongly — ${problems}`, 400)
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

export interface CallOptions {
  /**
   * The operator's hourly limit for this tool (AgentTool.rateLimitPerHour).
   * Only a request to USE the tool passes it; a re-check of an approval
   * already taken does not. Counted after the permission and business checks,
   * so a refused call never spends the budget.
   */
  hourlyLimit?: number | null
  /** C1 — the approval this dry run re-checks (the staleness check before an approved change runs). */
  approvalId?: string
}

/** C1 — what `execute` is told about the approval it carries out. */
export interface ExecuteOptions {
  /** The approval being carried out. */
  approvalId?: string
  /** The preview the person approved, raw, as the approval stores it. */
  approvedPreview?: unknown
  /** The door the approved REQUEST came through; the principal's own door when absent. */
  via?: ToolDoor
}

async function withinHourlyLimit(name: string, limit: number | null | undefined): Promise<void> {
  if (limit == null) return
  const verdict = await takeToolCall(name, limit)
  if (verdict.ok) return
  const minutes = Math.max(1, Math.ceil(verdict.retryAfterSec / 60))
  throw new ToolAccessError(
    'rate_limited',
    `${name} is limited to ${limit} call${limit === 1 ? '' : 's'} per hour in this business. Try again in ${minutes} min.`,
    429,
  )
}

/**
 * MCP.7 — output another tool stored (an approval's preview), as this principal may see it:
 * nothing when they may not use that tool, and its money filter when they may.
 */
function storedOutputFor(principal: ToolPrincipal, toolName: string, value: unknown): unknown | null {
  const stored = getTool(toolName)
  if (!stored) return principal.kind === 'system' ? value : null
  if (missingPermissions(principal, stored).length > 0) return null
  return visibleTo(principal, stored, value)
}

/** C8 — what this principal may see of output other tools stored (approvals' previews), as one function. */
export function storedOutputOf(principal: ToolPrincipal): (toolName: string, value: unknown) => unknown | null {
  return (toolName, value) => storedOutputFor(principal, toolName, value)
}

/** The dry run: a tool's `handler`. It never changes anything. */
export async function callTool(
  principal: ToolPrincipal,
  name: string,
  args: Record<string, unknown>,
  options: CallOptions = {},
): Promise<ToolCall> {
  // MCP.7 — a tool not offered on this door does not exist for it (the drafts, over MCP).
  const listed = getTool(name)
  if (listed && principal.kind === 'user' && !offeredOn(listed, surfaceOf(principal.via))) {
    throw new ToolAccessError('unknown_tool', `unknown tool: ${name}`, 404)
  }
  const tool = allowedTool(principal, name)
  const input = parsedArgs(tool, args)
  const context: ToolContext = {
    userId: principal.kind === 'user' ? principal.userId : null,
    storedOutput: (toolName, value) => storedOutputFor(principal, toolName, value),
    can: canFor(principal),
    via: doorOf(principal),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
  }
  const raw = await asPrincipal(principal, async () => {
    await withinHourlyLimit(name, options.hourlyLimit)
    return tool.handler(input, context)
  })
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
  options: ExecuteOptions = {},
): Promise<ToolCall> {
  const tool = allowedTool(principal, name)
  const execute = tool.execute
  if (!execute) throw new ToolAccessError('unknown_tool', `${name} is preview-only and cannot run`, 400)
  // Stored arguments are parsed again: what runs is exactly what the schema allows today.
  const input = parsedArgs(tool, args)
  const context: ToolContext = {
    userId: principal.kind === 'user' ? principal.userId : principal.label,
    storedOutput: (toolName, value) => storedOutputFor(principal, toolName, value),
    can: canFor(principal),
    via: options.via ?? doorOf(principal),
    ...(options.approvalId ? { approvalId: options.approvalId } : {}),
    ...(options.approvedPreview !== undefined ? { approvedPreview: options.approvedPreview } : {}),
  }
  const raw = await asPrincipal(principal, () => execute(input, context))
  return { tool, raw, visible: visibleTo(principal, tool, raw) }
}
