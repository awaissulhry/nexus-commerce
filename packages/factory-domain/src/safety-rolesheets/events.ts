import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The role risk sheets (B-W2b-128; QHS-236; design plant.risk "live: role_sheet.changed → Banner in Skills, PPE and Health",
 * plant.health "live: employee.role_changed → change-of-task visit due"). apps/factory-api's modules/safety/rolesheets and
 * modules/people/employees/role-sheet.ts emit them in the commands that make the change. Their own module folder (the safety
 * events file is B-W2b-120's, the people one B-W2b-26's), as safety-risk.
 *
 *   role_sheet.changed       a role sheet was added, applied (its risks, kit, courses or health surveillance changed: which
 *                            courses and items came or went, how many people are in the role), archived or restored. The
 *                            Skills, PPE and Health pages show "the role sheet changed" and read again.
 *   employee.role_changed    a person was given a role sheet, moved to another, or left without one (by the office, or by a
 *                            move to another site, which clears it). B-W2b-135 makes the change-of-task visit due from it;
 *                            B-W2b-133 and -134 read the person's new courses and kit.
 *
 * Reach the safety pages of the office (safety.view over the record's company): ids, counts and states only; never a name,
 * never a health value (whether the role needs visits is the role's, never a person's), never the floor.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', fields }) as const

export const ROLE_SHEET_CHANGES = ['ADDED', 'APPLIED', 'ARCHIVED', 'RESTORED'] as const
export const ROLE_CHANGE_SOURCES = ['OFFICE', 'SITE_MOVE'] as const

export const events = [
  defineEvent({
    type: 'role_sheet.changed',
    context: 'safety-rolesheets',
    description: 'A role risk sheet was added, applied (its risks, PPE kit, courses or health surveillance changed), archived or restored: which courses and kit items came or went and how many people are in the role.',
    payload: z.strictObject({
      roleSheetId: z.uuid(),
      change: z.enum(ROLE_SHEET_CHANGES),
      people: z.number().int().min(0),
      coursesAdded: z.array(z.uuid()),
      coursesRemoved: z.array(z.uuid()),
      kitAdded: z.array(z.uuid()),
      kitRemoved: z.array(z.uuid()),
      /** Whether the role needs health surveillance now, when this change set it; null: not changed. */
      surveillance: z.enum(['NEEDED', 'NOT_NEEDED']).nullable(),
    }),
    live: live(['roleSheetId', 'change']),
  }),
  defineEvent({
    type: 'employee.role_changed',
    context: 'safety-rolesheets',
    description: 'A person was given a role sheet, moved to another one, or left without one (by the office, or by a move to another site).',
    payload: z.strictObject({ employeeId: z.uuid(), fromRoleSheetId: z.uuid().nullable(), toRoleSheetId: z.uuid().nullable(), by: z.enum(ROLE_CHANGE_SOURCES) }),
    live: live(['employeeId', 'toRoleSheetId']),
  }),
] as const
