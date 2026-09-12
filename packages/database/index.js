import { Pool } from 'pg';
import { workspacePrisma } from './workspace-router.js';
export * from '@prisma/client';
const globalForPrisma = global;
// Serverless-safe pool config:
// - max:1 avoids exhausting Neon's connection limit per cold-start invocation
// - connectionTimeoutMillis:30000 gives Neon time to wake from suspension (free tier ~3-5s)
// - idleTimeoutMillis:10000 releases connections quickly after use
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
});
export const prisma = globalForPrisma.workspacePrisma ||
    workspacePrisma(pool);
if (process.env.NODE_ENV !== 'production')
    globalForPrisma.workspacePrisma = prisma;
export default prisma;
