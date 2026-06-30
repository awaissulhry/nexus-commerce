export type ObjectKind = 'market' | 'portfolio' | 'campaign' | 'adgroup' | 'target'
export type Health = 'ok' | 'warn' | 'bad'

export interface OpsDetail {
  sales?: number // EUR
  roas?: number
  impressions?: number
  clicks?: number
  orders?: number
  trueProfitCents?: number
  marginPct?: number // fraction
  status?: string
  adType?: string
  dailyBudget?: number // EUR
  lastSyncedAt?: string | null
}

export interface OpsObject {
  id: string
  kind: ObjectKind
  name: string
  parentId?: string
  spend?: number // EUR
  acos?: number // fraction, e.g. 0.24 = 24%
  health?: Health
  detail?: OpsDetail
}

export interface OpsNodeData {
  kind: ObjectKind
  name: string
  spend?: number
  acos?: number
  health?: Health
  hasChildren?: boolean
  childCount?: number
  expanded?: boolean
  selected?: boolean
  checked?: boolean
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
