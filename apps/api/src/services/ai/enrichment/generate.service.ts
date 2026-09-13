import { normalizeLanguage } from '../../pim/content-language.js'
/**
 * PES.8 — run an enrichment batch.
 *
 * This service has NO route to `Product`. It reads the catalogue and writes
 * `ProductAiDraft` rows, full stop. That is not a convention to be careful
 * about — it is why an AI value cannot become a confirmed catalogue value
 * without an operator approving it. The only writer is `approveDrafts`.
 *
 * Composition, not reimplementation: the provider registry, the per-feature
 * model resolver, the four-horizon budget gate, the outbound prompt sanitiser
 * and the usage ledger already exist and are already wired to the kill switch.
 * This adds the one thing they had no notion of — the channel's own caps — and
 * the draft lifecycle.
 *
 * `dryRun` is a first-class mode, not a debugging flag: it builds every prompt
 * and prices every call, and returns without spending a cent. It is what the
 * operator sees before agreeing to a batch.
 */
import { createHash } from 'node:crypto'
import prisma from '../../../db.js'
import { languageForMarketplace } from '../../products/translation-resolver.service.js'
import { parseAiJson } from '../../pim/mapping-suggest-ai.service.js'
import { getSheetColumns } from '../../pim/sheet-columns.service.js'
import { checkBudget, estimateCallCostUSD } from '../budget.service.js'
import { getProviderForFeature, resolveModelForFeature } from '../model-resolver.service.js'
import { isAiKillSwitchOn } from '../providers/index.js'
import { sanitizeOutboundPrompt } from '../prompt-sanitizer.js'
import { logUsage } from '../usage-logger.service.js'
import type { CellAddress } from './cell-key.js'
import { draftableConstraints, type CellConstraint } from './constraints.js'
import {
  isDraftableField,
  loadCurrentValues,
  recordDrafts,
  type DraftInput,
} from './draft.service.js'
import { buildEnrichmentPrompt, type ProductPromptContext } from './prompt.js'
import { draftsFromResponse, hashPromptField } from './response.js'

/** The AI feature key this lane bills and resolves its model under. */
export const ENRICHMENT_FEATURE = 'product-enrichment'

/**
 * Output ceiling for one call, scaled to the chunk.
 *
 * A flat 4096 made the cost estimate four times more pessimistic than the work
 * once chunking split a 47-column product into four calls: the estimate prices
 * `max_tokens` in full, so a ceiling nobody approaches is a forecast nobody can
 * use. ~260 tokens covers a long bullet or a capped description, plus headroom
 * for the JSON envelope and the per-field reason.
 */
function outputCeilingFor(fieldCount: number): number {
  return Math.min(4096, 400 + fieldCount * 260)
}
/** A batch bigger than this is a mistake, not an intention. */
const MAX_PRODUCTS_PER_RUN = 50
/**
 * Fields per call.
 *
 * Measured on the real IT catalogue 2026-09-01: a master-scope run on one
 * XAVIA product (OUTERWEAR) put 60 draftable columns in scope. Asking for all
 * 60 in one response is two failures waiting — the answer runs past
 * MAX_OUTPUT_TOKENS and gets truncated mid-JSON, and the fields at the end get
 * the model's attention only after it has written fifty others. Chunking costs
 * one extra prompt per chunk (the product context is re-sent) and buys a whole
 * response's worth of attention per group of fields.
 */
const MAX_FIELDS_PER_CALL = 12

export interface EnrichmentScope {
  /** null = the master scope. */
  channel: string | null
  /** Required when `channel` is set. */
  marketplace: string | null
  aliasId?: string | null
  locale?: string | null
}

export interface RunEnrichmentInput {
  productIds: string[]
  /** Market whose column set (and therefore whose caps) applies. */
  market: string
  scope: EnrichmentScope
  /** Restrict to these column keys / write fields. Empty = every draftable cell. */
  columns?: string[]
  /** Build and price the batch without calling the vendor. */
  dryRun?: boolean
  provider?: string | null
  userId?: string | null
}

export interface PerProductPlan {
  productId: string
  sku: string
  /** Draftable cells in scope for this product. */
  cellCount: number
  /** Vendor calls this product needs — its cells chunked by MAX_FIELDS_PER_CALL. */
  callCount: number
  estimatedCostUSD: number
  estimatedInputTokens: number
}

