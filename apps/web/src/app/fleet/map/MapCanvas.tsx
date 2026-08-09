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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { statusOf, usd, type MapEdge, type MapNode } from './lib'
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
  /** The topology, in a sentence, for a reader who cannot see the arrows. */
  wiring: string
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
      {/*
        S2R — the SAME THREE SLOTS on every card, always, in the same order.

        Before, the row was conditional: a card showed one, two or three facts
        depending on its data, so the third item on one card was the second item
        on the next and a column of cards could not be read down. Grafana's node
        model is a fixed main-stat / secondary-stat set for exactly this reason.

        A slot with nothing in it prints an en dash rather than collapsing —
        "this worker has no findings" and "this card is showing you something
        else here" are different facts.

        Money is 2dp, matching the census band one row above. It was `toFixed(4)`
        here and `$0.00 of $2.00` there — two precisions for money on one page,
        which is the defect Section 1 had just finished removing.
      */}
      <div className="sbm-node-facts">
        <span className={`sbm-fact ${d.neverRun ? 'is-empty' : ''}`}>
          <b>{d.neverRun ? '—' : d.runsLifetime}</b> {d.neverRun ? 'not yet run' : 'runs'}
        </span>
        <span className={`sbm-fact ${d.open === 0 ? 'is-empty' : ''}`}>
          <b>{d.open === 0 ? '—' : d.open}</b> open
          {d.openExpired > 0 ? <i> · {d.openExpired} stale</i> : null}
        </span>
        {/* A worker that never ran gets a dash, NOT `$0.00`. "Ran and cost
            nothing" and "was never measured" are different facts, and printing
            the cheaper-looking one is the exact error the parent study names
            for the cost overlay. */}
        <span className={`sbm-fact ${d.neverRun ? 'is-empty' : ''}`}>
          <b>{d.neverRun ? '—' : usd(d.costWindow)}</b> spent
        </span>
      </div>
      {/*
        The wiring, for a screen reader. An edge is information a sighted
        reader gets for free from an arrow and a screen-reader user loses
        entirely, so it has to be in the DOM.

        It lives here, inside the card, rather than on the node's `ariaLabel`:
        that field exists on the Node type and tsc accepts it, but xyflow
        12.11.1 does not render it — measured on prod, the wrapper carries
        class/data-id/tabindex/role/aria-roledescription/aria-describedby and
        no aria-label at all. A visually-hidden span is honoured by every
        screen reader and depends on nothing the library chooses to do.
      */}
      <span className="sr-only">{d.wiring}</span>
      <Handle type="source" position={Position.Right} className="sbm-handle" />
    </div>
  )
}

interface LaneNodeData {
  title: string
  note: string
  w: number
  h: number
  [key: string]: unknown
}
/**
 * S2R — a CONTAINER, not a caption.
 *
 * It was a 640px dashed top-border with two lines of text sitting 46px above a
 * row of cards it had no visual relationship to, which reads as debris rather
 * than as a label for anything. Airflow's TaskGroup is the model: a bounded
 * region with a header, drawn behind its members so the grouping is a fact
 * about the picture instead of a note near it.
 *
 * It is sized from the same layout maths that places the cards, so the box can
 * never drift from what it contains.
 */
function LaneNode({ data }: NodeProps) {
  const d = data as unknown as LaneNodeData
  return (
    <div className="sbm-lane" style={{ width: d.w, height: d.h }}>
      <span className="sbm-lane-title">{d.title}</span>
      <span className="sbm-lane-note">{d.note}</span>
    </div>
  )
}

const nodeTypes = { worker: WorkerNode, lane: LaneNode }


/** The card and lane boxes, in graph coordinates. These are CSS constants
 *  (`.sbm-node { width: 252px }`, `.sbm-lane { width: 640px }`) and are verified
 *  against the DOM on prod: `offsetWidth/offsetHeight` report 252×82 and 640×41.
 *  They live here because the frame has to be computable BEFORE first paint. */
const NODE_W = 252
const NODE_H = 82
const FIT_PAD = 22

/**
 * The viewport, computed rather than requested.
 *
 * `zoom` is capped at 1.35 deliberately: a seven-node fleet blown up to fill the
 * container stops looking like a diagram and starts looking like a zoomed
 * screenshot. The floor matches the canvas's own `minZoom`.
 */
