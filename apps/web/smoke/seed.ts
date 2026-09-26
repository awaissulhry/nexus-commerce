import { readFileSync } from 'node:fs'

/** What scripts/ci/seed-smoke.mts wrote. Credentials live only in that file, outside the repo. */
export interface SmokeSeed {
  email: string
  password: string
  workspaces: { a: string; b: string }
  nonce: string
  products: Record<string, { id: string; sku: string; name: string }[]>
}

export function smokeSeed(): SmokeSeed {
  const path = process.env.SMOKE_SEED
  if (!path) throw new Error('SMOKE_SEED is not set — run scripts/ci/seed-smoke.mts and point SMOKE_SEED at its --out file')
  return JSON.parse(readFileSync(path, 'utf8')) as SmokeSeed
}
