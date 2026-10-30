import { definePermissions } from '../auth/permissions/registry'
import type { Permission } from '../core/permissions'

/**
 * The accounting exports and the period locks (apps/factory-api modules/accounting; B-W2a-39; FIN-046, LOG-098, LOG-100;
 * design finance.accounting, SCR-156). Area `accounting`. Checked with can() against the company of the export or the
 * lock; office only (the floor, portal and link sessions read none of it). A file of a package carries money of its
 * grain (journals and Intrastat: price; purchases and the year-end stock pack: cost): preparing or downloading it also
 * needs that grain, checked by the handler.
 *
 *   view    the exports, their checks, contents and files; a period's checks, Intrastat rows and review; the locks
 *   export  a numbered batch for a period (or a re-export of what changed), every failing check explained; cancel a draft
 *   lock    lock a period SOFT or HARD (the final close: the typed phrase), lift a SOFT lock with a reason
 *   unlock  lift a HARD lock with a reason (step-up: the accountant has the period; whether a hard lock may ever be
 *           lifted is the accountant's question, GATE-ACCOUNTANT)
 */
export const ACCOUNTING_DEFINITIONS = definePermissions('accounting', {
  view: {
    risk: 'read',
    description:
      "See a company's accounting exports (numbered batches, their checks, contents and files), a period's checks, Intrastat rows and review, and the period locks (amounts only with their grain).",
  },
  export: {
    risk: 'write',
    description:
      "Make a company's numbered accounting export for a month (sales journal, purchases journal, payments, Intrastat, the year-end stock pack), with every failing check explained in words; re-export only what changed since; cancel a draft. Each package needs the grain of its amounts.",
  },
  lock: {
    risk: 'write',
    description: "Lock a company's month: soft (finance may still write into it with a reason) or hard (the final close, with the typed phrase: nothing dated in it changes); lift a soft lock with a reason.",
  },
  unlock: {
    risk: 'stepUp',
    description: 'Lift a hard period lock with a reason (the accountant has the period: agree it with them first).',
  },
})

export const ACCOUNTING_VIEW = 'accounting.view' satisfies Permission
export const ACCOUNTING_EXPORT = 'accounting.export' satisfies Permission
export const ACCOUNTING_LOCK = 'accounting.lock' satisfies Permission
export const ACCOUNTING_UNLOCK = 'accounting.unlock' satisfies Permission

export const ACCOUNTING_PERMISSIONS: readonly Permission[] = Object.freeze([ACCOUNTING_VIEW, ACCOUNTING_EXPORT, ACCOUNTING_LOCK, ACCOUNTING_UNLOCK])
