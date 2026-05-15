/**
 * A4.1 — Flat File AI Assistant.
 *
 * Accepts a free-form operator instruction + the current flat file rows,
 * calls Claude (Anthropic provider), and returns a structured list of
 * proposed cell changes. The caller reviews and applies the diff.
 */

import { getProvider, isAiKillSwitchOn } from './ai/providers/index.js'
import { ANTHROPIC_DEFAULT_MODEL } from './ai/rate-cards.js'
import { logger } from '../utils/logger.js'

export interface FlatFileAiChange {
  rowId: string
  sku: string
  field: string
  oldValue: unknown
  newValue: unknown
}

export interface FlatFileAiResult {
  changes: FlatFileAiChange[]
  summary: string
  usage: {
    inputTokens: number
    outputTokens: number
    costUSD: number
    model: string
  }
}

export interface FlatFileAiParams {
  instruction: string
  /** Flat file rows — heavy meta fields (_listingId, _fieldStates, etc.) already stripped by caller */
  rows: Array<Record<string, unknown>>
  /** Column definitions for context */
  columnMeta: Array<{ id: string; label: string; description?: string }>
  marketplace: string
  channel: 'AMAZON' | 'EBAY'
  /** Defaults to claude-haiku-4-5-20251001 */
  model?: string
}

/** Max rows to send in a single call — avoids context overflow */
const MAX_ROWS = 200
/** Max tokens for Claude response */
const MAX_OUTPUT_TOKENS = 8192

export async function runFlatFileAiInstruction(
  params: FlatFileAiParams,
): Promise<FlatFileAiResult> {
  const { instruction, rows, columnMeta, marketplace, channel, model } = params

  if (isAiKillSwitchOn()) {
    throw new Error('AI features are currently disabled (kill switch active).')
  }

  // Prefer Anthropic explicitly — this feature is intentionally Claude-first.
  const provider = getProvider('anthropic')
  if (!provider) {
    throw new Error('Anthropic provider not configured. Set ANTHROPIC_API_KEY.')
  }

  const effectiveModel = model ?? ANTHROPIC_DEFAULT_MODEL

  // Trim rows to MAX_ROWS and strip any remaining meta/internal fields
  const safeRows = rows.slice(0, MAX_ROWS).map((r) => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(r)) {
      if (k.startsWith('_')) continue
      if (v == null || v === '') continue
      out[k] = v
    }
    return out
  })

  // Compact column list — only id + label for token efficiency
  const colList = columnMeta
    .filter((c) => !c.id.startsWith('_'))
    .map((c) => `${c.id}: ${c.label}`)
    .join('\n')

  const rowJson = JSON.stringify(safeRows, null, 0)

  const prompt = buildPrompt({
    instruction,
    channel,
    marketplace,
    colList,
    rowJson,
    rowCount: safeRows.length,
  })

  logger.info('[flat-file-ai] calling Claude', {
    channel,
    marketplace,
    model: effectiveModel,
    rowCount: safeRows.length,
    instructionLength: instruction.length,
  })

  const result = await provider.generate({
    prompt,
    model: effectiveModel,
    jsonMode: true,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    temperature: 0.3,  // lower = more consistent structured output
    feature: 'flat-file-ai',
  })

  // Parse Claude's JSON response
  const parsed = parseAiResponse(result.text, safeRows)

  return {
    changes: parsed.changes,
    summary: parsed.summary,
    usage: {
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUSD: result.usage.costUSD,
      model: result.usage.model,
    },
  }
}

// ── Prompt builder ─────────────────────────────────────────────────────────

function buildPrompt(p: {
  instruction: string
  channel: string
  marketplace: string
  colList: string
  rowJson: string
  rowCount: number
}): string {
  return `You are an expert e-commerce content assistant for Xavia, an Italian motorcycle gear brand selling on ${p.channel} in marketplace ${p.marketplace}.

You are working with a flat file containing ${p.rowCount} product rows.

AVAILABLE COLUMNS (id: label):
${p.colList}

CURRENT ROW DATA:
${p.rowJson}

THE OPERATOR HAS GIVEN YOU THIS INSTRUCTION:
"${p.instruction}"

YOUR TASK:
Analyse the rows and the instruction. Return a JSON object with the proposed changes.

RESPOND WITH ONLY THIS JSON STRUCTURE — no prose, no markdown fences:
{
  "changes": [
    {
      "rowId": "<_rowId value from the row>",
      "sku": "<sku value from the row>",
      "field": "<column id to modify>",
      "newValue": "<new value — string, number, or array of strings>"
    }
  ],
  "summary": "<one or two sentences describing what you changed and why>"
}

RULES:
- Use "rowId" from the _rowId field in each row (if present) OR generate a stable identifier from the row's sku
- Only propose changes that the instruction explicitly or clearly implies
- Skip rows that already have valid, non-empty content in the target field UNLESS the instruction says to overwrite
- For Italian content: write in Italian unless the instruction specifies another language
- Amazon character limits: item_name ≤ 200 chars, bullet_point ≤ 500 chars each
- eBay character limits: title ≤ 80 chars
- For price fields: return numeric values (no currency symbols)
- For bullet_point or bullets fields: return an array of strings, not a single string
- If no changes are needed (all rows already have the content), return an empty changes array with an explanatory summary
- Return ONLY valid JSON`
}

// ── Response parser ────────────────────────────────────────────────────────

interface RawAiChange {
  rowId?: string
  sku?: string
  field?: string
  newValue?: unknown
}

interface RawAiResponse {
  changes?: RawAiChange[]
  summary?: string
}

function parseAiResponse(
  text: string,
  rows: Array<Record<string, unknown>>,
): { changes: FlatFileAiChange[]; summary: string } {
  // Strip markdown fences if present despite instructions
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

  let parsed: RawAiResponse
  try {
    parsed = JSON.parse(cleaned) as RawAiResponse
  } catch {
    logger.warn('[flat-file-ai] Claude response not valid JSON', { preview: text.slice(0, 200) })
    return { changes: [], summary: 'Claude returned an unparseable response. Please try again.' }
  }

  const rawChanges = Array.isArray(parsed.changes) ? parsed.changes : []
  const summary = typeof parsed.summary === 'string' ? parsed.summary : `${rawChanges.length} change(s) proposed.`

  // Build a rowId → row lookup for oldValue extraction
  const rowByRowId = new Map<string, Record<string, unknown>>()
  const rowBySku = new Map<string, Record<string, unknown>>()
  for (const r of rows) {
    if (r._rowId) rowByRowId.set(String(r._rowId), r)
    if (r.sku) rowBySku.set(String(r.sku), r)
  }

  const changes: FlatFileAiChange[] = []
  for (const c of rawChanges) {
    if (!c.field || c.newValue == null) continue
    const rowId = c.rowId ?? c.sku ?? ''
    const sku = c.sku ?? ''
    const row = rowByRowId.get(rowId) ?? rowBySku.get(sku) ?? {}
    const oldValue = row[c.field] ?? null

    // Skip no-ops (same value)
    if (String(oldValue) === String(c.newValue)) continue

    changes.push({
      rowId,
      sku,
      field: c.field,
      oldValue,
      newValue: c.newValue,
    })
  }

  return { changes, summary }
}
