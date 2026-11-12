import type { RuleFinding } from '@nexus/factory-domain/sales/quote-warnings/rules'
import type { Reader } from '../quotes/store'
import type { LineCheckDocument, LineCheckLine, LineFinding } from './index'

/**
 * What the B-W2b-294 line rules (SAL-147, QT1:01, QT1:02) read about a document's lines, once per document: the style and
 * colourway codes a line is named by ("Line 20 (SEED-JKT-01 BLK)"), and a rule's finding as a line rule answers it.
 */

export interface LineLabels {
  readonly label: (line: LineCheckLine) => string
}

/** "SEED-JKT-01 BLK" per line (style code, colourway code). */
export async function labelsOf(db: Reader, document: LineCheckDocument): Promise<LineLabels> {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(document.lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return { label: (line) => [styles.get(line.styleId), colourways.get(line.colourwayId)].filter(Boolean).join(' ') }
}

/** A rule's finding about some lines (none: the whole document), with where it is settled in its details. */
export function findingOf(check: string, finding: RuleFinding, lines: readonly LineCheckLine[], details: Readonly<Record<string, unknown>> = {}): LineFinding {
  return {
    check,
    code: finding.code,
    severity: finding.severity,
    lineIds: lines.flatMap((line) => (line.id ? [line.id] : [])),
    seqs: lines.map((line) => line.seq),
    message: finding.message,
    details: { ...details, open: finding.open },
  }
}
