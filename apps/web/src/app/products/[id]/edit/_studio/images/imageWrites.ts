/**
 * PES.7 — what an image write is FILED UNDER (#708).
 *
 * 🔴 The defect this exists to remove. `useImageWorkspace.write()` reported every mutation with a
 * fresh `img-N` id and NO subject, and `ledgerPending`/`ledgerResolved` fall back to the write id
 * when no subject is given (`saveState.ts:52,59`). So each attempt was filed under a key nothing
 * could ever match again: a refused alt-text edit stayed in `failed` forever, and re-saving the
 * SAME picture successfully added a second key rather than clearing the first. The images header
 * counted a HISTORY OF ATTEMPTS — "3 changes not saved" over a tab with nothing unsaved, and no
 * gesture on the page could bring it back to zero. It is the same shape PES.2 fixed on the sheet
 * (#699), which keys by row id; images had no row concept, which is why it was missed.
 *
 * A SUBJECT is the thing the operator would point at and call "this change". Retrying the same work
 * must produce the same subject — that is the whole mechanism: `ledgerPending` deletes the subject
 * from `failed` when the retry leaves, and `ledgerResolved` deletes it again when the retry lands.
 * A subject that varies per attempt is exactly the bug.
 *
 * This module is PURE and imports no React, no `./api` runtime and no Next: `apps/web` vitest runs
 * `environment: 'node'` with no jsdom, so the hook that calls this cannot be rendered in a test.
 * Keeping the reporting here means the test drives the SAME code the browser does rather than a
 * re-derivation of it beside the hook (the trap `saveState.ts:19-34` documents).
 */
import type { ApiResult } from './api'

/**
 * Only what this module calls. Structural on purpose: the real reporter comes from
 * `useSaveReporter()` (`contracts.tsx:262`) and carries a `cleared` this module has no business
 * calling, and a test must be able to hand in a double without constructing a React context.
 */
export interface WriteReporterLike {
  pending(writeId: string, subject?: string): void
  resolved(writeId: string, ok: boolean, message?: string, subject?: string): void
}

/**
 * The ATTEMPT id — distinct per call, deliberately.
 *
 * `inFlight` is keyed by write and `failed` by subject (`saveState.ts:36-39`), because two writes to
 * one picture can overlap: a fast delete landing during a slow alt-text patch must remove its own
 * row from `inFlight` and not the other's. So the attempt id stays unique; the SUBJECT is what
 * repeats.
 */
let writeSeq = 0
export const nextWriteId = (): string => `img-${++writeSeq}`

/**
 * The three kinds of thing an image write is about. Built here rather than spelled at 21 call sites
 * so the vocabulary is one list that can be read, and so a typo is a compile error rather than a
 * subject that silently never matches its retry.
 */
export const writeSubject = {
  /** One existing picture or video, by its row id — alt text, delete, hero, a derived crop. */
  asset: (assetId: string) => `asset:${assetId}`,
  /**
   * Work that has no row id YET, keyed by what is being brought in. A retry of the same file (or
   * the same DAM asset, or the same prompt) is the same subject, which is what lets a successful
   * re-upload clear the refusal from the first attempt.
   */
  upload: (name: string) => `upload:${name}`,
  /**
   * A write about a SET rather than a picture — a bulk save, a reorder, a publish, a restore. Keyed
   * per surface, never shared between surfaces: two surfaces posting to the same endpoint are two
   * pieces of work, and one landing must not clear the other's refusal.
   */
  surface: (name: string) => `surface:${name}`,
}

/**
 * Run one mutation with save reporting attached, filed under `subject`.
 *
 * The result is returned unchanged so the caller can still surface the real refusal next to the
 * control that caused it — the header says THAT something is unsaved, the surface says what.
 */
export async function reportedWrite<T>(
  reporter: WriteReporterLike,
  subject: string,
  run: () => Promise<ApiResult<T>>,
): Promise<ApiResult<T>> {
  const id = nextWriteId()
  reporter.pending(id, subject)
  let res: ApiResult<T>
  try { res = await run() }
  catch (error) { res = { ok: false, status: 0, message: error instanceof Error ? error.message : 'The change could not be saved.' } }
  reporter.resolved(id, res.ok, res.ok ? undefined : res.message, subject)
  return res
}
