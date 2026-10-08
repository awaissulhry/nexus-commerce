/**
 * MCP full control 08 S13 — sending stock into Amazon FBA (decided S-3, Owner 2026-10-01): Claude asks to plan the
 * shipment (plan-fba-shipment) and reads where it stands and what Amazon offers (fba-shipment-options). Confirming at
 * Amazon — the shipments, fulfilment centres, carriers and fees — stays a person's click in Nexus: no tool here reaches it.
 *
 * Step 4 Send to FBA (2026-10-07): both tools run on the SAME services as the Matrix "Send to FBA…" dialog
 * (services/fba-inbound/, through its contract): one rule for the boxes and the refusals, one job that talks to Amazon
 * outside any request. Drafts (Owner 2026-10-08): plan-fba-shipment puts the SKUs into the ONE open DRAFT for that
 * warehouse and market, exactly as the dialog's "Add to draft" does — nothing is held, nothing reaches Amazon. A person
 * sends the draft from Fulfillment › Outbound › FBA shipments ("Send to Amazon": the checks again, the holds, Amazon's
 * steps). FBA stock is Amazon's number: nothing here writes it. Prep / label owners come from each SKU's case pack (the
 * Matrix Case column) and are never Claude's to choose.
 */

import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import { FBA_SEND_COPY, lineCases, lineUnits, sendSummary, type FbaDraftAddRequest, type FbaPlanView, type FbaSendDraft, type FbaSendLine } from '@nexus/shared/fba-send'
import { CASE_COPY, type CaseCount } from '@nexus/shared/stock-cases'
import prisma from '../../../db.js'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { amazonSkusInMarket } from '../../listings/reported-sku.js'
import { addToDraft, FbaSendError, readPlan, readSendDraft } from '../../fba-inbound/contract.js'

