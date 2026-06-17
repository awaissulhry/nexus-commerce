/**
 * FX.7 — AI column-mapping tail.
 *
 * For the external headers the deterministic FX.3 mapper leaves unmatched, ask
 * the model to pick the best flat-file column id from the manifest catalog —
 * CONSTRAINED to the catalog (the result is filtered to real ids), so it can't
 * invent a column. Same provider substrate + constrained-prompt approach as
 * value-translate / flat-file-coerce-ai. Graceful: kill-switch on or no provider
 * → every header resolves to null (stays manual), never throws.
 */

import { getProvider, isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'

function parseJsonObject(text: string): Record<string, unknown> {
  let c = text.trim()
  if (c.startsWith('```')) c = c.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
  const brace = c.indexOf('{')
  if (brace > 0) c = c.slice(brace)
  try {
    return JSON.parse(c) as Record<string, unknown>
  } catch {
    return {}
  }
}

export async function aiSuggestColumns(
  headers: string[],
  columns: Array<{ id: string; labelEn?: string; labelLocal?: string }>,
  samples: Record<string, string>,
): Promise<Record<string, { columnId: string; confidence: number } | null>> {
  const out: Record<string, { columnId: string; confidence: number } | null> = Object.fromEntries(headers.map((h) => [h, null]))
  if (!headers.length || !columns.length || isAiKillSwitchOn()) return out
  const provider = getProvider(null)
  if (!provider) return out

  // Bound the catalog so a 200-column Amazon manifest doesn't blow the prompt.
  const catalog = columns.slice(0, 300).map((c) => `${c.id}${c.labelEn ? ` = ${c.labelEn}` : ''}`)
  const prompt = [
    `Map each external spreadsheet column to the best-matching Amazon flat-file column id, or null if none fits.`,
    ``,
    `External columns (with a sample value):`,
    ...headers.map((h) => `- ${JSON.stringify(h)}${samples[h] ? ` e.g. ${JSON.stringify(samples[h])}` : ''}`),
    ``,
    `Allowed flat-file columns (id = label):`,
    ...catalog,
    ``,
    `Return strict JSON mapping each external column to a flat-file column id from the list above, or null:`,
    `{`,
    ...headers.map((h) => `  ${JSON.stringify(h)}: "<column id or null>",`),
    `}`,
    `Only use ids from the allowed list. If unsure, use null.`,
  ].join('\n')

  const startedAt = Date.now()
  try {
    const res = await provider.generate({ prompt, jsonMode: true, maxOutputTokens: 1024, temperature: 0.1, feature: 'ff-map-columns' })
    logUsage({
      provider: res.usage.provider, model: res.usage.model, feature: 'ff-map-columns',
      inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt, ok: true, metadata: { headerCount: headers.length },
    })
    const parsed = parseJsonObject(res.text)
    const validIds = new Set(columns.map((c) => c.id))
    for (const h of headers) {
      const v = parsed[h]
      const id = typeof v === 'string' ? v.trim() : ''
      if (id && id !== 'null' && validIds.has(id)) out[h] = { columnId: id, confidence: 0.6 }
    }
  } catch (err) {
    logUsage({
      provider: provider.name, model: provider.defaultModel, feature: 'ff-map-columns',
      inputTokens: 0, outputTokens: 0, costUSD: 0, latencyMs: Date.now() - startedAt,
      ok: false, errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}
