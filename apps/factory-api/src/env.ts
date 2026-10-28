import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'

/**
 * The factory API's configuration. It reads ONE file, apps/factory-api/.env, by explicit path (src/ and dist/ both sit
 * one level below the workspace), and only variables named FACTORY_…. It never reads the repository root's `.env`: on
 * the Owner's Mac that file holds Commerce's production credentials, and its DATABASE_URL can never be picked up here.
 *
 * Refusals:
 *   - FACTORY_ENV local or test: the database and Redis must be on this machine (loopback);
 *   - FACTORY_ENV staging or production: only on Railway (RAILWAY_ENVIRONMENT set by the platform, never by the file).
 */
export const FACTORY_ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url))

const PREFIX = 'FACTORY_'

export class FactoryEnvError extends Error {
  override name = 'FactoryEnvError'
}

const schema = z.object({
  FACTORY_ENV: z.enum(['local', 'test', 'staging', 'production']),
  FACTORY_DATABASE_URL: z.string().min(1),
  FACTORY_REDIS_URL: z.string().min(1),
  FACTORY_HOST: z.string().min(1).optional(),
  FACTORY_PORT: z.coerce.number().int().min(1).max(65535).default(8190),
})

export type FactoryEnv = Readonly<z.infer<typeof schema> & { FACTORY_HOST: string }>

type Sources = { file?: string; processEnv?: NodeJS.ProcessEnv }

/** FACTORY_ variables from the file, then from the process environment (the process wins, as on Railway). */
export function readFactoryVariables({ file = FACTORY_ENV_FILE, processEnv = process.env }: Sources = {}): Record<
  string,
  string
> {
  const fromFile: Record<string, string | undefined> = existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}
  const variables: Record<string, string> = {}
  for (const source of [fromFile, processEnv]) {
    for (const [key, value] of Object.entries(source)) {
      if (key.startsWith(PREFIX) && value !== undefined) variables[key] = value
    }
  }
  return variables
}

/** Validates the variables and applies the refusals. `railwayEnvironment` comes from the platform, never the file. */
export function parseFactoryEnv(variables: Record<string, string>, railwayEnvironment: string | undefined): FactoryEnv {
  const parsed = schema.safeParse(variables)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    throw new FactoryEnvError(`apps/factory-api configuration is not valid: ${problems.join('; ')}`)
  }
  const env = parsed.data
  const local = env.FACTORY_ENV === 'local' || env.FACTORY_ENV === 'test'
  if (local) {
    for (const key of ['FACTORY_DATABASE_URL', 'FACTORY_REDIS_URL'] as const) {
      if (!isLoopbackUrl(env[key])) {
        throw new FactoryEnvError(
          `${key} points at ${describeUrlHost(env[key])}; with FACTORY_ENV=${env.FACTORY_ENV} only a loopback host is allowed`,
        )
      }
    }
  } else if (railwayEnvironment === undefined || railwayEnvironment === '') {
    throw new FactoryEnvError(
      `FACTORY_ENV=${env.FACTORY_ENV} runs only on Railway (RAILWAY_ENVIRONMENT is not set); use local or test here`,
    )
  }
  return Object.freeze({ ...env, FACTORY_HOST: env.FACTORY_HOST ?? (local ? '127.0.0.1' : '::') })
}

export function loadFactoryEnv(sources: Sources = {}): FactoryEnv {
  const processEnv = sources.processEnv ?? process.env
  return parseFactoryEnv(readFactoryVariables({ ...sources, processEnv }), processEnv.RAILWAY_ENVIRONMENT)
}
