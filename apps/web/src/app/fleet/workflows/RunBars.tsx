'use client'

/**
 * NAF.WF-S1R S1.b, extracted at WF-S2R S2.b — the run-history strip.
 *
 * Twelve bars: colour is how a run ended, HEIGHT is how long it took next to
 * the longest run drawn. Airflow's DAG cards spend the same ink on two
 * dimensions; we already compute `durationMs` per orchestration in lib.ts.
 *
 * Extracted because the routine list and the routine's own page must not
 * encode run history two different ways. It lived inside RoutineCard until a
 * second consumer existed — the AS.1 rule: extract on the second consumer,
 * not in anticipation of one.
 *
 * The honesty rules are IN this component, so neither surface can drop one:
 * a run still in flight has no duration and draws full height in the running
 * colour, never as a failure; a group whose duration was never recorded draws
 * at a neutral mid height and says so on hover; the cap is stated on screen,
 * not only in an aria-label; and a routine that has never run gets twelve grey
 * slots — UiPath's rule that never-executed is a colour, not an absence.
 */

import { fmtDuration, type RunGroup } from './lib'

const MAX_BARS = 12
const BAR_MIN = 6
const BAR_MAX = 24
/** Neutral height for a group whose duration is unknown — never zero, which
 *  would read as "instant", and never full, which would read as "slowest". */
const BAR_UNKNOWN = 13

function outcomeWord(g: RunGroup): string {
  return g.running ? 'running now' : g.halted ? 'stopped early' : g.ok ? 'ok' : 'failed'
}
function outcomeClass(g: RunGroup): string {
  return g.running ? 'run' : g.halted ? 'halt' : g.ok ? 'ok' : 'fail'
}

export function RunBars({ groups }: { groups: RunGroup[] }) {
  /* Oldest on the left, so the strip reads left-to-right like time does. */
  const bars = groups.slice(0, MAX_BARS).reverse()
  const longest = Math.max(0, ...bars.map((g) => (g.running ? 0 : (g.durationMs ?? 0))))

  const barHeight = (g: RunGroup): number => {
    if (g.running) return BAR_MAX
    const d = g.durationMs
    if (d == null || d <= 0 || longest <= 0) return BAR_UNKNOWN
    return BAR_MIN + Math.round((BAR_MAX - BAR_MIN) * (d / longest))
  }
  const barTitle = (g: RunGroup): string => {
    const when = new Date(g.startedAt).toLocaleString()
    const took = g.running
      ? 'still running'
      : g.durationMs != null && g.durationMs > 0
        ? `took ${fmtDuration(g.durationMs)}`
        : 'duration not recorded'
    return `${when} — ${outcomeWord(g)}, ${took}`
  }
  const hint = bars.length
    ? 'Each bar is one run, oldest on the left. Its colour is how the run ended; its height is how long it took, next to the longest run shown here.'
    : 'No runs recorded for this routine yet. Each slot will fill with one run.'
  const caption = !groups.length
    ? 'nothing to chart yet'
    : groups.length > bars.length
      ? `latest ${bars.length} of ${groups.length} runs`
      : `${groups.length} run${groups.length === 1 ? '' : 's'} on record`

  return (
    <span className="wf-recent">
      <span className="wf-bars" title={hint} aria-label={hint}>
        {/* Empty slots come FIRST. The strip reads left to right like time
            does, so the unfilled past belongs on the left and the newest run
            belongs hard against the right edge. */}
        {Array.from({ length: MAX_BARS - bars.length }, (_, i) => (
          <span key={`slot-${i}`} className="wf-bar empty" />
        ))}
        {bars.map((g) => (
          <span
            key={g.id}
            className={`wf-bar ${outcomeClass(g)}`}
            style={{ height: `${barHeight(g)}px` }}
            title={barTitle(g)}
          />
        ))}
      </span>
      <span className="wf-sub">{caption}</span>
    </span>
  )
}
