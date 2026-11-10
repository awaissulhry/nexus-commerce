import type { Permission } from '../../core/permissions'
import { definePermissions } from '../../auth/permissions/registry'
import { REGISTER_VIEW } from '../register/permissions'

/**
 * Recall, withdrawal and authority (B-W2b-260; PRD-387, PRD-388, PRD-390; design compliance.register, SCR-113 W2b parts;
 * Reg. (EU) 2016/425 art. 8(4), 8(8), 8(9); Reg. (EU) 2019/1020 art. 4(3); Reg. (EU) 2023/988 art. 35-36). Office only (area
 * `compliance`). Reading the authority notices, the recalls and withdrawals with their progress, the distributors told and
 * the authority requests reuses the PPE register's view permission (the same people read the entries they hang on). Checked
 * with can() against the record's company (and, for what hangs on a register entry, the party that reported the entry).
 *
 *   recall.manage  draft and keep what follows a register entry: the notice to a market surveillance authority (its words
 *                  per language, cancelled while a draft), a recall or a withdrawal (its scope from the trace, holds on
 *                  what is still here, progress per customer, close, cancel, the public notice taken down), the notices
 *                  to distributors (drafted per recipient, their answer or failure recorded), and the authority requests
 *                  (logged with what is asked and by when, answered with the evidence sent, a register entry opened).
 *   recall.send    speak for the company outward, with a fresh code (step-up): mark an authority notice as sent (a
 *                  person sends it; nothing goes to an authority by itself), send the drafted notices to distributors
 *                  (e-mail through the outbox; a call or a portal message recorded), publish a recall's public notice
 *                  (first on the public DoC page).
 *
 * The quality inspector holds both; the owner from every().
 */
export const RECALL_DEFINITIONS = definePermissions('compliance', {
  'recall.manage': {
    risk: 'write',
    description:
      'Draft and keep what follows a PPE register entry: notices to market surveillance authorities, recalls and withdrawals (scope from the trace, holds on what is still here, progress per customer, close), notices to distributors with their answers, and the authority requests with the evidence sent.',
  },
  'recall.send': {
    risk: 'stepUp',
    description: "Speak for the company outward with a fresh code: mark an authority notice as sent, send the notices to distributors, and publish a recall's public notice on the public DoC page.",
  },
})

/** Reading: the PPE register's view permission. */
export const RECALL_VIEW: Permission = REGISTER_VIEW
export const RECALL_MANAGE = 'compliance.recall.manage' satisfies Permission
export const RECALL_SEND = 'compliance.recall.send' satisfies Permission

export const RECALL_PERMISSIONS: readonly Permission[] = Object.freeze([RECALL_MANAGE, RECALL_SEND])

/** Who holds them (auth/roles/templates): the quality inspector, beside compliance.register.manage. */
export const RECALL_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  quality_inspector: [RECALL_MANAGE, RECALL_SEND],
})
