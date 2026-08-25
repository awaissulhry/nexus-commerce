'use client'

/**
 * ACR.1.4 — Activity: what automation actually did, and why.
 *
 * The question this whole programme started from was "why did this bid move", and until now it
 * had no surface. The DATA has existed since ADX A2/G6 — `AdvertisingActionLog.evidence` carries
 * the metric, what was observed, the threshold it was measured against, the window and the sample
 * size — but it was written by one path and read by nothing.
 *
 * Deliberately NOT a second change log. `/marketing/ads/changelog` already renders the full
 * account feed with undo, filters and CSV export, and rebuilding that here would be two surfaces
 * over one endpoint drifting apart. This is the automation-scoped slice an operator wants when
 * they are standing in the Control Room — what did the machine do while I was away — with a
 * quiet link out to the full log for everything else.
 *
 * Two facts are kept apart on purpose, because they are genuinely different: what we INTENDED
 * (the field change) and whether Amazon TOOK it (delivery). Collapsing them is how a gated write
 * came to read as a success earlier today.
 */

import { useCallback, useEffect, useState } from 'react'
import { DataGrid, type Column } from '@/design-system/components'
import { Button } from '@/design-system/primitives'
import { AlertTriangle, ExternalLink, Mail, Eye, Send, CheckCircle2, Undo2, ShieldAlert } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

/**
 * ACR.4.3 — "This week", above the feed.
 *
 * The feed answers "what happened to this bid". The rollup answers the question a weekly
 * reviewer actually arrives with: what did the machine do this week, what did it ask me, and
 * what is that worth. Same service the Monday email is built from, so the screen and the inbox
 * cannot disagree about the same week — one builder, two consumers.
 */
interface DigestRule {
  ruleId: string; name: string; level: string
  acted: number; proposed: number; denied: number; applied: number; declined: number; failed: number
}
interface Digest {
  window: { from: string; to: string; label: string; complete: boolean }
  gates: { cronFlag: string; cronEnabled: boolean; outboundFlag: string; outboundEnabled: boolean; state: 'off' | 'dry-run' | 'live'; explanation: string }
  totals: { acted: number; proposed: number; denied: number; applied: number; declined: number; failed: number }
  rules: DigestRule[]
  effect: { budgetDeltaCents: number; budgetMoves: number; bidMoves: number; placementMoves: number; note: string }
  proposals: { pending: number; priced: number; spendAtStakeCents: number; recoverableCents: number }
  graduation: { ready: number; unseen: number; unreviewed: number; readyNames: string[]; unseenNames: string[] }
  breaker: {
    tripsThisWeek: Array<{ at: string; reason: string }>
    maxActionsPerHour: number
    maxHourlySpendCents: number
    spendThresholdIsDefault: boolean
    peakHourSpendCents: number
    peakHoursSampled: number
    tripNote: string
    spendNote: string
  }
  coverage: { marketplace: string; week: string | null; priorWeek: string | null; share: number | null; priorShare: number | null; deltaPct: number | null; terms: number; measured: boolean; note: string } | null
  delivery: { failedWrites: number; deadLetters: number }
}

const eur = (cents: number) =>
  new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR' }).format(cents / 100)

interface Change {
  id: string
  at: string
  actor: string | null
  source: string
  origin: { kind: string; id: string | null; name: string | null }
  entity: { type: string; id: string; name: string | null }
  campaign: { id: string; name: string | null } | null
  field: string
  oldValue: string | null
  newValue: string | null
  reason: string | null
  evidence: Record<string, unknown> | null
  delivery: { state: string; attempts: number; lastError: string | null } | null
  undoable: boolean
  undoActionLogId: string | null
  undoBlockedReason?: string
}

