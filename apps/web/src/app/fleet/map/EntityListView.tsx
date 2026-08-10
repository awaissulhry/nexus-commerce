'use client'

/**
 * NAF.SB.M.6 — the derived relationships, as a table.
 *
 * WHY THIS EXISTS, and why S6R argues it should be the default rather than an
 * afterthought.
 *
 * The controlled experiment everyone cites here — Ghoniem, Fekete & Castagliola,
 * *A Comparison of the Readability of Graphs Using Node-Link and Matrix-Based
 * Representations* — found that above **twenty vertices** a matrix beats a
 * node-link diagram on most tasks, with a lead of about 30% of correct answers,
 * and that "only path finding is consistently in favour of node-link".
 *
 * This page runs both sides of that threshold. Worker mode is **7 nodes**, below
 * it, where the picture genuinely wins — and it has a table anyway, because a
 * node-link diagram owes a text alternative. Entity mode is **38 nodes and 103
 * edges**, well above it, and had only the picture.
 *
 * So this is not just the accessibility alternative. For everything except
 * tracing a path, it is the better instrument for this data.
 *
 * ONE ROW PER RELATIONSHIP, not per node. The unit of this mode is the edge —
 * "these two compete, on this search term" — and a row per node would put the
 * thing the reader came for inside a cell.
 *
 * IT CARRIES THE EVIDENCE. `properties.on` is the set of search terms the
 * inference rests on — a set, not one term, which is what S6.i had to correct.
 * A derived relationship that cannot say what it was derived from asks the
 * reader to take it on trust, and none of the data-catalog tools surveyed
 * surfaces this at all.
 *
 * NO ACTIONS. Same rule as the worker list: this shows derived relationships
 * and nothing else. There is no dial here, and there is nothing to press.
 */

import { DataGrid, type Column } from '@/design-system/components/DataGrid'
import { relationOf, type EntityGraph, type EntityEdge } from './EntityCanvas'
/* S6.i — its own module so it can be tested: this file imports the design
   system, and the apps/web vitest runner has no `@/` alias. */
import { termsOf } from './entity-terms'

const keyOf = (t: string, i: string) => `${t}|${i}`

export function EntityListView({
  graph,
  selectedKey,
  onSelect,
}: {
  graph: EntityGraph
  selectedKey: string | null
  onSelect: (key: string | null) => void
}) {
  const nameOf = (type: string, id: string) =>
    graph.nodes.find((n) => n.type === type && n.id === id)?.label ?? id
  const degreeOf = (type: string, id: string) =>
    graph.nodes.find((n) => n.type === type && n.id === id)?.degree ?? 0

  const columns: Array<Column<EntityEdge & { _i: number }>> = [
    {
      key: 'from',
      label: 'This campaign',
      width: 236,
      sortable: true,
      sortValue: (e) => nameOf(e.fromType, e.from).toLowerCase(),
      render: (e) => {
        const k = keyOf(e.fromType, e.from)
        return (
          <button
            type="button"
            className={`sbm-listname ${selectedKey === k ? 'on' : ''}`}
            onClick={() => onSelect(k === selectedKey ? null : k)}
            aria-pressed={selectedKey === k}
          >
            <span className="nm">{nameOf(e.fromType, e.from)}</span>
          </button>
        )
      },
    },
    {
      key: 'relation',
      label: 'Relationship',
      width: 150,
      sortable: true,
      sortValue: (e) => relationOf(e.relation).label,
      /* The swatch class is the SAME class that colours the edge on the canvas —
         the one-source rule this page holds every legend to. */
      render: (e) => (
        <span className="sbm-entrel">
          <span className={`sbm-swatch ${relationOf(e.relation).className}`} aria-hidden />
          {relationOf(e.relation).label}
        </span>
      ),
    },
    {
      key: 'to',
      label: 'That campaign',
      width: 236,
      sortable: true,
      sortValue: (e) => nameOf(e.toType, e.to).toLowerCase(),
      render: (e) => {
        const k = keyOf(e.toType, e.to)
        return (
          <button
            type="button"
            className={`sbm-listname ${selectedKey === k ? 'on' : ''}`}
            onClick={() => onSelect(k === selectedKey ? null : k)}
            aria-pressed={selectedKey === k}
          >
            <span className="nm">{nameOf(e.toType, e.to)}</span>
          </button>
        )
      },
    },
    {
      key: 'on',
      label: 'Worked out from',
      width: 250,
      sortable: true,
      sortValue: (e) => termsOf(e.properties?.on ?? '')[0]?.term ?? '',
      render: (e) => {
        const on = e.properties?.on
        if (!on) return <span className="sbm-listdim">not recorded</span>
        const ts = termsOf(on)
        if (!ts.length) return <span className="sbm-listdim">not recorded</span>
        /* One term fits a cell; ten do not. Show the first and SAY how many are
           behind it, so the cell reads as a sample rather than the whole
           evidence — the same obligation the capped table takes on in its
           footer. No claim is made about which term matters most: the fleet
           records them as a set and this page does not rank them. */
        const [first, ...rest] = ts
        return (
          <span className="sbm-entterm">
            {first.term}
            {first.type ? <span className="sbm-listdim"> {first.type}</span> : null}
            {rest.length ? <span className="sbm-listdim"> +{rest.length} more</span> : null}
          </span>
        )
      },
    },
    {
      key: 'links',
      label: 'Its links',
      width: 82,
      align: 'right',
      sortable: true,
      /* "Which campaign is tangled up in the most overlap" — one click, and the
         question the picture answers worst. */
      sortValue: (e) => -degreeOf(e.fromType, e.from),
      render: (e) => degreeOf(e.fromType, e.from),
    },
  ]

  const rows = graph.edges.map((e, _i) => ({ ...e, _i }))

  return (
    <div className="sbm-listwrapper">
      <DataGrid
        className="sbm-listgrid"
        columns={columns}
        rows={rows}
        rowKey={(e) => `${e.fromType}|${e.from}->${e.toType}|${e.to}->${e.relation}->${e._i}`}
        rowClassName={(e) =>
          selectedKey === keyOf(e.fromType, e.from) || selectedKey === keyOf(e.toType, e.to)
            ? 'is-selected'
            : undefined
        }
        initialSort={{ key: 'links', dir: 'asc' }}
        emptyState="No relationships worked out yet."
      />
      {/* S6.g — this sentence used to say "the fleet derived N of them" in every
          case. Forced `truncated: true` on production and the screen contradicted
          itself: the band said "Capped, so it shows the strongest links first"
          while this footer presented the same 40 rows as the whole set. That is
          the defect S6.a fixed one phase earlier — a surface stating a fact it is
          not showing — reintroduced by the surface I added to replace it. */}
      <p className="sbm-listfoot">
        {graph.truncated ? (
          <>
            The strongest {graph.edges.length} relationships, across {graph.nodes.length} campaigns
            — the fleet worked out more than this view carries. Open one campaign to see everything
            around it.
          </>
        ) : (
          <>
            One row per relationship the fleet derived — {graph.edges.length} of them, across{' '}
            {graph.nodes.length} campaigns.
          </>
        )}{' '}
        <b>Worked out from</b> is the search term the fleet saw them both bidding on. Nothing here
        changes anything; the workers read these directly.
      </p>
    </div>
  )
}
