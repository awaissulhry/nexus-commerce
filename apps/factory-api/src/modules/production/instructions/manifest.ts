import { defineManifest } from '../../../core/manifest'

/**
 * Work instructions (B-W2b-214; PRD-117, PRD-258, MES-110, MES-119; design production.instructions SCR-141, floor.instructions
 * SCR-174). An instruction is a company's: office handlers check each with can() over its company (`record`). Reading needs
 * production.instructions.view; writing .manage; approving another person's draft .approve; a training record by name and a
 * paper acknowledgement .people. The floor reads the instruction of the operation in hand and the frozen spec of its work
 * order, and says Seen, with the scans' right at the device's own site (row-level security keeps a device to its site and
 * to published versions).
 */
export const manifest = defineManifest({
  'GET /production/instructions': { audiences: ['office'], permission: 'production.instructions.view', scope: 'record' },
  'POST /production/instructions': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'GET /production/instructions/typed-steps': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'POST /production/instructions/typed-steps': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'GET /production/instructions/:instructionId': { audiences: ['office'], permission: 'production.instructions.view', scope: 'record' },
  'POST /production/instructions/:instructionId/archive': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'POST /production/instructions/:instructionId/restore': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'POST /production/instructions/:instructionId/versions': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'GET /production/instructions/:instructionId/versions/:versionId': { audiences: ['office'], permission: 'production.instructions.view', scope: 'record' },
  'PUT /production/instructions/:instructionId/versions/:versionId': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'POST /production/instructions/:instructionId/versions/:versionId/publish': { audiences: ['office'], permission: 'production.instructions.approve', scope: 'record' },
  'POST /production/instructions/:instructionId/versions/:versionId/discard': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'GET /production/instructions/:instructionId/versions/:versionId/sheet': { audiences: ['office'], permission: 'production.instructions.view', scope: 'record' },
  'POST /production/instructions/:instructionId/files': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'POST /production/instructions/:instructionId/files/:fileId/complete': { audiences: ['office'], permission: 'production.instructions.manage', scope: 'record' },
  'GET /production/instructions/:instructionId/acknowledgements': { audiences: ['office'], permission: 'production.instructions.view', scope: 'record' },
  'POST /production/instructions/:instructionId/versions/:versionId/acknowledgements': { audiences: ['office'], permission: 'production.instructions.people', scope: 'record' },
  'GET /production/instructions/floor/operation': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/instructions/floor/spec': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'POST /production/instructions/floor/seen': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/instructions/floor/mine': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
  'GET /production/instructions/floor/media/:mediaId/download': { audiences: ['floor'], permission: 'production.scan', scope: 'record' },
})
