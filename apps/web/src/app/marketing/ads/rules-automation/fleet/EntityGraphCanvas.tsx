'use client'

/**
 * FX.10 — the entity graph on the canvas: your campaigns, products and
 * the relationships the fleet derived between them (Phase H). Two views,
 * both deterministic — no physics, no layout library:
 *
 *  - overview: every campaign that competes with or cannibalizes another,
 *    laid out on a ring, sized by how entangled it is.
 *  - focused: the chosen entity at the centre, its neighbours on rings by
 *    hop distance (BFS from the focus over the returned edges).
 *
 * Light skin, same family as the fleet map.
 */

import { useMemo } from 'react'
import {
  Background,
  BackgroundVariant,
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
  [key: string]: unknown
}

function EntityNodeCard({ data }: NodeProps) {
  const d = data as unknown as EntityNodeData
  return (
    <div className={`acr-eg-node k-${d.kind} ${d.isFocus ? 'focus' : ''}`}>
      <Handle type="target" position={Position.Top} className="acr-fl-h" />
      <span className="acr-eg-kind">{d.kind}</span>
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

const nodeTypes = { entity: EntityNodeCard }

const RING = [0, 300, 560]
const key = (type: string, id: string) => `${type}|${id}`

const NODE_W = 176
const NODE_H = 74
const CLUSTER_GAP = 96
const ROW_MAX_W = 1900

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
    const radius = n <= 2 ? 0 : Math.max(150, (n * (NODE_W + 34)) / (2 * Math.PI))
    const boxW = n <= 2 ? NODE_W * n + (n - 1) * 60 : radius * 2 + NODE_W
    const boxH = n <= 2 ? NODE_H : radius * 1.5 + NODE_H

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

    // hop distance from the focus, over the edges we were given
    const depth = new Map<string, number>()
    if (focusKey) {
      const adj = new Map<string, string[]>()
      for (const e of data.edges) {
        const a = key(e.fromType, e.from)
        const b = key(e.toType, e.to)
        adj.set(a, [...(adj.get(a) ?? []), b])
        adj.set(b, [...(adj.get(b) ?? []), a])
      }
      depth.set(focusKey, 0)
      let frontier = [focusKey]
      for (let d = 1; d < RING.length && frontier.length; d++) {
        const next: string[] = []
        for (const n of frontier) {
          for (const m of adj.get(n) ?? []) {
            if (!depth.has(m)) {
              depth.set(m, d)
              next.push(m)
            }
          }
        }
        frontier = next
      }
    }

    let positions: Map<string, { x: number; y: number }>
    if (!focusKey) {
      // no focus: cluster the families
      positions = layoutClusters(data.nodes, data.edges)
    } else {
      // focused: the entity at the centre, neighbours on rings by hop
      positions = new Map()
      const byRing = new Map<number, EntityNode[]>()
      for (const n of data.nodes) {
        const d = depth.get(key(n.type, n.id)) ?? RING.length - 1
        byRing.set(d, [...(byRing.get(d) ?? []), n])
      }
      for (const [ring, members] of byRing) {
        const radius = RING[Math.min(ring, RING.length - 1)] ?? RING[RING.length - 1]!
        if (radius === 0) {
          positions.set(key(members[0]!.type, members[0]!.id), { x: 0, y: 0 })
          continue
        }
        // widen the ring when it is crowded so cards never overlap
        const r = Math.max(radius, (members.length * (NODE_W + 26)) / (2 * Math.PI))
        members.forEach((n, i) => {
          const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2
          positions.set(key(n.type, n.id), {
            x: Math.round(Math.cos(angle) * r),
            y: Math.round(Math.sin(angle) * r * 0.78),
          })
        })
      }
    }

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
          isFocus: k === focusKey,
        } satisfies EntityNodeData,
        draggable: false,
        connectable: false,
      }
    })

    const outEdges: Edge[] = data.edges.map((e, i) => {
      const meta = RELATION_META[e.relation]
      return {
        id: `${e.relation}-${e.from}-${e.to}-${i}`,
        source: key(e.fromType, e.from),
        target: key(e.toType, e.to),
        animated: e.relation === 'CANNIBALIZES',
        style: {
          stroke: meta?.color ?? '#c3ccd8',
          strokeWidth: e.relation === 'TARGETS' ? 1 : 1.6,
          opacity: e.relation === 'TARGETS' ? 0.45 : 0.8,
        },
      }
    })

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
          const [type, ...rest] = node.id.split('|')
          onFocus(type!, rest.join('|'))
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#d7dee7" />
      </ReactFlow>
    </div>
  )
}
