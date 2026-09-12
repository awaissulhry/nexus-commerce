import { Queue, Worker, UnrecoverableError, type Job, type JobsOptions, type BulkJobOptions, type WorkerOptions, type Processor } from 'bullmq'
import prisma from '../db.js'
import { createWorkspaceService } from '../services/workspace.service.js'
import { withWorkspace, workspaceContext, requireWorkspace, LEGACY_WORKSPACE_ID, type WorkspaceContext } from './workspace-context.js'

const ENVELOPE = '__nexusWorkspace'
export function scopeJobData<T>(data: T): T {
  const context = workspaceContext()
  if (!context && process.env.NEXUS_WORKSPACES_ENABLED !== '1') return data
  const scope = context ?? requireWorkspace()
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Workspace jobs require an object payload.')
  const { sessionId: _sessionId, ...authority } = scope
  return { ...data, [ENVELOPE]: { version: 1, ...authority } }
}

export async function runWorkspaceJob<T>(job: Pick<Job, 'data' | 'timestamp'>, work: () => Promise<T>): Promise<T> {
  if (process.env.NEXUS_WORKSPACES_ENABLED !== '1' && !job.data?.[ENVELOPE]) return work()
  let scope = job.data?.[ENVELOPE] as (WorkspaceContext & { version: number }) | undefined
  if (!scope) {
    const legacy = await prisma.workspace.findUnique({ where: { id: LEGACY_WORKSPACE_ID }, select: { createdAt: true, status: true } })
    if (!legacy || legacy.status !== 'active' || !job.timestamp || job.timestamp >= legacy.createdAt.getTime()) throw new UnrecoverableError('Job has no business profile. Queue it again from its profile.')
    scope = { version: 1, workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
  }
  if (scope.version !== 1 || typeof scope.workspaceId !== 'string' || !Array.isArray(scope.roleKeys)) throw new UnrecoverableError('Job has an invalid business profile.')
  const workspace = await prisma.workspace.findUnique({ where: { id: scope.workspaceId }, select: { status: true, automationResumedAt: true } })
  if (workspace?.status !== 'active') throw new UnrecoverableError('The job’s business profile is unavailable.')
  if (workspace.automationResumedAt && (!job.timestamp || job.timestamp <= workspace.automationResumedAt.getTime())) throw new UnrecoverableError('This job predates the profile’s restoration. Queue it again from the business profile.')
  if (scope.actorUserId) {
    try {
      const access = await createWorkspaceService(prisma).membership(scope.actorUserId, scope.workspaceId)
      if (access.id !== scope.membershipId || (scope.membershipVersion !== undefined && access.version !== scope.membershipVersion) || JSON.stringify([...access.roleKeys].sort()) !== JSON.stringify([...scope.roleKeys].sort())) throw new Error('Membership permissions changed.')
      return await withWorkspace(access.context, work)
    } catch (error) {
      // Only access errors are terminal; provider/processing failures keep their retry behavior.
      if ((error as { code?: string }).code === 'workspace_unavailable' || (error as Error).message === 'Membership permissions changed.') throw new UnrecoverableError('The membership that queued this job has changed. Queue it again from the business profile.')
      throw error
    }
  }
  if (scope.apiKeyId) {
    const key = await withWorkspace(scope, () => prisma.apiKey.findUnique({ where: { id: scope!.apiKeyId } }))
    if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date())) throw new UnrecoverableError('The API key that queued this job is unavailable.')
  }
  return withWorkspace(scope, work)
}

function jobOptions<T extends JobsOptions | BulkJobOptions>(options?: T): T | undefined {
  const id = workspaceContext()?.workspaceId
  if (!id) return options
  const prefix = `w_${id}_`
  return { ...options, ...(options?.jobId ? { jobId: options.jobId.startsWith(prefix) ? options.jobId : `${prefix}${options.jobId}` } : {}), ...(options?.deduplication ? { deduplication: { ...options.deduplication, id: `${prefix}${options.deduplication.id}` } } : {}) } as T
}
function belongs(job: Job | undefined | null, workspaceId: string): boolean {
  return !!job && (job.data?.[ENVELOPE]?.workspaceId === workspaceId || (!job.data?.[ENVELOPE] && workspaceId === LEGACY_WORKSPACE_ID))
}

