'use client'

/**
 * NAF.SB.M.1b — the map canvas.
 *
 * FIVE RULES, each of which cost something to learn.
 *
 * 1. LAYOUT IS A FUNCTION OF TOPOLOGY, NEVER OF STATE. Positions are computed
 *    from the worker set and the edges alone, memoised on a hash of exactly
 *    that, and sorted before layout so the drawing is identical every mount. A
 *    10-second poll that flips a worker to running or adds three findings
 *    repaints in place and never moves anything. This is the defect that makes
 *    live graphs unusable — nodes drift, the reader loses object constancy,
 *    and clicking becomes a moving-target game.
 *
 * 2. COLOUR IS NEVER THE CARRIER. Every status is a ring AND a glyph AND the
 *    literal word, with colour as the redundant fourth cue. WCAG 1.4.1 is a
 *    Level A failure, and the map has to survive a greyscale screenshot in a
 *    ticket.
 *
 * 3. OFF IS GREY, NEVER RED. A worker the operator switched off is not asking
 *    for anything. Red for a thing you turned off yourself trains people to
 *    ignore red. Never-run is a dashed neutral outline and is NOT dimmed —
 *    absence of data is not an error, and dimming it would hide the coverage
 *    gap that is usually the actual finding.
 *
 * 4. NO INLINE HEX. The DS ratchet matches `style={{ … #hex }}` in TSX, the
 *    `fleet` section has no baseline row so the guard's zero fallback applies,
 *    and it scans the WORKING TREE — one violation here blocks every
 *    concurrent session's push, which has already happened once. Every colour
 *    on this canvas comes from a class in `map.css`.
 *
 * 5. TEACHING CANNOT LIVE ON THE CANVAS. `<Term>`'s tooltip is absolutely
 *    positioned at z-index 40 and every canvas wrapper sets `overflow: hidden`,
 *    so a `<Term>` inside here is clipped. Explanations live in the strip and
 *    the rails; the canvas carries words, not tooltips.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { statusOf, type MapEdge, type MapNode } from './lib'
import type { Overlay } from './overlays'

const COL_W = 320
const ROW_H = 116
const LANE_GAP = 72

interface WorkerNodeData {
  name: string
  tier: string
  word: string
  label: string
  tone: string
  reason: string
  open: number
  openExpired: number
  costWindow: number
  runsLifetime: number
  neverRun: boolean
  diagnostic: boolean
  dimmed: boolean
  selected: boolean
  overlayClass: string
  [key: string]: unknown
}

function WorkerNode({ data }: NodeProps) {
  const d = data as unknown as WorkerNodeData
  return (
    <div
      className={[
        'sbm-node',
        `tone-${d.tone}`,
        /* The overlay owns the ring. Status keeps its glyph and its word, so
           switching to "what it cost" never costs the reader the ability to
           see what a worker IS — colour is one channel of three, never the
           carrier. */
        d.overlayClass,
        d.neverRun ? 'is-neverrun' : '',
        d.dimmed ? 'is-dimmed' : '',
        d.selected ? 'is-selected' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Handle type="target" position={Position.Left} className="sbm-handle" />
      <div className="sbm-node-top">
        <span className="sbm-node-name">{d.name}</span>
        {d.diagnostic ? <span className="sbm-tag-diag">self-test</span> : null}
      </div>
      <div className="sbm-node-status">
        <span className={`sbm-glyph g-${d.word}`} aria-hidden />
        <span className="sbm-node-word">{d.label}</span>
        <span className="sbm-node-tier">{d.tier}</span>
      </div>
      <div className="sbm-node-facts">
        {d.neverRun ? (
          <span className="sbm-fact muted">not yet run</span>
        ) : (
          <span className="sbm-fact">{d.runsLifetime} runs</span>
        )}
        {d.open > 0 ? (
          <span className="sbm-fact">
            {d.open} open{d.openExpired > 0 ? ` · ${d.openExpired} expired` : ''}
          </span>
        ) : null}
        {d.costWindow > 0 ? (
          <span className="sbm-fact">${d.costWindow.toFixed(4)}</span>
        ) : null}
      </div>
      <Handle type="source" position={Position.Right} className="sbm-handle" />
    </div>
  )
}

