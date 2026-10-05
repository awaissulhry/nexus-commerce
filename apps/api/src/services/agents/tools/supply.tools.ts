/**
 * MCP full control 08 S9 — suppliers and purchase orders Claude asks for: keep a supplier and what it supplies, draft a
 * PO, move it through its workflow (submit, approve, send, acknowledgement) and cancel it.
 *
 * Every tool here is a change: its handler is a dry run, and `execute` runs only after a person approved it in Nexus,
 * through the services the purchasing pages use (services/supply/*, po-workflow). Decided S-1 (Owner, 2026-10-01):
 * Claude drafts, and may ASK to approve and send — one approval card per PO, never automatic; the card shows the
 * supplier's e-mail, the total and its currency, and whether the e-mail is really sent. The PO's workflow actor is the
 * person who approved the request, never an argument. Never: a supplier's auto-PO opt-in (`autoTrigger*`, section
 * 06), a hard delete. email-supplier writes to a supplier's own address on file, from the business's identity (07 O3).
 *
 * 08 S10 — receiving (receive-stock: never more than a line still expects; FBA shipments are Amazon's), inbound
 * shipments (update-inbound-shipment: details, costs, status, a PO's receipt), product costs (set-product-costs, and the
 * landed cost of a received PO copied to the supplier's catalogue) and the reorder suggestions (replenishment-action).
 */

import { createHash } from 'node:crypto'
import { workspaceKey } from '@nexus/database/workspace-context'
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { sanitizeSupplierProductInput, supplierFields, wirePrimarySupplier } from '../../supply/supplier.service.js'
import { createPurchaseOrder } from '../../supply/purchase-order.service.js'
import { draftLineCosts } from '../../supply/draft-line-costs.service.js'
import { nextStatus, transitionPo, type WorkflowTransition } from '../../po-workflow.service.js'
import { publishPoEvent } from '../../po-events.service.js'
import type { AgentTool, ToolResult, ToolUndo } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import { levelOf, readOnlyLocation, SET_STOCK_UNDO } from './stock.tools.js'
import { createPoReceipt, setInboundCosts, type InboundCostsInput } from '../../supply/inbound-shipment.service.js'
import { readPurchaseOrderMatch } from '../../supply/purchase-order.service.js'
import { receiveItems, recordDiscrepancy, releaseQcHold, transitionShipmentStatus } from '../../inbound.service.js'
import { publishInboundEvent } from '../../inbound-events.service.js'
import { defaultStockLocation, StockLocationUnresolved } from '../../default-stock-location.js'
import { bulkSetCosts } from '../../product-costs.service.js'
import { masterCurrency } from '../../fx-rate.service.js'
import { dismissRecommendation } from '../../replenishment-recommendation.service.js'
import { setPreferredSupplier } from '../../supplier-comparison.service.js'
import { createSubstitution } from '../../substitution.service.js'

const PREVIEW_LINES = 20
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
/** A yes/no argument; the words true and false count as one (z.coerce.boolean would read "false" as true). */
const flag = z.preprocess((value) => (value === 'true' ? true : value === 'false' ? false : value), z.boolean())
const basisOf = (facts: unknown) => createHash('sha256').update(JSON.stringify(facts)).digest('hex').slice(0, 16)
const listed = (lines: string[]) => (lines.length > 5 ? `${lines.slice(0, 5).join('; ')}; and ${lines.length - 5} more` : lines.join('; '))
type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

/** Whether a supplier e-mail really goes out from this process (services/email/transport.ts: otherwise a dry run that only logs it). */
const emailLive = () => process.env.NEXUS_ENABLE_OUTBOUND_EMAILS === 'true'
const emailWhat = (to: string | null) =>
  !to ? 'The supplier has no e-mail address: the PO is marked sent and nothing is e-mailed — send it to the supplier yourself.'
    : !emailLive() ? 'E-mail is a dry run here (outbound e-mail is off): the PO is marked sent and the e-mail is logged, not sent.'
      : !process.env.RESEND_API_KEY ? 'Outbound e-mail is on but no e-mail provider key is set: the PO is marked sent and the e-mail fails — send it yourself.'
        : 'The PO is e-mailed to the supplier with an acknowledgement link. This cannot be taken back.'

// ── upsert-supplier ───────────────────────────────────────────────────────────────────────────────────

const SUPPLIER_TEXT_FIELDS = ['contactName', 'email', 'phone', 'addressLine1', 'city', 'postalCode', 'country', 'taxId', 'paymentTerms', 'defaultCurrency', 'notes'] as const
const SUPPLIER_INT_FIELDS = ['leadTimeDays', 'productionTimeDays', 'shippingTimeDays'] as const
const SUPPLIER_FIELDS = ['name', ...SUPPLIER_TEXT_FIELDS, ...SUPPLIER_INT_FIELDS, 'isActive'] as const
type SupplierField = (typeof SUPPLIER_FIELDS)[number]
/** The argument a column is asked for by, where the two differ (a column named like an id is not one). */
const ARG_OF: Partial<Record<SupplierField, string>> = { taxId: 'taxNumber' }
const argOf = (field: string) => ARG_OF[field as SupplierField] ?? field
const ROW_FIELDS = ['supplierSku', 'costCents', 'currencyCode', 'moq', 'casePack', 'leadTimeDaysOverride', 'isPrimary'] as const
type SupplyRow = Partial<Record<(typeof ROW_FIELDS)[number], unknown>>
const SUPPLY_MAX = 250

const rowOf = (r: Record<string, unknown> | null): SupplyRow | null => (r ? Object.fromEntries(ROW_FIELDS.map((k) => [k, r[k] ?? null])) : null)

export const SUPPLIER_LIMITS = z.object({
  maxCostChangePercent: z.number().min(0).max(100).default(20).describe('the most a supplier price may move, in percent'),
})
export function supplierWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const totals = (preview as { totals?: { maxCostChangePercent?: unknown } } | null)?.totals
  if (!totals) return 'the request does not say what it changes'
  const pct = totals.maxCostChangePercent
  if (typeof pct === 'number' && pct > Number(limits.maxCostChangePercent)) return `a supplier price moves ${pct} %, more than the ${limits.maxCostChangePercent} % allowed without a person`
  return null
}

interface SupplierPlan {
  action: 'create' | 'update'
  supplier: { id: string | null; name: string; email: string | null }
  fields: Partial<Record<SupplierField, unknown>>
  changes: Partial<Record<SupplierField, { from: unknown; to: unknown }>>
  rows: Array<{ productId: string; sku: string; before: SupplyRow | null; after: SupplyRow | null; data: Record<string, unknown> }>
}

async function planSupplier(args: Record<string, unknown>): Promise<SupplierPlan | Refusal> {
  const supplierId = args.supplierId as string | undefined
  const named = Object.fromEntries(SUPPLIER_FIELDS.filter((f) => args[argOf(f)] !== undefined).map((f) => [f, args[argOf(f)]])) as Record<string, unknown>
  const fields = supplierFields(named) as Partial<Record<SupplierField, unknown>>
  const current = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId } }) : null
  if (supplierId && !current) return { error: 'Supplier not found' }
  if (!current && !fields.name) return { error: 'name is required to create a supplier' }
  const changes: SupplierPlan['changes'] = {}
  for (const [field, value] of Object.entries(fields) as Array<[SupplierField, unknown]>) {
    const from = current ? (current as unknown as Record<string, unknown>)[field] ?? null : null
    if (!current || JSON.stringify(from) !== JSON.stringify(value ?? null)) changes[field] = { from, to: value ?? null }
  }
  const supplies = (args.supplierProducts ?? []) as Array<Record<string, unknown> & { productId: string }>
  const removals = [...new Set((args.removeProducts ?? []) as string[])]
  const productIds = [...new Set([...supplies.map((s) => s.productId), ...removals])]
  const products = productIds.length ? await prisma.product.findMany({ where: { id: { in: productIds }, deletedAt: null }, select: { id: true, sku: true } }) : []
  if (products.length !== productIds.length) return { error: PRODUCT_NOT_FOUND }
  const skuOf = new Map(products.map((p) => [p.id, p.sku]))
  const existing = current && productIds.length
    ? new Map((await prisma.supplierProduct.findMany({ where: { supplierId: current.id, productId: { in: productIds } } })).map((r) => [r.productId, rowOf(r as never)!]))
    : new Map<string, SupplyRow>()
  const rows: SupplierPlan['rows'] = []
  const problems: string[] = []
  for (const supply of supplies) {
    const sanitized = sanitizeSupplierProductInput(supply)
    if ('error' in sanitized) { problems.push(`${skuOf.get(supply.productId)}: ${sanitized.error}`); continue }
    const before = existing.get(supply.productId) ?? null
    const after = { ...(before ?? rowOf({ moq: 1, isPrimary: false, currencyCode: 'EUR' })!), ...sanitized.data } as SupplyRow
    if (before && JSON.stringify(rowOf(after as never)) === JSON.stringify(before)) continue
    rows.push({ productId: supply.productId, sku: skuOf.get(supply.productId)!, before, after: rowOf(after as never), data: sanitized.data })
  }
  for (const productId of removals) {
    const before = existing.get(productId)
    if (!before) { problems.push(`${skuOf.get(productId)} is not one of this supplier's products`); continue }
    rows.push({ productId, sku: skuOf.get(productId)!, before, after: null, data: {} })
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}` }
  const name = String(fields.name ?? current?.name ?? '')
  if (current && !Object.keys(changes).length && !rows.length) return { error: `Nothing to change on supplier "${name}": name a field with a new value, or a product it supplies.` }
  return { action: current ? 'update' : 'create', supplier: { id: current?.id ?? null, name, email: (fields.email as string | null | undefined) ?? current?.email ?? null }, fields, changes, rows }
}

const costPercent = (from: unknown, to: unknown) =>
  typeof from === 'number' && typeof to === 'number' && from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null

const SUPPLIER_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { supplierId?: string; fields?: Record<string, unknown>; products?: Array<{ productId: string }> }
    if (!after.supplierId) return null
    const supplier = await prisma.supplier.findUnique({ where: { id: after.supplierId } })
    const rows = after.products?.length
      ? new Map((await prisma.supplierProduct.findMany({ where: { supplierId: after.supplierId, productId: { in: after.products.map((p) => p.productId) } } })).map((r) => [r.productId, rowOf(r as never)]))
      : new Map()
    return {
      supplierId: after.supplierId,
      fields: Object.fromEntries(Object.keys(after.fields ?? {}).map((k) => [k, supplier ? (supplier as unknown as Record<string, unknown>)[k] ?? null : null])),
      products: (after.products ?? []).map((p) => ({ productId: p.productId, row: rows.get(p.productId) ?? null })),
    }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; supplierId?: string | null; fields?: Record<string, unknown>; products?: Array<{ productId: string; row: SupplyRow | null }> }
    const after = (change.after ?? {}) as { supplierId?: string }
    if (!after.supplierId) return { refusal: 'This change does not name its supplier.' }
    if (before.action === 'create') return { tool: 'upsert-supplier', args: { supplierId: after.supplierId, isActive: false } }
    const products = before.products ?? []
    return {
      tool: 'upsert-supplier',
      args: {
        supplierId: after.supplierId,
        ...Object.fromEntries(Object.entries(before.fields ?? {}).map(([field, value]) => [argOf(field), value])),
        // A price with no currency of its own stays as it is (the column cannot be emptied here).
        ...(products.some((p) => p.row) ? { supplierProducts: products.filter((p) => p.row).map((p) => ({ productId: p.productId, ...Object.fromEntries(Object.entries(p.row!).filter(([k, v]) => !(k === 'currencyCode' && v == null))) })) } : {}),
        ...(products.some((p) => !p.row) ? { removeProducts: products.filter((p) => !p.row).map((p) => p.productId) } : {}),
      },
    }
  },
}

const nullableText = (max: number, what: string) => z.string().trim().max(max).nullable().optional().describe(what)

const upsertSupplier: AgentTool = {
  name: 'upsert-supplier',
  title: 'Keep a supplier',
  input: z.object({
    supplierId: z.string().trim().min(1).max(64).optional().describe('the supplier to change (supplier-search lists them); leave it out to create one'),
    name: z.string().trim().min(1).max(200).optional().describe('the supplier\'s name (required to create)'),
    contactName: nullableText(200, 'the main contact'),
    email: nullableText(200, 'where purchase orders are e-mailed'),
    phone: nullableText(60, 'phone'),
    addressLine1: nullableText(200, 'street address'),
    city: nullableText(100, 'city'),
    postalCode: nullableText(30, 'postal code'),
    country: nullableText(60, 'country'),
    taxNumber: nullableText(60, 'VAT or tax number'),
    paymentTerms: nullableText(200, 'payment terms, e.g. 30 days net'),
    defaultCurrency: nullableText(3, 'the currency it invoices in, e.g. EUR'),
    notes: nullableText(1000, 'notes'),
    leadTimeDays: z.coerce.number().int().min(0).max(365).optional().describe('days from order to arrival'),
    productionTimeDays: z.coerce.number().int().min(0).max(365).nullable().optional().describe('days to produce'),
    shippingTimeDays: z.coerce.number().int().min(0).max(365).nullable().optional().describe('days in transit'),
    isActive: flag.optional().describe('false switches the supplier off (it is never deleted here)'),
    supplierProducts: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      supplierSku: z.string().trim().max(100).nullable().optional().describe('the supplier\'s own code for it'),
      costCents: z.coerce.number().int().min(0).max(100_000_000).nullable().optional().describe('its price, in cents of currencyCode'),
      currencyCode: z.string().trim().length(3).optional().describe('the price\'s currency, e.g. EUR'),
      moq: z.coerce.number().int().min(1).max(1_000_000).optional().describe('minimum order quantity'),
      casePack: z.coerce.number().int().min(1).max(1_000_000).nullable().optional().describe('units per case'),
      leadTimeDaysOverride: z.coerce.number().int().min(0).max(365).nullable().optional().describe('its own lead time, in days'),
      isPrimary: flag.optional().describe('the product\'s main supplier (replenishment orders from it)'),
    })).max(SUPPLY_MAX).optional().describe(`products it supplies, added or changed, up to ${SUPPLY_MAX}`),
    removeProducts: z.array(z.string().trim().min(1).max(64)).max(SUPPLY_MAX).optional().describe('product ids it no longer supplies'),
  }),
  requires: [F.suppliersManage, FIELDS.financialsSuppliersView],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  // Undo puts the supplier's fields and its product rows back; another supplier that stopped being a product's main
  // supplier, and the product's preferred supplier for replenishment, stay as they are.
  reversibility: 'partial',
  maxClaudeTrust: 'auto',
  limits: SUPPLIER_LIMITS,
  withinLimits: supplierWithinLimits,
  undo: SUPPLIER_UNDO,
  description:
    'Create a supplier or change one — its details, lead times, and the products it supplies (supplier SKU, price, MOQ, '
    + 'case pack, lead time, main supplier) — or take products off it. A supplier is switched off, never deleted, and '
    + 'its automatic reordering is never switched on here. Waits for a person to approve it in Nexus unless the '
    + 'business lets Claude make small price changes itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planSupplier(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const pcts = plan.rows.map((r) => costPercent(r.before?.costCents, r.after?.costCents)).filter((p): p is number => p != null).map(Math.abs)
    return {
      ok: true,
      preview: {
        action: plan.action,
        supplier: { id: plan.supplier.id, name: plan.supplier.name },
        changes: plan.changes,
        products: plan.rows.slice(0, PREVIEW_LINES).map((r) => ({
          sku: r.sku, change: !r.before ? 'add' : !r.after ? 'remove' : 'update',
          ...(r.after ? { costCents: r.after.costCents, currencyCode: r.after.currencyCode, moq: r.after.moq, isPrimary: r.after.isPrimary } : {}),
          ...(r.before && r.after ? { costCentsBefore: r.before.costCents, costChangePercent: costPercent(r.before.costCents, r.after.costCents) } : {}),
        })),
        ...(plan.rows.length > PREVIEW_LINES ? { moreProducts: plan.rows.length - PREVIEW_LINES } : {}),
        totals: {
          fields: Object.keys(plan.changes).length,
          productsAdded: plan.rows.filter((r) => !r.before).length,
          productsChanged: plan.rows.filter((r) => r.before && r.after).length,
          productsRemoved: plan.rows.filter((r) => !r.after).length,
          maxCostChangePercent: pcts.length ? Math.max(...pcts) : null,
        },
        note: `${NOT_YET} A main supplier becomes the product's preferred supplier for replenishment.`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planSupplier(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const supplierId = await prisma.$transaction(async (tx) => {
      const id = plan.supplier.id
        ? (Object.keys(plan.fields).length ? (await tx.supplier.update({ where: { id: plan.supplier.id }, data: plan.fields as never })).id : plan.supplier.id)
        : (await tx.supplier.create({ data: { ...plan.fields, name: plan.supplier.name } as never })).id
      for (const row of plan.rows) {
        if (!row.after) {
          await tx.supplierProduct.deleteMany({ where: { supplierId: id, productId: row.productId } })
          await tx.replenishmentRule.updateMany({ where: { productId: row.productId, preferredSupplierId: id }, data: { preferredSupplierId: null } })
          continue
        }
        const saved = row.before
          ? await tx.supplierProduct.update({ where: { supplierId_productId: workspaceKey({ supplierId: id, productId: row.productId }) }, data: row.data })
          : await tx.supplierProduct.create({ data: { supplierId: id, productId: row.productId, ...row.data } as never })
        if (saved.isPrimary) await wirePrimarySupplier(tx, row.productId, id)
      }
      return id
    })
    return {
      ok: true,
      data: { supplierId, action: plan.action },
      change: {
        before: {
          action: plan.action, supplierId: plan.supplier.id,
          fields: Object.fromEntries(Object.entries(plan.changes).map(([k, c]) => [k, c!.from])),
          products: plan.rows.map((r) => ({ productId: r.productId, sku: r.sku, row: r.before })),
        },
        after: {
          supplierId,
          fields: Object.fromEntries(Object.entries(plan.changes).map(([k, c]) => [k, c!.to])),
          products: plan.rows.map((r) => ({ productId: r.productId, row: r.after })),
        },
      },
    }
  },
}

