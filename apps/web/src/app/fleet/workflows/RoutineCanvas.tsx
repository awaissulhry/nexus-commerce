'use client'

/**
 * NAF.WF.2 (S2) — one routine's story as a read-only graph. Follows
 * FleetMapCanvas's conventions (hand-computed column layout, custom nodes,
 * draggable:false) but stays page-local: the map shows the whole fleet as it
 * is now; this shows ONE named routine's definition. Worker steps carry the
 * live autonomy tint; code steps are visually neutral because they are math,
 * not judgment; the gate step is where a human sits.
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
import type { RoutineStory } from './routines'

export interface StepLive {
  autonomyLevel: string
  degraded: boolean
  running: boolean
}

interface StepNodeData {
  label: string
  sub: string
  kind: 'worker' | 'code' | 'gate'
  level: string | null
  degraded: boolean
  running: boolean
  [key: string]: unknown
}

function StepNode({ data }: NodeProps) {
  const d = data as unknown as StepNodeData
  return (
    <div className={`wf-node k-${d.kind} ${d.running ? 'is-running' : ''}`}>
      <Handle type="target" position={Position.Left} className="wf-h" />
      <span className="wf-node-top">
        <span className="wf-node-label">{d.label}</span>
        {d.level ? <span className={`acr-pg-lvl ${d.level.toLowerCase()}`}>{d.level}</span> : null}
      </span>
      <span className="wf-node-sub">{d.sub}</span>
      {d.running ? <span className="wf-node-live">working now…</span> : null}
      {d.degraded ? <span className="wf-node-deg">settings unreadable</span> : null}
      <Handle type="source" position={Position.Right} className="wf-h" />
    </div>
  )
}

const nodeTypes = { step: StepNode }

const COL_W = 252
const ROW_H = 104

const EDGE_COLOR: Record<string, string> = {
  findings: '#1f6fde',
  plan: '#8b5cf6',
  survivors: '#8b5cf6',
}

export function RoutineCanvas({
  story,
  liveByCharter,
}: {
  story: RoutineStory
  /** Live worker state keyed by charterKey; absent = render without a tint. */
  liveByCharter: Map<string, StepLive>
}) {
  const { flowNodes, flowEdges } = useMemo(() => {
    const byCol = new Map<number, typeof story.steps>()
    for (const s of story.steps) byCol.set(s.col, [...(byCol.get(s.col) ?? []), s])
    const tallest = Math.max(...[...byCol.values()].map((c) => c.length), 1)

    const outNodes: Node[] = []
    for (const [col, members] of byCol) {
      const yPad = ((tallest - members.length) * ROW_H) / 2
      members.forEach((s, i) => {
        const live = s.charterKey ? liveByCharter.get(s.charterKey) : undefined
        outNodes.push({
          id: s.id,
          type: 'step',
          position: { x: col * COL_W, y: yPad + i * ROW_H },
          data: {
            label: s.label,
            sub: s.sub,
            kind: s.kind,
            level: s.kind === 'worker' && live ? live.autonomyLevel : null,
            degraded: live?.degraded ?? false,
            running: live?.running ?? false,
          } satisfies StepNodeData,
          draggable: false,
          connectable: false,
        })
      })
    }

    const outEdges: Edge[] = story.edges.map((e) => ({
      id: `${e.from}->${e.to}`,
      source: e.from,
      target: e.to,
      animated: true,
      style: {
        stroke: EDGE_COLOR[e.label ?? ''] ?? '#b3bcc9',
        strokeWidth: 1.5,
        opacity: 0.75,
      },
      label: e.label,
      labelStyle: { fill: '#5a6675', fontSize: 10, fontWeight: 600 },
      labelBgStyle: { fill: '#ffffff', fillOpacity: 0.95 },
      labelBgPadding: [5, 3] as [number, number],
      labelBgBorderRadius: 4,
    }))

    return { flowNodes: outNodes, flowEdges: outEdges }
  }, [story, liveByCharter])

  return (
    <div className="wf-canvas">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        nodesConnectable={false}
        nodesDraggable={false}
        zoomOnScroll={false}
        preventScrolling={false}
        minZoom={0.35}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#d7dee7" />
      </ReactFlow>
    </div>
  )
}
