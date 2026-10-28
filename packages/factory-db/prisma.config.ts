import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { defineConfig } from 'prisma/config'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'

// The only env file the Prisma CLI reads here: packages/factory-db/.env, by explicit path. Never the repository root's
// `.env` (on the Owner's Mac it holds production credentials), and only FACTORY_ variables. The process environment
// wins over the file, as on Railway, where the pre-deploy step sets the migration login.
const envFile = fileURLToPath(new URL('./.env', import.meta.url))
const fileVariables: Record<string, string | undefined> = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}

const url =
  process.env.FACTORY_MIGRATION_DATABASE_URL ??
  fileVariables.FACTORY_MIGRATION_DATABASE_URL ??
  process.env.FACTORY_DATABASE_URL ??
  fileVariables.FACTORY_DATABASE_URL

// Off Railway the CLI only ever talks to a database on this machine.
if (url !== undefined && !isLoopbackUrl(url) && !process.env.RAILWAY_ENVIRONMENT) {
  throw new Error(
    `packages/factory-db: refusing ${describeUrlHost(url)}. Off Railway the Prisma CLI runs only against a loopback ` +
      'database (FACTORY_DATABASE_URL in packages/factory-db/.env).',
  )
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  // validate and generate need no database; migrate refuses to run without one.
  ...(url === undefined ? {} : { datasource: { url } }),
})
