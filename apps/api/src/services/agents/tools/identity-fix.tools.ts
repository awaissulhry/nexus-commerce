/**
 * MCP full control I10 — identity fixes a person approves in Nexus: a product's SKU, a barcode, brands, and an extra
 * listing's own SKU. Plan: docs/mcp-full-control/sections/04-identity.md §3 (set-product-sku, set-gtin, set-brand,
 * set-listing-sku).
 *
 * Every tool here changes Nexus only — nothing is sent to a channel — and always waits for a person (alwaysAsk). The
 * `handler` is the preview and writes nothing: product changes go through the product bulk writer's own dry run
 * (`applyProductBulkEdits`, `dryRun: true`), so a preview carries the writer's refusals (SKU unique, a SKU an extra
 * listing or another product's listing uses) and warnings. `execute` works the change out again from what is stored
 * when it runs (the gate has already compared the approved preview's material fields) and writes through the same
 * writer. Each records what it replaced, and undo asks for the old value through the same gate.
 *
 * S9 (per-channel SKU, the Owner's rule 2026-10-05) replaces d12's refusals: a product SKU rename keeps every channel in
 * step — the listings a channel holds keep the old SKU, drafts follow the new one (the preview names them). A listing's
 * own SKU is that listing's (`ChannelListing.channelSku`, set-listing-sku, through `setChannelSku`); on a listing the
 * channel holds, a new SKU is allowed where Publish's move step carries it (S10: Amazon, eBay Trading, Shopify).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { logger } from '../../../utils/logger.js'
import {
  applyProductBulkEdits,
  ProductBulkError,
  type ProductBulkChangeError,
  type ProductBulkChangeWarning,
  type ProductBulkContext,
  type ProductBulkInput,
} from '../../products/bulk-edit.service.js'
import { REQUIREMENT_MISSING } from '../../identity/identity-checks.js'
import { availableRequirements } from '../../identity/identity-audit.service.js'
import { barcodeDuplicates } from '../../identity/identity-write-guards.js'
import { validateGtin } from '../../listing-preflight.service.js'
import { IdentityFixRefusal, coordinateOf, planLink, planUnlink, runLink, runUnlink } from '../../identity/identity-fix.service.js'
import { liveProduct, PRODUCT_NOT_FOUND } from './live-product.js'
import { CHANNEL_SKU_LISTING_SELECT, ChannelSkuError, channelSkuMoveFacts, setChannelSku } from '../../listings/channel-sku.js'
import { liveChannelSku, wantedChannelSku } from '../../listings/channel-sku.pure.js'
import { listingPlace, liveChannelSkuMoveRefusal } from '../../listings/channel-sku-live-move.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'

type Change = ProductBulkInput['changes'][number]
type Refusal = { error: string }

const NEXUS_ONLY = 'Nexus only: nothing is sent to a channel.'
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`

// ── The product writer, dry run and run ───────────────────────────────────────────────────────────────

function writerContext(userId: string | null | undefined): ProductBulkContext {
  const log = (level: 'warn' | 'error') => (details: unknown, message?: string) =>
    logger[level](message ?? '[agents/identity-fix] product bulk writer', { details })
  return { formulaCascade: false, userId: userId ?? null, logger: { warn: log('warn'), error: log('error') } as unknown as ProductBulkContext['logger'] }
}

type WriterOut = { dryRun?: boolean; wouldUpdate?: number; updated?: number; operationId?: string; errors?: ProductBulkChangeError[]; warnings?: ProductBulkChangeWarning[]
  /** S9 — what each product SKU rename does on the channels (`channel-sku-rename.ts`). */
  skuRenames?: Array<{ productId: string; from: string; to: string; summary: string }> }

const writerLines = (items: Array<{ id: string; error?: string; warning?: string }>, skuOf: Map<string, string>) =>
  items.map((item) => `${skuOf.get(item.id) ?? item.id}: ${item.error ?? item.warning}`)

/** The writer's verdict on every change, writing nothing. */
async function writerDryRun(changes: Change[], skuOf: Map<string, string>): Promise<Refusal | { warnings: string[]; skuRenames: NonNullable<WriterOut['skuRenames']> }> {
  try {
    const out = (await applyProductBulkEdits({ changes, dryRun: true }, writerContext(null))) as WriterOut
    if (out.errors?.length) return { error: writerLines(out.errors, skuOf).join(' ') }
    if (out.dryRun !== true || out.wouldUpdate !== changes.length) {
      return { error: `The product writer could not check every change (${out.wouldUpdate ?? 0} of ${changes.length}).` }
    }
    return { warnings: writerLines(out.warnings ?? [], skuOf), skuRenames: out.skuRenames ?? [] }
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    const errors = error.details.errors
    return { error: Array.isArray(errors) && errors.length ? writerLines(errors as ProductBulkChangeError[], skuOf).join(' ') : error.message }
  }
}

/** The real write. A throw rolls the whole transaction back, so nothing changed then. */
async function writerRun(changes: Change[], userId: string | null | undefined): Promise<Refusal | WriterOut> {
  try {
    const out = (await applyProductBulkEdits({ changes }, writerContext(userId))) as WriterOut
    if (out.errors?.length) return { error: out.errors.map((e) => e.error).join(' ') }
    return out
  } catch (error) {
    if (!(error instanceof ProductBulkError)) throw error
    return { error: error.message }
  }
}

const refused = (reason: string, nothing: string) => `${reason} ${nothing}`.trim()

// ── set-product-sku ───────────────────────────────────────────────────────────────────────────────────

interface SkuPlan {
  productId: string
  from: string
  to: string
  /** S9 — what the rename does on the channels ("Amazon · DE keeps OLD; drafts follow NEW."); '' with no listing. */
  channels: string
  warnings: string[]
}

