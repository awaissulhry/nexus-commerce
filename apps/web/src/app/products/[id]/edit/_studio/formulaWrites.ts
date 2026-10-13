import type { SaveReporter } from './types'

let sequence = 0

/**
 * A formula write's outcome. `dropped`: it never left, or its answer belongs to edits the sheet discarded meanwhile.
 * `stored`: the server holds the change although `ok` is false — a formula kept for correction because it did not
 * evaluate (`lastError`); the cell says refused, and ⌘Z still has the step (review of #614).
 */
export interface FormulaWriteResult { ok: boolean; error?: string; dropped?: boolean; stored?: boolean }

/**
 * G4 (2026-10-13) — what the formula routes answer about the row a write moved (`cell-formula.routes.ts`, additive): the
 * version it holds now (`currentVersion`), which row that is (`versionOf`, and for a listing its id), and the version the
 * write was made over (`versionBefore`). Absent on a refusal or an older API.
 */
export interface FormulaVersionFacts {
  currentVersion?: number
  versionOf?: 'product' | 'channelListing'
  versionBefore?: number
  listingId?: string
}

/** One formula request, sent when its turn comes: its result for the cell, and the version facts of its answer. */
export type FormulaSend = () => Promise<{ result: FormulaWriteResult; facts: FormulaVersionFacts }>

/** A sheet's write line for one row (`sheet/formulaWriteLine.ts`): sends `send` in the row's turn and resolves its result. */
export type FormulaWriteLine = (rowId: string, send: FormulaSend) => Promise<FormulaWriteResult>

/** What a formula write the sheet discarded before it was saved resolves with. */
export const FORMULA_WRITE_DROPPED: FormulaWriteResult = { ok: false, dropped: true, error: 'This change was discarded before it was saved.' }

const version = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/** The version facts of a formula route's answer. Anything malformed is left out, so nothing is adopted from it. */
export function formulaVersionFacts(body: unknown): FormulaVersionFacts {
  const b = (body ?? {}) as Record<string, unknown>
  if (!version(b.currentVersion) || !version(b.versionBefore) || (b.versionOf !== 'product' && b.versionOf !== 'channelListing')) return {}
  return { currentVersion: b.currentVersion, versionBefore: b.versionBefore, versionOf: b.versionOf,
    ...(typeof b.listingId === 'string' && b.listingId ? { listingId: b.listingId } : {}) }
}

/** Report before enqueueing, including drawer writes that bypass the grid writer. */
export async function reportedFormulaWrite(reporter: SaveReporter, rowId: string, fieldKey: string,
  run: () => Promise<FormulaWriteResult>): Promise<FormulaWriteResult> {
  const id = `formula-write:${++sequence}`
  const subject = `formula:${JSON.stringify([rowId, fieldKey])}`
  reporter.pending(id, subject)
  let result: FormulaWriteResult
  try { result = await run() }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'The formula change could not be confirmed.' } }
  // A write the sheet discarded (Reload) is gone, not failed: it leaves the header's count without a verdict.
  if (result.dropped) reporter.cleared([subject])
  else reporter.resolved(id, result.ok, result.error, subject)
  return result
}
