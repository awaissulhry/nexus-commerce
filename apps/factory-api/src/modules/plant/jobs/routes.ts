import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  assignJobsContract,
  cancelJobContract,
  closeJobContract,
  createJobContract,
  handBackContract,
  jobCountsContract,
  jobRecordContract,
  listJobsContract,
  planJobContract,
  reopenJobContract,
  startJobContract,
  updateJobContract,
  waitJobContract,
} from '../contract'
import { assignJobs, createJob, jobCounts, jobRecord, listJobs, moveJob, updateJob } from './jobs'
import { manifest } from './manifest'

/**
 * Maintenance jobs (B-W2a-35; ./jobs.ts). Each write is one command with an Idempotency-Key; a repeated key answers from
 * its receipt.
 */
export default defineRoutes('plant.jobs', manifest, async (app) => {
  app.get('/plant/jobs', { schema: listJobsContract }, async (request) => listJobs(request, request.query))

  app.get('/plant/jobs/counts', { schema: jobCountsContract }, async (request) => jobCounts(request, request.query))

  app.get('/plant/jobs/:jobId', { schema: jobRecordContract }, async (request) => jobRecord(request, request.params.jobId))

  app.post('/plant/jobs', { schema: createJobContract }, async (request, reply) => {
    const answer = await createJob(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })

  app.patch('/plant/jobs/:jobId', { schema: updateJobContract }, async (request) => updateJob(request, request.params.jobId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/jobs/assign', { schema: assignJobsContract }, async (request) => assignJobs(request, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/jobs/:jobId/plan', { schema: planJobContract }, async (request) => moveJob(request, request.params.jobId, 'plan', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/start', { schema: startJobContract }, async (request) => moveJob(request, request.params.jobId, 'start', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/wait', { schema: waitJobContract }, async (request) => moveJob(request, request.params.jobId, 'wait', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/hand-back', { schema: handBackContract }, async (request) => moveJob(request, request.params.jobId, 'handBack', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/reopen', { schema: reopenJobContract }, async (request) => moveJob(request, request.params.jobId, 'reopen', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/close', { schema: closeJobContract }, async (request) => moveJob(request, request.params.jobId, 'close', request.body, idempotencyKeyFrom(request)))
  app.post('/plant/jobs/:jobId/cancel', { schema: cancelJobContract }, async (request) => moveJob(request, request.params.jobId, 'cancel', request.body, idempotencyKeyFrom(request)))
})
