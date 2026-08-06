'use client'

/**
 * FX.9 — the map as a graph experience: a LIGHT canvas (operator
 * direction 2026-08-07, revised from the first dark cut), premium
 * worker cards, animated flow edges, and findings drill-down ON the
 * canvas — expand a worker and its latest findings dock beneath it as
 * chips wired to their source. Click a card body to open the worker's
 * profile; the ⊕ toggle expands findings without leaving the map.
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
export interface CanvasFinding {
  id: string
  kind: string
  entityId: string
  severity: string
}

interface WorkerNodeData {
  name: string
  level: string
  open: number
  degraded: boolean
  isSelftest: boolean
  runInfo: NodeRunInfo | null
  expandable: boolean
  expanded: boolean
  onToggleExpand: () => void
  [key: string]: unknown
}
interface FindingNodeData {
  kind: string
  entity: string
  severity: string
  [key: string]: unknown
}

const agoShort = (iso: string) => {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

function WorkerNode({ data }: NodeProps) {
  const d = data as unknown as WorkerNodeData
  return (
    <div
      className={`acr-fln lv-${d.level.toLowerCase()} ${d.runInfo?.running ? 'is-running' : ''}`}
    >
      <Handle type="target" position={Position.Left} className="acr-fl-h" />
      <div className="acr-fln-top">
        <span className="acr-fln-name">{d.name}</span>
        {d.expandable ? (
          <button
            type="button"
            className="acr-fln-expand nodrag"
            aria-label={d.expanded ? 'Collapse findings' : 'Show findings on the map'}
            title={d.expanded ? 'Collapse findings' : 'Show its findings on the map'}
            onClick={(e) => {
              e.stopPropagation()
              d.onToggleExpand()
            }}
          >
            {d.expanded ? '−' : '+'}
          </button>
        ) : null}
      </div>
      <div className="acr-fln-meta">
        <span className={`acr-fln-level lv-${d.level.toLowerCase()}`}>{d.level}</span>
        {d.open > 0 ? (
          <span className={`acr-fln-open ${d.isSelftest ? 'muted' : ''}`}>
            {d.open} {d.isSelftest ? 'health notes' : 'open'}
          </span>
        ) : null}
        {d.degraded ? <span className="acr-fln-degraded">degraded</span> : null}
      </div>
      <div className="acr-fln-run">
        {d.runInfo?.running ? (
          <span className="acr-fln-working">working now…</span>
        ) : d.runInfo ? (
          <>
            <span className={`acr-fln-dot ${d.runInfo.ok ? 'ok' : 'bad'}`} aria-hidden />
            ran {agoShort(d.runInfo.at)}
            {d.runInfo.findings > 0 ? ` · ${d.runInfo.findings} findings` : ''}
          </>
        ) : (
          <span className="acr-fln-never">never run</span>
        )}
      </div>
      <Handle type="source" position={Position.Right} className="acr-fl-h" />
      <Handle type="source" position={Position.Bottom} id="drill" className="acr-fl-h" />
    </div>
  )
}

function FindingNode({ data }: NodeProps) {
  const d = data as unknown as FindingNodeData
  return (
    <div className={`acr-flf sev-${d.severity}`}>
      <Handle type="target" position={Position.Top} className="acr-fl-h" />
      <span className="acr-flf-kind">{d.kind}</span>
      <span className="acr-flf-entity">{d.entity}</span>
    </div>
  )
}

const nodeTypes = { worker: WorkerNode, finding: FindingNode }

const TIER_ORDER = ['analyst', 'director', 'critic']
const COL_W = 320
const ROW_H = 112
const CHIP_W = 236
const SEV_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 }

export function FleetMapCanvas({
  nodes,
  edges,
  nameByKey,
  openByKey,
  runInfoByKey,
  edgeCounts,
  findingsByKey,
  expanded,
  onToggleExpand,
  onSelect,
}: {
  nodes: FleetMapNodeInput[]
  edges: FleetMapEdgeInput[]
  nameByKey: Map<string, string>
  openByKey: Map<string, number>
  runInfoByKey?: Map<string, NodeRunInfo>
  edgeCounts?: Map<string, number>
  findingsByKey?: Map<string, CanvasFinding[]>
  expanded: string | null
  onToggleExpand: (key: string) => void
  onSelect: (key: string) => void
}) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const byTier = new Map<string, FleetMapNodeInput[]>()
    for (const n of nodes) byTier.set(n.tier, [...(byTier.get(n.tier) ?? []), n])
    const tallest = Math.max(...[...byTier.values()].map((t) => t.length), 1)

    const outNodes: Node[] = []
    const positions = new Map<string, { x: number; y: number }>()
    for (const [tier, members] of byTier) {
      const col = TIER_ORDER.indexOf(tier)
      const x = (col < 0 ? TIER_ORDER.length : col) * COL_W
      const yPad = ((tallest - members.length) * ROW_H) / 2
      members.forEach((n, i) => {
        const pos = { x, y: yPad + i * ROW_H }
        positions.set(n.key, pos)
        const chips = findingsByKey?.get(n.key) ?? []
        outNodes.push({
          id: n.key,
          type: 'worker',
          position: pos,
          data: {
            name: nameByKey.get(n.key) ?? n.key,
            level: n.autonomyLevel,
            open: openByKey.get(n.key) ?? 0,
            degraded: n.degraded ?? false,
            isSelftest: n.key === 'fleet-selftest',
            runInfo: runInfoByKey?.get(n.key) ?? null,
            expandable: chips.length > 0,
            expanded: expanded === n.key,
            onToggleExpand: () => onToggleExpand(n.key),
          } satisfies WorkerNodeData,
          draggable: false,
          connectable: false,
        })
      })
    }

    const outEdges: Edge[] = edges.map((e) => {
      const count = edgeCounts?.get(`${e.from}->${e.to}`)
      const isPlan = e.artifact === 'plan'
      return {
        id: `${e.from}->${e.to}`,
        source: e.from,
        target: e.to,
        animated: true,
        style: { stroke: isPlan ? '#8b5cf6' : '#1f6fde', strokeWidth: 1.5, opacity: 0.75 },
        label:
          count != null && count > 0
            ? `${count} ${e.artifact}${count === 1 ? '' : 's'}`
            : e.artifact,
        labelStyle: { fill: '#5a6675', fontSize: 10, fontWeight: 600 },
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.95 },
        labelBgPadding: [5, 3] as [number, number],
        labelBgBorderRadius: 4,
      }
    })

    // Drill-down: the expanded worker's top findings dock along the bottom.
    if (expanded && findingsByKey?.has(expanded)) {
      const chips = [...(findingsByKey.get(expanded) ?? [])]
        .sort((a, b) => (SEV_RANK[a.severity] ?? 9) - (SEV_RANK[b.severity] ?? 9))
        .slice(0, 5)
      const bottomY = tallest * ROW_H + 56
      chips.forEach((f, i) => {
        const id = `chip-${f.id}`
        outNodes.push({
          id,
          type: 'finding',
          position: { x: i * CHIP_W, y: bottomY },
          data: {
            kind: f.kind.replace(/_/g, ' '),
            entity: f.entityId.includes(':')
              ? f.entityId.split(':').slice(1).join(':')
              : f.entityId,
            severity: f.severity,
          } satisfies FindingNodeData,
          draggable: false,
          connectable: false,
        })
        outEdges.push({
          id: `drill-${f.id}`,
          source: expanded,
          sourceHandle: 'drill',
          target: id,
          animated: true,
          style: { stroke: '#b3bcc9', strokeWidth: 1, opacity: 0.8 },
        })
      })
    }

    return { flowNodes: outNodes, flowEdges: outEdges }
  }, [nodes, edges, nameByKey, openByKey, runInfoByKey, edgeCounts, findingsByKey, expanded, onToggleExpand])

  return (
    <div className="acr-fl-canvas">
      <ReactFlow
        key={expanded ?? 'none'} /* remount on drill-down so fitView reframes */
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1 }}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.35}
        onNodeClick={(_e, node) => {
          if (node.type === 'worker') onSelect(node.id)
        }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#d7dee7" />
      </ReactFlow>
    </div>
  )
}
