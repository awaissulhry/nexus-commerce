import { defineManifest, PUBLIC, SIGNED_IN } from '../../core/manifest'

/**
 * The privacy pack (B-W1-36; A2 SCR-025, SCR-086, SCR-028). Office routes are scoped by record: each handler checks the
 * company of the notice, DPIA or activity with can() (privacy.view to know it exists, then the route's permission) and
 * filters lists with scopeWhere(); publishing a notice and storing a DPIA also ask for a fresh code (step-up) inside the
 * handler. Every signed-in office person reads and acknowledges their company's staff notice; every floor worker
 * (floor.work) the worker notice of the device's company. The public notice is for anyone.
 */
export const manifest = defineManifest({
  'GET /privacy/overview': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'GET /privacy/notices': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'GET /privacy/notices/:noticeId': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'POST /privacy/notices': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'PUT /privacy/notices/:noticeId/texts/:locale': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'DELETE /privacy/notices/:noticeId/texts/:locale': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/notices/:noticeId/texts/:locale/pdf': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/notices/:noticeId/texts/:locale/pdf/:fileId/complete': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/notices/:noticeId/publish': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'DELETE /privacy/notices/:noticeId': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'GET /privacy/notices/:noticeId/acknowledgements': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'POST /privacy/notices/:noticeId/paper-acknowledgements': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },

  'GET /privacy/dpia': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'POST /privacy/dpia': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/dpia/:dpiaId/pdf': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/dpia/:dpiaId/pdf/:fileId/complete': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/dpia/:dpiaId/store': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },

  'GET /privacy/register': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'POST /privacy/register': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'PATCH /privacy/register/:activityId': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
  'POST /privacy/register/:activityId/archive': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },

  'GET /privacy/staff-notice': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /privacy/staff-notice/acknowledge': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /privacy/floor/notice': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'POST /privacy/floor/notice/acknowledge': { audiences: ['floor'], permission: 'floor.work', scope: 'site' },
  'GET /privacy/public/:companyId': { audiences: PUBLIC, permission: PUBLIC, scope: 'none' },

  // B-W2b-405: data requests with their clock, the person's package, the erasure (requests/, erasure/); download my data; the
  // retention rules and their sweeps (retention/); the safety-report form's switch. Scoped by record: each handler checks the
  // request's or the rule's company (a rule of the whole group: the permission over every company).
  'GET /privacy/requests': { audiences: ['office'], permission: 'privacy.requests.view', scope: 'record' },
  'GET /privacy/requests/:requestId': { audiences: ['office'], permission: 'privacy.requests.view', scope: 'record' },
  'POST /privacy/requests': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/identity': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/extend': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/collect': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'GET /privacy/requests/:requestId/package': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/done': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/refuse': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'POST /privacy/requests/:requestId/withdraw': { audiences: ['office'], permission: 'privacy.requests.manage', scope: 'record' },
  'GET /privacy/requests/:requestId/erasure': { audiences: ['office'], permission: 'privacy.requests.view', scope: 'record' },
  'POST /privacy/requests/:requestId/erase': { audiences: ['office'], permission: 'privacy.erase', scope: 'record' },
  'GET /privacy/my-data': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'POST /privacy/my-data': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /privacy/my-data/:requestId/package': { audiences: ['office'], permission: SIGNED_IN, scope: 'tenant' },
  'GET /privacy/retention': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'GET /privacy/retention/rules/:ruleId/sweeps': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'POST /privacy/retention/rules': { audiences: ['office'], permission: 'privacy.retention.manage', scope: 'record' },
  'PATCH /privacy/retention/rules/:ruleId': { audiences: ['office'], permission: 'privacy.retention.manage', scope: 'record' },
  'POST /privacy/retention/rules/:ruleId/active': { audiences: ['office'], permission: 'privacy.retention.manage', scope: 'record' },
  'POST /privacy/retention/rules/:ruleId/apply': { audiences: ['office'], permission: 'privacy.retention.manage', scope: 'record' },
  'POST /privacy/retention/rules/:ruleId/sweep': { audiences: ['office'], permission: 'privacy.retention.manage', scope: 'record' },
  'GET /privacy/safety-report-form': { audiences: ['office'], permission: 'privacy.view', scope: 'record' },
  'PUT /privacy/safety-report-form': { audiences: ['office'], permission: 'privacy.manage', scope: 'record' },
})
