/**
 * MCP full control 08 S13 — sending stock into Amazon FBA (decided S-3, Owner 2026-10-01): Claude asks to create the
 * plan (plan-fba-shipment) and reads where it stands and what Amazon offers (fba-shipment-options). Confirming at Amazon
 * — the shipments, fulfilment centres, carriers and fees — stays a person's click in Nexus: no tool here reaches it.
 *
 * Step 4 Send to FBA (2026-10-07): both tools run on the SAME services as the Matrix "Send to FBA…" dialog
 * (services/fba-inbound/, through its contract): one rule for the boxes and the refusals, one job that talks to Amazon
 * outside any request. A plan HOLDS its units at the From warehouse at once (FBM listings show the lower number); the
 * units leave the warehouse only when a person marks a shipment Shipped. FBA stock is Amazon's number: nothing here
 * writes it. Prep / label owners come from each SKU's case pack (the Matrix Case column); a SKU with them "not set" is
 * refused, never guessed. The ship-from address is the From warehouse + Settings › Company; a gap is refused.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { FBA_SEND_COPY, lineUnits, sendSummary, type FbaCreateRequest, type FbaPlanView, type FbaSendDraft, type FbaSendLine } from '@nexus/shared/fba-send'
import prisma from '../../../db.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { amazonSkusInMarket } from '../../listings/reported-sku.js'
import { createSendPlan, FbaSendError, readPlan, readSendDraft } from '../../fba-inbound/contract.js'

const PLAN_MAX_SKUS = 50
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const PERSON_CONFIRMS = 'Where it goes (shipments, fulfilment centres, carrier, Amazon\'s fees) is chosen and confirmed by a person in Nexus; Claude cannot confirm it.'
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
type Refusal = { error: string }
/** One sentence, ending with its full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

// ── plan-fba-shipment ─────────────────────────────────────────────────────────────────────────────────

interface Prepared {
  request: FbaCreateRequest
  draft: FbaSendDraft
  lines: FbaSendLine[]
}

/** The request the Matrix would send, checked by the same rule (`sendSummary`). Owners are never Claude's to choose. */
async function prepare(args: Record<string, unknown>): Promise<Prepared | Refusal> {
  const asked = (args.lines ?? []) as Array<{ productId: string; cases?: number; units?: number; quantity?: number }>
  const ids = asked.map((line) => line.productId)
  if (new Set(ids).size !== ids.length) return { error: 'A product is on two lines: give each product one line.' }
  const lines: FbaSendLine[] = asked.map((line) => ({ productId: line.productId, cases: line.cases ?? 0, looseUnits: line.units ?? line.quantity ?? 0 }))
  let draft: FbaSendDraft
  try {
    draft = await readSendDraft({ productIds: ids, from: (args.from as string | undefined) ?? null, market: String(args.marketplace ?? '') })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  const readyToShipOn = typeof args.readyToShipOn === 'string' && args.readyToShipOn ? args.readyToShipOn : draft.readyToShipOn
  const summary = sendSummary(draft, { lines, readyToShipOn, mixedBox: null, owners: null })
  if (summary.blocking.length > 0) {
    // A SKU whose listing has no single seller SKU reads "no listing" in the shared rule; Claude gets the exact reason.
    const conflicts = summary.blocking.some((problem) => problem.code === 'NO_LISTING') && draft.markets.some((m) => m.code === draft.market)
      ? await amazonSkusInMarket(prisma as never, { accountId: draft.markets.find((m) => m.code === draft.market)!.accountId, marketplace: draft.market, products: draft.skus.map((sku) => ({ id: sku.productId, sku: sku.sku })) })
      : new Map()
    const sentences = summary.blocking.map((problem) => {
      if (problem.code === 'NO_OWNERS') return `${problem.message} — ${FBA_SEND_COPY.ownersForClaude}`
      const conflict = problem.code === 'NO_LISTING' && problem.productId ? conflicts.get(problem.productId) : undefined
      return conflict && conflict.ok === false && conflict.code === 'CONFLICT' ? conflict.sentence : problem.message
    })
    return { error: `${[...new Set(sentences)].map(sentence).join(' ')} Nothing was sent to Amazon.` }
  }
  return {
    request: { from: draft.from!.code, market: draft.market, readyToShipOn, lines, mixedBox: null, owners: null },
    draft,
    lines,
  }
}

const planFbaShipment: AgentTool = {
  name: 'plan-fba-shipment',
  title: 'Plan an FBA shipment',
  input: z.object({
    marketplace: z.preprocess(upper, z.string().min(2).max(20)).describe('the Amazon market the stock goes to, e.g. IT'),
    lines: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id of a SKU (a parent stands for its variations: name them)'),
      cases: z.coerce.number().int().min(0).max(10_000).optional().describe('sealed cases to send, as identical case boxes (needs the SKU\'s case size and case dimensions)'),
      units: z.coerce.number().int().min(0).max(10_000).optional().describe('loose units to send, packed in mixed boxes (needs the SKU\'s unit weight)'),
      quantity: z.coerce.number().int().min(0).max(10_000).optional().describe('older name for units'),
    })).min(1).max(PLAN_MAX_SKUS).describe(`the SKUs, 1 to ${PLAN_MAX_SKUS}`),
    from: z.string().trim().min(1).max(40).optional().describe('the warehouse the boxes leave from, by its code (default: the default warehouse)'),
    readyToShipOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the day the boxes are ready, YYYY-MM-DD (default: the next working day)'),
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
    'Create a Send to FBA plan, exactly as the Matrix "Send to FBA…" dialog does: the SKUs (sealed cases and loose '
    + 'units), the warehouse they leave from and the Amazon market. On approval the units are HELD at that warehouse '
    + '(FBM listings show the lower number) and Nexus creates the plan at Amazon in the background; then a person '
    + 'chooses where it goes (shipments, fulfilment centres, carrier, Amazon\'s fees) and confirms it in Nexus — Claude '
    + 'cannot. Units leave the warehouse only when a person marks a shipment Shipped; FBA stock is Amazon\'s number and '
    + 'never changes here. A person can cancel the plan in Nexus (free at Amazon until it is confirmed). Refused while a '
    + 'SKU has no Amazon listing in the market, has Prep by / Labels by not set, lacks free units, or the ship-from '
    + 'address (warehouse address, company name and phone) is incomplete. Always waits for a person to approve it.',
  async handler(args): Promise<ToolResult> {
    const plan = await prepare(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const { draft, lines } = plan
    const summary = sendSummary(draft, { lines, readyToShipOn: plan.request.readyToShipOn, mixedBox: null, owners: null })
    const skuOf = new Map(draft.skus.map((sku) => [sku.productId, sku]))
    const sent = lines.filter((line) => line.cases > 0 || line.looseUnits > 0)
    return {
      ok: true,
      preview: {
        summary: `Send ${summary.units} units of ${summary.skus} SKUs from ${draft.from!.code} to Amazon ${draft.market} (held at ${draft.from!.code} until shipped).`,
        marketplace: draft.market,
        from: { code: draft.from!.code, town: draft.from!.town, address: draft.address.summary },
        readyToShipOn: plan.request.readyToShipOn,
        lines: sent.map((line) => {
          const sku = skuOf.get(line.productId)!
          return {
            sku: sku.msku ?? sku.sku,
            ...(sku.msku && sku.msku !== sku.sku ? { productSku: sku.sku } : {}),
            cases: line.cases,
            units: line.looseUnits,
            quantity: lineUnits(line, sku.unitsPerCase),
            freeNow: sku.free,
            prepBy: sku.prepOwner,
            labelsBy: sku.labelOwner,
          }
        }),
        totals: { skus: summary.skus, units: summary.units, boxes: summary.boxes, caseBoxes: summary.caseBoxes, mixedBoxes: summary.mixedBoxes, weightKg: summary.weightKg },
        ...(summary.warnings.length ? { warnings: summary.warnings.map((warning) => warning.message) } : {}),
        note: `${NOT_YET} Then the units are held at ${draft.from!.code} and the plan is created at Amazon. ${PERSON_CONFIRMS}`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await prepare(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      const { planId } = await createSendPlan(plan.request, { actor: ctx.userId ?? 'claude', userId: ctx.userId ?? null }, 'claude')
      return {
        ok: true,
        data: { planId, held: { from: plan.request.from, units: plan.lines.reduce((n, l) => n + lineUnits(l, plan.draft.skus.find((s) => s.productId === l.productId)?.unitsPerCase ?? null), 0) }, next: PERSON_CONFIRMS },
        change: { before: { marketplace: plan.request.market }, after: { planId } },
      }
    } catch (error) {
      if (error instanceof FbaSendError) {
        const extra = error.problems.filter((problem) => problem.message !== error.message).map((problem) => problem.message)
        return { ok: false, error: `${[error.message, ...extra].map(sentence).join(' ')} Nothing was sent to Amazon.` }
      }
      return { ok: false, error: `The plan was not created: ${error instanceof Error ? error.message : String(error)}` }
    }
  },
}

// ── fba-shipment-options ──────────────────────────────────────────────────────────────────────────────

/** What the plan stands at and what Amazon offered, from the snapshot the job stored — Amazon is not called. */
function optionsView(plan: FbaPlanView) {
  return {
    plan: { id: plan.id, name: plan.name, status: plan.status, statusText: FBA_SEND_COPY.status[plan.status], step: plan.step, market: plan.market, from: plan.from?.code ?? null, units: plan.units, skus: plan.skus },
    ...(plan.message ? { message: plan.message } : {}),
    ...(plan.problems.length ? { amazonProblems: plan.problems } : {}),
    options: plan.options
      ? {
          readAt: plan.options.readAt,
          expiresAt: plan.options.expiresAt,
          placements: plan.options.placements.map((placement) => ({
            placementOptionId: placement.placementOptionId,
            status: placement.status,
            expiresAt: placement.expiresAt,
            fees: placement.fees,
            discounts: placement.discounts,
            shipments: placement.shipments.map((shipment) => ({
              shipmentId: shipment.shipmentId,
              fulfilmentCentre: shipment.destinationFc,
              town: shipment.destinationTown,
              transport: shipment.transport.map((t) => ({ transportationOptionId: t.transportationOptionId, carrier: t.carrierName ?? t.carrierCode, shippingMode: t.shippingMode, shippingSolution: t.shippingSolution, quote: t.quote })),
              deliveryWindows: shipment.deliveryWindows.map((w) => ({ deliveryWindowOptionId: w.deliveryWindowOptionId, start: w.start, end: w.end })),
            })),
          })),
        }
      : null,
    ...(plan.choice ? { choice: plan.choice } : {}),
    shipments: plan.shipments.map((shipment) => ({ id: shipment.id, shipmentConfirmationId: shipment.shipmentConfirmationId, fulfilmentCentre: shipment.destinationFc, status: shipment.status, units: shipment.units, boxes: shipment.boxes.length, shippedAt: shipment.shippedAt })),
    steps: plan.steps.map((step) => ({ step: step.step, call: step.call, result: step.result, startedAt: step.startedAt, finishedAt: step.finishedAt, ...(step.problems.length ? { problems: step.problems } : {}) })),
    can: plan.can,
    note: PERSON_CONFIRMS,
  }
}

const fbaShipmentOptions: AgentTool = {
  name: 'fba-shipment-options',
  title: 'FBA shipment options',
  input: z.object({
    planId: z.string().trim().min(1).max(64).describe('the Send to FBA plan in Nexus (the planId plan-fba-shipment answered)'),
  }),
  requires: [F.inboundManage],
  restrictedFields: { fees: FIELDS.financialsFeesView, discounts: FIELDS.financialsFeesView, quote: FIELDS.financialsFeesView },
  category: 'fulfillment',
  riskTier: 'low',
  readOnly: true,
  openWorld: false,
  description:
    'Read where a Send to FBA plan stands: its status and steps (with Amazon\'s own problems when a step failed), and the '
    + 'options Amazon offered — each placement with its shipments, fulfilment centres, carriers, quotes, delivery windows, '
    + 'fees and expiry — as Nexus stored them (Amazon is not called). Reading changes nothing. '
    + PERSON_CONFIRMS,
  async handler(args): Promise<ToolResult> {
    const plan = await readPlan(String(args.planId))
    if (!plan) return { ok: false, error: 'FBA plan not found' }
    return { ok: true, data: optionsView(plan) }
  },
}

export const FBA_INBOUND_TOOLS: AgentTool[] = [planFbaShipment, fbaShipmentOptions]
