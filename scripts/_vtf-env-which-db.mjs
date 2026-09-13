/**
 * VT.F — WHICH database does an `apps/api` vitest run resolve to, by CWD? Env read only: this file makes
 * NO connection and imports no prisma client. `reference_which_database_is_this_api_on`, from the other end.
 */
import { resolve } from 'node:path'
import { config } from 'dotenv'
const host = (u) => { try { return new URL(u).host } catch { return '(unparseable)' } }
const show = (label, cwd) => {
  const env = {}
  /* Exactly what apps/api/src/env.ts does, in its order, non-overriding. */
  config({ path: resolve(cwd, '.env'), processEnv: env })
  config({ path: resolve('/Users/awais/nexus-commerce', '.env'), processEnv: env })
  console.log(`${label.padEnd(34)} DATABASE_URL host = ${host(env.DATABASE_URL ?? '')}`)
}
show('cwd = apps/api  (how :8091 starts)', '/Users/awais/nexus-commerce/apps/api')
show('cwd = repo root (how a lane runs vitest)', '/Users/awais/nexus-commerce')
