/**
 * FF2.8b — Import history persistence.
 *
 * Thin wrappers over prisma.flatFileImport.{create,update,findUnique,findMany}.
 * No business logic lives here — orchestration belongs to the route layer.
 *
 * Status lifecycle:
 *   PREVIEW  → created by createPreviewRecord (before apply)
 *   APPLIED  → written by recordApply when all writes succeeded
 *   FAILED   → written by recordApply when some writes failed
 */

import type { ImportDiff } from './diff.js'
import type { InverseCell } from './apply.js'

// ── Input shapes ──────────────────────────────────────────────────────────────

export interface CreatePreviewInput {
  channel: string
  markets: string[] | 'ALL'
  includeMaster: boolean
  snapshotId?: string
  filename?: string
  uploadHandle?: string
  diff: ImportDiff
}

export interface RecordApplyInput {
  inverseDiff: InverseCell[]
  appliedCount: number
  skippedCount: number
  failedCount: number
  status: 'APPLIED' | 'FAILED'
  reportHandle?: string
}

// ── createPreviewRecord ───────────────────────────────────────────────────────

/**
 * Persist a new import record in PREVIEW status.
 * Called immediately after previewImport completes, before any catalog write.
 *
 * @returns The newly created record's id.
 */
export async function createPreviewRecord(
  prisma: any,
  input: CreatePreviewInput,
): Promise<{ id: string }> {
  const record = await prisma.flatFileImport.create({
    data: {
      channel: input.channel,
      markets: input.markets as any,
      includeMaster: input.includeMaster,
      snapshotId: input.snapshotId ?? null,
      filename: input.filename ?? null,
      uploadHandle: input.uploadHandle ?? null,
      diff: input.diff as any,
      status: 'PREVIEW',
    },
    select: { id: true },
  })
  return { id: record.id as string }
}

// ── recordApply ───────────────────────────────────────────────────────────────

/**
 * Update an existing import record after apply completes (success or partial failure).
 * Writes the inverse diff (for future rollback), counters, final status, and report handle.
 */
export async function recordApply(
  prisma: any,
  id: string,
  input: RecordApplyInput,
): Promise<void> {
  await prisma.flatFileImport.update({
    where: { id },
    data: {
      inverseDiff: input.inverseDiff as any,
      appliedCount: input.appliedCount,
      skippedCount: input.skippedCount,
      failedCount: input.failedCount,
      status: input.status,
      reportHandle: input.reportHandle ?? null,
    },
  })
}

// ── getImport ─────────────────────────────────────────────────────────────────

/**
 * Fetch a single import record by id. Returns null if not found.
 */
export async function getImport(
  prisma: any,
  id: string,
): Promise<any | null> {
  return prisma.flatFileImport.findUnique({ where: { id } })
}

// ── listImports ───────────────────────────────────────────────────────────────

/**
 * List import records, most-recent first.
 *
 * @param opts.channel  Optional channel filter (AMAZON | EBAY | SHOPIFY).
 * @param opts.limit    Max rows to return (default 50).
 */
export async function listImports(
  prisma: any,
  opts?: { channel?: string; limit?: number },
): Promise<any[]> {
  const where = opts?.channel ? { channel: opts.channel } : undefined
  return prisma.flatFileImport.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: opts?.limit ?? 50,
  })
}
