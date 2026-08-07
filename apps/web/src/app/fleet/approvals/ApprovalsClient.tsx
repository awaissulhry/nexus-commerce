'use client'

/**
 * NAF.AQ.1 — the Approvals page.
 *
 * Study: docs/2026-08-07-naf-aq-approvals-page.md. The page's whole reason to
 * be a page rather than the panel it grew out of is AQ-S2, the gate state: an
 * empty approvals queue and a broken approvals pipe look identical, and today
 * it is the pipe. Three independent walls stop anything arriving —
 *
 *   1. the three fleet propose-tools are preview-only, so `runOrQueueTool`
 *      creates no row and an approve could not reach Amazon either;
 *   2. six of seven charters cap below PROPOSE, the only dial that queues;
 *   3. `executeCharter` never calls the queueing path at all, so only the
 *      weekly council can produce a request — not a sweep, not an `ask`, not
 *      an assignment.
 *
 * — and none of them is visible anywhere in the product. S2 is the section
 * that says so, and it is deliberately the first thing under the promise.
 *
 * The QUEUE ITSELF is the shipped `<ApprovalInbox>` (AP.1–AP.8), imported
 * unmodified. That is the point: one decision surface, not two. AQ.3/AQ.4
 * rebuild the card in this directory and this import goes away; until then the
 * page is the panel plus the truth, which is strictly better than either.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  Info,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import {
  ApprovalInbox,
  type ApprovalRow,
  type InboxCounts,
  type InboxView,
  type PrecedentRow,
} from '@/app/marketing/ads/rules-automation/fleet/ApprovalInbox'
import { DecisionCard } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import type { StoryPlan } from '@/app/marketing/ads/rules-automation/fleet/PlanStory'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'

/* ── the gate-state contract (agent-fleet-approvals.routes.ts) ─────────── */

interface GateWorker {
  key: string
  name: string
  autonomyLevel: string
  autonomyCap: string
  enabled: boolean
  provisioned: boolean
  couldEverPropose: boolean
  proposesNow: boolean
}

interface GateTool {
  name: string
  canExecute: boolean
  requiresApproval: boolean
  riskTier: string
  isFleetTool: boolean
}

interface GateState {
  halted: boolean
  haltReason: string | null
  canAnythingArrive: boolean
  blockers: string[]
  workers: GateWorker[]
  tools: GateTool[]
  arrival: {
    councilNext: string | null
    councilEnabled: boolean
    councilSchedule: string | null
    sweepNext: string | null
    sweepEnabled: boolean
    sweepCanQueue: boolean
  }
  expiry: {
    hours: number
    maintenanceSeconds: number
    runsWhileFleetIsOff: boolean
    lastMaintenance: { startedAt: string; status: string; outputSummary: string | null } | null
  }
  outside: { pending: number; byTool: Array<{ toolName: string; count: number }> }
}

interface CharterRow {
  key: string
  name: string
}

const humanTool = (s: string) => s.replace(/-/g, ' ')

function whenNext(iso: string | null): string {
  if (!iso) return 'not scheduled'
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return 'due now'
  const h = Math.floor(ms / 3_600_000)
  if (h < 1) return `in ${Math.max(1, Math.round(ms / 60_000))} min`
  if (h < 48) return `in ${h}h`
  return `in ${Math.round(h / 24)} days`
}

/* ── S1 · the standing promise ─────────────────────────────────────────── */

/**
 * Two sentences that must survive a FULL queue, which is why they are not
 * inside the empty state: the empty state disappears exactly when volume makes
 * rubber-stamping tempting.
 */
function StandingPromise() {
  return (
    <p className="aq-promise">
      <ShieldCheck size={14} aria-hidden />
      <span>
        <strong>Nothing on this page has happened yet.</strong> Every card is something one of
        your AI workers <em>wants</em> to do — and nothing the fleet proposes reaches Amazon
        unless you say yes here.
      </span>
    </p>
  )
}

/* ── S1 · how this works, as a drawer rather than a wall of text ───────── */