// ── draft-purchase-order ──────────────────────────────────────────────────────────────────────────────

const PO_MAX_LINES = 200

export const DRAFT_LIMITS = z.object({
  maxTotalCents: z.number().int().min(0).max(100_000_000).default(200_000).describe('the largest PO total, in cents (default €2,000)'),
  maxLines: z.number().int().min(1).max(PO_MAX_LINES).default(PO_MAX_LINES).describe('the most lines one PO has'),
})
export function draftWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { totals?: { totalCents?: unknown; lines?: unknown }; approval?: { thresholdCents?: unknown } } | null
  const total = p?.totals?.totalCents
  if (typeof total !== 'number' || typeof p?.totals?.lines !== 'number') return 'the request does not say its total'
  if (total > Number(limits.maxTotalCents)) return `the PO totals ${total / 100}, more than the ${Number(limits.maxTotalCents) / 100} allowed without a person`
  const threshold = p.approval?.thresholdCents
  if (typeof threshold === 'number' && total > threshold) return `the PO totals ${total / 100}, above the PO approval threshold of ${threshold / 100}`
  if (p.totals.lines > Number(limits.maxLines)) return `it has ${p.totals.lines} lines, more than the ${limits.maxLines} allowed without a person`
  return null
}

interface DraftLine { productId: string; sku: string; supplierSku: string | null; quantity: number; unitCostCents: number }
interface DraftPlan {
  action: 'create' | 'edit'
  po: { id: string | null; poNumber: string | null; status: string; version: number | null }
  supplier: { id: string; name: string; email: string | null }
  currencyCode: string
  lines: DraftLine[] | null
  linesBefore: DraftLine[] | null
  header: { expectedDeliveryDate?: string | null; notes?: string | null }
  headerBefore: { expectedDeliveryDate: string | null; notes: string | null }
  thresholdCents: number | null
  requireApproval: boolean
}

const totalOf = (lines: DraftLine[]) => lines.reduce((s, l) => s + l.quantity * l.unitCostCents, 0)
const dateOnly = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

async function linesFor(supplierId: string, asked: Array<{ productId: string; quantity: number; unitCostCents?: number }>, currency: string | null): Promise<{ lines: DraftLine[]; currencyCode: string } | Refusal> {
  const ids = [...new Set(asked.map((l) => l.productId))]
  if (ids.length !== asked.length) return { error: 'A product is on two lines: give each product one line.' }
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true } })
  if (products.length !== ids.length) return { error: PRODUCT_NOT_FOUND }
  const costs = await draftLineCosts(supplierId, ids)
  const currencyCode = currency ?? costs.currencyCode
  const supplierSkus = new Map((await prisma.supplierProduct.findMany({ where: { supplierId, productId: { in: ids } }, select: { productId: true, supplierSku: true } })).map((r) => [r.productId, r.supplierSku]))
  const skuOf = new Map(products.map((p) => [p.id, p.sku]))
  return {
    currencyCode,
    lines: asked.map((l) => ({
      productId: l.productId, sku: skuOf.get(l.productId)!, supplierSku: supplierSkus.get(l.productId) ?? null, quantity: l.quantity,
      unitCostCents: l.unitCostCents ?? (currencyCode === costs.currencyCode ? costs.costOf(l.productId) : 0),
    })),
  }
}

async function planDraft(args: Record<string, unknown>): Promise<DraftPlan | Refusal> {
  const settings = await prisma.brandSettings.findFirst({ select: { requireApprovalForPo: true, poApprovalThresholdCents: true } })
  const thresholdCents = settings?.poApprovalThresholdCents ?? null
  const header: DraftPlan['header'] = {
    ...(args.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: args.expectedDeliveryDate as string | null } : {}),
    ...(args.notes !== undefined ? { notes: args.notes as string | null } : {}),
  }
  const asked = args.lines as Array<{ productId: string; quantity: number; unitCostCents?: number }> | undefined
  const poId = args.purchaseOrderId as string | undefined
  if (poId) {
    const po = await prisma.purchaseOrder.findUnique({
      where: { id: poId },
      select: { id: true, poNumber: true, status: true, version: true, deletedAt: true, currencyCode: true, expectedDeliveryDate: true, notes: true, supplier: { select: { id: true, name: true, email: true } }, items: { orderBy: { lineOrder: 'asc' }, select: { productId: true, sku: true, supplierSku: true, quantityOrdered: true, unitCostCents: true } } },
    })
    if (!po || po.deletedAt) return { error: 'Purchase order not found' }
    if (po.status !== 'DRAFT') return { error: `Only a DRAFT purchase order is edited; ${po.poNumber} is ${po.status}.` }
    if (args.version != null && Number(args.version) !== po.version) return { error: `${po.poNumber} changed since (version ${po.version}, not ${args.version}): read it again.` }
    if (!po.supplier) return { error: `${po.poNumber} has no supplier: edit it in Nexus.` }
    const linesBefore = po.items.map((i) => ({ productId: i.productId ?? '', sku: i.sku, supplierSku: i.supplierSku, quantity: i.quantityOrdered, unitCostCents: i.unitCostCents }))
    let lines: DraftLine[] | null = null
    if (asked) {
      if (linesBefore.some((l) => !l.productId)) return { error: `${po.poNumber} has a line without a product: edit it in Nexus.` }
      const built = await linesFor(po.supplier.id, asked, po.currencyCode)
      if (refused(built)) return built
      lines = built.lines
    }
    if (!lines && !Object.keys(header).length) return { error: `Nothing to change on ${po.poNumber}: give lines, an expected delivery date or notes.` }
    return {
      action: 'edit', po: { id: po.id, poNumber: po.poNumber, status: po.status, version: po.version }, supplier: po.supplier, currencyCode: po.currencyCode,
      lines, linesBefore, header, headerBefore: { expectedDeliveryDate: dateOnly(po.expectedDeliveryDate), notes: po.notes }, thresholdCents,
      requireApproval: (settings?.requireApprovalForPo ?? false) || (thresholdCents != null && totalOf(lines ?? linesBefore) > thresholdCents),
    }
  }
  const supplierId = args.supplierId as string | undefined
  if (!supplierId) return { error: 'supplierId is required to draft a purchase order (or purchaseOrderId to edit one)' }
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId }, select: { id: true, name: true, email: true, isActive: true } })
  if (!supplier) return { error: 'Supplier not found' }
  if (!supplier.isActive) return { error: `Supplier "${supplier.name}" is switched off.` }
  let wanted = asked
  if (!wanted && args.fromSuggestions === true) {
    const supplied = await prisma.supplierProduct.findMany({ where: { supplierId }, select: { productId: true, moq: true } })
    const moq = new Map(supplied.map((s) => [s.productId, s.moq]))
    const recs = await prisma.replenishmentRecommendation.findMany({ where: { status: 'ACTIVE', needsReorder: true, productId: { in: [...moq.keys()] }, product: { deletedAt: null } }, select: { productId: true, reorderQuantity: true } })
    wanted = recs.filter((r) => r.reorderQuantity > 0).map((r) => ({ productId: r.productId, quantity: Math.max(r.reorderQuantity, moq.get(r.productId) ?? 1) }))
    if (!wanted.length) return { error: `No product of "${supplier.name}" needs reordering now.` }
  }
  if (!wanted?.length) return { error: 'lines are required (or fromSuggestions: true)' }
  const built = await linesFor(supplier.id, wanted, typeof args.currencyCode === 'string' ? args.currencyCode : null)
  if (refused(built)) return built
  const total = totalOf(built.lines)
  return {
    action: 'create', po: { id: null, poNumber: null, status: 'DRAFT', version: null }, supplier, currencyCode: built.currencyCode,
    lines: built.lines, linesBefore: null, header, headerBefore: { expectedDeliveryDate: null, notes: null }, thresholdCents,
    requireApproval: (settings?.requireApprovalForPo ?? false) || (thresholdCents != null && total > thresholdCents),
  }
}

