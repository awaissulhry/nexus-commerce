import { newId } from '@nexus/factory-domain/core/ids'
import { SCHEDULE_CHANGES } from '@nexus/factory-domain/planning/schedule/changes'
import { laneColumns, SLOT_LIMITS, type LaneRef } from '@nexus/factory-domain/planning/schedule/slots'
import type { CommandTools, CommandTx } from '../../../core/command'
import type { SiteRow } from '../store'

/**
 * The board's change log for this step's writes (B-W2b-312; ScheduleChange of B-W2b-286, append-only): a pin or unpin,
 * the moves and placements of forward scheduling and the backlog reschedule, and the moves of an applied what-if (naming
 * its scenario). Each row: the working plan, the slot, its work order and operation, where it was and where it went, who
 * and when. B-W2b-329 logs the W2a moves the same way and reads the log (the Changes section with undo). And the one
 * planning.schedule_changed of this step's commands (the board, capacity and allocation screens read again).
 */

export type LoggedKind = 'PLACE' | 'MOVE' | 'REMOVE' | 'PIN' | 'UNPIN'

export interface LoggedPlace {
  readonly lane: LaneRef
  readonly startAt: Date
  readonly endAt: Date
}

export interface LoggedChange {
  readonly kind: LoggedKind
  readonly slotId: string
  readonly workOrderId: string
  readonly operationId: string | null
  readonly from?: LoggedPlace | null
  readonly to?: LoggedPlace | null
  readonly reason?: string | null
  readonly whatIfScenarioId?: string | null
}

const NO_LANE = { lineId: null, workCentreId: null, partyId: null }

/** Writes the rows (one statement) in the command's transaction. */
export async function logChanges(tx: CommandTx, site: SiteRow, planVersionId: string, changes: readonly LoggedChange[], actorId: string, now: Date): Promise<void> {
  if (changes.length === 0) return
  await tx.scheduleChange.createMany({
    data: changes.map((change) => {
      const from = change.from ? laneColumns(change.from.lane) : NO_LANE
      const to = change.to ? laneColumns(change.to.lane) : NO_LANE
      return {
        id: newId(),
        siteId: site.id,
        planVersionId,
        kind: change.kind,
        slotId: change.slotId,
        workOrderId: change.workOrderId,
        workOrderOperationId: change.operationId,
        fromLineId: from.lineId,
        fromWorkCentreId: from.workCentreId,
        fromPartyId: from.partyId,
        fromStartAt: change.from?.startAt ?? null,
        fromEndAt: change.from?.endAt ?? null,
        toLineId: to.lineId,
        toWorkCentreId: to.workCentreId,
        toPartyId: to.partyId,
        toStartAt: change.to?.startAt ?? null,
        toEndAt: change.to?.endAt ?? null,
        reason: change.reason ?? null,
        whatIfScenarioId: change.whatIfScenarioId ?? null,
        changedById: actorId,
        changedAt: now,
        createdAt: now,
        createdById: actorId,
      }
    }),
  })
}

export type DepthChange = Extract<(typeof SCHEDULE_CHANGES)[number], 'PINNED' | 'UNPINNED' | 'SCHEDULED_FORWARD' | 'BACKLOG_RESCHEDULED' | 'WHAT_IF_APPLIED'>

/** planning.schedule_changed for this step's commands (B-W2a-34's event; the change kinds B-W2b-312 added). */
export function emitDepthChange(tools: CommandTools, site: SiteRow, plan: { readonly id: string; readonly version: number }, change: DepthChange, slotIds: readonly string[], workOrderIds: readonly string[]): void {
  tools.emit({
    type: 'planning.schedule_changed',
    subject: plan.id,
    companyId: site.companyId,
    siteId: site.id,
    payload: { siteId: site.id, planVersionId: plan.id, planVersion: plan.version, change, slots: slotIds.length, slotIds: slotIds.slice(0, SLOT_LIMITS.perBatch), workOrderIds: [...new Set(workOrderIds)].slice(0, SLOT_LIMITS.perBatch) },
  })
}
