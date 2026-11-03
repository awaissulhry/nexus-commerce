import type { QueueKind, QueueRecordType } from '@nexus/factory-domain/quality/queue/rules'
import type { CommandCaller } from '../../../core/command'
import { getInspection } from '../final/inspections'
import { sheetOf } from '../final/sheet'
import { getIncoming } from '../incoming/views'
import { checkViewOf } from '../inprocess/views'

/**
 * One open record as the screen that records it reads it (B-W2b-106): exactly the module's own answers, so the tablet keeps
 * what the bench screens show and the queued writes act on (B-W2b-97's bench sheet and W1's inspection, B-W2b-98's incoming
 * record, B-W2b-99's check with its plan checks). Each read checks the caller again in its module.
 */

export interface RecordRef {
  readonly recordType: QueueRecordType
  readonly id: string
  readonly kind?: QueueKind
}

export async function modelOf(caller: CommandCaller, ref: Pick<RecordRef, 'recordType' | 'id'>) {
  switch (ref.recordType) {
    case 'Inspection': {
      const final = await getInspection(caller, ref.id)
      const sheet = final.inspection.planVersion ? await sheetOf(caller, ref.id) : null
      return { final, sheet, incoming: null, check: null }
    }
    case 'IncomingInspection':
      return { final: null, sheet: null, incoming: await getIncoming(caller, ref.id), check: null }
    case 'InProcessCheck':
      return { final: null, sheet: null, incoming: null, check: await checkViewOf(caller, ref.id) }
  }
}
