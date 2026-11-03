import { defineManifest } from '../../../core/manifest'

/**
 * Corrective actions, CAPA and 8D (B-W2b-108; QHS-087, QHS-093, QHS-094, QHS-096; design quality.capa SCR-146 and ncr-capa).
 * Office only; handlers check each CAPA with can() over its company and customer (`record`). Escalating an NCR also needs
 * quality.ncr.manage at its site; recording an action done takes quality.capa.view for the action's own owner, manage for
 * anyone else (both checked in the handlers).
 */
const view = { audiences: ['office'], permission: 'quality.capa.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'quality.capa.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /quality/capa': view,
  'GET /quality/capa/counts': view,
  'GET /quality/capa/people': view,
  'GET /quality/capa/escalate': view,
  'POST /quality/capa': manage,
  'GET /quality/capa/:capaId': view,
  'PATCH /quality/capa/:capaId': manage,
  'POST /quality/capa/:capaId/stage': manage,
  'POST /quality/capa/:capaId/close': manage,
  'POST /quality/capa/:capaId/cancel': manage,
  'POST /quality/capa/:capaId/sources': manage,
  'DELETE /quality/capa/:capaId/sources/:sourceId': manage,
  'POST /quality/capa/:capaId/actions': manage,
  'PATCH /quality/capa/:capaId/actions/:actionId': manage,
  'POST /quality/capa/:capaId/actions/:actionId/done': view,
  'POST /quality/capa/:capaId/actions/:actionId/cancel': manage,
  'POST /quality/capa/:capaId/actions/:actionId/remind': manage,
  'GET /quality/capa/:capaId/report': view,
  'POST /quality/capa/:capaId/report': manage,
})
