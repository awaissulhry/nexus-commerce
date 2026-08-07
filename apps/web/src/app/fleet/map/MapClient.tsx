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

import { useCallback, useMemo, useState } from 'react'
import Link from 'next/link'
import { Map as MapIcon, RefreshCw, ShieldAlert, ArrowRight } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'
import { Term } from '@/app/marketing/ads/rules-automation/fleet/glossary'
import { useVisibilityPoll } from '../_shared/use-visibility-poll'
import { MapCanvas } from './MapCanvas'
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
  const [selected, setSelected] = useState<string | null>(null)

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
  const dimmed = useMemo(() => {
    if (!activeChip) return new Set<string>()
    const chip = CHIPS.find((c) => c.id === activeChip)
    if (!chip) return new Set<string>()
    return new Set(nodes.filter((n) => !chip.matches(n)).map((n) => n.key))
  }, [activeChip, nodes])

  const windowLabel = WINDOWS.find((w) => w.key === windowKey)?.label ?? windowKey

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
                  const note = count === 0 && chip.zeroNote ? chip.zeroNote : chip.definition
                  return (
                    <button
                      key={chip.id}
                      type="button"
                      className={`sbm-chip ${on ? 'on' : ''} ${chip.rank === 'subject' ? 'subject' : ''}`}
                      aria-pressed={on}
                      title={note}
                      onClick={() =>
                        setActiveChip(chip.id === 'workers' ? null : on ? null : chip.id)
                      }
                    >
                      <span className="n">{count}</span> {chip.label}
                    </button>
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

      {/* ── M2 · the canvas ───────────────────────────────────────────── */}
      {data == null ? (
        <div className="sbm-canvas sbm-skeleton" aria-busy="true" aria-label="Loading the map" />
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
        <MapCanvas
          nodes={nodes}
          edges={data.edges}
          windowLabel={windowLabel}
          dimmedKeys={dimmed}
          selectedKey={selected}
          onSelect={setSelected}
        />
      )}

      {/* Until the inspector rail lands (M.3), a selection still has to lead
          somewhere — a node you can click and cannot act on is a dead end. */}
      {selected ? (
        <p className="sbm-selline" role="status">
          Selected <b>{nodes.find((n) => n.key === selected)?.name ?? selected}</b> —{' '}
          <Link href={`/fleet/workers/${selected}`}>open its profile</Link>. The detail panel
          arrives with the next step.
        </p>
      ) : null}

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
    </div>
  )
}