const DRAFT_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { purchaseOrderId?: string; version?: number }
    if (!after.purchaseOrderId) return null
    const po = await prisma.purchaseOrder.findUnique({ where: { id: after.purchaseOrderId }, select: { status: true, version: true } })
    return 'version' in after ? { purchaseOrderId: after.purchaseOrderId, version: po?.version ?? null } : { purchaseOrderId: after.purchaseOrderId, status: po?.status ?? null }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; lines?: DraftLine[]; header?: Record<string, unknown> }
    const after = (change.after ?? {}) as { purchaseOrderId?: string; version?: number }
    if (!after.purchaseOrderId) return { refusal: 'This change does not name its purchase order.' }
    if (before.action === 'create') return { tool: 'cancel-purchase-order', args: { purchaseOrderId: after.purchaseOrderId, reason: 'Undo of a draft asked for through Claude' } }
    return {
      tool: 'draft-purchase-order',
      args: {
        purchaseOrderId: after.purchaseOrderId, version: after.version,
        ...(before.lines ? { lines: before.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitCostCents: l.unitCostCents })) } : {}),
        ...(before.header ?? {}),
      },
    }
  },
}

const draftPurchaseOrder: AgentTool = {
  name: 'draft-purchase-order',
  title: 'Draft a purchase order',
  input: z.object({
    purchaseOrderId: z.string().trim().min(1).max(64).optional().describe('a DRAFT PO to change (leave it out to draft a new one)'),
    supplierId: z.string().trim().min(1).max(64).optional().describe('new PO: the supplier'),
    version: z.coerce.number().int().min(1).optional().describe('change: the version you read (purchase-orders shows it); a newer one is refused'),
    lines: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      quantity: z.coerce.number().int().min(1).max(100_000).describe('units to order'),
      unitCostCents: z.coerce.number().int().min(0).max(100_000_000).optional().describe('price per unit in cents (default: the supplier\'s price, else the cost price)'),
    })).min(1).max(PO_MAX_LINES).optional().describe(`the lines, 1 to ${PO_MAX_LINES}; a change replaces them all`),
    fromSuggestions: flag.optional().describe('new PO: one line per product of this supplier that needs reordering (replenishment-suggestions), at its suggested quantity'),
    currencyCode: z.string().trim().length(3).optional().describe('new PO: its currency (default: the supplier\'s)'),
    expectedDeliveryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe('YYYY-MM-DD'),
    notes: z.string().trim().max(500).nullable().optional().describe('notes on the PO'),
  }),
  requires: [F.poCreate],
  restrictedFields: { totalCents: FIELDS.financialsSuppliersView, lineTotalCents: FIELDS.financialsSuppliersView, thresholdCents: FIELDS.financialsSuppliersView },
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: DRAFT_LIMITS,
  withinLimits: draftWithinLimits,
  undo: DRAFT_UNDO,
  description:
    'Draft a purchase order for a supplier — from lines you give, or from the products of that supplier that need '
    + 'reordering — or change a DRAFT (its lines, expected date, notes). A draft goes nowhere: submitting, approving '
    + 'and sending are advance-purchase-order. Line prices default to the supplier\'s price. Waits for a person to '
    + 'approve it in Nexus unless the business lets Claude draft small orders itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planDraft(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const lines = plan.lines ?? plan.linesBefore ?? []
    return {
      ok: true,
      preview: {
        action: plan.action,
        purchaseOrder: { ...plan.po, supplier: plan.supplier.name, currencyCode: plan.currencyCode },
        lines: lines.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, supplierSku: l.supplierSku, quantity: l.quantity, unitCostCents: l.unitCostCents, lineTotalCents: l.quantity * l.unitCostCents })),
        ...(lines.length > PREVIEW_LINES ? { moreLines: lines.length - PREVIEW_LINES } : {}),
        ...(Object.keys(plan.header).length ? { header: plan.header } : {}),
        totals: { lines: lines.length, units: lines.reduce((s, l) => s + l.quantity, 0), totalCents: totalOf(lines), basis: basisOf(lines.map((l) => [l.productId, l.quantity, l.unitCostCents])) },
        approval: { thresholdCents: plan.thresholdCents, needsApprovalWhenSubmitted: plan.requireApproval },
        note: `${NOT_YET} A draft stays in Nexus: nothing is sent to the supplier.${lines.some((l) => !l.unitCostCents) ? ' A line with no known price is at 0: set it before sending.' : ''}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planDraft(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.action === 'create') {
      const po = await createPurchaseOrder({
        supplierId: plan.supplier.id, currencyCode: plan.currencyCode, notes: plan.header.notes ?? undefined,
        expectedDeliveryDate: plan.header.expectedDeliveryDate ?? undefined,
        items: plan.lines!.map((l) => ({ productId: l.productId, sku: l.sku, supplierSku: l.supplierSku ?? undefined, quantityOrdered: l.quantity, unitCostCents: l.unitCostCents })),
      })
      if (!po) return { ok: false, error: 'lines are required' }
      return { ok: true, data: { purchaseOrderId: po.id, poNumber: po.poNumber, totalCents: po.totalCents }, change: { before: { action: 'create', supplierId: plan.supplier.id }, after: { purchaseOrderId: po.id, status: 'DRAFT' } } }
    }
    const id = plan.po.id!
    const lines = plan.lines
    const version = await prisma.$transaction(async (tx) => {
      // The version seen when the preview was approved: an edit in between refuses this one (compare-and-set).
      const claimed = await tx.purchaseOrder.updateMany({
        where: { id, status: 'DRAFT', version: plan.po.version! },
        data: {
          version: { increment: 1 },
          ...(plan.header.notes !== undefined ? { notes: plan.header.notes } : {}),
          ...(plan.header.expectedDeliveryDate !== undefined ? { expectedDeliveryDate: plan.header.expectedDeliveryDate ? new Date(plan.header.expectedDeliveryDate) : null } : {}),
          ...(lines ? { totalCents: totalOf(lines) } : {}),
        },
      })
      if (claimed.count === 0) return null
      if (lines) {
        await tx.purchaseOrderItem.deleteMany({ where: { purchaseOrderId: id } })
        await tx.purchaseOrderItem.createMany({ data: lines.map((l, i) => ({ purchaseOrderId: id, productId: l.productId, sku: l.sku, supplierSku: l.supplierSku, quantityOrdered: l.quantity, unitCostCents: l.unitCostCents, lineOrder: i })) })
      }
      return plan.po.version! + 1
    })
    if (version == null) return { ok: false, error: `${plan.po.poNumber} changed meanwhile: nothing was written. Ask again.` }
    publishPoEvent({ type: 'po.updated', poId: id, reason: 'lines', ts: Date.now() } as never)
    return {
      ok: true,
      data: { purchaseOrderId: id, version },
      change: {
        before: { action: 'edit', purchaseOrderId: id, ...(lines ? { lines: plan.linesBefore } : {}), header: Object.fromEntries(Object.keys(plan.header).map((k) => [k, plan.headerBefore[k as keyof DraftPlan['headerBefore']]])) },
        after: { purchaseOrderId: id, version },
      },
    }
  },
}

// ── advance-purchase-order / cancel-purchase-order ────────────────────────────────────────────────────

const ADVANCE = ['submit-for-review', 'approve', 'send', 'acknowledge'] as const
/** As the transition route does: open purchasing pages refresh on a real move (not on the idempotent no-op). */
const announce = (moved: { poId: string; poNumber: string; fromStatus: string; toStatus: string }) => {
  if (moved.fromStatus !== moved.toStatus) publishPoEvent({ type: 'po.transitioned', poId: moved.poId, poNumber: moved.poNumber, fromStatus: moved.fromStatus, toStatus: moved.toStatus, ts: Date.now() })
}
const NEEDS_APPROVE = new Set(['approve', 'send'])

async function poForWorkflow(args: Record<string, unknown>) {
  const po = await prisma.purchaseOrder.findUnique({
    where: { id: String(args.purchaseOrderId ?? '') },
    select: { id: true, poNumber: true, status: true, version: true, deletedAt: true, totalCents: true, currencyCode: true, supplier: { select: { name: true, email: true } }, _count: { select: { items: true } } },
  })
  if (!po || po.deletedAt) return { error: 'Purchase order not found' } as Refusal
  if (args.version != null && Number(args.version) !== po.version) return { error: `${po.poNumber} changed since (version ${po.version}, not ${args.version}): read it again.` } as Refusal
  return po
}

const advancePurchaseOrder: AgentTool = {
  name: 'advance-purchase-order',
  title: 'Move a purchase order on',
  input: z.object({
    purchaseOrderId: z.string().trim().min(1).max(64).describe('the PO (purchase-orders lists them)'),
    transition: z.preprocess(lower, z.enum(ADVANCE)).describe('submit-for-review, approve, send (e-mails the supplier) or acknowledge (the supplier confirmed)'),
    version: z.coerce.number().int().min(1).optional().describe('the version you read; a newer one is refused'),
  }),
  // Submitting and acknowledging need po.create; approving and sending also need po.approve (checked per call).
  requires: [F.poCreate],
  restrictedFields: { totalCents: FIELDS.financialsSuppliersView },
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Move one purchase order on in its workflow: submit it for review (it goes straight to approved when no approval '
    + 'is required and its total is under the threshold), approve it, send it (the supplier is e-mailed the PO with an '
    + 'acknowledgement link — this commits the spend and cannot be taken back), or record the supplier\'s '
    + 'acknowledgement. One approval per PO, never automatic: the card shows the supplier\'s e-mail, the total and '
    + 'currency, and whether the e-mail really goes out. The person who approves is recorded as the one who did it.',
  async handler(args, ctx): Promise<ToolResult> {
    const po = await poForWorkflow(args)
    if (refused(po)) return { ok: false, error: po.error }
    if (NEEDS_APPROVE.has(String(args.transition)) && !ctx.can(F.poApprove)) return { ok: false, error: `${po.poNumber}: to ${args.transition} a purchase order you need the permission to approve purchase orders.` }
    const settings = await prisma.brandSettings.findFirst({ select: { requireApprovalForPo: true, poApprovalThresholdCents: true } })
    const thresholdHit = settings?.poApprovalThresholdCents != null && po.totalCents > settings.poApprovalThresholdCents
    const step = nextStatus({ current: po.status, transition: args.transition as WorkflowTransition, requireApproval: (settings?.requireApprovalForPo ?? false) || thresholdHit })
    if (step.ok === false) return { ok: false, error: `${po.poNumber}: ${step.reason}.` }
    return {
      ok: true,
      preview: {
        action: args.transition,
        purchaseOrder: { id: po.id, poNumber: po.poNumber, status: po.status, version: po.version, nextStatus: step.next, ...(step.autoAdvanced.length ? { passesThrough: step.autoAdvanced } : {}), lines: po._count.items },
        supplier: { name: po.supplier?.name ?? null, email: po.supplier?.email ?? null },
        totalCents: po.totalCents,
        currencyCode: po.currencyCode,
        ...(args.transition === 'send' ? { email: { to: po.supplier?.email ?? null, live: emailLive() && !!po.supplier?.email, what: emailWhat(po.supplier?.email ?? null) } } : {}),
        note: `${NOT_YET} The person who approves is recorded as the one who ${args.transition === 'approve' ? 'approved' : args.transition === 'send' ? 'sent' : 'moved'} it.${args.transition === 'send' ? ' Sending commits the spend.' : ''}`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const po = await poForWorkflow(args)
    if (refused(po)) return { ok: false, error: po.error }
    if (NEEDS_APPROVE.has(String(args.transition)) && !ctx.can(F.poApprove)) return { ok: false, error: `${po.poNumber}: to ${args.transition} a purchase order you need the permission to approve purchase orders.` }
    try {
      // The actor is the person who approved this request (ctx.userId in a run), never an argument.
      const moved = await transitionPo({ poId: po.id, transition: args.transition as WorkflowTransition, userId: ctx.userId ?? null })
      announce(moved)
      return {
        ok: true,
        data: {
          poNumber: moved.poNumber, from: moved.fromStatus, to: moved.toStatus, passedThrough: moved.autoAdvanced,
          // Only whether it went out: the result also carries the acknowledgement link, a secret.
          ...(moved.supplierEmail ? { email: moved.supplierEmail.emailDelivery } : {}),
        },
        change: { before: { purchaseOrderId: po.id, status: moved.fromStatus }, after: { purchaseOrderId: po.id, status: moved.toStatus } },
      }
    } catch (error) {
      return { ok: false, error: `${po.poNumber}: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

