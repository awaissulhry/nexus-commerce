/**
 * IM.3.2 — in-memory registry for async stock-import applies.
 *
 * The apply route detaches `run()` and registers the job here; the progress
 * endpoint serves sub-second-fresh counts from this map while the import is
 * running in THIS process, falling back to the StockImportJob row (updated
 * per chunk) after a restart or from another process. Terminal entries are
 * kept briefly so the final poll returns instantly, then swept.
 */
import type { ApplyProgress } from './stock-import.service.js'

export interface RunningImportState {
  jobId: string
  total: number
  processed: number
  succeeded: number
  failed: number
  skipped: number
  startedAt: number
  updatedAt: number
  status: 'APPLYING' | 'DONE' | 'ERROR'
  cancelRequested: boolean
  error?: string
}

const running = new Map<string, RunningImportState>()
const TERMINAL_TTL_MS = 10 * 60_000

function sweep(): void {
  const now = Date.now()
  for (const [id, s] of running) {
    if (s.status !== 'APPLYING' && now - s.updatedAt > TERMINAL_TTL_MS) running.delete(id)
  }
}

export function trackImportStart(jobId: string, total: number): void {
  sweep()
  running.set(jobId, {
    jobId,
    total,
    processed: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    status: 'APPLYING',
    cancelRequested: false,
  })
}

export function updateImportProgress(jobId: string, p: ApplyProgress): void {
  const s = running.get(jobId)
  if (!s) return
  s.processed = p.processed
  s.succeeded = p.succeeded
  s.failed = p.failed
  s.skipped = p.skipped
  s.total = p.total
  s.updatedAt = Date.now()
}

export function finishImport(jobId: string, error?: string): void {
  const s = running.get(jobId)
  if (!s) return
  s.status = error ? 'ERROR' : 'DONE'
  s.error = error
  s.updatedAt = Date.now()
}

export function getImportState(jobId: string): RunningImportState | undefined {
  sweep()
  return running.get(jobId)
}

/** Returns true when the job is running here and the flag was set. */
export function requestImportCancel(jobId: string): boolean {
  const s = running.get(jobId)
  if (!s || s.status !== 'APPLYING') return false
  s.cancelRequested = true
  return true
}

export function isImportCancelRequested(jobId: string): boolean {
  return running.get(jobId)?.cancelRequested === true
}