/** Subclasses preserve BullMQ's own getter/receiver identity. */
export class WorkspaceQueue<Data = any, Result = any, Name extends string = string> extends Queue<Data, Result, Name, Data, Result, Name> {
  override add(name: Name, data: Data, options?: JobsOptions) { return super.add(name, scopeJobData(data), jobOptions(options)) }
  override addBulk(jobs: { name: Name; data: Data; opts?: BulkJobOptions }[]) { return super.addBulk(jobs.map(job => ({ ...job, data: scopeJobData(job.data), opts: jobOptions(job.opts) }))) }
  override async getJob(id: string) {
    const scope = workspaceContext()
    const prefixed = scope && !id.startsWith(`w_${scope.workspaceId}_`) ? `w_${scope.workspaceId}_${id}` : id
    let job = await super.getJob(prefixed)
    if (!job && prefixed !== id) job = await super.getJob(id)
    return !scope || belongs(job, scope.workspaceId) ? job : undefined
  }
  override async getJobs(types?: Parameters<Queue['getJobs']>[0], start = 0, end = -1, asc = false) {
    const scope = workspaceContext()
    if (!scope) return super.getJobs(types, start, end, asc)
    const found: Awaited<ReturnType<Queue<Data, Result, Name, Data, Result, Name>['getJobs']>> = []
    let offset = 0
    while (end < 0 || found.length <= end) {
      const batch = await super.getJobs(types, offset, offset + 499, asc)
      found.push(...batch.filter(job => belongs(job, scope.workspaceId)))
      if (batch.length < 500) break
      offset += 500
    }
    return found.slice(start, end < 0 ? undefined : end + 1)
  }
  override async getJobCounts(...types: Parameters<Queue['getJobCounts']>) {
    if (!workspaceContext()) return super.getJobCounts(...types)
    const statuses = types.length ? types : ['active', 'completed', 'delayed', 'failed', 'paused', 'waiting', 'waiting-children'] as const
    const entries = await Promise.all(statuses.map(async type => [type, (await this.getJobs([type as any])).length] as const))
    return Object.fromEntries(entries)
  }
  override async pause() { if (workspaceContext()) throw new Error('Queue-wide pause is reserved for platform maintenance. Pause the business automation instead.'); return super.pause() }
  override async resume() { if (workspaceContext()) throw new Error('Queue-wide resume is reserved for platform maintenance.'); return super.resume() }
  override async remove(id: string, options?: Parameters<Queue['remove']>[1]) {
    const job = await this.getJob(id)
    return job?.id ? super.remove(job.id, options) : 0
  }
  override async getJobLogs(id: string, ...args: [number?, number?, boolean?]) {
    const job = await this.getJob(id)
    return job?.id ? super.getJobLogs(job.id, ...args) : { logs: [], count: 0 }
  }
  override async getJobState(id: string) {
    const job = await this.getJob(id)
    return job?.id ? super.getJobState(job.id) : 'unknown' as const
  }
  override async clean(...args: Parameters<Queue['clean']>) { platformMaintenance(); return super.clean(...args) }
  override async drain(...args: Parameters<Queue['drain']>) { platformMaintenance(); return super.drain(...args) }
  override async obliterate(...args: Parameters<Queue['obliterate']>) { platformMaintenance(); return super.obliterate(...args) }
  override async retryJobs(...args: Parameters<Queue['retryJobs']>) { platformMaintenance(); return super.retryJobs(...args) }
  override async promoteJobs(...args: Parameters<Queue['promoteJobs']>) { platformMaintenance(); return super.promoteJobs(...args) }
}
function platformMaintenance() { if (workspaceContext()) throw new Error('Queue-wide maintenance cannot run from a business profile.') }
export class WorkspaceWorker<Data = any, Result = any, Name extends string = string> extends Worker<Data, Result, Name> {
  constructor(name: string, processor: Processor<Data, Result, Name>, options?: WorkerOptions) {
    super(name, (job, token, signal) => runWorkspaceJob(job, () => processor(job, token, signal)), options)
  }
}
