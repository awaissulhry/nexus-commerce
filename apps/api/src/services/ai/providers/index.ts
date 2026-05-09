/**
 * Provider selector + registry.
 *
 * Resolution order for `getProvider(requested?)`:
 *   1. NEXUS_AI_KILL_SWITCH env — when on, ALL providers refused (fail
 *      closed). Returns null and the caller surfaces a "AI temporarily
 *      disabled" message. Single chokepoint for kill-switching every
 *      AI feature simultaneously without redeploying or rotating keys.
 *   2. requested (validated against the registry)
 *   3. AI_PROVIDER env var
 *   4. 'gemini' default
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

/**
 * AI-1.2 — emergency disable for every AI call across the app.
 *
 * Truthy values that flip it on: '1', 'true', 'yes', 'on' (case
 * insensitive, trimmed). Anything else is off — including 'false', '0',
 * empty string, and unset. Stays env-driven (no DB hit per call) so
 * the check is microsecond-cheap and survives DB outages.
 *
 * Operationally: set NEXUS_AI_KILL_SWITCH=1 in the runtime config to
 * stop all AI spend immediately. No process restart required for
 * Node-managed envs that hot-reload (Railway/Vercel rotate envs); for
 * cold envs, a redeploy is needed.
 */
const KILL_SWITCH_VALUES = new Set(['1', 'true', 'yes', 'on'])

export function isAiKillSwitchOn(): boolean {
  const raw = (process.env.NEXUS_AI_KILL_SWITCH ?? '').trim().toLowerCase()
  return KILL_SWITCH_VALUES.has(raw)
}

export function listProviders(): {
  killSwitch: boolean
  providers: Array<{
    name: ProviderName
    configured: boolean
    defaultModel: string
  }>
} {
  return {
    killSwitch: isAiKillSwitchOn(),
    providers: Object.values(REGISTRY).map((p) => ({
      name: p.name,
      configured: p.isConfigured(),
      defaultModel: p.defaultModel,
    })),
  }
}

/**
 * Pick a provider for an outgoing AI call.
 *
 * The fallback rule: if the requested provider isn't configured, we
 * try the env-default, then any configured provider in the registry.
 * Returns null only when no provider has credentials OR when the
 * kill switch is on, so callers can 503 cleanly with a kill-switch
 * specific message via `isAiKillSwitchOn()`.
 */
export function getProvider(requested?: string | null): LLMProvider | null {
  // 0. Kill switch — fail closed before any vendor lookup.
  if (isAiKillSwitchOn()) return null
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
