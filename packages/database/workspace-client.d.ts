import { type PrismaClient } from '@prisma/client';
import { type WorkspaceContext } from './workspace-context.js';
type RecordValue = Record<string, unknown>;
/** Preserve existing named compound selectors while making ownership mandatory. */
export declare function scopeUniqueWhere(model: string, source: RecordValue, workspaceId: string): RecordValue;
export declare function scopeArguments(model: string, operation: string, input: RecordValue, workspaceId: string): RecordValue;
export declare function scopedPrisma(client: PrismaClient, scope?: WorkspaceContext): PrismaClient;
export {};
