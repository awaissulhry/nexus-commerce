import { z } from 'zod'
import { defineEvent } from '../events/define'

/**
 * The chemical register and the data sheet library (B-W2b-143; the module's own events file, as quality-amendments: safety/events.ts
 * is the other safety steps'; QHS-277, QHS-278; design plant.chemicals "live: sds.replaced
 * → register"). apps/factory-api's modules/safety/chemicals emits them in the commands that make the change.
 *
 *   chemical.changed   a chemical was added to the register, changed, archived or put back in use
 *   sds.replaced       a safety data sheet became the current one of its chemical and language (the first one, or a newer
 *                      version: the one before is kept, superseded)
 *
 * Reach the register of the office (safety.view over the chemical's company and site) and the tablets of its site
 * (floor.work: the cabinet's reader refreshes what it keeps). Ids, codes and states only: no person, no money.
 */

const live = (fields: readonly string[]) => ({ permission: 'safety.view', floor: 'floor.work', fields }) as const

export const CHEMICAL_CHANGES = ['ADDED', 'EDITED', 'ARCHIVED', 'RESTORED'] as const

export const events = [
  defineEvent({
    type: 'chemical.changed',
    context: 'safety-chemicals',
    description: 'A chemical was added to the register of a site, changed (hazards, place, roles, PPE), archived or put back in use.',
    payload: z.strictObject({ chemicalId: z.uuid(), siteId: z.uuid(), change: z.enum(CHEMICAL_CHANGES) }),
    live: live(['chemicalId', 'siteId', 'change']),
  }),
  defineEvent({
    type: 'sds.replaced',
    context: 'safety-chemicals',
    description: 'A safety data sheet became the current one of its chemical and language: the first one, or a newer version (the one before is kept, superseded).',
    payload: z.strictObject({ chemicalId: z.uuid(), siteId: z.uuid(), sheetId: z.uuid(), supersededId: z.uuid().nullable(), language: z.string().regex(/^[a-z]{2}$/) }),
    live: live(['chemicalId', 'siteId', 'sheetId', 'language']),
  }),
] as const
