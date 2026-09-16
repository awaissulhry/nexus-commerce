/**
 * Owns one parse worker for the life of one upload: its heap cap, its deadline, and the
 * database answers it is not allowed to fetch for itself.
 *
 * The guarantee this module exists to provide is narrow and absolute — **a spreadsheet
 * upload cannot take the API down.** Before 2026-09-16 it could, and did: see
 * `docs/2026-09-16-studio-import-wedged-production.md`. Every failure mode the parse has
 * now lands here as a rejected promise with a sentence an operator can act on, including
 * the two that previously had no representation at all (heap exhaustion and never
 * finishing).
 */
import { Worker } from 'node:worker_threads'
import type { HostMessage, PartOutcome, WorkerMessage } from './workbook-parse-protocol.js'

/**
 * Sized from measurement, not taste. The worst *legitimate* single workbook — 40 MB
 * expanded, the cap `checkWorkbookSize` already enforces — costs ~700 MB at the measured
 * ~1 KB per cell, and a batch drops each book before loading the next, so the peak is one
 * book plus the accumulated rows. 1536 MB clears that with room, and is far enough below
 * the container's 8 GB that a worker dying never squeezes the API.
 */
const PARSE_HEAP_MB = 1536
/** A full-limit batch parses in well under a minute; past this it is a defect, not a big file. */
const PARSE_TIMEOUT_MS = 90_000

export class WorkbookParseError extends Error {
  constructor(message: string, readonly reason: 'heap' | 'timeout' | 'crashed' | 'refused') {
    super(message)
    this.name = 'WorkbookParseError'
  }
}

export interface ParseSessionOptions {
  /** Fetch the stored export baseline for an editing workbook. Runs on the main thread. */
  resolveBaseline: (exportId: string) => Promise<unknown>
  /** Per-stage timing. The 2026-09-16 handler logged nothing, which is why it was unreadable. */
  log?: (event: string, detail: Record<string, unknown>) => void
  /**
   * Overridden only by the suite, so the kill path itself can be exercised against a small
   * file instead of being asserted from the constants. A containment nothing ever trips is
   * a containment nobody has seen work.
   */
  heapMb?: number
  timeoutMs?: number
}

/*
 * Under `tsc` this file and its worker are both `.js` in `dist` and plain Node runs them.
 * Under `tsx watch` and vitest both are `.ts` on disk, and a worker thread does NOT inherit
 * the parent's loader hooks — `--import tsx` alone starts the entry but leaves Node's stock
 * resolver in place, so the worker's own `./catalog-source-file.js` specifiers fail to
 * resolve to their `.ts` sources. Registering tsx's ESM API inside the thread, by absolute
 * URL because a `data:` module cannot resolve a bare specifier, is what actually rewrites
 * them. Measured: without this the worker dies with `Cannot find module …js`, which the host
 * correctly reports as a parse failure — a green suite over a worker that never ran.
 */
const HOST_IS_TS = import.meta.url.endsWith('.ts')
const WORKER_URL = new URL(HOST_IS_TS ? './workbook-parse.worker.ts' : './workbook-parse.worker.js', import.meta.url)
const WORKER_EXEC_ARGV = (() => {
  if (!HOST_IS_TS) return []
  try {
    return ['--import', `data:text/javascript,import{register}from${JSON.stringify(import.meta.resolve('tsx/esm/api'))};register();`]
  } catch {
    return [] // tsx is a dev dependency; production never reaches this branch.
  }
})()

export interface ParseSession {
  /** Parse one uploaded part. Rejects — never hangs, never takes the process with it. */
  read(filename: string, bytes: Buffer, batchBudgetBytes: number): Promise<PartOutcome>
  close(): Promise<void>
}

