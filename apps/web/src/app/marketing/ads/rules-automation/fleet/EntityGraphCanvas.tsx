'use client'

/**
 * FX.10 — the entity graph on the canvas: your campaigns, products and
 * the relationships the fleet derived between them (Phase H). Two views,
 * both deterministic — no physics, no layout library:
 *
 *  - overview: every campaign that competes with or cannibalizes another,
 *    split into connected FAMILIES and drawn as separate constellations
 *    (one ring for all of them was a hairball).
 *  - focused: the chosen entity on the left, its direct relationships in
 *    LANES by relation — a campaign can advertise a hundred products, and
 *    a ring of a hundred cards is a smear. Each lane says how many exist
 *    and admits how many it is showing.
 *
 * Light skin, same family as the fleet map.
 */

import { useMemo } from 'react'
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
  properties: unknown
}
export interface EntityGraphData {
  nodes: EntityNode[]
  edges: EntityEdge[]
  focus: { type: string; id: string } | null
  truncated: boolean
  relationCounts: Record<string, number>
}

/** One vocabulary for the relations — colour, label, and what it means. */
export const RELATION_META: Record<
  string,
  { color: string; label: string; meaning: string }
> = {
  COMPETES_WITH: {
    color: '#1f6fde',
    label: 'competes with',
    meaning: 'Both campaigns bid on the same search terms in the same market.',
  },
  CANNIBALIZES: {
    color: '#d4453f',
    label: 'cannibalizes',
    meaning:
      'The first campaign is losing the same searches to the second — it spends without winning them.',
  },
  SHARES_INVENTORY: {
    color: '#8b5cf6',
    label: 'shares stock',
    meaning:
      'Two campaigns in different markets advertise the same product, so their spend draws on one pool of stock.',
  },
  TARGETS: {
    color: '#94a3b8',
    label: 'advertises',
    meaning: 'The campaign advertises this product.',
  },
  VARIANT_OF: {
    color: '#c3ccd8',
    label: 'variant of',
    meaning: 'This variation belongs to that parent product.',
  },
}

interface EntityNodeData {
  label: string
  sublabel: string | null
  kind: string
  degree: number
  isFocus: boolean
  compact: boolean
  /** carried so a click resolves the entity regardless of the node id */
  entityType?: string
  entityId?: string
  [key: string]: unknown
}

function EntityNodeCard({ data }: NodeProps) {
  const d = data as unknown as EntityNodeData
  return (
    <div
      className={`acr-eg-node k-${d.kind} ${d.isFocus ? 'focus' : ''} ${d.compact ? 'compact' : ''}`}
    >
      <Handle type="target" position={Position.Top} className="acr-fl-h" />
      {d.compact ? null : <span className="acr-eg-kind">{d.kind}</span>}
      <span className="acr-eg-label" title={d.label}>
        {d.label}
      </span>
      {d.sublabel ? (
        <span className="acr-eg-sub" title={d.sublabel}>
          {d.sublabel}
        </span>
      ) : null}
      <Handle type="source" position={Position.Bottom} className="acr-fl-h" />
    </div>
  )
}

function LaneHeader({ data }: NodeProps) {
  const d = data as unknown as { title: string; count: number; color: string }
  return (
    <div className="acr-eg-lane">
      <span className="acr-eg-laneswatch" style={{ background: d.color }} aria-hidden />
      {d.title} · {d.count}
    </div>
  )
}
function MoreCard({ data }: NodeProps) {
  const d = data as unknown as { count: number }
  return <div className="acr-eg-more">+{d.count} more not shown</div>
}

const nodeTypes = { entity: EntityNodeCard, lane: LaneHeader, more: MoreCard }

const key = (type: string, id: string) => `${type}|${id}`

/** Overview cards are compact so the whole picture stays READABLE when
 *  fitView scales it; the focused view uses the roomier card. */
const NODE_W = 146
const NODE_H = 56
const CLUSTER_GAP = 74
const ROW_MAX_W = 1450

/**
 * Overview layout: the graph splits into connected components — families
 * of campaigns fighting over the same searches — and each is drawn as its
 * own small constellation, packed left to right. One big ring put every
 * edge through the middle and read as a hairball; clusters make the
 * families legible, which IS the insight.
 */
