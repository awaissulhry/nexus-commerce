import { z } from 'zod'
import { input } from '@nexus/factory-domain/core/contracts'
import type { CommandTools } from '../../../../core/command'
import { guardReport, recordGuards, type GuardOutcome, type GuardWork, type RecordedScan } from '../../guards/checks'
import type { ScanOperation } from '@nexus/factory-domain/production/scans/rules'

export type { ComponentInput } from '../../guards/checks'
export type { VerifiedOverride } from '../../guards/override'

/**
 * B-W2b-46 hook of the scans' report (modules/production/guards; MES-070, MES-097, MES-098, MES-114): what scans.ts and
 * contract.ts call, each in a named line of their own.
 *
 *   contract   the report body (and the offline batch's REPORT item, which the floor sync reuses) takes the lots scanned
 *              at the operation: `components: [{ code, garments }]`.
 *   decide     after W1's reportDecision (called with `guarded: true`), inside the report's command: the site's checks
 *              hold the report (W1's codes and words for a skipped operation and more than passed; WRONG_BUNDLE) unless
 *              the report carries a verified team leader's override (POST /production/guards/override); the lots are
 *              checked. Its `cap` is what reached the operation, for the scan's audit row.
 *   record     after the scan row: the checks the report met (WARN: the team leaders are told), the override, the lots.
 */

/** The report body's field (scans/contract.ts `report`): the lots scanned at the operation, each with its garments. */
export const guardReportFields = {
  components: z
    .array(input({ code: z.string().trim().min(1).max(60), garments: z.number().int().min(1).max(100_000) }))
    .max(40)
    .optional(),
}

export async function guardReportInCommand(tools: CommandTools, work: GuardWork): Promise<GuardOutcome> {
  return guardReport(tools.tx, work)
}

export function recordGuardsInCommand(tools: CommandTools, outcome: GuardOutcome, input: { readonly scan: RecordedScan; readonly workOrder: { readonly id: string; readonly number: string; readonly companyId: string; readonly siteId: string }; readonly bundleId: string; readonly operation: ScanOperation }): void {
  recordGuards(tools, outcome, input)
}
