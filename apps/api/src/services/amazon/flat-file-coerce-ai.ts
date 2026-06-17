/**
 * FX.4 — AI semantic-match for flagged enum cells, layered on the pure
 * coercion engine (flat-file-coerce.ts).
 *
 * When a mapped external value doesn't match any of the column's options by
 * exact/normalized text (e.g. supplier "rosso" / "impermeabile" vs the column's
 * "Red" / "Waterproof"), this asks the model to pick the single best option —
 * CONSTRAINED to the option list so it can't hallucinate a value Amazon would
 * reject. Mirrors the proven constrained-prompt approach in
 * value-translate.service.ts, but takes the options directly (no DB / no
 * cross-market schema load) and runs one call per enum column.
 *
 * Graceful: with the AI kill-switch on or no provider configured, every value
 * resolves to null (the cell stays flagged for manual fixing) — never throws.
 */

import { getProvider, isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { coerceRows, type CoercibleColumnWithId, type CoerceRowsResult } from './flat-file-coerce.js'

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

/**
 * Map each value → a valid option (or null). Only values that resolve to an
 * actual member of `options` are returned; anything else is null.
 */
export async function aiMatchEnumValues(
  values: string[],
  options: string[],
  ctx: { colId: string; colLabel?: string },
): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = Object.fromEntries(values.map((v) => [v, null]))
  if (!values.length || !options.length || isAiKillSwitchOn()) return out
  const provider = getProvider(null)
  if (!provider) return out

  const sample = options.slice(0, 80)
  const prompt = [
    `You are matching imported product attribute values to a fixed list of allowed Amazon options.`,
    ``,
    `Field: "${ctx.colId}"${ctx.colLabel ? ` (${ctx.colLabel})` : ''}`,
    ``,
    `Imported values to match:`,
    ...values.map((v) => `- ${v}`),
    ``,
    `Allowed options:`,
    ...sample.map((o) => `- ${o}`),
    options.length > 80 ? `... (${options.length - 80} more omitted)` : '',
    ``,
    `For each imported value, return the single best-matching option from the allowed list`,
    `(exact string, case-sensitive). If none is a reasonable match, return null.`,
    `Return strict JSON only:`,
    `{`,
    ...values.map((v) => `  ${JSON.stringify(v)}: "<option or null>",`),
    `}`,
  ].filter((l) => l !== undefined && l !== '').join('\n')

  const startedAt = Date.now()
  try {
    const res = await provider.generate({ prompt, jsonMode: true, maxOutputTokens: 1024, temperature: 0.1, feature: 'ff-coerce-enum' })
    logUsage({
      provider: res.usage.provider, model: res.usage.model, feature: 'ff-coerce-enum',
      inputTokens: res.usage.inputTokens, outputTokens: res.usage.outputTokens, costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt, ok: true, metadata: { colId: ctx.colId, valueCount: values.length },
    })
    const parsed = parseJsonObject(res.text)
    const byLower = new Map(options.map((o) => [o.toLowerCase(), o]))
    for (const v of values) {
      const m = parsed[v]
      const s = typeof m === 'string'
        ? m.trim()
        : (m && typeof m === 'object' && typeof (m as Record<string, unknown>).match === 'string'
            ? String((m as Record<string, unknown>).match).trim() : '')
      if (s && s !== 'null' && s !== 'NO_MATCH') out[v] = byLower.get(s.toLowerCase()) ?? null
    }
  } catch (err) {
    logUsage({
      provider: provider.name, model: provider.defaultModel, feature: 'ff-coerce-enum',
      inputTokens: 0, outputTokens: 0, costUSD: 0, latencyMs: Date.now() - startedAt,
      ok: false, errorMessage: err instanceof Error ? err.message : String(err),
    })
  }
  return out
}

/**
 * Pure coercion (flat-file-coerce.coerceRows) + an optional AI pass that rescues
 * flagged ENUM cells via semantic matching. AI runs one call per affected enum
 * column (distinct flagged values batched). Rescued cells flip flagged→coerced.
 */
export async function coerceRowsWithAi(
  rows: Record<string, unknown>[],
  columns: CoercibleColumnWithId[],
  opts: { ai: boolean; colLabels?: Map<string, string> },
): Promise<CoerceRowsResult> {
  const base = coerceRows(rows, columns)
  if (!opts.ai) return base

  const byId = new Map(columns.map((c) => [c.id, c]))
  const flaggedByCol = new Map<string, Set<string>>()
  for (const iss of base.issues) {
    if (iss.status !== 'flagged') continue
    const col = byId.get(iss.columnId)
    if (col?.kind === 'enum' && col.options?.length) {
      if (!flaggedByCol.has(iss.columnId)) flaggedByCol.set(iss.columnId, new Set())
      flaggedByCol.get(iss.columnId)!.add(iss.from)
    }
  }
  if (!flaggedByCol.size) return base

  const resolved = new Map<string, Record<string, string | null>>()
  await Promise.all(
    [...flaggedByCol].map(async ([colId, vals]) => {
      const col = byId.get(colId)!
      resolved.set(colId, await aiMatchEnumValues([...vals], col.options ?? [], { colId, colLabel: opts.colLabels?.get(colId) }))
    }),
  )

  let { ok, coerced, flagged } = base.counts
  const rowsOut = base.rows.map((r) => ({ ...r }))
  const issuesOut = base.issues.map((iss) => {
    if (iss.status === 'flagged') {
      const match = resolved.get(iss.columnId)?.[iss.from]
      if (match) {
        rowsOut[iss.rowIndex][iss.columnId] = match
        flagged--; coerced++
        return { ...iss, status: 'coerced' as const, to: match, note: `AI matched "${match}"` }
      }
    }
    return iss
  })

  return { rows: rowsOut, issues: issuesOut, counts: { ok, coerced, flagged } }
}
