import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * B-PR-45 — the issues that need an answer, the office's list (production plan §5 Customer card, Overview; L24; R-42). Office
 * only: a floor, portal or link session is refused by audience (issues are office only, PW-15). The handler checks
 * workorders.view (every issue) or orders.view (the issues on a sales order) over each issue's company, site and customer
 * (./list.ts: the brand wall). The customer's "Report a problem" is a portal route of ../brand-portal; the escalation a cron
 * (./escalate.ts); raising (B-PR-43b, ./raise.ts) and answering (./answered.ts) have no route of their own.
 */
export const manifest = defineManifest({
  'GET /production/issues': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