async function planSku(args: Record<string, unknown>, nothing: string): Promise<SkuPlan | Refusal> {
  const productId = String(args.productId ?? '')
  const to = String(args.sku ?? '').trim()
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, sku: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  if (product.sku === to) return { error: `${product.sku} already has this SKU. ${nothing}` }
  const checked = await writerDryRun([{ id: product.id, field: 'sku', value: to, target: 'master' }], new Map([[product.id, product.sku]]))
  if ('error' in checked) return { error: refused(checked.error, nothing) }
  const channels = checked.skuRenames.find((rename) => rename.productId === product.id)?.summary ?? ''
  return { productId: product.id, from: product.sku, to, channels, warnings: checked.warnings }
}

const SET_PRODUCT_SKU_UNDO: ToolUndo = {
  async current(change) {
    const productId = String((change.after as { productId?: unknown } | null)?.productId ?? '')
    const p = await prisma.product.findFirst({ where: liveProduct(productId), select: { sku: true } })
    return { productId, sku: p?.sku ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; sku?: string }
    if (!before.productId || !before.sku) return { refusal: 'This change does not name its product and SKU.' }
    return { tool: 'set-product-sku', args: { productId: before.productId, sku: before.sku } }
  },
}

const setProductSku: AgentTool = {
  name: 'set-product-sku',
  title: 'Rename a product SKU',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    sku: z.string().trim().min(1).max(100).describe('the new SKU'),
  }),
  requires: [F.productsEdit],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_PRODUCT_SKU_UNDO,
  description:
    `Rename a product's SKU in Nexus (the Shared SKU). ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. `
    + 'Every listing a channel holds keeps the SKU it has there (the old one), so nothing on a channel changes; draft '
    + 'listings follow the new SKU and Publish lists them under it. The preview names which listings keep the old SKU. '
    + 'Refused when another product, an extra listing or another product\'s listing of this business uses the SKU, when '
    + 'the new SKU breaks the product-SKU rule (at most 100 characters; letters, numbers, dots, hyphens and underscores only), '
    + 'and when the product shares stock with another business (disconnect it first).',
  async handler(args): Promise<ToolResult> {
    const plan = await planSku(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: 'set-product-sku',
        sku: plan.from,
        changes: { SKU: { from: plan.from, to: plan.to } },
        effect: `Renames ${plan.from} to ${plan.to} in Nexus.${plan.channels ? ` ${plan.channels}` : ''}`,
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planSku(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const out = await writerRun([{ id: plan.productId, field: 'sku', value: plan.to, target: 'master' }], ctx.userId)
    if ('error' in out) return { ok: false, error: refused(out.error, 'Nothing changed.') }
    return {
      ok: true,
      data: { sku: plan.to, previousSku: plan.from, operationId: out.operationId ?? null, ...(plan.channels ? { channels: plan.channels } : {}), note: NEXUS_ONLY },
      change: { before: { productId: plan.productId, sku: plan.from }, after: { productId: plan.productId, sku: plan.to } },
    }
  },
}

// ── set-gtin ──────────────────────────────────────────────────────────────────────────────────────────

const BARCODE_FIELDS = ['gtin', 'ean', 'upc'] as const
type BarcodeField = (typeof BARCODE_FIELDS)[number]

interface GtinPlan {
  productId: string
  sku: string
  field: BarcodeField
  from: string | null
  to: string | null
  liveAmazon: string[]
  warnings: string[]
}

const digitsOf = (code: string) => code.replace(/[\s-]/g, '')

async function planGtin(args: Record<string, unknown>, nothing: string): Promise<GtinPlan | Refusal> {
  const productId = String(args.productId ?? '')
  const field = (args.field ?? 'gtin') as BarcodeField
  const raw = String(args.code ?? '').trim()
  const product = await prisma.product.findFirst({ where: liveProduct(productId), select: { id: true, sku: true, gtin: true, ean: true, upc: true } })
  if (!product) return { error: PRODUCT_NOT_FOUND }
  const to = raw ? digitsOf(raw) : null
  const from = product[field]
  if ((from ? digitsOf(from) : null) === to) return { error: `${product.sku} already has this ${field.toUpperCase()}. ${nothing}` }
  if (to) {
    const verdict = validateGtin(to)
    if (!verdict.valid) return { error: `${product.sku}: "${raw}" is not a valid barcode (${verdict.reason}). ${nothing}` }
    const [duplicate] = await barcodeDuplicates([{ id: product.id, field, code: to }])
    if (duplicate) {
      return { error: `${product.sku}: ${duplicate.otherSku} already carries this barcode. One barcode on two products makes a channel match both to one item — correct the other product, or merge duplicates. ${nothing}` }
    }
  }
  const checked = await writerDryRun([{ id: product.id, field, value: to ?? '', target: 'master' }], new Map([[product.id, product.sku]]))
  if ('error' in checked) return { error: refused(checked.error, nothing) }
  const live = await prisma.channelListing.findMany({
    where: { productId: product.id, channel: 'AMAZON', listingStatus: 'ACTIVE', isPublished: true },
    select: { marketplace: true },
    orderBy: { marketplace: 'asc' },
  })
  return { productId: product.id, sku: product.sku, field, from: from ?? null, to, liveAmazon: [...new Set(live.map((l) => l.marketplace))], warnings: checked.warnings }
}

const SET_GTIN_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { productId?: string; field?: BarcodeField }
    const field = BARCODE_FIELDS.includes(after.field as BarcodeField) ? (after.field as BarcodeField) : 'gtin'
    const p = await prisma.product.findFirst({ where: liveProduct(String(after.productId ?? '')), select: { gtin: true, ean: true, upc: true } })
    return { productId: after.productId ?? '', field, code: p ? p[field] ?? null : null }
  },
  request(change) {
    const before = (change.before ?? {}) as { productId?: string; field?: string; code?: string | null }
    if (!before.productId || !before.field) return { refusal: 'This change does not name its product and barcode field.' }
    return { tool: 'set-gtin', args: { productId: before.productId, field: before.field, code: before.code ?? '' } }
  },
}

