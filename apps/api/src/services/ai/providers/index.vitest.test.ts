/**
 * NAF.A2 — provider registry, with the regression that the whole "no
 * behaviour change when the local provider is unconfigured" claim rests on:
 * `getProvider()`'s step-3 fallback returns the first CONFIGURED provider in
 * registry iteration order, so appending `local` last must leave a machine
 * with cloud keys resolving exactly as it did before.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getProvider, isValidProviderName, listProviders } from './index.js'

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NEXUS_LOCAL_AI_BASE_URL',
  'NEXUS_LOCAL_AI_MODEL',
  'AI_PROVIDER',
  'NEXUS_AI_KILL_SWITCH',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('isValidProviderName', () => {
  it('accepts the three registered providers and nothing else', () => {
    expect(isValidProviderName('gemini')).toBe(true)
    expect(isValidProviderName('anthropic')).toBe(true)
    expect(isValidProviderName('local')).toBe(true)
    expect(isValidProviderName('openai')).toBe(false)
    expect(isValidProviderName('')).toBe(false)
  })
})

describe('getProvider — registry order is behaviour', () => {
  it('REGRESSION: a cloud key still wins the first-configured fallback when local is also configured', () => {
    process.env.GEMINI_API_KEY = 'g'
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect(getProvider()?.name).toBe('gemini')
  })

  it('REGRESSION: with Anthropic and local both configured, Anthropic still wins', () => {
    process.env.ANTHROPIC_API_KEY = 'a'
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect(getProvider()?.name).toBe('anthropic')
  })

  it('falls back to local only when it is the sole configured provider', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect(getProvider()?.name).toBe('local')
  })

  it('honours an explicit request for local', () => {
    process.env.GEMINI_API_KEY = 'g'
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect(getProvider('local')?.name).toBe('local')
    expect(getProvider(' LOCAL ')?.name).toBe('local')
  })

  it('ignores an explicit request for local when it is not configured', () => {
    process.env.GEMINI_API_KEY = 'g'
    expect(getProvider('local')?.name).toBe('gemini')
  })

  it('honours AI_PROVIDER=local', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    process.env.AI_PROVIDER = 'local'
    expect(getProvider()?.name).toBe('local')
  })

  it('returns null with nothing configured', () => {
    expect(getProvider()).toBeNull()
  })

  it('the kill switch still fails closed over a configured local provider', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    process.env.NEXUS_AI_KILL_SWITCH = '1'
    expect(getProvider()).toBeNull()
    expect(getProvider('local')).toBeNull()
  })
})

describe('listProviders', () => {
  it('reports local with its configured flag and default model', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    process.env.NEXUS_LOCAL_AI_MODEL = 'qwen3-14b'
    const row = listProviders().providers.find((p) => p.name === 'local')
    expect(row).toEqual({
      name: 'local',
      configured: true,
      defaultModel: 'qwen3-14b',
    })
  })

  it('reports local as unconfigured when no base URL is set', () => {
    const row = listProviders().providers.find((p) => p.name === 'local')
    expect(row?.configured).toBe(false)
  })
})
