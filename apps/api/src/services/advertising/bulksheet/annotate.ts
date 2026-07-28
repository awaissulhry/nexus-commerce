/**
 * AX-IE.7 — hand the file back, marked up.
 *
 * The point is that the correction loop closes without the operator reconciling
 * anything by hand. They fix the red cells in the file we return, upload that
 * same file, and only the previously-failed rows do anything — because
 * `_baseline` has been refreshed for every row that succeeded, so those now read
 * as no-ops rather than as changes to re-apply.
 *
 * Adobe's bulk flow is the reference for the shape (email back an error file to
 * correct and re-upload); Perpetua appends Result/Errors columns but does not
 * close the loop, because nothing in its returned file stops the successful rows
 * being applied a second time.
 *
 * Note on language: the spec says localise the error text to Italian. Not done,
 * deliberately — the house rule is that operator-facing UI is English and
 * Italian is reserved for listing content. Errors here are operator-facing.
 */

import type { PrismaClient } from '@prisma/client'
import {
  COLUMNS, ROW_KEY_HEADER, BASELINE_HEADER, computeBaseline, parseVocabulary,
} from '@nexus/shared/ads-bulksheet'
import { createWriter, type RowCell, type SheetColumnSpec } from './spreadsheet-adapter.js'
import { coerceCell, SP_SHEET } from './build-workbook.js'

export const STATUS_HEADER = '_status'
export const ERRORS_HEADER = '_errors'
export const APPLIED_AT_HEADER = '_applied_at'
export const ERRORS_SHEET = 'Errors'

/** What the operator sees in `_status`. */
type RowStatus = 'ok' | 'error' | 'skipped' | 'unchanged'

interface StagedParsed {
  entity: string | null
  operation: string | null
  rowKey: string
  baseline: string
  values: Record<string, string>
  cells?: string[]
}

export interface AnnotateResult {
  buffer: Buffer
  rows: number
  errors: number
  ok: number
}

/**
 * Group error text into a small, actionable summary.
 *
 * "412 rows failed" is not actionable; "398 of them are the same unrecognised
 * match type" is — it is one find-and-replace.
 */
function errorFamily(message: string): { code: string; fix: string } {
  const m = message.toLowerCase()
  if (m.includes('match type')) return { code: 'match-type', fix: 'Use one of Amazon\'s exact spellings: Broad, Phrase, Exact, Negative exact, Negative phrase. Match type cannot be changed on an existing keyword — create a new row instead.' }
  if (m.includes('ambiguous')) return { code: 'ambiguous-number', fix: 'Write the number so it can only be read one way — 1.234 or 1234, not 1,234.' }
  if (m.includes('below amazon')) return { code: 'bid-floor', fix: 'Amazon will not accept a bid under 0.02.' }
  if (m.includes('is not a number')) return { code: 'not-a-number', fix: 'The cell contains text where a number is expected. Retype it, or reformat the column as a number.' }
  if (m.includes('is required')) return { code: 'missing-required', fix: 'Fill in the field named in the message. Which fields are required depends on the Entity and the Operation.' }
  if (m.includes('not recognised')) return { code: 'unknown-value', fix: 'Use one of the values listed on the Dictionary sheet for that column.' }
  if (m.includes('not a date') || m.includes('ambiguous —')) return { code: 'bad-date', fix: 'Use YYYYMMDD, e.g. 20260403.' }
  if (m.includes('changed on amazon')) return { code: 'conflict', fix: 'Someone edited this entity after you downloaded. Re-download to get the current values, or re-upload to overwrite deliberately.' }
  return { code: 'other', fix: 'See the message on the row.' }
}

