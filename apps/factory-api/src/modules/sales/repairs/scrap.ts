import { InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { SALES_REPAIRS_MANAGE } from '@nexus/factory-domain/sales/repairs/permissions'
import { REPAIR_LIMITS, SCRAP_WARNING, safetyFailures, scrapProblems, scrapReasonOf, type RepairStage, type SafetyChecklist, type SafetyResult } from '@nexus/factory-domain/sales/repairs/rules'
import { command, type CommandCaller } from '../../../core/command'
import { officeRepair } from './access'
import { blank, recordOf, refuse } from './create'
import { lockRepair, moveStageInCommand } from './stages'
import { liveDdtOf, type RepairView } from './store'

/**
 * B-W2b-GF5 (G513; Owner 11-15: A): a protective garment whose safety check after the repair FAILED is scrapped, never
 * returned unsafe (factory-domain sales/repairs scrapProblems: repaired, protective, its last check after the repair
 * failed, no live DDT). POST /sales/repairs/:repairId/scrap {version, reason} (sales.repairs.manage, as a cancel): ONE
 * command on the repair's row (locked at the version the screen read). The database moves a repaired garment only back
 * into repair or out to the customer, so the scrap is two moves in the command, each with its RepairStageEvent and the
 * scrap's words: REPAIRED → IN_REPAIR (the repaired time cleared, as the move requires) → CANCELLED with the reason (what
 * failed and the person's words) and the repaired time back, so the record keeps the repair and its failed check (the list
 * says "Scrapped"). The garment stays at the site; the answer warns that the customer is told in writing.
 */

export interface ScrapBody {
  readonly version: number
  readonly reason: string
}

/** The stored checklist as the domain reads it (a missing point counts as not failed). */
function failuresOf(stored: unknown): string[] {
  if (!stored || typeof stored !== 'object') return []
  const list = stored as Partial<SafetyChecklist> & { protectors?: Partial<SafetyChecklist['protectors']> }
  return safetyFailures({
    seams: list.seams ?? 'PASS',
    abrasionZones: list.abrasionZones ?? 'PASS',
    closures: list.closures ?? 'PASS',
    protectors: { result: list.protectors?.result ?? 'PASS', replaced: list.protectors?.replaced ?? false, lot: list.protectors?.lot ?? null, level: list.protectors?.level ?? null },
    certificateCovers: list.certificateCovers ?? true,
    note: null,
  })
}

/** POST /sales/repairs/:repairId/scrap */
export async function scrapRepair(caller: CommandCaller, repairId: string, body: ScrapBody, idempotencyKey?: string): Promise<{ repair: RepairView; warnings: Issue[] }> {
  const { repair: seen } = await officeRepair(caller, repairId, SALES_REPAIRS_MANAGE)
  const reason = blank(body.reason)
  if (!reason || reason.length > REPAIR_LIMITS.reason) refuse([{ path: 'body/reason', message: `Say why the garment is scrapped (at most ${REPAIR_LIMITS.reason} characters).` }], 'A reason is needed.')
  const { result } = await command(caller, { name: 'repairs.scrap', idempotencyKey, input: { repairId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const repair = await lockRepair(tools, seen.id, body.version)
    const problems = scrapProblems({
      number: repair.number,
      stage: repair.stage as RepairStage,
      required: repair.safetyCheckRequired,
      result: (repair.safetyCheckResult as SafetyResult | null) ?? null,
      checkedAt: repair.safetyCheckedAt,
      repairedAt: repair.repairedAt,
      liveDdt: await liveDdtOf(tx, repair.id),
    })
    if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
    const failures = failuresOf(repair.safetyChecklist)
    const words = scrapReasonOf(failures, reason!)
    const repairedAt = repair.repairedAt!
    const audit = { scrapped: true, failures, safetyCheckedAt: repair.safetyCheckedAt ? toUtcIso(repair.safetyCheckedAt) : null, repairedAt: toUtcIso(repairedAt) }
    const out = await moveStageInCommand(tools, repair, 'IN_REPAIR', { data: { repairedAt: null }, note: words, audit })
    await moveStageInCommand(tools, out, 'CANCELLED', { data: { cancelledAt: now, cancelReason: words, repairedAt }, note: words, audit: { ...audit, cancelledAt: toUtcIso(now) } })
    return { warnings: [{ path: 'garment', message: SCRAP_WARNING }] }
  })
  return { repair: await recordOf(caller, seen.id), warnings: result.warnings }
}
