/**
 * PES.1 — the save state's DECISIONS, as pure functions.
 *
 * Extracted so they can be tested. This repo's vitest runs `environment: 'node'` with no jsdom and
 * no testing-library, by deliberate choice ("no new dependencies: all pure-logic `.ts`"), so a hook
 * or a component cannot be rendered in a test here. Rather than add two dependencies to the
 * monorepo to assert a couple of branches, the branches move out of the hook — which is where they
 * belonged anyway: `useInFlightGuard` becomes wiring, `SaveIndicator` becomes markup, and the rules
 * they encode become assertable facts.
 *
 * The browser half of this behaviour (listener delivery, the modifier/target/origin filters actually
 * firing, `preventDefault` taking effect, and the guard being inert at zero after a real confirmed
 * write) was witnessed live by PES.2's pass. What is asserted here is the half that races API
 * latency in a browser: the mapping from a save state to a decision.
 */

import type { StudioSaveState } from './types'

/* ── the save ledger (#693) ──────────────────────────────────────────────────────────────────
 *
 * 🔴 What the header counts, as data rather than as three closures over three refs.
 *
 * It lives here, and not inside `useSaveMachine`, for the reason at the top of this file: vitest
 * runs `environment: 'node'` with no jsdom, so a hook cannot be rendered. A test that re-derived
 * this arithmetic beside the hook would assert its own scaffolding and pass while the hook was
 * wrong — so the hook holds ONE of these and calls these functions, and the tests drive the same
 * code the browser does.
 *
 * The defect this shape exists to prevent, measured on the sheet 2026-09-02: failures were keyed by
 * WRITE id while `masterWrite.ts` builds them as `${rowId}:${Date.now()}`. Every attempt minted a
 * new id, so nothing could ever remove an earlier failure and the header reported a HISTORY OF
 * ATTEMPTS — "2 changes not saved" over a sheet with zero refused cells, unclearable by discarding,
 * by reloading, or by retyping the cell and watching it save.
 */
export interface SaveLedger {
  /** Write ids currently out. Keyed by write, because two writes to one row can overlap. */
  readonly inFlight: ReadonlySet<string>
  /** SUBJECTS with work that has not landed. A row id for a sheet — never a write id. */
  readonly failed: ReadonlySet<string>
  /** writeId → subject, so `resolved` can find what a `pending` was filed under. */
  readonly subjects: ReadonlyMap<string, string>
  readonly savedCount: number
  /** When a write last actually landed. Discarding work must not restamp this. */
  readonly lastSavedAt: number | null
}

export const emptyLedger: SaveLedger = {
  inFlight: new Set(), failed: new Set(), subjects: new Map(), savedCount: 0, lastSavedAt: null,
}

export function ledgerPending(l: SaveLedger, writeId: string, subject?: string): SaveLedger {
  const key = subject ?? writeId
  const failed = new Set(l.failed); failed.delete(key)
  const subjects = new Map(l.subjects); subjects.set(writeId, key)
  return { ...l, inFlight: new Set(l.inFlight).add(writeId), failed, subjects }
}

export function ledgerResolved(l: SaveLedger, writeId: string, ok: boolean, at: number, subject?: string): SaveLedger {
  const key = subject ?? l.subjects.get(writeId) ?? writeId
  const inFlight = new Set(l.inFlight); inFlight.delete(writeId)
  const subjects = new Map(l.subjects); subjects.delete(writeId)
  const failed = new Set(l.failed)
  // A row that landed has no unsaved work, whatever it did on an earlier attempt.
  if (ok) failed.delete(key)
  else failed.add(key)
  return {
    inFlight, failed, subjects,
    savedCount: ok ? l.savedCount + 1 : l.savedCount,
    lastSavedAt: ok ? at : l.lastSavedAt,
  }
}

/** The work is GONE (discarded), not fixed — the only honest way to drop a failure without a save. */
export function ledgerCleared(l: SaveLedger, subjects: readonly string[]): SaveLedger {
  const failed = new Set(l.failed)
  for (const s of subjects) failed.delete(s)
  const cleared = new Set(subjects)
  const inFlight = new Set(l.inFlight)
  const remaining = new Map(l.subjects)
  for (const [writeId, subject] of remaining) if (cleared.has(subject)) { inFlight.delete(writeId); remaining.delete(writeId) }
  return { ...l, failed, inFlight, subjects: remaining }
}

