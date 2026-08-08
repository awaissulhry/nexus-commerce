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
 * AQ.3 retired the borrowed `<ApprovalInbox>`: the card and the lists now live
 * in this directory (`ApprovalCard`, `ApprovalLists`), so the page has exactly
 * one card design and the outside queue and the fleet queue cannot drift apart.
 * The AP.1–AP.8 BEHAVIOURS are reproduced deliberately rather than reinvented —
 * three views, grouping by worker name, the server-written blast-radius
 * sentence, reject-all, the parked row with its inline undo. The Overview still
 * renders the original from its own directory; the two retire together when it
 * moves. Only the tool VOCABULARY is still imported, because copying it would
 * create two dictionaries that drift — the defect AP.3 was written to fix.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Info,
  MinusCircle,
  ShieldCheck,
  Undo2,
} from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { FleetPageShell } from '../_shell/FleetPageShell'
import { HowApprovalsWork } from './HowApprovalsWork'
import { toolCardFor } from '@/app/marketing/ads/rules-automation/fleet/DecisionCard'
import { ApprovalCard, type FleetLabels } from './ApprovalCard'
import {
  PrecedentPanel,
  RecordList,
  ViewTabs,
  WaitingList,
  type ApprovalRow,
  type InboxCounts,
  type InboxView,
  type PrecedentRow,
} from './ApprovalLists'
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

/**
 * AQ-S2R — one enumerated precondition, composed server-side.
 *
 * Mirrors `GateCondition` in `agent-fleet-approvals.routes.ts`. It is a
 * hand-written mirror rather than a shared type because web does not import
 * from api — which means **tsc cannot catch a drift between them**, and the
 * only thing that can is the browser. Worth knowing before changing either.
 */
interface GateCondition {
  key: 'worker-may-ask' | 'action-can-run' | 'something-scheduled'
  met: boolean
  requirement: string
  detail: string
  owner: 'operator' | 'engineering' | 'automatic'
  href: string | null
  at: string | null
}

