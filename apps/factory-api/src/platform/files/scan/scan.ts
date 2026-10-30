import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { command, StaleVersionError, type CommandCaller } from '../../../core/command'
import { GatewayCallFailed, GatewayRefusal } from '../../gateway/gateway'
import type { FileView } from '../contract'
import { viewOf } from '../files'
import type { FilesRuntime } from '../service'
import { ScannerUnavailableError, type VirusScanner } from './port'
import { retryChange, verdictChange, waitsForScan, type ScanStatus } from './rules'

/**
 * The virus scan of a confirmed upload (PLT-245; B-W2a-42), OUTSIDE any transaction like every store call:
 *
 *   1. the file's row as the caller sees it (office or system: the files platform's own callers);
 *   2. FAILED and held → files.rescan moves it back to PENDING (the person's Try again, audited);
 *   3. its bytes from the store (one gateway call, files.read) → the scanner;
 *   4. files.recordScan: ONE command on the StoredFile (its version is the lock) writes the verdict (rules.ts) with its
 *      audit row, and `file.available` when it became AVAILABLE. A verdict another scan recorded meanwhile wins.
 * The scanner or the store not answering changes nothing: the file stays held (QUARANTINED, PENDING) and the answer
 * says so (`outcome`); the person tries again, or the sweep (sweep.ts) scans it when the scanner is back. Never CLEAN by
 * default.
 */

export type ScanOutcome = 'scanned' | 'scanner_unavailable' | 'store_unavailable' | 'not_waiting'

const SELECT = {
  id: true,
  companyId: true,
  recordType: true,
  recordId: true,
  kind: true,
  originalName: true,
  contentType: true,
  sizeBytes: true,
  sha256: true,
  storeAccountId: true,
  storageKey: true,
  status: true,
  visibility: true,
  floorSiteId: true,
  partyId: true,
  retainUntil: true,
  legalHold: true,
  quarantineReason: true,
  scanStatus: true,
  scannedAt: true,
  scanEngine: true,
  scanFinding: true,
  availableAt: true,
  deletedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StoredFileSelect

type ScanRow = Prisma.StoredFileGetPayload<{ select: typeof SELECT }>

const readRow = async (caller: CommandCaller, fileId: string): Promise<ScanRow> => {
  const row = await caller.withClient((client) => client.storedFile.findUnique({ where: { id: fileId }, select: SELECT }))
  if (!row) throw new NotFoundError('File not found.')
  return row
}

const scanned = (row: Pick<ScanRow, 'status' | 'scanStatus' | 'quarantineReason'>) => ({ status: row.status, scanStatus: row.scanStatus as ScanStatus, quarantineReason: row.quarantineReason })

/** A fresh server key: a scan is never a replay of a request (the file's state makes it safe to repeat). */
const scanKey = (fileId: string) => `files-scan.${fileId}.${newId()}`

/** files.rescan: a held FAILED file back to PENDING. */
async function retry(caller: CommandCaller, row: ScanRow): Promise<ScanRow> {
  await command(caller, { name: 'files.rescan', idempotencyKey: scanKey(row.id), input: { fileId: row.id }, record: { type: 'StoredFile', id: row.id, expectedVersion: row.version } }, async ({ tx, audit }) => {
    const current = await tx.storedFile.findUniqueOrThrow({ where: { id: row.id }, select: SELECT })
    if (current.scanStatus !== 'FAILED' || !waitsForScan(scanned(current))) return null
    await tx.storedFile.update({ where: { id: row.id }, data: retryChange(), select: { id: true } })
    audit({ recordType: 'StoredFile', recordId: row.id, companyId: row.companyId, before: { scanStatus: 'FAILED', scanFinding: current.scanFinding }, after: { scanStatus: 'PENDING' } })
    return null
  })
  return readRow(caller, row.id)
}

/** The verdict, in one command; a verdict recorded meanwhile (another scan) is kept. */
async function record(caller: CommandCaller, row: ScanRow, verdict: Awaited<ReturnType<VirusScanner['scan']>>): Promise<FileView> {
  try {
    const { result } = await command(
      caller,
      {
        name: 'files.recordScan',
        idempotencyKey: scanKey(row.id),
        input: { fileId: row.id, verdict: verdict.verdict, engine: verdict.engine },
        record: { type: 'StoredFile', id: row.id, expectedVersion: row.version },
      },
      async ({ tx, audit, emit, now }) => {
        const current = await tx.storedFile.findUniqueOrThrow({ where: { id: row.id }, select: SELECT })
        if (current.scanStatus !== 'PENDING') return viewOf(current)
        const change = verdictChange(scanned(current), verdict, now)
        const after = await tx.storedFile.update({ where: { id: row.id }, data: change, select: SELECT })
        audit({
          recordType: 'StoredFile',
          recordId: row.id,
          companyId: row.companyId,
          before: { status: current.status, scanStatus: current.scanStatus, quarantineReason: current.quarantineReason },
          after: { status: after.status, scanStatus: after.scanStatus, quarantineReason: after.quarantineReason, scanEngine: after.scanEngine, scanFinding: after.scanFinding },
        })
        if (after.status === 'AVAILABLE' && current.status !== 'AVAILABLE') {
          emit({ type: 'file.available', subject: row.id, companyId: after.companyId, payload: { fileId: row.id, recordType: after.recordType, recordId: after.recordId, kind: after.kind } })
        }
        return viewOf(after)
      },
    )
    return result
  } catch (error) {
    if (error instanceof StaleVersionError) return viewOf(await readRow(caller, row.id))
    throw error
  }
}

/**
 * Scans a file that waits for its scan (PENDING, or FAILED: tried again) and records the verdict. Returns the file as it
 * is now, and what happened.
 */
export async function scanFile(files: FilesRuntime, scanner: VirusScanner, caller: CommandCaller, fileId: string): Promise<{ file: FileView; outcome: ScanOutcome }> {
  let row = await readRow(caller, fileId)
  if (!waitsForScan(scanned(row))) return { file: viewOf(row), outcome: 'not_waiting' }
  if (row.scanStatus === 'FAILED') row = await retry(caller, row)
  if (row.scanStatus !== 'PENDING') return { file: viewOf(row), outcome: 'not_waiting' }
  let bytes: Buffer | null
  try {
    bytes = await files.storage.read(caller, row.storeAccountId, row.storageKey, row.sizeBytes)
  } catch (error) {
    if (error instanceof GatewayRefusal || error instanceof GatewayCallFailed) return { file: viewOf(row), outcome: 'store_unavailable' }
    throw error
  }
  if (!bytes) return { file: viewOf(row), outcome: 'store_unavailable' }
  let verdict: Awaited<ReturnType<VirusScanner['scan']>>
  try {
    verdict = await scanner.scan(bytes)
  } catch (error) {
    if (error instanceof ScannerUnavailableError) return { file: viewOf(row), outcome: 'scanner_unavailable' }
    throw error
  }
  return { file: await record(caller, row, verdict), outcome: 'scanned' }
}
