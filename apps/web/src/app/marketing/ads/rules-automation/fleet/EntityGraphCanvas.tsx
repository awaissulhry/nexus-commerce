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

    const byRing = new Map<number, EntityNode[]>()
    for (const n of data.nodes) {
      const d = focusKey ? (depth.get(key(n.type, n.id)) ?? RING.length - 1) : 1
      byRing.set(d, [...(byRing.get(d) ?? []), n])
    }

    const positions = new Map<string, { x: number; y: number }>()
    for (const [ring, members] of byRing) {
      const radius =
        RING[Math.min(ring, RING.length - 1)] ??
        RING[RING.length - 1]!
      if (radius === 0) {
        positions.set(key(members[0]!.type, members[0]!.id), { x: 0, y: 0 })
        continue
      }
      // widen the ring when it is crowded so cards never overlap
      const r = Math.max(radius, members.length * 34)
      members.forEach((n, i) => {
        const angle = (i / members.length) * Math.PI * 2 - Math.PI / 2
        positions.set(key(n.type, n.id), {
          x: Math.round(Math.cos(angle) * r),
          y: Math.round(Math.sin(angle) * r * 0.72),
        })
      })
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
    <div className="acr-fl-canvas">
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
