import type { Prisma } from '@prisma/client'
import { workspaceIdForQuery } from '@nexus/database/workspace-context'
/** Shared by tree edits, category memberships, imports, and reviewed channel assignments. */
export async function lockCategoryTree(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`categories:${workspaceIdForQuery()}`}, 0))`
}
