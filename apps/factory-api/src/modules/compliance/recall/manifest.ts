import { defineManifest } from '../../../core/manifest'

/**
 * Recall, withdrawal and authority (B-W2b-260; PRD-387, PRD-388, PRD-390; design compliance.register W2b parts). Office only.
 * Reading needs the PPE register's view permission; drafting and keeping notices, recalls, progress, distributor notices
 * and authority requests needs compliance.recall.manage; speaking for the company outward (an authority notice marked as
 * sent, the notices to distributors sent, a recall's public notice published) compliance.recall.send (step-up). Handlers
 * check each record with can() against its company and, for what hangs on an entry, the entry's reporting party (`record`).
 */
const view = { audiences: ['office'], permission: 'compliance.register.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'compliance.recall.manage', scope: 'record' } as const
const send = { audiences: ['office'], permission: 'compliance.recall.send', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /compliance/register/:entryId/surveillance': view,
  'GET /compliance/register/:entryId/distributors': view,
  'POST /compliance/register/:entryId/authority-notices': manage,
  'POST /compliance/register/:entryId/recalls': manage,
  'POST /compliance/register/:entryId/distributor-notices': manage,
  'POST /compliance/register/:entryId/distributor-notices/send': send,

  'GET /compliance/authority-notices': view,
  'GET /compliance/authority-notices/:noticeId': view,
  'GET /compliance/authority-notices/:noticeId/pdf': view,
  'PATCH /compliance/authority-notices/:noticeId': manage,
  'POST /compliance/authority-notices/:noticeId/sent': send,
  'POST /compliance/authority-notices/:noticeId/reference': manage,
  'POST /compliance/authority-notices/:noticeId/cancel': manage,

  'GET /compliance/recalls': view,
  'GET /compliance/recalls/:recallId': view,
  'PATCH /compliance/recalls/:recallId': manage,
  'POST /compliance/recalls/:recallId/start': manage,
  'POST /compliance/recalls/:recallId/holds': manage,
  'POST /compliance/recalls/:recallId/notice/publish': send,
  'POST /compliance/recalls/:recallId/notice/withdraw': manage,
  'POST /compliance/recalls/:recallId/progress': manage,
  'PATCH /compliance/recalls/:recallId/progress/:progressId': manage,
  'POST /compliance/recalls/:recallId/close': manage,
  'POST /compliance/recalls/:recallId/cancel': manage,

  'PATCH /compliance/distributor-notices/:noticeId': manage,
  'POST /compliance/distributor-notices/:noticeId/answer': manage,
  'POST /compliance/distributor-notices/:noticeId/failed': manage,
  'POST /compliance/distributor-notices/:noticeId/cancel': manage,

  'GET /compliance/authority-requests': view,
  'POST /compliance/authority-requests': manage,
  'GET /compliance/authority-requests/:requestId': view,
  'PATCH /compliance/authority-requests/:requestId': manage,
  'POST /compliance/authority-requests/:requestId/register-entry': manage,
  'POST /compliance/authority-requests/:requestId/evidence': manage,
  'POST /compliance/authority-requests/:requestId/answer': manage,
  'POST /compliance/authority-requests/:requestId/cancel': manage,
})
