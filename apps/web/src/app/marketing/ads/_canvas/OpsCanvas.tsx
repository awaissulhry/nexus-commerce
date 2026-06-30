'use client'
import { ReactFlow, Background, Controls, MiniMap, type Node, type Edge } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './ops-canvas.css'
import { ObjectNode } from './ObjectNode'
import { buildGraph } from './buildGraph'
import type { OpsObject } from './types'

const nodeTypes = { object: ObjectNode }

export function OpsCanvas({ objects }: { objects: OpsObject[] }) {
  const { nodes, edges } = buildGraph(objects)
  return (
    <div className="ops-canvas">
      <ReactFlow
        nodes={nodes as unknown as Node[]}
        edges={edges as unknown as Edge[]}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        nodesConnectable={false}
        minZoom={0.3}
      >
        <Background gap={22} color="#dfe4ea" />
        <MiniMap pannable zoomable />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