export async function buildAnnotatedWorkbook(prisma: PrismaClient, jobId: string): Promise<AnnotateResult> {
  const job = await prisma.importJob.findUnique({ where: { id: jobId } })
  if (!job) throw new Error('import job not found')

  const staged = await prisma.importJobRow.findMany({
    where: { jobId },
    orderBy: { rowIndex: 'asc' },
    select: { rowIndex: true, status: true, errorMessage: true, targetId: true, completedAt: true, parsedValues: true, afterState: true },
  })

  // Refresh `_baseline` for rows that actually landed, so re-uploading this file
  // treats them as unchanged. Read the entities back rather than assuming the
  // write took the value we asked for — the gate, a clamp, or Amazon itself may
  // have adjusted it, and a baseline that describes a value the entity does not
  // hold would resurface as a phantom conflict.
  const appliedIds = staged.filter((r) => r.status === 'SUCCESS' && r.targetId).map((r) => r.targetId!)
  const [camps, ags, tgts] = appliedIds.length
    ? await Promise.all([
        prisma.campaign.findMany({ where: { id: { in: appliedIds } }, select: { id: true, name: true, status: true, dailyBudget: true, biddingStrategy: true, portfolioId: true } }),
        prisma.adGroup.findMany({ where: { id: { in: appliedIds } }, select: { id: true, name: true, status: true, defaultBidCents: true } }),
        prisma.adTarget.findMany({ where: { id: { in: appliedIds } }, select: { id: true, status: true, bidCents: true } }),
      ])
    : [[], [], []]
  const campById = new Map(camps.map((c) => [c.id, c]))
  const agById = new Map(ags.map((a) => [a.id, a]))
  const tgtById = new Map(tgts.map((t) => [t.id, t]))

  /**
   * The fingerprint of an entity as it stands after the write, computed with the
   * SAME per-entity field list the exporter uses — so a re-upload of this file
   * sees the row as unchanged. Entity-specific because a negative keyword's
   * baseline covers State only, while a keyword's covers State and Bid.
   */
  const refreshedBaseline = (entity: string | null, targetId: string): string | undefined => {
    if (!entity) return undefined
    const c = campById.get(targetId)
    if (c) {
      return computeBaseline(entity, (h) => ({
        State: (c.status ?? '').toLowerCase(),
        'Daily budget': c.dailyBudget == null ? '' : Number(c.dailyBudget),
        'Campaign name': c.name,
        'Bidding strategy': parseVocabulary('biddingStrategy', c.biddingStrategy ?? '') ?? '',
        'Portfolio ID': c.portfolioId ?? '',
      } as Record<string, unknown>)[h])
    }
    const a = agById.get(targetId)
    if (a) {
      return computeBaseline(entity, (h) => ({
        State: (a.status ?? '').toLowerCase(),
        'Ad group name': a.name,
        'Ad Group Default Bid': a.defaultBidCents / 100,
      } as Record<string, unknown>)[h])
    }
    const t = tgtById.get(targetId)
    if (t) {
      return computeBaseline(entity, (h) => ({
        State: (t.status ?? '').toLowerCase(),
        Bid: t.bidCents / 100,
      } as Record<string, unknown>)[h])
    }
    return undefined
  }

  const writer = await createWriter()
  const columns: SheetColumnSpec[] = [
    ...COLUMNS.map((c) => ({ header: c.header, type: c.type })),
    { header: ROW_KEY_HEADER, type: 'text' as const, hidden: true },
    { header: BASELINE_HEADER, type: 'text' as const, hidden: true },
    { header: STATUS_HEADER, type: 'text' as const, headerNote: 'ok = applied · error = fix and re-upload · skipped = nothing to do · unchanged = already matches' },
    { header: ERRORS_HEADER, type: 'text' as const, headerNote: 'What went wrong on this row, and what to do about it.' },
    { header: APPLIED_AT_HEADER, type: 'text' as const },
  ]
  writer.addSheet({ name: SP_SHEET, columns, freeze: { rows: 1, columns: 3 } })

  const familyCounts = new Map<string, { count: number; fix: string; example: string }>()
  let errors = 0
  let ok = 0

  for (const r of staged) {
    const p = (r.parsedValues ?? {}) as unknown as StagedParsed
    const v = p.values ?? {}
    const status: RowStatus = r.status === 'SUCCESS' ? 'ok'
      : r.status === 'FAILED' ? 'error'
      : r.status === 'SKIPPED' ? 'skipped' : 'unchanged'
    if (status === 'error') errors++
    if (status === 'ok') ok++

    // Which cells to mark. The staged row keeps the ADDRESSES of offending cells
    // from validation; anything else falls back to marking the whole row's status.
    const badColumns = new Set<string>()
    for (const addr of p.cells ?? []) {
      // "Sheet!F412" → the column letter is between '!' and the digits.
      const m = /!([A-Z]+)\d+$/.exec(addr ?? '')
      if (!m) continue
      let n = 0
      for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64)
      const col = COLUMNS[n - 1]
      if (col) badColumns.add(col.header)
    }

    const msg = r.errorMessage ?? ''
    if (status === 'error' && msg) {
      const fam = errorFamily(msg)
      const prev = familyCounts.get(fam.code)
      if (prev) prev.count++
      else familyCounts.set(fam.code, { count: 1, fix: fam.fix, example: msg.slice(0, 140) })
    }

    const cells: RowCell[] = COLUMNS.map((c) => {
      if (status === 'error' && badColumns.has(c.header)) {
        // Write the operator's ORIGINAL text, not the coerced value. Coercion is
        // exactly what failed here — Number("abc") and parseVocabulary("Exakt")
        // both yield null — so coercing would hand back a blank red cell and lose
        // the very value they need to see in order to fix it.
        return { value: v[c.header] ?? '', fill: 'error' as const, note: msg.slice(0, 400) }
      }
      return coerceCell(c, v[c.header])
    })
    cells.push(p.rowKey ?? '')
    // The refreshed fingerprint for applied rows — this is what makes a
    // re-upload of this very file a no-op for everything that worked.
    const fresh = status === 'ok' && r.targetId ? refreshedBaseline(p.entity, r.targetId) : undefined
    cells.push(fresh ?? (p.baseline ?? ''))
    cells.push({ value: status, fill: status === 'error' ? 'error' : status === 'ok' ? 'ok' : undefined })
    cells.push(msg)
    cells.push(r.completedAt ? r.completedAt.toISOString() : '')
    await writer.addRow(SP_SHEET, cells)
  }

  // Errors sheet: families rather than a repeat of every row, because the value
  // of a summary is telling you that 398 failures are one find-and-replace.
  writer.addSheet({
    name: ERRORS_SHEET,
    columns: [
      { header: 'Problem', type: 'text' },
      { header: 'Rows affected', type: 'int' },
      { header: 'What it means', type: 'text' },
      { header: 'How to fix it', type: 'text' },
    ],
    freeze: { rows: 1, columns: 1 },
  })
  if (!familyCounts.size) {
    await writer.addRow(ERRORS_SHEET, ['No errors', 0, 'Every row in this file was accepted.', 'Nothing to do.'])
  } else {
    for (const [code, f] of [...familyCounts].sort((a, b) => b[1].count - a[1].count)) {
      await writer.addRow(ERRORS_SHEET, [code, f.count, f.example, f.fix])
    }
  }

  return { buffer: await writer.toBuffer(), rows: staged.length, errors, ok }
}
