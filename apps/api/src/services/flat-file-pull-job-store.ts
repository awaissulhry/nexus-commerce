/**
 * Flat-File Pull Job Store — Phase 5 persistence layer.
 *
 * Both Amazon and eBay in-editor pull services maintain their own
 * in-memory job queues (the fast path) AND dual-write to the
 * FlatFilePullJob table here. The DB is the recovery surface so a
 * browser refresh or a server restart doesn't lose a long-running
 * pull's results.
 *
 * Contract:
 *   persistPullJobInitial — INSERT on job creation
 *   persistPullJobFinal   — UPDATE on done/failed (also writes rows)
 *   findActivePullJob     — used by editor mount to surface an
 *                            unreviewed completed pull or resume a
 *                            still-running job
 *
 * All writes are best-effort. A DB failure logs + swallows the error
 * so the in-memory job continues unaffected.
 */

import prisma from '../db.js'
import { getPullPreviewJobStatus as getAmazonJob } from './amazon/flat-file-pull-preview.service.js'
import { getEbayPullPreviewJobStatus as getEbayJob } from './ebay-flat-file-pull-preview.service.js'

interface InitialJobInput {
  jobId: string
  marketplace: string
  productType?: string | null
  skus: string[] | null
  startedAt: string
}

interface FinalJobInput {
  jobId: string
  status: 'done' | 'failed'
  progress: number
  total: number
  pulled: number
  skipped: number
  failed: number
  errors: Array<{ sku: string; error: string }>
  rows: any[]
  doneAt?: string
  fatalError?: string
}

export async function persistPullJobInitial(
  channel: 'AMAZON' | 'EBAY',
  job: InitialJobInput,
): Promise<void> {
  try {
    await prisma.flatFilePullJob.create({
      data: {
        id: job.jobId,
        channel,
        marketplace: job.marketplace.toUpperCase(),
        productType: job.productType ?? null,
        skus: job.skus ?? [],
        status: 'running',
        startedAt: new Date(job.startedAt),
      },
    })
  } catch (err) {
    console.error(`[FlatFilePullJob:initial:${channel}] DB write failed for ${job.jobId}:`, err)
  }
}

export async function persistPullJobFinal(
  channel: 'AMAZON' | 'EBAY',
  job: FinalJobInput,
): Promise<void> {
  try {
    await prisma.flatFilePullJob.update({
      where: { id: job.jobId },
      data: {
        status: job.status,
        progress: job.progress,
        total: job.total,
        pulled: job.pulled,
        skipped: job.skipped,
        failed: job.failed,
        errors: job.errors as any,
        rows: job.rows as any,
        doneAt: job.doneAt ? new Date(job.doneAt) : new Date(),
        fatalError: job.fatalError ?? null,
      },
    })
  } catch (err) {
    console.error(`[FlatFilePullJob:final:${channel}] DB write failed for ${job.jobId}:`, err)
  }
}

interface FindActiveOptions {
  channel: 'AMAZON' | 'EBAY'
  marketplace: string
  productType?: string | null
  maxAgeMinutes?: number
}

/**
 * Returns the most recent pull job for (channel, marketplace [,
 * productType]) within the last `maxAgeMinutes` (default 60), enriched
 * with two flags the editor cares about:
 *
 *   `alive`     — the in-memory job queue still has this job (fast
 *                  path is intact, polling will yield progress)
 *   `reviewed`  — an audit log row already exists for this job, so
 *                  the operator has already applied / cancelled — no
 *                  banner needed
 *
 * Returns null when no such job exists.
 */
export async function findActivePullJob(opts: FindActiveOptions) {
  const cutoff = new Date(Date.now() - (opts.maxAgeMinutes ?? 60) * 60 * 1000)
  const where: Record<string, any> = {
    channel: opts.channel,
    marketplace: opts.marketplace.toUpperCase(),
    startedAt: { gte: cutoff },
  }
  if (opts.channel === 'AMAZON' && opts.productType) {
    where.productType = opts.productType.toUpperCase()
  }

  const job = await prisma.flatFilePullJob.findFirst({
    where,
    orderBy: { startedAt: 'desc' },
  })
  if (!job) return null

  const reviewedRow = await prisma.flatFilePullRecord.findFirst({
    where: { jobId: job.id },
    select: { id: true },
  })

  const alive =
    opts.channel === 'AMAZON' ? !!getAmazonJob(job.id) : !!getEbayJob(job.id)

  return {
    job,
    alive,
    reviewed: !!reviewedRow,
  }
}
