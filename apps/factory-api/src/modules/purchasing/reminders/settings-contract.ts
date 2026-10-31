import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * The Owner's switch for automatic PO confirmation reminders (B-W2b-14; Z1:09): where it stands for a company (its own
 * row, else the tenant-wide row, else OFF) and the switch itself (./settings.ts).
 */

const row = output({ id: id(), companyId: id().nullable(), confirmationRemindersEnabled: z.boolean(), version: z.number().int(), updatedAt: instant() }).nullable()

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