interface GateState {
  halted: boolean
  haltReason: string | null
  canAnythingArrive: boolean
  conditions: GateCondition[]
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
 * S1.a (study Part 12) — the promise IS the page description now, not a green
 * banner under it.
 *
 * Three measured reasons, all on production before the change:
 *
 *   1. It was said twice. `.acr-sub` read "Everything the fleet wants to do and
 *      cannot do until you say yes" and the banner 38px below it made the same
 *      guarantee at 171 characters per line. A reader who read both learned
 *      nothing from the second.
 *   2. It was GREEN — a success colour on a statement that is not a success —
 *      and it never changed. A never-changing element in notification clothing
 *      is the stimulus the habituation literature says is ignored fastest
 *      (visual processing collapses after the SECOND exposure). Helios,
 *      Atlassian and Carbon all reserve that treatment for state changes; a
 *      standing guarantee is page-level identity, and Helios is explicit that
 *      page-level information belongs at the top of the page.
 *   3. As a description it survives a full queue by construction — it is not
 *      inside the empty state, so it cannot vanish exactly when volume makes
 *      rubber-stamping tempting. That was the property the study wanted; the
 *      banner was one way of getting it, and not the good one.
 *
 * Hierarchy comes from WEIGHT, not colour: the lede is 13/600 at 14.3:1, which
 * is darker and heavier than the same words were inside the tinted box.
 *
 * "one of your workers", NOT "the fleet": `worker` has a glossary entry and
 * `fleet` does not, and this page will not mint a term in a shared append-only
 * file for a word it does not need.
 *
 * The second sentence stops at "unless you say yes" on purpose. The other half
 * — that today a yes writes nothing either — is state-dependent, and S2 and the
 * card both say it. An invariant that needs rewording the day Phase F lands is
 * not an invariant.
 */
function PageDescription() {
  return (
    <>
      <span className="aq-lede">Nothing on this page has happened yet.</span>
      Every card is a change one of your <Term k="worker">workers</Term> wants to make. It does
      not happen unless you say yes.
    </>
  )
}

/* ── S2 · can anything reach this queue? ───────────────────────────────── */

/**
 * NAF.AQ-S2R (study Part 13) — the readiness readout.
 *
 * The section only this page can host: Controls knows the dials, Overview knows
 * the schedule, and nothing anywhere knows whether the actions a worker can
 * propose are able to RUN. Joined here, they answer the question an empty queue
 * always raises — is this broken, or just quiet?
 *
 * It is a READOUT, not a checklist and not a status banner, and the distinction
 * is a safety property rather than a style preference:
 *
 * · Not a banner. Argo CD ranks `Suspended` ("waiting for some external event
 *   to resume") as a different STATUS from `Degraded`; LaunchDarkly frames OFF
 *   as deliberate configuration; Statuspage gives "Under Maintenance" the
 *   LOWEST precedence of any status. This fleet is off because the operator
 *   chose that, so painting it amber told them something was wrong every single
 *   day — and it was a FOURTH amber, when `.acr-banner.warn` already serves
 *   seven fleet surfaces.
 * · Not a checklist. A checklist invites completion, and two of the three
 *   conditions must NOT be completed by the operator: setting a worker to
 *   PROPOSE arms a fleet that is off by deliberate constraint, and the missing
 *   executors are Phase F work nobody here can act on.
 *
 * So every row carries an OWNER — yours, ours, or automatic. That is the half
 * of "what would have to change" the old design did not attempt, and it is why
 * there is no progress bar, no "2 of 3 complete", and no per-row action button.
 *
 * The four tiles are gone. Their contract needed a delta and a trend and none
 * of the four numbers could supply either: two were counts of configuration,
 * one a countdown, one a policy constant. Numbers live inside the sentences
 * they qualify now. The `24h` tile is deleted outright rather than restyled —
 * it is not a precondition at all, and S1's teaching drawer already states it.
 */

const OWNER_LINE: Record<GateCondition['owner'], string> = {
  operator: 'Yours to change',
  engineering: 'Ours to build — nothing you can do here',
  automatic: 'Automatic',
}

/**
 * The state word per condition. Colour is never the carrier: every state pairs
 * a distinct glyph WITH a word (the status-page convention, and WCAG 1.4.1,
 * which this stylesheet's own header already committed to).
 *
 * Note what is deliberately absent: any word implying fault. "Not yet" and
 * "Not built" are states, not failures.
 */
function stateWord(c: GateCondition): string {
  if (c.met) return 'Ready'
  if (c.owner === 'engineering') return 'Not built'
  if (c.owner === 'automatic') return 'Not set up'
  return 'Not yet'
}

function ConditionRow({
  condition,
  tools,
}: {
  condition: GateCondition
  /** Only the `action-can-run` row renders these — the evidence for its claim. */
  tools: GateTool[]
}) {
  const met = condition.met
  return (
    <li className={`aq-cond${met ? ' met' : ''}`}>
      <span className="aq-condstate">
        {met ? (
          <CheckCircle2 size={14} aria-hidden />
        ) : (
          <MinusCircle size={14} aria-hidden />
        )}
        {stateWord(condition)}
      </span>
      <div className="aq-condbody">
        <p className="aq-condreq">{condition.requirement}</p>
        <p className="aq-conddetail">
          {condition.detail}
          {condition.at ? (
            <>
              {' '}
              <time dateTime={condition.at} title={new Date(condition.at).toLocaleString()}>
                Next {whenNext(condition.at)}
              </time>
              .
            </>
          ) : null}
        </p>

        {tools.length > 0 ? (
          <ul className="aq-toollist">
            {tools.map((t) => (
              <li key={t.name}>
                <span className={t.canExecute ? 'aq-can' : 'aq-cannot'}>
                  {t.canExecute ? 'can run' : 'describes only'}
                </span>
                {/* FX.1: names, not identifiers. `toolCardFor` is the vocabulary
                    this page already imports for its card — copying it into a
                    second dictionary is the defect AP.3 was written to fix. */}
                {toolCardFor(t.name).shortAsk}
              </li>
            ))}
          </ul>
        ) : null}

        <p className="aq-condowner">
          {OWNER_LINE[condition.owner]}
          {condition.href ? (
            <>
              {' · '}
              <Link href={condition.href}>Controls →</Link>
            </>
          ) : null}
        </p>
      </div>
    </li>
  )
}

function GateStateSection({ gate, waiting }: { gate: GateState | null; waiting: number }) {
  if (!gate) return null

  const conditions = gate.conditions ?? []
  const unmet = conditions.filter((c) => !c.met)
  const fleetTools = gate.tools.filter((t) => t.isFleetTool)

  /*
   * The halt is a FAULT, not an unmet precondition, so it is the one thing on
   * this surface that earns a danger colour — and it uses the fleet's existing
   * `.acr-banner`, read-only, exactly as Activity does, rather than a fifth
   * palette. Placed ABOVE the readout per GOV.UK's notification-banner rule;
   * the readout still renders beneath it, because a halt does not make the
   * other conditions unknowable.
   */
  const halt = gate.halted ? (
    <div className="acr-banner err aq-halt" role="alert">
      <AlertTriangle size={14} aria-hidden />
      <span>
        <strong>The whole fleet is halted.</strong>{' '}
        {gate.haltReason ?? 'No reason was recorded.'} No worker runs at all until it is released
        on <Link href="/fleet/controls">Controls</Link>.
      </span>
    </div>
  ) : null

  /*
   * S2 ⇄ S3, settled in the study rather than left half-written: S2's size is a
   * function of the QUEUE, never of a toggle. On the day something is waiting,
   * the operator's attention belongs on the request and this shrinks itself.
   * That is also why there is no chevron — a disclosure whose correct state is
   * always "open" is not a disclosure.
   */
  if (waiting > 0) {
    return (
      <>
        {halt}
        <p className="aq-gate-line">
          <MinusCircle size={13} aria-hidden />
          {conditions.length - unmet.length} of {conditions.length} conditions met — nothing NEW
          can reach this queue yet.
        </p>
      </>
    )
  }

  // The open pipe. Never rendered anywhere in this fleet's history; designed
  // as one line, because it is a fact rather than an event.
  if (gate.canAnythingArrive) {
    const scheduled = conditions.find((c) => c.at)
    return (
      <>
        {halt}
        <p className="aq-gate-line ok">
          <CheckCircle2 size={13} aria-hidden />
          Ready — a worker can ask you
          {scheduled?.at ? <>, and the next chance is the weekly council {whenNext(scheduled.at)}</> : null}.
        </p>
      </>
    )
  }

  return (
    <>
      {halt}
      <section className="aq-gate" aria-labelledby="aq-gate-h">
        <div className="aq-gate-head">
          <MinusCircle size={15} aria-hidden />
          <p id="aq-gate-h">
            <strong>Nothing can reach this queue yet — and nothing is broken.</strong>{' '}
            <span className="aq-gate-sub">
              {conditions.length} things have to be true before a worker can ask you for anything.{' '}
              {conditions.length - unmet.length === 0
                ? 'None of them is.'
                : conditions.length - unmet.length === 1
                  ? 'One of them is.'
                  : `${conditions.length - unmet.length} of them are.`}
            </span>
          </p>
        </div>

        <ol className="aq-conds">
          {conditions.map((c) => (
            <ConditionRow
              key={c.key}
              condition={c}
              tools={c.key === 'action-can-run' ? fleetTools : []}
            />
          ))}
        </ol>

        {gate.outside.pending > 0 ? (
          <p className="aq-gate-foot">
            Separately, {gate.outside.pending} request{gate.outside.pending === 1 ? '' : 's'} from
            the older agent system {gate.outside.pending === 1 ? 'is' : 'are'} waiting — those can
            genuinely change something, and they are listed at the foot of this page.
          </p>
        ) : null}
      </section>
    </>
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
  labels,
  busy,
  expiryHours,
  onDecide,
  onUndo,
  onCommit,
  onRecheck,
  onAmend,
  onSnooze,
}: {
  rows: OutsideRow[]
  labels: FleetLabels
  busy: boolean
  expiryHours: number
  onDecide: (id: string, decision: 'approve' | 'reject', reason?: string) => void
  onUndo: (id: string) => void
  onCommit: (id: string) => void
  onRecheck: (id: string) => Promise<{ stale: boolean; why: string | null }>
  onAmend: (id: string, args: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
  onSnooze: (id: string, until: Date | null) => void
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
                <ApprovalCard
                  approval={{
                    id: a.id,
                    toolName: a.toolName,
                    charterKey: null,
                    riskTier: a.riskTier,
                    status: a.status,
                    args: a.args,
                    preview: a.preview,
                    requestedAt: a.requestedAt,
                    expiresAt: a.expiresAt,
                    reason: a.reason,
                    trackRecord: null,
                  }}
                  labels={labels}
                  workerName={a.originKey ? humanTool(a.originKey) : 'An agent we cannot identify'}
                  busy={busy}
                  canExecute={a.canExecute}
                  onDecide={onDecide}
                  onRecheck={onRecheck}
                  onAmend={onAmend}
                  onSnooze={onSnooze}
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
  /**
   * Deep links, contracted with the Assignments stream and needed by any
   * notification: `?assignment=<id>` lands the queue filtered to what one
   * assignment produced, `?item=<id>` to a single request.
   */
  const params = useSearchParams()
  const focusAssignment = params.get('assignment')
  const focusItem = params.get('item')

  const [view, setView] = useState<InboxView>('waiting')
  const [approvals, setApprovals] = useState<ApprovalRow[]>([])
  const [counts, setCounts] = useState<InboxCounts>({ waiting: 0, decided: 0, expired: 0 })
  const [precedents, setPrecedents] = useState<PrecedentRow[]>([])
  const [labels, setLabels] = useState<FleetLabels>({ campaigns: {}, targets: {} })
  const [charters, setCharters] = useState<CharterRow[]>([])
  const [gate, setGate] = useState<GateState | null>(null)
  const [outside, setOutside] = useState<OutsideRow[]>([])
  const [loading, setLoading] = useState(true)
  /**
   * What a bulk decision actually did. Both bulk endpoints have always
   * returned `{done, of, failed[]}` and every client discarded it, so a
   * partial failure looked identical to a success: the page just reloaded and
   * some rows were still there. Partial failure is the NORMAL case when
   * writing to a rate-limited third-party API, and it deserves a sentence.
   */
  const [bulkResult, setBulkResult] = useState<{
    done: number
    of: number
    failed: string[]
    error?: string
  } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [a, pr, c, g, o] = await Promise.all([
      fetch(`${backend}/api/agent/fleet/approvals?view=${view}`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/precedents?limit=25`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/charters`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/gate-state`, { cache: 'no-store' }),
      fetch(`${backend}/api/agent/fleet/approvals/outside`, { cache: 'no-store' }),
    ])
    if (!a.ok) throw new Error(`approvals: ${a.status}`)
    const aj = (await a.json()) as {
      approvals: ApprovalRow[]
      counts: InboxCounts
      labels?: FleetLabels
    }
    setApprovals(aj.approvals)
    setCounts(aj.counts)
    // AQ.3 — the API has always resolved these and every client threw them
    // away, which is why no card ever said WHICH campaign.
    setLabels(aj.labels ?? { campaigns: {}, targets: {} })
    if (pr.ok) setPrecedents(((await pr.json()) as { precedents: PrecedentRow[] }).precedents)
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
        /*
         * The content-type is set ONLY when there is a body.
         *
         * Sending `content-type: application/json` with no body makes Fastify
         * reject the request before the handler ever runs —
         * `FST_ERR_CTP_EMPTY_JSON_BODY`, a flat 400. Three calls on this page
         * pass no body: **undo, commit and unsnooze**. All three were failing
         * silently, because the client fires them with `void post(...)` and
         * nothing reads the result.
         *
         * Consequence while it lasted: the 20-second window could not be taken
         * back from the UI at all, and the browser could not commit early — a
         * parked action just sat there until the 30-second maintenance sweep
         * picked it up. The undo LOOKED present and did nothing, which is worse
         * than not offering one.
         */
        const r = await fetch(`${backend}/api/agent/fleet/${path}`, {
          method: 'POST',
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
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

  /** AQ.3 — ask the server whether this approval still describes reality. */
  const recheck = useCallback(
    async (id: string) => {
      const r = await fetch(`${backend}/api/agent/fleet/approvals/${id}/recheck`, {
        method: 'POST',
      })
      if (!r.ok) return { stale: true, why: `the check could not run (${r.status})` }
      return (await r.json()) as { stale: boolean; why: string | null }
    },
    [backend],
  )

  /**
   * AQ.8 — supersede a proposal with the operator's own number. The server
   * re-runs the tool's own handler, so a refusal here is the tool's words.
   */
  const amend = useCallback(
    async (id: string, args: Record<string, unknown>) => {
      const r = await fetch(`${backend}/api/agent/fleet/approvals/${id}/amend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ args }),
      })
      const d = (await r.json().catch(() => null)) as { error?: string } | null
      if (!r.ok) return { ok: false, error: d?.error ?? `edit failed (${r.status})` }
      refresh()
      return { ok: true }
    },
    [backend, refresh],
  )

