/**
 * AI-2.2 — live model catalog.
 *
 * Discovers the models each provider currently serves — Anthropic
 * `GET /v1/models`, Gemini `GET /v1beta/models` — at runtime, so a model
 * the vendor ships next month appears here with no code change. That is
 * the whole point of "support all models, always": selection tracks the
 * provider's real lineup instead of a hardcoded list that goes stale
 * (which is exactly how the app ended up defaulting to gemini-2.0-flash
 * two weeks after Google retired it).
 *
 * Each discovered model is joined against the static rate card
 * (rate-cards.ts). A model the table knows carries its real price; a
 * brand-new model the table hasn't seen is still returned and fully
 * usable — `costEstimated: true` and the price is the provider default
 * as a placeholder, so cost analytics can flag it rather than silently
 * mis-charge. Prices stay exact for known models; new models become
 * selectable the day they launch.
 *
 * Fails closed per provider: missing key, network error, or a non-2xx
 * from the models API yields an empty list for that provider (with
 * `error` set for observability) — never throws. A provider with no API
 * key simply doesn't contribute models, which is the correct UX: you
 * can't pick a model you can't reach. The kill switch is reported but
 * does NOT suppress discovery — listing models is free and the settings
 * UI still needs the catalog to render.
 */

import { TtlCache } from '../../utils/ttl-cache.js'
import { isAiKillSwitchOn } from './providers/index.js'
import {
  ANTHROPIC_DEFAULT_MODEL,
  GEMINI_DEFAULT_MODEL,
  rateInfoFor,
} from './rate-cards.js'

export type CatalogProvider = 'anthropic' | 'gemini'

export interface CatalogModel {
  provider: CatalogProvider
  id: string
  displayName: string
  inputPer1M: number
  outputPer1M: number
  /** true → price is a default-rate placeholder (model not yet seeded). */
  costEstimated: boolean
  /** true → this is the provider's current default content model. */
  isDefault: boolean
}

export interface ProviderCatalog {
  provider: CatalogProvider
  configured: boolean
  models: CatalogModel[]
  /** Set when discovery failed (missing key, network, non-2xx). */
  error?: string
}

export interface ModelCatalog {
  killSwitch: boolean
  providers: ProviderCatalog[]
}

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=1000'
const ANTHROPIC_VERSION = '2023-06-01'
const GEMINI_MODELS_URL =
  'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000'

// The vendor model list changes on the order of weeks, so an hour-long
// TTL keeps the settings page snappy without ever being meaningfully
// stale. maxEntries is tiny — only two keys ('anthropic', 'gemini').
const cache = new TtlCache<ProviderCatalog>({
  ttlMs: 60 * 60 * 1000,
  maxEntries: 8,
})

// Drop non-text-generation models from the picker (embeddings, image /
// video / speech generators, Gemma open weights, tuning helpers). For
// Gemini the generateContent filter already covers most of these; this
// is belt-and-suspenders and also trims Anthropic's list.
const ID_BLOCKLIST =
  /embedding|imagen|veo|gemma|learnlm|aqa|tts|image-generation|text-to/i

function toCatalogModel(
  provider: CatalogProvider,
  id: string,
  displayName?: string,
): CatalogModel {
  const rate = rateInfoFor(provider, id)
  const defaultId =
    provider === 'gemini' ? GEMINI_DEFAULT_MODEL : ANTHROPIC_DEFAULT_MODEL
  return {
    provider,
    id,
    displayName: displayName?.trim() || id,
    inputPer1M: rate.inputPer1M,
    outputPer1M: rate.outputPer1M,
    costEstimated: !rate.known,
    isDefault: id === defaultId,
  }
}

async function discoverAnthropic(): Promise<ProviderCatalog> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return { provider: 'anthropic', configured: false, models: [] }
  try {
    const res = await fetch(ANTHROPIC_MODELS_URL, {
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    })
    if (!res.ok) {
      return {
        provider: 'anthropic',
        configured: true,
        models: [],
        error: `models API ${res.status}`,
      }
    }
    const json = (await res.json()) as {
      data?: Array<{ id?: string; display_name?: string }>
    }
    const models = (json.data ?? [])
      .filter((m): m is { id: string; display_name?: string } =>
        Boolean(m.id && !ID_BLOCKLIST.test(m.id)),
      )
      .map((m) => toCatalogModel('anthropic', m.id, m.display_name))
    return { provider: 'anthropic', configured: true, models }
  } catch (err) {
    return {
      provider: 'anthropic',
      configured: true,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function discoverGemini(): Promise<ProviderCatalog> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { provider: 'gemini', configured: false, models: [] }
  try {
    const res = await fetch(`${GEMINI_MODELS_URL}&key=${apiKey}`)
    if (!res.ok) {
      return {
        provider: 'gemini',
        configured: true,
        models: [],
        error: `models API ${res.status}`,
      }
    }
    const json = (await res.json()) as {
      models?: Array<{
        name?: string
        displayName?: string
        supportedGenerationMethods?: string[]
      }>
    }
    const models = (json.models ?? [])
      .filter((m) =>
        (m.supportedGenerationMethods ?? []).includes('generateContent'),
      )
      .map((m) => ({
        id: (m.name ?? '').replace(/^models\//, ''),
        displayName: m.displayName,
      }))
      .filter((m) => Boolean(m.id && !ID_BLOCKLIST.test(m.id)))
      .map((m) => toCatalogModel('gemini', m.id, m.displayName))
    return { provider: 'gemini', configured: true, models }
  } catch (err) {
    return {
      provider: 'gemini',
      configured: true,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function getProviderCatalog(
  provider: CatalogProvider,
  force?: boolean,
): Promise<ProviderCatalog> {
  if (!force) {
    const hit = cache.get(provider)
    if (hit) return hit
  }
  const result =
    provider === 'anthropic'
      ? await discoverAnthropic()
      : await discoverGemini()
  // Only cache clean results. A transient blip (network, 5xx) shouldn't
  // pin an empty list for the full hour — retry on the next call instead.
  if (!result.error) cache.set(provider, result)
  return result
}

/**
 * The merged, cached model catalog across providers. `force` bypasses
 * the per-provider cache (for the settings "refresh models" button).
 */
export async function getModelCatalog(opts?: {
  force?: boolean
}): Promise<ModelCatalog> {
  const providers = await Promise.all([
    getProviderCatalog('anthropic', opts?.force),
    getProviderCatalog('gemini', opts?.force),
  ])
  return { killSwitch: isAiKillSwitchOn(), providers }
}
