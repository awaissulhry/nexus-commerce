import { AsyncLocalStorage } from 'node:async_hooks';
const storage = new AsyncLocalStorage();
export const LEGACY_WORKSPACE_ID = 'nexus_legacy_workspace';
/** Rollout fallback is confined to the verified original business. */
export function workspaceIdForQuery() {
    const current = storage.getStore();
    if (current)
        return current.workspaceId;
    if (process.env.NEXUS_WORKSPACES_ENABLED !== '1')
        return LEGACY_WORKSPACE_ID;
    return requireWorkspace().workspaceId;
}
export function workspaceKey(key) {
    // Server-rendered callers construct selectors before their asynchronous request
    // context resolves. scopedPrisma completes and verifies them at query execution.
    const current = storage.getStore();
    return (current ? { ...key, workspaceId: current.workspaceId } : key);
}
export class WorkspaceError extends Error {
    code;
    statusCode;
    constructor(code, message, statusCode = 403) {
        super(message);
        this.code = code;
        this.statusCode = statusCode;
        this.name = 'WorkspaceError';
    }
}
export function workspaceContext() {
    return storage.getStore();
}
export function requireWorkspace() {
    const context = storage.getStore();
    if (!context)
        throw new WorkspaceError('workspace_required', 'Select a business profile.', 400);
    return context;
}
export function withWorkspace(context, work) {
    return storage.run(Object.freeze({ ...context, roleKeys: Object.freeze([...context.roleKeys]) }), work);
}
/** Capture when scheduling work. A later browser selection cannot retarget it. */
export function captureWorkspace() {
    const captured = requireWorkspace();
    return (work) => withWorkspace(captured, work);
}
export function workspaceCacheKey(key) {
    return `workspace:${requireWorkspace().workspaceId}:${key}`;
}
