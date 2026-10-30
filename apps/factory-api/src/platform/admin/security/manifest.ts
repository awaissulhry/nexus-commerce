import { defineManifest, SIGNED_IN } from '../../../core/manifest'

/**
 * Security & health (B-W2a-36; PLT-045, PLT-214; SCR-166). Tenant-wide: the page is about the whole group. The two-factor
 * rule of a role is roles.manage (a step-up permission: the handler asks for a fresh code); its read and its preview are
 * roles.view. Recording a restore drill is security.drills.record; its evidence file also needs files.upload (platform
 * files' own check). All settings › Needs attention is any office session: each row is read only where the person holds
 * its own view permission (`record`: the handler filters).
 */
export const manifest = defineManifest({
  'GET /admin/security': { audiences: ['office'], permission: 'security.view', scope: 'tenant' },
  'GET /admin/security/two-factor': { audiences: ['office'], permission: 'roles.view', scope: 'tenant' },
  'POST /admin/security/two-factor/preview': { audiences: ['office'], permission: 'roles.view', scope: 'tenant' },
  'POST /admin/security/two-factor': { audiences: ['office'], permission: 'roles.manage', scope: 'tenant' },
  'GET /admin/security/fingerprint': { audiences: ['office'], permission: 'security.drills.record', scope: 'tenant' },
  'GET /admin/security/drills': { audiences: ['office'], permission: 'security.view', scope: 'tenant' },
  'POST /admin/security/drills/evidence': { audiences: ['office'], permission: 'security.drills.record', scope: 'tenant' },
  'POST /admin/security/drills/evidence/:fileId/complete': { audiences: ['office'], permission: 'security.drills.record', scope: 'tenant' },
  'POST /admin/security/drills': { audiences: ['office'], permission: 'security.drills.record', scope: 'tenant' },
  'GET /admin/security/attention': { audiences: ['office'], permission: SIGNED_IN, scope: 'record' },
})
