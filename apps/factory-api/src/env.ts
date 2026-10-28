import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import { z } from 'zod'
import { describeUrlHost, isLoopbackUrl } from '@nexus/db-kit/url-guard'

/**
 * The factory API's configuration. It reads ONE file, apps/factory-api/.env, by explicit path (src/ and dist/ both sit
 * one level below the workspace), and only variables named FACTORY_…. It never reads the repository root's `.env`: on
 * the Owner's Mac that file holds Commerce's production credentials, and its DATABASE_URL can never be picked up here.
 *
 * Variables:
 *   FACTORY_ENV               local | test | staging | production
 *   FACTORY_DATABASE_URL      the runtime login `factory_app` (never the owner; openFactoryDatabase audits it at boot)
 *   FACTORY_REDIS_URL         Redis (queues, rate limits, cron locks)
 *   FACTORY_QUEUE_PREFIX      every Redis key of the queues, cron locks and live screens sits under it; required with
 *                             local and test (the local Redis is shared by every worktree: the worktree's step, w0_12),
 *                             `factory` by default on Railway (each environment has its own Redis)
 *   FACTORY_HOST, FACTORY_PORT
 *   FACTORY_WEB_ORIGIN        the factory web's origin, the only one allowed cross-origin (local: http://localhost:3200)
 *   FACTORY_COOKIE_SECRET     signs cookies; local and test fall back to a fixed placeholder
 *   FACTORY_TRUST_PROXY_HOPS  proxies in front of the API whose X-Forwarded-For is trusted (default 0)
 *   FACTORY_SECRETS_MASTER_KEY  local and test only: the master key that wraps the data keys of sealed secrets
 *                             (platform/secrets), 32 random bytes in base64 (`openssl rand -base64 32`); optional (sealing
 *                             and opening fail without it)
 *   FACTORY_KMS_KEY_ID        staging and production only, and required there: the AWS KMS key that wraps them instead
 *   FACTORY_AWS_REGION        default eu-south-1
 *   FACTORY_AWS_ACCESS_KEY_ID, FACTORY_AWS_SECRET_ACCESS_KEY
 *                             staging and production only, and required there: the IAM user for KMS (passed to the AWS
 *                             client explicitly, so it never falls back to a profile or another variable)
 *   FACTORY_LOCAL_FILES_DIR   local and test only: the folder of the local file store (the store of a FAKE R2
 *                             account; platform/files), an absolute path; default a folder under the system's
 *                             temporary directory named after FACTORY_QUEUE_PREFIX
 *
 * Refusals:
 *   - FACTORY_ENV local or test: the database and Redis must be on this machine (loopback), and FACTORY_QUEUE_PREFIX
 *     must be set; no KMS or AWS variable (nothing local reaches AWS);
 *   - FACTORY_ENV staging or production: only on Railway (RAILWAY_ENVIRONMENT set by the platform, never by the file),
 *     with an https web origin, a real cookie secret of at least 32 characters (never the local placeholder), the KMS key
 *     and its AWS keys, no local master key and no local files folder (files are on R2 there).
 */
export const FACTORY_ENV_FILE = fileURLToPath(new URL('../.env', import.meta.url))

const PREFIX = 'FACTORY_'

export class FactoryEnvError extends Error {
  override name = 'FactoryEnvError'
}

/** The cookie secret of local and test runs. Public on purpose: staging and production refuse it. */
export const LOCAL_COOKIE_SECRET = 'factory-local-cookie-secret-not-for-staging-or-production'
const LOCAL_WEB_ORIGIN = 'http://localhost:3200'

/** A queue prefix: 1-32 lower-case letters, digits or underscores, starting with a letter. */
export const QUEUE_PREFIX_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
const RAILWAY_QUEUE_PREFIX = 'factory'

const origin = z.string().refine(
  (value) => {
    try {
      const url = new URL(value)
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value
    } catch {
      return false
    }
  },
  { message: 'must be an origin: scheme, host and optional port, no path or trailing slash' },
)

