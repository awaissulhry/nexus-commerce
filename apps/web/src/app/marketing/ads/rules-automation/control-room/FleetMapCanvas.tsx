'use client'

/**
 * NAF.D — the fleet map on xyflow (decision D-D2), following the
 * _canvas/OpsCanvas idiom. Layout is deterministic — tier → column,
 * index → row — because a six-node DAG wants legibility, not physics.
 * Node colour = autonomy dial, badge = open findings, edges labelled by
 * the artifact they carry (finding / plan).
 */

import { useMemo } from 'react'
import {
  Background,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'

export interface FleetMapNodeInput {
  key: string
  tier: string
  autonomyLevel: string
  degraded?: boolean
}
export interface FleetMapEdgeInput {
  from: string
  to: string
  artifact: string
}

interface FleetNodeData {
  name: string
  level: string
  open: number
  degraded: boolean
  selected: boolean
  [key: string]: unknown
}

function FleetNode({ data }: NodeProps) {
  const d = data as unknown as FleetNodeData
  return (
    <div className={`acr-fl-node lv-${d.level.toLowerCase()} ${d.selected ? 'on' : ''}`}>
      <Handle type="target" position={Position.Left} className="acr-fl-h" />
      <span className="acr-fl-nodename">{d.name}</span>
      <span className="acr-fl-nodemeta">
        {d.level}
        {d.open > 0 ? <em>{d.open} open</em> : null}
        {d.degraded ? <em className="acr-fl-degraded">degraded</em> : null}
      </span>
      <Handle type="source" position={Position.Right} className="acr-fl-h" />
    </div>
  )
}

const nodeTypes = { fleet: FleetNode }

const TIER_ORDER = ['analyst', 'director', 'critic']
const COL_W = 300
const ROW_H = 84

export function FleetMapCanvas({
  nodes,
  edges,
  nameByKey,
  openByKey,
  selected,
  onSelect,
}: {
  nodes: FleetMapNodeInput[]
  edges: FleetMapEdgeInput[]
  nameByKey: Map<string, string>
  openByKey: Map<string, number>
  selected: string | null
  onSelect: (key: string) => void
}) {
  const flowNodes = useMemo<Node[]>(() => {
    const byTier = new Map<string, FleetMapNodeInput[]>()
    for (const n of nodes) byTier.set(n.tier, [...(byTier.get(n.tier) ?? []), n])
    const tallest = Math.max(...[...byTier.values()].map((t) => t.length), 1)
    const out: Node[] = []
    for (const [tier, members] of byTier) {
      const col = TIER_ORDER.indexOf(tier)
      const yPad = ((tallest - members.length) * ROW_H) / 2
      members.forEach((n, i) => {
        out.push({
          id: n.key,
          type: 'fleet',
          position: { x: (col < 0 ? TIER_ORDER.length : col) * COL_W, y: yPad + i * ROW_H },
          data: {
            name: nameByKey.get(n.key) ?? n.key,
            level: n.autonomyLevel,
            open: openByKey.get(n.key) ?? 0,
            degraded: n.degraded ?? false,
            selected: selected === n.key,
          } satisfies FleetNodeData,
          draggable: false,
          connectable: false,
        })
      })
    }
    return out
  }, [nodes, nameByKey, openByKey, selected])

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => ({
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        label: e.artifact,
        className: 'acr-fl-edge',
      })),
    [edges],
  )

  return (
    <div className="acr-fl-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.4}
        onNodeClick={(_e, node) => onSelect(node.id)}
      >
        <Background gap={22} color="#dfe4ea" />
      </ReactFlow>
    </div>
  )
}
