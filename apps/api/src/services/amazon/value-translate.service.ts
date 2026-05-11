/**
 * Cross-market enum value translation for Amazon flat-file columns.
 *
 * Given a source market's enum values for a specific column (e.g.
 * "impermeabile" in IT), finds the semantically equivalent option in
 * each target market's schema options list (e.g. "étanche" in FR).
 *
 * Strategy: constrained LLM mapping — the model is given the source
 * value AND the full list of valid target options, so it can only
 * return values that exist in the target schema. This eliminates
 * hallucinated translations.
 *
 * One AI call per target market (all source values batched together).
 */

import type { PrismaClient } from '@nexus/database'
import { getProvider, isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { buildSchemaEnums } from './flat-file.service.js'

// ── Types ──────────────────────────────────────────────────────────────────

export interface ValueTranslateInput {
  sourceMarket: string
  productType: string
  /** Column field ID (e.g. "water_resistance_level") */
  colId: string
  /** Human-readable English column label for better AI context */
  colLabelEn?: string
  /** Distinct source values to map */
  values: string[]
  targetMarkets: string[]
}

export interface ValueMapping {
  /** Best-matching option in the target schema, or null if no match */
  match: string | null
  /** Confidence level from the AI */
  confidence: 'high' | 'medium' | 'low' | 'none'
  /** True if match is in the target schema's valid options */
  valid: boolean
}

export interface ValueTranslateResult {
  colLabel: string
  /** market → { sourceValue → mapping } */
  mappings: Record<string, Record<string, ValueMapping>>
  /** market → full sorted list of valid options (for user overrides) */
  targetOptions: Record<string, string[]>
  /** market → error message for markets that couldn't be processed */
  errors: Record<string, string>
}

// ── Language labels ────────────────────────────────────────────────────────

const MARKET_LANGUAGE: Record<string, string> = {
  IT: 'Italian',
  DE: 'German',
  FR: 'French',
  ES: 'Spanish',
  UK: 'English (UK)',
}

const SOURCE_LANGUAGE: Record<string, string> = MARKET_LANGUAGE

// ── Main service function ──────────────────────────────────────────────────

export async function translateEnumValues(
  prisma: PrismaClient,
  input: ValueTranslateInput,
): Promise<ValueTranslateResult> {
  const { sourceMarket, productType, colId, colLabelEn, values, targetMarkets } = input
  const srcLang = SOURCE_LANGUAGE[sourceMarket.toUpperCase()] ?? sourceMarket

  const result: ValueTranslateResult = {
    colLabel: colLabelEn ?? colId,
    mappings: {},
    targetOptions: {},
    errors: {},
  }

  if (!values.length || !targetMarkets.length) return result

  // Load schemas for all target markets in parallel
  const schemaRows = await prisma.categorySchema.findMany({
    where: {
      channel: 'AMAZON',
      marketplace: { in: targetMarkets.map((m) => m.toUpperCase()) },
      productType: productType.toUpperCase(),
      isActive: true,
    },
    select: { marketplace: true, schemaDefinition: true },
    orderBy: { fetchedAt: 'desc' },
    distinct: ['marketplace'],
  })

  const schemaByMarket = new Map(
    schemaRows.map((r) => [r.marketplace ?? '', r.schemaDefinition as any]),
  )

  // Check AI availability once
  const aiAvailable = !isAiKillSwitchOn()
  const provider = aiAvailable ? getProvider(null) : null

  // Process each target market
  await Promise.allSettled(
    targetMarkets.map(async (rawMp) => {
      const mp = rawMp.toUpperCase()
      const schema = schemaByMarket.get(mp)

      if (!schema) {
        result.errors[mp] =
          `No schema cached for ${mp}/${productType} — open the flat file for that marketplace and click "Refresh schema" first`
        return
      }

      // Extract options for this column from the target schema
      const properties: Record<string, any> = (schema as any)?.properties ?? {}
      const enumMap = buildSchemaEnums(properties)

      // Try the exact colId first, then sub-property variants
      let targetOptions: string[] =
        enumMap[colId] ??
        // Some columns have a primary sub-key like "color.value"
        enumMap[Object.keys(enumMap).find((k) => k.startsWith(`${colId}.`)) ?? ''] ??
        []

      if (!targetOptions.length) {
        result.errors[mp] = `Column "${colId}" has no enum options in the ${mp} schema — it may be a free-text field in this marketplace`
        return
      }

      result.targetOptions[mp] = targetOptions

      // If AI isn't available, skip mapping but return options for manual override
      if (!provider) {
        result.errors[mp] = 'AI provider not configured — you can still select values manually using the dropdowns below'
        result.mappings[mp] = Object.fromEntries(
          values.map((v) => [v, { match: null, confidence: 'none', valid: false } as ValueMapping]),
        )
        return
      }

      const tgtLang = MARKET_LANGUAGE[mp] ?? mp

      const prompt = buildTranslationPrompt({
        srcLang,
        tgtLang,
        colId,
        colLabel: colLabelEn ?? colId,
        productType,
        values,
        targetOptions,
      })

      const startedAt = Date.now()
      let raw: string
      let usage: { inputTokens: number; outputTokens: number; costUSD: number; model: string; provider: string }

      try {
        const res = await provider.generate({
          prompt,
          jsonMode: true,
          maxOutputTokens: 1024,
          temperature: 0.1,
          feature: 'ff-value-translate',
        })
        raw = res.text
        usage = res.usage
        logUsage({
          provider: res.usage.provider,
          model: res.usage.model,
          feature: 'ff-value-translate',
          inputTokens: res.usage.inputTokens,
          outputTokens: res.usage.outputTokens,
          costUSD: res.usage.costUSD,
          latencyMs: Date.now() - startedAt,
          ok: true,
          metadata: { sourceMarket, targetMarket: mp, colId, valueCount: values.length },
        })
      } catch (err) {
        logUsage({
          provider: provider.name,
          model: provider.defaultModel,
          feature: 'ff-value-translate',
          inputTokens: 0, outputTokens: 0, costUSD: 0,
          latencyMs: Date.now() - startedAt,
          ok: false,
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        result.errors[mp] = `AI call failed: ${err instanceof Error ? err.message : String(err)}`
        return
      }

      // Parse the AI response
      const parsed = parseAiResponse(raw)
      const optionSet = new Set(targetOptions.map((o) => o.toLowerCase()))

      result.mappings[mp] = Object.fromEntries(
        values.map((srcVal) => {
          const rawMatch: unknown = parsed[srcVal]
          if (!rawMatch || typeof rawMatch !== 'object') {
            // Simple string response
            const matchStr = typeof rawMatch === 'string' ? rawMatch.trim() : null
            if (!matchStr || matchStr === 'null' || matchStr === 'NO_MATCH') {
              return [srcVal, { match: null, confidence: 'none', valid: false }]
            }
            const exact = targetOptions.find((o) => o === matchStr)
            const caseInsensitive = targetOptions.find((o) => o.toLowerCase() === matchStr.toLowerCase())
            const matched = exact ?? caseInsensitive ?? null
            return [srcVal, {
              match: matched,
              confidence: matched ? 'high' : 'none',
              valid: !!matched,
            }]
          }
          // Object response with confidence: { match: "...", confidence: "high" }
          const obj = rawMatch as Record<string, string>
          const matchStr = typeof obj.match === 'string' ? obj.match.trim() : null
          if (!matchStr || matchStr === 'null' || matchStr === 'NO_MATCH') {
            return [srcVal, { match: null, confidence: 'none', valid: false }]
          }
          const exact = targetOptions.find((o) => o === matchStr)
          const caseInsensitive = targetOptions.find((o) => o.toLowerCase() === matchStr.toLowerCase())
          const matched = exact ?? caseInsensitive ?? null
          const confRaw = obj.confidence ?? 'high'
          const confidence: ValueMapping['confidence'] =
            confRaw === 'high' || confRaw === 'medium' || confRaw === 'low' ? confRaw : 'high'
          return [srcVal, {
            match: matched,
            confidence: matched ? confidence : 'none',
            valid: !!matched,
          }]
        }),
      )
    }),
  )

  return result
}

// ── Helpers ────────────────────────────────────────────────────────────────

interface PromptArgs {
  srcLang: string
  tgtLang: string
  colId: string
  colLabel: string
  productType: string
  values: string[]
  targetOptions: string[]
}

function buildTranslationPrompt(args: PromptArgs): string {
  const { srcLang, tgtLang, colId, colLabel, productType, values, targetOptions } = args
  // Limit options list in prompt to avoid bloat (Amazon can have 200+ options)
  const optionsSample = targetOptions.slice(0, 80)
  const truncated = targetOptions.length > 80

  return [
    `You are matching product attribute values across languages for Amazon listings.`,
    ``,
    `Field: "${colId}" (${colLabel})`,
    `Product type: ${productType}`,
    `Source language: ${srcLang}`,
    `Target language: ${tgtLang}`,
    ``,
    `Source values to map (${srcLang}):`,
    ...values.map((v) => `- ${v}`),
    ``,
    `Valid ${tgtLang} options for this field:`,
    ...optionsSample.map((o) => `- ${o}`),
    truncated ? `... (${targetOptions.length - 80} more options omitted)` : '',
    ``,
    `Instructions:`,
    `- For each source value, return the single best matching ${tgtLang} option from the list above.`,
    `- Only return values that appear EXACTLY in the list above (case-sensitive).`,
    `- If no reasonable equivalent exists, return null for that value.`,
    `- Also return your confidence: "high", "medium", or "low".`,
    ``,
    `Return strict JSON only, no commentary:`,
    `{`,
    ...values.map((v) => `  "${v}": { "match": "<option or null>", "confidence": "high|medium|low" },`),
    `}`,
  ]
    .filter((l) => l !== undefined)
    .join('\n')
}

function parseAiResponse(text: string): Record<string, unknown> {
  let candidate = text.trim()
  if (candidate.startsWith('```')) {
    candidate = candidate.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  }
  const firstBrace = candidate.indexOf('{')
  if (firstBrace > 0) candidate = candidate.slice(firstBrace)
  try {
    return JSON.parse(candidate) as Record<string, unknown>
  } catch {
    return {}
  }
}
