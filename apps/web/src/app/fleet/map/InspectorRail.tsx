'use client'

/**
 * NAF.SB.M.3 — the inspector rail.
 *
 * Docked, never floating. Camunda shipped node details as a popover over the
 * diagram and then reversed it, because a popover occludes the thing you are
 * reasoning about. The graph does not move, re-centre or re-zoom when the
 * selection changes; only the rail's contents change.
 *
 * THREE STATES, and the middle one is the point:
 *   nothing → the fleet at a glance, read-only
 *   worker  → who it is, what it may do, what it has done, and the way out
 *   edge    → THE HANDOFF, which is the one thing no other page in the ten can
 *             show: what the director carried, and what it considered and
 *             dropped, in the words it wrote at the time
 *
 * READ-ONLY. Every control here either changes what you are looking at or
 * navigates. Nothing writes — so the rail inherits none of the three
 * dial-bypassing paths the spend audit found.
 *
 * WHAT IT DELIBERATELY DOES NOT SHOW, and why it matters: campaign and
 * portfolio scope. Both are stored on a charter, accepted at create, merged
 * onto the effective charter — and read by nothing that enforces them.
 * `scopeCampaignIds` is named as a defect class in the codebase itself
 * (`observation-builder.ts:145-152`); `scopePortfolioIds` is worse, with no
 * enforcement anywhere at all. The series' own rule, written into the file
 * that enforces the marketplace version (`scope-filter.ts:6-7`), is "a control
 * that is not enforced must not be rendered". So this rail renders the
 * marketplace scope, which IS enforced, and says plainly what that means.
 */

import Link from 'next/link'
import { ArrowRight, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { ago } from '../_shared/run-health'
import { statusOf, type MapEdge, type MapNode } from './lib'
import { overlayById } from './overlays'

export type Selection = { kind: 'worker' | 'edge'; id: string }

const usd = (n: number) => `$${n.toFixed(4)}`

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info']

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="sbm-row">
      <span className="k">{k}</span>
      <span className="v">{v}</span>
    </div>
  )
}

/* ── nothing selected: the fleet at a glance ───────────────────────────── */

