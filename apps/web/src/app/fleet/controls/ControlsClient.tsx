'use client'

/**
 * NAF.SB.6 — Controls: every lever over the fleet, in one place.
 *
 * docs/AGENT_FLEET.md Part 7 enumerates twenty controls, and they are currently
 * spread across env vars, code constants, the Control Room and per-worker pages.
 * Spread controls are how an operator ends up believing something is off when it
 * is on. This page gathers the ones that are editable at runtime, in Part 7's
 * own order — bluntest first.
 *
 * Boundary, stated once: the Control Room governs deterministic engines and
 * rules. This page governs agents only. Neither lists the other's objects.
 *
 * Safety posture of this page itself: every control that could START SPENDING
 * (enabling a worker, raising a dial) asks first and says what it will cost.
 * Controls that only ever reduce risk (halt, disable, lower a budget) apply
 * immediately — a stop control that argues with you is a broken stop control.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle, Ban, Bot, Check, Play, RefreshCw, ShieldAlert, ShieldCheck,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { GLOSSARY, Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'

type TermKey = keyof typeof GLOSSARY & string
const LEVEL_TERM: Record<string, TermKey> = {
  OFF: 'off', OBSERVE: 'observe', PROPOSE: 'propose', AUTO: 'auto',
}
const LEVELS = ['OFF', 'OBSERVE', 'PROPOSE', 'AUTO'] as const
type Level = (typeof LEVELS)[number]
const RANK: Record<string, number> = { OFF: 0, OBSERVE: 1, PROPOSE: 2, AUTO: 3 }

/** What each rung actually means for the operator's money and their Amazon
 *  account. Deliberately blunt: these are the sentences a beginner needs
 *  BEFORE they click, not after. */
const LEVEL_EFFECT: Record<Level, string> = {
  OFF: 'The worker does not run. It costs nothing.',
  OBSERVE: 'The worker runs and writes findings. It spends money on AI, and it cannot change anything on Amazon.',
  PROPOSE: 'The worker runs and its suggestions queue for your approval. It spends money on AI. Nothing reaches Amazon until you approve it.',
  AUTO: 'The worker acts on its own inside every safety gate. It spends money on AI and it changes your Amazon account without asking first.',
}

interface CharterRow {
  key: string
  name: string
  tier: string
  domain: string
  enabled: boolean
  autonomyLevel: string
  autonomyCap: string
  dailyBudgetUSD: number
  maxTokensPerRun: number
  degraded: boolean
  scopeMarketplaces?: string[]
  pausedUntil?: string | null
  pausedReason?: string | null
}
interface FleetState {
  halted: boolean
  haltedAt: string | null
  haltReason: string | null
  haltedBy: string | null
  dailyCeilingUSD: number
  degraded: boolean
}
interface ScorecardRow {
  charterKey: string
  grade: string | null
  promotionEligible: boolean
}

/** A pending change the operator has asked for but not yet confirmed. */
interface Pending {
  key: string
  name: string
  level: Level
  enabled: boolean
}

