'use client'

/**
 * NAF.SB.W.4 — the autonomy dial, once.
 *
 * Operator decision 2026-08-07: the dial is operable from the Workers roster as
 * well as from Controls. The obvious way to do that is to write a second dial,
 * and the obvious way for a fleet to end up with two different ideas of what
 * PROPOSE means is to have two places that say so. So there is one component,
 * one set of effect sentences, one confirmation, and one mutation — rendered in
 * two modes:
 *
 *   · `explain`  — Controls. A card per worker, the ladder as a teaching
 *                  object, the effect of the CURRENT rung spelled out below it.
 *   · `operate`  — Workers. The same ladder inline in a table row, or applied
 *                  across a selection.
 *
 * The safety rule is inherited from Controls verbatim and lives here now, which
 * means neither surface can quietly diverge from it:
 *
 *   **Controls that reduce risk apply immediately. Controls that let a worker do
 *   more ask first, and say what it will cost.**
 *
 * A stop control that argues with you is a broken stop control — so switching a
 * worker off, or down, never opens a dialog.
 */

import type { ReactNode } from 'react'

export const LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
export type Level = (typeof LEVELS)[number]

export const RANK: Record<string, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }

/**
 * What each rung actually means for the operator's money and their Amazon
 * account. Deliberately blunt: these are the sentences a beginner needs BEFORE
 * they click, not after.
 */
export const LEVEL_EFFECT: Record<Level, string> = {
  OFF: 'The worker does not run. It costs nothing.',
  OBSERVE: 'The worker runs and writes findings. It spends money on AI, and it cannot change anything on Amazon.',
  PROPOSE: 'The worker runs and its suggestions queue for your approval. It spends money on AI. Nothing reaches Amazon until you approve it.',
  AUTO: 'The worker acts on its own inside every safety gate. It spends money on AI and it changes your Amazon account without asking first.',
}

/** Does this change let the worker do MORE than it can today? */
export function isRaise(from: string, to: string): boolean {
  return (RANK[to] ?? 0) > (RANK[from] ?? 0)
}

export function isAboveCap(level: string, cap: string): boolean {
  return (RANK[level] ?? 0) > (RANK[cap] ?? 0)
}

/* ── the ladder ────────────────────────────────────────────────────────── */

export function AutonomyDial({
  level,
  cap,
  disabled,
  busy,
  label,
  onPick,
  renderRung,
}: {
  level: string
  /** The ceiling written in code. The server refuses anything above it, so the
   *  UI disables it rather than letting the operator discover that by error. */
  cap: string
  disabled?: boolean
  busy?: boolean
  /** Accessible name — "Autonomy for Bid tuner", not just "Autonomy". */
  label: string
  onPick: (next: Level) => void
  /** Lets Controls keep its glossary `<Term>` tooltips on each rung while the
   *  roster renders plain text in a much smaller cell. */
  renderRung?: (level: Level) => ReactNode
}) {
  return (
    <span className="acr-pg-ladder" role="group" aria-label={label}>
      {LEVELS.map((lvl) => {
        const above = isAboveCap(lvl, cap)
        const on = level === lvl
        return (
          <button
            key={lvl}
            type="button"
            className={`acr-pg-rung ${on ? 'on' : ''} ${above ? 'blocked' : ''}`}
            disabled={above || busy || disabled}
            aria-pressed={on}
            title={
              above
                ? `${lvl} is above this worker's ceiling of ${cap} — the ceiling is written in code and the server refuses to exceed it`
                : LEVEL_EFFECT[lvl]
            }
            onClick={() => { if (!on) onPick(lvl) }}
          >
            {renderRung ? renderRung(lvl) : lvl}
          </button>
        )
      })}
    </span>
  )
}

/* ── the confirmation ──────────────────────────────────────────────────── */

/** One worker a pending change would touch. */
export interface AffectedWorker {
  key: string
  name: string
  from: string
  /** Its daily cap, so a confirmation can say what the change authorises to be
   *  spent rather than only what it permits to happen. */
  budgetUSD?: number
}

const money = (n: number) => `$${n.toFixed(2)}`

/**
 * Shown ONLY for changes that let a worker do more — see the safety rule at the
 * top. It always enumerates every worker by name: "set 6 workers to PROPOSE" is
 * a sentence an operator can agree to without knowing what they agreed to, and
 * bulk is exactly where that goes wrong.
 */
