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
import { overlayById } from './overlays'

/** The same overlay the canvas paints from and the rail reads — not a second
 *  derivation of "what may it do". */
const AUTONOMY = overlayById('autonomy')

/** `lane` is how a worker is INVOKED, which the canvas draws as a container and
 *  the table had no column for. */
const LANE_WORDS: Record<string, string> = {
  ranked: 'a step of a routine',
  standalone: 'the nightly job runs it',
  unwired: 'nothing runs it',
}
const LANE_ORDER: Record<string, number> = { ranked: 0, standalone: 1, unwired: 2 }

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
  dimmedKeys,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  selectedKey: string | null
  onSelect: (key: string | null) => void
  /**
   * S3R C-S3.3 — the table honours the rail's filter.
   *
   * It did not, and the state persisted anyway: set "analyst" on the map (3 of 7
   * cards dimmed), switch to List, and all seven rows came back undimmed while
   * the rail — and with it the only control that could clear the filter — was
   * not rendered at all. Switch back and the three dim again. The operator had
   * a filter armed, invisible, and unmentioned.
   *
   * *Filtering dims; it never removes* is a law of this page, and the table is
   * part of the page, so the rows stay, in order, and recede.
   */
  dimmedKeys: Set<string>
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
    /*
     * S5.d — THE THREE COLUMNS THAT MAKE THIS AN EQUIVALENT ALTERNATIVE AGAIN.
     *
     * WCAG's bar for a complex image is not "a table exists" but a text
     * alternative that "serves a purpose equivalent" — for data, "a complete
     * text equivalent of the data or information provided in the image". After
     * Sections 2–4 the canvas card had drifted ahead of the table on three
     * facts, so the picture could answer questions its own alternative could
     * not:
     *
     *   the autonomy level   S3.j put it in WORDS on the card precisely because
     *                        colour alone failed SC 1.4.1. The table never had
     *                        it — so the page's DEFAULT question, "what is each
     *                        worker allowed to do", was answerable only in the
     *                        picture.
     *   the lane             S2R made it a real container saying "Runs as part
     *                        of the nightly job — not a step of any routine".
     *                        A structural fact about how a worker is invoked.
     *   the runs count       the card's third fact slot.
     *
     * `Right now` reads the SAME bucket the canvas paints from and the
     * inspector rail reads (S4.d), so three surfaces cannot drift. Sorting it
     * sorts by the autonomy ladder, which is the order the legend prints.
     */
    {
      key: 'mayDo',
      label: 'Right now',
      width: 132,
      sortable: true,
      sortValue: (n) => AUTONOMY.buckets.findIndex((b) => b.id === AUTONOMY.bucketOf(n).id),
      render: (n) => {
        const b = AUTONOMY.bucketOf(n)
        return <span>{b.short ?? b.label}</span>
      },
    },
    {
      key: 'lane',
      label: 'How it runs',
      width: 128,
      sortable: true,
      sortValue: (n) => LANE_ORDER[n.lane] ?? 9,
      render: (n) => <span className="sbm-listdim">{LANE_WORDS[n.lane] ?? n.lane}</span>,
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
            {/*
             * S5.c — the same defect S4.d fixed in the inspector rail, still
             * live here. Forced a failure, a limit and a degraded charter: all
             * three rendered "Needs attention", separated only by red vs amber
             * — 1.50:1 apart in greyscale, where WCAG credits lightness as a
             * second channel only at 3:1.
             *
             * The shared module already computes the cause for exactly this
             * reason; the table was throwing it away. Gated on
             * `word === 'attention'`, not `needsAttention`, because `paused` and
             * `not-set-up` set that flag too and would print "Paused · paused"
             * — the mistake S4.d shipped and had to correct.
             */}
            {s.word === 'attention' && s.tag ? (
              <span className="sbm-listcause">{s.tag}</span>
            ) : null}
          </span>
        )
      },
    },
    /*
     * S5.f — ADJACENCY SITS AHEAD OF THE RANKING COLUMNS, DELIBERATELY.
     *
     * `table-layout: fixed`, and at 1024×768 the wrapper scrolls: 176px hidden,
     * with "It feeds" cut by 175px. So the LAST columns are the ones a narrow
     * viewport takes away — and they were the two that make this view an
     * equivalent alternative rather than a worse Workers roster.
     *
     * Ranking is what a table wins at and what the picture answers badly, but
     * spend and findings have other homes (the census band, the inspector rail,
     * Activity). The wiring has none. So when something has to scroll out of
     * view, it is a number you can get elsewhere, not the arrows nothing else
     * writes down.
     */
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
    {
      key: 'runs',
      label: 'Runs',
      width: 78,
      align: 'right',
      sortable: true,
      sortValue: (n) => -n.runs.lifetime,
      render: (n) =>
        n.runs.lifetime === 0 ? <span className="sbm-listdim">none</span> : n.runs.lifetime,
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
  ]

  return (
    <div className="sbm-listwrapper">
      <DataGrid
        className="sbm-listgrid"
        columns={columns}
        rows={nodes}
        rowKey={(n) => n.key}
        // `is-dimmed`, matching the canvas card — NOT `sbm-listdim`, which is
        // already this table's muted-cell colour on seven cells. Third name
        // collision caught on this page; the first two shipped.
        /* S5.e — the whole ROW carries the selection. It was marked only in
           the Worker cell (colour 5.42 → 15.48:1 plus an underline, both fine)
           — one cell at the far left of a 1262px row of eleven. The canvas
           gives a selected card a ring around the whole thing. */
        rowClassName={(n) =>
          [dimmedKeys.has(n.key) ? 'is-dimmed' : '', n.key === selectedKey ? 'is-selected' : '']
            .filter(Boolean)
            .join(' ') || undefined
        }
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
