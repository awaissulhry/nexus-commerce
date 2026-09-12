import { PrismaPg } from '@prisma/adapter-pg';
import type { Pool } from 'pg';
import { type WorkspaceContext } from './workspace-context.js';
type Adapter = Awaited<ReturnType<PrismaPg['connect']>>;
export type WorkspaceResolver = () => Promise<WorkspaceContext | undefined>;
export declare function registerWorkspaceResolver(next: WorkspaceResolver): void;
export declare function resolveWorkspaceContext(): Promise<WorkspaceContext | undefined>;
/** The same transaction boundary covers ORM queries, nested relations and raw SQL. */
export declare class WorkspacePg extends PrismaPg {
    private readonly scope?;
    constructor(pool: Pool, scope?: WorkspaceContext | undefined);
    connect(): Promise<Adapter>;
}
export {};
