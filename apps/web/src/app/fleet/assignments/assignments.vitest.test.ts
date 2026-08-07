/**
 * NAF.SB.AS.4 — two invariants that typechecking cannot see.
 *
 * 1. **Tile counts equal what clicking the tile reveals**, and tiles plus the
 *    stated remainder account for every assignment. The blocking critique of
 *    the study named this exactly: a first-time operator clicking a tile
 *    marked 3 and landing on 2 rows learns the page lies. Nothing in the type
 *    system stops the count and the filter drifting apart, because they were
 *    two expressions that merely looked alike.
 *
 * 2. **Every guard the API can emit has a WRITTEN sentence.** The fallback
 *    quietly renders machine text, so an omission is invisible — the same
 *    shape as the `?? []` map the Approvals stream found the same night. Add
 *    a guard to the executor without a sentence here and this fails.
 */
import { describe, expect, it } from 'vitest'

import {
  ASSIGNMENT_STATES,
  GUARD_PREFIXES,
  TILE_ORDER,
  errorSentence,
  isOpenState,
  outcomeLine,
  reasonSentence,
  shortReason,
  stateDef,
  type AssignmentState,
} from './states'
import { closedCount, tileCounts, visibleRows, type CountableRow } from './views'

const NOW = Date.UTC(2026, 7, 8, 12, 0, 0)
let seq = 0
function row(state: AssignmentState, dueAt: string | null = null): CountableRow {
  seq++
  return { id: `a${seq}`, state, dueAt, createdAt: `2026-08-0${(seq % 9) + 1}T00:00:00.000Z` }
}

const ROWS: CountableRow[] = [
  row('not_started'),
  row('not_started', '2026-08-01T00:00:00.000Z'), // overdue
  row('running'),
  row('finished'),
  row('finished'),
  row('stopped'),
  row('failed'),
  row('abandoned'),
  row('closed'),
  row('cancelled'),
  row('cancelled'),
]

describe('the strip and the list agree', () => {
  it('each tile count equals the rows that tile reveals', () => {
    const counts = tileCounts(ROWS)
    for (const k of TILE_ORDER) {
      const shown = visibleRows(ROWS, { filter: k, showClosed: false, now: NOW })
      expect(shown.length, `tile "${ASSIGNMENT_STATES[k].label}"`).toBe(counts[k])
    }
  })

  it('tiles + the stated remainder account for EVERY assignment', () => {
    const counts = tileCounts(ROWS)
    const onTiles = TILE_ORDER.reduce((s, k) => s + counts[k], 0)
    expect(onTiles + closedCount(ROWS)).toBe(ROWS.length)
  })

  it('the default view is exactly the open states — nothing silently hidden', () => {
    const shown = visibleRows(ROWS, { now: NOW })
    expect(shown.length).toBe(ROWS.filter((r) => isOpenState(r.state)).length)
    expect(shown.every((r) => isOpenState(r.state))).toBe(true)
  })

  it('showing closed reveals every row and loses none', () => {
    expect(visibleRows(ROWS, { showClosed: true, now: NOW }).length).toBe(ROWS.length)
  })

  it('overdue rises to the top without being filtered out', () => {
    const shown = visibleRows(ROWS, { now: NOW })
    expect(shown[0].dueAt).toBe('2026-08-01T00:00:00.000Z')
    // …and it is still just a flag: its state is untouched.
    expect(shown[0].state).toBe('not_started')
  })

  it('every tile in the strip is an OPEN state — closed ones are the remainder', () => {
    for (const k of TILE_ORDER) expect(ASSIGNMENT_STATES[k].open, k).toBe(true)
  })
})

describe('every state is legible', () => {
  it('has a label and a tip that is more than the label', () => {
    for (const k of Object.keys(ASSIGNMENT_STATES) as AssignmentState[]) {
      const d = ASSIGNMENT_STATES[k]
      expect(d.label.length, k).toBeGreaterThan(2)
      // The tip is load-bearing with eight states: if it is ever weaker than
      // the name, the page becomes eight words nobody can tell apart.
      expect(d.tip.length, k).toBeGreaterThan(d.label.length + 20)
    }
  })

  it('stateDef never throws on an unknown state', () => {
    expect(stateDef('something-new').label).toBeTruthy()
  })
})

