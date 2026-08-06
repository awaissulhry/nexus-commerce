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

export interface NodeRunInfo {
  at: string
  ok: boolean
  findings: number
  running: boolean
}

interface FleetNodeData {
  name: string
  level: string
  open: number
  degraded: boolean
  selected: boolean
  isSelftest: boolean
  runInfo: NodeRunInfo | null
  [key: string]: unknown
}

const agoShort = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function FleetNode({ data }: NodeProps) {
  const d = data as unknown as FleetNodeData
  return (
    <div
      className={`acr-fl-node lv-${d.level.toLowerCase()} ${d.selected ? 'on' : ''} ${d.runInfo?.running ? 'is-running' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="acr-fl-h" />
      <span className="acr-fl-nodename">{d.name}</span>
      <span className="acr-fl-nodemeta">
        {d.level}
        {d.open > 0 ? (
          <em className={d.isSelftest ? 'muted' : ''}>
            {d.open} {d.isSelftest ? 'health notes' : 'open'}
          </em>
        ) : null}
        {d.degraded ? <em className="acr-fl-degraded">degraded</em> : null}
      </span>
      <span className="acr-fl-noderun">
        {d.runInfo?.running ? (
          <em className="running">working now…</em>
        ) : d.runInfo ? (
          <>
            <span className={`acr-fl-runstate ${d.runInfo.ok ? 'ok' : 'bad'}`} aria-hidden />
            ran {agoShort(d.runInfo.at)}
            {d.runInfo.findings > 0 ? ` · ${d.runInfo.findings} findings` : ''}
          </>
        ) : (
          'never run'
        )}
      </span>
      <Handle type="source" position={Position.Right} className="acr-fl-h" />
    </div>
  )
}

const nodeTypes = { fleet: FleetNode }

const TIER_ORDER = ['analyst', 'director', 'critic']
const COL_W = 300
const ROW_H = 96

export function FleetMapCanvas({
  nodes,
  edges,
  nameByKey,
  openByKey,
  runInfoByKey,
  edgeCounts,
  selected,
  onSelect,
}: {
  nodes: FleetMapNodeInput[]
  edges: FleetMapEdgeInput[]
  nameByKey: Map<string, string>
  openByKey: Map<string, number>
  runInfoByKey?: Map<string, NodeRunInfo>
  edgeCounts?: Map<string, number>
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
            isSelftest: n.key === 'fleet-selftest',
            runInfo: runInfoByKey?.get(n.key) ?? null,
          } satisfies FleetNodeData,
          draggable: false,
          connectable: false,
        })
      })
    }
    return out
  }, [nodes, nameByKey, openByKey, selected, runInfoByKey])

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((e) => {
        const count = edgeCounts?.get(`${e.from}->${e.to}`)
        return {
          id: `${e.from}->${e.to}`,
          source: e.from,
          target: e.to,
          label: count != null && count > 0 ? `${count} ${e.artifact}${count === 1 ? '' : 's'}` : e.artifact,
          className: 'acr-fl-edge',
        }
      }),
    [edges, edgeCounts],
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
