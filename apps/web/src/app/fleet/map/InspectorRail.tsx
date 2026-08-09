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
import { ArrowRight, X } from 'lucide-react'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { ago } from '../_shared/run-health'
import { statusOf, type MapEdge, type MapNode } from './lib'

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
      <Row
        k="Autonomy"
        v={
          <>
            <b>{node.charter.autonomyLevel}</b>
            {node.charter.autonomyCap !== node.charter.autonomyLevel ? (
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
            </>
          ) : (
            <p className="sbm-dim">Nothing has been reviewed yet.</p>
          )}
        </>
      ) : (
        <>
          <h4>What crossed</h4>
          <Row k="Carried into a plan" v={edge.counts.crossed} />
          <Row k="Considered and dropped" v={edge.counts.dropped} />
          {edge.counts.conflicted > 0 ? <Row k="In conflict" v={edge.counts.conflicted} /> : null}
          <p className="sbm-rail-note">{edge.lineageNote}</p>

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

/* ── the rail ──────────────────────────────────────────────────────────── */

export function InspectorRail({
  nodes,
  edges,
  selection,
  onSelect,
  onClose,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  selection: Selection | null
  onSelect: (sel: Selection | null) => void
  onClose: () => void
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

  return (
    <aside className="sbm-rail" aria-label="Details">
      <header className="sbm-rail-head">
        <h3>{title}</h3>
        {selection ? (
          <button type="button" className="sbm-rail-close" aria-label="Clear selection" onClick={onClose}>
            <X size={13} aria-hidden />
          </button>
        ) : null}
      </header>
      <div className="sbm-rail-body">
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
      </div>
    </aside>
  )
}
