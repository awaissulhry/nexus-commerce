/**
 * MCP full control P8 — the two structure changes whose effect reaches every listing that follows them: a channel
 * mapping (field rules, value maps, size conversions) and a listing template (an eBay description theme, a listing
 * preset). Decision P-2: Claude may ask for them; a person always approves (alwaysAsk, `ask` at most — never auto),
 * and every preview says how much it touches.
 *
 * save-channel-mapping
 *   rules       field rules for one market (optionally one channel category): the dry run computes the SAME review
 *               the mapping page runs (pim/mapping/impact.service.ts), in memory — no review row is written — and
 *               says how many listings change, how many values, which overrides are kept, and refuses a change that
 *               would make values invalid. A market with more than 2,000 listings is refused with the reason (Nexus's
 *               mapping review scans those in the background). On approval the stored review runs, its counts must
 *               equal the approved ones, and it is activated through the page's own path; the mapping revision it
 *               leaves holds the rules it replaced, and undo restores that revision (`restoreRevisionId`).
 *   restore     put a saved revision back (what undo asks for), through the same review.
 *   value-map   value translations (master value → channel value) for one channel and market; impact: the rules
 *               that use the attribute's map and the listings whose products hold the value.
 *   size-scale  size conversions (system → system); impact: the mapping rules that use the scale.
 *   Nothing is sent from here: listings take the new rule at their next publish or sync (openWorld).
 *
 * save-listing-template
 *   description-theme  name, HTML, notes, active of an eBay description theme; impact: the eBay listings it wraps
 *                      (assigned, through the default, or through a presentation rule). eBay keeps the HTML it was
 *                      sent until a person re-publishes, so a theme change marks those descriptions stale and sends
 *                      nothing by itself.
 *   preset             name, description, category hint of a listing preset (its channels and defaults stay fixed,
 *                      as on the page); impact: how often it was applied. Presets are applied, never followed.
 *   Edits only: creating a theme or a preset stays in Nexus (an undo of a creation would have to delete it).
 *
 * Every dry run is a pure read in the caller's business: another business's market, theme or preset is not found.
 */

import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { mappingToken, MappingConflict } from '../../pim/mapping/revision-token.js'
import type { MappingChange } from '../../pim/mapping/impact.service.js'
import { getMappingForMarketplace, InvalidMappingError, type FieldMappingRule, type MarketplaceSchemaMapping } from '../../pim/schema-mapping.service.js'
import { removeSizeScale, removeValueMap, upsertSizeScale, upsertValueMap } from '../../pim/value-map.service.js'
import type { AgentTool, ToolContext, ToolResult, ToolUndo } from '../tool-types.js'
import { safeText } from './claude-safe.js'

/**
 * The mapping review, loaded when a mapping is previewed or saved — not when the tool registry loads: it brings the
 * field catalogue and every channel's specs (with their account and gateway services), which nothing that only loads
 * the registry (the approval inbox, its tests) may pull in.
 */
const impactService = () => import('../../pim/mapping/impact.service.js')

const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const canonical = (value: unknown): string => {
  const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted)
      : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]))
        : v
  return JSON.stringify(sorted(JSON.parse(JSON.stringify(value ?? null))))
}
const hashOf = (text: string) => createHash('sha256').update(text).digest('hex').slice(0, 16)

/** At most this many changed fields or entries are listed in a preview; the rest are counted. */
const SHOWN = 20

// ── save-channel-mapping ──────────────────────────────────────────────────────────────────────────────

const MAPPING_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
const MAPPING_KINDS = ['rules', 'value-map', 'size-scale', 'restore'] as const
type MappingKind = (typeof MAPPING_KINDS)[number]

const RULE = z.object({
  source: z.string().max(500).describe('the master attribute path the value comes from (e.g. name, brand, attributes.color); may be empty when a transform makes the value'),
  fallback: z.string().max(500).optional().describe('the path used when the source is empty'),
  transforms: z.array(z.record(z.string(), z.unknown())).max(20).optional()
    .describe('ordered transform steps as the mapping editor writes them, e.g. {"type":"truncate","max":80} or {"type":"valueMap","attribute":"color"}'),
  required: z.boolean().optional().describe('true when a publish must find a value for this field'),
  notes: z.string().max(500).optional().describe('why the rule exists, shown in the mapping editor'),
})

const mappingInput = z.object({
  channel: z.preprocess(upper, z.enum(MAPPING_CHANNELS)).describe('the channel whose mapping changes'),
  market: z.string().trim().toUpperCase().min(2).max(20)
    .describe('the marketplace code, e.g. IT or DE; GLOBAL for single-store channels such as Shopify and Etsy'),
  kind: z.enum(MAPPING_KINDS).optional()
    .describe('what changes: rules (default), value-map, size-scale, or restore (put a saved revision back; given restoreRevisionId it is implied)'),
  category: z.string().trim().min(1).max(120).optional()
    .describe('rules only: the channel category (product type) the rules are for; omit for the whole market'),
  rules: z.array(z.object({
    fieldKey: z.string().trim().min(1).max(200).describe('the channel field, e.g. title or item_specifics.Brand'),
    rule: RULE.nullable().describe('the new rule; null removes this field\'s rule'),
  })).max(250).optional().describe('rules: the field rules to set or remove (at most 250 per request)'),
  valueMap: z.array(z.object({
    attribute: z.string().trim().min(1).max(120).describe('the master attribute, e.g. color'),
    fromValue: z.string().trim().min(1).max(200).describe('the master value, e.g. Rosso'),
    toValue: z.string().max(200).nullable().describe('the value the channel gets, e.g. Red; null removes the translation'),
  })).max(250).optional().describe('value-map: translations for this channel and market'),
  sizeScale: z.array(z.object({
    scale: z.string().trim().min(1).max(60).describe('the size scale, e.g. JACKETS'),
    fromSystem: z.string().trim().min(1).max(20).describe('the size system converted from, e.g. EU'),
    toSystem: z.string().trim().min(1).max(20).describe('the size system converted to, e.g. UK'),
    fromValue: z.string().trim().min(1).max(40).describe('the size in the first system, e.g. 52'),
    toValue: z.string().max(40).nullable().describe('the size in the second system, e.g. L; null removes the conversion'),
  })).max(250).optional().describe('size-scale: size conversions (they apply to every channel and market)'),
  restoreRevisionId: z.string().trim().min(1).max(64).optional()
    .describe('restore: the saved mapping revision to put back (undo-change asks with this)'),
})
type MappingArgs = z.infer<typeof mappingInput>

