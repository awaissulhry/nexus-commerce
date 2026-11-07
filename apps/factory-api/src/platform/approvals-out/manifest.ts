import { defineManifest } from '../../core/manifest'

/**
 * Approval requests to partners (B-W2b-184; COL-064, SAL-222, SAL-294, PLT-089). Office routes check each request and record
 * with can() (partners.approvals.* AND the record's own permission, ./records.ts); the link routes serve the APPROVAL link's
 * own request; the portal routes the session's party (row-level security), an answer also portal.approve (handler).
 */
export const manifest = defineManifest({
  'POST /approvals-out': { audiences: ['office'], permission: 'partners.approvals.ask', scope: 'record' },
  'GET /approvals-out': { audiences: ['office'], permission: 'partners.approvals.view', scope: 'record' },
  'GET /approvals-out/:requestId': { audiences: ['office'], permission: 'partners.approvals.view', scope: 'record' },
  'POST /approvals-out/:requestId/withdraw': { audiences: ['office'], permission: 'partners.approvals.ask', scope: 'record' },
  'GET /link/approval': { audiences: ['link'], permission: 'links.open', scope: 'record' },
  'POST /link/approval/approve': { audiences: ['link'], permission: 'links.approve', scope: 'record' },
  'POST /link/approval/refuse': { audiences: ['link'], permission: 'links.refuse', scope: 'record' },
  'GET /portal/approvals': { audiences: ['partner'], permission: 'portal.approvals.view', scope: 'party' },
  'GET /portal/approvals/:requestId': { audiences: ['partner'], permission: 'portal.approvals.view', scope: 'party' },
  'POST /portal/approvals/:requestId/answer': { audiences: ['partner'], permission: 'portal.approvals.view', scope: 'party' },
  // PLT-089: approve from e-mail (the person's own switch, and the mailed link opened after the office sign-in).
  'GET /approvals/mail-me': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'PUT /approvals/mail-me': { audiences: ['office'], permission: 'home.view', scope: 'record' },
  'POST /approvals/mail-open': { audiences: ['office'], permission: 'home.view', scope: 'record' },
})
