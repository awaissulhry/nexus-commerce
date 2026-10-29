import { newId } from '@nexus/factory-domain/core/ids'
import type { DefectLine } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTools } from '../../../core/command'
import type { Reader } from './store'

/**
 * THE seam of the scrap and rework lines (B-W1-42; reason-first counting: one line per reason with its garments): the
 * append-only OperationScanDefect rows of a scan (written with it, in its command, by the floor or the office) or of a
 * correction request (the counts it asks), read in the caller's scope. The …_production_scan_records_guards trigger
 * keeps each line to an active reason of its kind and within its owner's count of that kind; the API writes a scan's
 * counts FROM its lines (normaliseDefects), so they add up.
 */

type Owner = { readonly scanId: string; readonly correctionRequestId?: undefined } | { readonly correctionRequestId: string; readonly scanId?: undefined }

/** Writes the lines of a scan or a request (none: nothing written) inside its command. */
export async function writeDefects(tools: CommandTools, owner: Owner & { readonly siteId: string; readonly createdById: string | null }, lines: readonly DefectLine[]): Promise<void> {
  if (lines.length === 0) return
  await tools.tx.operationScanDefect.createMany({
    data: lines.map((line) => ({
      id: newId(),
      siteId: owner.siteId,
      scanId: owner.scanId ?? null,
      correctionRequestId: owner.correctionRequestId ?? null,
      kind: line.kind,
      reasonCode: line.reason,
      quantity: line.quantity,
      serverTime: tools.now,
      createdById: owner.createdById,
    })),
  })
}

const sorted = (lines: DefectLine[]) => lines.sort((a, b) => (a.kind === b.kind ? a.reason.localeCompare(b.reason) : a.kind === 'SCRAP' ? -1 : 1))

/** The lines of these scans (a scan without any: an empty list). */
export async function readDefects(db: Reader, scanIds: readonly string[]): Promise<Map<string, DefectLine[]>> {
  const lines = new Map<string, DefectLine[]>(scanIds.map((id) => [id, []]))
  if (scanIds.length === 0) return lines
  const rows = await db.operationScanDefect.findMany({ where: { scanId: { in: [...new Set(scanIds)] } }, select: { scanId: true, kind: true, reasonCode: true, quantity: true } })
  for (const row of rows) lines.get(row.scanId!)?.push({ kind: row.kind, reason: row.reasonCode, quantity: row.quantity })
  for (const list of lines.values()) sorted(list)
  return lines
}

/** The lines of these correction requests. */
export async function readRequestDefects(db: Reader, requestIds: readonly string[]): Promise<Map<string, DefectLine[]>> {
  const lines = new Map<string, DefectLine[]>(requestIds.map((id) => [id, []]))
  if (requestIds.length === 0) return lines
  const rows = await db.operationScanDefect.findMany({ where: { correctionRequestId: { in: [...new Set(requestIds)] } }, select: { correctionRequestId: true, kind: true, reasonCode: true, quantity: true } })
  for (const row of rows) lines.get(row.correctionRequestId!)?.push({ kind: row.kind, reason: row.reasonCode, quantity: row.quantity })
  for (const list of lines.values()) sorted(list)
  return lines
}
