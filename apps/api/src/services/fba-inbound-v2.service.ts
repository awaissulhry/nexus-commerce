/**
 * F.3 (TECH_DEBT #50) — FBA Inbound v2024-03-20 state machine.
 *
 * Wraps the F.1 client wrappers with persistence + status polling
 * so the multi-step flow can be driven from either an HTTP route
 * (operator clicks "Next") or a follow-up cron sweep that picks up
 * plans stuck in *_CONFIRMING states.
 *
 * The polling is on-demand here — caller invokes `pollUntilDone(planId,
 * step)` and gets back the terminal state. F.5 may add a cron worker
 * if mid-flow drop-offs become common; for v1 the operator-driven
 * "Next" click is sufficient.
 *
 * Each transition writes the operationId to FbaInboundPlanV2.operationIds
 * before invoking the SP-API call so that an API restart mid-poll can
 * resume by reading the persisted operationId.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import {
  createInboundPlan,
  getInboundOperation,
  listPackingOptions,
  confirmPackingOption,
  listPlacementOptions,
  confirmPlacementOption,
  listTransportationOptions,
  confirmTransportationOptions,
  getShipmentLabels,
  type CreateInboundPlanInput,
  type TransportationConfirmation,
  type ShipmentLabelsInput,
} from '../clients/amazon-fba-inbound-v2.client.js'

export type PlanStep =
  | 'CREATE'
  | 'LIST_PACKING'
  | 'CONFIRM_PACKING'
  | 'LIST_PLACEMENT'
  | 'CONFIRM_PLACEMENT'
  | 'LIST_TRANSPORT'
  | 'CONFIRM_TRANSPORT'
  | 'GET_LABELS'

export type PlanStatus =
  | 'DRAFT'
  | 'CREATING'
  | 'ACTIVE'
  | 'PACKING_OPTIONS_LISTED'
  | 'PACKING_CONFIRMING'
  | 'PACKING_CONFIRMED'
  | 'PLACEMENT_OPTIONS_LISTED'
  | 'PLACEMENT_CONFIRMING'
  | 'PLACEMENT_CONFIRMED'
  | 'TRANSPORT_OPTIONS_LISTED'
  | 'TRANSPORT_CONFIRMING'
  | 'TRANSPORT_CONFIRMED'
  | 'LABELS_READY'
  | 'FAILED'

const POLL_BACKOFF_MS = [
  1_000, 2_000, 3_000, 5_000, 5_000, 10_000, 10_000,
  15_000, 15_000, 30_000, 30_000, 60_000, 60_000,
]

function setOperationId(
  plan: { operationIds: unknown },
  step: PlanStep,
  operationId: string,
): Record<string, string> {
  const current =
    plan.operationIds && typeof plan.operationIds === 'object' && !Array.isArray(plan.operationIds)
      ? (plan.operationIds as Record<string, string>)
      : {}
  return { ...current, [step]: operationId }
}

async function recordError(planRowId: string, message: string): Promise<void> {
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: {
      status: 'FAILED',
      lastError: message.slice(0, 500),
      lastErrorAt: new Date(),
    },
  })
}

/**
 * Poll an SP-API operationId until it resolves SUCCESS / FAILED, with
 * exponential backoff. Throws on FAILED or timeout.
 */
async function pollOperation(operationId: string): Promise<void> {
  for (const wait of POLL_BACKOFF_MS) {
    const r = await getInboundOperation(operationId)
    if (r.operationStatus === 'SUCCESS') return
    if (r.operationStatus === 'FAILED') {
      const problemMsg = r.operationProblems
        ?.map((p) => `[${p.severity ?? '?'}] ${p.code ?? '?'}: ${p.message ?? ''}`)
        .join('; ') ?? 'unknown'
      throw new Error(`SP-API operation FAILED: ${problemMsg}`)
    }
    await new Promise((res) => setTimeout(res, wait))
  }
  throw new Error(
    `SP-API operation ${operationId} did not resolve within ${POLL_BACKOFF_MS.reduce((a, b) => a + b, 0) / 1000}s — left IN_PROGRESS, follow up via /operations/${operationId}`,
  )
}

// ── Step 1: CREATE ────────────────────────────────────────────────────

/**
 * Create a v2024-03-20 inbound plan + persist the FbaInboundPlanV2
 * tracker row. Returns the plan's row id (use for subsequent step
 * calls).
 *
 * Optional inboundShipmentId links the new plan to an existing
 * InboundShipment row.
 */
