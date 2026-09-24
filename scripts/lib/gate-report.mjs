/**
 * The browser gates' machine-readable result — A-43 / R-50 (2026-09-23).
 *
 * `scripts/run-browser-gates.mjs` sets `GATE_REPORT=<path>` for each gate it runs. A gate writes ONE report, and only
 * from a place where it actually MEASURED: its green line (`exit 0`, no failures) or its red list (`exit 1`, the
 * failures it printed). Every early refusal — no server, no session, a focused run, an unreadable contract — writes
 * nothing, and the runner reads a missing report as NOT MEASURED, never as green.
 */
import { writeFileSync } from 'node:fs'

export function writeGateReport(gate, exit, failures) {
  const path = process.env.GATE_REPORT
  if (!path) return
  writeFileSync(path, JSON.stringify({ gate, exit, failures: failures.map(String), at: new Date().toISOString() }, null, 2))
}

/**
 * A failure's KEY — the sentence with its measured numbers masked, so the same defect keeps the same key from run to
 * run (`row: got 36, spec 37` and `row: got 35.5, spec 37` are one key) while a different field, scope or gesture is a
 * different key. PURE.
 */
export function failureKey(text) {
  return String(text)
    .replace(/\s+/g, ' ')
    .replace(/\d+(?:\.\d+)?/g, '#')
    .trim()
}
