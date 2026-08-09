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
import { Map as MapIcon, Network, RefreshCw, ShieldAlert, ArrowRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { MapCanvas } from './MapCanvas'
import { InspectorRail } from './InspectorRail'
import { OverlayRail } from './OverlayRail'
import { ListView } from './ListView'
import { EntityCanvas, relationOf, type EntityGraph } from './EntityCanvas'
import { HowThisMapWorks } from './HowThisMapWorks'
import { CensusBand, CensusBandSkeleton } from './CensusBand'
import { overlayById } from './overlays'
import { CHIPS, type FleetMapPayload } from './lib'

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
  const [railCollapsed, setRailCollapsed] = useState(false)
  const [tierFilter, setTierFilter] = useState<string | null>(null)
  const [hideDiagnostic, setHideDiagnostic] = useState(false)
  const [view, setView] = useState<'map' | 'list'>('map')
  /** Which universe the page is showing: the workers, or the things they
   *  reason about. Two different node sets, one shell. */
  const [mode, setMode] = useState<'workers' | 'entities'>('workers')
  const [entity, setEntity] = useState<EntityGraph | null>(null)
  const [entityLoading, setEntityLoading] = useState(false)
  const [entityErr, setEntityErr] = useState(false)
  const [entitySel, setEntitySel] = useState<string | null>(null)
  /** The walk back. The breadcrumb IS the back-stack — one of them, not two. */
  const [trail, setTrail] = useState<Array<{ type: string; id: string; label: string }>>([])
  /** A signal, not a boolean: the band asks the teaching drawer to open at
   *  "What each number counts", and asking twice in a row must work. */
  const [explainAt, setExplainAt] = useState<number | undefined>(undefined)

  const loadEntities = useCallback(
    async (focus?: { type: string; id: string }) => {
      setEntityLoading(true)
      try {
        const qs = focus ? `?type=${encodeURIComponent(focus.type)}&id=${encodeURIComponent(focus.id)}` : ''
        const r = await fetch(`${backend}/api/agent/fleet/entity-graph${qs}`, { cache: 'no-store' })
        if (!r.ok) throw new Error(String(r.status))
        setEntity((await r.json()) as EntityGraph)
        setEntitySel(null)
        setEntityErr(false)
      } catch {
        setEntity(null)
        // S1R: "could not read" and "still reading" must not be the same
        // pixels. Without this the band cannot tell them apart, and a failed
        // first read spins a skeleton with aria-busy set, forever.
        setEntityErr(true)
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
    const next = (await r.json()) as FleetMapPayload
    /**
     * Only re-render when something actually changed.
     *
     * This is not a micro-optimisation, it is a correctness fix. Every poll
     * handed React Flow a brand-new node array, which it treats as nodes
     * needing measurement — so it sets `visibility: hidden` on all of them,
     * measures, and shows them again. Measured on prod: all eight nodes
     * reporting `visibility: hidden` while plainly painted on screen, because
     * the sample landed inside one of those windows.
     *
     * For a mouse that is an invisible flicker. For a keyboard user it is
     * worse: a hidden element cannot hold focus, so every ten seconds their
     * place in the graph is taken away from them.
     *
     * `asOf` changes on every read by definition, so it is excluded from the
     * comparison — otherwise nothing would ever compare equal and the fix
     * would do nothing.
     */
    setData((prev) => {
      if (!prev) return next
      const strip = (p: FleetMapPayload) => JSON.stringify({ ...p, asOf: '' })
      return strip(prev) === strip(next) ? prev : next
    })
  }, [backend, windowKey])

  const { asOf, refresh } = useVisibilityPoll(load)

  const nodes = data?.nodes ?? []

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
          {/*
            S2R — the SUBJECT control, under the title.

            It changes which universe of nodes the page is about; the window
            switch on the right changes the denominator of every number. They
            were pixel-identical devices 10px apart, which asked the reader to
            learn which was which from position alone. Now they differ in
            position, in shape and in label.
          */}
          <div className="sbm-modetabs" role="radiogroup" aria-label="What to show">
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
                {m === 'workers' ? 'The fleet' : 'What they watch'}
              </button>
            ))}
          </div>
        </div>
        <div className="sbm-head-right">
          {/* S2R — the two switches change different ORDERS of thing and were
              pixel-identical 10px apart. This one qualifies every number on the
              page; it now says so rather than relying on the reader inferring
              it from position. */}
          <span className="sbm-seglabel" aria-hidden>
            Window
          </span>
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

      <HowThisMapWorks openSignal={explainAt} />

      {/* ── M6 · entity mode: a different universe, the same shell ─────── */}
      {mode === 'entities' ? (
        <>
          {/* S1.d — the same band, for a universe with no partition to draw.
              What this replaces was two <span className="sbm-chip subject">
              elements: cursor:pointer, no role, no tabindex, no definition, and
              pixel-identical to the Workers-mode chips that ARE buttons and DO
              filter. Nothing here filters, so nothing here is drawn as a
              control, and the two counts are a sentence. Measured dead width in
              that mode was 977.6px — 60.6%. */}
          {entity == null ? (
            /* `entityErr`, not `err`: `err` is the MAP read, and this mode is
               reading a different endpoint. Wiring the wrong signal here would
               have reported "the fleet could not be read" over a perfectly
               healthy entity graph. */
            <CensusBandSkeleton failed={entityErr} />
          ) : (
            <section className="sbm-band tone-entities" aria-label="What this view shows">
              <div className="sbm-verdict">
                <p className="sbm-verdict-head">
                  <Network size={15} aria-hidden />
                  <span>
                    {entity.nodes.length} things the fleet watches, and {entity.edges.length} links
                    it worked out between them.
                  </span>
                </p>
                <p className="sbm-verdict-sub">
                  {entity.truncated
                    ? 'Capped, so it shows the strongest links first — open one thing to see everything around it.'
                    : 'This is what the workers reason about. The Workers view is what the fleet is.'}
                </p>
              </div>

              {/* The relation mix, which IS a partition of the links — the same
                  device as the workers meter, reading from the same counts the
                  rail names beside it, so the bar and the legend cannot become
                  two sources. */}
              <div className="sbm-meterwrap">
                <div
                  className="sbm-meter"
                  role="img"
                  aria-label={`Link types: ${Object.entries(entity.relationCounts ?? {})
                    .map(([r, n]) => `${n} ${relationOf(r).label}`)
                    .join(', ')}`}
                >
                  {Object.entries(entity.relationCounts ?? {})
                    .sort(([, a], [, b]) => b - a)
                    .map(([rel, n]) => (
                      <span
                        key={rel}
                        className={`sbm-mseg sbm-swatch ${relationOf(rel).className}`}
                        style={{ flexGrow: n }}
                      />
                    ))}
                </div>
              </div>

              <div className="sbm-facts">
                <div className="sbm-bfact">
                  <span className="k">Rebuilt</span>
                  <span className="v">every night, by the sweep</span>
                </div>
              </div>
            </section>
          )}

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
                <span className="sbm-gesturehint">
                  Scroll to move · ⌘/Ctrl + scroll to zoom · double-click a card to focus it
                </span>
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
      {/* ── M1 · the census band (S1R) ────────────────────────────────── */}
      {data == null ? (
        <CensusBandSkeleton failed={err != null} />
      ) : (
        <CensusBand
          nodes={nodes}
          halted={data.state.halted}
          spentTodayUSD={data.state.spentTodayUSD}
          dailyCeilingUSD={data.state.dailyCeilingUSD}
          activeChip={activeChip}
          onChip={setActiveChip}
          onExplain={() => setExplainAt(Date.now())}
        />
      )}

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
        <div
          className={`sbm-body ${view === 'list' ? 'is-list' : ''} ${railCollapsed ? 'is-railcollapsed' : ''}`}
        >
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
              {/* S2R — the gesture, said out loud. Verified on prod that the
                  convention already holds (plain wheel pans, ctrl/⌘+wheel zooms
                  1.0 → 1.8), so this needed no code, only saying. A gesture
                  nobody mentions is a gesture nobody finds. */}
              {view === 'map' ? (
                <span className="sbm-gesturehint">Scroll to move · ⌘/Ctrl + scroll to zoom</span>
              ) : null}
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
                /* The same `dimmed` the canvas gets. The table used to ignore
                   it while the state persisted and its control disappeared
                   with the rail — see ListView's own note. */
                dimmedKeys={dimmed}
              />
            )}
          </div>
          <InspectorRail
            nodes={nodes}
            edges={data.edges}
            selection={selection}
            onSelect={setSelection}
            onClose={() => setSelection(null)}
            /* S4.g — the state lives here rather than in the rail so the BODY
               can re-column: a collapsed rail is a 44px track, not a 340px one
               with an empty panel in it. */
            collapsed={railCollapsed}
            onCollapsed={setRailCollapsed}
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
