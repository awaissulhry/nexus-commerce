import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The training records, the attendance signed on the floor and the hands-on instruction register (B-W2b-139; QHS-243,
 * QHS-244, QHS-246, QHS-247, QHS-248; design people.skills live "training.recorded (Office or floor sign-off) → cells",
 * floor.training live "The session closed in the office → signing stops with the reason"). apps/factory-api's
 * modules/safety/records emits them in the commands that make the change. Their own module folder, as safety-training.
 *
 *   training_session.changed     a session was opened, edited, closed (with how many records it wrote) or cancelled. The
 *                                tablets of its site read it again: a closed or cancelled one stops signing with the reason.
 *   training_attendance.changed  an attendance was signed on the floor, recorded from the paper sheet, countersigned (on the
 *                                floor with the trainer's PIN, or in the office) or voided. The tablet's list fills ("8
 *                                signed"); the office's session record reads again.
 *   training.recorded            training records were written: from a session's close, typed in the office, or a correction.
 *                                The matrix's safety cells and the due list read again.
 *   instruction.changed          an entry of the instruction register was written, signed on the floor, recorded on paper or
 *                                voided.
 *
 * Ids, counts, states and how; never a name, a result per person or a typed reason. Reach the safety pages of the office
 * (safety.view); the session and attendance events also reach the tablets of the site (floor.work: ids and counts only).
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const
const toFloor = (fields: readonly string[]) => ({ permission: 'safety.view', floor: 'floor.work', fields }) as const

export const SESSION_CHANGES = ['OPENED', 'EDITED', 'CLOSED', 'CANCELLED'] as const
export const ATTENDANCE_CHANGES = ['SIGNED', 'PAPER', 'COUNTERSIGNED', 'VOIDED'] as const
export const RECORD_WAYS = ['SESSION', 'OFFICE', 'CORRECTION'] as const
export const INSTRUCTION_CHANGES = ['ADDED', 'SIGNED', 'PAPER', 'VOIDED'] as const
export const SIGNED_VIA = ['FLOOR', 'OFFICE'] as const

export const events = [
  defineEvent({
    type: 'training_session.changed',
    context: 'safety-records',
    description: 'A training session was opened at a site, edited before anyone signed, closed (its training records written) or cancelled with the reason.',
    payload: z.strictObject({
      sessionId: z.uuid(),
      courseId: z.uuid(),
      status: z.enum(['OPEN', 'CLOSED', 'CANCELLED']),
      change: z.enum(SESSION_CHANGES),
      /** CLOSED: how many training records the close wrote. */
      records: z.number().int().min(0),
    }),
    live: toFloor(['sessionId', 'status', 'change']),
  }),
  defineEvent({
    type: 'training_attendance.changed',
    context: 'safety-records',
    description: 'An attendance at a training session was signed with badge and PIN on the floor, recorded from the paper sheet, countersigned by the trainer (floor PIN or office) or voided.',
    payload: z.strictObject({
      sessionId: z.uuid(),
      /** The attendances concerned (a countersignature names several). */
      attendanceIds: z.array(z.uuid()).min(1),
      change: z.enum(ATTENDANCE_CHANGES),
      via: z.enum(SIGNED_VIA),
      /** Attendances of the session signed and not voided now, and of them countersigned (counts). */
      signed: z.number().int().min(0),
      countersigned: z.number().int().min(0),
    }),
    live: toFloor(['sessionId', 'change', 'signed', 'countersigned']),
  }),
  defineEvent({
    type: 'training.recorded',
    context: 'safety-records',
    description: 'Training records were written: from a session’s countersigned attendances at its close, typed in the office, or a correction of an earlier record.',
    payload: z.strictObject({
      courseId: z.uuid(),
      recordIds: z.array(z.uuid()).min(1),
      /** The people concerned (ids: the matrix reads their cells again). */
      employeeIds: z.array(z.uuid()).min(1),
      way: z.enum(RECORD_WAYS),
      sessionId: z.uuid().nullable(),
      /** CORRECTION: the record it corrects. */
      correctsId: z.uuid().nullable(),
    }),
    live: live(['courseId', 'way', 'sessionId']),
  }),
  defineEvent({
    type: 'instruction.changed',
    context: 'safety-records',
    description: 'An entry of the hands-on instruction register was written, signed by the person on the floor with badge and PIN, recorded from its signed paper or voided.',
    payload: z.strictObject({
      instructionId: z.uuid(),
      employeeId: z.uuid(),
      change: z.enum(INSTRUCTION_CHANGES),
      via: z.enum(SIGNED_VIA),
    }),
    live: live(['instructionId', 'change']),
  }),
] as const