describe('every guard the API can emit has a written sentence', () => {
  // Realistic strings, in the shapes the executor actually produces.
  const SAMPLES: Record<string, string> = {
    kill_switch: 'kill_switch',
    fleet_halted: 'fleet_halted: operator paused the fleet',
    fleet_state_unreadable: 'fleet_state_unreadable',
    charter_day: 'charter_day: $0.1000 of $0.10 daily charter budget spent',
    fleet_day: 'fleet_day: $2.0000 of $2.00 fleet ceiling spent',
    stale_evidence: 'stale_evidence: negative-candidates vintage 2026-08-01 exceeds 26h',
    budget_tokens: 'budget_tokens: 20142 of 20000 run tokens used',
    budget_tool_calls: 'budget_tool_calls: 6 of 5 tool calls used',
    target_gone: 'target_gone: the campaign this assignment names no longer exists',
    target_outside_worker_scope: 'target_outside_worker_scope: this worker is limited to DE',
    target_unsupported: 'target_unsupported: this worker reads bid-proposals',
    target_unresolvable: 'target_unresolvable: the assignment names no campaign',
    orphaned: 'orphaned: stuck running >2h, reclaimed',
  }

  it('the sample set covers the declared vocabulary — no guard untested', () => {
    expect(Object.keys(SAMPLES).sort()).toEqual([...GUARD_PREFIXES].sort())
  })

  for (const prefix of GUARD_PREFIXES) {
    it(`${prefix} → a short reason and a full sentence, neither of them machine text`, () => {
      const sample = SAMPLES[prefix]
      const short = shortReason(sample)
      const full = reasonSentence(sample)

      expect(short, `${prefix} short`).toBeTruthy()
      expect(full, `${prefix} full`).toBeTruthy()

      // The generic fallback is `halted.split(':')[0].replace(/_/g,' ')` for
      // the short form and the raw string for the long one. Either appearing
      // means this guard has no written sentence.
      expect(short, `${prefix} fell through to the generic short form`).not.toBe(
        sample.split(':')[0].replace(/_/g, ' '),
      )
      expect(full, `${prefix} fell through to raw machine text`).not.toBe(sample)

      // A sentence, not a fragment: it should say something an operator can act on.
      expect(full!.length, `${prefix} sentence too thin`).toBeGreaterThan(40)
      expect(full, `${prefix} leaks the raw key`).not.toMatch(/_/)
    })
  }
})

describe('errors an operator would otherwise have to decode', () => {
  it('translates a retired worker rather than showing "unknown charter"', () => {
    const s = errorSentence('unknown charter: negative-miner-de')
    expect(s).toContain('retired')
    expect(s).not.toContain('unknown charter')
  })

  it('passes other errors through untouched', () => {
    expect(errorSentence('schema validation failed twice')).toBe('schema validation failed twice')
    expect(errorSentence(null)).toBeNull()
  })
})

describe('outcomeLine — the one delta per row', () => {
  const base = { state: 'finished', runCount: 1, findingCount: 0, lastRun: null }
  it('reads finding nothing as a result, not a failure', () => {
    expect(outcomeLine({ ...base, findingCount: 0 })).toBe('nothing to do')
  })
  it('counts findings in plain words', () => {
    expect(outcomeLine({ ...base, findingCount: 1 })).toBe('1 finding')
    expect(outcomeLine({ ...base, findingCount: 3 })).toBe('3 findings')
  })
  it('never shows a percentage or a bar for a live run', () => {
    expect(outcomeLine({ ...base, state: 'running' })).toBe('working now…')
  })
  it('a stopped row carries WHICH guard, not just "stopped"', () => {
    const line = outcomeLine({
      ...base,
      state: 'stopped',
      lastRun: { haltedReason: 'fleet_day: $2 of $2 spent' },
    })
    expect(line).toContain("fleet's day budget")
  })
  it('never-run reads as never run, not as zero findings', () => {
    expect(outcomeLine({ ...base, state: 'not_started', runCount: 0 })).toBe('never run')
  })
})