  /** NAF.AQ — set aside, or bring back. */
  const snooze = useCallback(
    (id: string, until: Date | null) => {
      void post(`approvals/${id}/${until ? 'snooze' : 'unsnooze'}`, until ? { until: until.toISOString() } : undefined).then(after)
    },
    [post, after],
  )

  /** Which tools can actually do something — straight from the gate state. */
  const canExecute = useCallback(
    (toolName: string) => gate?.tools.find((t) => t.name === toolName)?.canExecute ?? false,
    [gate],
  )

  /**
   * What the queue actually shows: the deep-link filter, then ORDER BY
   * CONSEQUENCE rather than by arrival.
   *
   * Creation order is the wrong default and the study says so plainly — it puts
   * a €2 bid nudge above a budget doubling. Ranked by what a wrong answer
   * costs: irreversible first, then high risk, then euro exposure, and only
   * then age as the tie-break.
   */
  const visible = useMemo(() => {
    let rows = approvals
    if (focusItem) rows = rows.filter((a) => a.id === focusItem)
    if (focusAssignment) rows = rows.filter((a) => a.assignmentId === focusAssignment)
    if (view !== 'waiting') return rows

    const exposure = (a: ApprovalRow) => {
      const p = (a.preview ?? {}) as Record<string, any>
      if (typeof p.currentBidCents === 'number' && typeof p.proposedBidCents === 'number') {
        return Math.abs(p.proposedBidCents - p.currentBidCents)
      }
      const ch = p.changes?.['base price']
      if (ch && typeof ch.from === 'number' && typeof ch.to === 'number') {
        return Math.abs(Math.round((ch.to - ch.from) * 100))
      }
      return 0
    }
    const irreversible = (a: ApprovalRow) =>
      a.toolName === 'send-customer-message' || a.toolName === 'publish-listing' ? 1 : 0

    return [...rows].sort(
      (x, y) =>
        irreversible(y) - irreversible(x) ||
        (y.riskTier === 'high' ? 1 : 0) - (x.riskTier === 'high' ? 1 : 0) ||
        exposure(y) - exposure(x) ||
        new Date(x.requestedAt).getTime() - new Date(y.requestedAt).getTime(),
    )
  }, [approvals, view, focusItem, focusAssignment])

