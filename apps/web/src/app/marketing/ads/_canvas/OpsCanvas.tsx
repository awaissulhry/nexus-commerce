'use client'
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './ops-canvas.css'
import { ObjectNode } from './ObjectNode'
import { buildGraph } from './buildGraph'
import { visibleObjects, childParentIds } from './accountGraph'
import type { OpsObject } from './types'

const nodeTypes = { object: ObjectNode }

export function OpsCanvas({
  objects,
  expanded,
  onToggleExpand,
  selectedId,
  onSelect,
}: {
  objects: OpsObject[]
  expanded: Set<string>
  onToggleExpand: (id: string) => void
  selectedId: string | null
  onSelect: (id: string) => void
}) {
  const visible = visibleObjects(objects, expanded)
  const parents = childParentIds(objects)
  const childCount = new Map<string, number>()
  for (const o of objects) {
    if (o.parentId) childCount.set(o.parentId, (childCount.get(o.parentId) ?? 0) + 1)
  }
  const { nodes, edges } = buildGraph(visible)
  const enriched = nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      hasChildren: parents.has(n.id),
      childCount: childCount.get(n.id) ?? 0,
      expanded: expanded.has(n.id),
      selected: selectedId === n.id,
      onToggle: () => onToggleExpand(n.id),
    },
  }))
  return (
    <div className="ops-canvas">
      <ReactFlow
        nodes={enriched as unknown as Node[]}
        edges={edges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
        nodesConnectable={false}
        minZoom={0.2}
        onInit={(inst) => inst.fitView({ padding: 0.2, maxZoom: 1 })}
        onNodeClick={(_, node) => onSelect(node.id)}
      >
        <Background gap={22} color="#dfe4ea" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
