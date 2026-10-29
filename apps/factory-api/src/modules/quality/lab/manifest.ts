import { defineManifest } from '../../../core/manifest'

/**
 * The lab step for incoming lots (B-W1-34; QHS-029, QHS-030, SCM-117, QHS-073; A2 SCR-054 Tests & substances, SCR-075
 * Lot release): the office only (a floor device never releases a lot). Handlers check each lot with can() over its
 * company and site (`record`); the settings over the company (tenant-wide: a grant over every company to save).
 */
export const manifest = defineManifest({
  'GET /quality/lots/:lotId': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'GET /quality/lots/:lotId/release-check': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'GET /quality/lots/:lotId/results': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'POST /quality/lots/:lotId/results/report': { audiences: ['office'], permission: 'quality.lots.test', scope: 'record' },
  'POST /quality/lots/:lotId/results': { audiences: ['office'], permission: 'quality.lots.test', scope: 'record' },
  'GET /quality/lots/:lotId/documents': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'POST /quality/lots/:lotId/documents/upload': { audiences: ['office'], permission: 'quality.lots.documents', scope: 'record' },
  'POST /quality/lots/:lotId/documents': { audiences: ['office'], permission: 'quality.lots.documents', scope: 'record' },
  'POST /quality/lots/:lotId/release': { audiences: ['office'], permission: 'quality.lots.release', scope: 'record' },
  'POST /quality/lots/:lotId/unblock': { audiences: ['office'], permission: 'quality.lots.release', scope: 'record' },
  'POST /quality/lots/:lotId/hold/clear': { audiences: ['office'], permission: 'quality.lots.release', scope: 'record' },
  'POST /quality/lots/:lotId/reject': { audiences: ['office'], permission: 'quality.lots.reject', scope: 'record' },
  'POST /quality/lots/:lotId/block': { audiences: ['office'], permission: 'quality.lots.reject', scope: 'record' },
  'GET /quality/settings': { audiences: ['office'], permission: 'quality.lots.view', scope: 'record' },
  'PUT /quality/settings': { audiences: ['office'], permission: 'quality.settings.manage', scope: 'record' },
})