/** What the header renders. A refusal outranks a save; a save never invents its own timestamp. */
export function ledgerState(l: SaveLedger, message?: string): StudioSaveState {
  if (l.failed.size > 0) {
    return { kind: 'error', failed: l.failed.size, pending: l.inFlight.size, message: message ?? 'The server refused a change.' }
  }
  if (l.inFlight.size > 0) return { kind: 'saving', pending: l.inFlight.size }
  if (l.savedCount > 0 && l.lastSavedAt !== null) return { kind: 'saved', at: l.lastSavedAt, count: l.savedCount }
  return { kind: 'idle' }
}

/**
 * How many writes are still in flight — the ONLY thing that arms the navigation guard.
 *
 * 🔴 `error` deliberately reports its own `pending` rather than zero. A refusal does not mean the
 * other writes landed: `{kind:'error', failed:1, pending:3}` means one was refused and three are
 * still out there, and leaving then still loses those three.
 */
export function pendingWrites(state: StudioSaveState): number {
  switch (state.kind) {
    case 'saving':
      return state.pending
    case 'error':
      return state.pending
    default:
      return 0
  }
}

/** Arm the guard? */
export function guardIsArmed(state: StudioSaveState): boolean {
  return pendingWrites(state) > 0
}

export interface LeaveAttempt {
  /** In-flight writes at the moment of the click. */
  pending: number
  defaultPrevented: boolean
  /** 0 = primary button. */
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  /** The anchor's `target`, if any. */
  anchorTarget: string | null
  /** The raw `href` attribute — `null` when the click was not on an anchor. */
  href: string | null
  /** The resolved destination, or `null` when it could not be parsed. */
  dest: { origin: string; pathname: string } | null
  currentOrigin: string
  currentPathname: string
}

/**
 * Should this click be interrupted to warn about in-flight writes?
 *
 * Every `false` here is a deliberate exemption, not an oversight:
 * - **no pending writes** — nothing to lose.
 * - **a modifier or `target="_blank"`** — the click opens a NEW tab and leaves this one, and its
 *   writes, exactly where they are. Prompting here trains people to dismiss the prompt.
 * - **a non-primary button, or an already-prevented event** — not a navigation we are causing.
 * - **another origin, or an unparseable href** — `beforeunload` covers leaving the origin.
 * - **the same pathname** — in a URL-state page, changing a scope chip or a tab is a navigation to
 *   the same page, not away from it. This is the exemption that stops the guard firing on the
 *   studio's own controls.
 */
export function shouldInterceptLeave(a: LeaveAttempt): boolean {
  if (a.pending <= 0) return false
  if (a.defaultPrevented) return false
  if (a.button !== 0) return false
  if (a.metaKey || a.ctrlKey || a.shiftKey || a.altKey) return false
  if (a.href == null) return false
  if (a.anchorTarget === '_blank') return false
  if (a.href === '' || a.href.startsWith('#')) return false
  if (!a.dest) return false
  if (a.dest.origin !== a.currentOrigin) return false
  if (a.dest.pathname === a.currentPathname) return false
  return true
}

/** The sentence the guard asks. Plural-correct, and it names the number at stake. */
export function leaveConfirmMessage(pending: number): string {
  return `${pending} ${pending === 1 ? 'change is' : 'changes are'} still saving. Leave anyway and lose ${pending === 1 ? 'it' : 'them'}?`
}

/* ── what the header renders ─────────────────────────────────────────────────────────────── */

export type SaveDisplay =
  | { kind: 'idle'; text: string; title: string }
  | { kind: 'saving'; text: string }
  | { kind: 'saved'; text: string; title: string }
  | { kind: 'error'; text: string; title: string }

/**
 * The save state as words.
 *
 * 🔴 `idle` is NOT "Saved". Nothing has been written this session, and claiming otherwise would be
 * the header's own invention rather than something the sheet reported
 * (feedback_100_percent_honest_ui).
 */
export function describeSaveState(state: StudioSaveState, clock: (at: number) => string): SaveDisplay {
  switch (state.kind) {
    case 'idle':
      return {
        kind: 'idle',
        text: 'Autosave on',
        title: 'Every cell saves on its own. There is no page Save.',
      }
    case 'saving':
      return { kind: 'saving', text: `Saving ${state.pending}…` }
    case 'saved':
      return {
        kind: 'saved',
        text: `Saved ${clock(state.at)}`,
        title: `${state.count} ${state.count === 1 ? 'change' : 'changes'} saved this session`,
      }
    case 'error':
      return {
        kind: 'error',
        text:
          `${state.failed} ${state.failed === 1 ? 'change' : 'changes'} not saved` +
          (state.pending > 0 ? ` · ${state.pending} in flight` : ''),
        // The server's own sentence, verbatim — rewording a refusal gives two explanations for one
        // event, and only one of them is true.
        title: state.message,
      }
  }
}
