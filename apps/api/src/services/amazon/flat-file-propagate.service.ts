/**
 * Flat-File Propagate Service
 *
 * Copies flat-file data from a source marketplace to one or more target
 * marketplaces for the same product type. Used when products are already
 * live on all markets and you want to hydrate the flat file editor for
 * each market from an already-pulled source rather than calling Amazon
 * again per market.
 *
 * Per target market:
 *   1. Verbatim copy of all structural + numeric + image fields
 *   2. AI text translation of title / description / bullet points (optional)
 *   3. AI enum mapping of locale-specific option values (optional)
 *   4. Sync to ChannelListing via syncRowsToPlatform
 *
 * Job lifecycle matches flat-file-pull.service — in-memory, polled every 3 s.
 */

import prisma from '../../db.js'
import { getProvider, isAiKillSwitchOn } from '../ai/providers/index.js'
import { logUsage } from '../ai/usage-logger.service.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import { AmazonFlatFileService } from './flat-file.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { translateEnumValues } from './value-translate.service.js'
import type { FlatFileRow } from './flat-file.service.js'

// ── Language maps ──────────────────────────────────────────────────────────

const MARKET_LANGUAGE: Record<string, string> = {
  IT: 'Italian', DE: 'German', FR: 'French', ES: 'Spanish', UK: 'English (UK)',
}

// Fields that carry locale-specific free text and should be AI-translated
const TEXT_FIELDS = [
  'item_name',
  'product_description',
  'generic_keyword',
  'bullet_point',
  'bullet_point_1', 'bullet_point_2', 'bullet_point_3',
  'bullet_point_4', 'bullet_point_5',
]

// Fields that are market-agnostic and must never be translated
const SKIP_TRANSLATE = new Set([
  // Internal
  '_rowId', '_productId', '_isNew', '_dirty', '_status', '_feedMessage', '_asin', '_listingStatus',
  // Structural
  'item_sku', 'product_type', 'record_action', 'parentage_level', 'parent_sku', 'variation_theme',
  // Pricing / qty (user adjusts per market)
  'purchasable_offer', 'standard_price', 'sale_price', 'fulfillment_availability', 'quantity',
  // Images
  'main_product_image_locator', 'swatch_image_locator',
  'other_image_locator_1', 'other_image_locator_2', 'other_image_locator_3', 'other_image_locator_4',
])

// ── Job types ──────────────────────────────────────────────────────────────

export interface PropagateMarketState {
  status: 'pending' | 'running' | 'done' | 'failed'
  phase: 'copy' | 'text' | 'enums' | 'sync' | 'idle'
  translated: number
  total: number
  errors: string[]
  rows: any[]
}

export interface PropagateJob {
  jobId: string
  sourceMarket: string
  targetMarkets: string[]
  productType: string
  options: { translateText: boolean; translateEnums: boolean }
  status: 'running' | 'done' | 'failed'
  markets: Record<string, PropagateMarketState>
  startedAt: string
  doneAt?: string
  fatalError?: string
}

// ── In-memory store ────────────────────────────────────────────────────────

const JOB_TTL_MS = 2 * 60 * 60 * 1000
const propagateJobs = new Map<string, PropagateJob>()

