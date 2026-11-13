/**
 * What makes a made-to-measure document "the same" (B-W2b-368, XF1:05; B-W2b-358's gaps):
 *
 *   unitFingerprint   the quote's approval fingerprint (quotes/pricing.ts fingerprintOf: what an approver approves) names a
 *                     unit's measurement profile revision and base size: a unit moved to another revision (or base size) makes a
 *                     pending approval STALE, as a changed price or size does. A size-grid line adds nothing (its fingerprint, and
 *                     every approval pending today, stay as they are).
 *   oncePerRevision   the worksheet PDF of a revision is painted and put in the store once: two people keeping the same new
 *                     version at once share ONE preparation in this process (the second waits for the first's answer), and the
 *                     worksheet's own lock in the command still answers the newest version to a second process (worksheet.ts).
 */

/** A quote line's part of the approval fingerprint: a unit's revision and base size; nothing for any other line. */
export function unitFingerprint(line: { readonly kind: string; readonly measurementProfileId: string | null; readonly baseSize: string | null }): readonly [string | null, string | null][] {
  return line.kind === 'MADE_TO_MEASURE' ? [[line.measurementProfileId, line.baseSize]] : []
}

const running = new Map<string, Promise<unknown>>()

/**
 * Runs `make` once per key at a time: a caller with the same key while one runs gets that run's answer (or its error). The key
 * names the revision and what the version is made of (the company and the language).
 */
export async function oncePerRevision<Result>(key: string, make: () => Promise<Result>): Promise<Result> {
  const current = running.get(key)
  if (current) return current as Promise<Result>
  const run = make().finally(() => running.delete(key))
  running.set(key, run)
  return run
}
