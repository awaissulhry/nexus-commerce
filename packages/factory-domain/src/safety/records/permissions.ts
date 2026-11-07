import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Safety at work: the training records, their due lists, the hands-on instruction register and the attendance signed on the
 * floor (apps/factory-api modules/safety/records; B-W2b-139; QHS-243, QHS-244, QHS-246, QHS-247, QHS-248; design
 * people.skills "Record training", "Instruction register", people.employees "Safety training", floor.training "Training
 * attendance"; D.Lgs. 81/2008 art. 37), in the safety area. Reading is safety.view (../organisation/permissions.ts), checked
 * with can() against the person's company and site. The floor signs with floor.work: the person's own badge and PIN (an
 * attendance, an instruction entry), the trainer's own badge and PIN (the countersignature).
 *
 *   safety.training.record      open a training session at a site (course, day, hours, language, trainer), edit it before
 *                               anyone signs, record an attendance from the signed paper sheet, countersign an attendance
 *                               in the office (the trainer's paper signature or the office's), void a wrong attendance,
 *                               close the session (its training records are written from the countersigned attendances)
 *                               or cancel it; record training given elsewhere (a course, a day, people, results, the
 *                               language checked), correct a record with the reason (a new record: records are never
 *                               changed).
 *   safety.instruction.record   write an entry of the hands-on instruction register (who, the task or machine, the
 *                               instructor, minutes, language) for the person to sign on the floor, record its signed
 *                               paper, void a wrong entry with the reason.
 *
 * The course catalogue and what a type of machine asks stay safety.training.manage (../training/permissions.ts).
 */
export const SAFETY_RECORDS_DEFINITIONS = definePermissions('safety', {
  'training.record': {
    risk: 'write',
    description:
      'Keep the training records: open a training session (course, day, hours, language, trainer) for the workers to sign on the floor with badge and PIN, record a paper attendance sheet, countersign or void an attendance in the office, close the session (its records are written from the countersigned attendances) or cancel it; record training given elsewhere with each person’s result and language check; correct a record with the reason (records are never changed).',
  },
  'instruction.record': {
    risk: 'write',
    description:
      'Keep the hands-on instruction register: write who was instructed on which task or machine, by whom, for how many minutes and in which language, for the person to sign on the floor with badge and PIN; record its signed paper; void a wrong entry with the reason.',
  },
})

export const SAFETY_TRAINING_RECORD = 'safety.training.record' satisfies Permission
export const SAFETY_INSTRUCTION_RECORD = 'safety.instruction.record' satisfies Permission

export const SAFETY_RECORDS_PERMISSIONS: readonly Permission[] = Object.freeze([SAFETY_TRAINING_RECORD, SAFETY_INSTRUCTION_RECORD])
