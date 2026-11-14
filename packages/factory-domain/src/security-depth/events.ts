import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * Security in depth's events (plan A1 §3.4; B-W2b-404; PLT-031, PLT-063, PLT-068):
 *
 *   security.settings_changed       the company's session lengths or the actions that ask for a fresh code changed: the
 *                                   Security page reads them again (a shorter length ends open sessions at their next
 *                                   request)
 *   security.role_archive_changed   a custom role was archived (its live assignments ended in the same command) or
 *                                   restored: the roles list and the role's record read it again
 *
 * Ids, codes and versions only: never a name, a reason or a person.
 */
export const events = [
  defineEvent({
    type: 'security.settings_changed',
    context: 'security-depth',
    description: "The company's session lengths or the actions that ask for a fresh code changed.",
    payload: z.strictObject({
      part: z.enum(['SESSIONS', 'STEP_UP']),
      version: z.number().int().min(1),
    }),
    live: { permission: 'security.view', fields: ['part'] },
  }),
  defineEvent({
    type: 'security.role_archive_changed',
    context: 'security-depth',
    description: 'A custom role was archived (its live assignments ended) or restored.',
    payload: z.strictObject({
      roleId: z.uuid(),
      archived: z.boolean(),
    }),
    live: { permission: 'roles.view', fields: ['archived'] },
  }),
] as const
