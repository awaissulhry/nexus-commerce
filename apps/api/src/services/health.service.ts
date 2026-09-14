import prisma from '../db.js'

/** The cutover probe checks database access without scanning operational history. */
export async function checkDatabaseReadiness(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
}