const MARKET_NOT_FOUND = 'Market not found'
const kindOf = (args: MappingArgs): MappingKind => args.kind ?? (args.restoreRevisionId ? 'restore' : 'rules')

/** The market in this business, or null. Every mapping change starts here, so another business's market is not found. */
const marketOf = (channel: string, market: string) =>
  prisma.marketplace.findFirst({ where: { channel, code: market }, select: { id: true, name: true, schemaMapping: true } })

/** The rules of one bucket (the market, or one category) that differ between two mappings, by field. */
function ruleDiff(before: MarketplaceSchemaMapping, after: MarketplaceSchemaMapping) {
  const out: Array<{ field: string; category: string | null; from: FieldMappingRule | null; to: FieldMappingRule | null }> = []
  const buckets: Array<[string | null, Record<string, FieldMappingRule>, Record<string, FieldMappingRule>]> = [[null, before.fields ?? {}, after.fields ?? {}]]
  for (const category of new Set([...Object.keys(before.byProductType ?? {}), ...Object.keys(after.byProductType ?? {})])) {
    buckets.push([category, before.byProductType?.[category] ?? {}, after.byProductType?.[category] ?? {}])
  }
  for (const [category, a, b] of buckets) {
    for (const field of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      if (field === 'variations' && category) continue // the variation rule of a category is not a field
      if (canonical(a[field] ?? null) !== canonical(b[field] ?? null)) out.push({ field, category, from: a[field] ?? null, to: b[field] ?? null })
    }
  }
  return out
}

/** A sample changed value of the review, as Claude reads it. */
const exampleOf = (row: Record<string, unknown>) => ({
  sku: row.sku, field: row.field, from: shortValue(row.before), to: shortValue(row.after), kept: row.preserved === true,
})
function shortValue(value: unknown): unknown {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value
  return safeText(typeof value === 'string' ? value : JSON.stringify(value), 160)
}

/** The review of a rules or restore change, computed in memory (no row): the preview, or a refusal. */
async function rulesPreview(args: MappingArgs, kind: 'rules' | 'restore'): Promise<ToolResult> {
  const { previewMappingImpact, PREVIEW_MAX_LISTINGS, PREVIEW_MAX_PRODUCTS } = await impactService()
  const before = await getMappingForMarketplace(args.channel, args.market)
  const token = mappingToken(before)
  let review
  try {
    review = await previewMappingImpact({
      channel: args.channel,
      market: args.market,
      expectedToken: token,
      userId: null,
      ...(kind === 'restore'
        ? { restoreRevisionId: args.restoreRevisionId }
        : { category: args.category ?? null, changes: (args.rules ?? []) as MappingChange[] }),
    })
  } catch (error) {
    if (error instanceof InvalidMappingError) {
      const missing = error.errors.some((e) => /Revision not found/.test(e))
      return { ok: false, error: missing ? 'Mapping revision not found' : `Not changed: ${error.errors.join('; ')}` }
    }
    if (error instanceof MappingConflict) return { ok: false, error: `Not changed: ${error.message}` }
    throw error
  }
  if (!review.ok) {
    const { listings, products } = review.tooLarge
    return {
      ok: false,
      error: `Not changed: this ${args.channel} ${args.market} mapping covers ${listings} listings and ${products} products — more than Claude reviews in one conversation (${PREVIEW_MAX_LISTINGS} listings, ${PREVIEW_MAX_PRODUCTS} products). Make this change in Nexus's mapping review, which scans them in the background.`,
    }
  }
  const { counts, payload } = review
  if (counts.introducedInvalid > 0) {
    const bad = review.examples.filter((row) => Array.isArray(row.errors) && (row.errors as unknown[]).length).slice(0, 3)
    return {
      ok: false,
      error: `Not changed: ${counts.introducedInvalid} value${counts.introducedInvalid === 1 ? '' : 's'} would become invalid under this mapping${bad.length ? ` (e.g. ${bad.map((row) => `${row.sku} ${row.field}: ${(row.errors as string[])[0]}`).join('; ')})` : ''}. Correct the rules and ask again.`,
    }
  }
  const diff = ruleDiff(before, payload.after)
  if (!diff.length) return { ok: false, error: 'Not changed: these rules are already the mapping.' }
  return {
    ok: true,
    preview: {
      action: 'save-channel-mapping',
      kind,
      channel: args.channel,
      market: args.market,
      ...(kind === 'rules' && args.category ? { category: args.category } : {}),
      ...(kind === 'restore' ? { restoreRevision: payload.restoreRevision ?? null } : {}),
      changes: diff.slice(0, SHOWN).map((row) => ({ field: row.field, category: row.category, from: row.from, to: row.to })),
      ...(diff.length > SHOWN ? { moreChanges: diff.length - SHOWN } : {}),
      impact: {
        listingsInMarket: review.listingsInScope,
        productsScanned: counts.scanned,
        productsMatched: counts.matchedProducts,
        listingsChanged: counts.affectedListings,
        valuesChanged: counts.changed,
        overridesKept: counts.preservedOverrides,
        invalidValues: counts.invalid,
        missingValues: counts.missing ?? 0,
      },
      examples: review.examples.map(exampleOf),
      // The mapping and every input the review read; a move of either makes the approval stale.
      basis: { token, inputToken: payload.inputToken ?? null },
      note: 'Saved in Nexus as the standing rule; each listing takes it at its next publish or sync. Overrides set on a listing are kept. Undo restores the rules this replaces.',
    },
  }
}

