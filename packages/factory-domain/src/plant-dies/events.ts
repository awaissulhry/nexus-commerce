import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The clicking-die register's event (B-W2b-136; QHS-173; design plant.machines "Clicking dies"). apps/factory-api's
 * modules/plant/dies emits it in the command that makes the change. A module folder of its own (the event guard wants
 * `src/<module>/events.ts`), so the register can be dropped in one cut (Owner question Q17).
 *
 *   clicking_die.changed   a die was registered, changed (rack, condition, size, piece, material, supplier, cost, note)
 *                          or retired: the names of the fields only
 *
 * Reaches the office's plant screens (plant.view); not the tablets. Ids, the die number and what changed: no cost, no
 * words a person typed, no person.
 */
export const events = [
  defineEvent({
    type: 'clicking_die.changed',
    context: 'plant-dies',
    description: 'A clicking die was registered, changed or retired (its number, its style and the names of the fields that changed).',
    payload: z.strictObject({ dieId: z.uuid(), code: z.string(), styleId: z.uuid(), change: z.enum(['REGISTERED', 'CHANGED', 'RETIRED']), fields: z.array(z.string()) }),
    live: { permission: 'plant.view', fields: ['dieId', 'code', 'change'] },
  }),
] as const