interface LaneNodeData {
  title: string
  note: string
  [key: string]: unknown
}
function LaneNode({ data }: NodeProps) {
  const d = data as unknown as LaneNodeData
  return (
    <div className="sbm-lane">
      <span className="sbm-lane-title">{d.title}</span>
      <span className="sbm-lane-note">{d.note}</span>
    </div>
  )
}

const nodeTypes = { worker: WorkerNode, lane: LaneNode }

/** Stable across mounts: the same fleet always draws the same picture. */
function topologyHash(nodes: MapNode[], edges: MapEdge[]): string {
  return [
    nodes
      .map((n) => `${n.key}:${n.lane}:${n.rank ?? '-'}`)
      .sort()
      .join('|'),
    edges.map((e) => e.id).sort().join('|'),
  ].join('#')
}

export function MapCanvas({
  nodes,
  edges,
  windowLabel,
  overlay,
  dimmedKeys,
  selectedKey,
  selectedEdgeId,
  onSelect,
  onSelectEdge,
}: {
  nodes: MapNode[]
  edges: MapEdge[]
  windowLabel: string
  overlay: Overlay
  dimmedKeys: Set<string>
  selectedKey: string | null
  selectedEdgeId: string | null
  onSelect: (key: string | null) => void
  onSelectEdge: (id: string | null) => void
}) {
  const hash = topologyHash(nodes, edges)

  /* Positions depend on the topology hash ALONE — never on status, counts or
     cost. That is what makes a poll repaint rather than rearrange. */
  const positions = useMemo(() => {
    const pos = new Map<string, { x: number; y: number }>()
    const lanes: Array<{ id: string; title: string; note: string; y: number }> = []

    const ranked = nodes.filter((n) => n.lane === 'ranked').slice().sort((a, b) => a.key.localeCompare(b.key))
    const byRank = new Map<number, MapNode[]>()
    for (const n of ranked) {
      const r = n.rank ?? 0
      byRank.set(r, [...(byRank.get(r) ?? []), n])
    }
    const ranks = [...byRank.keys()].sort((a, b) => a - b)
    const tallest = Math.max(1, ...ranks.map((r) => (byRank.get(r) ?? []).length))

    for (const r of ranks) {
      const members = byRank.get(r) ?? []
      const x = ranks.indexOf(r) * COL_W
      const pad = ((tallest - members.length) * ROW_H) / 2
      members.forEach((n, i) => pos.set(n.key, { x, y: pad + i * ROW_H }))
    }

    let y = tallest * ROW_H + LANE_GAP
    const others: Array<[MapNode['lane'], string, string]> = [
      [
        'standalone',
        'Runs as part of the nightly job',
        'Not a step of any routine — the job runs it directly, after the report cards.',
      ],
      [
        'unwired',
        'Not wired into any routine',
        'It exists, but no enabled routine names it, so nothing will start it.',
      ],
    ]
    for (const [lane, title, note] of others) {
      const members = nodes.filter((n) => n.lane === lane).slice().sort((a, b) => a.key.localeCompare(b.key))
      if (members.length === 0) continue
      lanes.push({ id: `lane-${lane}`, title, note, y })
      members.forEach((n, i) => pos.set(n.key, { x: i * COL_W, y: y + 46 }))
      y += 46 + Math.ceil(members.length / 4) * ROW_H + LANE_GAP
    }
    return { pos, lanes }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])

  const flowNodes: Node[] = useMemo(() => {
    const out: Node[] = positions.lanes.map((l) => ({
      id: l.id,
      type: 'lane',
      position: { x: 0, y: l.y },
      data: { title: l.title, note: l.note } satisfies LaneNodeData,
      draggable: false,
      selectable: false,
      connectable: false,
    }))
    for (const n of nodes) {
      const p = positions.pos.get(n.key)
      if (!p) continue
      const s = statusOf(n)
      out.push({
        id: n.key,
        type: 'worker',
        position: p,
        data: {
          name: n.name,
          tier: n.tier,
          word: s.word,
          label: s.label,
          tone: s.tone,
          reason: s.reason,
          open: n.findings.open,
          openExpired: n.findings.openExpired,
          costWindow: n.cost.windowUSD,
          runsLifetime: n.runs.lifetime,
          neverRun: n.runs.lifetime === 0,
          diagnostic: n.diagnostic,
          dimmed: dimmedKeys.has(n.key),
          selected: selectedKey === n.key,
          overlayClass: overlay.bucketOf(n).className,
        } satisfies WorkerNodeData,
        draggable: false,
        connectable: false,
      })
    }
    return out
  }, [nodes, positions, dimmedKeys, selectedKey, overlay])

  const flowEdges: Edge[] = useMemo(
    () =>
      edges.map((e) => {
        // A plan edge can never carry a volume: the critic does not author an
        // artifact, it records a verdict on the plan in place. So it says what
        // actually crossed — the verdict — rather than a fabricated count.
        // Kept short on purpose. Three analyst edges converge on the director,
        // so their labels sit within a few pixels of each other; "4 carried ·
        // 1 dropped" collided with its neighbour and truncated mid-word on
        // prod. What the director DROPPED and why is the edge inspector's
        // centrepiece (M.4), where there is room to print the reason it wrote.
        const label =
          e.artifact === 'plan'
            ? e.verdicts && e.verdicts.pass + e.verdicts.revise + e.verdicts.block > 0
              ? `${e.verdicts.block > 0 ? 'blocked' : e.verdicts.revise > 0 ? 'sent back' : 'passed'}`
              : 'nothing reviewed yet'
            : e.counts.crossed > 0
              ? `${e.counts.crossed} carried`
              : `nothing carried in ${windowLabel}`
        return {
          id: e.id,
          source: e.from,
          target: e.to,
          className: [
            'sbm-edge',
            e.everCrossed ? 'has-crossed' : 'never-crossed',
            e.counts.crossed > 0 ? 'is-live' : '',
            e.id === selectedEdgeId ? 'is-selected' : '',
          ]
            .filter(Boolean)
            .join(' '),
          /* A 1.4px line is not a click target. xyflow renders an invisible
             wider path underneath for hit-testing; this widens it so an edge
             is as clickable as a node, which it has to be — half the graph's
             information lives on the edges. */
          interactionWidth: 22,
          animated: false,
          label,
          labelShowBg: true,
          labelBgPadding: [6, 3] as [number, number],
          labelBgBorderRadius: 4,
        }
      }),
    [edges, windowLabel, selectedEdgeId],
  )

  /**
   * fitView runs once, at mount, against whatever the container measured at
   * that instant — and this canvas is a grid cell that settles slightly later,
   * so the first fit was computed against the wrong box and left the furniture
   * lane below the fold. `Fleet auditor` is exactly the node that lane exists
   * to make visible, so a fit that clips it defeats the section.
   *
   * A ResizeObserver refits whenever the box genuinely changes size, which
   * covers the settle-after-mount race, a window resize, and the rails
   * appearing or disappearing at the responsive breakpoints. It is debounced
   * to a frame so a drag-resize does not refit per pixel.
   */
  const fitRef = useRef<{ fitView: (o?: object) => void } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const refit = useCallback(() => {
    fitRef.current?.fitView({ padding: 0.14, maxZoom: 1.35, duration: 0 })
  }, [])
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(refit)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [refit])

  return (
    <div className="sbm-canvas" ref={wrapRef}>
      <ReactFlow
        key={hash}
        onInit={(inst) => {
          fitRef.current = inst as unknown as { fitView: (o?: object) => void }
          refit()
        }}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        /* maxZoom 1 leaves a seven-node fleet occupying about half a 1300px
           canvas, with the rest dead space. 1.35 fills the box without
           blowing the 12.5px card type past the point where it looks like a
           zoomed screenshot. Measured on prod at 1456px. */
        fitViewOptions={{ padding: 0.14, maxZoom: 1.35 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        nodesDraggable={false}
        panOnScroll
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, node) => {
          if (node.type === 'worker') onSelect(node.id === selectedKey ? null : node.id)
        }}
        onEdgeClick={(_e, edge) => onSelectEdge(edge.id === selectedEdgeId ? null : edge.id)}
        onPaneClick={() => onSelect(null)}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} className="sbm-bg" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
