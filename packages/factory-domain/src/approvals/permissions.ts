import type { Permission } from '../core/permissions'
import { definePermissions } from '../auth/permissions/registry'

/**
 * One approval engine (apps/factory-api platform/approvals; B-W2b-282; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105;
 * design home.approvals, admin.automation "Approval rules"). Office only. A request is also behind its record's own view
 * permission (its kind's: a purchase order's needs purchasing.view over its company), so these never widen what a person
 * sees; a person always sees the requests they asked and those addressed to them.
 *
 *   view           see the requests for a yes one asked, those waiting for one, those of the records one may see, the
 *                  approval history of a record, and the approval rules
 *   request        ask for a yes on a record one may change (its kind's own permission too) and take one's request back
 *   decide         approve (with a comment; signed where the rule asks, with a fresh step-up) or reject (a reason and
 *                  words) a request addressed to one, or to a role one holds over its company; never one's own request
 *   rules.manage   write the approval rules: when a request needs a yes and from whom, the meaning of the signature, the
 *                  step-up, the time to decide; switch a rule on or off (every rule is written off)
 *
 * Four eyes are two people, never two permissions: whoever asked (or wrote) a request never decides it, the Owner included
 * (Owner answer Q3 = A): the engine refuses it in words and the database refuses it for every login.
 */
export const APPROVALS_DEFINITIONS = definePermissions('approvals', {
  view: {
    risk: 'read',
    description: 'See the requests for a yes you asked, those waiting for you, those of the records you can see, the approval history of a record, and the approval rules.',
  },
  request: {
    risk: 'write',
    description: 'Ask for a yes on a record you may change (its own permission is checked too) and take your own request back.',
  },
  decide: {
    risk: 'write',
    description: 'Approve (with a comment; signed with its meaning and a fresh code where the rule asks) or reject (with a reason and words) a request addressed to you or to a role you hold. Never your own request.',
  },
  'rules.manage': {
    risk: 'write',
    description: 'Write the approval rules: when a request needs a yes and from whom, what the signature means, whether it asks a fresh code and how long the approver has; switch a rule on or off.',
  },
})

export const APPROVALS_VIEW = 'approvals.view' satisfies Permission
export const APPROVALS_REQUEST = 'approvals.request' satisfies Permission
export const APPROVALS_DECIDE = 'approvals.decide' satisfies Permission
export const APPROVALS_RULES_MANAGE = 'approvals.rules.manage' satisfies Permission

export const APPROVALS_PERMISSIONS: readonly Permission[] = Object.freeze([APPROVALS_VIEW, APPROVALS_REQUEST, APPROVALS_DECIDE, APPROVALS_RULES_MANAGE])

const WORKS = [APPROVALS_VIEW, APPROVALS_REQUEST, APPROVALS_DECIDE] as const

/**
 * Who holds them (auth/roles/templates; the owner from every(), read-only reads them): every office template whose people
 * ask for a yes or may be named to give one; the administrator also keeps the rules (design admin.automation). A rule names
 * a role or a person; holding approvals.decide alone gives no request.
 */
export const APPROVALS_ADDS: Readonly<Record<string, readonly Permission[]>> = Object.freeze({
  admin: [...WORKS, APPROVALS_RULES_MANAGE],
  finance: WORKS,
  sales: WORKS,
  planner: WORKS,
  buyer: WORKS,
  warehouse: WORKS,
  production_manager: WORKS,
  quality_inspector: WORKS,
  floor_supervisor: WORKS,
  maintenance: WORKS,
  hr: WORKS,
  safety_officer: WORKS,
})
