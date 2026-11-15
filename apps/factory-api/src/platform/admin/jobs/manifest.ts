import { defineManifest } from '../../../core/manifest'

/**
 * Admin › Security › Jobs and integrations (B-W2b-415; PLT-221; SCR-166 section `jobs`). Tenant-wide like the page: the
 * jobs and their runs are read with security.view; Run now is security.jobs.run (not step-up: an early run of a job that
 * checks or catches up widens nobody's rights).
 */
export const manifest = defineManifest({
  'GET /admin/jobs': { audiences: ['office'], permission: 'security.view', scope: 'tenant' },
  'GET /admin/jobs/:jobKey/runs': { audiences: ['office'], permission: 'security.view', scope: 'tenant' },
  'POST /admin/jobs/:jobKey/run': { audiences: ['office'], permission: 'security.jobs.run', scope: 'tenant' },
})
