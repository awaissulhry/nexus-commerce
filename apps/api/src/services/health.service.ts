import prisma from '../db.js'
import { readFileSync } from 'node:fs'

/** CLI uploads carry their source revision; native GitHub deployments supply it. */
export function servingBuild(): string {
  let sha = process.env.RAILWAY_GIT_COMMIT_SHA ?? ''
  try {
    const uploaded = readFileSync(new URL('../../.release-sha', import.meta.url), 'utf8').trim()
    if (/^[a-f0-9]{40}$/.test(uploaded)) sha = uploaded
  } catch { /* Native deployment or local development has no upload marker. */ }
  return sha.slice(0, 8) || 'unknown'
}

/** The cutover probe checks database access without scanning operational history. */
export async function checkDatabaseReadiness(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
}