const cancelPurchaseOrder: AgentTool = {
  name: 'cancel-purchase-order',
  title: 'Cancel a purchase order',
  input: z.object({
    purchaseOrderId: z.string().trim().min(1).max(64).describe('the PO (purchase-orders lists them)'),
    reason: z.string().trim().min(1).max(200).describe('why it is cancelled (kept on the PO)'),
    version: z.coerce.number().int().min(1).optional().describe('the version you read; a newer one is refused'),
  }),
  requires: [F.poCreate],
  restrictedFields: { totalCents: FIELDS.financialsSuppliersView },
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Cancel a purchase order that has not been sent (DRAFT, REVIEW or APPROVED). A sent PO is cancelled with the '
    + 'supplier, not here. A cancelled PO cannot be reopened. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const po = await poForWorkflow(args)
    if (refused(po)) return { ok: false, error: po.error }
    if (!['DRAFT', 'REVIEW', 'APPROVED'].includes(po.status)) return { ok: false, error: `${po.poNumber} is ${po.status}: only a PO that has not been sent is cancelled here.` }
    return {
      ok: true,
      preview: {
        action: 'cancel',
        purchaseOrder: { id: po.id, poNumber: po.poNumber, status: po.status, version: po.version, lines: po._count.items },
        supplier: po.supplier?.name ?? null,
        totalCents: po.totalCents,
        currencyCode: po.currencyCode,
        reason: args.reason,
        note: `${NOT_YET} A cancelled PO cannot be reopened; draft a new one if needed. Nothing is sent to the supplier.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const po = await poForWorkflow(args)
    if (refused(po)) return { ok: false, error: po.error }
    try {
      const moved = await transitionPo({ poId: po.id, transition: 'cancel', userId: ctx.userId ?? null, cancelReason: String(args.reason) })
      announce(moved)
      return { ok: true, data: { poNumber: moved.poNumber, from: moved.fromStatus, to: moved.toStatus }, change: { before: { purchaseOrderId: po.id, status: moved.fromStatus }, after: { purchaseOrderId: po.id, status: moved.toStatus } } }
    } catch (error) {
      return { ok: false, error: `${po.poNumber}: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

// ── receive-stock ─────────────────────────────────────────────────────────────────────────────────────

const RECEIVE_ACTIONS = ['receive', 'release-hold', 'report-discrepancy'] as const
const QC = ['PASS', 'HOLD', 'FAIL'] as const
const DISCREPANCY_REASONS = ['SHORT_SHIP', 'OVER_SHIP', 'WRONG_ITEM', 'DAMAGED', 'QUALITY_ISSUE', 'LATE_ARRIVAL', 'COST_VARIANCE', 'OTHER'] as const
const RECEIVE_MAX = 250
const CLOSED_INBOUND = ['CLOSED', 'CANCELLED', 'RECONCILED']
const INBOUND_NOT_FOUND = 'Inbound shipment not found'
const PO_NOT_FOUND = 'Purchase order not found'
const dateArg = (what: string) => z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional().describe(`${what} (YYYY-MM-DD)`)

/** Where a receive lands: the shipment's warehouse, else the business's default warehouse (as receiveItems resolves it). */
async function receiveLocation(warehouseId: string | null) {
  const select = { id: true, code: true, name: true, type: true } as const
  const own = warehouseId ? await prisma.stockLocation.findUnique({ where: { warehouseId }, select }) : null
  if (own) return own
  try {
    const fallback = (await defaultStockLocation()) ?? (await prisma.stockLocation.findFirst({ where: { code: 'IT-MAIN' }, select: { id: true, code: true } }))
    return fallback ? prisma.stockLocation.findUniqueOrThrow({ where: { id: fallback.id }, select }) : null
  } catch (error) {
    if (error instanceof StockLocationUnresolved) return null
    throw error
  }
}

interface ReceiveLine { itemId: string | null; poItemId: string | null; productId: string; sku: string; expected: number; received: number; quantity: number; qc: string; stockNow: number; lotNumber?: string; expiresAt?: string }
interface ReceivePlan {
  action: (typeof RECEIVE_ACTIONS)[number]
  shipment: { id: string | null; reference: string | null; status: string; version: number | null; type: string; purchaseOrder: string | null }
  po: Awaited<ReturnType<typeof poForReceipt>> | null
  location: { id: string; code: string; name: string; type: string }
  lines: ReceiveLine[]
  reasonCode: string | null
  description: string | null
}

const poForReceipt = (id: string) => prisma.purchaseOrder.findFirst({ where: { id, deletedAt: null }, include: { items: { orderBy: { lineOrder: 'asc' } } } })

async function planReceive(args: Record<string, unknown>): Promise<ReceivePlan | Refusal> {
  const action = (args.action ?? 'receive') as ReceivePlan['action']
  const asked = (args.lines ?? []) as Array<{ productId: string; quantity?: number; qc?: string; lotNumber?: string; expiresAt?: string }>
  let shipment: ReceivePlan['shipment']
  let items: Array<{ id: string | null; poItemId: string | null; productId: string | null; sku: string; expected: number; received: number; qcStatus: string | null }>
  let po: ReceivePlan['po'] = null
  let warehouseId: string | null
  if (args.shipmentId) {
    const found = await prisma.inboundShipment.findFirst({
      where: { id: String(args.shipmentId), deletedAt: null },
      select: { id: true, reference: true, status: true, version: true, type: true, warehouseId: true, purchaseOrder: { select: { poNumber: true } }, items: { select: { id: true, purchaseOrderItemId: true, productId: true, sku: true, quantityExpected: true, quantityReceived: true, qcStatus: true } } },
    })
    if (!found) return { error: INBOUND_NOT_FOUND }
    shipment = { id: found.id, reference: found.reference, status: found.status, version: found.version, type: found.type, purchaseOrder: found.purchaseOrder?.poNumber ?? null }
    items = found.items.map((i) => ({ id: i.id, poItemId: i.purchaseOrderItemId, productId: i.productId, sku: i.sku, expected: i.quantityExpected, received: i.quantityReceived, qcStatus: i.qcStatus }))
    warehouseId = found.warehouseId
  } else if (args.purchaseOrderId) {
    po = await poForReceipt(String(args.purchaseOrderId))
    if (!po) return { error: PO_NOT_FOUND }
    if (action !== 'receive') return { error: `${po.poNumber}: name the inbound shipment (inbound-shipments lists them) to ${action === 'release-hold' ? 'release a hold' : 'report a discrepancy'}.` }
    if (['DRAFT', 'REVIEW', 'APPROVED', 'CANCELLED'].includes(po.status)) return { error: `${po.poNumber} is ${po.status}: only a purchase order that was sent is received.` }
    shipment = { id: null, reference: `Receipt for ${po.poNumber}`, status: 'ARRIVED', version: null, type: 'SUPPLIER', purchaseOrder: po.poNumber }
    items = po.items.map((i) => ({ id: null, poItemId: i.id, productId: i.productId, sku: i.sku, expected: Math.max(0, i.quantityOrdered - (i.quantityReceived ?? 0)), received: 0, qcStatus: null }))
    warehouseId = po.warehouseId
  } else {
    return { error: 'shipmentId or purchaseOrderId is required' }
  }
  const name = shipment.reference ? `shipment "${shipment.reference}"` : `this shipment`
  // FBA quantity is Amazon's: an FBA shipment leaves this business's warehouse; Amazon receives it, not Nexus.
  if (shipment.type === 'FBA') return { error: `${name} goes to Amazon FBA: Amazon receives it and owns that number.` }
  if (CLOSED_INBOUND.includes(shipment.status)) return { error: `${name} is ${shipment.status}: nothing is received on it any more.` }
  const location = await receiveLocation(warehouseId)
  if (!location) return { error: `${name}: this business has no default warehouse to receive into. Choose one in Nexus.` }
  const readOnly = readOnlyLocation(location)
  if (readOnly) return { error: `${name}: ${readOnly}` }
  if (action === 'report-discrepancy' && !args.reasonCode) return { error: `reasonCode is required to report a discrepancy on ${name}` }
  if (!asked.length && action !== 'report-discrepancy') return { error: `Nothing to ${action === 'receive' ? 'receive' : 'release'} on ${name}: give lines (a product and its units).` }
  if (action !== 'receive' && asked.length > 1) return { error: `One line at a time to ${action === 'release-hold' ? 'release a hold' : 'report a discrepancy'} on ${name}.` }
  const ids = asked.map((l) => l.productId)
  if (new Set(ids).size !== ids.length) return { error: 'A product is on two lines: give each product one line.' }
  const products = ids.length ? await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true } }) : []
  if (products.length !== ids.length) return { error: PRODUCT_NOT_FOUND }
  const skuOf = new Map(products.map((p) => [p.id, p.sku]))
  const lines: ReceiveLine[] = []
  const problems: string[] = []
  for (const line of asked) {
    const sku = skuOf.get(line.productId)!
    const matches = items.filter((i) => i.productId === line.productId)
    if (!matches.length) { problems.push(`${sku} is not on ${name}`); continue }
    if (matches.length > 1) { problems.push(`${sku} is on ${name} more than once: receive it in Nexus`); continue }
    const item = matches[0]
    const stockNow = (await levelOf(line.productId, location.id)).quantity
    if (action === 'receive') {
      const open = item.expected - item.received
      if (line.quantity! > open) { problems.push(`${sku}: ${open} still expected, ${line.quantity} is more (record an over-delivery with report-discrepancy)`); continue }
      lines.push({ itemId: item.id, poItemId: item.poItemId, productId: line.productId, sku, expected: item.expected, received: item.received, quantity: line.quantity!, qc: line.qc ?? 'PASS', stockNow, lotNumber: line.lotNumber, expiresAt: line.expiresAt })
    } else if (action === 'release-hold') {
      if (item.qcStatus !== 'HOLD' && item.qcStatus !== 'FAIL') { problems.push(`${sku} is not held (quality check ${item.qcStatus ?? 'not set'})`); continue }
      const release = line.quantity ? Math.min(line.quantity, item.received) : item.received
      if (release <= 0) { problems.push(`${sku}: nothing received to release`); continue }
      lines.push({ itemId: item.id, poItemId: item.poItemId, productId: line.productId, sku, expected: item.expected, received: item.received, quantity: release, qc: item.qcStatus, stockNow })
    } else {
      lines.push({ itemId: item.id, poItemId: item.poItemId, productId: line.productId, sku, expected: item.expected, received: item.received, quantity: line.quantity ?? 0, qc: item.qcStatus ?? '', stockNow })
    }
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}` }
  if (!lines.length && action !== 'report-discrepancy') return { error: `Nothing to ${action} on ${name}.` }
  const description = typeof args.description === 'string' && args.description.trim() ? args.description.trim() : null
  return { action, shipment, po, location, lines, reasonCode: (args.reasonCode as string | undefined) ?? null, description }
}

/** What moves stock: a receive that passes its quality check, and a released hold. */
const movesStock = (plan: ReceivePlan, line: ReceiveLine) => plan.action === 'release-hold' || (plan.action === 'receive' && line.qc === 'PASS')

const RECEIVE_UNDO: ToolUndo = {
  current: SET_STOCK_UNDO.current,
  request(change) {
    const before = (change.before ?? {}) as { items?: Array<{ productId: string; location: string; quantity: number }> }
    if (!before.items?.length) return { refusal: 'This change moved no stock: a held receipt or a discrepancy is changed in Nexus.' }
    return {
      tool: 'set-stock',
      args: { items: before.items.map(({ productId, location, quantity }) => ({ productId, location, quantity })), reason: 'MANUAL_ADJUSTMENT', note: 'Undo of a receive (the shipment keeps its received count)' },
    }
  },
}

const receiveStock: AgentTool = {
  name: 'receive-stock',
  title: 'Receive stock',
  input: z.object({
    action: z.preprocess(lower, z.enum(RECEIVE_ACTIONS)).default('receive').describe('receive (default), release-hold (units held at the quality check go into stock) or report-discrepancy'),
    shipmentId: z.string().trim().min(1).max(64).optional().describe('the inbound shipment (inbound-shipments lists them)'),
    purchaseOrderId: z.string().trim().min(1).max(64).optional().describe('receive: against a sent purchase order (a receipt shipment is opened for it) when there is no shipment yet'),
    lines: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      quantity: z.coerce.number().int().min(1).max(100_000).optional().describe('receive: units that arrived now; release-hold: units to release (default all held); report-discrepancy: units short (+) or over (−)'),
      qc: z.preprocess(upper, z.enum(QC)).optional().describe('receive: the quality check — PASS (default) goes into stock; HOLD or FAIL is recorded, not stocked'),
      lotNumber: z.string().trim().min(1).max(60).optional().describe('receive: lot number, to track the batch'),
      expiresAt: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('receive: the lot\'s expiry date (YYYY-MM-DD)'),
    })).max(RECEIVE_MAX).optional().describe(`the products, 1 to ${RECEIVE_MAX} (one for release-hold and report-discrepancy)`),
    reasonCode: z.preprocess(upper, z.enum(DISCREPANCY_REASONS)).optional().describe('report-discrepancy: what went wrong'),
    description: z.string().trim().max(500).optional().describe('report-discrepancy: what was found'),
    reference: z.string().trim().max(120).optional().describe('receive against a PO: the delivery note or invoice number'),
    carrierCode: z.string().trim().max(60).optional().describe('receive against a PO: the carrier'),
    trackingNumber: z.string().trim().max(120).optional().describe('receive against a PO: the tracking number'),
  }),
  requires: [F.inboundManage, F.poReceive],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: RECEIVE_UNDO,
  description:
    'Receive units that arrived on an inbound shipment, or against a sent purchase order: units that pass the quality '
    + 'check go into stock at the shipment\'s warehouse (one audited movement each), the shipment and the PO count them, '
    + 'and listings that follow stock show the new number. Never more than is still expected on a line. Also releases '
    + 'units held at the quality check into stock, or records a discrepancy (short, damaged, wrong item). Amazon FBA '
    + 'shipments are never received here. Undo takes the units back out of stock; the shipment keeps its count. '
    + 'Waits for a person: approved in Nexus, or confirmed in Claude with the asker\'s authenticator code when the business set it so.',
  async handler(args): Promise<ToolResult> {
    const plan = await planReceive(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const stocked = plan.lines.filter((l) => movesStock(plan, l))
    return {
      ok: true,
      preview: {
        action: plan.action,
        shipment: { ...plan.shipment, location: plan.location.code },
        lines: plan.lines.slice(0, PREVIEW_LINES).map((l) => ({
          sku: l.sku, expected: l.expected, receivedBefore: l.received,
          ...(plan.action === 'receive' ? { receiving: l.quantity, receivedAfter: l.received + l.quantity, qc: l.qc } : plan.action === 'release-hold' ? { releasing: l.quantity, heldAs: l.qc } : { unitsShort: l.quantity }),
          stockNow: l.stockNow, stockAfter: l.stockNow + (movesStock(plan, l) ? l.quantity : 0),
        })),
        ...(plan.lines.length > PREVIEW_LINES ? { moreLines: plan.lines.length - PREVIEW_LINES } : {}),
        ...(plan.action === 'report-discrepancy' ? { discrepancy: { reasonCode: plan.reasonCode, description: plan.description } } : {}),
        totals: { lines: plan.lines.length, units: plan.lines.reduce((n, l) => n + l.quantity, 0), unitsToStock: stocked.reduce((n, l) => n + l.quantity, 0) },
        basis: basisOf([plan.shipment.version, plan.lines.map((l) => [l.productId, l.received, l.stockNow, l.quantity])]),
        note: `${NOT_YET} ${stocked.length ? `Stock goes up at ${plan.location.code}; listings that follow stock are updated and queued to their channels.` : 'No stock moves.'} A receive between the approval and the run stops it (ask again).`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planReceive(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const actor = ctx.userId ?? 'claude'
    let shipmentId = plan.shipment.id
    if (shipmentId) {
      // One receive at a time through Claude: the version seen in the run claims the shipment (receiveItems moves it on).
      const claimed = await prisma.inboundShipment.updateMany({ where: { id: shipmentId, version: plan.shipment.version! }, data: { version: { increment: 1 } } })
      if (claimed.count === 0) return { ok: false, error: `${plan.shipment.reference ?? 'The shipment'} changed meanwhile: nothing was received. Ask again.` }
    }
    if (plan.action === 'report-discrepancy') {
      const line = plan.lines[0]
      const made = await recordDiscrepancy({ shipmentId: shipmentId!, itemId: line?.itemId ?? undefined, reasonCode: plan.reasonCode!, quantityImpact: line ? line.quantity : undefined, description: plan.description ?? undefined, reportedBy: actor })
      publishInboundEvent({ type: 'inbound.discrepancy', shipmentId: shipmentId!, ts: Date.now() })
      return { ok: true, data: { shipmentId, discrepancyId: made.id }, change: { before: { shipmentId, items: [] }, after: { items: [] } } }
    }
    if (plan.action === 'release-hold') {
      const line = plan.lines[0]
      await releaseQcHold({ shipmentId: shipmentId!, itemId: line.itemId!, quantity: line.quantity, actor })
      publishInboundEvent({ type: 'inbound.updated', shipmentId: shipmentId!, reason: 'qc-release', ts: Date.now() })
    } else {
      if (!shipmentId) {
        const receipt = await createPoReceipt(plan.po!, { status: 'ARRIVED', reference: args.reference as string | undefined, carrierCode: args.carrierCode as string | undefined, trackingNumber: args.trackingNumber as string | undefined, arrivedAt: new Date() })
        shipmentId = receipt.id
        const itemOf = new Map(receipt.items.map((i) => [i.purchaseOrderItemId, i.id]))
        for (const line of plan.lines) line.itemId = itemOf.get(line.poItemId) ?? null
        publishInboundEvent({ type: 'inbound.created', shipmentId, ts: Date.now() })
      }
      await receiveItems({
        shipmentId,
        items: plan.lines.map((l) => ({
          itemId: l.itemId!, quantityReceived: l.received + l.quantity, qcStatus: l.qc,
          ...(l.lotNumber ? { lotNumber: l.lotNumber, expiresAt: l.expiresAt } : {}),
          idempotencyKey: `claude:${l.itemId}:${l.received}->${l.received + l.quantity}`,
        })),
        actor,
        receivedById: ctx.userId ?? undefined,
      })
      publishInboundEvent({ type: 'inbound.received', shipmentId, ts: Date.now() })
      if (plan.po || plan.shipment.purchaseOrder) {
        const poId = plan.po?.id ?? (await prisma.inboundShipment.findUnique({ where: { id: shipmentId }, select: { purchaseOrderId: true } }))?.purchaseOrderId
        if (poId) publishPoEvent({ type: 'po.received', poId, shipmentId, ts: Date.now() })
      }
    }
    const stocked = plan.lines.filter((l) => movesStock(plan, l))
    const after = await Promise.all(stocked.map(async (l) => ({ productId: l.productId, location: plan.location.code, quantity: (await levelOf(l.productId, plan.location.id)).quantity })))
    return {
      ok: true,
      data: { shipmentId, lines: plan.lines.length, unitsToStock: stocked.reduce((n, l) => n + l.quantity, 0) },
      change: {
        before: { shipmentId, items: stocked.map((l, i) => ({ productId: l.productId, sku: l.sku, location: plan.location.code, quantity: after[i].quantity - l.quantity })) },
        after: { items: after },
      },
    }
  },
}

// ── update-inbound-shipment ───────────────────────────────────────────────────────────────────────────

const INBOUND_ACTIONS = ['details', 'costs', 'status', 'create'] as const
const INBOUND_STATUSES = ['DRAFT', 'SUBMITTED', 'IN_TRANSIT', 'ARRIVED', 'RECEIVING', 'RECONCILED', 'CLOSED', 'CANCELLED'] as const
const DETAIL_FIELDS = ['reference', 'carrierCode', 'trackingNumber', 'trackingUrl', 'expectedAt', 'notes'] as const
const COST_FIELDS = ['currencyCode', 'exchangeRate', 'shippingCostCents', 'customsCostCents', 'dutiesCostCents', 'insuranceCostCents'] as const
type InboundField = (typeof DETAIL_FIELDS)[number] | (typeof COST_FIELDS)[number]

interface InboundPlan {
  action: (typeof INBOUND_ACTIONS)[number]
  shipment: { id: string | null; reference: string | null; status: string; version: number | null; purchaseOrder: string | null }
  po: Awaited<ReturnType<typeof poForReceipt>> | null
  changes: Partial<Record<InboundField, { from: unknown; to: unknown }>>
  lineCosts: Array<{ itemId: string; productId: string; sku: string; from: number | null; to: number | null }>
  status: string | null
}

const fieldValue = (field: InboundField, row: Record<string, unknown>) => {
  const v = row[field]
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (field === 'exchangeRate') return Number(v)
  return v
}

async function planInbound(args: Record<string, unknown>): Promise<InboundPlan | Refusal> {
  const action = (args.action ?? 'details') as InboundPlan['action']
  const asked = (fields: readonly InboundField[]) => fields.filter((f) => args[f] !== undefined)
  if (action === 'create') {
    if (!args.purchaseOrderId) return { error: 'purchaseOrderId is required to open a receipt shipment for a purchase order' }
    const po = await poForReceipt(String(args.purchaseOrderId))
    if (!po) return { error: PO_NOT_FOUND }
    if (['DRAFT', 'REVIEW', 'APPROVED', 'CANCELLED'].includes(po.status)) return { error: `${po.poNumber} is ${po.status}: a receipt shipment is opened for a purchase order that was sent.` }
    if (!po.items.some((i) => i.quantityOrdered - (i.quantityReceived ?? 0) > 0)) return { error: `${po.poNumber}: nothing is still expected.` }
    const changes = Object.fromEntries(asked(DETAIL_FIELDS).map((f) => [f, { from: null, to: args[f] }]))
    return { action, shipment: { id: null, reference: (args.reference as string | undefined) ?? `Receipt for ${po.poNumber}`, status: 'DRAFT', version: null, purchaseOrder: po.poNumber }, po, changes, lineCosts: [], status: null }
  }
  if (!args.shipmentId) return { error: 'shipmentId is required (inbound-shipments lists them)' }
  const found = await prisma.inboundShipment.findFirst({
    where: { id: String(args.shipmentId), deletedAt: null },
    include: { purchaseOrder: { select: { poNumber: true } }, items: { select: { id: true, productId: true, sku: true, unitCostCents: true } } },
  })
  if (!found) return { error: INBOUND_NOT_FOUND }
  const name = found.reference ? `shipment "${found.reference}"` : 'this shipment'
  if (args.version != null && Number(args.version) !== found.version) return { error: `${name} changed since (version ${found.version}, not ${args.version}): read it again.` }
  const shipment = { id: found.id, reference: found.reference, status: found.status, version: found.version, purchaseOrder: found.purchaseOrder?.poNumber ?? null }
  if (found.type === 'FBA' && action !== 'details') return { error: `${name} goes to Amazon FBA: its status and costs follow Amazon's own plan.` }
  if (action === 'status') {
    const to = args.status as string | undefined
    if (!to) return { error: `status is required to move ${name}` }
    if (to === found.status) return { error: `${name} is already ${to}.` }
    if (!(INBOUND_TRANSITIONS[found.status] ?? []).includes(to)) return { error: `${name} is ${found.status}: it cannot move to ${to}.` }
    return { action, shipment, po: null, changes: {}, lineCosts: [], status: to }
  }
  if (['CLOSED', 'CANCELLED'].includes(found.status)) return { error: `${name} is ${found.status}: it is no longer changed.` }
  const fields = asked(action === 'costs' ? COST_FIELDS : DETAIL_FIELDS)
  const changes: InboundPlan['changes'] = {}
  for (const f of fields) {
    const from = fieldValue(f, found as unknown as Record<string, unknown>)
    if (JSON.stringify(from) !== JSON.stringify(args[f] ?? null)) changes[f] = { from, to: args[f] ?? null }
  }
  const lineCosts: InboundPlan['lineCosts'] = []
  if (action === 'costs') {
    const problems: string[] = []
    for (const line of (args.lineCosts ?? []) as Array<{ productId: string; unitCostCents: number | null }>) {
      const matches = found.items.filter((i) => i.productId === line.productId)
      if (matches.length !== 1) { problems.push(`${line.productId} is ${matches.length ? 'on it more than once' : 'not on it'}`); continue }
      if (matches[0].unitCostCents !== line.unitCostCents) lineCosts.push({ itemId: matches[0].id, productId: line.productId, sku: matches[0].sku, from: matches[0].unitCostCents, to: line.unitCostCents })
    }
    if (problems.length) return { error: `Not queued on ${name}: ${listed(problems)}` }
  }
  if (!Object.keys(changes).length && !lineCosts.length) return { error: `Nothing to change on ${name}: name a ${action === 'costs' ? 'cost' : 'detail'} with a new value.` }
  return { action, shipment, po: null, changes, lineCosts, status: null }
}