/** Value translations: what each one is now, what the change sets, and what follows them. */
async function valueMapPreview(args: MappingArgs): Promise<ToolResult> {
  const { PREVIEW_MAX_LISTINGS } = await impactService()
  const entries = args.valueMap ?? []
  if (!entries.length) return { ok: false, error: 'Not changed: name at least one value translation (valueMap).' }
  const keys = new Set<string>()
  for (const e of entries) {
    const key = `${e.attribute}\0${e.fromValue}`
    if (keys.has(key)) return { ok: false, error: `Not changed: ${e.attribute} "${e.fromValue}" is named twice.` }
    keys.add(key)
  }
  const current = await prisma.fieldValueMap.findMany({
    where: { channel: args.channel, marketplace: args.market, OR: entries.map((e) => ({ attribute: e.attribute, fromValue: e.fromValue })) },
    select: { attribute: true, fromValue: true, toValue: true },
  })
  const now = new Map(current.map((row) => [`${row.attribute}\0${row.fromValue}`, row.toValue]))
  const changes = entries
    .map((e) => ({ attribute: e.attribute, fromValue: e.fromValue, from: now.get(`${e.attribute}\0${e.fromValue}`) ?? null, to: e.toValue }))
    .filter((row) => row.from !== row.to)
  if (!changes.length) return { ok: false, error: 'Not changed: these translations are already set.' }
  const mapping = await getMappingForMarketplace(args.channel, args.market)
  const attributes = [...new Set(changes.map((row) => row.attribute))]
  const rulesUsing = [mapping.fields ?? {}, ...Object.values(mapping.byProductType ?? {})]
    .flatMap((bucket) => Object.entries(bucket))
    .filter(([, rule]) => (rule?.transforms ?? []).some((op) => op.type === 'valueMap' && attributes.includes(op.attribute)))
    .map(([field]) => field)
  let listingsWithValue = 0
  for (const row of changes) {
    const [{ n }] = await prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(DISTINCT cl.id)::int AS n FROM "ChannelListing" cl JOIN "Product" p ON p.id = cl."productId"
      WHERE cl.channel = ${args.channel} AND cl.marketplace = ${args.market} AND p."deletedAt" IS NULL
        AND (p."categoryAttributes" -> ${row.attribute} = to_jsonb(${row.fromValue}::text)
          OR (jsonb_typeof(p."categoryAttributes" -> ${row.attribute}) = 'array' AND jsonb_exists(p."categoryAttributes" -> ${row.attribute}, ${row.fromValue})))`
    listingsWithValue += n
  }
  if (listingsWithValue > PREVIEW_MAX_LISTINGS) {
    return { ok: false, error: `Not changed: these translations reach ${listingsWithValue} listings — more than Claude changes in one request (${PREVIEW_MAX_LISTINGS}). Make this change in Nexus.` }
  }
  return {
    ok: true,
    preview: {
      action: 'save-channel-mapping',
      kind: 'value-map',
      channel: args.channel,
      market: args.market,
      changes: changes.slice(0, SHOWN),
      ...(changes.length > SHOWN ? { moreChanges: changes.length - SHOWN } : {}),
      // Every entry's current value, so a translation changed by someone else since makes the approval stale.
      basis: { entries: hashOf(canonical(changes.map((row) => [row.attribute, row.fromValue, row.from]))) },
      impact: { rulesUsingTheseMaps: rulesUsing.length, fields: rulesUsing.slice(0, SHOWN), listingsWithTheseValues: listingsWithValue },
      note: rulesUsing.length
        ? 'Saved in Nexus; the listings take the new values at their next publish or sync.'
        : 'Saved in Nexus; no field rule of this market uses these attributes\' translations yet, so no listing changes until one does.',
    },
  }
}

/** Size conversions: they belong to the business, not to a market. */
async function sizeScalePreview(args: MappingArgs): Promise<ToolResult> {
  const entries = (args.sizeScale ?? []).map((e) => ({ ...e, scale: e.scale.toUpperCase(), fromSystem: e.fromSystem.toUpperCase(), toSystem: e.toSystem.toUpperCase() }))
  if (!entries.length) return { ok: false, error: 'Not changed: name at least one size conversion (sizeScale).' }
  const keyOf = (e: { scale: string; fromSystem: string; toSystem: string; fromValue: string }) => [e.scale, e.fromSystem, e.toSystem, e.fromValue].join('\0')
  if (new Set(entries.map(keyOf)).size !== entries.length) return { ok: false, error: 'Not changed: a size conversion is named twice.' }
  const current = await prisma.sizeScaleMap.findMany({
    where: { OR: entries.map((e) => ({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue })) },
    select: { scale: true, fromSystem: true, toSystem: true, fromValue: true, toValue: true },
  })
  const now = new Map(current.map((row) => [keyOf(row), row.toValue]))
  const changes = entries
    .map((e) => ({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue, from: now.get(keyOf(e)) ?? null, to: e.toValue }))
    .filter((row) => row.from !== row.to)
  if (!changes.length) return { ok: false, error: 'Not changed: these size conversions are already set.' }
  const scales = new Set(changes.map((row) => row.scale))
  const markets = await prisma.marketplace.findMany({ select: { channel: true, code: true, schemaMapping: true } })
  let rulesUsing = 0
  const marketsUsing: string[] = []
  for (const m of markets) {
    const mapping = (m.schemaMapping ?? {}) as unknown as MarketplaceSchemaMapping
    const n = [mapping.fields ?? {}, ...Object.values(mapping.byProductType ?? {})]
      .flatMap((bucket) => Object.values(bucket ?? {}))
      .filter((rule) => (rule?.transforms ?? []).some((op) => op.type === 'sizeScale' && scales.has(String(op.scale).toUpperCase()))).length
    if (n) { rulesUsing += n; marketsUsing.push(`${m.channel} ${m.code}`) }
  }
  return {
    ok: true,
    preview: {
      action: 'save-channel-mapping',
      kind: 'size-scale',
      channel: args.channel,
      market: args.market,
      changes: changes.slice(0, SHOWN),
      ...(changes.length > SHOWN ? { moreChanges: changes.length - SHOWN } : {}),
      basis: { entries: hashOf(canonical(changes.map((row) => [row.scale, row.fromSystem, row.toSystem, row.fromValue, row.from]))) },
      impact: { rulesUsingTheseScales: rulesUsing, markets: marketsUsing.slice(0, SHOWN) },
      note: 'Size conversions apply to every channel and market that converts with these scales; listings take the new sizes at their next publish or sync.',
    },
  }
}

async function mappingDryRun(args: MappingArgs): Promise<ToolResult> {
  const kind = kindOf(args)
  // The business boundary first: a market this business does not have is not found, whatever else was asked.
  if (!(await marketOf(args.channel, args.market))) return { ok: false, error: MARKET_NOT_FOUND }
  const given = { rules: !!args.rules?.length, 'value-map': !!args.valueMap?.length, 'size-scale': !!args.sizeScale?.length, restore: !!args.restoreRevisionId }
  const others = Object.entries(given).filter(([name, set]) => set && name !== kind).map(([name]) => name)
  if (others.length) return { ok: false, error: `Not changed: one kind of change per request — this is ${kind}, and ${others.join(', ')} was also given.` }
  if (kind === 'restore') {
    if (!args.restoreRevisionId) return { ok: false, error: 'Not changed: name the revision to restore (restoreRevisionId).' }
    const revision = await prisma.mappingRevision.findFirst({ where: { id: args.restoreRevisionId, channel: args.channel, code: args.market }, select: { id: true } })
    if (!revision) return { ok: false, error: 'Mapping revision not found' }
    return rulesPreview(args, 'restore')
  }
  if (kind === 'rules') {
    if (!args.rules?.length) return { ok: false, error: 'Not changed: name at least one field rule (rules).' }
    return rulesPreview(args, 'rules')
  }
  return kind === 'value-map' ? valueMapPreview(args) : sizeScalePreview(args)
}

/** The stored review of an approved change: wait for its scan (the page polls the same row). */
async function waitForReview(jobId: string, timeoutMs = 120_000): Promise<{ status: string; counts: Record<string, number> | null }> {
  const started = Date.now()
  for (;;) {
    const job = await prisma.bulkOperation.findUnique({ where: { id: jobId }, select: { status: true, changes: true } })
    if (!job) return { status: 'MISSING', counts: null }
    if (job.status !== 'MAPPING_SCANNING' || Date.now() - started > timeoutMs) {
      return { status: job.status, counts: (job.changes as unknown as { counts?: Record<string, number> } | null)?.counts ?? null }
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** The facts of a preview that must not have moved between the approval and the run. */
const materialOf = (preview: unknown) => {
  const p = (preview ?? {}) as Record<string, unknown>
  return canonical({ changes: p.changes, impact: p.impact, basis: p.basis })
}

/** The person (or system) the review row belongs to: activation reads it back by this name. */
const reviewer = (ctx: ToolContext) => ctx.userId ?? 'claude'

async function executeRules(args: MappingArgs, kind: 'rules' | 'restore', ctx: ToolContext, fresh: Record<string, unknown>): Promise<ToolResult> {
  const { activateMappingImpact, createMappingImpact } = await impactService()
  const before = await getMappingForMarketplace(args.channel, args.market)
  const token = mappingToken(before)
  if (token !== (fresh.basis as { token?: string }).token) return { ok: false, error: 'Not changed: the mapping changed while this ran. Ask again.' }
  const userId = reviewer(ctx)
  let jobId: string
  try {
    ;({ jobId } = await createMappingImpact({
      channel: args.channel,
      market: args.market,
      expectedToken: token,
      userId,
      ...(kind === 'restore' ? { restoreRevisionId: args.restoreRevisionId } : { category: args.category ?? null, changes: (args.rules ?? []) as MappingChange[] }),
    }))
  } catch (error) {
    if (error instanceof MappingConflict || error instanceof InvalidMappingError) return { ok: false, error: `Not changed: ${error.message}` }
    throw error
  }
  const review = await waitForReview(jobId)
  if (review.status !== 'MAPPING_REVIEW') {
    return { ok: false, error: `Not changed: the mapping review ended as ${review.status.replace('MAPPING_', '').toLowerCase()} (the mapping or its inputs moved). Ask again.` }
  }
  // The stored review counted what the approved preview counted, or the world moved in between.
  const impact = fresh.impact as Record<string, number>
  const counts = review.counts ?? {}
  const pairs: Array<[string, number, number]> = [
    ['listings changed', impact.listingsChanged, counts.affectedListings ?? 0],
    ['values changed', impact.valuesChanged, counts.changed ?? 0],
    ['products matched', impact.productsMatched, counts.matchedProducts ?? 0],
  ]
  const moved = pairs.filter(([, a, b]) => a !== b)
  if (moved.length) {
    return { ok: false, error: `Not changed: the review counted differently than the approved preview (${moved.map(([name, a, b]) => `${name} ${a} → ${b}`).join(', ')}). Ask again.` }
  }
  try {
    await activateMappingImpact(jobId, userId)
  } catch (error) {
    if (error instanceof MappingConflict) return { ok: false, error: `Not changed: ${error.message}` }
    throw error
  }
  // The revision the activation left holds the mapping it replaced: undo restores it.
  const revision = await prisma.mappingRevision.findFirst({ where: { channel: args.channel, code: args.market }, orderBy: { version: 'desc' }, select: { id: true, version: true } })
  const after = await getMappingForMarketplace(args.channel, args.market)
  return {
    ok: true,
    data: { channel: args.channel, market: args.market, kind, reviewId: jobId, listingsChanged: impact.listingsChanged, restoreRevisionId: revision?.id ?? null },
    change: {
      before: { channel: args.channel, market: args.market, kind, token, restoreRevisionId: revision?.id ?? null, fields: (fresh.changes as Array<{ field: string }>).map((row) => row.field) },
      after: { channel: args.channel, market: args.market, token: mappingToken(after) },
    },
  }
}

async function executeValueMap(args: MappingArgs, fresh: Record<string, unknown>): Promise<ToolResult> {
  const changes = fresh.changes as Array<{ attribute: string; fromValue: string; from: string | null; to: string | null }>
  // The preview lists at most SHOWN; the run takes every entry the request names, re-read now.
  const all = (args.valueMap ?? []).map((e) => ({ attribute: e.attribute, fromValue: e.fromValue, to: e.toValue }))
  const current = await prisma.fieldValueMap.findMany({
    where: { channel: args.channel, marketplace: args.market, OR: all.map((e) => ({ attribute: e.attribute, fromValue: e.fromValue })) },
    select: { id: true, attribute: true, fromValue: true, toValue: true },
  })
  const now = new Map(current.map((row) => [`${row.attribute}\0${row.fromValue}`, row]))
  const before: Array<{ attribute: string; fromValue: string; toValue: string | null }> = []
  const after: Array<{ attribute: string; fromValue: string; toValue: string | null }> = []
  for (const e of all) {
    const row = now.get(`${e.attribute}\0${e.fromValue}`)
    if ((row?.toValue ?? null) === e.to) continue
    if (e.to === null) { if (row) await removeValueMap(row.id) } else await upsertValueMap({ channel: args.channel, marketplace: args.market, attribute: e.attribute, fromValue: e.fromValue, toValue: e.to, confidence: 'MANUAL', reviewed: true })
    before.push({ attribute: e.attribute, fromValue: e.fromValue, toValue: row?.toValue ?? null })
    after.push({ attribute: e.attribute, fromValue: e.fromValue, toValue: e.to })
  }
  return {
    ok: true,
    data: { channel: args.channel, market: args.market, kind: 'value-map', changed: after.length, shown: changes.length },
    change: { before: { channel: args.channel, market: args.market, kind: 'value-map', valueMap: before }, after: { channel: args.channel, market: args.market, kind: 'value-map', valueMap: after } },
  }
}

async function executeSizeScale(args: MappingArgs): Promise<ToolResult> {
  const entries = (args.sizeScale ?? []).map((e) => ({ scale: e.scale.toUpperCase(), fromSystem: e.fromSystem.toUpperCase(), toSystem: e.toSystem.toUpperCase(), fromValue: e.fromValue, to: e.toValue }))
  const current = await prisma.sizeScaleMap.findMany({
    where: { OR: entries.map((e) => ({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue })) },
    select: { scale: true, fromSystem: true, toSystem: true, fromValue: true, toValue: true },
  })
  const keyOf = (e: { scale: string; fromSystem: string; toSystem: string; fromValue: string }) => [e.scale, e.fromSystem, e.toSystem, e.fromValue].join('\0')
  const now = new Map(current.map((row) => [keyOf(row), row.toValue]))
  type Entry = { scale: string; fromSystem: string; toSystem: string; fromValue: string; toValue: string | null }
  const before: Entry[] = []
  const after: Entry[] = []
  for (const e of entries) {
    const was = now.get(keyOf(e)) ?? null
    if (was === e.to) continue
    if (e.to === null) await removeSizeScale(e)
    else await upsertSizeScale({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue, toValue: e.to })
    const key = { scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue }
    before.push({ ...key, toValue: was })
    after.push({ ...key, toValue: e.to })
  }
  return {
    ok: true,
    data: { kind: 'size-scale', changed: after.length },
    change: { before: { channel: args.channel, market: args.market, kind: 'size-scale', sizeScale: before }, after: { channel: args.channel, market: args.market, kind: 'size-scale', sizeScale: after } },
  }
}

interface MappingChangeRecord {
  channel?: string
  market?: string
  kind?: MappingKind
  token?: string
  restoreRevisionId?: string | null
  valueMap?: Array<{ attribute: string; fromValue: string; toValue: string | null }>
  sizeScale?: Array<{ scale: string; fromSystem: string; toSystem: string; fromValue: string; toValue: string | null }>
}

/**
 * Undo: rules and restores put back the revision the activation left (the mapping it replaced); value maps and size
 * conversions put each entry back as it was (a translation or conversion that did not exist is removed again).
 * Refused while what is stored is no longer what the change wrote.
 */
export const SAVE_CHANNEL_MAPPING_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as MappingChangeRecord
    const channel = String(after.channel ?? '')
    const market = String(after.market ?? '')
    if (after.valueMap) {
      const rows = await prisma.fieldValueMap.findMany({
        where: { channel, marketplace: market, OR: after.valueMap.map((e) => ({ attribute: e.attribute, fromValue: e.fromValue })) },
        select: { attribute: true, fromValue: true, toValue: true },
      })
      const now = new Map(rows.map((row) => [`${row.attribute}\0${row.fromValue}`, row.toValue]))
      return { channel, market, kind: 'value-map', valueMap: after.valueMap.map((e) => ({ attribute: e.attribute, fromValue: e.fromValue, toValue: now.get(`${e.attribute}\0${e.fromValue}`) ?? null })) }
    }
    if (after.sizeScale) {
      const rows = await prisma.sizeScaleMap.findMany({
        where: { OR: after.sizeScale.map((e) => ({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue })) },
        select: { scale: true, fromSystem: true, toSystem: true, fromValue: true, toValue: true },
      })
      const keyOf = (e: { scale: string; fromSystem: string; toSystem: string; fromValue: string }) => [e.scale, e.fromSystem, e.toSystem, e.fromValue].join('\0')
      const now = new Map(rows.map((row) => [keyOf(row), row.toValue]))
      return { channel, market, kind: 'size-scale', sizeScale: after.sizeScale.map((e) => ({ scale: e.scale, fromSystem: e.fromSystem, toSystem: e.toSystem, fromValue: e.fromValue, toValue: now.get(keyOf(e)) ?? null })) }
    }
    const market_ = await marketOf(channel, market)
    return { channel, market, token: market_ ? mappingToken(await getMappingForMarketplace(channel, market)) : null }
  },
  request(change) {
    const before = (change.before ?? {}) as MappingChangeRecord
    if (!before.channel || !before.market) return { refusal: 'This change does not name its channel and market.' }
    if (before.valueMap) return before.valueMap.length ? { tool: 'save-channel-mapping', args: { channel: before.channel, market: before.market, kind: 'value-map', valueMap: before.valueMap } } : { refusal: 'This change set no translation, so there is nothing to put back.' }
    if (before.sizeScale) return before.sizeScale.length ? { tool: 'save-channel-mapping', args: { channel: before.channel, market: before.market, kind: 'size-scale', sizeScale: before.sizeScale } } : { refusal: 'This change set no size conversion, so there is nothing to put back.' }
    if (!before.restoreRevisionId) return { refusal: 'No saved revision of the mapping before this change was found, so it cannot be restored.' }
    return { tool: 'save-channel-mapping', args: { channel: before.channel, market: before.market, restoreRevisionId: before.restoreRevisionId } }
  },
}

const saveChannelMapping: AgentTool = {
  name: 'save-channel-mapping',
  title: 'Change a channel mapping',
  category: 'catalog',
  description:
    'Change how Nexus fills a channel\'s fields for one market: field rules (where each channel field takes its value '
    + 'from, with transforms), value translations, size conversions, or restoring a saved revision. The preview runs '
    + 'the same impact review as Nexus\'s mapping page — how many listings and values change, which listing overrides '
    + 'are kept, examples — and refuses a change that makes values invalid or covers more than 2,000 listings. Nothing '
    + 'changes until a person approves it in Nexus; listings then take the rule at their next publish or sync. Undo '
    + 'restores what it replaced.',
  input: mappingInput,
  requires: [F.pimManage],
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  // The standing rule reaches every marketplace listing that follows it, at its next publish or sync.
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SAVE_CHANNEL_MAPPING_UNDO,
  handler: (args) => mappingDryRun(args as MappingArgs),
  async execute(args, ctx) {
    const parsed = args as MappingArgs
    const fresh = await mappingDryRun(parsed)
    if (!fresh.ok) return fresh
    // The review must still be the one the person approved (besides the gate's own staleness check).
    if (ctx.approvedPreview !== undefined && materialOf(ctx.approvedPreview) !== materialOf(fresh.preview)) {
      return { ok: false, error: 'Not changed: the mapping, its inputs or its impact moved since this was approved. Ask again for a fresh review.' }
    }
    const preview = fresh.preview as Record<string, unknown>
    const kind = kindOf(parsed)
    if (kind === 'rules' || kind === 'restore') return executeRules(parsed, kind, ctx, preview)
    return kind === 'value-map' ? executeValueMap(parsed, preview) : executeSizeScale(parsed)
  },
}

// ── save-listing-template ─────────────────────────────────────────────────────────────────────────────

const TEMPLATE_KINDS = ['description-theme', 'preset'] as const
const THEME_NOT_FOUND = 'Description theme not found'
const PRESET_NOT_FOUND = 'Listing preset not found'

const templateInput = z.object({
  kind: z.enum(TEMPLATE_KINDS).optional()
    .describe('description-theme (an eBay description theme) or preset (a listing preset); implied by themeId or presetId'),
  themeId: z.string().trim().min(1).max(64).optional().describe('description-theme: the theme to change'),
  presetId: z.string().trim().min(1).max(64).optional().describe('preset: the listing preset to change'),
  name: z.string().trim().min(1).max(120).optional().describe('the new name'),
  html: z.string().min(1).max(100_000).optional()
    .describe('description-theme: the new theme HTML (the listing body is placed where the theme says)'),
  notes: z.string().max(2_000).nullable().optional().describe('description-theme: notes for the team; null clears them'),
  active: z.boolean().optional().describe('description-theme: false switches the theme off (listings fall back to the default)'),
  description: z.string().max(500).optional().describe('preset: the new description; an empty text clears it'),
  categoryHint: z.string().max(60).optional().describe('preset: the new category hint; an empty text clears it'),
})
type TemplateArgs = z.infer<typeof templateInput>

const templateKind = (args: TemplateArgs) => args.kind ?? (args.presetId && !args.themeId ? 'preset' : 'description-theme')

/** The eBay listings a theme wraps: assigned to it, through the default (when it is the default), or by a presentation rule. */
async function themeUse(themeId: string, isDefault: boolean) {
  const listings = await prisma.channelListing.findMany({
    where: { channel: 'EBAY', product: { deletedAt: null } },
    select: { platformAttributes: true },
  })
  let assigned = 0
  let viaDefault = 0
  for (const row of listings) {
    const value = ((row.platformAttributes ?? {}) as Record<string, unknown>).descriptionThemeId
    if (value === themeId) assigned++
    else if (isDefault && (value === undefined || value === null || value === '')) viaDefault++
  }
  const markets = await prisma.marketplace.findMany({ where: { channel: 'EBAY' }, select: { code: true, schemaMapping: true } })
  const rules = markets.flatMap((m) => (((m.schemaMapping ?? {}) as unknown as MarketplaceSchemaMapping).presentationRules ?? [])
    .filter((rule) => rule.themeId === themeId).map(() => m.code))
  return { assignedListings: assigned, listingsUsingTheDefault: viaDefault, presentationRules: rules.length, ruleMarkets: [...new Set(rules)] }
}

const themeView = (row: { name: string; notes: string | null; active: boolean; html: string }) => ({
  name: row.name, notes: row.notes, active: row.active, htmlLength: row.html.length, htmlHash: hashOf(row.html),
})

async function templateDryRun(args: TemplateArgs): Promise<ToolResult> {
  const kind = templateKind(args)
  if (kind === 'description-theme') {
    if (!args.themeId) return { ok: false, error: 'Not changed: name the theme to change (themeId). New themes are created in Nexus.' }
    if (args.description !== undefined || args.categoryHint !== undefined) return { ok: false, error: 'Not changed: description and categoryHint belong to presets.' }
    const theme = await prisma.ebayDescriptionTheme.findFirst({ where: { id: args.themeId } })
    if (!theme) return { ok: false, error: THEME_NOT_FOUND }
    const next = {
      name: args.name ?? theme.name,
      notes: args.notes !== undefined ? args.notes : theme.notes,
      active: args.active ?? theme.active,
      html: args.html ?? theme.html,
    }
    const from = themeView(theme)
    const to = themeView(next)
    const changes = Object.fromEntries(
      (Object.keys(from) as Array<keyof typeof from>).filter((key) => from[key] !== to[key]).map((key) => [key, { from: from[key], to: to[key] }]),
    )
    if (!Object.keys(changes).length) return { ok: false, error: 'Not changed: the theme already reads like this.' }
    if (next.name !== theme.name && await prisma.ebayDescriptionTheme.findFirst({ where: { name: next.name, NOT: { id: theme.id } }, select: { id: true } })) {
      return { ok: false, error: `Not changed: a theme named "${next.name}" already exists.` }
    }
    if (!next.active && theme.isDefault) return { ok: false, error: 'Not changed: this is the default theme; choose another default in Nexus before switching it off.' }
    return {
      ok: true,
      preview: {
        action: 'save-listing-template',
        kind,
        theme: theme.name,
        builtIn: theme.builtIn,
        isDefault: theme.isDefault,
        changes,
        // The person approving reads the start of the new HTML, not only that it changed.
        ...(next.html !== theme.html ? { newHtmlStart: safeText(next.html, 600) } : {}),
        impact: await themeUse(theme.id, theme.isDefault),
        basis: { version: theme.version },
        note: 'Saved in Nexus. eBay keeps the description it was sent: the listings this theme wraps show as stale until a person re-publishes them. Undo puts the old theme back.',
      },
    }
  }
  if (!args.presetId) return { ok: false, error: 'Not changed: name the preset to change (presetId). New presets are saved from the listing wizard in Nexus.' }
  if (args.html !== undefined || args.notes !== undefined || args.active !== undefined) return { ok: false, error: 'Not changed: html, notes and active belong to description themes.' }
  const preset = await prisma.wizardTemplate.findFirst({ where: { id: args.presetId } })
  if (!preset) return { ok: false, error: PRESET_NOT_FOUND }
  if (preset.builtIn) return { ok: false, error: 'Not changed: built-in presets are read-only. Save your own from the listing wizard.' }
  const clean = (text: string | undefined, cap: number, current: string | null) => (text === undefined ? current : text.trim() ? text.trim().slice(0, cap) : null)
  const next = { name: args.name ?? preset.name, description: clean(args.description, 500, preset.description), categoryHint: clean(args.categoryHint, 60, preset.categoryHint) }
  const from = { name: preset.name, description: preset.description, categoryHint: preset.categoryHint }
  const changes = Object.fromEntries((Object.keys(from) as Array<keyof typeof from>).filter((key) => from[key] !== next[key]).map((key) => [key, { from: from[key], to: next[key] }]))
  if (!Object.keys(changes).length) return { ok: false, error: 'Not changed: the preset already reads like this.' }
  return {
    ok: true,
    preview: {
      action: 'save-listing-template',
      kind,
      preset: preset.name,
      changes,
      impact: { timesApplied: preset.usageCount, lastUsedAt: preset.lastUsedAt?.toISOString() ?? null, listingsFollowingIt: 0 },
      basis: { updatedAt: preset.updatedAt.toISOString() },
      note: 'Saved in Nexus. A preset is applied when a listing is made, never followed afterwards: no existing listing changes. Undo puts the old name and texts back.',
    },
  }
}

interface TemplateRecord {
  kind?: 'description-theme' | 'preset'
  themeId?: string
  presetId?: string
  name?: string
  notes?: string | null
  active?: boolean
  html?: string
  htmlHash?: string
  version?: number
  description?: string | null
  categoryHint?: string | null
}

export const SAVE_LISTING_TEMPLATE_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as TemplateRecord
    if (after.kind === 'preset') {
      const preset = await prisma.wizardTemplate.findFirst({ where: { id: after.presetId } })
      return preset ? { kind: 'preset', presetId: preset.id, name: preset.name, description: preset.description, categoryHint: preset.categoryHint } : null
    }
    const theme = await prisma.ebayDescriptionTheme.findFirst({ where: { id: after.themeId } })
    return theme ? { kind: 'description-theme', themeId: theme.id, name: theme.name, notes: theme.notes, active: theme.active, htmlHash: hashOf(theme.html), version: theme.version } : null
  },
  request(change) {
    const before = (change.before ?? {}) as TemplateRecord
    if (before.kind === 'preset') {
      if (!before.presetId || !before.name) return { refusal: 'This change does not name its preset.' }
      return { tool: 'save-listing-template', args: { kind: 'preset', presetId: before.presetId, name: before.name, description: before.description ?? '', categoryHint: before.categoryHint ?? '' } }
    }
    if (!before.themeId || !before.name || !before.html) return { refusal: 'This change does not name its theme.' }
    return { tool: 'save-listing-template', args: { kind: 'description-theme', themeId: before.themeId, name: before.name, html: before.html, notes: before.notes ?? null, active: before.active ?? true } }
  },
}

const saveListingTemplate: AgentTool = {
  name: 'save-listing-template',
  title: 'Change a listing template',
  category: 'listings',
  description:
    'Change an eBay description theme (name, HTML, notes, on/off) or a listing preset (name, description, category '
    + 'hint). The preview says what it touches: the eBay listings the theme wraps (assigned, through the default, or by '
    + 'a presentation rule), or how often the preset was applied. Nothing changes until a person approves it in Nexus; '
    + 'nothing is sent to eBay by it (a theme change marks those descriptions to re-publish). Undo puts the old template '
    + 'back. Creating new themes or presets stays in Nexus.',
  input: templateInput,
  requires: [F.listingsPublish],
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  // Saved in Nexus only: eBay keeps the HTML it was sent until a person re-publishes.
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SAVE_LISTING_TEMPLATE_UNDO,
  handler: (args) => templateDryRun(args as TemplateArgs),
  async execute(args, ctx) {
    const parsed = args as TemplateArgs
    const fresh = await templateDryRun(parsed)
    if (!fresh.ok) return fresh
    if (ctx.approvedPreview !== undefined && canonical((ctx.approvedPreview as Record<string, unknown>)?.basis) !== canonical((fresh.preview as Record<string, unknown>).basis)) {
      return { ok: false, error: 'Not changed: the template was edited since this was approved. Ask again.' }
    }
    if (templateKind(parsed) === 'description-theme') {
      const theme = await prisma.ebayDescriptionTheme.findFirst({ where: { id: parsed.themeId } })
      if (!theme) return { ok: false, error: THEME_NOT_FOUND }
      // As PUT /ebay/description-themes/:id: the version must be the one read, and it moves by one.
      const written = await prisma.ebayDescriptionTheme.updateMany({
        where: { id: theme.id, version: theme.version },
        data: {
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.html !== undefined ? { html: parsed.html } : {}),
          ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
          ...(parsed.active !== undefined ? { active: parsed.active } : {}),
          version: { increment: 1 },
        },
      })
      if (written.count !== 1) return { ok: false, error: 'Not changed: the theme changed while saving. Ask again.' }
      const now = await prisma.ebayDescriptionTheme.findFirstOrThrow({ where: { id: theme.id } })
      return {
        ok: true,
        data: { theme: now.name, version: now.version },
        change: {
          before: { kind: 'description-theme', themeId: theme.id, name: theme.name, notes: theme.notes, active: theme.active, html: theme.html, version: theme.version },
          after: { kind: 'description-theme', themeId: now.id, name: now.name, notes: now.notes, active: now.active, htmlHash: hashOf(now.html), version: now.version },
        },
      }
    }
    const preset = await prisma.wizardTemplate.findFirst({ where: { id: parsed.presetId } })
    if (!preset || preset.builtIn) return { ok: false, error: PRESET_NOT_FOUND }
    const changes = (fresh.preview as { changes: Record<string, { to: string | null }> }).changes
    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(changes)) data[key] = value.to
    // As PATCH /wizard-templates/:id: only if the preset is still the one read.
    const written = await prisma.wizardTemplate.updateMany({ where: { id: preset.id, updatedAt: preset.updatedAt, builtIn: false }, data })
    if (written.count !== 1) return { ok: false, error: 'Not changed: the preset changed while saving. Ask again.' }
    const now = await prisma.wizardTemplate.findFirstOrThrow({ where: { id: preset.id } })
    return {
      ok: true,
      data: { preset: now.name },
      change: {
        before: { kind: 'preset', presetId: preset.id, name: preset.name, description: preset.description, categoryHint: preset.categoryHint },
        after: { kind: 'preset', presetId: now.id, name: now.name, description: now.description, categoryHint: now.categoryHint },
      },
    }
  },
}

export const MAPPING_CHANGE_TOOLS: AgentTool[] = [saveChannelMapping, saveListingTemplate]
