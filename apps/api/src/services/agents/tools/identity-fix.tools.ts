/**
 * MCP full control I10 — identity fixes a person approves in Nexus: a product's SKU, a barcode, brands, and an extra
 * listing's own SKU. Plan: docs/mcp-full-control/sections/04-identity.md §3 (set-product-sku, set-gtin, set-brand,
 * set-listing-sku).
 *
 * Every tool here changes Nexus only — nothing is sent to a channel — and always waits for a person (alwaysAsk). The
 * `handler` is the preview and writes nothing: product changes go through the product bulk writer's own dry run
 * (`applyProductBulkEdits`, `dryRun: true`), so a preview carries the writer's refusals (SKU unique, a live product's
 * SKU is never renamed, a SKU an extra listing uses) and warnings. `execute` works the change out again from what is
 * stored when it runs (the gate has already compared the approved preview's material fields) and writes through the
 * same writer. Each records what it replaced, and undo asks for the old value through the same gate.
 *
 * d12 (decided): a live listing's channel SKU is RECORDED in Nexus, never renamed on the channel. So a live product's
 * SKU is not renamed (the writer refuses), and an extra listing's SKU may be recorded, but not changed once it is live.
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

type WriterOut = { dryRun?: boolean; wouldUpdate?: number; updated?: number; operationId?: string; errors?: ProductBulkChangeError[]; warnings?: ProductBulkChangeWarning[] }

const writerLines = (items: Array<{ id: string; error?: string; warning?: string }>, skuOf: Map<string, string>) =>
  items.map((item) => `${skuOf.get(item.id) ?? item.id}: ${item.error ?? item.warning}`)

/** The writer's verdict on every change, writing nothing. */
async function writerDryRun(changes: Change[], skuOf: Map<string, string>): Promise<Refusal | { warnings: string[] }> {
  try {
    const out = (await applyProductBulkEdits({ changes, dryRun: true }, writerContext(null))) as WriterOut
    if (out.errors?.length) return { error: writerLines(out.errors, skuOf).join(' ') }
    if (out.dryRun !== true || out.wouldUpdate !== changes.length) {
      return { error: `The product writer could not check every change (${out.wouldUpdate ?? 0} of ${changes.length}).` }
    }
    return { warnings: writerLines(out.warnings ?? [], skuOf) }
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
  draftListings: number
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
  const draftListings = await prisma.channelListing.count({ where: { productId: product.id, listingStatus: 'DRAFT' } })
  return { productId: product.id, from: product.sku, to, draftListings, warnings: checked.warnings }
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
    `Rename a product's SKU in Nexus. ${NEXUS_ONLY} Always waits for a person to approve it in Nexus. Refused when another `
    + 'product or an extra listing of this business uses the SKU, and when the product (or its variation) is live on a '
    + 'channel: a channel\'s seller SKU is never renamed — the SKU the channel shows is recorded instead (set-listing-sku).',
  async handler(args): Promise<ToolResult> {
    const plan = await planSku(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: 'set-product-sku',
        sku: plan.from,
        changes: { SKU: { from: plan.from, to: plan.to } },
        effect: `Renames ${plan.from} to ${plan.to} in Nexus.${plan.draftListings ? ` ${plural(plan.draftListings, 'draft listing')} will be published under the new SKU.` : ''}`,
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
      data: { sku: plan.to, previousSku: plan.from, operationId: out.operationId ?? null, note: NEXUS_ONLY },
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

interface ListingSkuPlan {
  aliasId: string
  label: string
  productSku: string
  channel: string
  market: string
  from: string | null
  to: string | null
  liveListings: number
}

async function planListingSku(args: Record<string, unknown>, nothing: string): Promise<ListingSkuPlan | Refusal> {
  const aliasId = String(args.extraListingId ?? '')
  const to = String(args.sku ?? '').trim() || null
  const alias = await prisma.productListingAlias.findFirst({
    where: { id: aliasId, product: { deletedAt: null } },
    select: { id: true, label: true, channel: true, marketplace: true, product: { select: { sku: true } } },
  })
  if (!alias) return { error: 'Extra listing not found' }
  const name = `The extra listing "${alias.label}" of ${alias.product.sku} (${alias.channel} ${alias.marketplace})`
  // The listing's own SKU comes with the eBay import by SKU (ProductListingAlias.sku). Until that column exists there is
  // nowhere to keep it, and this tool says so instead of pretending.
  if (!(await availableRequirements()).has('listing-alias-sku')) {
    return { error: `${name}: ${REQUIREMENT_MISSING['listing-alias-sku']} ${nothing}` }
  }
  const ws = workspaceIdForQuery()
  const [row] = await prisma.$queryRaw<Array<{ sku: string | null }>>`SELECT sku FROM "ProductListingAlias" WHERE id = ${alias.id} AND "workspaceId" = ${ws}`
  const from = row?.sku ?? null
  if (from === to) return { error: `${name} already has this SKU. ${nothing}` }
  const liveListings = await prisma.channelListing.count({ where: { aliasId: alias.id, listingStatus: 'ACTIVE', isPublished: true } })
  // d12 — a live listing's channel SKU is recorded, never renamed: once recorded, it is not changed to another SKU while
  // live. Recording one, and clearing a wrong record (what undo of a record asks), change nothing on the channel.
  if (from && to && liveListings) {
    return { error: `${name} is live with the SKU ${from}. A channel's seller SKU is never renamed from Nexus: end or relist it on the channel first. ${nothing}` }
  }
  if (to) {
    const [clash] = await prisma.$queryRaw<Array<{ what: string; sku: string }>>`
      SELECT 'product' AS what, p.sku FROM "Product" p
        WHERE p."workspaceId" = ${ws} AND p."deletedAt" IS NULL AND lower(btrim(p.sku)) = ${to.toLowerCase()}
      UNION ALL
      SELECT 'extra listing', a.sku FROM "ProductListingAlias" a
        WHERE a."workspaceId" = ${ws} AND a.id <> ${alias.id} AND lower(btrim(a.sku)) = ${to.toLowerCase()}
      LIMIT 1`
    if (clash) return { error: `${name}: ${to} is already the SKU of ${clash.what === 'product' ? 'a product' : 'another extra listing'} (${clash.sku}). One SKU names one thing. ${nothing}` }
  }
  return { aliasId: alias.id, label: alias.label, productSku: alias.product.sku, channel: alias.channel, market: alias.marketplace, from, to, liveListings }
}

const SET_LISTING_SKU_UNDO: ToolUndo = {
  async current(change) {
    const aliasId = String((change.after as { extraListingId?: unknown } | null)?.extraListingId ?? '')
    if (!(await availableRequirements()).has('listing-alias-sku')) return { extraListingId: aliasId, sku: undefined }
    const [row] = await prisma.$queryRaw<Array<{ sku: string | null }>>`
      SELECT sku FROM "ProductListingAlias" WHERE id = ${aliasId} AND "workspaceId" = ${workspaceIdForQuery()}`
    return { extraListingId: aliasId, sku: row ? row.sku : undefined }
  },
  request(change) {
    const before = (change.before ?? {}) as { extraListingId?: string; sku?: string | null }
    if (!before.extraListingId) return { refusal: 'This change does not name its extra listing.' }
    return { tool: 'set-listing-sku', args: { extraListingId: before.extraListingId, sku: before.sku ?? '' } }
  },
}

const setListingSku: AgentTool = {
  name: 'set-listing-sku',
  title: 'Record an extra listing SKU',
  input: z.object({
    extraListingId: z.string().trim().min(1).max(64).describe('the extra listing (listing alias) id, as product-identity shows it'),
    sku: z.string().trim().max(100).describe('the seller SKU this listing has on its channel; empty clears it'),
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
    `Record the seller SKU of an extra listing (a second listing of a product on the same channel and market). ${NEXUS_ONLY} `
    + 'Always waits for a person to approve it in Nexus. Refused when a product or another extra listing of this business '
    + 'uses the SKU, and when a live listing already has one: a channel\'s seller SKU is recorded, never renamed. Available '
    + 'once the listing-SKU column exists (it comes with the eBay import by SKU); until then it is refused and says so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planListingSku(args, 'Nothing was queued.')
    if ('error' in plan) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: 'set-listing-sku',
        sku: plan.productSku,
        extraListing: plan.label,
        channel: plan.channel,
        market: plan.market,
        changes: { 'listing SKU': { from: plan.from, to: plan.to } },
        effect: plan.to
          ? `Records ${plan.to} as the SKU of the extra listing "${plan.label}" in Nexus.${plan.liveListings ? ' It is live: make sure this is the SKU the channel shows — Nexus does not change it there.' : ''}`
          : `Clears the SKU of the extra listing "${plan.label}" in Nexus.`,
        note: `${NEXUS_ONLY} Nothing changes until a person approves this in Nexus.`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planListingSku(args, 'Nothing changed.')
    if ('error' in plan) return { ok: false, error: plan.error }
    let updated = 0
    try {
      // Fenced on the SKU the plan read: a change in between writes nothing.
      updated = await prisma.$executeRaw`
        UPDATE "ProductListingAlias" SET sku = ${plan.to}, "updatedAt" = now()
        WHERE id = ${plan.aliasId} AND "workspaceId" = ${workspaceIdForQuery()} AND sku IS NOT DISTINCT FROM ${plan.from}`
    } catch (error) {
      if (/unique|23505|P2010/i.test(String((error as { code?: string; message?: string })?.code ?? '') + String((error as Error)?.message ?? ''))) {
        return { ok: false, error: `${plan.to} became another extra listing's SKU meanwhile. Nothing changed.` }
      }
      throw error
    }
    if (updated !== 1) return { ok: false, error: 'The extra listing changed meanwhile. Nothing changed.' }
    try {
      const { publishListingEvent } = await import('../../listing-events.service.js')
      const listings = await prisma.channelListing.findMany({ where: { aliasId: plan.aliasId }, select: { id: true } })
      for (const l of listings) publishListingEvent({ type: 'listing.updated', listingId: l.id, reason: 'listing-sku', ts: Date.now() })
    } catch {
      // Best-effort: the write committed; a refresh that did not fire is not a failed change.
    }
    return {
      ok: true,
      data: { extraListing: plan.label, sku: plan.to, previous: plan.from, note: NEXUS_ONLY },
      change: { before: { extraListingId: plan.aliasId, sku: plan.from }, after: { extraListingId: plan.aliasId, sku: plan.to } },
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
    const before = (change.before ?? {}) as { listingId?: string; channel?: string; externalId?: string }
    if (!before.listingId || !before.externalId) return { refusal: 'This change does not name its listing and channel id.' }
    if (before.channel === 'EBAY') return { tool: 'link-channel-id', args: { listingId: before.listingId, externalId: before.externalId } }
    if (before.channel === 'AMAZON') return { tool: 'link-channel-id', args: { listingId: before.listingId } }
    return { refusal: `A ${before.channel ?? 'channel'} id is linked again in its own flow in Nexus (Shopify: colour products).` }
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
    + 'stays live on the channel and can oversell: the preview names the quantity last advertised. Undo links it again '
    + '(eBay and Amazon, verified on the channel).',
  async handler(args): Promise<ToolResult> {
    try {
      const plan = await planUnlink(String(args.listingId))
      const c = plan.coordinate
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
        data: { unlinked: record.externalId, rows: record.rows.length, sharedVariationsEnded: record.membershipIds.length, snapshots: record.snapshotIds.length, note: NEXUS_ONLY },
        change: { before: record, after: { listingId: record.listingId, externalId: null } },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing changed.')
    }
  },
}

const LINK_UNDO: ToolUndo = {
  async current(change) {
    const listingId = String((change.after as { listingId?: unknown } | null)?.listingId ?? '')
    const coordinate = await coordinateOf(listingId)
    return { listingId, externalId: coordinate?.externalId ?? null }
  },
  request(change) {
    const after = (change.after ?? {}) as { listingId?: string }
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
      .describe('eBay: the Item ID to link. Amazon: leave it out — the ASIN is read from Amazon by the listing\'s seller SKU, never typed'),
    acknowledgeUnverifiable: z.boolean().optional()
      .describe('eBay only: link even though it cannot be proven the item is this account\'s (the account has no recorded seller)'),
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
    'Link a listing to the channel item it sells, after checking it on the channel: eBay — the Item ID must be listed by '
    + 'this account\'s seller and carry this family\'s SKUs on this market and account (no other family may hold it); it is '
    + 'written only on the rows the item carries, with the status eBay reports (an ended item reads Ended, and Relist is '
    + 'offered); a variation that holds another item moves to this one only when eBay shows its own SKU on it (the preview '
    + 'lists each such row, and the rows left alone); Amazon — the ASIN is read from Amazon by the listing\'s seller SKU. Always waits for a person to approve it '
    + 'in Nexus, and checks again before it writes. The rows stay paused until a person resumes their pushes. The product '
    + 'sheet\'s Item ID cell uses the same rules. Shopify links through colour products in Nexus; Etsy is not built yet.',
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
          changes: { 'channel id': { from: c.externalId, to: plan.externalId } },
          ...(plan.proof ? {
            listings: plan.proof.rows.slice(0, LINE_CAP).map((r) => r.sku),
            // Owner option A (2026-10-05): rows that hold another item and that eBay shows on this one move with the link.
            ...(plan.proof.moved.length ? { movesFromOtherItem: plan.proof.moved.slice(0, LINE_CAP).map((m) => m.sentence) } : {}),
            ...(plan.proof.kept.length ? { keptOtherItem: plan.proof.kept.slice(0, LINE_CAP).map((k) => k.sentence) } : {}),
          } : {}),
          effect: plan.proof
            ? `Links ${c.channel} ${plan.externalId} to ${plan.proof.rows.length} row(s) of ${c.root.sku} (${c.market})${plan.proof.moved.length ? `, moving ${plan.proof.moved.length} of them from another item` : ''}; they read ${plan.proof.status === 'ENDED' ? 'Ended (Relist is offered)' : 'Active'} in Nexus and stay paused until a person resumes their pushes.`
            : `Links ${c.channel} ${plan.externalId} to ${c.root.sku} (${c.market}); its rows become live in Nexus and stay paused until a person resumes their pushes.`,
          note: 'Nothing is sent to the channel. Nothing changes until a person approves this in Nexus.',
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
        data: { linked: record.externalId, rows: record.rows.length, ...(record.status ? { status: record.status } : {}), sharedVariationsLive: record.membershipsReactivated.length, note: 'Pushes stay paused until a person resumes them.' },
        change: { before: { listingId: record.listingId, externalId: before?.externalId ?? null, rows: record.rows }, after: { listingId: record.listingId, externalId: record.externalId } },
      }
    } catch (error) {
      return fixRefusal(error, 'Nothing changed.')
    }
  },
}

export const IDENTITY_FIX_TOOLS: AgentTool[] = [setProductSku, setGtin, setBrand, setListingSku, unlinkChannelId, linkChannelId]