/** The manual moves of inbound.service.ts (DRAFT→SUBMITTED→IN_TRANSIT→ARRIVED→RECEIVING; RECEIVED→RECONCILED→CLOSED; cancel before receiving). */
const INBOUND_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ['SUBMITTED', 'CANCELLED'], SUBMITTED: ['IN_TRANSIT', 'DRAFT', 'CANCELLED'], IN_TRANSIT: ['ARRIVED', 'CANCELLED'],
  ARRIVED: ['RECEIVING', 'CANCELLED'], RECEIVING: ['CANCELLED'], PARTIALLY_RECEIVED: ['CANCELLED'], RECEIVED: ['CLOSED', 'RECONCILED'], RECONCILED: ['CLOSED'],
}

const INBOUND_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { shipmentId?: string; fields?: Record<string, unknown>; lineCosts?: Array<{ productId: string }>; status?: string }
    if (!after.shipmentId) return null
    const row = await prisma.inboundShipment.findUnique({ where: { id: after.shipmentId }, include: { items: { select: { productId: true, unitCostCents: true } } } })
    if (!row) return null
    if ('status' in after) return { shipmentId: after.shipmentId, status: row.status }
    return {
      shipmentId: after.shipmentId,
      fields: Object.fromEntries(Object.keys(after.fields ?? {}).map((f) => [f, fieldValue(f as InboundField, row as unknown as Record<string, unknown>)])),
      lineCosts: (after.lineCosts ?? []).map((l) => ({ productId: l.productId, unitCostCents: row.items.find((i) => i.productId === l.productId)?.unitCostCents ?? null })),
    }
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; fields?: Record<string, unknown>; lineCosts?: Array<{ productId: string; unitCostCents: number | null }> }
    const after = (change.after ?? {}) as { shipmentId?: string }
    if (!after.shipmentId) return { refusal: 'This change does not name its shipment.' }
    if (before.action === 'create') return { tool: 'update-inbound-shipment', args: { action: 'status', shipmentId: after.shipmentId, status: 'CANCELLED' } }
    if (before.action === 'status') return { refusal: 'A shipment\'s status move is not undone: move it again in Nexus if needed.' }
    return { tool: 'update-inbound-shipment', args: { action: before.action, shipmentId: after.shipmentId, ...before.fields, ...(before.lineCosts?.length ? { lineCosts: before.lineCosts } : {}) } }
  },
}

