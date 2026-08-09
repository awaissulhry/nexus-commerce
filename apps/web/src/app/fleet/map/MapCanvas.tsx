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
  useReactFlow,
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

/**
 * S2R — THE CANVAS FRAMES ITSELF. It does not ask the library to.
 *
 * THE HISTORY, because this is the third attempt and the first two both looked
 * correct in review:
 *
 *   1. `fitView` from `onInit`, plus a ResizeObserver. Measured on prod: the
 *      same URL at the same viewport fitted at `matrix(0.981873,…,78.08,45)` on
 *      one load and landed on the **identity matrix** on three others, sampled
 *      every 100ms for four seconds. Driving the container 1034 → 620 → 1200 →
 *      1034px never moved it.
 *   2. `fitView` gated on `useNodesInitialized`, the documented pattern, which
 *      `EntityCanvas.tsx` has used since M.6. Shipped, deployed, measured — and
 *      the transform was STILL the identity matrix.
 *
 * WHAT THE THIRD MEASUREMENT FOUND, and it is the one that mattered: clicking
 * xyflow's own **Zoom In** control moved the transform to `1.2 @ -103.2,-56.8`,
 * while its own **Fit View** control did nothing at all. So pan/zoom is attached
 * and the container is real — `fitView` *specifically* is the no-op, because it
 * filters to nodes with measured dimensions and this graph never gets any. That
 * also explains attempt 2: `useNodesInitialized` is false for the same reason,
 * so the gate never opened and the fix could not fire.
 *
 * THE FIX IS TO STOP NEEDING THE MEASUREMENT. This canvas already computes every
 * node's position itself — layout is a function of topology alone, which is rule
 * 1 of this file. A canvas that owns its layout can own its frame: we read each
 * node's untransformed box straight from the DOM (`offsetWidth/offsetHeight`,
 * which CSS transforms do not affect), combine it with the positions we
 * computed, and set the viewport arithmetically.
 *
 * That makes the frame deterministic by construction rather than dependent on
 * when a third party decides it has measured something — which is exactly the
 * property rule 1 exists to protect, applied one level up.
 */
function FitToContent({
  hostRef,
  sig,
}: {
  hostRef: React.RefObject<HTMLDivElement | null>
  sig: string
}) {
  const { setViewport } = useReactFlow()

  const fit = useCallback(() => {
    const host = hostRef.current
    if (!host) return
    const { width: cw, height: ch } = host.getBoundingClientRect()
    if (cw < 2 || ch < 2) return

    /* Graph-space bounds, from the positions we set and the boxes the browser
       laid out. `offsetWidth/Height` is the untransformed layout size, so it is
       already in graph coordinates whatever the current zoom is. */
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const els = host.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
    if (els.length === 0) return
    for (const el of els) {
      const m = /translate\(\s*(-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(el.style.transform)
      if (!m) continue
      const x = parseFloat(m[1])
      const y = parseFloat(m[2])
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x + el.offsetWidth)
      maxY = Math.max(maxY, y + el.offsetHeight)
    }
    if (!Number.isFinite(minX) || maxX <= minX || maxY <= minY) return

    const PAD = 22
    const w = maxX - minX
    const h = maxY - minY
    /* 1.35, not 1.6: a seven-node fleet blown up to the container's full height
       stops looking like a diagram and starts looking like a zoomed screenshot.
       The floor matches the canvas's own `minZoom`. */
    const zoom = Math.max(0.3, Math.min(1.35, (cw - PAD * 2) / w, (ch - PAD * 2) / h))
    setViewport(
      { zoom, x: (cw - w * zoom) / 2 - minX * zoom, y: (ch - h * zoom) / 2 - minY * zoom },
      { duration: 0 },
    )
  }, [hostRef, setViewport])

  /* Two frames after the sig changes: one for React to commit the nodes, one
     for the browser to lay them out. Without the second, `offsetWidth` is read
     before the card has a box and the fit is computed against zero. */
  useEffect(() => {
    let a = 0
    let b = 0
    a = requestAnimationFrame(() => {
      b = requestAnimationFrame(fit)
    })
    return () => {
      cancelAnimationFrame(a)
      cancelAnimationFrame(b)
    }
  }, [sig, fit])

  useEffect(() => {
    const el = hostRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    let frame = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(fit)
    })
    ro.observe(el)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
    }
  }, [hostRef, fit])

  return null
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
      position: { x: 0, y: l.y },
      data: { title: l.title, note: l.note } satisfies LaneNodeData,
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

  const wrapRef = useRef<HTMLDivElement | null>(null)

  return (
    <div
      className="sbm-canvas"
      ref={wrapRef}
      onKeyDown={onKeyDown}
      role="application"
      aria-label="Fleet map. Use Tab to move between workers, Left and Right arrows to follow the work, Enter to open one."
    >
      <ReactFlow
        key={hash}
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
        <FitToContent hostRef={wrapRef} sig={hash} />
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} className="sbm-bg" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
