'use client'

/**
 * NAF.SB.M.6 — the second mode: not the workers, but the things they reason
 * about, and the relationships the fleet derived between them.
 *
 * THE DEFECT THIS EXISTS TO FIX. The entity graph shipped on the Overview and
 * at fit-view its card labels are unreadable — verified on prod. A graph whose
 * labels you cannot read is a texture, not a picture, and the whole point of
 * this view is which campaign competes with which.
 *
 * The fix is SEMANTIC ZOOM rather than smaller type: three discrete tiers,
 * bound to thresholds, each a coherent design in itself. Scaling label type
 * down with the viewport just renders a smudge — never render text you know
 * the reader cannot read; drop it and show a shape instead. Thresholds carry a
 * hysteresis band so a trackpad wobble does not strobe between tiers.
 *
 * LAYOUT is grid-per-component, not a ring. The existing canvas packs each
 * connected family into a circle, which spends its radius on empty middle and
 * puts labels at angles; a grid of the same cards is denser, reads
 * left-to-right, and keeps every label horizontal. Deterministic and cached on
 * a hash of the data, so a poll repaints and never rearranges.
 *
 * It consumes the EXISTING endpoint and does not touch `entity-graph.service`:
 * that file is owned by no stream and the protocol has no route for editing
 * it, and nothing here needs one — `getEntityGraphOverview` and
 * `getEntityNeighborhood` already return named nodes.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useNodesInitialized,
  useStore,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

export interface EntityNode {
  type: string
  id: string
  label: string
  sublabel: string | null
  degree: number
}
export interface EntityEdge {
  from: string
  to: string
  fromType: string
  toType: string
  relation: string
  weight: number | null
}
export interface EntityGraph {
  nodes: EntityNode[]
  edges: EntityEdge[]
  focus: { type: string; id: string } | null
  truncated: boolean
  relationCounts: Record<string, number>
}

/** The relation vocabulary, in operator words. The colour is a class, never an
 *  inline value — the DS ratchet's zero fallback applies to this tree. */
export const RELATIONS: Record<string, { label: string; meaning: string; className: string }> = {
  COMPETES_WITH: {
    label: 'competes with',
    meaning: 'Both campaigns bid on overlapping searches, so they push each other’s price up.',
    className: 'rel-competes',
  },
  CANNIBALIZES: {
    label: 'takes sales from',
    meaning: 'One campaign is winning sales the other would otherwise have made.',
    className: 'rel-cannibalizes',
  },
  TARGETS: { label: 'targets', meaning: 'The campaign bids on this keyword or product.', className: 'rel-targets' },
  SHARES_INVENTORY: {
    label: 'shares stock with',
    meaning: 'They sell from the same pool of stock, so they compete for units as well as clicks.',
    className: 'rel-shares',
  },
  HARVESTED_FROM: { label: 'harvested from', meaning: 'This keyword was found in that campaign’s search terms.', className: 'rel-harvested' },
  NEGATED_IN: { label: 'blocked in', meaning: 'This term is negated in that campaign.', className: 'rel-negated' },
  VARIANT_OF: { label: 'variant of', meaning: 'Two forms of the same product.', className: 'rel-variant' },
  PROMOTED_BY: { label: 'promoted by', meaning: 'This product is advertised by that campaign.', className: 'rel-promoted' },
  RANKS_FOR: { label: 'ranks for', meaning: 'The product ranks organically for this term.', className: 'rel-ranks' },
  SUPPRESSED_BY: { label: 'suppressed by', meaning: 'Something is holding this listing back.', className: 'rel-suppressed' },
}

export const relationOf = (r: string) =>
  RELATIONS[r] ?? { label: r.toLowerCase().replace(/_/g, ' '), meaning: '', className: 'rel-other' }

const CARD_W = 210
const CARD_H = 62
const GAP_X = 26
const GAP_Y = 20
const GROUP_GAP = 54

const keyOf = (type: string, id: string) => `${type}|${id}`

/* ── the node, with three zoom tiers ───────────────────────────────────── */

interface EntityNodeData {
  label: string
  sublabel: string | null
  type: string
  degree: number
  focused: boolean
  dimmed: boolean
  [key: string]: unknown
}

/** A boolean selector, so the node re-renders only when a threshold is
 *  crossed rather than on every frame of a zoom. */
const detailSelector = (s: { transform: number[] }) => s.transform[2] >= 0.62
const fullSelector = (s: { transform: number[] }) => s.transform[2] >= 1.05

function EntityCard({ data }: NodeProps) {
  const d = data as unknown as EntityNodeData
  const showText = useStore(detailSelector)
  const showAll = useStore(fullSelector)
  return (
    <div
      className={[
        'sbm-ent',
        `t-${d.type}`,
        d.focused ? 'is-focused' : '',
        d.dimmed ? 'is-dimmed' : '',
        showText ? '' : 'is-tiny',
      ]
        .filter(Boolean)
        .join(' ')}
      title={d.label}
    >
      <Handle type="target" position={Position.Left} className="sbm-handle" />
      {showText ? (
        <>
          <span className="sbm-ent-label">{d.label}</span>
          {showAll ? (
            <span className="sbm-ent-sub">
              {d.sublabel ? `${d.sublabel} · ` : ''}
              {d.degree} link{d.degree === 1 ? '' : 's'}
            </span>
          ) : null}
        </>
      ) : (
        <span className="sbm-ent-dot" aria-hidden />
      )}
      <Handle type="source" position={Position.Right} className="sbm-handle" />
    </div>
  )
}

