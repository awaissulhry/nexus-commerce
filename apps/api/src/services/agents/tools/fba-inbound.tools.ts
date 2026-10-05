/**
 * MCP full control 08 S13 — sending stock into Amazon FBA (decided S-3, Owner 2026-10-01): Claude asks to create the
 * inbound plan at Amazon (plan-fba-shipment) and reads the options Amazon offers for it (fba-shipment-options).
 * Confirming packing, placement or transport — each with Amazon's fees — stays a person's click in Nexus: no tool here
 * confirms anything. A plan writes no quantity: FBA stock is Amazon's number, and own stock moves only when the boxes
 * leave (an FBA shipment is never received by receive-stock).
 *
 * Amazon is reached through the FBA Inbound v2024-03-20 client (clients/amazon-fba-inbound-v2.client.ts), which goes
 * through the channel gateway. Nexus cannot cancel a plan at Amazon, so plan-fba-shipment is irreversible.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { createPlan } from '../../fba-inbound-v2.service.js'
import { listPackingOptions, listPlacementOptions, listTransportationOptions } from '../../../clients/amazon-fba-inbound-v2.client.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { PRODUCT_NOT_FOUND } from './live-product.js'
import { amazonAccountIdFor, amazonSkusInMarket } from '../../listings/reported-sku.js'

const PLAN_MAX_SKUS = 50
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const PERSON_CONFIRMS = 'Packing, placement and transport (with Amazon\'s fees) are chosen and confirmed by a person in Nexus; Claude cannot confirm them.'
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
const lower = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : value)
type Refusal = { error: string }
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r
const text = (max: number, what: string) => z.string().trim().min(1).max(max).describe(what)

// ── plan-fba-shipment ─────────────────────────────────────────────────────────────────────────────────

interface FbaPlan {
  marketplace: { code: string; marketplaceId: string }
  name: string
  /** `sku` is the Amazon seller SKU sent (the listing's own in this market, else the product SKU); `productSku` is Nexus's. */
  lines: Array<{ productId: string; sku: string; productSku: string; quantity: number; ownStock: number }>
  shipment: { id: string; reference: string | null } | null
}

async function planFba(args: Record<string, unknown>): Promise<FbaPlan | Refusal> {
  let shipment: FbaPlan['shipment'] = null
  if (args.shipmentId) {
    const row = await prisma.inboundShipment.findFirst({ where: { id: String(args.shipmentId), deletedAt: null }, select: { id: true, reference: true, type: true, status: true } })
    if (!row) return { error: 'Inbound shipment not found' }
    const name = row.reference ? `shipment "${row.reference}"` : 'this shipment'
    if (row.type !== 'FBA') return { error: `${name} is not an FBA shipment (it is ${row.type}): link an FBA shipment, or none.` }
    if (['CLOSED', 'CANCELLED'].includes(row.status)) return { error: `${name} is ${row.status}.` }
    shipment = { id: row.id, reference: row.reference }
  }
  const code = String(args.marketplace ?? '')
  const market = await prisma.marketplace.findFirst({ where: { channel: 'AMAZON', code }, select: { code: true, marketplaceId: true } })
  if (!market?.marketplaceId) return { error: `No Amazon marketplace ${code} in this business (see the Amazon markets in Nexus).` }
  const asked = (args.lines ?? []) as Array<{ productId: string; quantity: number }>
  const ids = asked.map((l) => l.productId)
  if (new Set(ids).size !== ids.length) return { error: 'A product is on two lines: give each product one line.' }
  const products = await prisma.product.findMany({ where: { id: { in: ids }, deletedAt: null }, select: { id: true, sku: true, totalStock: true } })
  if (products.length !== ids.length) return { error: PRODUCT_NOT_FOUND }
  const byId = new Map(products.map((p) => [p.id, p]))
  // S7 — the seller SKU Amazon knows each product by in this market, on the account the plan is created with: its main
  // listing's own SKU; no listing there → the product SKU, as before. No single SKU: refused, never a guess.
  const amazonSkus = await amazonSkusInMarket(prisma, { accountId: await amazonAccountIdFor(), marketplace: market.code, products })
  for (const l of asked) {
    const amazon = amazonSkus.get(l.productId)
    if (amazon && amazon.ok === false && amazon.code === 'CONFLICT') return { error: `${amazon.sentence} Nothing was sent to Amazon.` }
  }
  const lines = asked.map((l) => {
    const product = byId.get(l.productId)!
    const amazon = amazonSkus.get(l.productId)
    return { productId: l.productId, sku: amazon && amazon.ok === true ? amazon.sku : product.sku, productSku: product.sku, quantity: l.quantity, ownStock: product.totalStock ?? 0 }
  })
  const name = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : `Inbound ${market.code} ${new Date().toISOString().slice(0, 10)}`
  return { marketplace: { code: market.code, marketplaceId: market.marketplaceId }, name, lines, shipment }
}

