import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The Owner's switch for automatic PO confirmation reminders (B-W2b-14; Z1:09): where it stands for a company (its own
 * row, else the tenant-wide row, else OFF) and the switch itself (./settings.ts).
 */

const row = output({
  id: id(),
  companyId: id().nullable(),
  confirmationRemindersEnabled: z.boolean(),
  /** B-W2b-377: the send's default confirm-by and the reminders' cadence set on this row (null: not set here). */
  confirmByHours: z.number().int().nullable(),
  reminderCadenceDays: z.number().int().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
}).nullable()
const source = z.enum(['COMPANY', 'TENANT', 'DEFAULT'])

const settingsAnswer = output({
  /** The company asked about; null: the tenant-wide settings. */
  companyId: id().nullable(),
  /** Which row holds: the company's own, the tenant's, or none (the default: OFF). */
  source: z.enum(['COMPANY', 'TENANT', 'DEFAULT']),
  /** Do the daily run's reminders reach this company's suppliers. */
  on: z.boolean(),
  words: z.string(),
  /** May the caller switch it (purchasing.reminders.switch over the company; every company for the tenant row). */
  mayChange: z.boolean(),
  company: row,
  tenant: row,
  /** B-W2b-377: what holds — the confirm-by hours (null: W2a's 48 hours over the supplier's open days) and the cadence in days. */
  timing: output({ confirmByHours: z.number().int().nullable(), cadenceDays: z.number().int(), source: output({ confirmByHours: source, cadenceDays: source }) }),
})

export const reminderSettingsContract = defineContract({ querystring: input({ companyId: id().optional() }), response: { 200: settingsAnswer } })

export const reminderSwitchContract = defineContract({
  body: input({
    /** The company whose reminders change; null: every company (the tenant-wide row, a role over every company). */
    companyId: id().nullable(),
    on: z.boolean(),
    /** The row's version as read; leave it out when the row does not exist yet. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: settingsAnswer },
})

// B-W2b-377: the confirm-by hours (1-720) and the cadence (1-30 days) of a company's reminders, or of every company (null clears).
export const reminderTimingContract = defineContract({
  body: input({
    companyId: id().nullable(),
    confirmByHours: z.number().int().min(1).max(720).nullable(),
    reminderCadenceDays: z.number().int().min(1).max(30).nullable(),
    /** The row's version as read; leave it out when the row does not exist yet. */
    version: z.number().int().min(1).optional(),
  }),
  response: { 200: settingsAnswer },
})