function frameFor(
  pos: Map<string, { x: number; y: number }>,
  lanes: Array<{ x: number; y: number; w: number; h: number }>,
  box: { w: number; h: number },
): { x: number; y: number; zoom: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pos.values()) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x + NODE_W)
    maxY = Math.max(maxY, p.y + NODE_H)
  }
  for (const l of lanes) {
    minX = Math.min(minX, l.x)
    minY = Math.min(minY, l.y)
    maxX = Math.max(maxX, l.x + l.w)
    maxY = Math.max(maxY, l.y + l.h)
  }
  if (!Number.isFinite(minX) || box.w < 2 || box.h < 2) return { x: 0, y: 0, zoom: 1 }
  const w = Math.max(1, maxX - minX)
  const h = Math.max(1, maxY - minY)
  const zoom = Math.max(0.3, Math.min(1.35, (box.w - FIT_PAD * 2) / w, (box.h - FIT_PAD * 2) / h))
  return {
    zoom,
    x: (box.w - w * zoom) / 2 - minX * zoom,
    y: (box.h - h * zoom) / 2 - minY * zoom,
  }
}

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
    const lanes: Array<{
      id: string
      title: string
      note: string
      x: number
      y: number
      w: number
      h: number
    }> = []

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
      const rows = Math.ceil(members.length / 4)
      const across = Math.min(members.length, 4)
      lanes.push({
        id: `lane-${lane}`,
        title,
        note,
        /* The box wraps its members with a 14px gutter, and is never narrower
           than the sentence it has to carry — a container cut to its cards
           would wrap that note to four lines. */
        x: -14,
        y,
        w: Math.max(460, (across - 1) * COL_W + NODE_W + 28),
        h: 46 + (rows - 1) * ROW_H + NODE_H + 14,
      })
      members.forEach((n, i) => pos.set(n.key, { x: i * COL_W, y: y + 46 }))
      y += 46 + Math.ceil(members.length / 4) * ROW_H + LANE_GAP
    }
    return { pos, lanes }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hash])

  /**
   * KEYBOARD TRAVERSAL. React Flow binds the arrow keys to *moving* a node,
   * which is right for an editor and wrong here — it would let a keyboard user
   * silently wreck a layout they cannot see, and it wastes the one spatial
   * idiom the graph has. On a read-only map the arrows should mean what the
   * arrows on screen mean: Right goes to the worker this one hands its work
   * to, Left goes back to the one that feeds it, Up and Down move between
   * workers standing in the same column.
   *
   * Implemented on the wrapper rather than inside the node, so it does not
   * fight React Flow's own focus handling or add a second tab stop per card.
   */
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const focused = (document.activeElement as HTMLElement | null)?.closest(
        '.react-flow__node',
      ) as HTMLElement | null
      const id = focused?.getAttribute('data-id')
      if (!id) return

      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        onSelect(id === selectedKey ? null : id)
        return
      }

      let next: string | undefined
      if (e.key === 'ArrowRight') next = edges.find((x) => x.from === id)?.to
      else if (e.key === 'ArrowLeft') next = edges.find((x) => x.to === id)?.from
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        const me = nodes.find((n) => n.key === id)
        if (!me) return
        const column = nodes
          .filter((n) => n.lane === me.lane && n.rank === me.rank)
          .sort((a, b) => a.key.localeCompare(b.key))
        const i = column.findIndex((n) => n.key === id)
        const step = e.key === 'ArrowDown' ? 1 : -1
        next = column[(i + step + column.length) % column.length]?.key
      } else return

      if (!next || next === id) return
      e.preventDefault()
      const target = document.querySelector(
        `.react-flow__node[data-id="${CSS.escape(next)}"]`,
      ) as HTMLElement | null
      target?.focus()
    },
    [edges, nodes, onSelect, selectedKey],
  )

  const flowNodes: Node[] = useMemo(() => {
    const out: Node[] = positions.lanes.map((l) => ({
      id: l.id,
      type: 'lane',
      position: { x: l.x, y: l.y },
      /*
       * ⚠ NO EXPLICIT `zIndex` HERE, and that is the fix for a live defect.
       *
       * S2.e set `zIndex: 0` on the lane so it would sit behind its members.
       * On prod that removed EVERY EDGE from the graph — `.react-flow__edges`
       * came back an empty div — and it survived two reverts aimed at the edge
       * label, because both of them were aimed at the wrong change. xyflow
       * groups edges into z-index layers derived from their endpoint nodes, and
       * giving SOME nodes an explicit zIndex while others have none puts the
       * edges in a layer that never renders.
       *
       * Painting order alone is enough: lanes are pushed into the node array
       * first, so they are already behind the workers.
       */
      data: { title: l.title, note: l.note, w: l.w, h: l.h } satisfies LaneNodeData,
      draggable: false,
      selectable: false,
      connectable: false,
      /* A lane header is a caption, not a thing you can act on. Left
         focusable it becomes a tab stop that announces nothing useful and
         sits between the reader and the workers they are trying to reach —
         confirmed on prod, where `lane-standalone` carried tabindex=0. */
      focusable: false,
    }))
    /* Tab order follows the pipeline, not the render order React Flow would
       otherwise inherit from an arbitrary array. A keyboard user should walk
       the graph left to right the way a sighted reader does. */
    const ordered = [...nodes].sort(
      (a, b) =>
        (a.rank ?? 99) - (b.rank ?? 99) ||
        a.lane.localeCompare(b.lane) ||
        a.key.localeCompare(b.key),
    )
    for (const n of ordered) {
      const p = positions.pos.get(n.key)
      if (!p) continue
      const s = statusOf(n)
      const feeds = edges.filter((e) => e.from === n.key).map((e) => e.to)
      const fedBy = edges.filter((e) => e.to === n.key).map((e) => e.from)
      const nameOf = (k: string) => nodes.find((x) => x.key === k)?.name ?? k
      out.push({
        id: n.key,
        type: 'worker',
        position: p,
        data: {
          wiring: [
          `${n.name}.`,
          `${n.tier}.`,
          `${s.label}.`,
          n.runs.lifetime === 0 ? 'Never run.' : `${n.runs.lifetime} runs.`,
          n.findings.open > 0 ? `${n.findings.open} open findings.` : '',
          fedBy.length > 0 ? `Fed by ${fedBy.map(nameOf).join(', ')}.` : 'Starts the chain.',
          feeds.length > 0 ? `Feeds ${feeds.map(nameOf).join(', ')}.` : 'Ends the chain.',
          ]
            .filter(Boolean)
            .join(' '),
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
  }, [nodes, edges, positions, dimmedKeys, selectedKey, overlay])

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

  /*
   * THE FRAME, and this is the fourth attempt — the first three all shipped
   * looking correct and all left the viewport at the identity matrix.
   *
   *   1. `fitView` from `onInit` + a ResizeObserver.
   *   2. `fitView` gated on `useNodesInitialized`, the documented pattern.
   *   3. `setViewport` with arithmetic of our own, retried until the node DOM
   *      existed.
   *
   * What the measurements finally established, on prod: xyflow's own **Zoom In**
   * control moves the transform, its own **Fit View** control does not, and
   * neither `fitView` NOR `setViewport` called from a child of `<ReactFlow>` has
   * any effect. Every node carries `visibility: hidden` inline — permanently,
   * not transiently as this file previously assumed — which is xyflow's
   * not-yet-measured state, so `node.measured` is never populated and every API
   * that filters on it is a no-op.
   *
   * So the viewport is not requested at all. It is COMPUTED BEFORE RENDER and
   * handed over as `defaultViewport`, which is a plain prop and cannot be
   * defeated by store timing. This canvas already computes every node position
   * itself — rule 1 — so it can compute its own frame from the same numbers;
   * the card and lane sizes are CSS constants, checked against the DOM.
   *
   * The container size is quantised into 40px buckets before it reaches the
   * remount key, so a drag-resize costs a handful of reframes rather than one
   * per pixel, and a poll — which changes neither the topology nor the box —
   * costs none at all.
   */
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const read = () => {
      const r = el.getBoundingClientRect()
      const w = Math.round(r.width / 40) * 40
      const h = Math.round(r.height / 40) * 40
      setBox((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const view = useMemo(
    () => frameFor(positions.pos, positions.lanes, box),
    [positions, box],
  )

  return (
    <div
      className="sbm-canvas"
      ref={wrapRef}
      onKeyDown={onKeyDown}
      role="application"
      aria-label="Fleet map. Use Tab to move between workers, Left and Right arrows to follow the work, Enter to open one."
    >
      <ReactFlow
        /* The box is in the key so a genuine resize reframes; `hash` is in it so
           a topology change does. A poll changes neither. */
        key={`${hash}@${box.w}x${box.h}`}
        defaultViewport={view}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        /* No `fitView` prop. Measured on prod: xyflow's own Fit View control is
           a no-op on this graph — it filters to nodes it has measured and it
           never measures ours — while its Zoom In control works, which is how
           the cause was isolated. `FitToContent` frames the graph
           arithmetically instead; see the note on that component. */
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
