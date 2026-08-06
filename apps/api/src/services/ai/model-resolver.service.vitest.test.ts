/**
 * NAF.A2 — routing named AI feature keys to the local provider.
 *
 * The precedence this file pins down:
 *   kill switch → lockedProvider → explicit per-call request
 *   → NEXUS_LOCAL_AI_FEATURES allowlist → per-feature pref → global pref
 *   → env / first configured
 *
 * The allowlist sits above the DB prefs deliberately and is consulted ONLY
 * when the local provider is configured. That combination is what keeps
 * production untouched: the variable is unset there, so the branch is dead,
 * and no AiFeatureModelPref row has to be written from a laptop whose API
 * talks to the production database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({
  default: {
    aiFeatureModelPref: {
      findMany: vi.fn(async () => []),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}))

import prisma from '../../db.js'
import {
  bustPrefCache,
  getProviderForFeature,
  localFeatureRouting,
  resolveModelForFeature,
} from './model-resolver.service.js'

const findMany = vi.mocked(prisma.aiFeatureModelPref.findMany)

const ENV_KEYS = [
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'NEXUS_LOCAL_AI_BASE_URL',
  'NEXUS_LOCAL_AI_MODEL',
  'NEXUS_LOCAL_AI_FEATURES',
  'AI_PROVIDER',
  'NEXUS_AI_KILL_SWITCH',
] as const
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  vi.clearAllMocks()
  findMany.mockResolvedValue([] as never)
  bustPrefCache()
  // The baseline every test starts from: a cloud key present, so any
  // reroute to local has to be caused by the thing under test.
  process.env.GEMINI_API_KEY = 'g'
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  bustPrefCache()
})

function serveLocal(features: string, model = 'qwen3-14b') {
  process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
  process.env.NEXUS_LOCAL_AI_MODEL = model
  process.env.NEXUS_LOCAL_AI_FEATURES = features
}

describe('localFeatureRouting', () => {
  it('is false when the allowlist is unset', () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect(localFeatureRouting('agent-fleet-analyst')).toBe(false)
  })

  it('is false when the allowlist is set but local is not configured', () => {
    process.env.NEXUS_LOCAL_AI_FEATURES = 'agent-fleet-analyst'
    expect(localFeatureRouting('agent-fleet-analyst')).toBe(false)
  })

  it('matches a listed key and only a listed key', () => {
    serveLocal('agent-fleet-analyst,agent-fleet-critic')
    expect(localFeatureRouting('agent-fleet-analyst')).toBe(true)
    expect(localFeatureRouting('agent-fleet-critic')).toBe(true)
    expect(localFeatureRouting('listing-content')).toBe(false)
  })

  it('tolerates whitespace, casing, and empty entries', () => {
    serveLocal(' Agent-Fleet-Analyst , , listing-content ')
    expect(localFeatureRouting('agent-fleet-analyst')).toBe(true)
    expect(localFeatureRouting('listing-content')).toBe(true)
    expect(localFeatureRouting('translate')).toBe(false)
  })

  it('routes everything on the wildcard', () => {
    serveLocal('*')
    expect(localFeatureRouting('agent-fleet-analyst')).toBe(true)
    expect(localFeatureRouting('anything-at-all')).toBe(true)
  })
})

describe('getProviderForFeature — local allowlist', () => {
  it('routes a listed feature to the local provider', async () => {
    serveLocal('agent-fleet-analyst')
    const p = await getProviderForFeature('agent-fleet-analyst')
    expect(p?.name).toBe('local')
  })

  it('leaves every unlisted feature exactly where it was', async () => {
    serveLocal('agent-fleet-analyst')
    expect((await getProviderForFeature('listing-content'))?.name).toBe('gemini')
    expect((await getProviderForFeature('translate'))?.name).toBe('gemini')
  })

  it('REGRESSION: changes nothing when the allowlist is unset', async () => {
    process.env.NEXUS_LOCAL_AI_BASE_URL = 'http://127.0.0.1:1234/v1'
    expect((await getProviderForFeature('agent-fleet-analyst'))?.name).toBe('gemini')
  })

  it('FAIL-SAFE: a listed feature stays on the cloud when local is unconfigured', async () => {
    process.env.NEXUS_LOCAL_AI_FEATURES = 'agent-fleet-analyst'
    expect((await getProviderForFeature('agent-fleet-analyst'))?.name).toBe('gemini')
  })

  it('does not override a hard-locked provider', async () => {
    serveLocal('*')
    // image-vision is lockedProvider: 'gemini' in the feature catalog.
    expect((await getProviderForFeature('image-vision'))?.name).toBe('gemini')
  })

  it('an explicit per-call request still wins over the allowlist', async () => {
    process.env.ANTHROPIC_API_KEY = 'a'
    serveLocal('agent-fleet-analyst')
    const p = await getProviderForFeature('agent-fleet-analyst', 'anthropic')
    expect(p?.name).toBe('anthropic')
  })

  it('outranks a per-feature DB pref (env is the laptop-side override)', async () => {
    process.env.ANTHROPIC_API_KEY = 'a'
    findMany.mockResolvedValue([
      { featureKey: 'agent-fleet-analyst', provider: 'anthropic', model: 'claude-haiku-4-5' },
    ] as never)
    serveLocal('agent-fleet-analyst')
    expect((await getProviderForFeature('agent-fleet-analyst'))?.name).toBe('local')
  })

  it('the kill switch still fails closed', async () => {
    serveLocal('*')
    process.env.NEXUS_AI_KILL_SWITCH = '1'
    expect(await getProviderForFeature('agent-fleet-analyst')).toBeNull()
  })
})

describe('resolveModelForFeature on the local provider', () => {
  it('uses the local default model when no pref targets it', async () => {
    serveLocal('agent-fleet-analyst', 'qwen3-14b')
    const p = await getProviderForFeature('agent-fleet-analyst')
    expect(await resolveModelForFeature('agent-fleet-analyst', p!)).toBe('qwen3-14b')
  })

  it('ignores a pref belonging to another provider', async () => {
    findMany.mockResolvedValue([
      { featureKey: 'agent-fleet-analyst', provider: 'anthropic', model: 'claude-haiku-4-5' },
    ] as never)
    serveLocal('agent-fleet-analyst', 'qwen3-14b')
    const p = await getProviderForFeature('agent-fleet-analyst')
    expect(await resolveModelForFeature('agent-fleet-analyst', p!)).toBe('qwen3-14b')
  })

  it('honours a pref that does target the local provider', async () => {
    findMany.mockResolvedValue([
      { featureKey: 'agent-fleet-analyst', provider: 'local', model: 'mistral-small-3.2-24b' },
    ] as never)
    serveLocal('agent-fleet-analyst', 'qwen3-14b')
    const p = await getProviderForFeature('agent-fleet-analyst')
    expect(await resolveModelForFeature('agent-fleet-analyst', p!)).toBe(
      'mistral-small-3.2-24b',
    )
  })
})
