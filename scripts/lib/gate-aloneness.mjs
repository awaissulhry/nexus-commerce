/**
 * The aloneness decision for `scripts/studio-gate-session.mjs`, as PURE functions plus one lock file.
 *
 * ## Why this file exists (VT.F item A8, on VT.3b's and VT.4b's measurements)
 *
 * The wrapper's first guard read `ps` and then dropped every line containing
 * `studio-gate-session.mjs`. It had to drop something, because the shell that launches
 * `node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs` has the GATE's name
 * in its own argv — so a guard matching the gate name fires on its own caller. Excluding by NAME made
 * the exclusion far too wide: it also hid every OTHER wrapper, which is the only process the guard
 * most needed to see.
 *
 * It was not theoretical. Both arms happened on 2026-09-13:
 *   - VT.3b started `check-control-census` through the wrapper while VT.2c's wrapper run was open; the
 *     reading was tainted, discarded and re-run alone (ledger 07:35:52Z).
 *   - VT.4b had two `studio-gate-session` processes alive at 10:04 — a hung 09:53 run plus a new one —
 *     and reported that the guard "looks for `check-*` processes and does not catch a second wrapper".
 *
 * ## The rule this file implements
 *
 * 1. **Exclude by PID, never by name.** The processes that must not count are THIS process and its
 *    ancestors (the launching shell, and whatever launched that). Their pids are facts; their argv is a
 *    coincidence. Everything else that matches is a real peer, wrapper or bare gate alike.
 * 2. **A lock file is the authority.** `ps` cannot see a peer that is between two child processes — a
 *    wrapper sitting in its own DB setup matches nothing but owns the dev server just as much. The lock
 *    is taken before the first write and released in the wrapper's `finally`; a lock whose pid is dead is
 *    reclaimed with a printed note, so a SIGKILLed run does not wedge the gate forever.
 * 3. **`pgrep -fc 'node scripts/'` is the witness, not the judge.** It counts this process too, so it can
 *    never be a refusal predicate; it is printed beside the decision so a reader can see what the
 *    instrument saw. A count that exceeds `1 + the gate child` is a prompt to look, and it is the positive
 *    control that the process view is pointed at something.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

/** Every `scripts/*.mjs` that owns the dev server for the duration of a reading. */
export const GATE_PATTERN = /scripts\/(check-(?:editor-open|layout-v2|control-census)|studio-gate-session)\.mjs/

/** `ps -Ao pid=,ppid=,args=` → rows. Tolerates leading spaces and argv containing spaces. */
export function parsePs(psOutput) {
  return String(psOutput)
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter(Boolean)
    .map(([, pid, ppid, args]) => ({ pid: Number(pid), ppid: Number(ppid), args }))
}

/**
 * The ancestor chain of `pid` (exclusive of `pid`), derived from the SAME `ps` rows the decision uses —
 * so the exclusion set cannot disagree with the candidate set.
 */
export function ancestorsOf(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const out = []
  let cursor = byPid.get(pid)?.ppid
  while (cursor && cursor > 1 && !out.includes(cursor)) {
    out.push(cursor)
    cursor = byPid.get(cursor)?.ppid
  }
  return out
}

/**
 * PURE. Which other gate-owning processes does this `ps` output show?
 * `selfPid`'s own row and its ancestors are excluded BY PID. Nothing is excluded by name.
 */
export function otherGateProcesses(psOutput, { selfPid, extraExcludedPids = [] } = {}) {
  const rows = parsePs(psOutput)
  const excluded = new Set([selfPid, ...ancestorsOf(rows, selfPid), ...extraExcludedPids])
  return rows.filter((r) => GATE_PATTERN.test(r.args) && !excluded.has(r.pid))
}

/** PURE. Is a lock record stale? `isAlive(pid)` is injected so this is testable without processes. */
export function lockIsStale(record, isAlive) {
  if (!record || typeof record.pid !== 'number') return true
  if (record.pid === process.pid) return true
  return !isAlive(record.pid)
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

/**
 * Take the lock, or throw naming the holder. Returns a describing line for the caller to print.
 * `{ ok, note }` on success; throws `Error` with the holder's pid, command and age on refusal.
 */
export function acquireGateLock(lockPath, { command, isAlive = alive } = {}) {
  let note = 'no previous lock'
  if (existsSync(lockPath)) {
    let record = null
    try { record = JSON.parse(readFileSync(lockPath, 'utf8')) } catch { record = null }
    if (!lockIsStale(record, isAlive)) {
      const age = Math.round((Date.now() - new Date(record.startedAt).getTime()) / 1000)
      throw new Error(
        `Another studio gate holds the lock — a gate must run ALONE:\n` +
          `  pid ${record.pid} · started ${record.startedAt} (${age}s ago) · ${record.command}\n` +
          `  lock: ${lockPath}\n` +
          `  If that process is gone, delete the lock file and say so in the ledger.`,
      )
    }
    note = record
      ? `reclaimed a STALE lock from pid ${record.pid} (${record.command}) — that process is gone`
      : `reclaimed an UNREADABLE lock file`
  }
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), command }, null, 2))
  return { ok: true, note }
}

/** Release only OUR lock. A lock another pid took in the meantime is left alone. */
export function releaseGateLock(lockPath) {
  if (!existsSync(lockPath)) return 'already released'
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (record?.pid !== process.pid) return `left in place — held by pid ${record?.pid}, not me`
  } catch { /* unreadable: it is not provably ours, but nobody can use it either — remove it */ }
  unlinkSync(lockPath)
  return 'released'
}

/**
 * The WITNESS: how many `node scripts/…` processes does `pgrep` see? It counts THIS process, so it is
 * never the judge — it is printed so the reading carries what the process view saw, and a 0 or a `null`
 * means the instrument is blind and the emptiness above proved nothing.
 *
 * 🔴 `pgrep -fc` is the LINUX spelling and it does not exist on this machine: BSD `pgrep` accepts
 * `-Lfilnoqvx` and no `-c`, so `-fc` exits 2 with a usage line on stderr — which the first version
 * swallowed into `null` and then let past an `assert.notEqual(witness, 0)`, a blind instrument reading
 * as a pass. Counted from `pgrep -f`'s own lines instead, which is portable, and the assertion below is
 * `>= 1` rather than `!== 0` so neither `null` nor `0` can slip through.
 */
export function gateProcessWitness() {
  try {
    const out = execFileSync('pgrep', ['-f', 'node scripts/'], { encoding: 'utf8' })
    return out.split('\n').filter((l) => /^\d+$/.test(l.trim())).length
  } catch (error) {
    /* pgrep exits 1 with no output when nothing matches — which, from inside a `node scripts/…`
       process, would itself be the finding. Anything else (a usage error) is `null`: not measured. */
    return error?.status === 1 ? 0 : null
  }
}

/** `ps` in the one shape every function here expects. */
export function readPs() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,args='], { encoding: 'utf8' })
}