const planFbaShipment: AgentTool = {
  name: 'plan-fba-shipment',
  title: 'Plan an FBA shipment',
  input: z.object({
    marketplace: z.preprocess(upper, z.string().min(2).max(20)).describe('the Amazon market the stock goes to, e.g. IT'),
    lines: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id (its Amazon listing\'s seller SKU in that market is sent)'),
      quantity: z.coerce.number().int().min(1).max(10_000).describe('units to send'),
    })).min(1).max(PLAN_MAX_SKUS).describe(`the products, 1 to ${PLAN_MAX_SKUS}`),
    sourceAddress: z.object({
      name: text(100, 'contact name'),
      companyName: z.string().trim().max(100).optional().describe('company'),
      addressLine1: text(180, 'street'),
      addressLine2: z.string().trim().max(180).optional().describe('more address'),
      city: text(100, 'city'),
      stateOrProvinceCode: text(30, 'province or state code, e.g. RN'),
      postalCode: text(20, 'postal code'),
      countryCode: z.preprocess(upper, z.string().length(2)).describe('country code, e.g. IT'),
      phoneNumber: z.string().trim().max(30).optional().describe('phone'),
      email: z.string().trim().email().max(120).optional().describe('e-mail'),
    }).describe('where the boxes leave from'),
    name: z.string().trim().max(80).optional().describe('the plan\'s name'),
    shipmentId: z.string().trim().min(1).max(64).optional().describe('an FBA inbound shipment in Nexus to link the plan to'),
  }),
  requires: [F.inboundManage],
  category: 'fulfillment',
  riskTier: 'high',
  readOnly: false,
  alwaysAsk: true,
  openWorld: true,
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Create an inbound plan at Amazon to send stock into FBA: the products and units, the market and the address the '
    + 'boxes leave from. Nothing is confirmed: the packing, placement and transport options (with Amazon\'s fees) are '
    + 'read with fba-shipment-options and confirmed by a person in Nexus. No quantity changes anywhere — FBA stock is '
    + 'Amazon\'s number. Nexus cannot cancel a plan at Amazon. Always waits for a person to approve it in Nexus.',
  async handler(args): Promise<ToolResult> {
    const plan = await planFba(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const address = args.sourceAddress as { city: string; countryCode: string }
    return {
      ok: true,
      preview: {
        marketplace: plan.marketplace.code,
        name: plan.name,
        lines: plan.lines.map((l) => ({ sku: l.sku, ...(l.sku !== l.productSku ? { productSku: l.productSku } : {}), quantity: l.quantity, ownStockNow: l.ownStock })),
        from: { city: address.city, countryCode: address.countryCode },
        ...(plan.shipment ? { shipment: plan.shipment } : {}),
        totals: { skus: plan.lines.length, units: plan.lines.reduce((n, l) => n + l.quantity, 0) },
        note: `${NOT_YET} The plan is created at Amazon; no quantity changes in Nexus. ${PERSON_CONFIRMS} A plan cannot be cancelled from Nexus.`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await planFba(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const address = args.sourceAddress as Record<string, string | undefined>
    try {
      const { planRowId } = await createPlan({
        spApi: {
          name: plan.name,
          destinationMarketplaces: [plan.marketplace.marketplaceId],
          msku: plan.lines[0].sku,
          items: plan.lines.map((l) => ({ msku: l.sku, quantity: l.quantity })),
          sourceAddress: Object.fromEntries(Object.entries(address).filter(([, v]) => v != null && v !== '')) as never,
        },
        inboundShipmentId: plan.shipment?.id,
        createdBy: ctx.userId ?? undefined,
      })
      return { ok: true, data: { planId: planRowId, next: PERSON_CONFIRMS }, change: { before: { marketplace: plan.marketplace.code }, after: { planId: planRowId } } }
    } catch (error) {
      return { ok: false, error: `Amazon did not create the plan: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

// ── fba-shipment-options ──────────────────────────────────────────────────────────────────────────────

const OPTION_KINDS = ['packing', 'placement', 'transport'] as const
const fee = (f: { type?: string; value?: { amount: number; currencyCode: string } }) => ({ type: f.type ?? null, amount: f.value?.amount ?? null, currencyCode: f.value?.currencyCode ?? null })

const fbaShipmentOptions: AgentTool = {
  name: 'fba-shipment-options',
  title: 'FBA shipment options',
  input: z.object({
    planId: z.string().trim().min(1).max(64).describe('the FBA inbound plan in Nexus (inbound-shipments lists them)'),
    kind: z.preprocess(lower, z.enum(OPTION_KINDS)).default('packing').describe('packing (default), placement or transport'),
    amazonShipment: z.string().trim().min(1).max(64).optional().describe('transport: one of the plan\'s Amazon shipments (after placement is confirmed)'),
  }),
  requires: [F.inboundManage],
  restrictedFields: { fees: FIELDS.financialsFeesView, quote: FIELDS.financialsFeesView },
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  openWorld: true,
  description:
    'Read, live from Amazon, the options an FBA inbound plan has now: packing (how boxes are grouped), placement (which '
    + 'fulfilment centres, with fees) or transport (carriers and quotes for one of its shipments). Reading changes '
    + `nothing. ${PERSON_CONFIRMS}`,
  async handler(args): Promise<ToolResult> {
    const row = await prisma.fbaInboundPlanV2.findUnique({ where: { id: String(args.planId) }, select: { id: true, name: true, planId: true, status: true, currentStep: true, shipmentIds: true } })
    if (!row) return { ok: false, error: 'FBA plan not found' }
    const name = row.name ? `"${row.name}"` : 'This plan'
    if (!row.planId) return { ok: false, error: `${name} is not created at Amazon yet (${row.status}).` }
    const plan = { id: row.id, name: row.name, status: row.status, step: row.currentStep, amazonShipments: row.shipmentIds }
    try {
      if (args.kind === 'placement') {
        const r = await listPlacementOptions(row.planId)
        return { ok: true, data: { plan, placement: r.placementOptions.map((o) => ({ placementOptionId: o.placementOptionId, status: o.status, shipments: o.shipmentIds?.length ?? 0, fees: (o.fees ?? []).map(fee) })), note: PERSON_CONFIRMS } }
      }
      if (args.kind === 'transport') {
        const shipment = args.amazonShipment as string | undefined
        if (!shipment || !row.shipmentIds.includes(shipment)) {
          return { ok: false, error: row.shipmentIds.length ? `${name}: name one of its Amazon shipments (${row.shipmentIds.join(', ')}) as amazonShipment.` : `${name} has no Amazon shipments yet: placement is confirmed first, by a person in Nexus.` }
        }
        const r = await listTransportationOptions(row.planId, shipment)
        return { ok: true, data: { plan, transport: r.transportationOptions.map((o) => ({ transportationOptionId: o.transportationOptionId, carrier: o.carrier?.name ?? o.carrier?.alphaCode ?? null, shippingMode: o.shippingMode ?? null, quote: o.quote ? { amount: o.quote.cost.amount, currencyCode: o.quote.cost.currencyCode, expiration: o.quote.expiration ?? null } : null })), note: PERSON_CONFIRMS } }
      }
      const r = await listPackingOptions(row.planId)
      return { ok: true, data: { plan, packing: r.packingOptions.map((o) => ({ packingOptionId: o.packingOptionId, status: o.status, expiration: o.expiration ?? null, packingGroups: o.packingGroups?.length ?? 0, features: o.packingFeatures ?? [], fees: (o.fees ?? []).map(fee) })), note: PERSON_CONFIRMS } }
    } catch (error) {
      return { ok: false, error: `${name}: Amazon could not be read (${error instanceof Error ? error.message : String(error)})` }
    }
  },
}

export const FBA_INBOUND_TOOLS: AgentTool[] = [planFbaShipment, fbaShipmentOptions]