function Overview({ nodes, onPick }: { nodes: MapNode[]; onPick: (k: string) => void }) {
  return (
    <>
      <p className="sbm-rail-hint">
        Select a worker, or a line between two of them, to see the detail here. The map stays
        exactly where it is.
      </p>
      <ul className="sbm-rail-list">
        {nodes.map((n) => {
          const s = statusOf(n)
          return (
            <li key={n.key}>
              <button type="button" className="sbm-rail-listbtn" onClick={() => onPick(n.key)}>
                <span className="nm">{n.name}</span>
                <span className={`st tone-${s.tone}`}>{s.label}</span>
                <span className="meta">
                  {/* S4.d — three unrelated conditions all say "Needs attention"
                      and were separated only by hue: red for a failure, amber
                      for a limit, measured 1.50:1 apart in greyscale. The shared
                      module already computes the CAUSE for exactly this reason —
                      its own comment says the operator's next step differs by
                      class — and the rail was throwing it away. */}
                  {/* ⚠ Gated on `word === 'attention'`, not on `needsAttention`.
                      Verified on prod: `paused` and `not-set-up` also set
                      `needsAttention`, so the first cut printed "Paused ·
                      paused" and "Not set up · never set up". `attention` is
                      the one word three different conditions share — which is
                      the whole defect — and it is a stable field rather than a
                      display string. */}
                  {s.word === 'attention' && s.tag ? (
                    <>
                      <span className="cause">{s.tag}</span>
                      {' · '}
                    </>
                  ) : null}
                  {n.runs.lifetime === 0 ? 'not yet run' : ago(n.lastRun?.createdAt)}
                  {n.findings.open > 0 ? ` · ${n.findings.open} open` : ''}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </>
  )
}

/* ── a worker ──────────────────────────────────────────────────────────── */

function WorkerPanel({
  node,
  edges,
  nodes,
  onPick,
}: {
  node: MapNode
  edges: MapEdge[]
  nodes: MapNode[]
  onPick: (k: string) => void
}) {
  const s = statusOf(node)
  /* The same bucket the canvas paints from — see the Row below. */
  const autonomyBucket = overlayById('autonomy').bucketOf(node)
  const nameOf = (k: string) => nodes.find((n) => n.key === k)?.name ?? k
  const feedsIt = edges.filter((e) => e.to === node.key)
  const itFeeds = edges.filter((e) => e.from === node.key)
  const sev = SEVERITY_ORDER.filter((x) => (node.findings.bySeverity[x] ?? 0) > 0)

  return (
    <>
      <div className="sbm-rail-id">
        <span className={`sbm-glyph g-${s.word}`} aria-hidden />
        <div>
          <div className="nm">{node.name}</div>
          <div className="ky">{node.key}</div>
        </div>
      </div>

      {/* deriveStatus always carries a reason. A status word with no reason is
          the flattening the shared module exists to prevent. */}
      <p className={`sbm-rail-reason tone-${s.tone}`}>{s.reason}</p>

      <h4>What it may do</h4>
      {/*
       * S4.d — this row is headed by the question and must answer it.
       *
       * It printed the raw dial. Measured on prod, for one PAUSED worker at one
       * moment: the canvas painted `ov-off` and the legend read "Held at off",
       * while this row said "OBSERVE · at its ceiling" — two surfaces on one
       * screen answering one question two ways, and the canvas's answer was the
       * right one. `overlays.ts` exists to prevent precisely that; its own
       * comment says a node tinted from `autonomyLevel` alone "would paint a
       * paused worker as armed".
       *
       * So the row reads the SAME bucket the canvas paints from rather than
       * re-deriving the rule — the legend/canvas one-source rule, applied to a
       * third surface. The dial stays, demoted to what it is: the setting that
       * will apply again once whatever is holding it lets go.
       */}
      <Row
        k="Right now"
        v={
          <>
            <b>{autonomyBucket.label}</b>
            {autonomyBucket.id === 'off' && node.charter.autonomyLevel !== 'OFF' ? (
              <span className="sbm-dim"> · the dial is still at {node.charter.autonomyLevel}</span>
            ) : node.charter.autonomyCap !== node.charter.autonomyLevel ? (
              <span className="sbm-dim"> · cannot go above {node.charter.autonomyCap}</span>
            ) : (
              <span className="sbm-dim"> · at its ceiling</span>
            )}
          </>
        }
      />
      <Row
        k="Where"
        v={
          node.charter.scopeMarketplaces.length > 0
            ? node.charter.scopeMarketplaces.join(', ')
            : 'everything, everywhere'
        }
      />
      <Row k="Daily budget" v={`$${node.charter.dailyBudgetUSD.toFixed(2)}`} />
      <Row
        k="Per run"
        v={`${node.charter.maxTokensPerRun.toLocaleString()} tokens · ${node.charter.maxFindingsPerRun} findings · ${node.charter.maxToolCallsPerRun} tool calls`}
      />

      <h4>What it has done</h4>
      <Row
        k="Runs"
        v={
          node.runs.lifetime === 0
            ? 'never run'
            : `${node.runs.window} in this window · ${node.runs.lifetime} ever`
        }
      />
      <Row k="Last run" v={node.lastRun ? ago(node.lastRun.createdAt) : '—'} />
      <Row
        k="Open findings"
        v={
          node.findings.open === 0 ? (
            'none'
          ) : (
            <>
              {node.findings.open}
              {sev.length > 0 ? (
                <span className="sbm-dim">
                  {' '}
                  · {sev.map((x) => `${node.findings.bySeverity[x]} ${x}`).join(', ')}
                </span>
              ) : null}
              {node.findings.openExpired > 0 ? (
                <div className="sbm-warnline">
                  {node.findings.openExpired} of them are past their expiry date.
                </div>
              ) : null}
            </>
          )
        }
      />
      <Row
        k="Spend"
        v={
          <>
            {usd(node.cost.windowUSD)} in this window
            <span className="sbm-dim"> · {usd(node.cost.lifetimeUSD)} ever</span>
          </>
        }
      />
      {/*
       * S4.e — two facts the endpoint has always returned and this panel threw
       * away. Forced a worker with 4 approvals waiting and 3 plans authored:
       * the panel said nothing about either.
       *
       * ⚠ RENDERED ONLY WHEN NON-ZERO, deliberately. No worker can queue an
       * approval on this deployment — the proposal tools are preview-only — so
       * `waiting` is a STRUCTURAL zero, and the census band already explains
       * that once, in a sentence, at the top of the page. S1R's rule is that a
       * count which can only ever be zero is a sentence and not a control;
       * printing "Waiting for you: none" on all seven cards would repeat a
       * structural zero seven times and imply it is a measurement.
       */}
      {node.approvals.waiting > 0 || node.approvals.scheduled > 0 ? (
        <Row
          k="Waiting for you"
          v={
            <>
              <b>{node.approvals.waiting}</b> to approve
              {node.approvals.scheduled > 0 ? (
                <span className="sbm-dim"> · {node.approvals.scheduled} already scheduled</span>
              ) : null}
            </>
          }
        />
      ) : null}
      {node.plans.authoredWindow > 0 ? (
        <Row
          k="Plans written"
          v={
            <>
              <b>{node.plans.authoredWindow}</b> in this window
              <span className="sbm-dim">
                {' '}
                · {node.plans.verdictsWindow.pass} passed, {node.plans.verdictsWindow.revise} sent
                back, {node.plans.verdictsWindow.block} blocked
              </span>
            </>
          }
        />
      ) : null}

      <h4>How it is wired</h4>
      <Row
        k="Feeds it"
        v={
          feedsIt.length === 0 ? (
            <span className="sbm-dim">nothing — it starts the chain</span>
          ) : (
            feedsIt.map((e) => (
              <button key={e.id} type="button" className="sbm-linkbtn" onClick={() => onPick(e.from)}>
                {nameOf(e.from)}
              </button>
            ))
          )
        }
      />
      <Row
        k="It feeds"
        v={
          itFeeds.length === 0 ? (
            <span className="sbm-dim">nothing — it is the end of the chain</span>
          ) : (
            itFeeds.map((e) => (
              <button key={e.id} type="button" className="sbm-linkbtn" onClick={() => onPick(e.to)}>
                {nameOf(e.to)}
              </button>
            ))
          )
        }
      />
      <Row
        k="Named by"
        v={
          node.declaredBy.length === 0 ? (
            <span className="sbm-dim">no routine — the nightly job runs it directly</span>
          ) : (
            node.declaredBy.map((d) => d.workflowKey).join(', ')
          )
        }
      />

      <div className="sbm-rail-exits">
        <Link href={`/fleet/workers/${node.key}`}>
          Open its profile and run history <ArrowRight size={12} aria-hidden />
        </Link>
        <Link href="/fleet/activity">
          Everything the fleet has done <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
    </>
  )
}

/* ── an edge: the handoff ──────────────────────────────────────────────── */

function EdgePanel({ edge, nodes }: { edge: MapEdge; nodes: MapNode[] }) {
  const nameOf = (k: string) => nodes.find((n) => n.key === k)?.name ?? k
  const isPlan = edge.artifact === 'plan'

  return (
    <>
      <div className="sbm-rail-id">
        <div>
          <div className="nm">
            {nameOf(edge.from)} → {nameOf(edge.to)}
          </div>
          <div className="ky">
            {edge.artifact === 'plan' ? (
              'a plan crosses here'
            ) : (
              <>
                a <Term k="handoff">handoff</Term>
              </>
            )}
          </div>
        </div>
      </div>

      {isPlan ? (
        <>
          <p className="sbm-rail-reason tone-neutral">{edge.lineageNote}</p>
          <h4>The critic&apos;s verdicts</h4>
          {edge.verdicts && edge.verdicts.pass + edge.verdicts.revise + edge.verdicts.block > 0 ? (
            <>
              <Row k="Passed" v={edge.verdicts.pass} />
              <Row k="Sent back" v={edge.verdicts.revise} />
              <Row k="Blocked" v={edge.verdicts.block} />
              {edge.lastCritique ? (
                <Row
                  k="Most recent"
                  v={
                    <>
                      <b>{edge.lastCritique.verdict}</b>
                      {edge.lastCritique.blockedCount > 0
                        ? ` · ${edge.lastCritique.blockedCount} item${edge.lastCritique.blockedCount === 1 ? '' : 's'} blocked`
                        : ''}
                    </>
                  }
                />
              ) : null}
              {/*
               * S4.j — the asymmetry this section existed to fix, closed.
               *
               * The finding edge accounts for every dropped item in the
               * director's own words. This edge could say "Blocked: 1" and never
               * say why — on the most consequential verdict the fleet produces.
               * The sentence was already persisted and the map service was
               * reading `criticNotes` and taking nothing from it but a count.
               */}
              {edge.lastCritique?.summary ? (
                <>
                  <h4>What the critic said</h4>
                  <ul className="sbm-drops">
                    <li>{edge.lastCritique.summary}</li>
                  </ul>
                </>
              ) : edge.lastCritique ? (
                <p className="sbm-rail-note">
                  The critic recorded this verdict without a written reason.
                </p>
              ) : null}
              {edge.lastCritique?.overrideNote ? (
                <p className="sbm-rail-note">
                  <b>This verdict was overridden:</b> {edge.lastCritique.overrideNote}
                </p>
              ) : null}
            </>
          ) : edge.latestCritique ? (
            /*
             * S4.k — "nothing reviewed" used to mean two different things and
             * said the same words for both. This fleet's only critique is a
             * 9-item BLOCK with a 945-character reason, and at the default
             * 7-day window the panel read "Nothing has been reviewed yet" —
             * which reads as *never happened*.
             *
             * The page already draws this distinction everywhere else:
             * `overlays.ts` separates "never run" from "has run before, but not
             * inside the time window you are looking at". The out-of-window
             * verdict is NOT promoted into the window; the panel says where to
             * look and leaves the reader to widen it.
             */
            <p className="sbm-rail-note">
              Nothing was reviewed in this window. The most recent verdict was a{' '}
              <b>{edge.latestCritique.verdict}</b> on{' '}
              {new Date(edge.latestCritique.at).toLocaleDateString(undefined, {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              })}
              {' — widen the window to read what the critic said.'}
            </p>
          ) : (
            <p className="sbm-rail-note">Nothing has been reviewed yet.</p>
          )}
        </>
      ) : (
        <>
          <h4>What crossed</h4>
          <Row k="Carried into a plan" v={edge.counts.crossed} />
          <Row k="Considered and dropped" v={edge.counts.dropped} />
          {edge.counts.conflicted > 0 ? <Row k="In conflict" v={edge.counts.conflicted} /> : null}
          <p className="sbm-rail-note">{edge.lineageNote}</p>

          {/* S4.e — the panel printed "In conflict: 3" and held the array that
              explains those three without rendering it. Showing a count whose
              meaning you are carrying and not printing is the same defect class
              as a legend that disagrees with its graph. */}
          {edge.conflicts.length > 0 ? (
            <>
              <h4>Where two findings collided</h4>
              <ul className="sbm-drops">
                {edge.conflicts.map((c, i) => (
                  <li key={`${c.kind ?? 'conflict'}-${i}`}>
                    <b>{c.findingIds.length} findings</b>
                    {c.kind ? ` · ${c.kind.replace(/_/g, ' ')}` : ''}
                    <div className="sbm-dim">
                      {c.resolution ?? 'No resolution was recorded for this one.'}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {/* The centrepiece. The director is required to account for every
              open finding it did not carry, in its own words — a fact no
              roster, timeline or cost page can express. */}
          {edge.dropped.length > 0 ? (
            <>
              <h4>Why it dropped them</h4>
              <ul className="sbm-drops">
                {edge.dropped.map((d) => (
                  <li key={d.findingId}>{d.reason || 'no reason recorded'}</li>
                ))}
              </ul>
            </>
          ) : null}

          {edge.samples.length > 0 ? (
            <>
              <h4>Some of what crossed</h4>
              <ul className="sbm-samples">
                {edge.samples.map((s) => (
                  <li key={s.id}>
                    <span className={`sev sev-${s.severity}`}>{s.severity}</span>{' '}
                    {s.kind.replace(/_/g, ' ')}
                    <span className="sbm-dim"> · {s.entityName ?? s.entityId}</span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}

      <h4>Declared by</h4>
      <p className="sbm-rail-note">
        {edge.declaredBy.length === 0
          ? 'No enabled routine declares this line.'
          : edge.declaredBy
              .map(
                (d) =>
                  `${d.workflowKey} (${d.kind === 'custom' ? 'your routine' : 'built-in'}${
                    d.source === 'revision' ? ', published version' : ''
                  })`,
              )
              .join(' · ')}
      </p>

      <div className="sbm-rail-exits">
        <Link href="/fleet/workflows">
          See the routines that declare it <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
    </>
  )
}

/* ── a selection that is not on this map ───────────────────────────────── */

/**
 * S4.c. A deep link to something that no longer exists used to be swallowed:
 * `selection` was truthy, neither `node` nor `edge` resolved, and the ternary
 * chain fell through to the roster — so the panel reverted to "The fleet at a
 * glance" while still rendering a close button for a selection that was not
 * there, and nothing anywhere said the key was missing. The URL kept repeating
 * it, so a reload or a share reproduced it exactly.
 *
 * A dead end needs a way forward; that is the one thing every empty-state
 * guideline agrees on.
 */
function MissingPanel({ selection, onClose }: { selection: Selection; onClose: () => void }) {
  return (
    <>
      <div className="sbm-rail-id">
        <div>
          <div className="nm">Not on this map</div>
          <div className="ky">{selection.id}</div>
        </div>
      </div>
      <p className="sbm-rail-reason tone-neutral">
        {selection.kind === 'worker'
          ? 'This link asks for a worker the map is not showing. It may have been renamed or removed, or it belongs to a routine that is switched off.'
          : 'This link asks for a handoff the map is not showing. The line only exists while a routine that declares it is switched on.'}
      </p>
      <div className="sbm-rail-exits">
        <button type="button" className="sbm-rail-exitbtn" onClick={onClose}>
          Show the whole fleet again <ArrowRight size={12} aria-hidden />
        </button>
        <Link href="/fleet/workers">
          See every worker, including the ones not on this map{' '}
          <ArrowRight size={12} aria-hidden />
        </Link>
      </div>
    </>
  )
}

/* ── the shell both modes share ────────────────────────────────────────── */

/**
 * S4.i — one shell, so the two universes cannot drift again.
 *
 * Entity mode's rail was written inline in `MapClient.tsx` and had grown four
 * behavioural differences from this one, measured: no close button ever
 * rendered, Escape did nothing, the selection was not in the URL so it could not
 * be shared or restored, and the panel was titled "Thing". It also carried 4 of
 * 4 contrast failures when empty and 15 of 29 with something selected, because
 * S4.a's fixes landed on the rail's classes and entity mode only borrowed some
 * of them.
 *
 * None of that was a decision. It is what happens when the same surface is
 * written twice.
 */
export function RailShell({
  title,
  announce,
  subject,
  onClose,
  collapsed,
  onCollapsed,
  children,
}: {
  title: string
  announce: string
  /** Named on the collapsed strip, so the control is never a bare chevron. */
  subject: string | null
  onClose?: () => void
  collapsed: boolean
  onCollapsed: (v: boolean) => void
  children: React.ReactNode
}) {
  if (collapsed) {
    return (
      <aside className="sbm-rail is-collapsed" aria-label="Details">
        <button
          type="button"
          className="sbm-rail-expand"
          aria-expanded={false}
          /* ⚠ `aria-label`, not a visible label plus an sr-only span. Verified on
             prod that the first cut announced "Details Show details for Fleet
             auditor" — the two concatenated, because both were inside the
             button. The visible word stays for the eye and is hidden from the
             name. */
          aria-label={subject ? `Show details for ${subject}` : 'Show the details panel'}
          onClick={() => onCollapsed(false)}
        >
          <ChevronLeft size={13} aria-hidden />
          <span className="lbl" aria-hidden>
            Details
          </span>
          {subject ? <span className="dot" aria-hidden /> : null}
        </button>
      </aside>
    )
  }

  return (
    <aside className="sbm-rail" aria-label="Details">
      <header className="sbm-rail-head">
        <h3>{title}</h3>
        <div className="sbm-rail-headbtns">
          {onClose ? (
            <button
              type="button"
              className="sbm-rail-close"
              aria-label="Clear selection"
              onClick={onClose}
            >
              <X size={13} aria-hidden />
            </button>
          ) : null}
          <button
            type="button"
            className="sbm-rail-close"
            aria-expanded
            aria-label="Collapse the details panel"
            onClick={() => onCollapsed(true)}
          >
            <ChevronRight size={13} aria-hidden />
          </button>
        </div>
      </header>
      {/*
       * S4.f — ONE live region for this panel, and it did not have one. The page
       * has exactly one (`role="status"` on the census band's sub-line) and it
       * does not cover the rail, so the entire contents could swap on selection
       * and a screen-reader user heard nothing.
       *
       * It announces a SENTENCE, not the panel: making `.sbm-rail-body` itself
       * live would re-read every row — thirty-odd on a worker — each time the
       * selection changed, which is how a live region becomes something people
       * switch off.
       */}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="sbm-rail-body">{children}</div>
    </aside>
  )
}

/* ── the rail ──────────────────────────────────────────────────────────── */

export function InspectorRail({
  nodes,
  edges,
  selection,
  onSelect,
  onClose,
  collapsed,
  onCollapsed,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  onClose: () => void
  collapsed: boolean
  onCollapsed: (v: boolean) => void
}) {
  const node = selection?.kind === 'worker' ? nodes.find((n) => n.key === selection.id) : undefined
  const edge = selection?.kind === 'edge' ? edges.find((e) => e.id === selection.id) : undefined
  /* Something is selected and neither half of the map has it. Distinct from
     "nothing is selected", which is what this used to collapse into. */
  const missing = selection != null && !node && !edge

  const title = node
    ? 'Worker'
    : /* S4.c — the plan edge is titled for what it is. The body already says
         "the critic does not write an artifact… there is nothing to count
         crossing here", so calling it a handoff made the header contradict the
         paragraph under it. */
      edge
      ? edge.artifact === 'plan'
        ? 'Review'
        : 'Handoff'
      : missing
        ? 'Not on this map'
        : 'The fleet at a glance'

  /* What the collapsed strip announces, so the control is not a bare chevron to
     anyone who cannot see the dot. */
  const subject = node
    ? node.name
    : edge
      ? `${nodes.find((n) => n.key === edge.from)?.name ?? edge.from} → ${nodes.find((n) => n.key === edge.to)?.name ?? edge.to}`
      : null

  /*
   * S4.g — collapsed, this is a 44px strip and nothing else.
   *
   * The rail took 340px unconditionally — the second-largest thing on the page
   * after the canvas — and there was no way to get it back for the tasks where
   * the graph IS the work: tracing a chain, reading the lanes. Kiali's panel is
   * collapsible and Cloudscape's has an explicit control, with the rule that
   * matters here: "Once users close the details panel, it stays closed even if
   * they change the resource selection." A reader who deliberately made the
   * graph wide should not have it taken back by their next click.
   */
  const announce = node
    ? `Showing worker ${node.name}.`
    : edge
      ? `Showing the ${edge.artifact === 'plan' ? 'review' : 'handoff'} from ${
          nodes.find((n) => n.key === edge.from)?.name ?? edge.from
        } to ${nodes.find((n) => n.key === edge.to)?.name ?? edge.to}.`
      : missing
        ? `Nothing on this map matches ${selection?.id}.`
        : 'Showing the whole fleet.'

  return (
    <RailShell
      title={title}
      announce={announce}
      subject={subject}
      onClose={selection ? onClose : undefined}
      collapsed={collapsed}
      onCollapsed={onCollapsed}
    >
        {node ? (
          <WorkerPanel
            node={node}
            edges={edges}
            nodes={nodes}
            onPick={(k) => onSelect({ kind: 'worker', id: k })}
          />
        ) : edge ? (
          <EdgePanel edge={edge} nodes={nodes} />
        ) : missing ? (
          <MissingPanel selection={selection} onClose={onClose} />
        ) : (
          <Overview nodes={nodes} onPick={(k) => onSelect({ kind: 'worker', id: k })} />
        )}
    </RailShell>
  )
}
