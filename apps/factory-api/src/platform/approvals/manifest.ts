import { defineManifest } from '../../core/manifest'

/**
 * One approval engine (B-W2b-282; PLT-042, PLT-086, PLT-091, PLT-093, PLT-104, PLT-105; design home.approvals,
 * admin.automation "Approval rules"). Office only. Reading is approvals.view, each request also behind its subject's own
 * view permission unless the reader asked it or it is addressed to them, each history behind its record's own view
 * permission (`record`: the handlers check it); asking and taking one's request back is approvals.request (and the kind's
 * own permission over the subject); deciding is approvals.decide, only for the request's approver, never the person who
 * asked it; keeping the rules is approvals.rules.manage over the rule's company.
 */
const view = { audiences: ['office'], permission: 'approvals.view', scope: 'record' } as const
const request = { audiences: ['office'], permission: 'approvals.request', scope: 'record' } as const
const decide = { audiences: ['office'], permission: 'approvals.decide', scope: 'record' } as const
const rules = { audiences: ['office'], permission: 'approvals.rules.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /approvals/kinds': view,
  'GET /approvals/rules': view,
  'POST /approvals/rules': rules,
  'POST /approvals/rules/test': rules,
  'GET /approvals/rules/:id': view,
  'PUT /approvals/rules/:id': rules,
  'GET /approvals/tasks': view,
  'GET /approvals/tasks/:id': view,
  'POST /approvals/tasks/:id/approve': decide,
  'POST /approvals/tasks/:id/reject': decide,
  'POST /approvals/tasks/:id/withdraw': request,
  'POST /approvals/requests': request,
  'GET /approvals/history/:recordType/:recordId': view,
})
