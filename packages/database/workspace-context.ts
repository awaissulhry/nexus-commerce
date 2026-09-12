import { AsyncLocalStorage } from 'node:async_hooks'

export interface WorkspaceContext {
  workspaceId: string
  actorUserId: string | null
  membershipId: string | null
  membershipVersion?: number
  sessionId?: string
  apiKeyId?: string
  roleKeys: readonly string[]
}

const storage = new AsyncLocalStorage<WorkspaceContext>()

export const LEGACY_WORKSPACE_ID = 'nexus_legacy_workspace'

/** Rollout fallback is confined to the verified original business. */
export function workspaceIdForQuery(): string {
  const current = storage.getStore()
  if (current) return current.workspaceId
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1') return LEGACY_WORKSPACE_ID
  return requireWorkspace().workspaceId
}

export function workspaceKey<T extends object>(key: T): T & { workspaceId: string } {
  // Server-rendered callers construct selectors before their asynchronous request
  // context resolves. scopedPrisma completes and verifies them at query execution.
  const current = storage.getStore()
  return (current ? { ...key, workspaceId: current.workspaceId } : key) as T & { workspaceId: string }
}

export class WorkspaceError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 403) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export function workspaceContext(): WorkspaceContext | undefined {
  return storage.getStore()
}

export function requireWorkspace(): WorkspaceContext {
  const context = storage.getStore()
  if (!context) throw new WorkspaceError('workspace_required', 'Select a business profile.', 400)
  return context
}

export function withWorkspace<T>(context: WorkspaceContext, work: () => T): T {
  return storage.run(Object.freeze({ ...context, roleKeys: Object.freeze([...context.roleKeys]) }), work)
}

/** Capture when scheduling work. A later browser selection cannot retarget it. */
export function captureWorkspace() {
  const captured = requireWorkspace()
  return <T>(work: () => T): T => withWorkspace(captured, work)
}

export function workspaceCacheKey(key: string): string {
  return `workspace:${requireWorkspace().workspaceId}:${key}`
}