const when = (iso: string) => {
  const d = new Date(iso)
  const mins = Math.floor((Date.now() - d.getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const h = Math.floor(mins / 60)
  return h < 24 ? `${h}h ago` : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

/** The numbers behind the prose. Absent on most writers still — that is normal, not an error. */
function Evidence({ e }: { e: Record<string, unknown> }) {
  const metric = e.metric as string | undefined
  const observed = e.observed as number | null | undefined
  const threshold = e.threshold as number | null | undefined
  const sample = e.sampleSize as number | null | undefined
  const unit = (e.sampleUnit as string | undefined) ?? 'rows'
  const target = e.targetKey as string | undefined
  if (!metric && observed == null && !target) return null
  return (
    <span className="acr-ev">
      {target && <span className="acr-ev-k">{target}</span>}
      {metric && (
        <span>
          {metric}
          {observed != null && <> <strong>{observed}</strong></>}
          {threshold != null && <> vs {threshold}</>}
        </span>
      )}
      {/* Thin evidence is flagged rather than hidden: a decision resting on 3 days of data
          must not look identical to one resting on 56. */}
      {sample != null && (
        <span className={sample < 7 && unit === 'days' ? 'thin' : undefined}>
          {sample} {unit}{sample < 7 && unit === 'days' ? ' — thin' : ''}
        </span>
      )}
    </span>
  )
}

/** The week's rollup + the digest that will carry it. */
function ThisWeek({ d, onSend, sending, sent }: {
  d: Digest
  onSend: () => void
  sending: boolean
  sent: string | null
}) {
  const t = d.totals
  const g = d.graduation
  const c = d.coverage
  const api = getBackendUrl()

  return (
    <section className="acr-week">
      <div className="acr-sec-head">
        <h2>This week</h2>
        <span className="acr-sec-count">
          {d.window.label}{d.window.complete ? '' : ' · still running'}
        </span>
      </div>

      <div className="acr-week-tiles">
        <div className="acr-week-tile">
          <span className="k">Acted</span>
          <b>{t.acted.toLocaleString('en-IE')}</b>
          <span className="s">{t.proposed.toLocaleString('en-IE')} proposed</span>
        </div>
        <div className="acr-week-tile">
          <span className="k">You decided</span>
          <b>{(t.applied + t.denied).toLocaleString('en-IE')}</b>
          <span className="s">{t.applied} applied · {t.denied} declined</span>
        </div>
        <div className={`acr-week-tile${d.effect.budgetDeltaCents < 0 ? ' good' : ''}`}>
          <span className="k">Daily budget</span>
          <b>{d.effect.budgetDeltaCents >= 0 ? '+' : '−'}{eur(Math.abs(d.effect.budgetDeltaCents))}</b>
          <span className="s">over {d.effect.budgetMoves.toLocaleString('en-IE')} changes</span>
        </div>
        <div className={`acr-week-tile${d.proposals.recoverableCents > 0 ? ' warn' : ''}`}>
          <span className="k">Waiting on you</span>
          <b>{d.proposals.pending.toLocaleString('en-IE')}</b>
          <span className="s">{eur(d.proposals.recoverableCents)} pure waste</span>
        </div>
        {c && c.share != null && (
          <div className="acr-week-tile">
            <span className="k">Coverage {c.marketplace}</span>
            <b>{(c.share * 100).toFixed(2)}%</b>
            <span className="s">
              {c.deltaPct != null
                ? `${c.deltaPct >= 0 ? '+' : ''}${c.deltaPct.toFixed(2)}pp vs ${c.priorWeek}`
                : 'no prior week yet'}
            </span>
          </div>
        )}
        {t.failed > 0 && (
          <div className="acr-week-tile bad">
            <span className="k">Failed</span>
            <b>{t.failed.toLocaleString('en-IE')}</b>
            <span className="s">real failures</span>
          </div>
        )}
      </div>

      {/* Bid moves are counted, never priced. Saying so once, here, is what stops the budget
          figure above being read as "the total effect of automation this week". */}
      <p className="acr-week-note">{d.effect.note}</p>

      {/*
        ACR.4.3 — the breaker. A trip HALTS every engine until resumed, so it is the loudest thing
        that can happen to this account and it left no durable record anywhere. Shown whenever it
        fired, and also when its spend limit is the unset code default — a guard set above
        anything the account can do is not protecting anything, and only a number next to a
        measurement makes that visible.
      */}
      {d.breaker.tripsThisWeek.length > 0 && (
        <div className="acr-breaker tripped">
          <ShieldAlert size={14} />
          <div>
            <strong>
              The breaker tripped {d.breaker.tripsThisWeek.length === 1 ? 'once' : `${d.breaker.tripsThisWeek.length} times`} this week.
            </strong>
            {d.breaker.tripsThisWeek.map((t) => (
              <div key={t.at} className="acr-breaker-trip">
                {new Date(t.at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} — {t.reason}
              </div>
            ))}
            <p>{d.breaker.tripNote}</p>
          </div>
        </div>
      )}
      {d.breaker.spendThresholdIsDefault && (
        <div className="acr-breaker">
          <ShieldAlert size={14} />
          <div>
            <strong>Ad spend has no operator-set hourly limit.</strong>
            <p>{d.breaker.spendNote}</p>
          </div>
        </div>
      )}

      {(g.ready > 0 || g.unseen > 0) && (
        <p className={`acr-week-grad ${g.ready > 0 ? 'ready' : 'unseen'}`}>
          {g.ready > 0
            ? <><strong>{g.ready} ready to graduate:</strong> {g.readyNames.join(' · ')}.</>
            : <><strong>{g.unseen} never queued a proposal:</strong> {g.unseenNames.join(' · ')} — so no evidence can accumulate.</>}
        </p>
      )}

      {d.rules.length > 0 && (
        <DataGrid<DigestRule>
          className="acr-week-table"
          rows={d.rules.slice(0, 12)}
          rowKey={(r) => r.ruleId}
          rowClassName={(r) => (r.failed > 0 ? 'failed' : undefined)}
          columns={WEEK_COLUMNS}
        />
      )}
      {d.rules.length > 12 && (
        <p className="acr-week-note">{d.rules.length - 12} more rules ran this week; the twelve busiest are shown.</p>
      )}

      {/* The engine declining itself is not the operator declining it, and neither is a
          failure. Kept out of the table so the three columns above stay comparable. */}
      {t.declined > 0 && (
        <p className="acr-week-note">
          {t.declined.toLocaleString('en-IE')}{' '}runs were declined by the engine&rsquo;s own daily cap — the engine
          refusing itself, not a failure and not your decision. Almost all of these are the self-ratcheting
          cap bug fixed on 4 August; the count should fall to near zero from this week on.
        </p>
      )}

      {/*
        ACR.4.2 — the gate, surfaced rather than flipped. The operator asked to decide from here
        after reading a real digest, so this states exactly what is true right now and offers
        both a preview and a test send that go through the identical code path Monday will use.
      */}
      <div className={`acr-digest ${d.gates.state}`}>
        <div className="acr-digest-head">
          <Mail size={14} />
          <strong>
            Weekly digest — {d.gates.state === 'off' ? 'not scheduled' : d.gates.state === 'dry-run' ? 'scheduled, nothing leaves' : 'scheduled and sending'}
          </strong>
        </div>
        <p>{d.gates.explanation}</p>
        <p className="acr-digest-flags">
          <code>{d.gates.cronFlag}</code> {d.gates.cronEnabled ? 'on' : 'not set'}
          {' · '}
          <code>{d.gates.outboundFlag}</code> {d.gates.outboundEnabled ? 'on' : 'not true'}
        </p>
        <div className="acr-digest-actions">
          <Button asChild size="sm">
            <a href={`${api}/api/advertising/digest/weekly/preview?mode=previous`} target="_blank" rel="noopener noreferrer">
              <Eye size={13} /> Preview last week&rsquo;s
            </a>
          </Button>
          <Button size="sm" onClick={onSend} disabled={sending}>
            <Send size={13} /> {sending ? 'Sending…' : 'Send me a test'}
          </Button>
          {sent && <span className="acr-digest-sent"><CheckCircle2 size={13} /> {sent}</span>}
        </div>
      </div>
    </section>
  )
}

/** The week rollup, as DS `DataGrid` columns. The failure count moves to a ROW class, because
 *  `Column` styles a cell by `align` only — see the note in .claude/DS-GAPS.md. */
const WEEK_COLUMNS: Array<Column<DigestRule>> = [
  { key: 'rule', label: 'Rule', render: (r) => <>{r.name}</> },
  { key: 'mode', label: 'Mode', render: (r) => <span className={`acr-mode ${r.level.toLowerCase()}`}>{r.level}</span> },
  { key: 'acted', label: 'Acted', align: 'right', render: (r) => <>{r.acted || '—'}</> },
  { key: 'proposed', label: 'Proposed', align: 'right', render: (r) => <>{r.proposed || '—'}</> },
  { key: 'applied', label: 'You applied', align: 'right', render: (r) => <>{r.applied || '—'}</> },
  { key: 'denied', label: 'You declined', align: 'right', render: (r) => <>{r.denied || '—'}</> },
  { key: 'failed', label: 'Failed', align: 'right', render: (r) => <>{r.failed || '—'}</> },
]

export function ActivityTab() {
  const [rows, setRows] = useState<Change[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [digest, setDigest] = useState<Digest | null>(null)
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState<string | null>(null)
  const [digestErr, setDigestErr] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [undoing, setUndoing] = useState<string | null>(null)
  const [undoMsg, setUndoMsg] = useState<{ id: string; ok: boolean; text: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes?source=automation&limit=60`, { cache: 'no-store' })
      if (!r.ok) throw new Error(`changes: ${r.status}`)
      const j = await r.json()
      setRows(Array.isArray(j?.items) ? (j.items as Change[]) : [])
      setErr(null)
    } catch (e) { setErr((e as Error).message); setRows([]) }
    // The rollup is a separate read and fails soft: the change feed is the tab's reason to
    // exist and must render whether or not the week can be summarised.
    try {
      const w = await fetch(`${getBackendUrl()}/api/advertising/digest/weekly?mode=current`, { cache: 'no-store' })
      if (!w.ok) throw new Error(String(w.status))
      setDigest((await w.json()) as Digest)
      setDigestErr(null)
    } catch (e) { setDigest(null); setDigestErr((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])

  const sendTest = useCallback(async () => {
    setSending(true); setSent(null)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/digest/weekly/send`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'previous' }),
      })
      const j = (await r.json()) as { status?: string; reason?: string; recipients?: string[] }
      // A DRY_RUN is not a failure and must not be reported as a success either — the whole
      // point of this button is telling the operator which of the two just happened.
      setSent(
        j.status === 'SENT' ? `Sent to ${(j.recipients ?? []).join(', ')}`
          : j.status === 'DRY_RUN' ? 'Built and logged — nothing was mailed (outbound email is off)'
            : j.reason ?? j.status ?? 'Unknown result',
      )
    } catch (e) { setSent((e as Error).message) } finally { setSending(false) }
  }, [])

  /**
   * Undo one change. The server re-checks everything this UI checked — window, already-undone,
   * whether it reached Amazon — so a race (the row ageing out while the confirm is open, or a
   * second tab undoing it first) comes back as a refusal rather than a wrong write. Its words
   * are shown verbatim, because it knows why and the client is only guessing.
   */
  const doUndo = useCallback(async (c: Change) => {
    if (!c.undoActionLogId) return
    setUndoing(c.id)
    try {
      const r = await fetch(`${getBackendUrl()}/api/advertising/changes/${c.undoActionLogId}/undo`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'undone from the Control Room activity feed' }),
      })
      const j = (await r.json()) as { ok?: boolean; reversed?: number; reason?: string }
      const ok = r.ok && j.ok !== false && (j.reversed ?? 0) > 0
      setUndoMsg({ id: c.id, ok, text: ok ? 'Reversed — the previous value is on its way back to Amazon.' : (j.reason ?? `Could not undo (${r.status}).`) })
      setConfirming(null)
      if (ok) await load()
    } catch (e) {
      setUndoMsg({ id: c.id, ok: false, text: (e as Error).message })
    } finally { setUndoing(null) }
  }, [load])

  if (err) return <div className="acr-banner err" role="alert"><AlertTriangle size={15} /> {err}</div>
  if (rows === null) return <div className="acr-empty">Loading…</div>

  return (
    <div className="acr-activity">
      {/* The rollup aggregates a week of executions, prices 150 proposals and reads two weeks of
          coverage — a few seconds even warm. Without this the section simply is not there while
          it loads, which reads as "there is no rollup" rather than "it is coming". */}
      {digest
        ? <ThisWeek d={digest} onSend={() => void sendTest()} sending={sending} sent={sent} />
        : digestErr
          ? <div className="acr-banner warn"><AlertTriangle size={15} /> This week&rsquo;s rollup could not be built ({digestErr}). The change feed below is unaffected.</div>
          : <div className="acr-empty">Summarising this week…</div>}

      <div className="acr-sec-head">
        <h2>What automation did</h2>
        <span className="acr-sec-count">
          {rows.length ? `last ${rows.length} automated changes` : ''}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="acr-empty">
          No automated changes recorded in this window. That is a real state, not an error —
          every engine may simply be off or holding.
        </div>
      ) : (
        <ul className="acr-changes">
          {rows.map((c) => (
            <li key={c.id} className="acr-change">
              <div className="acr-change-head">
                <span className="acr-change-what">
                  <strong>{c.field}</strong>
                  {c.oldValue != null && c.newValue != null && (
                    <span className="acr-delta">{c.oldValue} → {c.newValue}</span>
                  )}
                </span>
                {/* Intent and delivery are separate facts. A change we made and a change
                    Amazon took are not the same thing. */}
                {c.delivery && (
                  <span className={`acr-deliv ${c.delivery.state.toLowerCase()}`} title={c.delivery.lastError ?? undefined}>
                    {c.delivery.state}
                  </span>
                )}
                <span className="acr-change-when">{when(c.at)}</span>
              </div>
              <div className="acr-change-sub">
                {c.origin.name ?? c.actor ?? 'system'}
                {c.campaign?.name ? ` · ${c.campaign.name}` : c.entity.name ? ` · ${c.entity.name}` : ''}
              </div>
              {c.reason && <div className="acr-change-why">{c.reason}</div>}
              {c.evidence && <Evidence e={c.evidence} />}

              {/*
                ACR.4.3 — reversibility, on the row that did the thing.
                Two-step on purpose: this writes to Amazon, restoring a value the engine has
                since moved on from, and a single mis-click on a feed you are SCROLLING is the
                easiest way to cause the incident this button exists to fix. The confirm names
                the value it will put back so the decision is made on the number, not the verb.
              */}
              {c.undoable && c.undoActionLogId && (
                confirming === c.id ? (
                  <div className="acr-undo confirming">
                    <span>
                      Put <strong>{c.field}</strong> back to <strong>{c.oldValue ?? 'its previous value'}</strong>?
                      This writes to Amazon.
                    </span>
                    {/* 🔴 NOT `variant="danger"`. This red is #a3342b — white on it measures
                        6.81:1, where the DS token (#c0392b) measures 5.44:1. Both pass AA, but a
                        substitution may only ever RAISE contrast, so the commit step keeps its own
                        colour until the DS token is darkened. Filed in .claude/DS-GAPS.md. */}
                    <button type="button" className="acr-undo-btn go" disabled={undoing === c.id} onClick={() => void doUndo(c)}>
                      {undoing === c.id ? 'Undoing…' : 'Yes, undo'}
                    </button>
                    <Button size="xs" onClick={() => setConfirming(null)}>Cancel</Button>
                  </div>
                ) : (
                  <div className="acr-undo">
                    <Button size="xs" onClick={() => { setConfirming(c.id); setUndoMsg(null) }}>
                      <Undo2 size={12} /> Undo
                    </Button>
                    {undoMsg?.id === c.id && <span className={`acr-undo-msg ${undoMsg.ok ? 'ok' : 'bad'}`}>{undoMsg.text}</span>}
                  </div>
                )
              )}
              {/* A row that cannot be reversed says why, rather than simply lacking a control —
                  the difference between "not allowed" and "not built". */}
              {!c.undoable && c.undoBlockedReason && (
                <div className="acr-undo blocked">{c.undoBlockedReason}</div>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="acr-foot">
        This is the automation-scoped slice.{' '}
        <a href="/marketing/ads/changelog" target="_blank" rel="noopener noreferrer" className="acr-link">
          The full account change log <ExternalLink size={11} />
        </a>{' '}
        carries operator changes, filters, undo and CSV export.
      </p>
    </div>
  )
}
