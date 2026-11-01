import { describe, expect, it } from 'vitest'
import { parseFactoryEnv } from '../env'
import { appConfig, rateLimitNamespace } from './app'

// The rate-limit counters' Redis prefix (B-W2b-30): per worktree on the one local Redis, unchanged on Railway.

const LOCAL = {
  FACTORY_ENV: 'local',
  FACTORY_DATABASE_URL: 'postgresql://factory_app@127.0.0.1:5442/factory_w9_01',
  FACTORY_REDIS_URL: 'redis://127.0.0.1:6399',
}
const RAILWAY = {
  FACTORY_ENV: 'production',
  FACTORY_DATABASE_URL: 'postgresql://factory_app:made-up@db.example.com:5432/factory',
  FACTORY_REDIS_URL: 'redis://default:made-up@cache.example.com:6379',
  FACTORY_WEB_ORIGIN: 'https://factory.example.com',
  FACTORY_COOKIE_SECRET: 'a-random-secret-of-at-least-thirty-two-chars',
  FACTORY_PIN_PEPPER: 'a-made-up-pin-pepper-of-at-least-thirty-two-chars',
  FACTORY_KMS_KEY_ID: 'arn:aws:kms:eu-south-1:000000000000:key/00000000-0000-0000-0000-000000000000',
  FACTORY_AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
  FACTORY_AWS_SECRET_ACCESS_KEY: 'not-a-real-secret-access-key-for-tests',
}

describe('the rate-limit namespace', () => {
  it('carries the worktree queue prefix, so two local APIs on one Redis never share a count', () => {
    const one = rateLimitNamespace(appConfig(parseFactoryEnv({ ...LOCAL, FACTORY_QUEUE_PREFIX: 'w2b30' }, undefined)))
    const two = rateLimitNamespace(appConfig(parseFactoryEnv({ ...LOCAL, FACTORY_QUEUE_PREFIX: 'w2b29' }, undefined)))
    expect(one).toBe('w2b30:local:rate-limit:')
    expect(two).toBe('w2b29:local:rate-limit:')
  })

  it('stays factory:<environment>:rate-limit: on Railway, where the prefix defaults to factory', () => {
    expect(rateLimitNamespace(appConfig(parseFactoryEnv(RAILWAY, 'production')))).toBe('factory:production:rate-limit:')
  })

  it('falls back to factory for a config without a prefix (tests that build the config by hand)', () => {
    expect(rateLimitNamespace({ environment: 'test' })).toBe('factory:test:rate-limit:')
  })
})