export function ControlsClient() {
  const backend = getBackendUrl()
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [state, setState] = useState<FleetState | null>(null)
  const [scorecards, setScorecards] = useState<ScorecardRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [haltReason, setHaltReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [c, s, sc] = await Promise.all([
        fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/state`, { cache: 'no-store' }),
        fetch(`${backend}/api/agent/fleet/scorecards?limit=200`, { cache: 'no-store' }),
      ])
      if (!c.ok) throw new Error(`charters: ${c.status}`)
      setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
      if (s.ok) setState((await s.json()) as FleetState)
      if (sc.ok) setScorecards(((await sc.json()) as { scorecards: ScorecardRow[] }).scorecards)
      setErr(null)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [backend])

  useEffect(() => { void load() }, [load])

  /** Apply a dial change. `enabled` and level move together: a worker at OFF is
   *  disabled, a worker above OFF is enabled — two switches for one idea is how
   *  an operator ends up with a worker that is "on" and does nothing. */
  const applyLevel = useCallback(async (key: string, level: Level) => {
    setBusy(key)
    setNote(null)
    try {
      const res = await fetch(`${backend}/api/agent/fleet/charters/${key}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ autonomyLevel: level, enabled: level !== 'OFF' }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error || `${res.status}`)
      }
      setNote(`${key} is now ${level}.`)
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
      setPending(null)
    }
  }, [backend, load])

  const request = useCallback((c: CharterRow, level: Level) => {
    const current = (c.autonomyLevel as Level) ?? 'OFF'
    if (level === current) return
    // Reducing risk applies at once; increasing it asks first.
    if (RANK[level]! < RANK[current]!) return void applyLevel(c.key, level)
    setPending({ key: c.key, name: c.name, level, enabled: level !== 'OFF' })
  }, [applyLevel])

  const halt = useCallback(async () => {
    const reason = haltReason.trim()
    if (!reason) { setErr('A halt needs a reason — it is written to the audit trail.'); return }
    setBusy('fleet')
    try {
      const res = await fetch(`${backend}/api/agent/fleet/state/halt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason }),
      })
      if (!res.ok) throw new Error(`halt: ${res.status}`)
      setHaltReason('')
      setNote('The fleet is halted. No worker will start.')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }, [backend, haltReason, load])

  const resume = useCallback(async () => {
    setBusy('fleet')
    try {
      const res = await fetch(`${backend}/api/agent/fleet/state/resume`, { method: 'POST' })
      if (!res.ok) throw new Error(`resume: ${res.status}`)
      setNote('The fleet may start again. Workers still obey their own dials.')
      await load()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally { setBusy(null) }
  }, [backend, load])

  const live = useMemo(
    () => charters.filter((c) => c.enabled && c.autonomyLevel !== 'OFF'),
    [charters],
  )
  const gradeOf = useCallback(
    (key: string) => scorecards.find((s) => s.charterKey === key) ?? null,
    [scorecards],
  )

  return (
    <div className="acr-fleet">
      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} /> {err}
          <button className="acr-btn" onClick={() => { setErr(null); void load() }}>Dismiss</button>
        </div>
      ) : null}
      {note ? (
        <div className="acr-banner ok" role="status"><Check size={15} /> {note}</div>
      ) : null}

      <p className="acr-pg-intro">
        Every lever over the fleet, bluntest first. Controls that reduce risk — halting,
        switching a worker off, lowering a budget — take effect the moment you click them.
        Controls that let a worker do more ask you to confirm, and tell you what it will cost.
      </p>

      {/* ── 1 · the fleet switch ─────────────────────────────────────── */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3>{state?.halted ? <Ban size={15} /> : <ShieldCheck size={15} />} The fleet switch</h3>
        </header>
        <div className="acr-pg-ctrlbody">
          <p className="acr-pg-ctrlwhat">
            The bluntest control there is. Halting stops the orchestrator from starting any
            worker at all. Your deterministic ads automation — rules, dayparting, budget
            enforcement — keeps running: that machinery is not part of the fleet.
          </p>

          {state?.degraded ? (
            <div className="acr-banner warn" role="status">
              <AlertTriangle size={15} />
              The fleet&apos;s own state could not be read from the database, so it is reporting
              the fail-safe posture: halted. This is a database problem, not a setting.
            </div>
          ) : null}

          {state?.halted ? (
            <div className="acr-pg-ctrlrow">
              <span className="acr-pg-statechip halted">Halted</span>
              <span className="acr-pg-ctrlnote">
                {state.haltReason ? `“${state.haltReason}”` : 'No reason recorded'}
                {state.haltedBy ? ` · by ${state.haltedBy}` : ''}
                {state.haltedAt ? ` · ${new Date(state.haltedAt).toLocaleString()}` : ''}
              </span>
              <span className="spacer" />
              <button className="acr-btn go" disabled={busy === 'fleet'} onClick={() => void resume()}>
                <Play size={13} /> Let the fleet start again
              </button>
            </div>
          ) : (
            <div className="acr-pg-ctrlrow">
              <span className="acr-pg-statechip running">Not halted</span>
              <span className="acr-pg-ctrlnote">
                {live.length === 0
                  ? 'Nothing would run anyway — every worker is switched off.'
                  : `${live.length} worker${live.length === 1 ? '' : 's'} may run.`}
              </span>
              <span className="spacer" />
              <input
                className="acr-pg-search"
                placeholder="Why are you halting?"
                aria-label="Reason for halting the fleet"
                value={haltReason}
                onChange={(e) => setHaltReason(e.target.value)}
              />
              <button className="acr-btn stop" disabled={busy === 'fleet'} onClick={() => void halt()}>
                <Ban size={13} /> Halt the fleet
              </button>
            </div>
          )}

          <div className="acr-pg-ctrlfacts">
            <span>
              Daily ceiling for the whole fleet: <b>${state?.dailyCeilingUSD?.toFixed(2) ?? '—'}</b>
              <span className="acr-pg-muted"> — a hard stop, set in the environment</span>
            </span>
          </div>
        </div>
      </section>

      {/* ── 2 · per-worker dials ─────────────────────────────────────── */}
      <section className="acr-card">
        <header className="acr-fl-head">
          <h3><Bot size={15} /> What each worker may do</h3>
          <div className="acr-fl-headright">
            <button className="acr-btn" onClick={() => void load()} disabled={loading}>
              <RefreshCw size={13} /> {loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
        </header>
        <div className="acr-pg-ctrlbody">
          <p className="acr-pg-ctrlwhat">
            Each worker climbs a ladder: <Term k="off">OFF</Term> → <Term k="observe">OBSERVE</Term>{' '}
            → <Term k="propose">PROPOSE</Term> → <Term k="auto">AUTO</Term>. Every worker is born
            OFF. The <Term k="cap">ceiling</Term> beside each dial is written in code and the
            server refuses to go above it — this page cannot override it, and neither can the API.
          </p>

          {charters.length === 0 ? (
            <div className="acr-pg-empty">
              <strong>{loading ? 'Reading the charters…' : 'No workers found.'}</strong>
              {loading ? 'One moment.' : 'The charter registry returned nothing.'}
            </div>
          ) : (
            <div className="acr-pg-dials">
              {charters.map((c) => {
                const current = (c.autonomyLevel as Level) ?? 'OFF'
                const capRank = RANK[c.autonomyCap] ?? 0
                const card = gradeOf(c.key)
                return (
                  <div className="acr-pg-dialcard" key={c.key}>
                    <div className="acr-pg-dialhead">
                      <span>
                        <Link className="nm" href={`/fleet/workers/${c.key}`}>
                          {c.name}
                        </Link>
                        <span className="acr-pg-muted"> · {c.tier}</span>
                      </span>
                      <span className="acr-pg-capnote">
                        ceiling <b>{c.autonomyCap}</b>
                      </span>
                    </div>

                    <div className="acr-pg-ladder" role="group" aria-label={`Autonomy for ${c.name}`}>
                      {LEVELS.map((lvl) => {
                        const above = (RANK[lvl] ?? 0) > capRank
                        const on = current === lvl
                        return (
                          <button
                            key={lvl}
                            type="button"
                            className={`acr-pg-rung ${on ? 'on' : ''} ${above ? 'blocked' : ''}`}
                            disabled={above || busy === c.key}
                            aria-pressed={on}
                            title={above ? `${lvl} is above this worker's ceiling of ${c.autonomyCap}` : LEVEL_EFFECT[lvl]}
                            onClick={() => request(c, lvl)}
                          >
                            {LEVEL_TERM[lvl] ? <Term k={LEVEL_TERM[lvl]!}>{lvl}</Term> : lvl}
                          </button>
                        )
                      })}
                    </div>

                    <p className="acr-pg-dialeffect">{LEVEL_EFFECT[current] ?? ''}</p>

                    <div className="acr-pg-dialfacts">
                      <span>Budget <b>${c.dailyBudgetUSD}</b>/day</span>
                      <span>Max <b>{c.maxTokensPerRun.toLocaleString()}</b> tokens a run</span>
                      {c.scopeMarketplaces?.length
                        ? <span>Scope <b>{c.scopeMarketplaces.join(', ')}</b></span>
                        : <span className="acr-pg-muted">No marketplace limit</span>}
                      {card?.grade
                        ? <span><Term k="grade">Grade</Term> <b>{card.grade}</b></span>
                        : <span className="acr-pg-muted">Not graded yet</span>}
                      {card?.promotionEligible
                        ? <span className="acr-pg-ok">Has earned its next rung</span>
                        : null}
                    </div>

                    {c.degraded ? (
                      <p className="acr-pg-warn">
                        <AlertTriangle size={12} /> Settings could not be read — showing the
                        fail-safe posture, not your choices.
                      </p>
                    ) : null}
                    {c.pausedUntil ? (
                      <p className="acr-pg-warn">
                        <AlertTriangle size={12} /> Paused until{' '}
                        {new Date(c.pausedUntil).toLocaleString()}
                        {c.pausedReason ? ` — ${c.pausedReason}` : ''}
                      </p>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </section>

      {/* confirmation — only ever for changes that let a worker do MORE */}
      {pending ? (
        <div className="acr-pg-confirmwrap" role="dialog" aria-modal="true" aria-label="Confirm this change">
          <div className="acr-pg-confirm">
            <h4>Let {pending.name} move to {pending.level}?</h4>
            <p>{LEVEL_EFFECT[pending.level]}</p>
            <p className="acr-pg-muted">
              You can move it back to OFF at any time, and that takes effect immediately.
            </p>
            <div className="acr-pg-confirmbtns">
              <button className="acr-btn" onClick={() => setPending(null)}>Cancel</button>
              <button
                className="acr-btn go"
                disabled={busy === pending.key}
                onClick={() => void applyLevel(pending.key, pending.level)}
              >
                Yes — set {pending.name} to {pending.level}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