const setGtin: AgentTool = {
  name: 'set-gtin',
  title: 'Set a barcode (GTIN/EAN/UPC)',
  input: z.object({
    productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
    field: z.preprocess(lower, z.enum(BARCODE_FIELDS)).optional().describe('which barcode: gtin (default), ean or upc'),
    code: z.string().trim().max(40).describe('the barcode, 8, 12, 13 or 14 digits (spaces and hyphens are dropped); empty clears it'),
  }),
  requires: [F.productsEdit],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_GTIN_UNDO,
  description:
    `Set or clear a product's GTIN, EAN or UPC in Nexus. ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. `
    + 'Refused when the check digit is wrong or another product of this business carries the code. A product live on '
    + 'Amazon is named: Amazon may match the listing to another catalogue item when its barcode is published.',
  async handler(args): Promise<ToolResult> {
    const plan = await planGtin(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const label = plan.field.toUpperCase()
    return {
      ok: true,
      preview: {
        action: 'set-gtin',
        sku: plan.sku,
        field: plan.field,
        changes: { [label]: { from: plan.from, to: plan.to } },
        effect: plan.to ? `Sets the ${label} of ${plan.sku} to ${plan.to} in Nexus.` : `Clears the ${label} of ${plan.sku} in Nexus.`,
        ...(plan.liveAmazon.length
          ? { liveOn: plan.liveAmazon.map((m) => `Amazon ${m}`), risk: 'Live on Amazon: when the new barcode is published, Amazon may match the listing to another catalogue item.' }
          : {}),
        ...(plan.warnings.length ? { warnings: plan.warnings } : {}),
        note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planGtin(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const out = await writerRun([{ id: plan.productId, field: plan.field, value: plan.to ?? '', target: 'master' }], ctx.userId)
    if ('error' in out) return { ok: false, error: refused(out.error, 'Nothing changed.') }
    return {
      ok: true,
      data: { sku: plan.sku, field: plan.field, code: plan.to, previous: plan.from, note: NEXUS_ONLY },
      change: {
        before: { productId: plan.productId, sku: plan.sku, field: plan.field, code: plan.from },
        after: { productId: plan.productId, field: plan.field, code: plan.to },
      },
    }
  },
}

// ── set-brand ─────────────────────────────────────────────────────────────────────────────────────────

const MAX_BRAND_PRODUCTS = 250
const PREVIEW_LINES = 20

interface BrandPlan {
  items: Array<{ id: string; sku: string; from: string | null; to: string | null }>
  alreadySet: number
  warnings: string[]
}

async function planBrands(args: Record<string, unknown>, nothing: string): Promise<BrandPlan | Refusal> {
  const wanted = (args.brands ?? []) as Array<{ product: string; brand: string }>
  const refs = wanted.map((w) => w.product.trim())
  if (new Set(refs).size !== refs.length) return { error: `A product is named twice. ${nothing}` }
  const found = await prisma.product.findMany({
    where: { deletedAt: null, OR: [{ id: { in: refs } }, { sku: { in: refs } }] },
    select: { id: true, sku: true, brand: true },
  })
  const byRef = new Map<string, (typeof found)[number]>()
  for (const p of found) {
    if (refs.includes(p.id)) byRef.set(p.id, p)
    if (refs.includes(p.sku)) byRef.set(p.sku, p)
  }
  const missing = refs.filter((ref) => !byRef.has(ref))
  if (missing.length) return { error: `${PRODUCT_NOT_FOUND}: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ` and ${missing.length - 10} more` : ''}. ${nothing}` }
  const items: BrandPlan['items'] = []
  let alreadySet = 0
  const seen = new Set<string>()
  for (const w of wanted) {
    const p = byRef.get(w.product.trim())!
    if (seen.has(p.id)) return { error: `${p.sku} is named twice (by id and by SKU). ${nothing}` }
    seen.add(p.id)
    const to = w.brand.trim() || null
    if ((p.brand ?? null) === to) alreadySet++
    else items.push({ id: p.id, sku: p.sku, from: p.brand ?? null, to })
  }
  if (!items.length) return { error: `Every product already has this brand. ${nothing}` }
  const skuOf = new Map(items.map((i) => [i.id, i.sku]))
  const checked = await writerDryRun(items.map((i) => ({ id: i.id, field: 'brand', value: i.to ?? '', target: 'master' as const })), skuOf)
  if ('error' in checked) return { error: refused(checked.error, nothing) }
  return { items, alreadySet, warnings: checked.warnings }
}

const SET_BRAND_UNDO: ToolUndo = {
  async current(change) {
    const after = ((change.after ?? {}) as { brands?: Array<{ productId: string }> }).brands ?? []
    const rows = await prisma.product.findMany({ where: { id: { in: after.map((a) => a.productId) }, deletedAt: null }, select: { id: true, brand: true } })
    const brandOf = new Map(rows.map((r) => [r.id, r.brand ?? null]))
    return { brands: after.map((a) => ({ productId: a.productId, brand: brandOf.has(a.productId) ? brandOf.get(a.productId) : undefined })) }
  },
  request(change) {
    const before = ((change.before ?? {}) as { brands?: Array<{ productId?: string; brand?: string | null }> }).brands ?? []
    if (!before.length || before.some((b) => !b.productId)) return { refusal: 'This change does not name its products.' }
    return { tool: 'set-brand', args: { brands: before.map((b) => ({ product: b.productId!, brand: b.brand ?? '' })) } }
  },
}

const setBrand: AgentTool = {
  name: 'set-brand',
  title: 'Set product brands',
  input: z.object({
    brands: z.array(z.object({
      product: z.string().trim().min(1).max(100).describe('Nexus product id or SKU'),
      brand: z.string().trim().max(200).describe('the brand, spelled as it should be everywhere; empty clears it'),
    })).min(1).max(MAX_BRAND_PRODUCTS)
      .describe(`each product with its brand, 1 to ${MAX_BRAND_PRODUCTS} (for one spelling everywhere, give each product the same brand)`),
  }),
  requires: [F.productsEdit, F.productsBulkRun],
  category: 'products',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_BRAND_UNDO,
  description:
    `Set the master brand of up to ${MAX_BRAND_PRODUCTS} products, each to its own value. ${NEXUS_ONLY} Always waits for a `
    + 'person to approve it in Nexus. Listings get the brand when they are next published; eBay accepts only its allowed '
    + 'brand values, so check the listing before publishing.',
  async handler(args): Promise<ToolResult> {
    const plan = await planBrands(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const changes: Record<string, { from: string | null; to: string | null }> = {}
    for (const i of plan.items.slice(0, PREVIEW_LINES)) changes[`${i.sku} brand`] = { from: i.from, to: i.to }
    return {
      ok: true,
      preview: {
        action: 'set-brand',
        changes,
        ...(plan.items.length > PREVIEW_LINES ? { moreChanges: plan.items.length - PREVIEW_LINES } : {}),
        totals: { changing: plan.items.length, alreadySet: plan.alreadySet },
        effect: `Sets the brand of ${plural(plan.items.length, 'product')} in Nexus${plan.alreadySet ? `; ${plan.alreadySet} already have it` : ''}.`,
        ...(plan.warnings.length ? { warnings: plan.warnings.slice(0, PREVIEW_LINES) } : {}),
        note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planBrands(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const out = await writerRun(plan.items.map((i) => ({ id: i.id, field: 'brand', value: i.to ?? '', target: 'master' as const })), ctx.userId)
    if ('error' in out) return { ok: false, error: refused(out.error, 'Nothing changed.') }
    return {
      ok: true,
      data: { changed: plan.items.length, alreadySet: plan.alreadySet, operationId: out.operationId ?? null, note: NEXUS_ONLY },
      change: {
        before: { brands: plan.items.map((i) => ({ productId: i.id, sku: i.sku, brand: i.from })) },
        after: { brands: plan.items.map((i) => ({ productId: i.id, brand: i.to })) },
      },
    }
  },
}

// ── set-listing-sku ───────────────────────────────────────────────────────────────────────────────────

/**
 * S9 — a listing's own SKU (`ChannelListing.channelSku`: that channel, that market, that account and listing), written
 * through its one writer (`setChannelSku`: characters, uniqueness per account and against product SKUs, version,
 * history, and the live-move rule). Named by `listingId` (any listing), or by `extraListingId` (an extra listing): then
 * its main row (the listing of the extra listing's own product) is the listing, and `ProductListingAlias.sku` is kept in
 * step with it. An extra listing with no listing row yet keeps only its recorded SKU, checked as before.
 */
interface ListingSkuPlan {
  /** The listing whose own SKU is written; null for an extra listing with no listing row yet. */
  listingId: string | null
  version: number | null
  /** The extra listing whose SKU is kept in step (`ProductListingAlias.sku`); null for a listing that is not one. */
  aliasId: string | null
  aliasFrom: string | null
  label: string | null
  productSku: string
  channel: string
  market: string
  place: string
  from: string | null
  to: string | null
  /** The SKU the channel holds for this listing; null = it holds none yet (a draft, or Deleted back to one). */
  held: string | null
  /** The SKU the listing sends after this change (Publish moves a held listing to it where it can: S10). */
  sends: string | null
}

const LISTING_SKU_SELECT = { ...CHANNEL_SKU_LISTING_SELECT, aliasId: true, product: { select: { sku: true, deletedAt: true } } } as const

/**
 * Every check of the write, writing nothing: `setChannelSku`'s own dry run. For an extra listing's main row the alias SKU
 * changes with it, so the live-move rule is asked here of the listing as it will be (`liveMove: 'allow'` to the writer).
 */
async function checkListingSku(listingId: string, to: string | null, aliasInStep: boolean): Promise<string | null> {
  try {
    await prisma.$transaction(async (tx) => {
      if (aliasInStep) {
        const row = await tx.channelListing.findUnique({ where: { id: listingId }, select: CHANNEL_SKU_LISTING_SELECT })
        const refusal = row ? liveChannelSkuMoveRefusal({ ...row, alias: row.alias ? { ...row.alias, sku: to } : row.alias }, row.product?.sku, to, await channelSkuMoveFacts(tx, row)) : null
        if (refusal) throw new ChannelSkuError(409, refusal, 'LIVE_SKU_HELD')
      }
      await setChannelSku(tx, { listingId, sku: to, actorId: null, dryRun: true, liveMove: aliasInStep ? 'allow' : 'refuse' })
    })
    return null
  } catch (error) {
    if (error instanceof ChannelSkuError) return error.message
    throw error
  }
}

async function planListingSku(args: Record<string, unknown>, nothing: string): Promise<ListingSkuPlan | Refusal> {
  const listingId = String(args.listingId ?? '').trim()
  const extraListingId = String(args.extraListingId ?? '').trim()
  if (!listingId && !extraListingId) return { error: `Name the listing: listingId (any listing), or extraListingId (an extra listing). ${nothing}` }
  const to = String(args.sku ?? '').trim() || null
  const ws = workspaceIdForQuery()
  const readListing = (where: { id: string } | { aliasId: string; productId: string }) =>
    prisma.channelListing.findFirst({ where: { ...where, product: { deletedAt: null } }, select: LISTING_SKU_SELECT })
  let row: Awaited<ReturnType<typeof readListing>> = null
  let alias: { id: string; label: string; sku: string | null } | null = null
  if (extraListingId) {
    const found = await prisma.productListingAlias.findFirst({
      where: { id: extraListingId, product: { deletedAt: null } },
      select: { id: true, label: true, channel: true, marketplace: true, productId: true, product: { select: { sku: true } } },
    })
    if (!found) return { error: 'Extra listing not found' }
    const name = `The extra listing "${found.label}" of ${found.product.sku} (${found.channel} ${found.marketplace})`
    // The listing's own SKU comes with the eBay import by SKU (ProductListingAlias.sku). Until that column exists there is
    // nowhere to keep it, and this tool says so instead of pretending.
    if (!(await availableRequirements()).has('listing-alias-sku')) {
      return { error: `${name}: ${REQUIREMENT_MISSING['listing-alias-sku']} ${nothing}` }
    }
    const [stored] = await prisma.$queryRaw<Array<{ sku: string | null }>>`SELECT sku FROM "ProductListingAlias" WHERE id = ${found.id} AND "workspaceId" = ${ws}`
    alias = { id: found.id, label: found.label, sku: stored?.sku ?? null }
    if (alias.sku === to) return { error: `${name} already has this SKU. ${nothing}` }
    row = await readListing({ aliasId: found.id, productId: found.productId })
    // Both named: they must be one listing (the extra listing's main row).
    if (listingId && row?.id !== listingId) {
      const named = await readListing({ id: listingId })
      if (!named) return { error: 'Listing not found' }
      return { error: `${name}: listingId names another listing (${listingPlace(named)} of ${named.product?.sku}). Name one listing. ${nothing}` }
    }
    if (!row) {
      // No listing row yet: only the recorded SKU, checked as before (a product's or another extra listing's SKU).
      if (to) {
        const [clash] = await prisma.$queryRaw<Array<{ what: string; sku: string }>>`
          SELECT 'product' AS what, p.sku FROM "Product" p
            WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND lower(btrim(p.sku)) = ${to.toLowerCase()}
          UNION ALL
          SELECT 'extra listing', a.sku FROM "ProductListingAlias" a
            WHERE a."workspaceId" = ${ws} AND a.id <> ${found.id} AND lower(btrim(a.sku)) = ${to.toLowerCase()}
          LIMIT 1`
        if (clash) return { error: `${name}: ${to} is already the SKU of ${clash.what === 'product' ? 'a product' : 'another extra listing'} (${clash.sku}). One SKU names one thing. ${nothing}` }
      }
      return { listingId: null, version: null, aliasId: found.id, aliasFrom: alias.sku, label: found.label, productSku: found.product.sku,
        channel: found.channel, market: found.marketplace, place: listingPlace({ channel: found.channel, marketplace: found.marketplace, aliasKey: found.id }),
        from: alias.sku, to, held: null, sends: to }
    }
  } else {
    row = await readListing({ id: listingId })
    if (!row) return { error: 'Listing not found' }
    // An extra listing's main row: its recorded SKU (ProductListingAlias.sku) is kept in step with the listing's own SKU.
    if (row.aliasId && row.alias?.productId === row.productId && (await availableRequirements()).has('listing-alias-sku')) {
      const [stored] = await prisma.$queryRaw<Array<{ sku: string | null; label: string }>>`
        SELECT sku, label FROM "ProductListingAlias" WHERE id = ${row.aliasId} AND "workspaceId" = ${ws}`
      if (stored) alias = { id: row.aliasId, label: stored.label, sku: stored.sku }
    }
  }
  const from = alias && extraListingId ? alias.sku : row.channelSku?.trim() || null
  const place = listingPlace(row)
  if (from === to && (!alias || alias.sku === to)) return { error: `The ${place} listing of ${row.product?.sku} already has this SKU. ${nothing}` }
  const refusal = await checkListingSku(row.id, to, !!alias)
  if (refusal) return { error: `The ${place} listing of ${row.product?.sku}: ${refusal} ${nothing}` }
  const after = { ...row, channelSku: to, ...(alias ? { alias: row.alias ? { ...row.alias, sku: to } : row.alias } : {}) }
  return { listingId: row.id, version: row.version, aliasId: alias?.id ?? null, aliasFrom: alias?.sku ?? null, label: alias?.label ?? null,
    productSku: row.product?.sku ?? '', channel: row.channel, market: row.marketplace, place, from, to,
    held: liveChannelSku(row, row.product?.sku)?.sku ?? null, sends: wantedChannelSku(after, row.product?.sku).sku }
}

const SET_LISTING_SKU_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { listingId?: unknown; extraListingId?: unknown }
    if (typeof after.listingId === 'string' && after.listingId) {
      const row = await prisma.channelListing.findFirst({ where: { id: after.listingId }, select: { channelSku: true } })
      return { listingId: after.listingId, sku: row ? row.channelSku : undefined }
    }
    const aliasId = String(after.extraListingId ?? '')
    if (!(await availableRequirements()).has('listing-alias-sku')) return { extraListingId: aliasId, sku: undefined }
    const [row] = await prisma.$queryRaw<Array<{ sku: string | null }>>`
      SELECT sku FROM "ProductListingAlias" WHERE id = ${aliasId} AND "workspaceId" = ${workspaceIdForQuery()}`
    return { extraListingId: aliasId, sku: row ? row.sku : undefined }
  },
  request(change) {
    const before = (change.before ?? {}) as { listingId?: string; extraListingId?: string; sku?: string | null }
    if (before.listingId) return { tool: 'set-listing-sku', args: { listingId: before.listingId, sku: before.sku ?? '' } }
    if (!before.extraListingId) return { refusal: 'This change does not name its listing.' }
    return { tool: 'set-listing-sku', args: { extraListingId: before.extraListingId, sku: before.sku ?? '' } }
  },
}

/** What the channel sees: nothing (it holds that SKU), a first listing under it, or Publish's move (S10). */
function listingSkuOutcome(plan: ListingSkuPlan): string {
  if (!plan.held) return plan.sends ? `Publish lists it under ${plan.sends}.` : ''
  if (plan.held === plan.sends) return `It is the SKU ${plan.place} holds: nothing moves on the channel.`
  return `${plan.place} holds ${plan.held}: the next Publish moves it to ${plan.sends}.`
}

/** The listing changed between the plan and the write: nothing is kept. */
class ListingSkuMoved extends Error {}

const setListingSku: AgentTool = {
  name: 'set-listing-sku',
  title: 'Set a listing\'s own SKU',
  input: z.object({
    listingId: z.string().trim().max(64).optional().describe('the listing (one channel, market and account), as listing-coordinates or product-identity show it'),
    extraListingId: z.string().trim().max(64).optional().describe('or: the extra listing (listing alias) id, as product-identity shows it'),
    sku: z.string().trim().max(100).describe('the SKU this listing sends on its channel; empty = follow the product SKU again'),
  }),
  requires: [F.listingsEdit],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: SET_LISTING_SKU_UNDO,
  description:
    `Set the SKU ONE listing uses on its channel (that channel, market and account only; Amazon's EU markets each on their own), `
    + `or let it follow the product SKU again (empty). ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. Name the `
    + 'listing by listingId, or an extra listing by extraListingId (its recorded SKU changes with it). A draft or deleted '
    + 'listing takes any SKU: Publish lists it under that SKU. A listing the channel holds moves to the new SKU at the next '
    + 'Publish on Amazon (new offer, old one deleted), eBay Trading and Shopify (renamed in place); an Amazon family\'s main '
    + 'listing, an eBay Inventory listing and Etsy cannot move yet (delete it, then list it again). Refused when another product, an extra listing, '
    + 'or another listing on the same account uses the SKU.',
  async handler(args): Promise<ToolResult> {
    const plan = await planListingSku(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    const extra = plan.label ? ` (the extra listing "${plan.label}")` : ''
    return {
      ok: true,
      preview: {
        action: 'set-listing-sku',
        sku: plan.productSku,
        ...(plan.label ? { extraListing: plan.label } : {}),
        channel: plan.channel,
        market: plan.market,
        changes: { 'listing SKU': { from: plan.from, to: plan.to } },
        effect: `${plan.to ? `The ${plan.place} listing of ${plan.productSku}${extra} uses ${plan.to} in Nexus.`
          : `The ${plan.place} listing of ${plan.productSku}${extra} follows the product SKU again in Nexus.`} ${listingSkuOutcome(plan)}`.trim(),
        note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planListingSku(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    try {
      await prisma.$transaction(async (tx) => {
        // The recorded SKU first, fenced on what the plan read, so the listing's own rules read the listing as it will be.
        if (plan.aliasId) {
          const updated = await tx.$executeRaw`
            UPDATE "ProductListingAlias" SET sku = ${plan.to}, "updatedAt" = now()
            WHERE id = ${plan.aliasId} AND "workspaceId" = ${workspaceIdForQuery()} AND sku IS NOT DISTINCT FROM ${plan.aliasFrom}`
          if (updated !== 1) throw new ListingSkuMoved('The extra listing changed meanwhile. Nothing changed.')
        }
        if (plan.listingId) {
          await setChannelSku(tx, { listingId: plan.listingId, sku: plan.to, actorId: ctx.userId ?? null, expectedVersion: plan.version ?? undefined,
            reason: 'set-listing-sku, approved in Nexus', liveMove: plan.aliasId ? 'allow' : 'refuse' })
        }
      })
    } catch (error) {
      if (error instanceof ListingSkuMoved) return { ok: false, error: error.message }
      if (error instanceof ChannelSkuError) {
        return { ok: false, error: error.code === 'VERSION_CONFLICT' ? 'The listing changed meanwhile. Nothing changed.' : `${error.message} Nothing changed.` }
      }
      if (/unique|23505|P2010/i.test(String((error as { code?: string; message?: string })?.code ?? '') + String((error as Error)?.message ?? ''))) {
        return { ok: false, error: `${plan.to} became another extra listing's SKU meanwhile. Nothing changed.` }
      }
      throw error
    }
    try {
      const { publishListingEvent } = await import('../../listing-events.service.js')
      const listings = plan.aliasId
        ? await prisma.channelListing.findMany({ where: { aliasId: plan.aliasId }, select: { id: true } })
        : [{ id: plan.listingId! }]
      for (const l of listings) publishListingEvent({ type: 'listing.updated', listingId: l.id, reason: 'listing-sku', ts: Date.now() })
    } catch {
      // Best-effort: the write committed; a refresh that did not fire is not a failed change.
    }
    const key = args.extraListingId ? { extraListingId: plan.aliasId } : { listingId: plan.listingId }
    return {
      ok: true,
      data: { listing: plan.place, ...(plan.label ? { extraListing: plan.label } : {}), sku: plan.to, previous: plan.from, note: NEXUS_ONLY },
      change: { before: { ...key, sku: plan.from }, after: { ...key, sku: plan.to } },
    }
  },
}

// ── I9: unlink-channel-id, link-channel-id ────────────────────────────────────────────────────────────

const LINE_CAP = 20

function fixRefusal(error: unknown, nothing: string): ToolResult {
  if (error instanceof IdentityFixRefusal) {
    return { ok: false, error: /not found$/.test(error.message) ? error.message : `${error.message} ${nothing}`.trim() }
  }
  throw error
}

const UNLINK_UNDO: ToolUndo = {
  async current(change) {
    const listingId = String((change.after as { listingId?: unknown } | null)?.listingId ?? '')
    const coordinate = await coordinateOf(listingId)
    return { listingId, externalId: coordinate?.externalId ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { listingId?: string; channel?: string; externalId?: string; suggested?: boolean }
    if (!before.listingId || !before.externalId) return { refusal: 'This change does not name its listing and channel id.' }
    // An ASIN a draft listed on at Publish is set again by name (checked in Amazon's catalog first).
    if (before.channel === 'EBAY' || before.channel === 'ETSY' || before.channel === 'SHOPIFY' || before.suggested) return { tool: 'link-channel-id', args: { listingId: before.listingId, externalId: before.externalId } }
    if (before.channel === 'AMAZON') return { tool: 'link-channel-id', args: { listingId: before.listingId } }
    return { refusal: `A ${before.channel ?? 'channel'} id is linked again in its own flow in Nexus.` }
  },
}

const unlinkChannelId: AgentTool = {
  name: 'unlink-channel-id',
  title: 'Unlink a channel id',
  input: z.object({
    listingId: z.string().trim().min(1).max(64).describe('a listing that carries the id; every row of its family that shares it is unlinked too'),
  }),
  requires: [F.listingsEdit, F.listingsRecover],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'ask',
  undo: UNLINK_UNDO,
  description:
    'Take a channel id (eBay Item ID, ASIN, Shopify product, Etsy listing) off a listing and the family rows that share it, '
    + `so Nexus stops driving that item. ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. A snapshot of each `
    + 'row is kept first; the rows become paused drafts and the shared eBay variations of the item end in Nexus. The item '
    + 'stays live on the channel and can oversell: the preview names the quantity last advertised. The SKU the channel held '
    + 'for each row is forgotten (the SKU Nexus sends stays). A Shopify colour product is not unlinked here. Amazon, one rule '
    + 'with the product sheet\'s ASIN cell: a row on Amazon keeps its ASIN (Amazon ties its seller SKU to it; refused with the '
    + 'way to change it); a row not on Amazon loses only the ASIN it would list on at Publish. Undo links it again (verified '
    + 'on the channel).',
  async handler(args): Promise<ToolResult> {
    try {
      const plan = await planUnlink(String(args.listingId))
      const c = plan.coordinate
      if (plan.suggested) {
        return {
          ok: true,
          preview: {
            action: 'unlink-channel-id', sku: c.rows[0]?.sku ?? c.root.sku, channel: c.channel, market: c.market, externalId: plan.externalId, suggested: true,
            changes: { 'ASIN at Publish': { from: plan.externalId, to: null } },
            effect: `Removes ASIN ${plan.externalId} as the ASIN seller SKU ${plan.suggested.sellerSku} lists on at Publish (Amazon ${c.market}). The row stays a draft; nothing changes on Amazon.`,
            note: 'Nothing is sent to Amazon. Nothing changes until a person approves this in Nexus.',
          },
        }
      }
      return {
        ok: true,
        preview: {
          action: 'unlink-channel-id',
          sku: c.root.sku,
          channel: c.channel,
          market: c.market,
          externalId: plan.externalId,
          changes: { 'channel id': { from: plan.externalId, to: null } },
          listings: plan.rows.slice(0, LINE_CAP).map((r) => `${r.sku} (${r.status}${r.quantity != null ? `, ${r.quantity} advertised` : ''})`),
          ...(plan.rows.length > LINE_CAP ? { moreListings: plan.rows.length - LINE_CAP } : {}),
          liveQuantity: plan.liveQuantity,
          ...(plan.sharedVariations ? { sharedVariations: plan.sharedVariations } : {}),
          effect: `Unlinks ${c.channel} ${plan.externalId} from ${plan.rows.length} listing row(s) of ${c.root.sku} (${c.market}); they become paused drafts in Nexus${plan.sharedVariations ? ` and ${plan.sharedVariations} shared eBay variation(s) end in Nexus` : ''}.`,
          ...(plan.live ? { risk: `The item stays live on ${c.channel} with the ${plan.liveQuantity} unit(s) last advertised, and Nexus no longer updates it: it can oversell until it is ended on the channel or linked again.` } : {}),
          note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
        },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing was queued.')
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const approved = (ctx.approvedPreview as { externalId?: string } | undefined)?.externalId
      const expected = approved ?? (await planUnlink(String(args.listingId))).externalId
      const record = await runUnlink(String(args.listingId), expected, ctx.userId ?? null)
      return {
        ok: true,
        data: record.suggested
          ? { removedAsinAtPublish: record.externalId, note: 'Nothing is sent to Amazon: Publish lists the row without an ASIN of your choice.' }
          : { unlinked: record.externalId, rows: record.rows.length, sharedVariationsEnded: record.membershipIds.length, snapshots: record.snapshotIds.length, note: NEXUS_ONLY },
        change: { before: record, after: { listingId: record.listingId, externalId: null } },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing changed.')
    }
  },
}

const LINK_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { listingId?: unknown; suggestedAsin?: boolean }
    const listingId = String(after.listingId ?? '')
    const coordinate = await coordinateOf(listingId)
    // An ASIN set for Publish reads back as the draft's suggestion (the row holds no ASIN of Amazon's).
    if (after.suggestedAsin) return { listingId, externalId: coordinate?.externalId ?? coordinate?.suggestedId ?? null, suggestedAsin: true }
    return { listingId, externalId: coordinate?.externalId ?? null }
  },
  request(change) {
    const after = (change.after ?? {}) as { listingId?: string; suggestedAsin?: boolean }
    if (!after.listingId) return { refusal: 'This change does not name its listing.' }
    return { tool: 'unlink-channel-id', args: { listingId: after.listingId } }
  },
}

const linkChannelId: AgentTool = {
  name: 'link-channel-id',
  title: 'Link a channel id',
  input: z.object({
    listingId: z.string().trim().min(1).max(64).describe('the listing to link (its family\'s rows on that account and market follow)'),
    externalId: z.string().trim().min(1).max(40).optional()
      .describe('eBay: the Item ID. Etsy: the Listing ID. Shopify: the Product ID. Amazon: leave it out to read the live ASIN from Amazon by the listing\'s seller SKU; '
        + 'give an ASIN only for a row not on Amazon (a draft, or deleted): it becomes the ASIN the row lists on at Publish'),
    acknowledgeUnverifiable: z.boolean().optional()
      .describe('eBay, Etsy, Shopify: link even though it cannot be proven the item is this account\'s or this listing\'s (no recorded seller; an item with no SKUs)'),
  }),
  requires: [F.listingsEdit, F.listingsRecover],
  category: 'listings',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'full',
  maxClaudeTrust: 'ask',
  undo: LINK_UNDO,
  description:
    'Link a listing to the channel item it sells, after checking it on the channel as this business\'s own account. eBay — '
    + 'the Item ID must be listed by this account\'s seller; Etsy — the listing must belong to this account\'s shop; Shopify — '
    + 'the product must be in this business\'s store and carry no other Nexus identity (a colour store confirms the colour it '
    + 'matches, which writes the Nexus identity on the Shopify product). Each must carry this family\'s SKUs on this market and '
    + 'account, and no other family may hold it. It is written only on the rows the item carries, with the status the channel '
    + 'reports, and each row records the SKU the channel proved for it; a variation that holds another item moves to this one '
    + 'only when the channel shows its own SKU on it (the preview lists each such row, and the rows left alone). Amazon — with '
    + 'no externalId the live ASIN is read from Amazon by the listing\'s seller SKU; an ASIN given for a row not on Amazon is '
    + 'checked in Amazon\'s catalog and becomes the ASIN it lists on at Publish; a live offer\'s ASIN is refused (Amazon ties '
    + 'its seller SKU to it). Always waits for a person to approve it in Nexus, and checks again before it writes. The rows '
    + 'stay paused until a person resumes their pushes. The product sheet\'s id cells use the same rules.',
  async handler(args): Promise<ToolResult> {
    try {
      const plan = await planLink(String(args.listingId), { externalId: (args.externalId as string | undefined) ?? null, acknowledgeUnverifiable: args.acknowledgeUnverifiable === true })
      const c = plan.coordinate
      return {
        ok: true,
        preview: {
          action: 'link-channel-id',
          sku: c.root.sku,
          channel: c.channel,
          market: c.market,
          externalId: plan.externalId,
          verdict: plan.verdict,
          proof: plan.reason,
          ...(plan.seller ? { seller: plan.seller } : {}),
          ...(plan.matchedSkus.length ? { matchedSkus: plan.matchedSkus.slice(0, LINE_CAP) } : {}),
          ...(plan.suggestedAsin ? { listings: [plan.suggestedAsin.sellerSku], found: plan.suggestedAsin.found } : {}),
          ...(plan.proof ? {
            listings: plan.proof.rows.slice(0, LINE_CAP).map((r) => r.sku),
            ...(plan.proof.colour ? { colour: plan.proof.colour.name, writesOnShopify: plan.proof.colour.writes } : {}),
            // Owner option A (2026-10-05): rows that hold another item and that eBay shows on this one move with the link.
            ...(plan.proof.moved.length ? { movesFromOtherItem: plan.proof.moved.slice(0, LINE_CAP).map((m) => m.sentence) } : {}),
            ...(plan.proof.kept.length ? { keptOtherItem: plan.proof.kept.slice(0, LINE_CAP).map((k) => k.sentence) } : {}),
            // An extra listing with its main row only (an adopted shell): the variations eBay sells on the item get rows.
            ...(plan.proof.adds?.length ? { addsRows: plan.proof.adds.slice(0, LINE_CAP).map((a) => a.sku) } : {}),
          } : {}),
          changes: { 'channel id': { from: plan.suggestedAsin ? plan.suggestedAsin.current : c.externalId, to: plan.externalId } },
          effect: plan.suggestedAsin
            ? `Sets ASIN ${plan.externalId} as the ASIN seller SKU ${plan.suggestedAsin.sellerSku} lists on at Publish (Amazon ${c.market}); nothing is sent to Amazon now.`
            : plan.proof
            ? `Links ${c.channel} ${plan.externalId} to ${plan.proof.rows.length} row(s) of ${c.root.sku} (${c.market})${plan.proof.moved.length ? `, moving ${plan.proof.moved.length} of them from another item` : ''}${plan.proof.adds?.length ? `, and adds ${plan.proof.adds.length} row(s) this listing has none for yet` : ''}; they read ${plan.proof.status === 'ENDED' ? `Ended${c.channel === 'EBAY' ? ' (Relist is offered)' : ''}` : plan.proof.status === 'INACTIVE' ? 'Inactive' : 'Active'} in Nexus and stay paused until a person resumes their pushes.`
            : `Links ${c.channel} ${plan.externalId} to ${c.root.sku} (${c.market}); its rows become live in Nexus and stay paused until a person resumes their pushes.`,
          note: plan.proof?.colour ? `${plan.proof.colour.writes} Nothing changes until a person approves this in Nexus.` : 'Nothing is sent to the channel. Nothing changes until a person approves this in Nexus.',
        },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing was queued.')
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    try {
      const approved = (ctx.approvedPreview as { externalId?: string } | undefined)?.externalId
      const expected = approved ?? (args.externalId as string | undefined) ?? ''
      const before = await coordinateOf(String(args.listingId))
      const record = await runLink(String(args.listingId), { externalId: (args.externalId as string | undefined) ?? null, acknowledgeUnverifiable: args.acknowledgeUnverifiable === true, expectedExternalId: expected, actor: ctx.userId ?? null })
      return {
        ok: true,
        data: record.suggestedAsin
          ? { listsOnAtPublish: record.externalId, changed: record.suggestedAsin.changed, note: 'Nothing is sent to Amazon now: Publish lists the row on this ASIN.' }
          : { linked: record.externalId, rows: record.rows.length, ...(record.added?.length ? { rowsAdded: record.added.length } : {}), ...(record.status ? { status: record.status } : {}), sharedVariationsLive: record.membershipsReactivated.length,
            ...(record.liveSkus?.length ? { channelSkusRecorded: record.liveSkus.length } : {}), note: 'Pushes stay paused until a person resumes them.' },
        change: { before: { listingId: record.listingId, externalId: record.suggestedAsin ? record.suggestedAsin.previous : before?.externalId ?? null, rows: record.rows },
          after: { listingId: record.listingId, externalId: record.externalId, ...(record.suggestedAsin ? { suggestedAsin: true } : {}) } },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing changed.')
    }
  },
}

export const IDENTITY_FIX_TOOLS: AgentTool[] = [setProductSku, setGtin, setBrand, setListingSku, unlinkChannelId, linkChannelId]
