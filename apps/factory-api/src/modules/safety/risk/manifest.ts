import { defineManifest } from '../../../core/manifest'

/**
 * The risk assessment, the DVR (B-W2b-122; QHS-230, QHS-234; design plant.risk). Office only; safety.view reads,
 * safety.risk.manage keeps the assessments, the versions, the signed papers, the seal and the improvement plan,
 * safety.risk.sign is the signer's own act (step-up). Moving a measure takes safety.view: its owner moves their own, a
 * manager any (checked in the handler). Handlers check each record with can() against its company and site (`record`).
 */
const view = { audiences: ['office'], permission: 'safety.view', scope: 'record' } as const
const manage = { audiences: ['office'], permission: 'safety.risk.manage', scope: 'record' } as const

export const manifest = defineManifest({
  'GET /safety/risk/assessments': view,
  'GET /safety/risk/counts': view,
  'GET /safety/risk/assessments/:assessmentId': view,
  'POST /safety/risk/assessments': manage,
  'PATCH /safety/risk/assessments/:assessmentId': manage,
  'POST /safety/risk/assessments/:assessmentId/versions': manage,
  'POST /safety/risk/versions/:versionId/withdraw': manage,
  'POST /safety/risk/versions/:versionId/sign': { audiences: ['office'], permission: 'safety.risk.sign', scope: 'record' },
  'POST /safety/risk/versions/:versionId/signatures': manage,
  'GET /safety/risk/versions/:versionId/seal': view,
  'POST /safety/risk/versions/:versionId/seal': manage,
  'GET /safety/risk/measures': view,
  'GET /safety/risk/measures/:measureId': view,
  'GET /safety/risk/owners': manage,
  'POST /safety/risk/measures': manage,
  'PATCH /safety/risk/measures/:measureId': manage,
  'POST /safety/risk/measures/:measureId/status': view,
})