const centsArg = (what: string) => z.coerce.number().int().min(0).max(100_000_000).nullable().optional().describe(`${what}, in cents of the shipment's currency`)

const updateInboundShipment: AgentTool = {
  name: 'update-inbound-shipment',
  title: 'Update an inbound shipment',
  input: z.object({
    action: z.preprocess(lower, z.enum(INBOUND_ACTIONS)).default('details').describe('details (default: reference, carrier, tracking, expected date, notes), costs, status, or create (a receipt shipment for a sent PO)'),
    shipmentId: z.string().trim().min(1).max(64).optional().describe('the shipment (inbound-shipments lists them)'),
    purchaseOrderId: z.string().trim().min(1).max(64).optional().describe('create: the sent purchase order it brings in'),
    version: z.coerce.number().int().min(1).optional().describe('the version you read; a newer one is refused'),
    reference: z.string().trim().max(120).nullable().optional().describe('details: delivery note, invoice or transport document'),
    carrierCode: z.string().trim().max(60).nullable().optional().describe('details: the carrier'),
    trackingNumber: z.string().trim().max(120).nullable().optional().describe('details: the tracking number'),
    trackingUrl: z.string().trim().url().max(500).nullable().optional().describe('details: the tracking link'),
    expectedAt: dateArg('details: when it is expected'),
    notes: z.string().trim().max(1000).nullable().optional().describe('details: notes'),
    currencyCode: z.string().trim().length(3).optional().describe('costs: the currency of its costs, e.g. EUR'),
    exchangeRate: z.coerce.number().positive().max(100_000).nullable().optional().describe('costs: rate to EUR'),
    shippingCostCents: centsArg('costs: freight'),
    customsCostCents: centsArg('costs: customs'),
    dutiesCostCents: centsArg('costs: duties'),
    insuranceCostCents: centsArg('costs: insurance'),
    lineCosts: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      unitCostCents: z.coerce.number().int().min(0).max(100_000_000).nullable().describe('its unit cost on this shipment, in cents'),
    })).max(RECEIVE_MAX).optional().describe('costs: unit costs per product on the shipment'),
    status: z.preprocess(upper, z.enum(INBOUND_STATUSES)).optional().describe('status: where it moves (SUBMITTED, IN_TRANSIT, ARRIVED, RECEIVING, RECONCILED, CLOSED, CANCELLED, back to DRAFT)'),
  }),
  requires: [F.inboundManage],
  restrictedFields: {
    shippingCostCents: FIELDS.financialsCostsView, exchangeRate: FIELDS.financialsCostsView, lineCosts: FIELDS.financialsCostsView,
  },
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  undo: INBOUND_UNDO,
  description:
    'Keep an inbound shipment up to date: its reference, carrier, tracking, expected date and notes; its costs (freight, '
    + 'customs, duties, insurance, unit costs — they make the landed cost); its status (in transit, arrived, closed, '
    + 'cancelled); or open the receipt shipment of a sent purchase order. Nothing here moves stock: receive-stock does. '
    + 'Amazon FBA shipments follow Amazon\'s plan. Waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planInbound(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    return {
      ok: true,
      preview: {
        action: plan.action,
        shipment: plan.shipment,
        ...(plan.status ? { status: { from: plan.shipment.status, to: plan.status } } : {}),
        ...(Object.keys(plan.changes).length ? { changes: plan.changes } : {}),
        ...(plan.lineCosts.length ? { lineCosts: plan.lineCosts.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, from: l.from, to: l.to })) } : {}),
        ...(plan.po ? { lines: plan.po.items.filter((i) => i.quantityOrdered - (i.quantityReceived ?? 0) > 0).slice(0, PREVIEW_LINES).map((i) => ({ sku: i.sku, expected: i.quantityOrdered - (i.quantityReceived ?? 0) })) } : {}),
        note: `${NOT_YET} Nothing here moves stock.${plan.status === 'CANCELLED' ? ' A cancelled shipment cannot be reopened.' : ''}`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planInbound(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.action === 'create') {
      const made = await createPoReceipt(plan.po!, { status: 'DRAFT' })
      const details = Object.fromEntries(Object.entries(plan.changes).map(([f, c]) => [f, f === 'expectedAt' && c!.to ? new Date(String(c!.to)) : c!.to]))
      if (Object.keys(details).length) await prisma.inboundShipment.update({ where: { id: made.id }, data: details })
      publishPoEvent({ type: 'po.received', poId: plan.po!.id, shipmentId: made.id, ts: Date.now() })
      publishInboundEvent({ type: 'inbound.created', shipmentId: made.id, ts: Date.now() })
      return { ok: true, data: { shipmentId: made.id }, change: { before: { action: 'create', purchaseOrderId: plan.po!.id }, after: { shipmentId: made.id, status: 'DRAFT' } } }
    }
    const id = plan.shipment.id!
    if (plan.action === 'status') {
      try {
        await transitionShipmentStatus({ shipmentId: id, newStatus: plan.status as never })
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
      publishInboundEvent({ type: plan.status === 'CANCELLED' ? 'inbound.cancelled' : 'inbound.updated', shipmentId: id, ...(plan.status === 'CANCELLED' ? {} : { reason: 'status' }), ts: Date.now() } as never)
      return { ok: true, data: { shipmentId: id, from: plan.shipment.status, to: plan.status }, change: { before: { action: 'status', shipmentId: id, status: plan.shipment.status }, after: { shipmentId: id, status: plan.status } } }
    }
    // The version seen in the run claims the shipment: a change in between refuses this one.
    const claimed = await prisma.inboundShipment.updateMany({ where: { id, version: plan.shipment.version! }, data: { version: { increment: 1 } } })
    if (claimed.count === 0) return { ok: false, error: `${plan.shipment.reference ?? 'The shipment'} changed meanwhile: nothing was written. Ask again.` }
    const to = Object.fromEntries(Object.entries(plan.changes).map(([f, c]) => [f, c!.to]))
    if (plan.action === 'costs') {
      await setInboundCosts(id, { ...to, items: plan.lineCosts.map((l) => ({ id: l.itemId, unitCostCents: l.to })) } as InboundCostsInput)
    } else {
      await prisma.inboundShipment.update({ where: { id }, data: Object.fromEntries(Object.entries(to).map(([f, v]) => [f, f === 'expectedAt' && v ? new Date(String(v)) : v])) })
      publishInboundEvent({ type: 'inbound.updated', shipmentId: id, reason: 'details', ts: Date.now() })
    }
    return {
      ok: true,
      data: { shipmentId: id, version: plan.shipment.version! + 1 },
      change: {
        before: { action: plan.action, shipmentId: id, fields: Object.fromEntries(Object.entries(plan.changes).map(([f, c]) => [f, c!.from])), lineCosts: plan.lineCosts.map((l) => ({ productId: l.productId, unitCostCents: l.from })) },
        after: { shipmentId: id, fields: to, lineCosts: plan.lineCosts.map((l) => ({ productId: l.productId, unitCostCents: l.to })) },
      },
    }
  },
}

// ── set-product-costs ─────────────────────────────────────────────────────────────────────────────────

const COSTS_MAX = 250
export const COST_LIMITS = z.object({
  maxProducts: z.number().int().min(1).max(COSTS_MAX).default(COSTS_MAX).describe('the most products one change sets'),
  maxChangePercent: z.number().min(0).max(100).default(25).describe('the most a cost may move, in percent'),
})
export function costWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { totals?: { products?: unknown }; costs?: Array<{ sku: string; changePercent: number | null; costPriceBefore: unknown }> } | null
  if (typeof p?.totals?.products !== 'number') return 'the request does not say what it sets'
  if (p.totals.products > Number(limits.maxProducts)) return `it sets ${p.totals.products} products, more than the ${limits.maxProducts} allowed without a person`
  for (const line of p.costs ?? []) {
    if (line.costPriceBefore == null) return `${line.sku} has no cost yet: a first cost is set by a person`
    if (line.changePercent == null || Math.abs(line.changePercent) > Number(limits.maxChangePercent)) return `${line.sku}'s cost moves ${line.changePercent ?? '?'} %, more than the ${limits.maxChangePercent} % allowed without a person`
  }
  return null
}

interface CostPlan {
  mode: 'costs' | 'landed'
  costs: Array<{ productId: string; sku: string; from: number | null; to: number | null }>
  landed: Array<{ productId: string; sku: string; from: number | null; to: number }>
  po: { id: string; poNumber: string; supplierId: string; supplier: string } | null
}

async function planCosts(args: Record<string, unknown>): Promise<CostPlan | Refusal> {
  if (args.purchaseOrderId) {
    const match = await readPurchaseOrderMatch(String(args.purchaseOrderId))
    if (!match) return { error: PO_NOT_FOUND }
    const po = await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: String(args.purchaseOrderId) }, select: { id: true, poNumber: true, supplierId: true, supplier: { select: { name: true } } } })
    if (!po.supplierId) return { error: `${po.poNumber} has no supplier: there is no supplier catalogue to copy its landed cost to.` }
    const only = args.productIds as string[] | undefined
    const lines = (match.lines as Array<{ productId: string | null; sku: string; receivedQty: number; landedUnitCentsEur: number | null }>)
      .filter((l) => l.productId && l.receivedQty > 0 && l.landedUnitCentsEur != null && l.landedUnitCentsEur > 0 && (!only || only.includes(l.productId)))
    if (only && only.some((id) => !(match.lines as Array<{ productId: string | null }>).some((l) => l.productId === id))) return { error: `A product named is not on ${po.poNumber}` }
    if (!lines.length) return { error: `Nothing received on ${po.poNumber} yet: no landed cost to copy.` }
    const current = new Map((await prisma.supplierProduct.findMany({ where: { supplierId: po.supplierId, productId: { in: lines.map((l) => l.productId!) } }, select: { productId: true, lastLandedCostCents: true } })).map((r) => [r.productId, r.lastLandedCostCents]))
    return {
      mode: 'landed', costs: [], po: { id: po.id, poNumber: po.poNumber, supplierId: po.supplierId, supplier: po.supplier?.name ?? '' },
      landed: lines.map((l) => ({ productId: l.productId!, sku: l.sku, from: current.get(l.productId!) ?? null, to: Math.round(l.landedUnitCentsEur!) })),
    }
  }
  const asked = (args.costs ?? []) as Array<{ productId: string; costPrice: number | null }>
  if (!asked.length) return { error: 'costs are required (or purchaseOrderId, to copy its landed cost)' }
  const ids = asked.map((c) => c.productId)
  if (new Set(ids).size !== ids.length) return { error: 'A product is named twice: name each product once.' }
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true, costPrice: true } })
  if (products.length !== ids.length) return { error: PRODUCT_NOT_FOUND }
  const byId = new Map(products.map((p) => [p.id, p]))
  const costs = asked
    .map((c) => ({ productId: c.productId, sku: byId.get(c.productId)!.sku, from: byId.get(c.productId)!.costPrice == null ? null : Number(byId.get(c.productId)!.costPrice), to: c.costPrice == null ? null : Math.round(c.costPrice * 100) / 100 }))
    .filter((c) => c.from !== c.to)
  if (!costs.length) return { error: 'Every product already has that cost. Nothing to change.' }
  return { mode: 'costs', costs, landed: [], po: null }
}

const pctMove = (from: number | null, to: number | null) => (from != null && to != null && from > 0 ? Math.round(((to - from) / from) * 1000) / 10 : null)

