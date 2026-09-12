export interface WorkspaceContext {
    workspaceId: string;
    actorUserId: string | null;
    membershipId: string | null;
    membershipVersion?: number;
    sessionId?: string;
    apiKeyId?: string;
    roleKeys: readonly string[];
}
export declare const LEGACY_WORKSPACE_ID = "nexus_legacy_workspace";
/** Rollout fallback is confined to the verified original business. */
export declare function workspaceIdForQuery(): string;
export declare function workspaceKey<T extends object>(key: T): T & {
    workspaceId: string;
};
export declare class WorkspaceError extends Error {
    readonly code: string;
    readonly statusCode: number;
    constructor(code: string, message: string, statusCode?: number);
}
export declare function workspaceContext(): WorkspaceContext | undefined;
export declare function requireWorkspace(): WorkspaceContext;
export declare function withWorkspace<T>(context: WorkspaceContext, work: () => T): T;
/** Capture when scheduling work. A later browser selection cannot retarget it. */
export declare function captureWorkspace(): <T>(work: () => T) => T;
export declare function workspaceCacheKey(key: string): string;
