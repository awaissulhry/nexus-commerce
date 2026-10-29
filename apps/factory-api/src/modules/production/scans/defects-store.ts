import { DEFECT_KINDS } from '@nexus/factory-domain/production/scans/reasons'
import type { DefectLine } from '@nexus/factory-domain/production/scans/rules'
import type { CommandTools } from '../../../core/command'
import type { Reader } from './store'

/**
 * THE seam of a scan's scrap and rework lines (B-W1-42; reason-first counting: one line per reason with its garments):
 * written with the scan in its command, read back for the screens and the corrections.
 *
 * INTERIM (until the schema step, the lead's SCHEMA token): the lines live in an audit row of the scan
 * (`production.scanDefects` on the OperationScan, written in the same transaction, append-only like the scan), and
 * OperationScan.scrapReason keeps the one scrap reason when there is exactly one. Audit rows are office reading, so
 * `readDefects` takes an office or system reader (a floor route reads through the tenant's system view, access.ts
 * systemView). Then: the append-only OperationScanDefect table (scan, kind SCRAP | REWORK, reason code, garments), which
 * the floor writes with its scan and reads at its site. The signatures stay.
 */

const ACTION = 'production.scanDefects'

/** Records the scan's lines (none: nothing written) inside the scan's command. */
export function writeDefects(tools: CommandTools, scan: { readonly id: string; readonly companyId: string; readonly siteId: string }, lines: readonly DefectLine[]): void {
  if (lines.length === 0) return
  tools.audit({ action: ACTION, recordType: 'OperationScan', recordId: scan.id, companyId: scan.companyId, siteId: scan.siteId, after: { defects: lines.map((line) => ({ kind: line.kind, reason: line.reason, quantity: line.quantity })) } })
}

const isLine = (value: unknown): value is DefectLine => {
  const line = value as Partial<DefectLine> | null
  return !!line && (DEFECT_KINDS as readonly string[]).includes(String(line.kind)) && typeof line.reason === 'string' && Number.isSafeInteger(line.quantity)
}

/** The lines of these scans (a scan without any: an empty list). An office or system reader. */
export async function readDefects(db: Reader, scanIds: readonly string[]): Promise<Map<string, DefectLine[]>> {
  const lines = new Map<string, DefectLine[]>(scanIds.map((id) => [id, []]))
  if (scanIds.length === 0) return lines
  const rows = await db.auditLog.findMany({ where: { recordType: 'OperationScan', recordId: { in: [...new Set(scanIds)] }, action: ACTION }, select: { recordId: true, after: true } })
  for (const row of rows) {
    const defects = (row.after as { defects?: unknown } | null)?.defects
    lines.set(row.recordId, Array.isArray(defects) ? defects.filter(isLine) : [])
  }
  return lines
}