const nodeTypes = { entity: EntityCard }

/**
 * fitView frames the graph from the nodes' measured sizes — and at mount they
 * have none yet, so it fits against xyflow's default 150×40 guess and the real
 * 210×62 cards overflow the viewport. On prod that clipped the right-hand
 * column of every family. `useNodesInitialized` flips true once every node has
 * been measured, which is the only honest moment to frame the picture.
 *
 * A child of <ReactFlow> so it sits inside the store's provider; it renders
 * nothing.
 */
function FitWhenMeasured({ onReady }: { onReady: () => void }) {
  const ready = useNodesInitialized()
  useEffect(() => {
    if (ready) onReady()
  }, [ready, onReady])
  return null
}

/* ── connected components, then a grid per component ───────────────────── */

function layout(graph: EntityGraph) {
  const adjacency = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    if (!adjacency.has(a)) adjacency.set(a, new Set())
    adjacency.get(a)!.add(b)
  }
  for (const n of graph.nodes) adjacency.set(keyOf(n.type, n.id), new Set())
  for (const e of graph.edges) {
    add(keyOf(e.fromType, e.from), keyOf(e.toType, e.to))
    add(keyOf(e.toType, e.to), keyOf(e.fromType, e.from))
  }

  // Stable order in, stable drawing out: a component walk seeded by an
  // unsorted array draws differently every mount.
  const order = [...graph.nodes]
    .map((n) => keyOf(n.type, n.id))
    .sort()
  const seen = new Set<string>()
  const components: string[][] = []
  for (const start of order) {
    if (seen.has(start)) continue
    const stack = [start]
    const comp: string[] = []
    seen.add(start)
    while (stack.length > 0) {
      const k = stack.pop() as string
      comp.push(k)
      for (const nb of [...(adjacency.get(k) ?? [])].sort()) {
        if (seen.has(nb)) continue
        seen.add(nb)
        stack.push(nb)
      }
    }
    components.push(comp.sort())
  }
  // Biggest families first — that is where the interesting overlap is.
  components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))

  const pos = new Map<string, { x: number; y: number }>()
  const groups: Array<{ y: number; size: number }> = []
  let y = 0
  for (const comp of components) {
    const cols = Math.max(1, Math.min(6, Math.ceil(Math.sqrt(comp.length * 1.6))))
    groups.push({ y, size: comp.length })
    comp.forEach((k, i) => {
      pos.set(k, {
        x: (i % cols) * (CARD_W + GAP_X),
        y: y + 22 + Math.floor(i / cols) * (CARD_H + GAP_Y),
      })
    })
    y += 22 + Math.ceil(comp.length / cols) * (CARD_H + GAP_Y) + GROUP_GAP
  }
  return { pos, groups }
}

export function EntityCanvas({
  graph,
  selectedKey,
  onSelect,
  onFocus,
}: {
  graph: EntityGraph
  selectedKey: string | null
  onSelect: (k: string | null) => void
  onFocus: (type: string, id: string) => void
}) {
  const hash = useMemo(
    () =>
      [
        graph.focus ? `${graph.focus.type}|${graph.focus.id}` : 'overview',
        graph.nodes.map((n) => keyOf(n.type, n.id)).sort().join(','),
        graph.edges.length,
      ].join('#'),
    [graph],
  )

  const { pos, groups } = useMemo(() => layout(graph), [hash]) // eslint-disable-line react-hooks/exhaustive-deps

  const flowNodes: Node[] = useMemo(() => {
    const out: Node[] = groups.map((g, i) => ({
      id: `grp-${i}`,
      type: 'group-label',
      position: { x: 0, y: g.y },
      data: {},
      draggable: false,
      selectable: false,
      hidden: true,
    }))
    for (const n of graph.nodes) {
      const p = pos.get(keyOf(n.type, n.id))
      if (!p) continue
      out.push({
        id: keyOf(n.type, n.id),
        type: 'entity',
        position: p,
        data: {
          label: n.label,
          sublabel: n.sublabel,
          type: n.type,
          degree: n.degree,
          focused: selectedKey === keyOf(n.type, n.id),
          dimmed: false,
        } satisfies EntityNodeData,
        draggable: false,
        connectable: false,
      })
    }
    return out
  }, [graph, pos, groups, selectedKey])

  const flowEdges: Edge[] = useMemo(
    () =>
      graph.edges.map((e, i) => ({
        id: `${e.fromType}|${e.from}->${e.toType}|${e.to}->${e.relation}->${i}`,
        source: keyOf(e.fromType, e.from),
        target: keyOf(e.toType, e.to),
        className: `sbm-eedge ${relationOf(e.relation).className}`,
        interactionWidth: 14,
      })),
    [graph],
  )

  const fitRef = useRef<{ fitView: (o?: object) => void } | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const refit = useCallback(() => {
    fitRef.current?.fitView({ padding: 0.1, maxZoom: 1, duration: 0 })
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
        fitViewOptions={{ padding: 0.1, maxZoom: 1 }}
        minZoom={0.15}
        maxZoom={1.8}
        nodesConnectable={false}
        nodesDraggable={false}
        panOnScroll
        zoomOnScroll={false}
        preventScrolling={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_e, node) => onSelect(node.id === selectedKey ? null : node.id)}
        onNodeDoubleClick={(_e, node) => {
          const [type, ...rest] = node.id.split('|')
          onFocus(type, rest.join('|'))
        }}
        onPaneClick={() => onSelect(null)}
      >
        <FitWhenMeasured onReady={refit} />
        <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
