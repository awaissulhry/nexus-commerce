import { Pool } from 'pg';
import { workspacePrisma } from './workspace-router.js';
export * from '@prisma/client';
const globalForPrisma = global;
// Serverless callers default to one connection. The long-running API supplies a
// bounded larger pool before this module loads so cron work cannot serialize all requests.
const poolMax = Number(process.env.NEXUS_DATABASE_POOL_MAX ?? '1');
if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 20) {
    throw new Error('NEXUS_DATABASE_POOL_MAX must be an integer between 1 and 20');
}
// Serverless-safe pool config:
// - connectionTimeoutMillis:30000 gives Neon time to wake from suspension (free tier ~3-5s)
// - idleTimeoutMillis:10000 releases connections quickly after use
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: poolMax,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
});
export const prisma = globalForPrisma.workspacePrisma ||
    workspacePrisma(pool);
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.workspacePrisma = prisma;
export default prisma;
