'use client'

/**
 * NEG.8 — the record: what changed, what was refused, and how you hear about it. The last section.
 *
 * ── 🔴 The refusals are the most valuable thing on this page ─────────────────────────────────
 *
 * `protectConverting` refusals carry the term, the order count and the sales, and they have never
 * been on a screen — they live inside `AutomationRuleExecution.actionResults` JSON. Five terms,
 * every one of them earning, that a rule tried to negate and was stopped from negating.
 *
 * The euro figures are what those terms **made**. They are never presented as money saved: what the
 * account would have lost is unknowable, exactly as a bid change's effect is, and the weekly
 * digest's header says the same thing about its own numbers.
 *
 * ── Three refusal sources, never merged ──────────────────────────────────────────────────────
 *
 * Protection refusals (with the money) · gate denials (NOT PERSISTED — no table exists, so no
 * count is invented) · cap refusals (counted null-safely, because the engine's own counter cannot
 * see a success). Three different problems with three different fixes.
 *
 * ── Notifications extend, they do not multiply ───────────────────────────────────────────────
 *
 * Five event types on the `NotificationPreference` model that already exists, and one negatives
 * section on the weekly digest builder that already exists. A second digest service is how two
 * summaries start disagreeing about the same account.
 */

import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import {
  AlertTriangle, Info, WifiOff, ShieldCheck, Bell, BellOff,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import type { NegSlotProps } from './slot-contract'

type LedgerAction = 'created' | 'retired' | 'state-changed'
type LedgerActor = 'user' | 'engine' | 'unattributed' | 'actor-not-recorded'

interface LedgerRow {
  id: string; at: string; action: LedgerAction; actionRaw: string; term: string
  targetGone: boolean; campaignName: string | null; adGroupName: string | null; market: string | null
  actor: LedgerActor; actorLabel: string; reason: string | null; evidence: string | null
  delivery: string
}
interface Refusal { term: string; orders: number; salesCents: number; markets?: string[]; windowDays?: number | null; times: number; lastAt: string }
interface Payload {
  scope: { boundBy: string; market: string; campaignsInScope: number }
  window: { days: number; since: string }
  ledger: {
    rows: LedgerRow[]; total: number
    byActor: Record<LedgerActor, number>
    byAction: Record<LedgerAction, number>
    evidence: { withEvidence: number; total: number; cutover: string | null; note: string }
    unlogged: { negativesWithNoLog: number; negativesTotal: number }
    droppedIfJoinOnly: number
  }
  refusals: {
    protection: { rows: Refusal[]; refusals: number; distinctTerms: number; salesOnRefusedTermsCents: number; sampleExecutions: number; note: string }
    gate: { persisted: boolean; recordedInExecutions: number; note: string }
    cap: { refusals: number; executionsInWindow: number; nullErrorRows: number; brokenClauseMatches: number; blindSpot: number; counterBroken: boolean; note: string }
  }
  alerts: Array<{ key: string; label: string; why: string; inApp: boolean; email: boolean; cadence: string; configured: boolean }>
  digest: { cadence: string; builder: string; consumers: string[]; note: string }
  knownGaps: Array<{ what: string; where: string; consequence: string }>
  coverage: { logRows: number; executionsScanned: number; negativesRead: number }
}

const num = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dayMonth = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()} ${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })}`
}
const ACTOR_LABEL: Record<LedgerActor, string> = {
  user: 'you', engine: 'the engine', unattributed: 'unattributed', 'actor-not-recorded': 'actor not recorded',
}
const ACTION_LABEL: Record<LedgerAction, string> = {
  created: 'created', retired: 'retired', 'state-changed': 'state changed',
}

export function NegRecord({ scope, push }: NegSlotProps) {
  // 🔴 `useSearchParams`, never `window.location.search` — not reactive under soft navigation.
  const params = useSearchParams()
  const tab = (params.get('record') ?? 'refusals') as 'refusals' | 'ledger' | 'alerts'

  const [data, setData] = useState<Payload | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const p = new URLSearchParams({ market: scope.market })
    for (const [k, v] of Object.entries({ line: scope.line, portfolio: scope.portfolio, campaign: scope.campaign, adGroup: scope.adGroup })) if (v) p.set(k, v)
    setLoading(true)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/negatives/record?${p.toString()}`, { cache: 'no-store' })
      if (r.status === 404) {
        const b = await r.json().catch(() => ({} as { code?: string; error?: string }))
        // Our 404 and Fastify's route-missing 404 are both 404 — discriminate on the code.
        throw new Error(b?.code ? String(b.error) : 'This view is not available yet — the record read is not deployed on this environment.')
      }
      if (!r.ok) throw new Error(`Could not load the record (${r.status})`)
      setData((await r.json()) as Payload)
      setErr(null)
    } catch (e) {
      // 🔴 Never `.catch(() => [])`. An empty ledger reads as "nothing has happened", which is both
      // reassuring and very easy to believe.
      setErr((e as Error).message)
      setData(null)
    } finally { setLoading(false) }
  }, [scope.market, scope.line, scope.portfolio, scope.campaign, scope.adGroup])

  useEffect(() => { void load() }, [load])

  const setAlert = async (key: string, inApp: boolean, email: boolean, cadence: string) => {
    if (busy) return
    setBusy(true)
    try {
      await fetch(`${getBackendUrl()}/api/advertising/negatives/alerts`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventType: key, inApp, email, cadence }),
      })
      await load()
    } finally { setBusy(false) }
  }

  if (loading && !data) {
    return (
      <section id="record" className="h10-ngrec">
        <header className="h10-ngrec-head"><h3>The record</h3></header>
        <p className="h10-ngrec-msg">Reading the ledger, the refusals and the notification settings…</p>
      </section>
    )
  }

  // Empty state 4 of 4 — the read failed.
  if (err || !data) {
    return (
      <section id="record" className="h10-ngrec">
        <header className="h10-ngrec-head"><h3>The record</h3></header>
        <p className="h10-ngrec-bad">
          <WifiOff size={13} />
          <span>
            <b>Could not read the record.</b> {err ?? 'The request returned nothing.'} This is a
            failed read, not an empty history — an empty ledger reads as “nothing has happened”, and
            that is both reassuring and very easy to believe.
          </span>
        </p>
      </section>
    )
  }

  const d = data
  const pr = d.refusals.protection
  // 🔴 A zero here means the query failed, not that nothing happened.
  const readFailed = d.coverage.logRows === 0 && d.coverage.executionsScanned === 0

  return (
    <section id="record" className="h10-ngrec">
      <header className="h10-ngrec-head">
        <h3>The record</h3>
        <p>
          What changed, what was <b>refused</b>, and how you hear about it. Last{' '}
          {d.window.days} days.
        </p>
      </header>

      {readFailed ? (
        <p className="h10-ngrec-bad">
          <WifiOff size={13} />
          <span><b>Nothing was read at all.</b> That is a failed query, not a quiet account.</span>
        </p>
      ) : (
        <>
          <div className="h10-ngrec-tabs" role="group" aria-label="Record views">
            {([
              ['refusals', num(pr.refusals), pr.refusals === 1 ? 'refusal' : 'refusals'],
              ['ledger', num(d.ledger.total), 'changes'],
              ['alerts', String(d.alerts.filter((a) => a.inApp || a.email).length), 'alerts on'],
            ] as const).map(([k, n, l]) => (
              <button
                key={k} type="button" className={`h10-ngrec-tab ${tab === k ? 'on' : ''}`}
                aria-pressed={tab === k} onClick={() => push({ record: k })}
              ><b>{n}</b><span>{l}</span></button>
            ))}
          </div>

          {/* ── refusals ──────────────────────────────────────────────────────────────────── */}
          {tab === 'refusals' && (
            <>
              {pr.refusals === 0 ? (
                <p className="h10-ngrec-msg neutral">
                  <b>No negation was refused in this window.</b> {num(pr.sampleExecutions)} executions
                  were read, so this is a real zero rather than an unread one — the protection simply
                  had nothing to stop.
                </p>
              ) : (
                <>
                  <p className="h10-ngrec-hero">
                    <ShieldCheck size={14} />
                    <span>
                      <b>{num(pr.refusals)} negations were refused</b> because the term was earning —
                      across <b>{pr.distinctTerms}</b> terms, in {num(pr.sampleExecutions)} executions
                      read. Every one of these would have blocked a term that was making money
                      {pr.rows[0]?.windowDays ? <> in the {pr.rows[0].windowDays} days before each attempt</> : null}.
                    </span>
                  </p>
                  <ul className="h10-ngrec-ref">
                    {pr.rows.map((r) => (
                      <li key={r.term}>
                        <button type="button" className="lnk" onClick={() => push({ focus: r.term })}>{r.term}</button>
                        <span className="o">{r.orders} {r.orders === 1 ? 'order' : 'orders'}</span>
                        <span className="s">{eur(r.salesCents)}</span>
                        <span className="m">{(r.markets ?? []).join(', ') || '—'}</span>
                        <span className="t">refused {r.times}×</span>
                      </li>
                    ))}
                  </ul>
                  <p className="h10-ngrec-note">
                    <Info size={13} />
                    <span>
                      🔴 <b>{eur(pr.salesOnRefusedTermsCents)} is what those terms made</b>, not what
                      was saved. What the account would have lost had they been negated is unknowable
                      — the same reason the weekly digest counts bid moves and never prices them.
                    </span>
                  </p>
                </>
              )}

              {/* the other two refusal classes, deliberately separate */}
              <div className="h10-ngrec-sub"><b>The other two kinds of refusal</b><span>different problems, different fixes</span></div>
              <ul className="h10-ngrec-other">
                <li>
                  <b>Refused by the daily cap</b>
                  <span className="n">{num(d.refusals.cap.refusals)}</span>
                  <em>
                    Of {num(d.refusals.cap.executionsInWindow)} executions. A rule refused by its own
                    cap is not a failure and not your decision.
                  </em>
                  {/* CAP 2026-08-14 — the healthy branch used to render nothing, so the repair was
                      invisible here. Plain `em`, not `em.bad`: a working brake is not an alarm. */}
                  {d.refusals.cap.counterBroken
                    ? <em className="bad">🔴 {d.refusals.cap.note}</em>
                    : <em>{d.refusals.cap.note}</em>}
                </li>
                <li>
                  <b>Refused by the write gate</b>
                  <span className="n">—</span>
                  <em>🔴 {d.refusals.gate.note}</em>
                  {d.refusals.gate.recordedInExecutions > 0 && (
                    <em>{num(d.refusals.gate.recordedInExecutions)} were recorded incidentally by an execution.</em>
                  )}
                </li>
              </ul>
            </>
          )}

          {/* ── ledger ────────────────────────────────────────────────────────────────────── */}
          {tab === 'ledger' && (
            <>
              {d.ledger.total === 0 ? (
                <p className="h10-ngrec-msg neutral">
                  <b>No negative was created, retired or changed in the last {d.window.days} days.</b>{' '}
                  {num(d.coverage.logRows)} log rows were read, so this is a measured zero. The
                  account holds {num(d.ledger.unlogged.negativesTotal)} negatives; they simply
                  predate the window.
                </p>
              ) : (
                <>
                  <p className="h10-ngrec-note">
                    <Info size={13} />
                    <span>
                      {num(d.ledger.byAction.created)} created · {num(d.ledger.byAction.retired)}{' '}
                      retired · {num(d.ledger.byAction['state-changed'])} state changed, by{' '}
                      {ACTOR_LABEL.user} {num(d.ledger.byActor.user)} · {ACTOR_LABEL.engine}{' '}
                      {num(d.ledger.byActor.engine)} · unattributed {num(d.ledger.byActor.unattributed)}.
                    </span>
                  </p>
                  <ul className="h10-ngrec-led">
                    {d.ledger.rows.slice(0, 40).map((r) => (
                      <li key={r.id}>
                        <span className="w">{dayMonth(r.at)}</span>
                        <span className={`a ${r.action}`}>{ACTION_LABEL[r.action]}</span>
                        <button type="button" className="lnk" onClick={() => push({ focus: r.term })}>{r.term}</button>
                        <span className="c">{r.campaignName ?? (r.targetGone ? 'target removed' : '—')}</span>
                        <span className={`by ${r.actor}`}>{r.actor === 'user' || r.actor === 'engine' ? r.actorLabel : ACTOR_LABEL[r.actor]}</span>
                        <span className="d">{r.delivery}</span>
                        {r.evidence && <span className="ev">{r.evidence}</span>}
                      </li>
                    ))}
                  </ul>
                  {d.ledger.rows.length > 40 && (
                    <p className="h10-ngrec-note"><Info size={13} /><span>Showing the 40 most recent of {num(d.ledger.total)}.</span></p>
                  )}
                </>
              )}
              <p className="h10-ngrec-note">
                <AlertTriangle size={13} />
                <span>
                  <b>{d.ledger.evidence.withEvidence} of {d.ledger.evidence.total} rows carry evidence.</b>{' '}
                  {d.ledger.evidence.note}{' '}
                  🔴 And <b>{num(d.ledger.unlogged.negativesWithNoLog)} of{' '}
                  {num(d.ledger.unlogged.negativesTotal)}</b> negatives have no log at all — that is
                  recorded as <i>unattributed</i>, never guessed at and never backfilled.
                </span>
              </p>
            </>
          )}

          {/* ── alerts ────────────────────────────────────────────────────────────────────── */}
          {tab === 'alerts' && (
            <>
              <ul className="h10-ngrec-alerts">
                {d.alerts.map((al) => (
                  <li key={al.key} className={al.inApp || al.email ? 'on' : ''}>
                    <span className="i">{al.inApp || al.email ? <Bell size={13} /> : <BellOff size={13} />}</span>
                    <span className="l"><b>{al.label}</b><em>{al.why}</em></span>
                    <span className="a">
                      <button
                        type="button" className={`h10-ngrec-tog ${al.inApp ? 'on' : ''}`} disabled={busy}
                        aria-pressed={al.inApp}
                        onClick={() => void setAlert(al.key, !al.inApp, al.email, al.cadence)}
                      >In the app</button>
                      <button
                        type="button" className={`h10-ngrec-tog ${al.email ? 'on' : ''}`} disabled={busy}
                        aria-pressed={al.email}
                        onClick={() => void setAlert(al.key, al.inApp, !al.email, al.cadence)}
                      >Email</button>
                    </span>
                  </li>
                ))}
              </ul>
              <p className="h10-ngrec-note">
                <Info size={13} />
                <span>
                  These use the notification settings this product already has — the bell, the feed
                  and the existing email. Nothing new was built to deliver them.{' '}
                  <b>The digest is {d.digest.cadence}</b>, built by one builder feeding{' '}
                  {d.digest.consumers.join(' and ')}. {d.digest.note}
                </span>
              </p>
            </>
          )}

          {/* ── known gaps, on every tab ──────────────────────────────────────────────────── */}
          <div className="h10-ngrec-sub"><b>Reported, not fixed</b><span>each lives in a file another surface owns</span></div>
          <ul className="h10-ngrec-gaps">
            {d.knownGaps.map((g) => (
              <li key={g.what}>
                <b>{g.what}</b>
                <code>{g.where}</code>
                <em>{g.consequence}</em>
              </li>
            ))}
          </ul>
          <p className="h10-ngrec-note">
            <Info size={13} />
            <span>
              Read over {num(d.coverage.logRows)} log rows and {num(d.coverage.executionsScanned)}{' '}
              executions.{' '}
              <a href="/marketing/ads/rules-automation/automations">Automations</a> holds the
              account-wide version of this ledger; this one is the same query filtered to negatives.
            </span>
          </p>
        </>
      )}
    </section>
  )
}
