import { checklistHold, openSteps } from '@nexus/factory-domain/production/checklists/rules'
import type { CommandTools } from '../../../../core/command'
import { refuse } from '../access'
import { readTicks, stepsOfOperation } from '../../checklists/store'

/**
 * B-W2b-47 hook of the scans' report (modules/production/checklists; MES-102; design floor.operation "Steps in this
 * operation": "held Finish until all required steps are ticked"): one named line in scans.ts, inside the report's command
 * under the bundle's scan lock (a tick takes the same lock). An operation with no steps costs two reads and holds nothing.
 */
export async function checklistHoldInCommand(tools: CommandTools, report: { readonly bundleId: string; readonly bundleCode: string; readonly operationId: string }): Promise<void> {
  const steps = await stepsOfOperation(tools.tx, report.operationId)
  if (steps.length === 0) return
  const held = checklistHold(openSteps(steps, await readTicks(tools.tx, report.bundleId, report.operationId)), { bundleCode: report.bundleCode })
  if (held) refuse(held)
}
