import { z } from 'zod'
import { defineEvent } from '../events/define'
import { ACCOUNTING_PACKAGES } from './packages'

/**
 * The accounting exports' and period locks' events (plan A1 §3.4; B-W2a-39; FIN-046, LOG-098, LOG-100). apps/factory-api
 * modules/accounting emits them in the commands that export, cancel, lock and lift. Ids, numbers, days and counts only:
 * never an amount. Live on the screens of the people who hold accounting.view for the company (design finance.accounting:
 * the history and the period's lock state follow them).
 *
 *   accounting_export.exported   a numbered batch was made: its number, period, packages and file count
 *   accounting_export.cancelled  a draft was abandoned (by a person, or replaced by a newer export of the period)
 *   period_lock.locked           a month was locked (SOFT or HARD), or a soft lock was made hard
 *   period_lock.lifted           a lock was lifted, with the reason kept on the lock
 */
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const live = { permission: 'accounting.view' as const, fields: ['periodStart', 'periodEnd'] }

export const events = [
  defineEvent({
    type: 'accounting_export.exported',
    context: 'accounting',
    description: "A company's numbered accounting export was made for a period (a re-export names the batch it amends).",
    payload: z.strictObject({
      exportId: z.uuid(),
      number: z.string().min(1).max(40),
      periodStart: day,
      periodEnd: day,
      packages: z.array(z.enum(ACCOUNTING_PACKAGES)).min(1),
      files: z.number().int().min(1),
      supersedesId: z.uuid().nullable(),
    }),
    live: { ...live, fields: ['number', 'periodStart', 'periodEnd'] },
  }),
  defineEvent({
    type: 'accounting_export.cancelled',
    context: 'accounting',
    description: 'A draft accounting export was cancelled, with the reason (or replaced by a newer export of its period).',
    payload: z.strictObject({ exportId: z.uuid(), periodStart: day, periodEnd: day, replacedById: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'period_lock.locked',
    context: 'accounting',
    description: "A company's period was locked: SOFT (finance may write into it with a reason) or HARD (nothing dated in it changes).",
    payload: z.strictObject({ lockId: z.uuid(), periodStart: day, periodEnd: day, level: z.enum(['SOFT', 'HARD']), exportId: z.uuid().nullable() }),
    live,
  }),
  defineEvent({
    type: 'period_lock.lifted',
    context: 'accounting',
    description: "A company's period lock was lifted with a reason.",
    payload: z.strictObject({ lockId: z.uuid(), periodStart: day, periodEnd: day, level: z.enum(['SOFT', 'HARD']) }),
    live,
  }),
] as const