export interface RunEnrichmentResult {
  runId: string
  dryRun: boolean
  provider: string | null
  model: string | null
  /**
   * Vendor calls the batch will make: products x field-chunks. This is the
   * number the cost estimate is built from and the one the operator agrees to.
   */
  callCount: number
  /** Upper-bound forecast. Present on a dry run and on a real run alike. */
  estimatedCostUSD: number
  /** Input tokens the forecast is built from, summed across calls. */
  estimatedInputTokens: number
  /** Output ceiling the forecast prices, summed across calls. Not a prediction
   *  of length — the ceiling the request will carry. */
  estimatedOutputCeiling: number
  /** What the vendor actually billed. Zero on a dry run. */
  actualCostUSD: number
  plan: PerProductPlan[]
  draftsCreated: number
  draftsSuperseded: number
  /** Drafts stored `failed` because the model broke a hard cap. */
  draftsFailed: number
  /** Columns in scope, so the operator can see what a run covers. */
  columnsInScope: Array<{
    columnKey: string
    label: string
    maxLength?: number
    maxBytes?: number
    capFrom?: string
  }>
  budgetWarn?: string
  /** Per-product problems that did not sink the batch. */
  issues: Array<{ productId: string; message: string }>
  /** Why nothing ran, when nothing ran. */
  refusedReason?: string
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function scopeLabel(scope: EnrichmentScope): string {
  if (scope.channel === null) return 'the master record'
  return `${scope.channel} - ${scope.marketplace}`
}

function addressFor(scope: EnrichmentScope, writeField: string): CellAddress {
  return {
    channel: scope.channel,
    marketplace: scope.marketplace,
    aliasId: scope.aliasId ?? null,
    locale: scope.locale ? normalizeLanguage(scope.locale) : null,
    writeField,
  }
}

/**
 * Constraints are keyed by the SHEET column key, but a draft has to be written
 * through `writeField`. A column whose write field the bulk PATCH does not
 * accept is dropped here rather than drafted and refused at approve time —
 * offering the operator a value that can never be applied wastes their review.
 */
function applicableConstraints(all: CellConstraint[], scope: EnrichmentScope): CellConstraint[] {
  // A locale-scoped run is a TRANSLATION run: it targets the four keys ProductTranslation stores
  // and nothing else. Attributes have no per-locale storage, so drafting one here would produce a
  // value with no address to apply to.
  if (scope.locale) {
    return all.filter((c) => isDraftableField(c.writeField, scope.locale) && scope.channel === null)
  }
  return all.filter((c) => {
    if (!isDraftableField(c.writeField)) return false
    // A channel-scope run drafts channel fields; a master run drafts master
    // ones. Mixing them would put an `amazon_title` draft on the master sheet.
    const isChannelField = c.writeField.startsWith('amazon_') || c.writeField.startsWith('ebay_')
    return scope.channel === null ? !isChannelField : isChannelField
  })
}

export async function runEnrichment(input: RunEnrichmentInput): Promise<RunEnrichmentResult> {
  const runId = createHash('sha256')
    .update(`${Date.now()}:${input.productIds.join(',')}:${Math.random()}`)
    .digest('hex')
    .slice(0, 24)

  const empty = (refusedReason?: string): RunEnrichmentResult => ({
    runId,
    dryRun: input.dryRun === true,
    provider: null,
    model: null,
    callCount: 0,
    estimatedCostUSD: 0,
    actualCostUSD: 0,
    plan: [],
    draftsCreated: 0,
    draftsSuperseded: 0,
    draftsFailed: 0,
    columnsInScope: [],
    issues: [],
    estimatedInputTokens: 0,
    estimatedOutputCeiling: 0,
    refusedReason,
  })

  const productIds = [...new Set(input.productIds)].filter(Boolean)
  if (productIds.length === 0) return empty('No products selected.')
  if (productIds.length > MAX_PRODUCTS_PER_RUN) {
    return empty(
      `A run covers at most ${MAX_PRODUCTS_PER_RUN} products; ${productIds.length} were selected.`,
    )
  }
  if (input.scope.channel !== null && !input.scope.marketplace) {
    return empty('A channel scope needs a marketplace.')
  }
  if (isAiKillSwitchOn()) {
    return empty('AI is disabled (NEXUS_AI_KILL_SWITCH is on).')
  }

  const products = await prisma.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      sku: true,
      name: true,
      brand: true,
      productType: true,
      description: true,
      bulletPoints: true,
      keywords: true,
      categoryAttributes: true,
    },
  })
  if (products.length === 0) return empty('None of the selected products exist.')

  const productTypes = [...new Set(products.map((p) => p.productType).filter(Boolean))] as string[]
  /**
   * `includeEmptyChannels` + `onlyChannels` (BE.1 #298, PES.5 #248).
   *
   * Without the flag, `getSheetColumns` drops any coordinate that carries no `ChannelListing`
   * ANYWHERE in the catalogue — so a channel × market nobody has listed on yet contributes no
   * columns, and enrichment reports "no draftable columns" on exactly the create path where an
   * operator most wants a draft. Measured on the real catalogue: DE goes from 96 columns to 101
   * with the flag, the difference being every eBay DE column.
   *
   * `onlyChannels` narrows the coordinate set to the scope being drafted, which is both correct
   * (a channel run should be capped by ITS channel, not by the tightest across all of them) and
   * cheaper.
   */
  const columnSet = await getSheetColumns({
    market: input.market,
    productTypes,
    includeEmptyChannels: true,
    ...(input.scope.channel ? { onlyChannels: [input.scope.channel] } : {}),
  })
  const constraints = applicableConstraints(
    draftableConstraints(columnSet.columns, input.columns),
    input.scope,
  )
  if (constraints.length === 0) {
    /**
     * A channel scope with NO per-channel write fields is not a failure — it is a fact about that
     * channel, and it deserves its own sentence.
     *
     * Readiness offers a scope chip for every configured coordinate, Shopify / WooCommerce / Etsy
     * included. Measured: a SHOPIFY·GLOBAL coordinate carries 30 columns and not one of them is a
     * per-channel field — they are all the MASTER's (brand, name, description, sku). Those channels
     * have no content layer of their own, and `PATCH /api/products/bulk` wires channel writes for
     * `amazon_*` and `ebay_*` only. So there is genuinely nothing channel-level to draft, and
     * drafting the master's values under a channel chip would misrepresent what the operator is
     * editing. "No draftable columns in this scope" reads like a bug; this reads like the truth.
     */
    if (input.scope.channel && !['AMAZON', 'EBAY'].includes(input.scope.channel)) {
      return empty(
        `${input.scope.channel} has no per-channel content of its own — its title and description ` +
          `are the master's. Run enrichment on the Master scope instead.`,
      )
    }
    return empty(
      productTypes.length === 0
        ? 'None of the selected products have a product type, so no channel schema applies and there are no caps to write within.'
        : 'No draftable columns in this scope.',
    )
  }

  const provider = await getProviderForFeature(ENRICHMENT_FEATURE, input.provider)
  if (!provider) {
    return empty('No AI provider is configured (set ANTHROPIC_API_KEY on the API server).')
  }
  const model = await resolveModelForFeature(ENRICHMENT_FEATURE, provider)

  const language = input.scope.marketplace
    ? await languageForMarketplace(input.scope.marketplace, input.scope.channel ?? 'AMAZON')
    : await languageForMarketplace(input.market, 'AMAZON')

  // What each target cell holds right now — the diff's left-hand side and the
  // baseline every staleness check is later made against.
  const addresses = constraints.map((c) => addressFor(input.scope, c.writeField))
  const current = await loadCurrentValues(
    products.map((p) => p.id),
    addresses,
  )

  const columnsInScope = constraints.map((c) => ({
    columnKey: c.columnKey,
    label: c.label,
    maxLength: c.maxLength,
    maxBytes: c.maxBytes,
    capFrom: c.capFrom,
  }))

  // Build every prompt first, so a dry run is the real thing minus the call.
  const fieldGroups = chunk(constraints, MAX_FIELDS_PER_CALL)
  const jobs = products.flatMap((p) => {
    const currentValues: Record<string, unknown> = {}
    for (const c of constraints) {
      currentValues[c.columnKey] = current.get(p.id, addressFor(input.scope, c.writeField)).value
    }
    const ctx: ProductPromptContext = {
      id: p.id,
      sku: p.sku,
      name: p.name,
      brand: p.brand,
      productType: p.productType,
      description: p.description,
      bulletPoints: p.bulletPoints ?? [],
      keywords: p.keywords ?? [],
      knownAttributes: (p.categoryAttributes as Record<string, unknown> | null) ?? {},
    }
    return fieldGroups.map((group) => {
      const raw = buildEnrichmentPrompt({
        product: ctx,
        constraints: group,
        scopeLabel: scopeLabel(input.scope),
        language,
        currentValues,
      })
      // Redact before pricing as well as before sending: the sanitised text is
      // what actually goes out, so it is what the estimate must be based on.
      const { sanitized, redactions } = sanitizeOutboundPrompt(raw)
      return { product: p, constraints: group, prompt: sanitized, redactions }
    })
  })

  // The plan is per PRODUCT, because that is the unit the operator selected;
  // a product's figure sums its chunks.
  const perCallCost = jobs.map((j) =>
    estimateCallCostUSD({
      prompt: j.prompt,
      maxOutputTokens: outputCeilingFor(j.constraints.length),
      provider: provider.name,
      model,
    }),
  )
  const plan: PerProductPlan[] = products.map((p) => {
    const mine = jobs.map((j, i) => ({ j, cost: perCallCost[i] })).filter((x) => x.j.product.id === p.id)
    return {
      productId: p.id,
      sku: p.sku,
      cellCount: constraints.length,
      callCount: mine.length,
      estimatedInputTokens: mine.reduce((s, x) => s + Math.ceil(x.j.prompt.length / 4), 0),
      estimatedCostUSD: mine.reduce((s, x) => s + x.cost, 0),
    }
  })
  const estimatedCostUSD = perCallCost.reduce((s, c) => s + c, 0)
  const estimatedInputTokens = jobs.reduce((s, j) => s + Math.ceil(j.prompt.length / 4), 0)
  const estimatedOutputCeiling = jobs.reduce((s, j) => s + outputCeilingFor(j.constraints.length), 0)

  if (input.dryRun) {
    return {
      runId,
      dryRun: true,
      provider: provider.name,
      model,
      callCount: jobs.length,
      estimatedCostUSD,
      estimatedInputTokens,
      estimatedOutputCeiling,
      actualCostUSD: 0,
      plan,
      draftsCreated: 0,
      draftsSuperseded: 0,
      draftsFailed: 0,
      columnsInScope,
      issues: [],
    }
  }

  // Real run.
  const drafts: DraftInput[] = []
  const issues: Array<{ productId: string; message: string }> = []
  let actualCostUSD = 0
  let budgetWarn: string | undefined

  for (const job of jobs) {
    const ceiling = outputCeilingFor(job.constraints.length)
    const estimate = estimateCallCostUSD({
      prompt: job.prompt,
      maxOutputTokens: ceiling,
      provider: provider.name,
      model,
    })
    const budget = await checkBudget(estimate, {
      feature: ENRICHMENT_FEATURE,
      userId: input.userId ?? undefined,
    })
    if (!budget.allowed) {
      // Stop the whole batch: the horizons are cumulative, so every remaining
      // product would be refused for the same reason. Half a batch with a
      // clear reason beats forty identical refusals.
      issues.push({
        productId: job.product.id,
        message: budget.message ?? 'Budget ceiling reached.',
      })
      break
    }
    if (budget.hitWarn) budgetWarn = budget.hitWarn

    const startedAt = Date.now()
    let text: string
    try {
      const res = await provider.generate({
        prompt: job.prompt,
        model,
        jsonMode: true,
        temperature: 0.3,
        maxOutputTokens: ceiling,
        feature: ENRICHMENT_FEATURE,
        entityType: 'Product',
        entityId: job.product.id,
      })
      text = res.text
      actualCostUSD += res.usage.costUSD
      logUsage({
        provider: res.usage.provider,
        model: res.usage.model,
        feature: ENRICHMENT_FEATURE,
        entityType: 'Product',
        entityId: job.product.id,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUSD: res.usage.costUSD,
        latencyMs: Date.now() - startedAt,
        ok: true,
        userId: input.userId ?? undefined,
        metadata: {
          runId,
          scope: scopeLabel(input.scope),
          market: input.market,
          cells: job.constraints.length,
          redactions: job.redactions,
        },
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logUsage({
        provider: provider.name,
        model,
        feature: ENRICHMENT_FEATURE,
        entityType: 'Product',
        entityId: job.product.id,
        inputTokens: 0,
        outputTokens: 0,
        costUSD: 0,
        latencyMs: Date.now() - startedAt,
        ok: false,
        errorMessage: message,
        userId: input.userId ?? undefined,
        metadata: { runId },
      })
      issues.push({ productId: job.product.id, message: `AI call failed: ${message}` })
      continue
    }

    const parsed = parseAiJson(text)
    const fields = (parsed.fields ?? parsed) as Record<string, unknown>
    if (!fields || typeof fields !== 'object') {
      issues.push({ productId: job.product.id, message: 'Model returned no usable JSON.' })
      continue
    }

    // Only the fields THIS call asked for. A model answering with a field from
    // another chunk is answering without having been shown that field's caps.
    // The rules themselves live in response.ts so they can be tested without a
    // vendor call — under ruling #13 this path has no other way to be exercised.
    drafts.push(
      ...draftsFromResponse({
        fields,
        constraints: job.constraints,
        productId: job.product.id,
        market: input.market,
        addressFor: (writeField) => addressFor(input.scope, writeField),
        currentValue: (address) => current.get(job.product.id, address),
        promptHash: (writeField) => hashPromptField(job.prompt, writeField),
      }),
    )
  }

  const { created, superseded } = await recordDrafts(runId, provider.name, model, drafts)

  return {
    runId,
    dryRun: false,
    provider: provider.name,
    model,
    callCount: jobs.length,
    estimatedCostUSD,
    estimatedInputTokens,
    estimatedOutputCeiling,
    actualCostUSD,
    plan,
    draftsCreated: created,
    draftsSuperseded: superseded,
    draftsFailed: drafts.filter((d) => d.status === 'failed').length,
    columnsInScope,
    issues,
    budgetWarn,
  }
}
