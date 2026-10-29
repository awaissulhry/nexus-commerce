import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * The purchasing module's permissions (apps/factory-api modules/purchasing; B-W1-30; SCM-050, SCM-053, SCM-054, SCM-055,
 * SCM-075; A2 SCR-058 "Purchase orders", SCR-059 the record, SCR-037 the send dialog, SCR-055 "Draft PO" from What to buy
 * & make). Each is checked with can() against the order's company, delivery site AND supplier, so a role limited to some
 * suppliers or sites reaches only theirs. Office only: no floor, portal or link route (the supplier's confirm link is
 * B-W1-31's; receiving is B-W1-32's).
 *
 *   view     the list and the record: header, lines (leather specs, Cr VI flag, the supplier's confirmation), the send
 *            checks, the PDFs, links and mails; purchase prices only with the cost grain (money.cost)
 *   manage   create a purchase order, edit its header and lines while it is a draft, draft orders from the plan's lines
 *            (and undo that), cancel a draft
 *   send     send a draft to the supplier: its PDF stored, a one-off confirm link mailed with it on the order's thread;
 *            send a new link; cancel an order already sent (the supplier is told). No step-up.
 *
 * PO approval (SCM-078, a limit and an approver) is W2b: in W1 the buyer who may send places the order.
 */
export const PURCHASING_DEFINITIONS = definePermissions('purchasing', {
  view: { risk: 'read', description: 'See purchase orders: lines with their leather specs, what stops a send, the PDFs, confirm links and mails (purchase prices only with the cost grain).' },
  manage: { risk: 'write', description: "Make and edit draft purchase orders, draft them from the plan's lines to buy (and undo that), cancel a draft." },
  send: { risk: 'write', description: 'Send a purchase order to its supplier (PDF and a one-off confirm link by mail), send a new link, cancel an order already sent.' },
})

export const PURCHASING_VIEW = 'purchasing.view' satisfies Permission
export const PURCHASING_MANAGE = 'purchasing.manage' satisfies Permission
export const PURCHASING_SEND = 'purchasing.send' satisfies Permission
export const PURCHASING_PERMISSIONS: readonly Permission[] = Object.freeze([PURCHASING_VIEW, PURCHASING_MANAGE, PURCHASING_SEND])
