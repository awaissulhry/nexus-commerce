import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { listJobsContract, listRunsContract, runNowContract } from './contract'
import { listJobs, listRuns, runNow } from './jobs'
import { manifest } from './manifest'

/**
 * Jobs and integrations (B-W2b-415; PLT-221):
 *   GET  /admin/jobs                  every scheduled job: last run, result, next run, failures in 7 days, waiting, state
 *   GET  /admin/jobs/:jobKey/runs     one job's runs, newest first (the run history)
 *   POST /admin/jobs/:jobKey/run      Run now: once in the cluster, for this business only (held jobs answer 409 in words)
 */
export default defineRoutes('admin-jobs', manifest, async (app) => {
  app.get('/admin/jobs', { schema: listJobsContract }, async (request) => listJobs(request))
  app.get('/admin/jobs/:jobKey/runs', { schema: listRunsContract }, async (request) => listRuns(request, request.params.jobKey, { before: request.query.before, limit: request.query.limit }))
  app.post('/admin/jobs/:jobKey/run', { schema: runNowContract }, async (request) => runNow(request, request.params.jobKey, idempotencyKeyFrom(request)))
})