export function ConfirmAutonomy({
  to,
  workers,
  busy,
  onCancel,
  onConfirm,
}: {
  to: Level
  workers: AffectedWorker[]
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  const many = workers.length > 1
  const raises = workers.filter((w) => isRaise(w.from, to))
  const drops = workers.filter((w) => !isRaise(w.from, to))
  /**
   * A bulk selection can be mixed: setting six workers to OBSERVE promotes the
   * five that are OFF and DEMOTES the one at PROPOSE. Announcing all six under
   * "let these workers move to OBSERVE" reads as granting power to a worker
   * that is having some taken away. So the heading is neutral when the change
   * cuts both ways, and every row says which direction it goes.
   */
  const mixed = raises.length > 0 && drops.length > 0
  return (
    <div
      className="acr-pg-confirmwrap"
      role="dialog"
      aria-modal="true"
      aria-label="Confirm this change"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="acr-pg-confirm">
        <h4>
          {mixed
            ? `Set these ${workers.length} workers to ${to}?`
            : many
              ? `Let these ${workers.length} workers move to ${to}?`
              : `Let ${workers[0]?.name ?? 'this worker'} move to ${to}?`}
        </h4>
        <p>{LEVEL_EFFECT[to]}</p>
        {mixed ? (
          <p>
            <b>{drops.length} of these would end up with less than {drops.length === 1 ? 'it has' : 'they have'} now</b>
            {' '}— {drops.map((w) => w.name).join(', ')}. That part takes effect the moment you confirm,
            and can be undone by setting {drops.length === 1 ? 'it' : 'them'} back.
          </p>
        ) : null}

        {/* Every name, always, with its direction. A count is not consent. */}
        <ul className="sbw-affected">
          {workers.map((w) => {
            const up = isRaise(w.from, to)
            return (
              <li key={w.key} className={up ? 'up' : 'down'}>
                <b>{w.name}</b>
                <span>
                  <i aria-hidden>{up ? '▲' : '▼'}</i>
                  <span className="sr-only">{up ? 'more autonomy' : 'less autonomy'}</span>
                  {w.from} → {to}
                </span>
              </li>
            )
          })}
        </ul>

        {/* What it authorises to be SPENT, not only what it permits to happen.
            Every rung above OFF costs money on AI, and an operator who has
            decided not to spend yet needs the number before the click, not on
            the bill. */}
        {to !== 'OFF' && raises.length > 0 && raises.some((w) => w.budgetUSD != null) ? (
          <p>
            This lets {raises.length === 1 ? 'it' : `those ${raises.length}`} spend up to{' '}
            <b>{money(raises.reduce((sum, w) => sum + (w.budgetUSD ?? 0), 0))} a day</b> on AI
            between {raises.length === 1 ? 'runs' : 'them'} — a ceiling the server enforces before
            each run, not a forecast.
          </p>
        ) : null}

        <p className="acr-pg-muted">
          You can move {many ? 'them' : 'it'} back to OFF at any time, and that takes effect
          immediately.
        </p>
        <div className="acr-pg-confirmbtns">
          <button className="acr-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="acr-btn go" onClick={onConfirm} disabled={busy}>
            {busy
              ? 'Applying…'
              : many ? `Yes — set all ${workers.length} to ${to}` : `Yes — set ${to}`}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ── the mutation ──────────────────────────────────────────────────────── */

/**
 * One request per worker, because the server audits per worker and refuses per
 * worker: a bulk endpoint would have to invent a policy for "three of six
 * succeeded", and the honest answer is to report exactly that.
 *
 * `enabled` moves with the level deliberately. Two switches for one idea is how
 * an operator ends up with a worker that is "on" and does nothing.
 */
export async function applyAutonomy(
  backend: string,
  keys: string[],
  level: Level,
): Promise<{ ok: string[]; failed: Array<{ key: string; error: string }> }> {
  const ok: string[] = []
  const failed: Array<{ key: string; error: string }> = []
  for (const key of keys) {
    try {
      const res = await fetch(`${backend}/api/agent/fleet/charters/${key}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autonomyLevel: level, enabled: level !== 'OFF' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        failed.push({ key, error: body.error || `${res.status}` })
      } else {
        ok.push(key)
      }
    } catch (e) {
      failed.push({ key, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ok, failed }
}

/** A pause always carries an end date, so stopping a worker is never a
 *  forgotten off switch. */
export async function applyPause(
  backend: string,
  keys: string[],
  days: number,
  reason: string,
): Promise<{ ok: string[]; failed: Array<{ key: string; error: string }> }> {
  const until = new Date(Date.now() + days * 24 * 3600_000).toISOString()
  const ok: string[] = []
  const failed: Array<{ key: string; error: string }> = []
  for (const key of keys) {
    try {
      const res = await fetch(`${backend}/api/agent/fleet/charters/${key}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ until, reason }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        failed.push({ key, error: body.error || `${res.status}` })
      } else ok.push(key)
    } catch (e) {
      failed.push({ key, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return { ok, failed }
}

/* ── pausing ───────────────────────────────────────────────────────────── */

/**
 * A real dialog, not `window.prompt`. The worker detail page still uses two
 * native prompts for this; W.7 replaces them with this one. A native prompt
 * cannot be tooltipped, styled, validated or translated, and this page's
 * standard is higher than that.
 *
 * The end date is mandatory by construction — there is no "pause indefinitely",
 * because that is an off switch someone will forget they flipped.
 */
export function PauseDialog({
  workers,
  busy,
  onCancel,
  onConfirm,
}: {
  workers: AffectedWorker[]
  busy?: boolean
  onCancel: () => void
  onConfirm: (days: number, reason: string) => void
}) {
  const many = workers.length > 1
  return (
    <div
      className="acr-pg-confirmwrap"
      role="dialog"
      aria-modal="true"
      aria-label="Pause"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <form
        className="acr-pg-confirm"
        onSubmit={(e) => {
          e.preventDefault()
          const f = new FormData(e.currentTarget)
          const days = Number(f.get('days'))
          const reason = String(f.get('reason') ?? '').trim()
          if (!Number.isFinite(days) || days <= 0) return
          onConfirm(days, reason)
        }}
      >
        <h4>Pause {many ? `${workers.length} workers` : workers[0]?.name}?</h4>
        <p>
          {many ? 'They' : 'It'} will not run until the pause expires. The autonomy dial is left
          exactly as it is, so resuming restores what you had rather than something you have to
          remember.
        </p>
        <ul className="sbw-affected">
          {workers.map((w) => <li key={w.key}><b>{w.name}</b><span>{w.from}</span></li>)}
        </ul>
        <label className="sbw-field">
          <span>For how many days?</span>
          <input name="days" type="number" min={1} max={365} defaultValue={7} required />
        </label>
        <label className="sbw-field">
          <span>Why? (recorded against {many ? 'each worker' : 'this worker'})</span>
          <input name="reason" type="text" placeholder="e.g. waiting on the credit top-up" />
        </label>
        <div className="acr-pg-confirmbtns">
          <button type="button" className="acr-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="acr-btn" disabled={busy}>
            {busy ? 'Pausing…' : `Pause ${many ? `all ${workers.length}` : 'it'}`}
          </button>
        </div>
      </form>
    </div>
  )
}


/* ── the controls that ignore the OFF switch ───────────────────────────── */

/**
 * NAF.SB.W — three paths deliberately bypass the autonomy dial and call the
 * model on a worker that is switched OFF:
 *
 *   · `POST /agent/fleet/run/:key`            (`ignoreEnabled: true`) — "Run it now"
 *   · `POST /agent/fleet/charters/:key/preview`  (`preview: true`)
 *   · the charter evaluation / A-B path        (`preview: true`)
 *
 * That is the correct design — it is how you test a worker without granting it
 * anything — and it is also the only way to spend money on a dark fleet. The
 * executor's OFF gate is the FIRST thing it does, so nothing else can:
 * `executeCharter` returns `skipped: 'disabled'` before it writes a run row,
 * before the budget guards, before any model call. The nightly sweep proves it
 * — 2026-08-07 04:45 reported `started=6 skipped=6`, $0.00, while still
 * computing 14 scorecards and ~5,800 graph edges.
 *
 * So this dialog exists for exactly one reason: an operator who has decided not
 * to spend yet should not be one unlabelled click away from spending. It states
 * that the worker is off, that this runs it anyway, and what the ceiling is.
 */
export function ConfirmSpend({
  workerName,
  isOff,
  dailyBudgetUSD,
  what,
  busy,
  onCancel,
  onConfirm,
}: {
  workerName: string
  /** True when the dial says OFF — the whole point of the warning. */
  isOff: boolean
  dailyBudgetUSD?: number
  /** "Run it once now" · "Preview this revision" · "Score this revision" */
  what: string
  busy?: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return (
    <div
      className="acr-pg-confirmwrap"
      role="dialog"
      aria-modal="true"
      aria-label="This will spend money"
      onClick={(e) => { if (e.target === e.currentTarget) onCancel() }}
    >
      <div className="acr-pg-confirm">
        <h4>{what} — this spends money</h4>
        <p>
          {isOff ? (
            <>
              <b>{workerName} is switched off.</b> This runs it anyway — that is what this control
              is for, and it is the one thing that ignores the dial.
            </>
          ) : (
            <>This runs <b>{workerName}</b> immediately rather than waiting for its schedule.</>
          )}
        </p>
        <p>
          One run calls the AI provider and is billed to your account.
          {dailyBudgetUSD != null ? (
            <> It cannot exceed <b>{money(dailyBudgetUSD)}</b> in a day — the server refuses the run
            past that, rather than truncating it.</>
          ) : null}
        </p>
        <p className="acr-pg-muted">
          It still cannot change anything on Amazon: a run at OBSERVE writes findings, and
          everything beyond that passes the approval gate first.
        </p>
        <div className="acr-pg-confirmbtns">
          <button className="acr-btn" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="acr-btn go" onClick={onConfirm} disabled={busy}>
            {busy ? 'Running…' : 'Yes — run it and spend'}
          </button>
        </div>
      </div>
    </div>
  )
}
