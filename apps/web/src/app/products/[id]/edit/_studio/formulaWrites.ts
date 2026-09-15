import type { SaveReporter } from './types'

let sequence = 0

/** Report before enqueueing, including drawer writes that bypass the grid writer. */
export async function reportedFormulaWrite(reporter: SaveReporter, rowId: string, fieldKey: string,
  run: () => Promise<{ ok: boolean; error?: string }>) {
  const id = `formula-write:${++sequence}`
  const subject = `formula:${JSON.stringify([rowId, fieldKey])}`
  reporter.pending(id, subject)
  let result: { ok: boolean; error?: string }
  try { result = await run() }
  catch (error) { result = { ok: false, error: error instanceof Error ? error.message : 'The formula change could not be confirmed.' } }
  reporter.resolved(id, result.ok, result.error, subject)
  return result
}