const COSTS_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { costs?: Array<{ productId: string }> }
    if (!after.costs) return null
    const rows = new Map((await prisma.product.findMany({ where: { id: { in: after.costs.map((c) => c.productId) } }, select: { id: true, costPrice: true } })).map((r) => [r.id, r.costPrice == null ? null : Number(r.costPrice)]))
    return { costs: after.costs.map((c) => ({ productId: c.productId, costPrice: rows.get(c.productId) ?? null })) }
  },
  request(change) {
    const before = (change.before ?? {}) as { mode?: string; costs?: Array<{ productId: string; costPrice: number | null }> }
    if (before.mode === 'landed') return { refusal: 'A landed cost copied from a purchase order is not put back here: edit the supplier\'s product in Nexus.' }
    if (!before.costs?.length) return { refusal: 'This change does not name the costs it replaced.' }
    return { tool: 'set-product-costs', args: { costs: before.costs.map(({ productId, costPrice }) => ({ productId, costPrice })) } }
  },
}

const setProductCosts: AgentTool = {
  name: 'set-product-costs',
  title: 'Set product costs',
  input: z.object({
    costs: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      costPrice: z.coerce.number().min(0).max(1_000_000).nullable().describe('what one unit costs, in the master currency (null clears it)'),
    })).min(1).max(COSTS_MAX).optional().describe(`each product's cost price, 1 to ${COSTS_MAX}`),
    purchaseOrderId: z.string().trim().min(1).max(64).optional().describe('instead: copy the landed cost per unit measured on this received PO to its supplier\'s catalogue (what reorders use)'),
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(COSTS_MAX).optional().describe('with purchaseOrderId: only these products'),
  }),
  requires: [F.pricingCostsEdit, FIELDS.financialsCostsView],
  restrictedFields: { costPriceBefore: FIELDS.financialsCostsView, changePercent: FIELDS.financialsCostsView, landedCostCents: FIELDS.financialsCostsView, landedCostCentsBefore: FIELDS.financialsCostsView },
  category: 'pricing',
  riskTier: 'medium',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'partial',
  maxClaudeTrust: 'confirm',
  limits: COST_LIMITS,
  withinLimits: costWithinLimits,
  undo: COSTS_UNDO,
  description:
    'Set what products cost (the cost price margins, profit and reorder value are worked out from), or copy the landed '
    + 'cost per unit measured on a received purchase order — goods plus its share of freight, customs, duties and '
    + 'insurance — to the supplier\'s catalogue. Prices are not changed. Undo puts the old cost prices back. Waits for a '
    + 'person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planCosts(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.mode === 'landed') {
      return {
        ok: true,
        preview: {
          action: 'copy-landed-cost', purchaseOrder: { id: plan.po!.id, poNumber: plan.po!.poNumber, supplier: plan.po!.supplier },
          landed: plan.landed.slice(0, PREVIEW_LINES).map((l) => ({ sku: l.sku, landedCostCentsBefore: l.from, landedCostCents: l.to, currencyCode: 'EUR' })),
          totals: { products: plan.landed.length },
          note: `${NOT_YET} The supplier's catalogue keeps the latest landed cost per product (reorders and their value use it); the product's own cost price is not changed.`,
        },
      }
    }
    return {
      ok: true,
      preview: {
        action: 'set-costs',
        costs: plan.costs.slice(0, PREVIEW_LINES).map((c) => ({ sku: c.sku, costPriceBefore: c.from, costPrice: c.to, changePercent: pctMove(c.from, c.to) })),
        ...(plan.costs.length > PREVIEW_LINES ? { moreProducts: plan.costs.length - PREVIEW_LINES } : {}),
        totals: { products: plan.costs.length },
        note: `${NOT_YET} Costs are in the master currency (${masterCurrency()}). Selling prices are not changed.`,
      },
    }
  },
  async execute(args): Promise<ToolResult> {
    const plan = await planCosts(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.mode === 'landed') {
      const now = new Date()
      for (const l of plan.landed) {
        await prisma.supplierProduct.upsert({
          where: { supplierId_productId: workspaceKey({ supplierId: plan.po!.supplierId, productId: l.productId }) },
          update: { lastLandedCostCents: l.to, lastLandedCostUpdatedAt: now },
          create: { supplierId: plan.po!.supplierId, productId: l.productId, lastLandedCostCents: l.to, lastLandedCostUpdatedAt: now },
        })
      }
      return { ok: true, data: { copied: plan.landed.length }, change: { before: { mode: 'landed', purchaseOrderId: plan.po!.id }, after: { landed: plan.landed.map((l) => ({ productId: l.productId, landedCostCents: l.to })) } } }
    }
    const done = await bulkSetCosts(plan.costs.map((c) => ({ productId: c.productId, costPrice: c.to })))
    return {
      ok: true,
      data: done,
      change: {
        before: { mode: 'costs', costs: plan.costs.map((c) => ({ productId: c.productId, sku: c.sku, costPrice: c.from })) },
        after: { costs: plan.costs.map((c) => ({ productId: c.productId, costPrice: c.to })) },
      },
    }
  },
}

// ── replenishment-action ──────────────────────────────────────────────────────────────────────────────

const REPLENISH_ACTIONS = ['dismiss', 'restore', 'preferred-supplier', 'substitute', 'cash-on-hand'] as const
const REPLENISH_MAX = 250
export const REPLENISH_LIMITS = z.object({
  maxItems: z.number().int().min(1).max(REPLENISH_MAX).default(REPLENISH_MAX).describe('the most products one change touches'),
})
export function replenishWithinLimits(preview: unknown, limits: Record<string, unknown>): string | null {
  const p = preview as { action?: string; totals?: { items?: unknown } } | null
  if (typeof p?.totals?.items !== 'number') return 'the request does not say what it changes'
  if (p.action === 'cash-on-hand') return 'cash on hand is set by a person'
  if (p.totals.items > Number(limits.maxItems)) return `it touches ${p.totals.items} products, more than the ${limits.maxItems} allowed without a person`
  return null
}

interface ReplenishPlan {
  action: (typeof REPLENISH_ACTIONS)[number]
  reason: string | null
  recs: Array<{ id: string; productId: string; sku: string; reorderQuantity: number; urgency: string }>
  preferred: Array<{ productId: string; sku: string; from: string | null; to: string | null; toName: string | null }>
  substitutions: Array<{ productId: string; sku: string; coveredBy: string; coveredBySku: string; from: number | null; to: number | null }>
  cash: { from: number | null; to: number | null } | null
}

async function planReplenish(args: Record<string, unknown>): Promise<ReplenishPlan | Refusal> {
  const action = (args.action ?? 'dismiss') as ReplenishPlan['action']
  const empty: ReplenishPlan = { action, reason: null, recs: [], preferred: [], substitutions: [], cash: null }
  if (action === 'cash-on-hand') {
    if (args.cashOnHandCents === undefined) return { error: 'cashOnHandCents is required (null clears it)' }
    const settings = await prisma.brandSettings.findFirst({ select: { cashOnHandCents: true } })
    const from = settings?.cashOnHandCents ?? null
    const to = (args.cashOnHandCents as number | null) ?? null
    if (from === to) return { error: 'Cash on hand is already that.' }
    return { ...empty, cash: { from, to } }
  }
  const named = action === 'preferred-supplier' ? ((args.preferred ?? []) as Array<{ productId: string }>).map((p) => p.productId)
    : action === 'substitute' ? ((args.substitutions ?? []) as Array<{ productId: string; coveredBy: string }>).flatMap((s) => [s.productId, s.coveredBy])
      : ((args.productIds ?? []) as string[])
  if (!named.length) return { error: `Nothing to ${action}: name the products (${action === 'preferred-supplier' ? 'preferred' : action === 'substitute' ? 'substitutions' : 'productIds'}).` }
  const ids = [...new Set(named)]
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true } })
  if (products.length !== ids.length) return { error: PRODUCT_NOT_FOUND }
  const skuOf = new Map(products.map((p) => [p.id, p.sku]))
  const problems: string[] = []
  if (action === 'dismiss' || action === 'restore') {
    const recs: ReplenishPlan['recs'] = []
    for (const productId of ids) {
      const active = await prisma.replenishmentRecommendation.findFirst({ where: { productId, status: 'ACTIVE' }, orderBy: { generatedAt: 'desc' }, select: { id: true, reorderQuantity: true, urgency: true } })
      if (action === 'dismiss') {
        if (!active) { problems.push(`${skuOf.get(productId)} has no open reorder suggestion`); continue }
        recs.push({ id: active.id, productId, sku: skuOf.get(productId)!, reorderQuantity: active.reorderQuantity, urgency: active.urgency })
        continue
      }
      if (active) { problems.push(`${skuOf.get(productId)} already has an open reorder suggestion`); continue }
      const dismissed = await prisma.replenishmentRecommendation.findFirst({ where: { productId, status: 'DISMISSED' }, orderBy: { dismissedAt: 'desc' }, select: { id: true, reorderQuantity: true, urgency: true } })
      if (!dismissed) { problems.push(`${skuOf.get(productId)} has no dismissed reorder suggestion`); continue }
      recs.push({ id: dismissed.id, productId, sku: skuOf.get(productId)!, reorderQuantity: dismissed.reorderQuantity, urgency: dismissed.urgency })
    }
    if (problems.length) return { error: `Not queued: ${listed(problems)}` }
    return { ...empty, recs, reason: typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim() : null }
  }
  if (action === 'preferred-supplier') {
    const asked = args.preferred as Array<{ productId: string; supplierId: string | null }>
    if (new Set(asked.map((a) => a.productId)).size !== asked.length) return { error: 'A product is named twice: name each product once.' }
    const supplierIds = [...new Set(asked.map((a) => a.supplierId).filter((s): s is string => !!s))]
    const suppliers = new Map((await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]))
    if (suppliers.size !== supplierIds.length) return { error: 'Supplier not found' }
    const rules = new Map((await prisma.replenishmentRule.findMany({ where: { productId: { in: ids } }, select: { productId: true, preferredSupplierId: true } })).map((r) => [r.productId, r.preferredSupplierId]))
    const preferred: ReplenishPlan['preferred'] = []
    for (const a of asked) {
      const sku = skuOf.get(a.productId)!
      if (a.supplierId && !(await prisma.supplierProduct.findFirst({ where: { supplierId: a.supplierId, productId: a.productId }, select: { id: true } }))) { problems.push(`${suppliers.get(a.supplierId)} does not supply ${sku} (upsert-supplier adds it)`); continue }
      const from = rules.get(a.productId) ?? null
      if (from !== a.supplierId) preferred.push({ productId: a.productId, sku, from, to: a.supplierId, toName: a.supplierId ? suppliers.get(a.supplierId)! : null })
    }
    if (problems.length) return { error: `Not queued: ${listed(problems)}` }
    if (!preferred.length) return { error: 'Every product already has that preferred supplier. Nothing to change.' }
    return { ...empty, preferred }
  }
  const asked = args.substitutions as Array<{ productId: string; coveredBy: string; fraction: number | null }>
  const substitutions: ReplenishPlan['substitutions'] = []
  for (const a of asked) {
    if (a.productId === a.coveredBy) { problems.push(`${skuOf.get(a.productId)} cannot cover itself`); continue }
    const row = await prisma.productSubstitution.findFirst({ where: { primaryProductId: a.productId, substituteProductId: a.coveredBy }, select: { substitutionFraction: true } })
    const from = row ? Number(row.substitutionFraction) : null
    const to = a.fraction ?? null
    if (from !== to) substitutions.push({ productId: a.productId, sku: skuOf.get(a.productId)!, coveredBy: a.coveredBy, coveredBySku: skuOf.get(a.coveredBy)!, from, to })
  }
  if (problems.length) return { error: `Not queued: ${listed(problems)}` }
  if (!substitutions.length) return { error: 'Every substitution is already that. Nothing to change.' }
  return { ...empty, substitutions }
}

const REPLENISH_UNDO: ToolUndo = {
  async current(change) {
    const after = (change.after ?? {}) as { action?: string; recs?: Array<{ id: string }>; preferred?: Array<{ productId: string }>; substitutions?: Array<{ productId: string; coveredBy: string }>; cashOnHandCents?: unknown }
    if (after.recs) return { action: after.action, recs: await Promise.all(after.recs.map(async (r) => ({ id: r.id, status: (await prisma.replenishmentRecommendation.findUnique({ where: { id: r.id }, select: { status: true } }))?.status ?? null }))) }
    if (after.preferred) return { action: after.action, preferred: await Promise.all(after.preferred.map(async (p) => ({ productId: p.productId, supplierId: (await prisma.replenishmentRule.findFirst({ where: { productId: p.productId }, select: { preferredSupplierId: true } }))?.preferredSupplierId ?? null }))) }
    if (after.substitutions) {
      return {
        action: after.action,
        substitutions: await Promise.all(after.substitutions.map(async (s) => {
          const row = await prisma.productSubstitution.findFirst({ where: { primaryProductId: s.productId, substituteProductId: s.coveredBy }, select: { substitutionFraction: true } })
          return { productId: s.productId, coveredBy: s.coveredBy, fraction: row ? Number(row.substitutionFraction) : null }
        })),
      }
    }
    if ('cashOnHandCents' in after) return { action: after.action, cashOnHandCents: (await prisma.brandSettings.findFirst({ select: { cashOnHandCents: true } }))?.cashOnHandCents ?? null }
    return null
  },
  request(change) {
    const before = (change.before ?? {}) as { action?: string; productIds?: string[]; preferred?: Array<{ productId: string; supplierId: string | null }>; substitutions?: Array<{ productId: string; coveredBy: string; fraction: number | null }>; cashOnHandCents?: number | null }
    if (before.action === 'dismiss' || before.action === 'restore') return { tool: 'replenishment-action', args: { action: before.action === 'dismiss' ? 'restore' : 'dismiss', productIds: before.productIds } }
    if (before.action === 'preferred-supplier') return { tool: 'replenishment-action', args: { action: 'preferred-supplier', preferred: before.preferred } }
    if (before.action === 'substitute') return { tool: 'replenishment-action', args: { action: 'substitute', substitutions: before.substitutions } }
    if (before.action === 'cash-on-hand') return { tool: 'replenishment-action', args: { action: 'cash-on-hand', cashOnHandCents: before.cashOnHandCents ?? null } }
    return { refusal: 'This change does not say what it changed.' }
  },
}