function HowThisWorks({ gate }: { gate: GateState | null }) {
  const [open, setOpen] = useState(false)
  const hours = gate?.expiry.hours ?? 24
  return (
    <div className="aq-how">
      <button className="acr-fl-checkstoggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        How approvals work
      </button>
      {open ? (
        <div className="aq-howbody">
          <p>
            <strong>Who is allowed to ask you.</strong> Only a worker whose dial is set to{' '}
            <Term k="propose">PROPOSE</Term>. A worker at <Term k="observe">OBSERVE</Term> can
            look and report but never ask, and one that is <Term k="off">OFF</Term> does not run
            at all.
          </p>
          <p>
            <strong>What was already refused before you saw it.</strong> Every proposal passes
            the <Term k="critic">critic</Term> first — an adversarial reviewer whose job is to
            find reasons to say no. Code-computed safety blocks are final; the critic can add a
            block but never remove one. What reaches you has already survived that.
          </p>
          <p>
            <strong>What happens the moment you say yes.</strong> Nothing, for twenty seconds.
            Your decision is recorded immediately — attributable and durable — but the action
            waits out the <Term k="undo-window">undo window</Term>, and one click takes it back.
            Close the tab and it still runs; only the execution waits, never the decision.
          </p>
          <p>
            <strong>What happens if you say nothing.</strong> The request expires {hours} hours
            after it was asked, and expiry always means <em>refused</em> — never
            approved-because-nobody-looked. The clock is swept every{' '}
            {gate?.expiry.maintenanceSeconds ?? 30} seconds, and that sweep keeps running even
            when the whole fleet is switched off, because turning the fleet off must not strand a
            decision you already took.
          </p>
          <p>
            <strong>Whose name goes on the record.</strong> Yours, from the moment you decide.
            Decisions taken before this system existed carry no name and say so plainly rather
            than inventing one.
          </p>
          <p>
            <strong>What this page cannot do.</strong> It cannot change what a worker is allowed
            to do — that is <Link href="/fleet/controls">Controls</Link>. It cannot re-run
            anything, or show you the story around a decision — that is{' '}
            <Link href="/fleet/activity">Activity</Link>. And it cannot yet let you amend a
            proposal before approving it; today a number you disagree with has to be rejected.
          </p>
        </div>
      ) : null}
    </div>
  )
}

/* ── S2 · can anything reach this queue? ───────────────────────────────── */

/**
 * The section only this page can host. Controls knows the dials, Overview
 * knows the schedule, and NOTHING anywhere knows whether the actions a worker
 * can propose are able to run. Joined here, they answer the one question an
 * empty queue always raises.
 *
 * It collapses to a single line when the pipe is open, and expands when it is
 * not — the inverse of the queue-shape strip, so exactly one of the two is
 * ever large.
 */