export function openWorkbookParser(options: ParseSessionOptions): ParseSession {
  const timeoutMs = options.timeoutMs ?? PARSE_TIMEOUT_MS
  const worker = new Worker(WORKER_URL, {
    resourceLimits: { maxOldGenerationSizeMb: options.heapMb ?? PARSE_HEAP_MB },
    execArgv: WORKER_EXEC_ARGV,
  })
  /*
   * 🔴 Deliberately NOT unref'd, and neither is the deadline below.
   *
   * Both were, until the compiled build was exercised on its own: with a parse in flight and
   * nothing else holding the loop, node printed `Detected unsettled top-level await` and
   * exited 13 — the request simply evaporated. The API's own server handle hides this, which
   * is exactly why it had to be caught here rather than in production. `close()` runs in a
   * `finally` and `clearTimeout` runs on every settle, so a ref'd worker delays nothing.
   */

  let nextPart = 1
  let closed = false
  const parts = new Map<number, { resolve: (outcome: PartOutcome) => void; reject: (error: Error) => void }>()
  /*
   * 🔴 A baseline lookup that threw must reach the caller as ITS OWN error, not as the
   * worker's paraphrase of it. `TransferConflict` decides the 409 the drawer renders, and a
   * round trip through a string would have flattened it to a generic 400.
   */
  let hostError: Error | null = null

  const failAll = (error: Error) => {
    for (const pending of parts.values()) pending.reject(error)
    parts.clear()
  }

  worker.on('message', (message: WorkerMessage) => {
    if (message.type === 'ask') {
      options.resolveBaseline(message.exportId).then(
        value => worker.postMessage({ type: 'answer', askId: message.askId, value } as HostMessage),
        (error: unknown) => {
          hostError = error instanceof Error ? error : new Error(String(error))
          worker.postMessage({ type: 'answer', askId: message.askId, error: hostError.message } as HostMessage)
        },
      )
      return
    }
    const pending = parts.get(message.partId)
    if (!pending) return
    parts.delete(message.partId)
    if (message.type === 'part-done') {
      options.log?.('workbook.part.parsed', { kind: message.outcome.kind, ms: Math.round(message.elapsedMs), expandedBytes: message.outcome.expandedBytes })
      pending.resolve(message.outcome)
    } else {
      options.log?.('workbook.part.refused', { ms: Math.round(message.elapsedMs), message: message.message })
      const original = hostError
      hostError = null
      pending.reject(original ?? new WorkbookParseError(message.message, 'refused'))
    }
  })

  worker.on('error', (error: Error) => {
    // The containment, arriving: a runaway is killed here in ~300 ms instead of pinning the
    // API's heap forever. Both halves of that sentence were measured on 2026-09-16.
    const heap = /memory limit|heap out of memory/i.test(error.message)
    options.log?.('workbook.parse.died', { heap, message: error.message })
    failAll(heap
      ? new WorkbookParseError('This file needs more memory to read than an import is allowed. Reduce its rows, columns or formatting, or split it into smaller workbooks.', 'heap')
      : new WorkbookParseError(`The file could not be read: ${error.message}`, 'crashed'))
  })

  worker.on('exit', code => {
    if (!closed && parts.size) failAll(new WorkbookParseError(`The file reader stopped unexpectedly (exit ${code}).`, 'crashed'))
  })

  return {
    read(filename, bytes, batchBudgetBytes) {
      return new Promise<PartOutcome>((resolve, reject) => {
        const partId = nextPart++
        parts.set(partId, { resolve, reject })
        const timer = setTimeout(() => {
          if (!parts.delete(partId)) return
          options.log?.('workbook.parse.timeout', { filename, ms: timeoutMs })
          void worker.terminate()
          reject(new WorkbookParseError('Reading this file took too long and was stopped. Split it into smaller workbooks, or remove unused rows, columns and formatting.', 'timeout'))
        }, timeoutMs)
        const settle = <T,>(run: (value: T) => void) => (value: T) => { clearTimeout(timer); run(value) }
        parts.set(partId, { resolve: settle(resolve), reject: settle(reject) })
        // A Buffer is a view on a pooled ArrayBuffer; copy so the clone carries these bytes only.
        const copy = new Uint8Array(bytes.byteLength)
        copy.set(bytes)
        worker.postMessage({ type: 'part', partId, bytes: copy, filename, batchBudgetBytes } as HostMessage, [copy.buffer])
      })
    },
    async close() {
      closed = true
      await worker.terminate()
    },
  }
}
