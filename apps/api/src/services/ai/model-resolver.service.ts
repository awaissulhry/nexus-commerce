/**
 * AI-2.2 — per-feature model selection.
 *
 * `resolveModelForFeature(feature, provider)` returns the model id a
 * given feature should use on the currently-active provider, applying
 * the operator's saved preference. Resolution order:
 *
 *   1. per-feature override   (AiFeatureModelPref[feature])
 *   2. global default          (AiFeatureModelPref["__global__"])
 *   3. provider default        (provider.defaultModel)
 *
 * A saved preference is provider-qualified — a Gemini model id is
 * meaningless on Anthropic — so a pref only applies when its provider
 * matches the active provider; otherwise we fall through to the provider
 * default. Provider SELECTION stays where it was (the ?provider query
 * param / AI_PROVIDER env / first configured); this layer only chooses
 * the model within that provider.
 *
 * Prefs are cached for 60s (tiny table, read on every AI call); writes
 * bust the cache so the settings UI feels immediate. A pref read failure
 * never sinks a call — it falls back to the provider default.
 */

import prisma from '../../db.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import { AI_FEATURES, GLOBAL_FEATURE_KEY, isKnownFeature } from './ai-features.js'
import { getProvider, isAiKillSwitchOn } from './providers/index.js'
import type { LLMProvider, ProviderName } from './providers/types.js'

interface PrefRow {
  provider: string
  model: string
}

const PREFS_KEY = 'all'
const cache = new TtlCache<Map<string, PrefRow>>({
  ttlMs: 60 * 1000,
  maxEntries: 1,
})

async function loadPrefs(): Promise<Map<string, PrefRow>> {
  const hit = cache.get(PREFS_KEY)
  if (hit) return hit
  const rows = await prisma.aiFeatureModelPref.findMany({
    select: { featureKey: true, provider: true, model: true },
  })
  const map = new Map<string, PrefRow>(
    rows.map((r) => [r.featureKey, { provider: r.provider, model: r.model }]),
  )
  cache.set(PREFS_KEY, map)
  return map
}

/** Drop the cached pref map — call after any write. */
export function bustPrefCache(): void {
  cache.clear()
}

/**
 * The model `feature` should use on `provider`, honouring the operator
 * pref when it targets this provider, else the global default, else the
 * provider's own default.
 */
export async function resolveModelForFeature(
  feature: string,
  provider: LLMProvider,
): Promise<string> {
  const prefs = await loadPrefs().catch(() => new Map<string, PrefRow>())
  const pick = (p?: PrefRow): string | null =>
    p && p.provider === provider.name ? p.model : null
  return (
    pick(prefs.get(feature)) ??
    pick(prefs.get(GLOBAL_FEATURE_KEY)) ??
    provider.defaultModel
  )
}

/* ── Pref CRUD (settings API) ──────────────────────────────────────── */

export interface SetPrefInput {
  featureKey: string
  provider: ProviderName
  model: string
  updatedBy?: string | null
}

export async function setFeaturePref(input: SetPrefInput) {
  const row = await prisma.aiFeatureModelPref.upsert({
    where: { featureKey: input.featureKey },
    create: {
      featureKey: input.featureKey,
      provider: input.provider,
      model: input.model,
      updatedBy: input.updatedBy ?? null,
    },
    update: {
      provider: input.provider,
      model: input.model,
      updatedBy: input.updatedBy ?? null,
    },
  })
  bustPrefCache()
  return row
}

export async function clearFeaturePref(featureKey: string): Promise<void> {
  await prisma.aiFeatureModelPref.deleteMany({ where: { featureKey } })
  bustPrefCache()
}

/** Validate a featureKey for writes (catalog key or the global sentinel). */
export function isWritableFeatureKey(key: string): boolean {
  return key === GLOBAL_FEATURE_KEY || isKnownFeature(key)
}

/**
 * Catalog + each feature's override + its effective model (resolved
 * against the default provider) + the global default — the payload the
 * settings Models tab renders.
 */
export async function getFeaturePrefOverview() {
  const prefs = await loadPrefs()
  // Assume the env-default / first-configured provider for the "effective"
  // column — the same provider a call with no explicit ?provider lands on.
  const active = getProvider(null)
  const features = await Promise.all(
    AI_FEATURES.map(async (f) => ({
      key: f.key,
      label: f.label,
      description: f.description,
      override: prefs.get(f.key) ?? null,
      effective: active
        ? { provider: active.name, model: await resolveModelForFeature(f.key, active) }
        : null,
    })),
  )
  return {
    killSwitch: isAiKillSwitchOn(),
    activeProvider: active?.name ?? null,
    global: prefs.get(GLOBAL_FEATURE_KEY) ?? null,
    features,
  }
}