const schema = z.object({
  FACTORY_ENV: z.enum(['local', 'test', 'staging', 'production']),
  FACTORY_DATABASE_URL: z.string().min(1),
  FACTORY_REDIS_URL: z.string().min(1),
  FACTORY_QUEUE_PREFIX: z
    .string()
    .regex(QUEUE_PREFIX_PATTERN, { message: 'must be 1-32 lower-case letters, digits or underscores, starting with a letter' })
    .optional()
    .or(z.literal('').transform(() => undefined)),
  FACTORY_HOST: z.string().min(1).optional(),
  FACTORY_PORT: z.coerce.number().int().min(1).max(65535).default(8190),
  FACTORY_WEB_ORIGIN: origin.optional(),
  FACTORY_COOKIE_SECRET: z.string().min(1).optional(),
  FACTORY_TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  FACTORY_SECRETS_MASTER_KEY: z
    .string()
    .refine((value) => /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32, {
      message: 'must be 32 random bytes in base64 (openssl rand -base64 32)',
    })
    .optional(),
  FACTORY_KMS_KEY_ID: z.string().min(1).optional(),
  FACTORY_AWS_REGION: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/, { message: 'must be an AWS region such as eu-south-1' }).default('eu-south-1'),
  FACTORY_AWS_ACCESS_KEY_ID: z.string().min(1).optional(),
  FACTORY_AWS_SECRET_ACCESS_KEY: z.string().min(1).optional(),
  FACTORY_LOCAL_FILES_DIR: z.string().refine(isAbsolute, { message: 'must be an absolute path' }).optional(),
})

export type FactoryEnv = Readonly<
  z.infer<typeof schema> & { FACTORY_HOST: string; FACTORY_WEB_ORIGIN: string; FACTORY_COOKIE_SECRET: string; FACTORY_QUEUE_PREFIX: string }
>

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
    if (env.FACTORY_QUEUE_PREFIX === undefined) {
      throw new FactoryEnvError(
        `FACTORY_QUEUE_PREFIX is required with FACTORY_ENV=${env.FACTORY_ENV}: the local Redis is shared by every worktree, so name this worktree's own (e.g. w0_12)`,
      )
    }
    for (const key of ['FACTORY_KMS_KEY_ID', 'FACTORY_AWS_ACCESS_KEY_ID', 'FACTORY_AWS_SECRET_ACCESS_KEY'] as const) {
      if (env[key] !== undefined) {
        throw new FactoryEnvError(`${key} is for staging and production only; with FACTORY_ENV=${env.FACTORY_ENV} secrets use FACTORY_SECRETS_MASTER_KEY`)
      }
    }
  } else if (railwayEnvironment === undefined || railwayEnvironment === '') {
    throw new FactoryEnvError(
      `FACTORY_ENV=${env.FACTORY_ENV} runs only on Railway (RAILWAY_ENVIRONMENT is not set); use local or test here`,
    )
  } else {
    if (env.FACTORY_WEB_ORIGIN === undefined || !env.FACTORY_WEB_ORIGIN.startsWith('https://')) {
      throw new FactoryEnvError(`FACTORY_WEB_ORIGIN must be set to the https origin of the factory web with FACTORY_ENV=${env.FACTORY_ENV}`)
    }
    const secret = env.FACTORY_COOKIE_SECRET
    if (secret === undefined || secret.length < 32 || secret === LOCAL_COOKIE_SECRET) {
      throw new FactoryEnvError(
        `FACTORY_COOKIE_SECRET must be a random secret of at least 32 characters with FACTORY_ENV=${env.FACTORY_ENV} (not the local placeholder)`,
      )
    }
    if (env.FACTORY_SECRETS_MASTER_KEY !== undefined) {
      throw new FactoryEnvError(`FACTORY_SECRETS_MASTER_KEY (a local master key) is refused with FACTORY_ENV=${env.FACTORY_ENV}; secrets are wrapped by AWS KMS there`)
    }
    if (env.FACTORY_LOCAL_FILES_DIR !== undefined) {
      throw new FactoryEnvError(`FACTORY_LOCAL_FILES_DIR (the local file store) is refused with FACTORY_ENV=${env.FACTORY_ENV}; files are on R2 there`)
    }
    for (const key of ['FACTORY_KMS_KEY_ID', 'FACTORY_AWS_ACCESS_KEY_ID', 'FACTORY_AWS_SECRET_ACCESS_KEY'] as const) {
      if (env[key] === undefined) throw new FactoryEnvError(`${key} must be set with FACTORY_ENV=${env.FACTORY_ENV}: secrets are wrapped by AWS KMS there`)
    }
  }
  return Object.freeze({
    ...env,
    FACTORY_HOST: env.FACTORY_HOST ?? (local ? '127.0.0.1' : '::'),
    FACTORY_WEB_ORIGIN: env.FACTORY_WEB_ORIGIN ?? LOCAL_WEB_ORIGIN,
    FACTORY_COOKIE_SECRET: env.FACTORY_COOKIE_SECRET ?? LOCAL_COOKIE_SECRET,
    FACTORY_QUEUE_PREFIX: env.FACTORY_QUEUE_PREFIX ?? RAILWAY_QUEUE_PREFIX,
  })
}

export function loadFactoryEnv(sources: Sources = {}): FactoryEnv {
  const processEnv = sources.processEnv ?? process.env
  return parseFactoryEnv(readFactoryVariables({ ...sources, processEnv }), processEnv.RAILWAY_ENVIRONMENT)
}
