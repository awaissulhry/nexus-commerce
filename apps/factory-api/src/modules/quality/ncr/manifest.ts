import { defineManifest } from '../../../core/manifest'

/**
 * Nonconformances (B-W2a-47; QHS-080 … QHS-091; design quality.ncr SCR-144 list and board, SCR-145 record): the office
 * only (the floor holds goods at the bench; the office raises the NCR and numbers it). Handlers check each NCR with
 * can() over its company and site (`record`): who finds a problem raises it (quality.ncr.raise), quality follows it up
 * (quality.ncr.manage), another person approves a decision that needs it (quality.ncr.approve), closing is an
 * e-signature with the office's step-up (quality.ncr.close).
 */
export const manifest = defineManifest({
  'GET /quality/ncr': { audiences: ['office'], permission: 'quality.ncr.view', scope: 'record' },
  'GET /quality/ncr/counts': { audiences: ['office'], permission: 'quality.ncr.view', scope: 'record' },
  'GET /quality/ncr/board': { audiences: ['office'], permission: 'quality.ncr.view', scope: 'record' },
  'GET /quality/ncr/prefill': { audiences: ['office'], permission: 'quality.ncr.raise', scope: 'record' },
  'POST /quality/ncr': { audiences: ['office'], permission: 'quality.ncr.raise', scope: 'record' },
  'GET /quality/ncr/:ncrId': { audiences: ['office'], permission: 'quality.ncr.view', scope: 'record' },
  'PATCH /quality/ncr/:ncrId': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/stage': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/close': { audiences: ['office'], permission: 'quality.ncr.close', scope: 'record' },
  'POST /quality/ncr/:ncrId/cancel': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/links': { audiences: ['office'], permission: 'quality.ncr.raise', scope: 'record' },
  'DELETE /quality/ncr/:ncrId/links/:linkId': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/register': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/holds/:holdId/close': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/containment': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'PATCH /quality/ncr/:ncrId/containment/:actionId': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/containment/:actionId/done': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/containment/:actionId/cancel': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/decisions': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'PATCH /quality/ncr/:ncrId/decisions/:decisionId': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'DELETE /quality/ncr/:ncrId/decisions/:decisionId': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/decisions/:decisionId/approve': { audiences: ['office'], permission: 'quality.ncr.approve', scope: 'record' },
  'POST /quality/ncr/:ncrId/decisions/:decisionId/carry-out': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
  'POST /quality/ncr/:ncrId/decisions/:decisionId/rework': { audiences: ['office'], permission: 'quality.ncr.manage', scope: 'record' },
})
