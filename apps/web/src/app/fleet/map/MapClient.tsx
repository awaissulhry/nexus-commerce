'use client'

/**
 * NAF.SB.M.1b — the Fleet map page.
 *
 * Study: docs/2026-08-07-naf-sbm-fleet-map-page.md. Sections built here are M1
 * (the census strip) and the core of M2 (the canvas). The overlay picker and
 * legend (M3), the inspector rail (M4) and the list view (M5) are later steps
 * and deliberately absent rather than stubbed.
 *
 * The page is READ-ONLY, by operator decision. Every control either changes
 * what you are looking at or navigates. Nothing here writes, so it inherits
 * none of the three dial-bypassing paths the spend audit found.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Map as MapIcon, RefreshCw, ShieldAlert, ArrowRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { MapCanvas } from './MapCanvas'
import { InspectorRail } from './InspectorRail'
import { OverlayRail } from './OverlayRail'
import { ListView } from './ListView'
import { EntityCanvas, relationOf, type EntityGraph } from './EntityCanvas'
import { HowThisMapWorks } from './HowThisMapWorks'
import { Def } from './definitions'
import { overlayById } from './overlays'
import {
  visibleCensus,
  filterSummary,
  diagnosticFootnote,
  CHIPS,
  type FleetMapPayload,
} from './lib'

const WINDOWS: Array<{ key: string; label: string }> = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'all time' },
]

export function MapClient() {
  const backend = getBackendUrl()
  const [data, setData] = useState<FleetMapPayload | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [windowKey, setWindowKey] = useState('7d')
  const [activeChip, setActiveChip] = useState<string | null>(null)
  /** One selection for the whole page: a worker, an edge, or nothing. Two
   *  separate selection states would let the rail show a worker while the
   *  canvas highlights an edge. */
  const [selection, setSelection] = useState<{ kind: 'worker' | 'edge'; id: string } | null>(null)
  const [overlayId, setOverlayId] = useState('autonomy')
  const [tierFilter, setTierFilter] = useState<string | null>(null)
  const [hideDiagnostic, setHideDiagnostic] = useState(false)
  const [view, setView] = useState<'map' | 'list'>('map')
  /** Which universe the page is showing: the workers, or the things they
   *  reason about. Two different node sets, one shell. */
  const [mode, setMode] = useState<'workers' | 'entities'>('workers')
  const [entity, setEntity] = useState<EntityGraph | null>(null)
  const [entityLoading, setEntityLoading] = useState(false)
  const [entitySel, setEntitySel] = useState<string | null>(null)
  /** The walk back. The breadcrumb IS the back-stack — one of them, not two. */
  const [trail, setTrail] = useState<Array<{ type: string; id: string; label: string }>>([])

  const loadEntities = useCallback(
    async (focus?: { type: string; id: string }) => {
      setEntityLoading(true)
      try {
        const qs = focus ? `?type=${encodeURIComponent(focus.type)}&id=${encodeURIComponent(focus.id)}` : ''
        const r = await fetch(`${backend}/api/agent/fleet/entity-graph${qs}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(String(r.status))
        setEntity((await r.json()) as EntityGraph)
        setEntitySel(null)
      } catch {
        setEntity(null)
      } finally {
        setEntityLoading(false)
      }
    },
    [backend],
  )

  useEffect(() => {
    if (mode === 'entities' && entity == null && !entityLoading) void loadEntities()
  }, [mode, entity, entityLoading, loadEntities])

  const load = useCallback(async () => {
    const r = await fetch(`${backend}/api/agent/fleet/map?window=${windowKey}`, {
      cache: 'no-store',
    })
    if (!r.ok) {
      setErr(`The map could not be loaded (${r.status}).`)
      throw new Error(String(r.status))
    }
    setErr(null)
    setData((await r.json()) as FleetMapPayload)
  }, [backend, windowKey])

  const { asOf, refresh } = useVisibilityPoll(load)

  const nodes = data?.nodes ?? []
  const rows = useMemo(() => visibleCensus(nodes), [nodes])
  const footnote = useMemo(() => diagnosticFootnote(nodes), [nodes])

  /* Filtering DIMS; it never removes and never re-lays-out. A node that jumps
     position when you press a chip destroys the spatial memory that is the
     only reason a map beats a list. */
  const overlay = useMemo(() => overlayById(overlayId), [overlayId])

  const dimmed = useMemo(() => {
    const out = new Set<string>()
    const chip = activeChip ? CHIPS.find((c) => c.id === activeChip) : null
    for (const n of nodes) {
      if (chip && !chip.matches(n)) out.add(n.key)
      if (tierFilter && n.tier !== tierFilter) out.add(n.key)
      if (hideDiagnostic && n.diagnostic) out.add(n.key)
    }
    return out
  }, [activeChip, nodes, tierFilter, hideDiagnostic])

  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey

  /**
   * The URL is the shareable unit. Selection state that lives only in React
   * cannot be pasted into a message, which is most of what an operations map
   * is for.
   *
   * Read once on mount, written with `replaceState` so selecting six workers
   * in a row does not leave six entries in the back button. Deliberately
   * `window.location` rather than `useSearchParams`: the hook drags a Suspense
   * boundary requirement onto the page for a value this component owns
   * outright, and `history.replaceState` needs no router.
   *
   * Semantic state only — which worker, which view, which window. Not the
   * viewport: "centred on this worker" survives a layout change, an absolute
   * pan-and-zoom does not.
   */
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const w = q.get('worker')
    const e = q.get('edge')
    if (w) setSelection({ kind: 'worker', id: w })
    else if (e) setSelection({ kind: 'edge', id: e })
    if (q.get('view') === 'list') setView('list')
    const win = q.get('window')
    if (win && WINDOWS.some((x) => x.key === win)) setWindowKey(win)
    const ov = q.get('colour')
    if (ov) setOverlayId(ov)
  }, [])

  useEffect(() => {
    const q = new URLSearchParams()
    if (selection?.kind === 'worker') q.set('worker', selection.id)
    if (selection?.kind === 'edge') q.set('edge', selection.id)
    if (view === 'list') q.set('view', 'list')
    if (windowKey !== '7d') q.set('window', windowKey)
    if (overlayId !== 'autonomy') q.set('colour', overlayId)
    const s = q.toString()
    window.history.replaceState(null, '', s ? `?${s}` : window.location.pathname)
  }, [selection, view, windowKey, overlayId])

  /* Escape precedence for this page, agreed once across the section studies:
     an open dialog first, then a confirm, then an active filter chip if focus
     is in the strip, then the selection. Only the last two exist today, so
     this is the whole of it — and it is written here rather than in four
     components that would each claim the key. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (selection) setSelection(null)
      else if (activeChip) setActiveChip(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [selection, activeChip])

  return (
    <div className="sbm-page">
      <header className="sbm-head">
        <div className="sbm-head-left">
          <h1>
            <MapIcon size={17} aria-hidden /> Fleet map
          </h1>
          <p className="sbm-sub">
            How the whole fleet fits together, live, on one canvas. This page is the fleet{' '}
            <i>as it is</i>; <Link href="/fleet/workflows">Workflows</Link> is where you change what
            it should be.
          </p>
        </div>
        <div className="sbm-head-right">
          {/* The mode switch changes the page's whole subject — which universe
              of nodes you are looking at — so it belongs with the title, not
              above the canvas where Map/List sits. */}
          <div className="sbm-seg" role="radiogroup" aria-label="What to show">
            {(['workers', 'entities'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? 'on' : ''}
                onClick={() => {
                  setMode(m)
                  setSelection(null)
                }}
              >
                {m === 'workers' ? 'Workers' : 'What they watch'}
              </button>
            ))}
          </div>
          <div className="sbm-seg" role="radiogroup" aria-label="Time window">
            {WINDOWS.map((w) => (
              <button
                key={w.key}
                type="button"
                role="radio"
                aria-checked={windowKey === w.key}
                className={windowKey === w.key ? 'on' : ''}
                onClick={() => setWindowKey(w.key)}
              >
                {w.label}
              </button>
            ))}
          </div>
          <span className="sbm-asof">
            {asOf ? `as of ${asOf.toLocaleTimeString()}` : 'loading…'}
          </span>
          <button type="button" className="acr-btn" onClick={refresh}>
            <RefreshCw size={13} aria-hidden /> Refresh
          </button>
        </div>
      </header>

      {err ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} aria-hidden /> {err}
          <button type="button" className="acr-btn" onClick={refresh}>
            Try again
          </button>
        </div>
      ) : null}

      {/* The halt is stated ONCE, here. It applies to every node identically,
          so encoding it on the canvas would spend the whole colour channel on
          one bit that is already a sentence. */}
      {data?.state.halted ? (
        <div className="acr-banner err" role="alert">
          <ShieldAlert size={15} aria-hidden />
          <span>
            The fleet is <b>halted</b>
            {data.state.haltReason ? ` — ${data.state.haltReason}` : ''}
            {data.state.haltedBy ? `, by ${data.state.haltedBy}` : ''}. Nothing will run, whatever
            any dial below says.
          </span>
          <Link href="/fleet/controls" className="sbm-banner-link">
            Controls <ArrowRight size={12} aria-hidden />
          </Link>
        </div>
      ) : null}

      {data?.wiring.degraded ? (
        <div className="acr-banner warn" role="status">
          Your saved routines could not be read, so this shows the built-in wiring — which is what
          would run.
        </div>
      ) : null}

      <HowThisMapWorks />

      {/* ── M6 · entity mode: a different universe, the same shell ─────── */}
      {mode === 'entities' ? (
        <>
          <section className="sbm-census" aria-label="What is on this map">
            <div className="sbm-census-rows">
              <div className="sbm-chiprow rank-subject">
                <span className="sbm-chip subject">
                  <span className="n">{entity?.nodes.length ?? 0}</span> things
                </span>
                <span className="sbm-chip subject">
                  <span className="n">{entity?.edges.length ?? 0}</span> relationships
                </span>
              </div>
            </div>
            <div className="sbm-census-side">
              <span className="sbm-spend">
                what the fleet has worked out about your campaigns — not what the fleet is
              </span>
            </div>
          </section>

          {entity?.truncated ? (
            <p className="sbm-footnote warn">
              This view is capped, so it shows the strongest links first. Open one thing to see
              everything around it.
            </p>
          ) : null}

          <div className="sbm-body">
            <aside className="sbm-orail" aria-label="What the lines mean">
              <div className="sbm-orail-sec">
                <h3>What the lines mean</h3>
                <ul className="sbm-legend">
                  {Object.entries(entity?.relationCounts ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([rel, n]) => {
                      const meta = relationOf(rel)
                      return (
                        <li key={rel}>
                          <span className={`sbm-swatch ${meta.className}`} aria-hidden />
                          <span className="txt">
                            <span className="lab">
                              {meta.label} · {n}
                            </span>
                            {meta.meaning ? <span className="note">{meta.meaning}</span> : null}
                          </span>
                        </li>
                      )
                    })}
                </ul>
                <p className="sbm-orail-foot">
                  Zoom in to read the names — the cards show more the closer you get. Double-click
                  anything to see everything around it.
                </p>
              </div>
            </aside>

            <div className="sbm-centre">
              <div className="sbm-viewswitch">
                {trail.length > 0 ? (
                  <nav className="sbm-crumbs" aria-label="Where you have been">
                    <button
                      type="button"
                      className="sbm-linkbtn"
                      onClick={() => {
                        setTrail([])
                        void loadEntities()
                      }}
                    >
                      Everything
                    </button>
                    {trail.map((t, i) => (
                      <span key={`${t.type}|${t.id}`}>
                        {' › '}
                        <button
                          type="button"
                          className="sbm-linkbtn"
                          onClick={() => {
                            setTrail(trail.slice(0, i + 1))
                            void loadEntities({ type: t.type, id: t.id })
                          }}
                        >
                          {t.label}
                        </button>
                      </span>
                    ))}
                  </nav>
                ) : (
                  <span className="sbm-viewhint">
                    Your campaigns, grouped into the families that actually touch each other.
                  </span>
                )}
              </div>
              {entityLoading && entity == null ? (
                <div className="sbm-canvas sbm-skeleton" aria-busy="true" />
              ) : entity && entity.nodes.length > 0 ? (
                <EntityCanvas
                  graph={entity}
                  selectedKey={entitySel}
                  onSelect={setEntitySel}
                  onFocus={(type, id) => {
                    const n = entity.nodes.find((x) => x.type === type && x.id === id)
                    setTrail([...trail, { type, id, label: n?.label ?? id }])
                    void loadEntities({ type, id })
                  }}
                />
              ) : (
                <div className="acr-pg-empty">
                  <strong>No relationships worked out yet.</strong>
                  <p>
                    The fleet rebuilds this every night with the sweep. Until it has, there is
                    nothing here to draw — which is not the same as there being nothing to find.
                  </p>
                </div>
              )}
            </div>

            <aside className="sbm-rail" aria-label="Details">
              <header className="sbm-rail-head">
                <h3>{entitySel ? 'Thing' : 'What this is'}</h3>
              </header>
              <div className="sbm-rail-body">
                {(() => {
                  const n = entity?.nodes.find((x) => `${x.type}|${x.id}` === entitySel)
                  if (!n) {
                    return (
                      <p className="sbm-rail-hint">
                        These are your campaigns and products, and the links the fleet worked out
                        between them by reading your data. It is what the workers reason{' '}
                        <i>about</i> — the Workers view is what the fleet <i>is</i>.
                      </p>
                    )
                  }
                  const links = (entity?.edges ?? []).filter(
                    (e) =>
                      `${e.fromType}|${e.from}` === entitySel || `${e.toType}|${e.to}` === entitySel,
                  )
                  return (
                    <>
                      <div className="sbm-rail-id">
                        <div>
                          <div className="nm">{n.label}</div>
                          <div className="ky">{n.type.toLowerCase()}</div>
                        </div>
                      </div>
                      <h4>Its links</h4>
                      {links.length === 0 ? (
                        <p className="sbm-dim">None in this view.</p>
                      ) : (
                        <ul className="sbm-samples">
                          {links.slice(0, 12).map((e, i) => {
                            const otherKey =
                              `${e.fromType}|${e.from}` === entitySel
                                ? `${e.toType}|${e.to}`
                                : `${e.fromType}|${e.from}`
                            const other = entity?.nodes.find((x) => `${x.type}|${x.id}` === otherKey)
                            return (
                              <li key={`${otherKey}-${e.relation}-${i}`}>
                                <span className="sbm-dim">{relationOf(e.relation).label}</span>{' '}
                                {other?.label ?? otherKey}
                              </li>
                            )
                          })}
                        </ul>
                      )}
                      <div className="sbm-rail-exits">
                        <button
                          type="button"
                          className="sbm-linkbtn"
                          onClick={() => {
                            setTrail([...trail, { type: n.type, id: n.id, label: n.label }])
                            void loadEntities({ type: n.type, id: n.id })
                          }}
                        >
                          Show everything around it →
                        </button>
                      </div>
                    </>
                  )
                })()}
              </div>
            </aside>
          </div>

          <footer className="sbm-foot">
            Rebuilt every night by the sweep. An id shown instead of a name is one the fleet could
            not resolve — shown as itself rather than invented.
          </footer>
        </>
      ) : (
        <>
      {/* ── M1 · the census strip ─────────────────────────────────────── */}
      <section className="sbm-census" aria-label="What is on this map">
        <div className="sbm-census-rows">
          {(['subject', 'state', 'fact'] as const).map((rank) => {
            const group = rows.filter((r) => r.chip.rank === rank)
            if (group.length === 0) return null
            return (
              <div key={rank} className={`sbm-chiprow rank-${rank}`}>
                {rank === 'fact' ? <span className="sbm-chiprow-label">also</span> : null}
                {group.map(({ chip, count }) => {
                  const on = activeChip === chip.id
                  // A zero with a structural cause explains itself rather than
                  // reading as an empty inbox.
                  const note = count === 0 && chip.zeroNote ? chip.zeroNote : undefined
                  return (
                    <Def key={chip.id} k={chip.id} note={note}>
                      {(described) => (
                        <button
                          type="button"
                          className={`sbm-chip ${on ? 'on' : ''} ${chip.rank === 'subject' ? 'subject' : ''}`}
                          aria-pressed={on}
                          {...described}
                          onClick={() =>
                            setActiveChip(chip.id === 'workers' ? null : on ? null : chip.id)
                          }
                        >
                          <span className="n">{count}</span> {chip.label}
                        </button>
                      )}
                    </Def>
                  )
                })}
              </div>
            )
          })}
        </div>
        <div className="sbm-census-side">
          {data ? (
            <span className="sbm-spend">
              spent <b>${data.state.spentTodayUSD.toFixed(4)}</b> of the{' '}
              <Term k="ceiling">${data.state.dailyCeilingUSD.toFixed(2)} daily ceiling</Term> today
            </span>
          ) : null}
        </div>
      </section>

      {activeChip ? (
        <p className="sbm-filterline" role="status">
          {filterSummary(nodes, activeChip)} — the rest are dimmed, not hidden.{' '}
          <button type="button" className="sbm-linkbtn" onClick={() => setActiveChip(null)}>
            Show all
          </button>
        </p>
      ) : null}

      {footnote ? <p className="sbm-footnote">{footnote}</p> : null}

      {data?.warnings.map((w) => (
        <p key={w} className="sbm-footnote warn">
          {w}
        </p>
      ))}

      {/* ── M2 · the canvas, M3 · the rail beside it ──────────────────── */}
      {data == null ? (
        <div className="sbm-body">
          <div className="sbm-canvas sbm-skeleton" aria-busy="true" aria-label="Loading the map" />
        </div>
      ) : nodes.length === 0 ? (
        <div className="acr-pg-empty">
          <strong>No workers to draw yet.</strong>
          <p>
            A worker appears here once a routine names it, or once you create one. Nothing is
            broken — there is simply nothing wired up.
          </p>
          <Link href="/fleet/workers">Go to Workers</Link>
        </div>
      ) : (
        <div className={`sbm-body ${view === 'list' ? 'is-list' : ''}`}>
          {/* The overlay rail explains the CANVAS's colours. In list view it
              would be a legend for tints the table does not use, while taking
              216px the adjacency columns need — so the table gets the width
              instead. The colour choice is remembered and comes back with the
              map. */}
          {view === 'map' ? (
            <OverlayRail
              overlay={overlay}
              onOverlay={setOverlayId}
              nodes={nodes}
              tierFilter={tierFilter}
              onTierFilter={setTierFilter}
              hideDiagnostic={hideDiagnostic}
              onHideDiagnostic={setHideDiagnostic}
            />
          ) : null}
          <div className="sbm-centre">
            {/* Map or List changes how the middle is drawn, not what the page
                is about — so it belongs above the canvas, not with the title. */}
            <div className="sbm-viewswitch">
              <div className="sbm-seg" role="radiogroup" aria-label="How to show the fleet">
                {(['map', 'list'] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    className={view === v ? 'on' : ''}
                    onClick={() => setView(v)}
                  >
                    {v === 'map' ? 'Map' : 'List'}
                  </button>
                ))}
              </div>
              <span className="sbm-viewhint">
                {view === 'map'
                  ? 'Best for seeing where work goes next.'
                  : 'Best for ranking — who costs most, who has the most open.'}
              </span>
            </div>
            {view === 'map' ? (
              <MapCanvas
                nodes={nodes}
                edges={data.edges}
                windowLabel={windowLabel}
                overlay={overlay}
                dimmedKeys={dimmed}
                selectedKey={selection?.kind === 'worker' ? selection.id : null}
                selectedEdgeId={selection?.kind === 'edge' ? selection.id : null}
                onSelect={(k) => setSelection(k ? { kind: 'worker', id: k } : null)}
                onSelectEdge={(id) => setSelection(id ? { kind: 'edge', id } : null)}
              />
            ) : (
              <ListView
                nodes={nodes}
                edges={data.edges}
                selectedKey={selection?.kind === 'worker' ? selection.id : null}
                onSelect={(k) => setSelection(k ? { kind: 'worker', id: k } : null)}
              />
            )}
          </div>
          <InspectorRail
            nodes={nodes}
            edges={data.edges}
            selection={selection}
            onSelect={setSelection}
            onClose={() => setSelection(null)}
          />
        </div>
      )}

      <footer className="sbm-foot">
        {data ? (
          <>
            Wiring read from{' '}
            <b>
              {data.wiring.workflows.length} enabled{' '}
              {data.wiring.workflows.length === 1 ? 'routine' : 'routines'}
            </b>
            {data.wiring.workflows.length > 0
              ? ` — ${data.wiring.workflows.map((w) => w.workflowKey).join(', ')}`
              : ''}
            . Workers that the nightly job runs directly are shown in their own lane, because no
            routine lists them.
          </>
        ) : null}
      </footer>
        </>
      )}
    </div>
  )
}