const replenishmentAction: AgentTool = {
  name: 'replenishment-action',
  title: 'Act on reorder suggestions',
  input: z.object({
    action: z.preprocess(lower, z.enum(REPLENISH_ACTIONS)).default('dismiss').describe('dismiss (default) or restore a reorder suggestion, preferred-supplier, substitute (one product covers part of another\'s demand), or cash-on-hand'),
    productIds: z.array(z.string().trim().min(1).max(64)).min(1).max(REPLENISH_MAX).optional().describe(`dismiss/restore: the products, 1 to ${REPLENISH_MAX} (replenishment-suggestions lists them)`),
    reason: z.string().trim().max(200).optional().describe('dismiss: why (kept with the suggestion)'),
    preferred: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id'),
      supplierId: z.string().trim().min(1).max(64).nullable().describe('the supplier reorders come from (it must supply the product); null: none'),
    })).min(1).max(REPLENISH_MAX).optional().describe('preferred-supplier: per product'),
    substitutions: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('the product whose demand is covered when it is out of stock'),
      coveredBy: z.string().trim().min(1).max(64).describe('the product id that covers it'),
      fraction: z.coerce.number().gt(0).max(1).nullable().describe('the share of demand it covers, above 0 up to 1; null removes the link'),
    })).min(1).max(REPLENISH_MAX).optional().describe('substitute: links between products'),
    cashOnHandCents: z.coerce.number().int().min(0).max(100_000_000_000).nullable().optional().describe('cash-on-hand: the cash available for purchasing, in cents of the master currency (null clears it)'),
  }),
  requires: [F.replenishmentRun],
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: false,
  requiresApprovalDefault: true,
  openWorld: false,
  reversibility: 'full',
  maxClaudeTrust: 'auto',
  limits: REPLENISH_LIMITS,
  withinLimits: replenishWithinLimits,
  undo: REPLENISH_UNDO,
  description:
    'Act on the reorder suggestions: dismiss one (or bring a dismissed one back), choose the supplier a product is '
    + 'reordered from, say that one product covers part of another\'s demand when it runs out, or set the cash on hand '
    + 'the purchasing plan counts on. Nothing is ordered here: draft-purchase-order does. Waits for a person to approve '
    + 'it in Nexus unless the business lets Claude act on suggestions itself.',
  async handler(args): Promise<ToolResult> {
    const plan = await planReplenish(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const items = plan.recs.length || plan.preferred.length || plan.substitutions.length || (plan.cash ? 1 : 0)
    return {
      ok: true,
      preview: {
        action: plan.action,
        ...(plan.recs.length ? { suggestions: plan.recs.slice(0, PREVIEW_LINES).map((r) => ({ sku: r.sku, reorderQuantity: r.reorderQuantity, urgency: r.urgency, to: plan.action === 'dismiss' ? 'DISMISSED' : 'ACTIVE' })), ...(plan.reason ? { reason: plan.reason } : {}) } : {}),
        ...(plan.preferred.length ? { preferred: plan.preferred.slice(0, PREVIEW_LINES).map((p) => ({ sku: p.sku, supplier: p.toName })) } : {}),
        ...(plan.substitutions.length ? { substitutions: plan.substitutions.slice(0, PREVIEW_LINES).map((s) => ({ sku: s.sku, coveredBy: s.coveredBySku, from: s.from, to: s.to })) } : {}),
        ...(plan.cash ? { cashOnHandCents: plan.cash } : {}),
        totals: { items },
        note: `${NOT_YET} Nothing is ordered.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planReplenish(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    if (plan.action === 'dismiss' || plan.action === 'restore') {
      for (const r of plan.recs) {
        if (plan.action === 'dismiss') await dismissRecommendation({ recommendationId: r.id, userId: ctx.userId ?? null, reason: plan.reason })
        else await prisma.replenishmentRecommendation.updateMany({ where: { id: r.id, status: 'DISMISSED' }, data: { status: 'ACTIVE', dismissedAt: null, dismissedByUserId: null, dismissedReason: null } })
      }
      const ids = plan.recs.map((r) => r.productId)
      return { ok: true, data: { [plan.action === 'dismiss' ? 'dismissed' : 'restored']: plan.recs.length }, change: { before: { action: plan.action, productIds: ids }, after: { action: plan.action, recs: plan.recs.map((r) => ({ id: r.id, status: plan.action === 'dismiss' ? 'DISMISSED' : 'ACTIVE' })) } } }
    }
    if (plan.action === 'preferred-supplier') {
      for (const p of plan.preferred) {
        if (p.to) await setPreferredSupplier({ productId: p.productId, supplierId: p.to })
        else await prisma.replenishmentRule.updateMany({ where: { productId: p.productId }, data: { preferredSupplierId: null } })
      }
      return { ok: true, data: { changed: plan.preferred.length }, change: { before: { action: plan.action, preferred: plan.preferred.map((p) => ({ productId: p.productId, supplierId: p.from })) }, after: { action: plan.action, preferred: plan.preferred.map((p) => ({ productId: p.productId, supplierId: p.to })) } } }
    }
    if (plan.action === 'substitute') {
      for (const s of plan.substitutions) {
        const key = { primaryProductId_substituteProductId: workspaceKey({ primaryProductId: s.productId, substituteProductId: s.coveredBy }) }
        if (s.to == null) await prisma.productSubstitution.deleteMany({ where: { primaryProductId: s.productId, substituteProductId: s.coveredBy } })
        else if (s.from == null) await createSubstitution({ primaryProductId: s.productId, substituteProductId: s.coveredBy, substitutionFraction: s.to })
        else await prisma.productSubstitution.update({ where: key, data: { substitutionFraction: s.to } })
      }
      return { ok: true, data: { changed: plan.substitutions.length }, change: { before: { action: plan.action, substitutions: plan.substitutions.map((s) => ({ productId: s.productId, coveredBy: s.coveredBy, fraction: s.from })) }, after: { action: plan.action, substitutions: plan.substitutions.map((s) => ({ productId: s.productId, coveredBy: s.coveredBy, fraction: s.to })) } } }
    }
    const existing = await prisma.brandSettings.findFirst({ select: { id: true } })
    if (existing) await prisma.brandSettings.update({ where: { id: existing.id }, data: { cashOnHandCents: plan.cash!.to } })
    else await prisma.brandSettings.create({ data: { cashOnHandCents: plan.cash!.to } })
    return { ok: true, data: { cashOnHandCents: plan.cash!.to }, change: { before: { action: plan.action, cashOnHandCents: plan.cash!.from }, after: { action: plan.action, cashOnHandCents: plan.cash!.to } } }
  },
}

// ── email-supplier ────────────────────────────────────────────────────────────────────────────────────

const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * 08 S9 — what an e-mail to a supplier would be: the supplier's own address on file (one recipient, never a typed one),
 * at most one of its purchase orders (one approval card per PO), and the sender — the business's identity (07 O3),
 * refused without one, never sent as another business. Read in this order so another business's supplier or PO is
 * "not found" before anything about this business is said.
 */
async function planSupplierEmail(args: Record<string, unknown>) {
  const supplier = await prisma.supplier.findUnique({ where: { id: String(args.supplierId) }, select: { id: true, name: true, email: true } })
  if (!supplier) return { error: 'Supplier not found' } as Refusal
  let po: { id: string; poNumber: string; status: string } | null = null
  if (args.purchaseOrderId) {
    const found = await prisma.purchaseOrder.findUnique({ where: { id: String(args.purchaseOrderId) }, select: { id: true, poNumber: true, status: true, supplierId: true, deletedAt: true } })
    if (!found || found.deletedAt) return { error: 'Purchase order not found' } as Refusal
    if (found.supplierId !== supplier.id) return { error: `${found.poNumber} is not a purchase order of ${supplier.name}.` } as Refusal
    po = { id: found.id, poNumber: found.poNumber, status: found.status }
  }
  const to = supplier.email?.trim() ?? ''
  if (!EMAIL_LIKE.test(to)) return { error: `${supplier.name} has no e-mail address on file: add one first (upsert-supplier). Nothing was queued.` } as Refusal
  const { resolveBusinessIdentity } = await import('../../business-identity.service.js')
  const identity = await resolveBusinessIdentity()
  if (identity.ok === false) return { error: identity.reason } as Refusal
  const { defaultFrom } = await import('../../email/transport.js')
  const subject = (typeof args.subject === 'string' && args.subject.trim()) || (po ? `${identity.identity.brandName} — purchase order ${po.poNumber}` : `Message from ${identity.identity.brandName}`)
  return { supplier: { id: supplier.id, name: supplier.name }, po, to, from: identity.identity.emailFrom, shownFrom: identity.identity.emailFrom ?? defaultFrom(), subject, text: String(args.message).trim() }
}

const emailSupplier: AgentTool = {
  name: 'email-supplier',
  title: 'E-mail a supplier',
  input: z.object({
    supplierId: z.string().trim().min(1).max(64).describe('the supplier (supplier-search names them); it is written to at its own e-mail address on file'),
    purchaseOrderId: z.string().trim().min(1).max(64).optional().describe('the one purchase order of this supplier the message is about, if any'),
    subject: z.string().trim().min(1).max(200).optional().describe('the subject; left out: the business\'s name, and the PO number when one is named'),
    message: z.string().trim().min(1).max(5000).describe('the message, in plain text'),
  }),
  requires: [F.suppliersManage],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  // A sent e-mail cannot be taken back.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'E-mail one supplier at its own address on file, about at most one of its purchase orders, from this business\'s own '
    + 'identity (Settings › Company; refused without one, never sent as another business). The message is logged in the '
    + 'supplier\'s history as sent by the person who approves it. A dry run that only logs the e-mail unless outbound '
    + 'e-mail is switched on; the card says which. Always waits for a person to approve it in Nexus; it cannot be taken back.',
  async handler(args): Promise<ToolResult> {
    const plan = await planSupplierEmail(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const live = emailLive() && !!process.env.RESEND_API_KEY
    return {
      ok: true,
      preview: {
        action: 'email-supplier',
        summary: `E-mail ${plan.supplier.name} (${plan.to})${plan.po ? ` about ${plan.po.poNumber}` : ''}.`,
        supplier: plan.supplier,
        ...(plan.po ? { purchaseOrder: plan.po } : {}),
        email: { to: plan.to, from: plan.shownFrom, subject: plan.subject, live, what: live ? 'The e-mail is sent. It cannot be taken back.' : 'E-mail is a dry run here (outbound e-mail is off): it is logged, not sent.' },
        message: plan.text.length > 600 ? `${plan.text.slice(0, 599)}…` : plan.text,
        note: `${NOT_YET} It goes out from this business, and the supplier's history names the person who approves it as the sender.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planSupplierEmail(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const { sendSupplierEmail } = await import('../../supply/supplier-email.service.js')
    // The sender is the person who approved this request (ctx.userId in a run), never an argument.
    const out = await sendSupplierEmail({ supplierId: plan.supplier.id, to: plan.to, subject: plan.subject, text: plan.text, byUserId: ctx.userId ?? null, ...(plan.from ? { from: plan.from } : {}) })
    if (!out.delivery.ok) return { ok: false, error: `The e-mail to ${plan.supplier.name} was not sent: ${out.delivery.error ?? 'the e-mail provider refused it'}. It is in the supplier's history as not sent.` }
    return { ok: true, data: { supplier: plan.supplier.name, to: plan.to, subject: plan.subject, ...(plan.po ? { purchaseOrder: plan.po.poNumber } : {}), dryRun: out.delivery.dryRun, commId: out.comm.id } }
  },
}

export const SUPPLY_CHANGE_TOOLS: AgentTool[] = [
  upsertSupplier, draftPurchaseOrder, advancePurchaseOrder, cancelPurchaseOrder,
  // 08 S10 — receiving, inbound shipments, product costs, replenishment actions.
  receiveStock, updateInboundShipment, setProductCosts, replenishmentAction,
  // 08 S9 — an e-mail to a supplier, from the business's own identity.
  emailSupplier,
]
