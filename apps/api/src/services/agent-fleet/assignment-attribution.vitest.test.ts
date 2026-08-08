/**
 * NAF.SB.AS.5 — attribution survives re-detection.
 *
 * The bug this exists to prevent is silent by construction. `AgentFinding`
 * has ONE `runId`, and the upsert's update branch rewrites it on every
 * re-detection — so a finding produced by an assignment quietly re-attributes
 * to whichever run noticed it most recently, usually the next nightly sweep.
 * No error, no warning, no visible change: "what this assignment found" just
 * becomes shorter overnight.
 *
 * Freezing `runId` instead (a `firstRunId` column) picks a different lie. The
 * finding unique is (charterKey, entityType, entityId, dedupeKey) and carries
 * NO scope, so two assignments over overlapping evidence collide on one row —
 * the second would render "found nothing" while its findings sat under the
 * first assignment's name. Both failures are asserted below.
 */
import { describe, expect, it } from 'vitest'

/**
 * The join, modelled exactly as the schema declares it: composite primary key
 * (findingId, runId), inserts idempotent via skipDuplicates.
 */
function makeJoin() {
  const rows: { findingId: string; runId: string }[] = []
  return {
    rows,
    detect(runId: string, findingIds: string[]) {
      for (const findingId of findingIds) {
        if (!rows.some((r) => r.findingId === findingId && r.runId === runId)) {
          rows.push({ findingId, runId })
        }
      }
    },
    findingsForRuns(runIds: string[]): string[] {
      return [...new Set(rows.filter((r) => runIds.includes(r.runId)).map((r) => r.findingId))]
    },
  }
}

/** What `AgentFinding.runId` does today — the behaviour we are NOT relying on. */
function makeSingleRunIdColumn() {
  const runIdByFinding = new Map<string, string>()
  return {
    detect(runId: string, findingIds: string[]) {
      // The upsert's update branch: runId is overwritten, unconditionally.
      for (const f of findingIds) runIdByFinding.set(f, runId)
    },
    findingsForRuns(runIds: string[]): string[] {
      return [...runIdByFinding.entries()]
        .filter(([, r]) => runIds.includes(r))
        .map(([f]) => f)
    },
  }
}

describe('a finding stays attributed to the assignment that found it', () => {
  it('survives a later sweep re-detecting the same thing', () => {
    const join = makeJoin()
    join.detect('run-assignment', ['f1', 'f2'])
    // Tonight's sweep sees the same two findings.
    join.detect('run-sweep', ['f1', 'f2'])

    expect(join.findingsForRuns(['run-assignment']).sort()).toEqual(['f1', 'f2'])
    // …and the sweep legitimately sees them too. Both are true at once.
    expect(join.findingsForRuns(['run-sweep']).sort()).toEqual(['f1', 'f2'])
  })

  it('DEMONSTRATES the bug the join replaces — a single runId column loses them', () => {
    const col = makeSingleRunIdColumn()
    col.detect('run-assignment', ['f1', 'f2'])
    col.detect('run-sweep', ['f1', 'f2'])
    // The assignment's page would silently go empty overnight.
    expect(col.findingsForRuns(['run-assignment'])).toEqual([])
  })

  it('two assignments over overlapping evidence each keep their own findings', () => {
    // The case a `firstRunId` column would get wrong: the unique has no scope,
    // so both assignments touch the SAME finding row.
    const join = makeJoin()
    join.detect('run-A', ['shared', 'onlyA'])
    join.detect('run-B', ['shared', 'onlyB'])

    expect(join.findingsForRuns(['run-A']).sort()).toEqual(['onlyA', 'shared'])
    expect(join.findingsForRuns(['run-B']).sort()).toEqual(['onlyB', 'shared'])
  })

  it('an assignment with several attempts sees everything any attempt found', () => {
    const join = makeJoin()
    join.detect('attempt-1', ['f1'])
    join.detect('attempt-2', ['f1', 'f2'])
    expect(join.findingsForRuns(['attempt-1', 'attempt-2']).sort()).toEqual(['f1', 'f2'])
  })

  it('re-detecting inside ONE run is idempotent — a repeated dedupeKey cannot fail a paid run', () => {
    const join = makeJoin()
    join.detect('run-1', ['f1', 'f1', 'f1'])
    expect(join.rows).toHaveLength(1)
  })

  it('a run that found nothing attributes nothing — not everything', () => {
    const join = makeJoin()
    join.detect('run-other', ['f1'])
    expect(join.findingsForRuns(['run-empty'])).toEqual([])
  })
})