  const nameByKey = useMemo(() => new Map(charters.map((c) => [c.key, c.name])), [charters])

  // Names, never raw keys — and an honest fallback rather than "unknown".
  const nameOf = useCallback(
    (key: string | null) =>
      key ? (nameByKey.get(key) ?? key.replace(/[_-]+/g, ' ')) : 'An agent we cannot identify',
    [nameByKey],
  )

  return (
    <FleetPageShell
      title="Approvals"
      sub={<PageDescription />}
      /* S1.b — the header's right-hand slot, which this page could not reach
         while it hand-rolled its own header. Measured before the change: the
         row was 1614px wide with a single 397px child, so 1217px of it — 75% —
         was dead, while the teaching control sat in the page flow below,
         costing a row forever. Helios and Primer both reserve this slot for
         exactly one secondary control; this is it. */
      aside={
        <HowApprovalsWork
          expiryHours={gate?.expiry.hours ?? null}
          maintenanceSeconds={gate?.expiry.maintenanceSeconds ?? null}
        />
      }
    >
      {err ? (
        <p className="acr-fl-empty aq-err" role="alert">
          <AlertTriangle size={13} aria-hidden /> {err}
        </p>
      ) : null}

      <GateStateSection gate={gate} waiting={counts.waiting} />

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

        <ViewTabs view={view} counts={counts} onChange={setView} />

        {bulkResult ? (
          <p
            className={`aq-bulkresult${bulkResult.failed.length || bulkResult.error ? ' partial' : ''}`}
            role="status"
          >
            {bulkResult.error ? (
              <>{bulkResult.error}</>
            ) : bulkResult.failed.length === 0 ? (
              <>All {bulkResult.done} went through.</>
            ) : (
              <>
                <strong>
                  {bulkResult.done} of {bulkResult.of} went through — {bulkResult.failed.length}{' '}
                  did not.
                </strong>{' '}
                {/* The reasons verbatim: a count alone tells the operator
                    something is wrong and nothing about what. */}
                {bulkResult.failed.slice(0, 4).join('; ')}
                {bulkResult.failed.length > 4 ? ` (+${bulkResult.failed.length - 4} more)` : ''}. The
                ones that did not are still in the list below.
              </>
            )}
            <button className="aq-bulkdismiss" onClick={() => setBulkResult(null)}>
              Dismiss
            </button>
          </p>
        ) : null}

        {loading ? (
          <div aria-busy="true" aria-label="Loading approvals">
            {[70, 70].map((h, i) => (
              <div key={i} className="dt-skeleton" style={{ height: h, marginBottom: 6 }} />
            ))}
          </div>
        ) : visible.length === 0 ? (
          <p className="acr-fl-empty">
            {view === 'waiting' ? (
              <>
                Nothing is waiting for you. <Term k="approval">Approvals</Term> appear here when a
                plan passes the <Term k="critic">critic</Term> — and every yes or no you give
                becomes <Term k="exemplar">precedent</Term> the workers read on their next run.
              </>
            ) : view === 'decided' ? (
              <>No decision has been taken yet.</>
            ) : (
              <>Nothing has expired. A request that goes unanswered too long ends up here.</>
            )}
          </p>
        ) : view === 'waiting' ? (
          <WaitingList
            rows={visible}
            labels={labels}
            nameOf={nameOf}
            busy={busy}
            canExecute={canExecute}
            onDecide={(id, d, reason) => void decide(id, d, reason)}
            onRejectAll={(charterKey, reason) => {
              void post('approvals/reject-all', { charterKey, reason }).then(after)
            }}
            onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
            onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
            onBulkPreview={async (ids, d) => {
              const r = await post('approvals/bulk-preview', { ids, decision: d })
              return r?.sentence ?? `This affects ${ids.length} actions.`
            }}
            onBulkDecide={(ids, d, reason) => {
              void post('approvals/bulk-decide', { ids, decision: d, reason }).then((r) => {
                const res = r as unknown as {
                  done?: number
                  of?: number
                  failed?: string[]
                  error?: string
                } | null
                if (res) {
                  setBulkResult({
                    done: res.done ?? 0,
                    of: res.of ?? ids.length,
                    failed: res.failed ?? [],
                    error: res.error,
                  })
                }
                return after()
              })
            }}
            onRecheck={recheck}
            onAmend={amend}
            onSnooze={snooze}
          />
        ) : (
          <RecordList rows={visible} nameOf={nameOf} />
        )}

        <PrecedentPanel precedents={precedents} nameOf={nameOf} />

        {view === 'waiting' && !loading && visible.length === 0 && gate ? (
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
        labels={labels}
        busy={busy}
        expiryHours={gate?.expiry.hours ?? 24}
        onDecide={(id, d, reason) => void decide(id, d, reason)}
        onUndo={(id) => void post(`approvals/${id}/undo`).then(after)}
        onCommit={(id) => void post(`approvals/${id}/commit`).then(after)}
        onRecheck={recheck}
        onAmend={amend}
        onSnooze={snooze}
      />
    </FleetPageShell>
  )
}
