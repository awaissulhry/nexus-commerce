import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

// 1. Export the Types/Classes directly from the source
export * from '@prisma/client';

const globalForPrisma = global as unknown as { prisma: PrismaClient };

// 2. Export the pre-configured instance
export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    adapter: new PrismaPg(
      new Pool({
        connectionString: process.env.DATABASE_URL,
        connectionTimeoutMillis: 5000, // Fail fast instead of hanging forever
      })
    ),
    log: ['query'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

export default prisma;