export async function createPlan(input: {
  spApi: CreateInboundPlanInput
  inboundShipmentId?: string
  createdBy?: string
}): Promise<{ planRowId: string }> {
  const row = await prisma.fbaInboundPlanV2.create({
    data: {
      inboundShipmentId: input.inboundShipmentId ?? null,
      name: input.spApi.name ?? null,
      status: 'CREATING',
      currentStep: 'CREATE',
      createdBy: input.createdBy ?? null,
    },
  })

  try {
    const { operationId } = await createInboundPlan(input.spApi)
    await prisma.fbaInboundPlanV2.update({
      where: { id: row.id },
      data: {
        operationIds: setOperationId(row, 'CREATE', operationId),
      },
    })
    await pollOperation(operationId)

    // The CREATE operation result carries the planId. v2024-03-20's
    // operations endpoint returns the planId in the response body of
    // the createInboundPlan op once SUCCESS — we've already polled
    // SUCCESS above, but the planId comes back from a different shape.
    // We follow up with a getInboundOperation read to extract it.
    const detail = await getInboundOperation(operationId)
    const planId =
      (detail as any).planId ??
      (detail as any).operationProblems?.find?.((p: any) => p.code === 'PLAN_ID')?.message ??
      null
    if (!planId) {
      throw new Error(
        'createInboundPlan completed but no planId surfaced — re-poll or contact SP-API support',
      )
    }
    await prisma.fbaInboundPlanV2.update({
      where: { id: row.id },
      data: { planId, status: 'ACTIVE', currentStep: 'LIST_PACKING' },
    })
    return { planRowId: row.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn('fba-inbound-v2: createPlan failed', { rowId: row.id, error: msg })
    await recordError(row.id, msg)
    throw err
  }
}

// ── Step 2-3: LIST + CONFIRM PACKING ──────────────────────────────────

export async function listPlanPackingOptions(planRowId: string) {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet — CREATE incomplete')
  const r = await listPackingOptions(plan.planId)
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: { status: 'PACKING_OPTIONS_LISTED', currentStep: 'CONFIRM_PACKING' },
  })
  return r
}

export async function confirmPlanPackingOption(
  planRowId: string,
  packingOptionId: string,
): Promise<void> {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: {
      status: 'PACKING_CONFIRMING',
      selectedPackingOptionId: packingOptionId,
    },
  })
  try {
    const { operationId } = await confirmPackingOption(plan.planId, packingOptionId)
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: { operationIds: setOperationId(plan, 'CONFIRM_PACKING', operationId) },
    })
    await pollOperation(operationId)
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: { status: 'PACKING_CONFIRMED', currentStep: 'LIST_PLACEMENT' },
    })
  } catch (err) {
    await recordError(planRowId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ── Step 4-5: LIST + CONFIRM PLACEMENT ────────────────────────────────

export async function listPlanPlacementOptions(planRowId: string) {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  const r = await listPlacementOptions(plan.planId)
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: { status: 'PLACEMENT_OPTIONS_LISTED', currentStep: 'CONFIRM_PLACEMENT' },
  })
  return r
}

export async function confirmPlanPlacementOption(
  planRowId: string,
  placementOptionId: string,
): Promise<void> {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: {
      status: 'PLACEMENT_CONFIRMING',
      selectedPlacementOptionId: placementOptionId,
    },
  })
  try {
    const { operationId } = await confirmPlacementOption(plan.planId, placementOptionId)
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: { operationIds: setOperationId(plan, 'CONFIRM_PLACEMENT', operationId) },
    })
    await pollOperation(operationId)

    // Placement confirmation produces the shipmentIds. Re-list to
    // pick them up — placement-options endpoint returns the now-
    // confirmed option with its shipmentIds populated.
    const refreshed = await listPlacementOptions(plan.planId)
    const confirmed = refreshed.placementOptions.find(
      (p) => p.placementOptionId === placementOptionId,
    )
    const shipmentIds = confirmed?.shipmentIds ?? []
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: {
        status: 'PLACEMENT_CONFIRMED',
        currentStep: 'LIST_TRANSPORT',
        shipmentIds,
      },
    })
  } catch (err) {
    await recordError(planRowId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ── Step 6-7: LIST + CONFIRM TRANSPORT ────────────────────────────────

export async function listPlanTransportOptions(planRowId: string, shipmentId: string) {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  if (!plan.shipmentIds.includes(shipmentId)) {
    throw new Error(`shipmentId ${shipmentId} not in this plan`)
  }
  const r = await listTransportationOptions(plan.planId, shipmentId)
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: { status: 'TRANSPORT_OPTIONS_LISTED', currentStep: 'CONFIRM_TRANSPORT' },
  })
  return r
}

export async function confirmPlanTransportOptions(
  planRowId: string,
  selections: TransportationConfirmation[],
): Promise<void> {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: {
      status: 'TRANSPORT_CONFIRMING',
      selectedTransportationOptions: selections as any,
    },
  })
  try {
    const { operationId } = await confirmTransportationOptions(plan.planId, selections)
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: { operationIds: setOperationId(plan, 'CONFIRM_TRANSPORT', operationId) },
    })
    await pollOperation(operationId)
    await prisma.fbaInboundPlanV2.update({
      where: { id: planRowId },
      data: { status: 'TRANSPORT_CONFIRMED', currentStep: 'GET_LABELS' },
    })
  } catch (err) {
    await recordError(planRowId, err instanceof Error ? err.message : String(err))
    throw err
  }
}

// ── Step 8: LABELS ────────────────────────────────────────────────────

export async function fetchPlanLabels(
  planRowId: string,
  args?: ShipmentLabelsInput,
): Promise<Record<string, unknown>> {
  const plan = await prisma.fbaInboundPlanV2.findUnique({ where: { id: planRowId } })
  if (!plan?.planId) throw new Error('Plan has no SP-API planId yet')
  if (plan.shipmentIds.length === 0) {
    throw new Error('No shipmentIds — placement not confirmed yet')
  }
  const labels: Record<string, unknown> = {}
  for (const shipmentId of plan.shipmentIds) {
    try {
      const r = await getShipmentLabels(plan.planId, shipmentId, args)
      labels[shipmentId] = r
    } catch (err) {
      labels[shipmentId] = {
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
  await prisma.fbaInboundPlanV2.update({
    where: { id: planRowId },
    data: { status: 'LABELS_READY', labels: labels as any },
  })
  return labels
}
