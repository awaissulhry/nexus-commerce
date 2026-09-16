/**
 * The spreadsheet parse, off the API's event loop and out of its heap.
 *
 * 🔴 Everything in this file used to run inline in the request handler. On 2026-09-16 one
 * XLSX upload to the product editor's import drawer took the whole production API down —
 * not slowly, and not with an error: the process pinned at its heap ceiling
 * (3.751469056 GB, the same value to the byte for twenty minutes), stopped answering every
 * other route within four seconds, never crashed, and so was never restarted. See
 * `docs/2026-09-16-studio-import-wedged-production.md`.
 *
 * The containment is the whole point of the file, and it was measured before it was built
 * on: a worker given `resourceLimits.maxOldGenerationSizeMb` and an unbounded allocation
 * is killed in 319 ms, hands the host a catchable `Worker terminated due to reaching
 * memory limit`, and leaves the host process untouched. Whatever the runaway turns out to
 * be — the 2026-09-16 one was never pinned — it can now only cost one request.
 *
 * Nothing here may touch the database. The two places the parse genuinely needs a stored
 * fact (an editing workbook's export baseline, an eBay workbook's targets and specs) are
 * served by asking the host, which owns Prisma. That keeps the connection pool, the
 * session identity and the boundary checks on the main thread where they belong.
 */
import { parentPort } from 'node:worker_threads'
import ExcelJS from 'exceljs'
import { checkWorkbookSize } from './catalog-source-file.js'
import { readCatalogWorkbook, type EditingWorkbookBaseline } from './catalog-workbook.js'
import { readTransferFile, readTransferWorkbook, TRANSFER_MAX_FILE_BYTES } from './catalog-transfer-file.js'
import { readEbayWorkbook } from './catalog-ebay-workbook.js'
import type { HostMessage, WorkerMessage, PartOutcome } from './workbook-parse-protocol.js'

const port = parentPort
if (!port) throw new Error('workbook-parse.worker must be started as a worker thread')

/** Host answers keyed by the request id the worker asked under. */
const waiting = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
let nextAsk = 1

/** Ask the host for something only it can reach, and wait for exactly that answer. */
function ask<T>(message: Omit<Extract<WorkerMessage, { type: 'ask' }>, 'type' | 'askId'>): Promise<T> {
  const askId = nextAsk++
  return new Promise<T>((resolve, reject) => {
    waiting.set(askId, { resolve: resolve as (value: unknown) => void, reject })
    port!.postMessage({ type: 'ask', askId, ...message } as WorkerMessage)
  })
}

async function readPart(bytes: Uint8Array, filename: string, batchBudgetBytes: number): Promise<PartOutcome> {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!buffer.length || buffer.length > TRANSFER_MAX_FILE_BYTES) {
    throw new Error(`${filename}: each workbook must be non-empty and at most 10 MB`)
  }
  if (!/\.xlsx$/i.test(filename)) return { kind: 'transfer', parsed: await readTransferFile(buffer, filename), expandedBytes: 0 }

  // Measured before anything is materialised: the guard that follows can only refuse what
  // it has already let ExcelJS build, so the cheap zip-header read has to come first.
  const expandedBytes = await checkWorkbookSize(buffer)
  if (expandedBytes > batchBudgetBytes) {
    throw new Error('The workbook batch expands beyond 128 MB. Reduce the selected products, destinations or attributes.')
  }

  const book = new ExcelJS.Workbook()
  await book.xlsx.load(buffer as never)

  const manifest = book.getWorksheet('Nexus workbook')
  if (manifest?.getCell('B2').text === '3' || manifest?.getCell('C2').text) {
    const baseline = await ask<EditingWorkbookBaseline>({ need: 'baseline', exportId: manifest.getCell('C2').text })
    const parsed = readCatalogWorkbook(book, baseline)
    if (!parsed) throw new Error('Keep the Nexus workbook manifest intact. Download a new editing workbook.')
    return { kind: 'editing', parsed, expandedBytes }
  }

  const wide = readCatalogWorkbook(book)
  if (wide) return { kind: 'wide', parsed: wide, expandedBytes }

  const table = readEbayWorkbook(book)
  if (table) return { kind: 'ebay', table, expandedBytes }

  /*
   * 🔴 The loaded book, not the bytes. `readEditorPart` used to fall through to
   * `readTransferFile(buffer, filename)` here, which ran `checkWorkbookSize` and
   * `xlsx.load` over the same upload a SECOND time while the first workbook was still
   * referenced — doubling the peak for exactly the files that reach the deepest branch.
   */
  return { kind: 'transfer', parsed: await readTransferWorkbook(book), expandedBytes }
}

port.on('message', (message: HostMessage) => {
  if (message.type === 'answer') {
    const pending = waiting.get(message.askId)
    waiting.delete(message.askId)
    if (!pending) return
    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.value)
    return
  }
  if (message.type !== 'part') return
  const started = performance.now()
  readPart(message.bytes, message.filename, message.batchBudgetBytes).then(
    outcome => port.postMessage({ type: 'part-done', partId: message.partId, outcome, elapsedMs: performance.now() - started } as WorkerMessage),
    (error: unknown) => port.postMessage({
      type: 'part-failed', partId: message.partId, elapsedMs: performance.now() - started,
      message: error instanceof Error ? error.message : String(error),
    } as WorkerMessage),
  )
})
