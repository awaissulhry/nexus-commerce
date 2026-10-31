import { z } from 'zod'
import { defineEvent } from '../events/define'
import { GATE_PURPOSES } from './privacy/purposes'

/**
 * The people module's events. B-W2b-26 (employees and teams) and the later People steps add their blocks to the same
 * list, one block each (check-event-contract: every event of the module sits in src/people/events.ts).
 *
 * B-W2b-27 (privacy of people data), emitted by apps/factory-api modules/people/privacy in the command that makes the
 * change. Ids, purposes, states and counts only: never a person, a basis text, a reason or a figure.
 *
 *   legal_gate.changed               a purpose of people data was switched on or off at a site, or its leads choice
 *                                    widened or narrowed: the People screens and Admin › Privacy re-read the gate
 *   people_settings.privacy_changed  a company's minimum group size or the roles that see one person's figures changed
 *
 * Both reach the office screens of people.privacy.view holders; the floor receives none (it reads no legal basis).
 */

export const LEGAL_GATE_CHANGES = ['SWITCHED_ON', 'SWITCHED_OFF', 'LEADS_WIDENED', 'LEADS_NARROWED'] as const
export const PRIVACY_SETTINGS_CHANGES = ['WIDENED', 'NARROWED'] as const

export const events = [
  // B-W2b-27: privacy of people data.
  defineEvent({
    type: 'legal_gate.changed',
    context: 'people',
    description: "A purpose of people data (attendance, one person's work figures) was switched on or off at a site, or whether leads see one person's figures there changed.",
    payload: z.strictObject({
      gateId: z.uuid(),
      siteId: z.uuid(),
      purpose: z.enum(GATE_PURPOSES),
      change: z.enum(LEGAL_GATE_CHANGES),
      open: z.boolean(),
      leadsSeeFigures: z.boolean(),
    }),
    live: { permission: 'people.privacy.view', fields: ['gateId', 'siteId', 'purpose', 'change', 'open'] },
  }),
  defineEvent({
    type: 'people_settings.privacy_changed',
    context: 'people',
    description: "A company's minimum group size for people figures, or the roles that see one person's figures, changed.",
    payload: z.strictObject({
      companyId: z.uuid(),
      minimumGroupSize: z.number().int().min(3),
      figureRoleCount: z.number().int().min(0),
      change: z.enum(PRIVACY_SETTINGS_CHANGES),
    }),
    live: { permission: 'people.privacy.view', fields: ['companyId', 'minimumGroupSize', 'change'] },
  }),
] as const
