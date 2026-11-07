import { defineManifest } from '../../../core/manifest'

/**
 * The training records (B-W2b-139; QHS-243, QHS-244, QHS-246, QHS-247, QHS-248; design people.skills "Record training",
 * "Instruction register", the tiles, the new tabs "Certificate (PDF)" and "Training due list (PDF)", people.employees ›
 * "Safety training", floor.training "Training attendance"). Office: safety.view reads; safety.training.record keeps the
 * sessions, the attendances recorded in the office and the records; safety.instruction.record keeps the instruction register;
 * handlers check each record with can() against the person's (or the session's) company and site (`record`). Floor: floor.work
 * at the tablet's own site (the person signs with their own badge and PIN, the trainer countersigns with theirs).
 */
const view = { audiences: ['office'], permission: 'safety.view', scope: 'record' } as const
const record = { audiences: ['office'], permission: 'safety.training.record', scope: 'record' } as const
const instruct = { audiences: ['office'], permission: 'safety.instruction.record', scope: 'record' } as const
const floor = { audiences: ['floor'], permission: 'floor.work', scope: 'site' } as const

export const manifest = defineManifest({
  'GET /safety/training/sessions': view,
  'GET /safety/training/sessions/:sessionId': view,
  'POST /safety/training/sessions': record,
  'PATCH /safety/training/sessions/:sessionId': record,
  'POST /safety/training/sessions/:sessionId/paper': record,
  'POST /safety/training/sessions/:sessionId/countersign': record,
  'POST /safety/training/sessions/:sessionId/attendances/:attendanceId/void': record,
  'POST /safety/training/sessions/:sessionId/close': record,
  'POST /safety/training/sessions/:sessionId/cancel': record,
  'GET /safety/training/people/:employeeId': view,
  'POST /safety/training/records': record,
  'POST /safety/training/records/:recordId/correct': record,
  'GET /safety/training/records/:recordId/pdf': view,
  'GET /safety/training/due': view,
  'GET /safety/training/due/pdf': view,
  'GET /safety/training/instruction': view,
  'POST /safety/training/instruction': instruct,
  'POST /safety/training/instruction/:instructionId/paper': instruct,
  'POST /safety/training/instruction/:instructionId/void': instruct,
  'GET /safety/floor/training/sessions': floor,
  'GET /safety/floor/training/sessions/:sessionId': floor,
  'POST /safety/floor/training/sessions/:sessionId/sign': floor,
  'POST /safety/floor/training/sessions/:sessionId/countersign': floor,
  'POST /safety/floor/training/instruction/pending': floor,
  'POST /safety/floor/training/instruction/:instructionId/sign': floor,
})