function prune() {
  const cutoff = Date.now() - JOB_TTL_MS
  for (const [id, job] of propagateJobs) {
    if (new Date(job.startedAt).getTime() < cutoff) propagateJobs.delete(id)
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

export function startPropagateJob(
  sourceMarket: string,
  targetMarkets: string[],
  productType: string,
  options: { translateText: boolean; translateEnums: boolean },
): string {
  prune()
  const jobId = `ffprop-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const markets: PropagateJob['markets'] = {}
  for (const mp of targetMarkets) {
    markets[mp.toUpperCase()] = {
      status: 'pending', phase: 'idle', translated: 0, total: 0, errors: [], rows: [],
    }
  }
  const job: PropagateJob = {
    jobId,
    sourceMarket: sourceMarket.toUpperCase(),
    targetMarkets: targetMarkets.map((m) => m.toUpperCase()),
    productType: productType.toUpperCase(),
    options,
    status: 'running',
    markets,
    startedAt: new Date().toISOString(),
  }
  propagateJobs.set(jobId, job)
  void runPropagateJob(job).catch((err) => {
    job.status = 'failed'
    job.fatalError = err instanceof Error ? err.message : String(err)
    job.doneAt = new Date().toISOString()
  })
  return jobId
}

export function getPropagateJobStatus(jobId: string): PropagateJob | null {
  return propagateJobs.get(jobId) ?? null
}

// ── Core job ───────────────────────────────────────────────────────────────

async function runPropagateJob(job: PropagateJob): Promise<void> {
  const { sourceMarket, productType, targetMarkets, options } = job

  const amazon = new AmazonService()
  const schemaService = new CategorySchemaService(prisma, amazon)
  const flatFileService = new AmazonFlatFileService(prisma, schemaService)

  // Load source rows — must have been pulled from Amazon already
  const sourceRows = await flatFileService.getExistingRows(sourceMarket, productType)
  if (!sourceRows.length) {
    job.status = 'failed'
    job.fatalError = `No rows for ${sourceMarket}/${productType} — pull from Amazon first`
    job.doneAt = new Date().toISOString()
    return
  }

  // Get source manifest for expandedFields (needed by syncRowsToPlatform)
  let expandedFields: Record<string, string> = {}
  try {
    const manifest = await flatFileService.generateManifest(sourceMarket, productType)
    expandedFields = manifest?.expandedFields ?? {}
  } catch { /* proceed without — sync will use generic collapse */ }

  // Process target markets sequentially (rate-limit friendly for AI calls)
  for (const targetMarket of targetMarkets) {
    const state = job.markets[targetMarket]
    state.status = 'running'
    state.total = sourceRows.length

    try {
      // 1. Verbatim copy
      state.phase = 'copy'
      let rows: FlatFileRow[] = sourceRows.map((r) => ({ ...r, _dirty: true, _status: 'idle' as const }))

      // 2. Translate text fields
      if (options.translateText) {
        state.phase = 'text'
        rows = await translateTextBatch(rows, sourceMarket, targetMarket)
      }

      // 3. Translate enum values
      if (options.translateEnums) {
        state.phase = 'enums'
        rows = await translateEnumBatch(rows, sourceMarket, targetMarket, productType)
      }

      // 4. Sync to platform DB
      state.phase = 'sync'
      await flatFileService.syncRowsToPlatform(rows, targetMarket, expandedFields, { isPublished: false })

      state.rows = rows
      state.translated = rows.length
      state.status = 'done'
      state.phase = 'idle'
    } catch (err: any) {
      state.status = 'failed'
      state.phase = 'idle'
      state.errors.push(err?.message ?? 'Failed')
    }
  }

  job.status = 'done'
  job.doneAt = new Date().toISOString()
}

// ── Text translation ───────────────────────────────────────────────────────

async function translateTextBatch(
  rows: FlatFileRow[],
  sourceMarket: string,
  targetMarket: string,
): Promise<FlatFileRow[]> {
  if (isAiKillSwitchOn()) return rows
  const provider = getProvider(null)
  if (!provider) return rows

  const srcLang = MARKET_LANGUAGE[sourceMarket] ?? sourceMarket
  const tgtLang = MARKET_LANGUAGE[targetMarket] ?? targetMarket

  // Build flat key-value batch: "r{i}_{field}" → value
  const batch: Record<string, string> = {}
  for (let i = 0; i < rows.length; i++) {
    for (const field of TEXT_FIELDS) {
      const val = String(rows[i][field] ?? '').trim()
      if (val) batch[`r${i}_${field}`] = val
    }
  }
  if (!Object.keys(batch).length) return rows

  const prompt = [
    `Translate these Amazon product listing fields from ${srcLang} to ${tgtLang}.`,
    `Rules:`,
    `- Keep brand names, model names, sizes, and technical measurements unchanged.`,
    `- Do not add or remove any keys.`,
    `- Return strict JSON only — no commentary.`,
    ``,
    JSON.stringify(batch, null, 2),
  ].join('\n')

  const startedAt = Date.now()
  try {
    const res = await provider.generate({
      prompt,
      jsonMode: true,
      maxOutputTokens: 4096,
      temperature: 0.1,
      feature: 'ff-propagate-text',
    })
    logUsage({
      provider: res.usage.provider,
      model: res.usage.model,
      feature: 'ff-propagate-text',
      inputTokens: res.usage.inputTokens,
      outputTokens: res.usage.outputTokens,
      costUSD: res.usage.costUSD,
      latencyMs: Date.now() - startedAt,
      ok: true,
    })

    let translated: Record<string, string> = {}
    try {
      const raw = res.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
      translated = JSON.parse(raw)
    } catch { return rows }

    return rows.map((row, i) => {
      const updated = { ...row }
      for (const field of TEXT_FIELDS) {
        const key = `r${i}_${field}`
        if (translated[key] && typeof translated[key] === 'string') {
          updated[field] = translated[key]
        }
      }
      return updated
    })
  } catch (err) {
    logUsage({
      provider: provider.name,
      model: provider.defaultModel,
      feature: 'ff-propagate-text',
      inputTokens: 0, outputTokens: 0, costUSD: 0,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorMessage: err instanceof Error ? err.message : String(err),
    })
    return rows
  }
}

// ── Enum translation ───────────────────────────────────────────────────────

async function translateEnumBatch(
  rows: FlatFileRow[],
  sourceMarket: string,
  targetMarket: string,
  productType: string,
): Promise<FlatFileRow[]> {
  // Collect candidate columns: non-structural, non-text, non-numeric string values
  const candidates = new Map<string, Set<string>>() // colId → distinct values
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (
        k.startsWith('_') ||
        SKIP_TRANSLATE.has(k) ||
        TEXT_FIELDS.includes(k) ||
        !v || typeof v !== 'string' || !v.trim() ||
        k.includes('image_locator') ||
        !isNaN(Number(v))
      ) continue
      if (!candidates.has(k)) candidates.set(k, new Set())
      candidates.get(k)!.add(v.trim())
    }
  }
  if (!candidates.size) return rows

  const updatedRows = rows.map((r) => ({ ...r }))

  // Translate each candidate column — translateEnumValues handles "no enum options" gracefully
  for (const [colId, valueSet] of candidates) {
    const values = [...valueSet]
    try {
      const result = await translateEnumValues(prisma, {
        sourceMarket,
        productType,
        colId,
        values,
        targetMarkets: [targetMarket],
      })
      const mappings = result.mappings[targetMarket.toUpperCase()]
      if (!mappings) continue

      for (const row of updatedRows) {
        const srcVal = String(row[colId] ?? '').trim()
        if (!srcVal) continue
        const mapping = mappings[srcVal]
        if (mapping?.match && mapping.valid) row[colId] = mapping.match
      }
    } catch { /* skip column on error */ }
  }

  return updatedRows
}
