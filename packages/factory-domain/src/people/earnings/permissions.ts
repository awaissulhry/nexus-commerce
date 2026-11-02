import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'

/**
 * Earnings and pay periods (B-W2b-43; apps/factory-api modules/people/earnings; MES-256, MES-260, MES-261, MES-264, MES-304;
 * design people.piecerates "Pay periods", "Earnings ledger", "Held scans", pop-ups "Worker statement", "Lock period",
 * "Resolve held scan"; people.reports "Earnings report"; c.c. arts. 2100-2101), in the people area. Each is checked with
 * can() against the record's company and site. A pay figure carries the pay grain (`money.pay`): HR and the worker. "The
 * right" to one person's figures is people.earnings.records AND the pay grain, together.
 *
 *   people.earnings.view     the pay periods with their states, checks and counts, the figures per line (groups under the
 *                            company's minimum hidden; with the pay grain only), the held scans with no name (administrator,
 *                            production manager, floor supervisor; owner and read-only through the registry)
 *   people.earnings.records  one person's statement and earnings lines, the ledger, the report per worker. `write` on
 *                            purpose, so read-only never holds it; each opening of one person is recorded. No template
 *                            lists it: HR (a custom role with the pay grain), and the Owner through every office permission.
 *   people.earnings.manage   runs a period, starts and takes back its review, locks it, decides held scans, approves
 *                            statements, corrects an entry, types an adjustment. No template lists it, for the same reason.
 *   people.earnings.review   a lead's review of one person's statement: pieces and minutes, never money, and only where
 *                            the site's legal gate lets leads see them (floor supervisor, production manager).
 */
export const PEOPLE_EARNINGS_DEFINITIONS = definePermissions('people', {
  'earnings.view': {
    risk: 'read',
    description:
      'See the pay periods of a company: their status, what still stands in the way, how many scans are held and how many statements are approved, and the figures per line. Pay figures only with the pay grain; never one person.',
  },
  'earnings.records': {
    risk: 'write',
    description:
      "Open one person's statement and earnings lines, read the earnings ledger and the report per worker. Asks for the pay grain too, and each opening is recorded.",
  },
  'earnings.manage': {
    risk: 'write',
    description:
      'Run a pay period, start and take back its review, lock it, decide held scans, approve statements, correct an earnings entry with a reason (a correction is always a new entry) and type an adjustment.',
  },
  'earnings.review': {
    risk: 'write',
    description:
      "Review a statement as the person's lead before HR approves it: pieces and minutes, never money, and only where the site's legal basis lets leads see one person's figures.",
  },
})

export const PEOPLE_EARNINGS_VIEW = 'people.earnings.view' satisfies Permission
export const PEOPLE_EARNINGS_RECORDS = 'people.earnings.records' satisfies Permission
export const PEOPLE_EARNINGS_MANAGE = 'people.earnings.manage' satisfies Permission
export const PEOPLE_EARNINGS_REVIEW = 'people.earnings.review' satisfies Permission

export const PEOPLE_EARNINGS_PERMISSIONS: readonly Permission[] = Object.freeze([PEOPLE_EARNINGS_VIEW, PEOPLE_EARNINGS_RECORDS, PEOPLE_EARNINGS_MANAGE, PEOPLE_EARNINGS_REVIEW])
