'use client'

/**
 * NAF.SB.M.5 — the same graph, as a table.
 *
 * TWO OBLIGATIONS, discharged by one control.
 *
 * 1. ACCESSIBILITY. The equivalent-purpose alternative for a complex node-link
 *    diagram is a real table in the DOM with the same data — an `aria-label` on
 *    a canvas is not one. Every relationship a sighted reader gets for free
 *    from an arrow is a fact a screen-reader user loses entirely, so the
 *    adjacency columns carry it in text.
 *
 * 2. RANKING. At seven nodes, "who costs most" and "who is failing" are
 *    answered better by a sortable column than by a picture. Node-link wins
 *    path-tracing; a table wins ordering, and the research puts the crossover
 *    well above this fleet's size.
 *
 * THE ADJACENCY COLUMNS ARE ITS REASON TO EXIST. Without *Feeds it* and *It
 * feeds* this is the Workers roster with fewer features, and the operator's
 * rule is that nothing is built twice. So this table carries the wiring and
 * NOTHING ELSE: no autonomy dial, no bulk actions, no create, no pause. If it
 * ever grows one, delete it and link to /fleet/workers instead — that is not a
 * hedge, it is the test for whether this still deserves to exist.
 *
 * It uses the shared DS `DataGrid` (operator decision, 2026-08-08) because it
 * is a genuine sortable table and the reader will flip between it and the
 * Workers roster, which is one too. It does NOT take GridToolbar or FilterBar:
 * filtering on this page lives in the overlay rail and is shared with the
 * canvas, so a second filter UI over the same state would be the duplication
 * the rule exists to prevent.
 */

import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { ago } from '../_shared/run-health'
import { statusOf, type MapEdge, type MapNode } from './lib'

const RANK: Record<string, number> = {
  attention: 0,
  'not-set-up': 1,
  paused: 2,
  running: 3,
  working: 4,
  off: 5,
}

export function ListView({
  nodes,
  edges,
  selectedKey,
  onSelect,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  selectedKey: string | null
  onSelect: (key: string | null) => void
}) {
  const nameOf = (k: string) => nodes.find((n) => n.key === k)?.name ?? k
  const feedsIt = (k: string) => edges.filter((e) => e.to === k).map((e) => nameOf(e.from))
  const itFeeds = (k: string) => edges.filter((e) => e.from === k).map((e) => nameOf(e.to))

  const columns: Array<Column<MapNode>> = [
    {
      key: 'worker',
      label: 'Worker',
      width: 210,
      sortable: true,
      sortValue: (n) => n.name.toLowerCase(),
      render: (n) => (
        <button
          type="button"
          className={`sbm-listname ${selectedKey === n.key ? 'on' : ''}`}
          onClick={() => onSelect(n.key === selectedKey ? null : n.key)}
          aria-pressed={selectedKey === n.key}
        >
          <span className="nm">{n.name}</span>
          {n.diagnostic ? <span className="sbm-tag-diag">self-test</span> : null}
        </button>
      ),
    },
    {
      key: 'role',
      label: 'Role',
      width: 92,
      sortable: true,
      sortValue: (n) => n.tier,
      render: (n) => <span className="sbm-listdim">{n.tier}</span>,
    },
    {
      key: 'status',
      label: 'Status',
      width: 128,
      sortable: true,
      sortValue: (n) => RANK[statusOf(n).word] ?? 9,
      render: (n) => {
        const s = statusOf(n)
        return (
          <span className={`sbm-liststatus tone-${s.tone}`}>
            <span className={`sbm-glyph g-${s.word}`} aria-hidden />
            {s.label}
          </span>
        )
      },
    },
    {
      key: 'lastRun',
      label: 'Last run',
      width: 104,
      sortable: true,
      // Never-run sorts last whichever direction you pick: it is not "a very
      // old run", it is the absence of one.
      sortValue: (n) => (n.lastRun ? -new Date(n.lastRun.createdAt).getTime() : Number.MAX_SAFE_INTEGER),
      render: (n) =>
        n.runs.lifetime === 0 ? (
          <span className="sbm-listdim">not yet run</span>
        ) : (
          ago(n.lastRun?.createdAt)
        ),
    },
    {
      key: 'open',
      label: 'Open findings',
      width: 108,
      align: 'right',
      sortable: true,
      sortValue: (n) => n.findings.open,
      render: (n) => (n.findings.open === 0 ? <span className="sbm-listdim">—</span> : n.findings.open),
    },
    {
      key: 'cost',
      label: 'Spend',
      width: 96,
      align: 'right',
      sortable: true,
      sortValue: (n) => n.cost.windowUSD,
      render: (n) =>
        n.cost.runs === 0 ? (
          // Not a `title`: the distinction between "did not run" and "ran and
          // cost nothing" is load-bearing, so it has to be reachable rather
          // than hover-only. The row is not focusable, so the text carries it.
          <span className="sbm-listdim">no runs in this window</span>
        ) : (
          `$${n.cost.windowUSD.toFixed(4)}`
        ),
    },
    {
      key: 'feedsIt',
      label: 'Feeds it',
      width: 168,
      render: (n) => {
        const list = feedsIt(n.key)
        return list.length === 0 ? (
          <span className="sbm-listdim">starts the chain</span>
        ) : (
          <span className="sbm-listwrap">{list.join(', ')}</span>
        )
      },
    },
    {
      key: 'itFeeds',
      label: 'It feeds',
      width: 168,
      render: (n) => {
        const list = itFeeds(n.key)
        return list.length === 0 ? (
          <span className="sbm-listdim">
            {n.lane === 'standalone' ? 'runs on its own' : 'ends the chain'}
          </span>
        ) : (
          <span className="sbm-listwrap">{list.join(', ')}</span>
        )
      },
    },
  ]

  return (
    <div className="sbm-listwrapper">
      <DataGrid
        columns={columns}
        rows={nodes}
        rowKey={(n) => n.key}
        initialSort={{ key: 'status', dir: 'asc' }}
        emptyState="No workers to list yet."
      />
      <p className="sbm-listfoot">
        The same seven workers the map draws, and the same wiring — <b>Feeds it</b> and{' '}
        <b>It feeds</b> are the arrows, written out. To change a worker, open it from{' '}
        <a href="/fleet/workers">Workers</a>; nothing on this page edits anything.
      </p>
    </div>
  )
}
