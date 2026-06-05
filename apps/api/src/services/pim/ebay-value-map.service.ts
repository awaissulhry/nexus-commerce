/**
 * VL.3 — eBay value-map seeder.
 *
 * Unlike Amazon (canonical wire values + Amazon-side display localization),
 * eBay aspect VALUES are localized per market — the value you send to eBay-IT
 * is "Impermeabile", to eBay-DE "Wasserdicht". So eBay needs a real value
 * dictionary: English canonical → per-market eBay value. eBay gives no official
 * English value label, so we AI-translate each market's localized SELECTION
 * values to English (the canonical) and seed FieldValueMap rows (channel=EBAY,
 * attribute=aspect_<EnglishName>, fromValue=English, toValue=localized),
 * flagged reviewedAt=null for operator review (freedom of choice).
 *
 * Resolution rides the existing FM.4 path: the eBay rule's `valueMap` transform
 * + loadValueMapLookup('EBAY', marketplace) maps the master English value to
 * the market's eBay value when the channel field is resolved.
 */

import prisma from '../../db.js'
import { getProvider } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { EbayCategoryService } from '../ebay-category.service.js'
import { upsertValueMap } from './value-map.service.js'
import { parseAiJson } from './mapping-suggest-ai.service.js'

const MARKET_LANG: Record<string, string> = {
  IT: 'Italian',
  DE: 'German',
  FR: 'French',
  ES: 'Spanish',
  UK: 'English',
  GB: 'English',
}

async function translateValuesToEnglish(
  values: string[],
  marketplace: string,
  aspect: string,
): Promise<Record<string, string>> {
  const lang = MARKET_LANG[marketplace.toUpperCase()] ?? marketplace
  if (lang === 'English') {
    // Already English — identity map (canonical == value).
    const out: Record<string, string> = {}
    for (const v of values) out[v] = v
    return out
  }
  const provider = getProvider()
  if (!provider) return {}
  const startedAt = Date.now()
  try {
    const res = await provider.generate({
      prompt: [
        `Translate these ${lang} eBay product-attribute values for the aspect "${aspect}" into English (the single best equivalent term each).`,
        `Return ONLY JSON mapping each original value to its English term: { "<original>": "<English>", ... }. Omit a value if unsure.`,
        ``,
        ...values.map((v) => `- ${v}`),
      ].join('\n'),
      jsonMode: true,
      maxOutputTokens: 1500,
      temperature: 0.1,
      feature: 'ebay-value-translate',
    })
    logUsage({
      provider: res.usage.provider,
      model: res.usage.model,
      feature: 'ebay-value-translate',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt,
      ok: true,
      metadata: { marketplace, aspect, n: values.length },
    })
    const parsed = parseAiJson(res.text)
    const out: Record<string, string> = {}
    for (const v of values) {
      const e = parsed[v]
      if (typeof e === 'string' && e.trim()) out[v] = e.trim()
    }
    return out
  } catch (err) {
    logUsage({
      provider: provider.name,
      model: provider.defaultModel,
      feature: 'ebay-value-translate',
      inputTokens: 0,
      outputTokens: 0,
      costUSD: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    return {}
  }
}

export async function seedEbayValueMaps(input: {
  productId: string
  marketplaces?: string[]
}): Promise<{ written: number; aspects: number; markets: string[] }> {
  const listings = await prisma.channelListing.findMany({
    where: { productId: input.productId, channel: 'EBAY' },
    select: { marketplace: true, platformAttributes: true },
  })
  const svc = new EbayCategoryService()
  let written = 0
  let aspects = 0
  const markets = new Set<string>()

  for (const l of listings) {
    if (!l.marketplace) continue
    if (input.marketplaces && !input.marketplaces.includes(l.marketplace)) continue
    const categoryId = (l.platformAttributes as { categoryId?: unknown } | null)?.categoryId
    if (typeof categoryId !== 'string' || !categoryId) continue

    let rich
    try {
      rich = await svc.getCategoryAspectsRich(categoryId, l.marketplace)
    } catch {
      continue
    }
    const selectAspects = rich.filter((a) => a.mode === 'SELECTION_ONLY' && a.values.length > 0 && a.values.length <= 60)
    if (selectAspects.length === 0) continue
    markets.add(l.marketplace)

    const isEnglish = MARKET_LANG[l.marketplace.toUpperCase()] === 'English'
    for (const a of selectAspects) {
      aspects++
      const attribute = `aspect_${a.englishName || a.name}`
      const english = await translateValuesToEnglish(a.values, l.marketplace, a.englishName || a.name)
      for (const v of a.values) {
        const en = english[v]
        if (!en) continue
        await upsertValueMap({
          channel: 'EBAY',
          marketplace: l.marketplace,
          attribute,
          fromValue: en,
          toValue: v,
          confidence: isEnglish ? 'MANUAL' : 'AI_MEDIUM',
          reviewed: isEnglish, // English markets are identity → trusted; others need review
        })
        written++
      }
    }
  }
  return { written, aspects, markets: [...markets] }
}
