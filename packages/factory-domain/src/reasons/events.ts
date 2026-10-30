import { z } from 'zod'
import { defineEvent } from '../events/define'
import { REASON_LISTS } from './lists'
import { REASON_LIMITS } from './rules'

/**
 * The reason lists' event (B-W2a-18). apps/factory-api's platform/reasons emits it in the command that changes a list;
 * the editor on another screen says "Changed by someone else · Reload", and the pickers read the list again. Codes and
 * counts only (never words: they are not personal, but a live message stays small).
 *
 *   reason.changed   reasons of `list` were added, edited, set inactive or active again, reordered, or the standard
 *                    reasons the list was missing were added
 */
export const REASON_CHANGES = ['CREATED', 'EDITED', 'DEACTIVATED', 'REACTIVATED', 'REORDERED', 'STANDARD_ADDED'] as const

export const events = [
  defineEvent({
    type: 'reason.changed',
    context: 'reasons',
    description: 'Reasons of a reason list were added, edited, set inactive or active again, reordered, or the standard ones it was missing were added: pickers and tiles read the list again.',
    payload: z.strictObject({
      list: z.enum(REASON_LISTS),
      change: z.enum(REASON_CHANGES),
      /** The codes the change reached (all of the list for a reorder). */
      codes: z.array(z.string().min(1).max(40)).min(1).max(REASON_LIMITS.perList),
    }),
    live: { permission: 'reasons.view', fields: ['list', 'change', 'codes'] },
  }),
] as const