function GateStateSection({ gate }: { gate: GateState | null }) {
  const [open, setOpen] = useState(true)
  if (!gate) return null

  const proposing = gate.workers.filter((w) => w.proposesNow)
  const couldEver = gate.workers.filter((w) => w.couldEverPropose)
  const fleetTools = gate.tools.filter((t) => t.isFleetTool)
  const executable = fleetTools.filter((t) => t.canExecute)

  if (gate.canAnythingArrive) {
    return (
      <p className="aq-gate-ok">
        <Check size={13} aria-hidden />
        The gate is open: {proposing.length} worker{proposing.length === 1 ? '' : 's'} can ask you
        for something, and the next chance is the weekly council {whenNext(gate.arrival.councilNext)}.
      </p>
    )
  }

  return (
    <section className="aq-gate" aria-labelledby="aq-gate-h">
      <button
        className="aq-gate-head"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        id="aq-gate-h"
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <CircleSlash size={14} aria-hidden />
        <span>
          <strong>Nothing can reach this queue right now.</strong> An empty queue and a blocked
          one look the same, so here is which it is.
        </span>
      </button>

      {open ? (
        <div className="aq-gate-body">
          <ol className="aq-blockers">
            {gate.blockers.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ol>

          <div className="aq-gate-grid">
            <div>
              <h4>Who could ask</h4>
              <p className="aq-gate-num">
                {proposing.length} of {gate.workers.length}
              </p>
              <p className="aq-gate-sub">
                set to <Term k="propose">PROPOSE</Term> — the only setting that puts a request
                here. {couldEver.length} of {gate.workers.length} could ever be; the rest are
                capped lower in code, and a <Term k="cap">cap</Term> is a ceiling the dial cannot
                pass.
              </p>
              <Link className="aq-gate-link" href="/fleet/workers">
                See the workers →
              </Link>
            </div>

            <div>
              <h4>Whether their actions can run</h4>
              <p className="aq-gate-num">
                {executable.length} of {fleetTools.length}
              </p>
              <p className="aq-gate-sub">
                of the actions the fleet can propose are able to run.{' '}
                {executable.length === 0 ? (
                  <>
                    All of them produce a <Term k="preview-only">preview only</Term>, so nothing
                    can be queued for you — and approving one would record your decision and
                    change nothing on Amazon. This is the part no other page will tell you.
                  </>
                ) : null}
              </p>
              <ul className="aq-toollist">
                {fleetTools.map((t) => (
                  <li key={t.name}>
                    <span className={t.canExecute ? 'aq-can' : 'aq-cannot'}>
                      {t.canExecute ? 'can run' : 'preview only'}
                    </span>
                    {humanTool(t.name)}
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h4>When one could appear</h4>
              <p className="aq-gate-num">{whenNext(gate.arrival.councilNext)}</p>
              <p className="aq-gate-sub">
                the weekly <Term k="council">council</Term>, and nothing else. A nightly{' '}
                <Term k="sweep">sweep</Term> cannot queue a request, and neither can a one-off
                run — only the council reaches the part of the code that asks you.
              </p>
            </div>

            <div>
              <h4>If you never answer</h4>
              <p className="aq-gate-num">{gate.expiry.hours}h</p>
              <p className="aq-gate-sub">
                then the request expires, and expiry means <strong>refused</strong> — never
                approved because nobody looked. Checked every {gate.expiry.maintenanceSeconds}{' '}
                seconds, and that check keeps running even with the fleet switched off, so a
                decision you already took is never stranded.
              </p>
            </div>
          </div>

          {gate.outside.pending > 0 ? (
            <p className="aq-outside">
              <AlertTriangle size={13} aria-hidden />
              <span>
                <strong>
                  {gate.outside.pending} request{gate.outside.pending === 1 ? '' : 's'} from
                  outside the fleet {gate.outside.pending === 1 ? 'is' : 'are'} waiting and{' '}
                  {gate.outside.pending === 1 ? 'is' : 'are'} not shown below.
                </strong>{' '}
                {gate.outside.byTool.map((t) => `${t.count} × ${humanTool(t.toolName)}`).join(', ')}.
                These come from the older agent system, they can genuinely change something, and
                the list below only shows the fleet&apos;s own three actions. They will expire in{' '}
                {gate.expiry.hours} hours if nobody answers them.
              </span>
            </p>
          ) : null}

          {gate.halted ? (
            <p className="aq-outside">
              <AlertTriangle size={13} aria-hidden />
              <span>
                The whole fleet is halted{gate.haltReason ? ` — ${gate.haltReason}` : ''}. No
                worker runs at all until it is released on{' '}
                <Link href="/fleet/controls">Controls</Link>.
              </span>
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}

/* ── S5 · waiting from outside the fleet ───────────────────────────────── */

interface OutsideRow {
  id: string
  toolName: string
  riskTier: string
  status: string
  args: Record<string, unknown>
  preview: Record<string, unknown> | null
  requestedAt: string
  expiresAt: string | null
  executeAfter: string | null
  reason: string | null
  decidedBy: string | null
  originKey: string | null
  canExecute: boolean
  trackRecord: null
}

/**
 * A parked row for the outside queue.
 *
 * Deliberately a second, smaller implementation of the shipped `ScheduledRow`:
 * that one is not exported, and this stream committed not to edit the file it
 * lives in while the Overview still renders it. AQ.3 moves the card into this
 * directory and the two become one — recorded here so the duplication is a
 * decision with an end date rather than an accident.
 */
function OutsideParked({
  row,
  busy,
  onUndo,
  onCommit,
}: {
  row: OutsideRow
  busy: boolean
  onUndo: (id: string) => void
  onCommit: (id: string) => void
}) {
  const until = row.executeAfter ? new Date(row.executeAfter).getTime() : 0
  const [left, setLeft] = useState(() => Math.max(0, Math.ceil((until - Date.now()) / 1000)))
  const fired = useRef(false)

  useEffect(() => {
    if (!until) return
    const t = setInterval(() => {
      const secs = Math.max(0, Math.ceil((until - Date.now()) / 1000))
      setLeft(secs)
      if (secs === 0 && !fired.current) {
        fired.current = true
        onCommit(row.id)
      }
    }, 500)
    return () => clearInterval(t)
  }, [until, row.id, onCommit])

  return (
    <div className="aq-outparked">
      <span className="aq-outparkedbody">
        <strong>Approved — {humanTool(row.toolName)}</strong>
        <span>
          {left > 0 ? (
            <>
              Running in {left} second{left === 1 ? '' : 's'} — the{' '}
              <Term k="undo-window">undo window</Term>. Nothing has happened yet.
            </>
          ) : (
            'Running now…'
          )}
        </span>
      </span>
      {left > 0 ? (
        <button className="acr-btn" disabled={busy} onClick={() => onUndo(row.id)}>
          <Undo2 size={13} /> Undo
        </button>
      ) : null}
    </div>
  )
}

function OutsideQueue({
  rows,
  busy,
  expiryHours,
  onDecide,
  onUndo,
  onCommit,
}: {
  rows: OutsideRow[]
  busy: boolean
  expiryHours: number
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onUndo: (id: string) => void
  onCommit: (id: string) => void
}) {
  const [open, setOpen] = useState(true)

  // Empty is the normal state and should cost one line, not a card.
  if (rows.length === 0) {
    return (
      <p className="aq-outnone">
        <ShieldCheck size={12} aria-hidden />
        Nothing is waiting from outside the fleet either. Requests from the older agent system
        would appear here — they are the only ones that can change something on Amazon today.
      </p>
    )
  }

  return (
    <section className="acr-card aq-outside-card" aria-labelledby="aq-out-h">
      <button
        className="aq-outhead"
        id="aq-out-h"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <AlertTriangle size={14} aria-hidden />
        <span>
          <strong>
            {rows.length} request{rows.length === 1 ? '' : 's'} from outside the fleet
          </strong>{' '}
          — and unlike everything above, {rows.length === 1 ? 'it can' : 'these can'} actually
          change something.
        </span>
      </button>

      {open ? (
        <div className="aq-outbody">
          <p className="aq-outwhy">
            These come from the older agent system, not from a fleet worker. They were reaching{' '}
            <strong>no screen at all</strong> until now — the queue above only shows the fleet&apos;s
            own three actions, while the clock that expires requests covers every action. So one of
            these could be created, seen by nobody, and thrown away after {expiryHours} hours.
            Deciding one here records your name, gives you the same twenty-second{' '}
            <Term k="undo-window">undo window</Term>, and re-checks the facts before it runs.
          </p>

          {rows.map((a) =>
            a.status === 'scheduled' ? (
              <OutsideParked
                key={a.id}
                row={a}
                busy={busy}
                onUndo={onUndo}
                onCommit={onCommit}
              />
            ) : (
              <div key={a.id} className="aq-outrow">
                <p className="aq-outorigin">
                  {a.originKey ? (
                    <>
                      Asked by <code>{a.originKey}</code> — an agent from before the fleet, so
                      there is no worker page and no track record for it.
                    </>
                  ) : (
                    <>The agent that asked for this cannot be identified.</>
                  )}
                </p>
                <DecisionCard
                  approval={{
                    id: a.id,
                    toolName: a.toolName,
                    charterKey: null,
                    riskTier: a.riskTier,
                    args: a.args,
                    preview: a.preview,
                    requestedAt: a.requestedAt,
                    expiresAt: a.expiresAt,
                    reason: a.reason,
                    trackRecord: null,
                  }}
                  workerName={a.originKey ? humanTool(a.originKey) : 'An agent we cannot identify'}
                  plans={[]}
                  busy={busy}
                  onDecide={onDecide}
                  onOpenPlan={() => {}}
                />
              </div>
            ),
          )}
        </div>
      ) : null}
    </section>
  )
}

/* ── the page ──────────────────────────────────────────────────────────── */

export function ApprovalsClient() {
  const backend = getBackendUrl()

  const [view, setView] = useState<InboxView>('waiting')
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [counts, setCounts] = useState<InboxCounts>({ waiting: 0, decided: 0, expired: 0 })
  const [precedents, setPrecedents] = useState<PrecedentRow[]>([])
  const [plans, setPlans] = useState<StoryPlan[]>([])
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [gate, setGate] = useState<GateState | null>(null)
  const [outside, setOutside] = useState<OutsideRow[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, pr, p, c, g, o] = await Promise.all([
      fetch(`${backend}/api/agent/fleet/approvals?view=${view}`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/precedents?limit=25`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/plans`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/gate-state`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/outside`, { cache: 'no-store' }),
    ])
    if (!a.ok) throw new Error(`approvals: ${a.status}`)
    const aj = (await a.json()) as { approvals: ApprovalRow[]; counts: InboxCounts }
    setApprovals(aj.approvals)
    setCounts(aj.counts)
    if (pr.ok) setPrecedents(((await pr.json()) as { precedents: PrecedentRow[] }).precedents)
    if (p.ok) setPlans(((await p.json()) as { plans: StoryPlan[] }).plans)
    if (c.ok) setCharters(((await c.json()) as { charters: CharterRow[] }).charters)
    // The gate state is the page's reason to exist, but it must never be able
    // to take the queue down with it.
    if (g.ok) setGate((await g.json()) as GateState)
    // AQ.2 — the only rows on this page that can reach Amazon.
    if (o.ok) setOutside(((await o.json()) as { approvals: OutsideRow[] }).approvals)
    setErr(null)
    setLoading(false)
  }, [backend, view])

  const { asOf, refresh } = useVisibilityPoll(
    useCallback(async () => {
      try {
        await load()
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e))
        setLoading(false)
        throw e
      }
    }, [load]),
  )

  // Switching tab must refetch immediately rather than waiting for the poll.
  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view])

  const post = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true)
      try {
        const r = await fetch(`${backend}/api/agent/fleet/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        })
        const d = (await r.json().catch(() => null)) as
          | { error?: string; sentence?: string }
          | null
        if (!r.ok) setErr(d?.error ?? `${path}: ${r.status}`)
        return d
      } finally {
        setBusy(false)
      }
    },
    [backend],
  )

  const after = useCallback(async () => {
    refresh()
  }, [refresh])

  const decide = useCallback(
    async (id: string, decision: 'approve' | 'reject', reason?: string) => {
      await post(`approvals/${id}/decide`, { decision, reason })
      await after()
    },
    [post, after],
  )

  const nameByKey = useMemo(
    () => new Map(charters.map((c) => [c.key, c.name])),
    [charters],
  )

  return (
    <>
      <StandingPromise />
      <HowThisWorks gate={gate} />

      {err ? (
        <p className="acr-fl-empty aq-err" role="alert">
          <AlertTriangle size={13} aria-hidden /> {err}
        </p>
      ) : null}

      <GateStateSection gate={gate} />

      <section className="acr-card aq-queue" aria-label="Approvals">
        <div className="acr-cardhead">
          <h3>
            {view === 'waiting'
              ? 'Waiting for you'
              : view === 'decided'
                ? /* NOT "what you already decided" — every row in there today says
                     "nobody recorded" and is labelled pre-fleet, so the heading would
                     credit the operator with 18 decisions they never took. That is the
                     exact trust hazard the study names for day one. */
                  'The decision record'
                : 'Ran out of time'}
          </h3>
          <span className="acr-fl-sub aq-asof">
            {asOf ? (
              <>
                <Clock size={11} aria-hidden /> as of {asOf.toLocaleTimeString()}
              </>
            ) : (
              'loading…'
            )}
          </span>
        </div>

        {/* AQ.1 renders the SHIPPED inbox rather than a second copy of it.
            One decision surface is the whole point; AQ.3/AQ.4 replace the
            card in this directory and this import goes away. */}
        <ApprovalInbox
          view={view}
          counts={counts}
          approvals={approvals}
          precedents={precedents}
          plans={plans}
          nameByKey={nameByKey}
          busy={busy}
          loading={loading}
          onViewChange={setView}
          onDecide={(id, d, reason) => void decide(id, d, reason)}
          onRejectAll={(charterKey, reason) => {
            void post('approvals/reject-all', { charterKey, reason }).then(after)
          }}
          onOpenPlan={() => {
            /* AQ.3 links to Activity; the plan story is not this page's to retell. */
          }}
          onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
          onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
          onBulkPreview={async (ids, d) => {
            const r = await post('approvals/bulk-preview', { ids, decision: d })
            return r?.sentence ?? `This affects ${ids.length} actions.`
          }}
          onBulkDecide={(ids, d, reason) => {
            void post('approvals/bulk-decide', { ids, decision: d, reason }).then(after)
          }}
        />

        {view === 'waiting' && !loading && approvals.length === 0 && gate ? (
          <p className="aq-emptywhy">
            <Info size={12} aria-hidden />
            {gate.canAnythingArrive
              ? 'The fleet is running and has not asked for anything. That is the normal, quiet state.'
              : 'This is empty because nothing can arrive yet, not because the fleet looked and found nothing — see above.'}
          </p>
        ) : null}
      </section>

      <OutsideQueue
        rows={outside}
        busy={busy}
        expiryHours={gate?.expiry.hours ?? 24}
        onDecide={(id, d, reason) => void decide(id, d, reason)}
        onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
        onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
      />
    </>
  )
}
