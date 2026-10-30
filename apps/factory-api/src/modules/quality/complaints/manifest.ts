import { defineManifest } from '../../../core/manifest'

/**
 * Customer complaints (B-W2a-65; SAL-416, QHS-113, QHS-115; design quality.complaints). Office only; handlers check each
 * complaint with can() over its company and customer (`record`). Editing a complaint's facts takes `log` while it is new
 * and `manage` once triaged (the handler checks the second); adding one to the PPE register also needs
 * compliance.register.manage (the handler checks it).
 */
const view = { audiences: ['office'], permission: 'quality.complaints.view', scope: 'record' } as const
const log = { audiences: ['office'], permission: 'quality.complaints.log', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'quality.complaints.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /quality/complaints': view,
  'GET /quality/complaints/counts': view,
  'GET /quality/complaints/people': view,
  'POST /quality/complaints/preview': log,
  'POST /quality/complaints': log,
  'GET /quality/complaints/:complaintId': view,
  'PATCH /quality/complaints/:complaintId': log,
  'POST /quality/complaints/:complaintId/triage': manage,
  'POST /quality/complaints/:complaintId/acknowledge': { audiences: ['office'], permission: 'quality.complaints.acknowledge', scope: 'record' },
  'POST /quality/complaints/:complaintId/status': manage,
  'POST /quality/complaints/:complaintId/close': manage,
  'POST /quality/complaints/:complaintId/register': manage,
})
