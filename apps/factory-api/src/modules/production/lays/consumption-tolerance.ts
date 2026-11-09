import { ConflictError, type Issue } from '@nexus/factory-domain/core/errors'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { consumptionCheck, toleranceFor, type ConsumptionRefusalCode, type ConsumptionWarningCode, type ToleranceRow } from '@nexus/factory-domain/product/settings/rules'
import type { Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'

/**
 * The consumption tolerance at the cut consumption confirmation (B-W2b-221; PRD-105; factory-domain product/settings/rules;
 * the settings are modules/product/settings). B-W2b-116's fabric used at cut finish (./fabric.ts confirmFabricUsed) asks it,
 * in its command, with the lay's estimate (marker × plies counted) and the figure confirmed:
 *
 *   MATCH        a figure that differs from the estimate is refused (409 `refusal/CONSUMPTION_MUST_MATCH`, in words) until
 *                the confirmation carries a note that explains it
 *   MAY_DIFFER   kept as typed (the default, and B-W2b-116's behaviour)
 *   WARN_ABOVE   kept; above the percent (either way) the answer carries the warning CONSUMPTION_ABOVE_TOLERANCE
 *
 * Which rule: the ProductSettings row of the cut order's company per material kind (the cut order's material), its general
 * rule, then the tenant-wide row's per kind and general rule, then MAY_DIFFER. The floor reads ProductSettings (its grant,
 * B-W2b-206): the table's own session asks it. Lengths only.
 */

const TOLERANCE_COLUMNS = { consumptionTolerance: true, consumptionTolerancePct: true, consumptionToleranceByKind: true } as const

async function toleranceRow(tx: CommandTx, id: string): Promise<ToleranceRow | null> {
  const row = await tx.productSettings.findUnique({ where: { id }, select: TOLERANCE_COLUMNS })
  return row === null ? null : { consumptionTolerance: row.consumptionTolerance, consumptionTolerancePct: row.consumptionTolerancePct?.toString() ?? null, consumptionToleranceByKind: row.consumptionToleranceByKind }
}

/** The tolerance of the cut order's material for its company. */
export async function toleranceForCutOrder(tx: CommandTx, tenantId: string, order: { readonly companyId: string; readonly itemId: string }) {
  const item = await tx.item.findUnique({ where: { id: order.itemId }, select: { kind: true } })
  const company = await toleranceRow(tx, order.companyId)
  const tenant = await toleranceRow(tx, tenantId)
  return toleranceFor(company, tenant, (item?.kind ?? null) as ItemKind | null)
}

/** A confirmation the tolerance refuses: 409, issue `refusal/<CODE>` with the words (the table reads them as B-W2b-116's). */
export class ConsumptionRefusedError extends ConflictError {
  override name = 'ConsumptionRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusalCode: ConsumptionRefusalCode, message: string) {
    super(message)
    this.issues = [{ path: `refusal/${refusalCode}`, message }]
  }
}

/**
 * The confirmation checked against the tolerance: the warnings for the answer's `warnings` (none, or the one above the
 * percent), or the refusal thrown in words. `what` names the material in the words ("fabric").
 */
export async function checkConsumption(
  tx: CommandTx,
  tenantId: string,
  order: { readonly companyId: string; readonly itemId: string },
  figures: { readonly estimated: Decimal; readonly confirmed: Decimal; readonly note: string | null; readonly unit: string; readonly what: string },
): Promise<{ code: ConsumptionWarningCode; message: string }[]> {
  const check = consumptionCheck(await toleranceForCutOrder(tx, tenantId, order), figures)
  if (check.outcome === 'REFUSED') throw new ConsumptionRefusedError(check.code, check.message)
  return check.outcome === 'WARNING' ? [{ code: check.code, message: check.message }] : []
}