const PLAN_MAX_SKUS = 50
const NOT_YET = 'Nothing changes until a person approves this in Nexus.'
const PERSON_CONFIRMS = 'Where it goes (shipments, fulfilment centres, carrier, Amazon\'s fees) is chosen and confirmed by a person in Nexus; Claude cannot confirm it.'
const PERSON_SENDS = `A person sends the draft from Fulfillment › Outbound › ${FBA_SEND_COPY.pageTitle} ("Send to Amazon"): Nexus checks it again, holds the units and starts Amazon's steps.`
const upper = (value: unknown) => (typeof value === 'string' ? value.trim().toUpperCase() : value)
type Refusal = { error: string }
/** One sentence, ending with its full stop. */
const sentence = (text: string) => (/[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`)
const refused = (r: unknown): r is Refusal => !!r && typeof r === 'object' && 'error' in r

// ── plan-fba-shipment ─────────────────────────────────────────────────────────────────────────────────

interface Prepared {
  request: FbaDraftAddRequest
  draft: FbaSendDraft
  lines: FbaSendLine[]
  /** What "Send to Amazon" would refuse today (the shared rule): the draft keeps the SKUs, a person fixes these first. */
  beforeSending: string[]
}

/** The lines the dialog's "Add to draft" would send, and what the shared rule says about sending them. Owners are never
 *  Claude's to choose. Writes nothing. */
async function prepare(args: Record<string, unknown>): Promise<Prepared | Refusal> {
  const asked = (args.lines ?? []) as Array<{ productId: string; cases?: number | CaseCount[]; units?: number; quantity?: number }>
  const ids = asked.map((line) => line.productId)
  if (new Set(ids).size !== ids.length) return { error: 'A product is on two lines: give each product one line.' }
  let draft: FbaSendDraft
  try {
    draft = await readSendDraft({ productIds: ids, from: (args.from as string | undefined) ?? null, market: String(args.marketplace ?? '') })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
  if (!draft.from) return { error: `${FBA_SEND_COPY.problem.notWarehouse}. Nothing was changed.` }
  if (!draft.markets.some((m) => m.code === draft.market)) return { error: `${FBA_SEND_COPY.problem.noAccount(draft.market)}. Nothing was changed.` }
  // Sealed cases per case size. A plain number stands for the SKU's ONE case size; a SKU with several names each size.
  const lines: FbaSendLine[] = []
  for (const line of asked) {
    const sku = draft.skus.find((s) => s.productId === line.productId)
    const looseUnits = line.units ?? line.quantity ?? 0
    if (Array.isArray(line.cases) || line.cases === undefined || line.cases === 0) {
      lines.push({ productId: line.productId, cases: Array.isArray(line.cases) ? line.cases : [], looseUnits })
      continue
    }
    const sizes = sku?.caseSizes ?? []
    if (sizes.length !== 1) {
      const name = sku?.sku ?? line.productId
      return {
        error: sizes.length === 0
          ? `${name}: ${CASE_COPY.noSize}. Nothing was changed.`
          : `${name} has ${CASE_COPY.sizes(sizes.map((size) => size.unitsPerCase))}: give the cases of each size as [{ unitsPerCase, cases }]. Nothing was changed.`,
      }
    }
    lines.push({ productId: line.productId, cases: [{ unitsPerCase: sizes[0].unitsPerCase, cases: line.cases }], looseUnits })
  }
  const readyToShipOn = typeof args.readyToShipOn === 'string' && args.readyToShipOn ? args.readyToShipOn : draft.readyToShipOn
  const summary = sendSummary(draft, { lines, readyToShipOn, mixedBox: null, owners: null })
  // A SKU whose listing has no single seller SKU reads "no listing" in the shared rule; Claude gets the exact reason.
  const conflicts = summary.blocking.some((problem) => problem.code === 'NO_LISTING')
    ? await amazonSkusInMarket(prisma as never, { accountId: draft.markets.find((m) => m.code === draft.market)!.accountId, marketplace: draft.market, products: draft.skus.map((sku) => ({ id: sku.productId, sku: sku.sku })) })
    : new Map()
  const beforeSending = [...new Set(summary.blocking.filter((problem) => problem.code !== 'NO_UNITS').map((problem) => {
    if (problem.code === 'NO_OWNERS') return sentence(`${problem.message} — ${FBA_SEND_COPY.ownersForClaude}`)
    const conflict = problem.code === 'NO_LISTING' && problem.productId ? conflicts.get(problem.productId) : undefined
    return sentence(conflict && conflict.ok === false && conflict.code === 'CONFLICT' ? conflict.sentence : problem.message)
  }))]
  return {
    request: { from: draft.from.code, market: draft.market, readyToShipOn, lines, mixedBox: null, owners: null },
    draft,
    lines,
    beforeSending,
  }
}

const planFbaShipment: AgentTool = {
  name: 'plan-fba-shipment',
  title: 'Plan an FBA shipment',
  input: z.object({
    marketplace: z.preprocess(upper, z.string().min(2).max(20)).describe('the Amazon market the stock goes to, e.g. IT'),
    lines: z.array(z.object({
      productId: z.string().trim().min(1).max(64).describe('Nexus product id of a SKU (a parent stands for its variations: name them)'),
      cases: z.union([
        z.array(z.object({
          unitsPerCase: z.coerce.number().int().min(1).max(10_000).describe('the case size: units in one sealed case'),
          cases: z.coerce.number().int().min(0).max(10_000).describe('sealed cases of that size'),
        })).max(5),
        z.coerce.number().int().min(0).max(10_000),
      ]).optional().describe('sealed cases to send, as identical case boxes per case size: [{ unitsPerCase, cases }], or a number when the SKU has one case size (needs each case size\'s dimensions and weight)'),
      units: z.coerce.number().int().min(0).max(10_000).optional().describe('loose units to send, packed in mixed boxes (needs the SKU\'s unit weight)'),
      quantity: z.coerce.number().int().min(0).max(10_000).optional().describe('older name for units'),
    })).min(1).max(PLAN_MAX_SKUS).describe(`the SKUs, 1 to ${PLAN_MAX_SKUS}; a SKU with no cases and no units is taken out of the draft`),
    from: z.string().trim().min(1).max(40).optional().describe('the warehouse the boxes leave from, by its code (default: the default warehouse)'),
    readyToShipOn: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('the day the boxes are ready, YYYY-MM-DD (default: the next working day)'),
  }),
  requires: [F.inboundManage],
  category: 'fulfillment',
  riskTier: 'medium',
  readOnly: false,
  alwaysAsk: true,
  openWorld: false,
  // Claude's undo-change cannot put a draft back; a person changes or deletes it on the FBA shipments page.
  reversibility: 'none',
  maxClaudeTrust: 'ask',
  description:
    'Put SKUs into the FBA shipment draft for a warehouse and an Amazon market, exactly as the Matrix "Send to FBA…" '
    + 'dialog\'s "Add to draft" does: sealed cases per case size and loose units. There is ONE open draft per warehouse '
    + 'and market; a SKU already in it takes the new numbers, a SKU with no cases and no units is taken out. Nothing is '
    + 'held and nothing reaches Amazon: a person sends the draft from Fulfillment › Outbound › FBA shipments ("Send to '
    + 'Amazon"), when Nexus checks it again, holds the units at the warehouse and creates the plan at Amazon; then a '
    + 'person chooses where it goes (shipments, fulfilment centres, carrier, Amazon\'s fees) and confirms it — Claude '
    + 'cannot. The answer lists what "Send to Amazon" would refuse today (no Amazon listing in the market, Prep by / '
    + 'Labels by not set, more than free, an incomplete ship-from address, …) so it can be fixed first. FBA stock is '
    + 'Amazon\'s number and never changes here. Always waits for a person to approve it.',
  async handler(args): Promise<ToolResult> {
    const plan = await prepare(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    const { draft, lines } = plan
    const summary = sendSummary(draft, { lines, readyToShipOn: plan.request.readyToShipOn ?? draft.readyToShipOn, mixedBox: null, owners: null })
    const skuOf = new Map(draft.skus.map((sku) => [sku.productId, sku]))
    const inDraft = new Map(draft.lines.map((line) => [line.productId, lineUnits(line)]))
    const from = draft.from!
    return {
      ok: true,
      preview: {
        summary: `Add ${summary.units} units of ${summary.skus} SKUs to the FBA draft from ${from.code} to Amazon ${draft.market}. Nothing is held or sent to Amazon.`,
        marketplace: draft.market,
        from: { code: from.code, town: from.town, address: draft.address.summary },
        readyToShipOn: plan.request.readyToShipOn,
        draft: draft.draftId ? { planId: draft.draftId, existing: true } : { existing: false },
        lines: lines.map((line) => {
          const sku = skuOf.get(line.productId)!
          const out = lineCases(line) === 0 && line.looseUnits === 0
          return {
            sku: sku.msku ?? sku.sku,
            ...(sku.msku && sku.msku !== sku.sku ? { productSku: sku.sku } : {}),
            ...(out ? { takenOut: true } : { cases: line.cases.filter((c) => c.cases > 0), units: line.looseUnits, quantity: lineUnits(line) }),
            ...(inDraft.has(line.productId) ? { inDraftNow: inDraft.get(line.productId) } : {}),
            freeNow: sku.free,
            prepBy: sku.prepOwner,
            labelsBy: sku.labelOwner,
          }
        }),
        totals: { skus: summary.skus, units: summary.units, boxes: summary.boxes, caseBoxes: summary.caseBoxes, mixedBoxes: summary.mixedBoxes, weightKg: summary.weightKg },
        ...(plan.beforeSending.length ? { beforeSending: plan.beforeSending } : {}),
        ...(summary.warnings.length ? { warnings: summary.warnings.map((warning) => warning.message) } : {}),
        note: `${NOT_YET} ${PERSON_SENDS} ${PERSON_CONFIRMS}`,
      },
    }
  },
  async execute(args, ctx): Promise<ToolResult> {
    const plan = await prepare(args)
    if (refused(plan)) return { ok: false, error: plan.error }
    try {
      const { planId } = await addToDraft(plan.request, { actor: ctx.userId ?? 'claude', userId: ctx.userId ?? null }, 'claude')
      return {
        ok: true,
        data: {
          planId,
          draft: true,
          units: plan.lines.reduce((n, l) => n + lineUnits(l), 0),
          ...(plan.beforeSending.length ? { beforeSending: plan.beforeSending } : {}),
          next: `${PERSON_SENDS} ${PERSON_CONFIRMS}`,
        },
        change: { before: { marketplace: plan.request.market }, after: { planId } },
      }
    } catch (error) {
      if (error instanceof FbaSendError) {
        const extra = error.problems.filter((problem) => problem.message !== error.message).map((problem) => problem.message)
        return { ok: false, error: `${[error.message, ...extra].map(sentence).join(' ')} Nothing was changed.` }
      }
      return { ok: false, error: `The draft was not changed: ${error instanceof Error ? error.message : String(error)}` }
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
