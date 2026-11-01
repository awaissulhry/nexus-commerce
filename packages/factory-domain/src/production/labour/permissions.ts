import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Labour records and corrections (apps/factory-api modules/production/labour; B-W2b-45; features MES-201 … MES-206; design
 * production.labour "Labour & corrections", floor.myday "Your records" and "Dispute an entry"), in the production area,
 * office only. Checked with can() against the line's (or the record's) company and site. The floor works with its own
 * floor permission: `floor.work` lets the signed-in worker read their own records (GDPR art. 15; c.c. art. 2101) and
 * dispute one of them, with the PIN.
 *
 * Nothing here opens one person's figures by itself: the daily sheet of one person goes through the People privacy gate
 * (people.figures.view and the site's PERFORMANCE legal gate; Statuto dei Lavoratori art. 4 c.1), and a list here never
 * names a person, filters, groups or totals by one (Owner answers W1, F2). No money: minutes are standard minutes.
 */
export const PRODUCTION_LABOUR_DEFINITIONS = definePermissions('production', {
  'labour.view': {
    risk: 'read',
    description:
      "See Labour & corrections: one queue of correction requests, disputes, off-standard blocks and line days to close (per line and day, never per person), each line's day with what holds its close, a labour record per scan with its standard minutes (its worker only on the record, where the site records workers and its legal gate for one person's work figures is on), and every change to labour and attendance records with before, after, who, when and why.",
  },
  'labour.close': {
    risk: 'write',
    description: "Close a line's day once its off-standard time is coded and its anomalies are cleared (corrections waiting, open disputes, refused scans, attendance anomalies): closed days feed pay.",
  },
  'labour.reopen': {
    risk: 'write',
    description: "Reopen a closed line's day, with a reason (closed days feed pay: a change after the close is on record).",
  },
  'labour.answer': {
    risk: 'write',
    description:
      "Answer a worker's dispute of their own record, upheld or rejected, in words sent to them; where upheld, correct the off-standard block it is about in the same step (before and after are kept). Never a dispute of one's own record.",
  },
})

export const PRODUCTION_LABOUR_VIEW = 'production.labour.view' satisfies Permission
export const PRODUCTION_LABOUR_CLOSE = 'production.labour.close' satisfies Permission
export const PRODUCTION_LABOUR_REOPEN = 'production.labour.reopen' satisfies Permission
export const PRODUCTION_LABOUR_ANSWER = 'production.labour.answer' satisfies Permission

export const PRODUCTION_LABOUR_PERMISSIONS: readonly Permission[] = Object.freeze([PRODUCTION_LABOUR_VIEW, PRODUCTION_LABOUR_CLOSE, PRODUCTION_LABOUR_REOPEN, PRODUCTION_LABOUR_ANSWER])