function layoutClusters(
  nodes: EntityNode[],
  edges: EntityEdge[],
): Map<string, { x: number; y: number }> {
  const adj = new Map<string, Set<string>>()
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set())
    adj.get(a)!.add(b)
  }
  for (const e of edges) {
    const a = key(e.fromType, e.from)
    const b = key(e.toType, e.to)
    add(a, b)
    add(b, a)
  }

  const seen = new Set<string>()
  const components: EntityNode[][] = []
  const byKey = new Map(nodes.map((n) => [key(n.type, n.id), n]))
  for (const n of nodes) {
    const k = key(n.type, n.id)
    if (seen.has(k)) continue
    const stack = [k]
    const group: EntityNode[] = []
    seen.add(k)
    while (stack.length) {
      const cur = stack.pop()!
      const node = byKey.get(cur)
      if (node) group.push(node)
      for (const nb of adj.get(cur) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb)
          stack.push(nb)
        }
      }
    }
    components.push(group.sort((a, b) => b.degree - a.degree))
  }
  // biggest, busiest families first
  components.sort((a, b) => b.length - a.length)

  const positions = new Map<string, { x: number; y: number }>()
  let cursorX = 0
  let rowY = 0
  let rowH = 0
  for (const group of components) {
    const n = group.length
    // a pair sits side by side; anything bigger takes a ring whose radius
    // grows with the crowd so cards never collide
    const radius = n <= 2 ? 0 : Math.max(120, (n * (NODE_W + 26)) / (2 * Math.PI))
    const boxW = n <= 2 ? NODE_W * n + (n - 1) * 48 : radius * 2 + NODE_W
    const boxH = n <= 2 ? NODE_H : radius * 1.45 + NODE_H

    if (cursorX > 0 && cursorX + boxW > ROW_MAX_W) {
      cursorX = 0
      rowY += rowH + CLUSTER_GAP
      rowH = 0
    }

    if (n === 1) {
      positions.set(key(group[0]!.type, group[0]!.id), { x: cursorX, y: rowY })
    } else if (n === 2) {
      positions.set(key(group[0]!.type, group[0]!.id), { x: cursorX, y: rowY })
      positions.set(key(group[1]!.type, group[1]!.id), {
        x: cursorX + NODE_W + 60,
        y: rowY,
      })
    } else {
      const cx = cursorX + boxW / 2
      const cy = rowY + boxH / 2
      group.forEach((node, i) => {
        const angle = (i / n) * Math.PI * 2 - Math.PI / 2
        positions.set(key(node.type, node.id), {
          x: Math.round(cx + Math.cos(angle) * radius - NODE_W / 2),
          y: Math.round(cy + Math.sin(angle) * radius * 0.66),
        })
      })
    }

    cursorX += boxW + CLUSTER_GAP
    rowH = Math.max(rowH, boxH)
  }
  return positions
}

