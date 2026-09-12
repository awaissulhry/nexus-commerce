import { PrismaClient } from '@prisma/client';
import type { Pool } from 'pg';
/**
 * Fixed-context adapters bridge Prisma's execution resources without ambient mutable state.
 * Engines are bounded and share one pg pool. Evicting an idle engine does not close the pool.
 */
export declare function workspacePrisma(pool: Pool): PrismaClient;
