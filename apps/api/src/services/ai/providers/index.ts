/**
 * Provider selector + registry.
 *
 * Resolution order for `getProvider(requested?)`:
 *   1. requested (validated against the registry)
 *   2. AI_PROVIDER env var
 *   3. 'gemini' default
 *
 * Falls back to a configured provider if the requested one isn't —
 * e.g. a route asks for 'anthropic' but ANTHROPIC_API_KEY isn't set,
 * we'd rather succeed on Gemini than 503 the user.
 *
 * Singleton instances per provider — the providers themselves are
 * lazy + cheap to keep around, and singletons let us share an
 * authenticated client across routes.
 */

import { AnthropicProvider } from './anthropic.provider.js'
import { GeminiProvider } from './gemini.provider.js'
import type { LLMProvider, ProviderName } from './types.js'

const gemini = new GeminiProvider()
const anthropic = new AnthropicProvider()

const REGISTRY: Record<ProviderName, LLMProvider> = {
  gemini,
  anthropic,
}

export function isValidProviderName(s: string): s is ProviderName {
  return s === 'gemini' || s === 'anthropic'
}

export function listProviders(): Array<{
  name: ProviderName
  configured: boolean
  defaultModel: string
}> {
  return Object.values(REGISTRY).map((p) => ({
    name: p.name,
    configured: p.isConfigured(),
    defaultModel: p.defaultModel,
  }))
}

/**
 * Pick a provider for an outgoing AI call.
 *
 * The fallback rule: if the requested provider isn't configured, we
 * try the env-default, then any configured provider in the registry.
 * Returns null only when no provider has credentials, so callers can
 * 503 cleanly.
 */
export function getProvider(requested?: string | null): LLMProvider | null {
  // 1. Honour an explicit request when valid + configured.
  if (requested) {
    const trimmed = requested.trim().toLowerCase()
    if (isValidProviderName(trimmed) && REGISTRY[trimmed].isConfigured()) {
      return REGISTRY[trimmed]
    }
  }
  // 2. Env default.
  const envName = (process.env.AI_PROVIDER ?? '').trim().toLowerCase()
  if (isValidProviderName(envName) && REGISTRY[envName].isConfigured()) {
    return REGISTRY[envName]
  }
  // 3. First configured.
  for (const p of Object.values(REGISTRY)) {
    if (p.isConfigured()) return p
  }
  return null
}

export type { LLMProvider, ProviderName } from './types.js'
