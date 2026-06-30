export type ObjectKind = 'market' | 'portfolio' | 'campaign' | 'adgroup' | 'target'
export type Health = 'ok' | 'warn' | 'bad'

export interface OpsObject {
  id: string
  kind: ObjectKind
  name: string
  parentId?: string
  spend?: number // EUR
  acos?: number // fraction, e.g. 0.24 = 24%
  health?: Health
}

export interface OpsNodeData {
  kind: ObjectKind
  name: string
  spend?: number
  acos?: number
  health?: Health
  hasChildren?: boolean
  expanded?: boolean
  selected?: boolean
  onToggle?: () => void
}

export interface OpsNode {
  id: string
  type: 'object'
  position: { x: number; y: number }
  data: OpsNodeData
}

export interface OpsEdge {
  id: string
  source: string
  target: string
  type: 'smoothstep'
}

export interface OpsGraph {
  nodes: OpsNode[]
  edges: OpsEdge[]
}
