import { InvalidStateError } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_CHECK } from '@nexus/factory-domain/sales/repairs/permissions'
import { safetyCheckHeld, safetyChecklistProblems, safetyFailures, safetyResultOf, storedChecklist, type RepairStage, type SafetyChecklist, type SafetyResult } from '@nexus/factory-domain/sales/repairs/rules'
import { command, type CommandCaller } from '../../../core/command'
import { officeRepair } from './access'
import { recordOf, refuse } from './create'
import { lockRepair, touchRepair } from './stages'
import type { RepairView } from './store'

/**
 * The safety check of a repaired protective garment (B-W2a-57; design repair.safety "A PPE garment goes back only after a
 * check that it still protects": seams, abrasion zones, closures, protectors with the lot and level of a replaced one
 * (SAL-400), the certificate still covers it; "Checked by", "Sign off (SignBlock)"). An e-signature: the checks of the
 * repair and the checklist first, then the office's fresh code (`stepUp`, requireStepUp), then ONE command on the
 * repair's row: the points, the result (PASS only when no point failed and the certificate still covers the garment),
 * when (now: after the repair, as the database wants) and who; repair.safety_checked. A new check replaces the last one
 * (its audit row keeps it); going back into repair makes it out of date.
 */

export interface SafetyBody {
  readonly version: number
  readonly checklist: {
    readonly seams: SafetyChecklist['seams']
    readonly abrasionZones: SafetyChecklist['abrasionZones']
    readonly closures: SafetyChecklist['closures']
    readonly protectors: { readonly result: SafetyChecklist['protectors']['result']; readonly replaced: boolean; readonly lot?: string | null | undefined; readonly level?: string | null | undefined }
    readonly certificateCovers: boolean
    readonly note?: string | null | undefined
  }
}

const checklistOf = (body: SafetyBody['checklist']): SafetyChecklist => ({
  seams: body.seams,
  abrasionZones: body.abrasionZones,
  closures: body.closures,
  protectors: { result: body.protectors.result, replaced: body.protectors.replaced, lot: body.protectors.lot ?? null, level: body.protectors.level ?? null },
  certificateCovers: body.certificateCovers,
  note: body.note ?? null,
})

/** POST /sales/repairs/:repairId/safety-check (sales.repairs.check + the office's step-up, asked after every other check). */
export async function signSafetyCheck(caller: CommandCaller, repairId: string, body: SafetyBody, stepUp: () => void | Promise<void>, idempotencyKey?: string): Promise<{ repair: RepairView; result: SafetyResult; failures: string[] }> {
  const { context, repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_CHECK)
  const early = safetyCheckHeld(seen.number, seen.stage as RepairStage, seen.safetyCheckRequired)
  if (early) throw new InvalidStateError(early)
  const checklist = checklistOf(body.checklist)
  const problems = safetyChecklistProblems(checklist)
  if (problems.length > 0) refuse(problems, 'The safety check is not complete.')
  await stepUp()
  const result = safetyResultOf(checklist)
  const failures = safetyFailures(checklist)
  await command(caller, { name: 'repairs.safetyCheck', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { now } = tools
    const repair = await lockRepair(tools, seen.id, body.version)
    const held = safetyCheckHeld(repair.number, repair.stage as RepairStage, repair.safetyCheckRequired)
    if (held) throw new InvalidStateError(held)
    const stored = storedChecklist(checklist)
    await touchRepair(tools, repair, { safetyChecklist: stored, safetyCheckResult: result, safetyCheckedAt: now, safetyCheckedById: context.actorId })
    tools.audit({
      recordType: 'RepairOrder',
      recordId: repair.id,
      companyId: repair.companyId,
      siteId: repair.siteId,
      before: { safetyCheckResult: repair.safetyCheckResult, safetyCheckedAt: repair.safetyCheckedAt ? toUtcIso(repair.safetyCheckedAt) : null, safetyChecklist: repair.safetyChecklist },
      after: { safetyCheckResult: result, safetyCheckedAt: toUtcIso(now), safetyChecklist: stored, repairedAt: repair.repairedAt ? toUtcIso(repair.repairedAt) : null, failures },
    })
    tools.emit({ type: 'repair.safety_checked', subject: repair.id, companyId: repair.companyId, siteId: repair.siteId, payload: { repairId: repair.id, number: repair.number, result } })
    return { result }
  })
  return { repair: await recordOf(caller, seen.id), result, failures }
}