export function EntityGraphCanvas({
  data,
  onFocus,
}: {
  data: EntityGraphData
  onFocus: (type: string, id: string) => void
}) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const focusKey = data.focus ? key(data.focus.type, data.focus.id) : null
    const byKey = new Map(data.nodes.map((n) => [key(n.type, n.id), n]))

    /* ── OVERVIEW: clustered families ───────────────────────────────── */
    if (!focusKey) {
      const positions = layoutClusters(data.nodes, data.edges)
      const outNodes: Node[] = data.nodes.map((n) => {
        const k = key(n.type, n.id)
        return {
          id: k,
          type: 'entity',
          position: positions.get(k) ?? { x: 0, y: 0 },
          data: {
            label: n.label,
            sublabel: n.sublabel,
            kind: n.type,
            degree: n.degree,
            isFocus: false,
            compact: true,
          } satisfies EntityNodeData,
          draggable: false,
          connectable: false,
        }
      })
      const outEdges: Edge[] = data.edges.map((e, i) => ({
        id: `${e.relation}-${e.from}-${e.to}-${i}`,
        source: key(e.fromType, e.from),
        target: key(e.toType, e.to),
        animated: e.relation === 'CANNIBALIZES',
        style: {
          stroke: RELATION_META[e.relation]?.color ?? '#c3ccd8',
          strokeWidth: 1.6,
          opacity: 0.8,
        },
      }))
      return { flowNodes: outNodes, flowEdges: outEdges }
    }

    /* ── FOCUSED: one hop, grouped into lanes by relationship ────────
       A campaign can advertise a hundred products; a ring of a hundred
       cards is a smear. Lanes keep it readable and honest — each lane
       says how many there are and how many are shown. */
    const lanes = new Map<string, { node: EntityNode; direction: 'out' | 'in' }[]>()
    for (const e of data.edges) {
      const a = key(e.fromType, e.from)
      const b = key(e.toType, e.to)
      if (a !== focusKey && b !== focusKey) continue // depth-2 edges: not drawn here
      const otherKey = a === focusKey ? b : a
      const other = byKey.get(otherKey)
      if (!other) continue
      const list = lanes.get(e.relation) ?? []
      if (!list.some((x) => key(x.node.type, x.node.id) === otherKey)) {
        list.push({ node: other, direction: a === focusKey ? 'out' : 'in' })
      }
      lanes.set(e.relation, list)
    }

    const LANE_ORDER = ['CANNIBALIZES', 'COMPETES_WITH', 'SHARES_INVENTORY', 'TARGETS', 'VARIANT_OF']
    const ordered = [...lanes.entries()].sort(
      (a, b) => LANE_ORDER.indexOf(a[0]) - LANE_ORDER.indexOf(b[0]),
    )
    const PER_LANE = 8
    const LANE_X = 330
    const CARD_Y = 92

    const outNodes: Node[] = []
    const outEdges: Edge[] = []

    const focusNode = byKey.get(focusKey)
    if (focusNode) {
      const tallest = Math.max(
        ...ordered.map(([, list]) => Math.min(list.length, PER_LANE)),
        1,
      )
      outNodes.push({
        id: focusKey,
        type: 'entity',
        position: { x: 0, y: (tallest * CARD_Y) / 2 },
        data: {
          label: focusNode.label,
          sublabel: focusNode.sublabel,
          kind: focusNode.type,
          degree: focusNode.degree,
          isFocus: true,
          compact: false,
        } satisfies EntityNodeData,
        draggable: false,
        connectable: false,
      })

      ordered.forEach(([relation, list], laneIdx) => {
        const meta = RELATION_META[relation]
        const x = LANE_X * (laneIdx + 1)
        outNodes.push({
          id: `lane|${relation}`,
          type: 'lane',
          position: { x, y: -60 },
          data: { title: meta?.label ?? relation, count: list.length, color: meta?.color ?? '#c3ccd8' },
          draggable: false,
          connectable: false,
          selectable: false,
        })
        list.slice(0, PER_LANE).forEach((item, i) => {
          // Lane-scoped id: the same campaign can legitimately appear in
          // two lanes (it both cannibalizes and competes), and duplicate
          // node ids silently drop one of them.
          const nodeId = `${relation}::${key(item.node.type, item.node.id)}`
          outNodes.push({
            id: nodeId,
            type: 'entity',
            position: { x, y: i * CARD_Y },
            data: {
              label: item.node.label,
              sublabel: item.node.sublabel,
              kind: item.node.type,
              degree: item.node.degree,
              isFocus: false,
              compact: false,
              entityType: item.node.type,
              entityId: item.node.id,
            } satisfies EntityNodeData,
            draggable: false,
            connectable: false,
          })
          outEdges.push({
            id: `${relation}-${nodeId}-${i}`,
            source: item.direction === 'out' ? focusKey : nodeId,
            target: item.direction === 'out' ? nodeId : focusKey,
            animated: relation === 'CANNIBALIZES',
            style: { stroke: meta?.color ?? '#c3ccd8', strokeWidth: 1.4, opacity: 0.75 },
          })
        })
        if (list.length > PER_LANE) {
          outNodes.push({
            id: `more|${relation}`,
            type: 'more',
            position: { x, y: PER_LANE * CARD_Y },
            data: { count: list.length - PER_LANE },
            draggable: false,
            connectable: false,
            selectable: false,
          })
        }
      })
    }

    return { flowNodes: outNodes, flowEdges: outEdges }
  }, [data])

  return (
    <div className="acr-fl-canvas acr-eg-canvas">
      <ReactFlow
        key={data.focus ? key(data.focus.type, data.focus.id) : 'overview'}
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.14, maxZoom: 1 }}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.2}
        onNodeClick={(_e, node) => {
          if (node.type !== 'entity') return // lane headers and "+N more" are chrome
          const d = node.data as unknown as EntityNodeData
          if (d.entityType && d.entityId) {
            onFocus(d.entityType, d.entityId)
            return
          }
          const [type, ...rest] = node.id.split('|')
          onFocus(type!, rest.join('|'))
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#d7dee7" />
        {/* the whole picture never fits at full size — let the operator zoom */}
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
