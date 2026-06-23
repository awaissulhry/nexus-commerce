'use client'

/**
 * BM.B4 + CP.2 — Budget Allocation Map / Control Plane canvas. A React Flow canvas
 * (same stack as AutopilotCanvas) over one market: the monthly Envelope node → each
 * campaign node (current daily budget → paced target). In CP.2 the campaign nodes are
 * selectable (onNodeClick → onSelect) and reflect STAGED changes from the scenario
 * (current → staged value, dashed accent) before anything is committed.
 */
import { useEffect, useMemo } from 'react'
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  useNodesState, useEdgesState, type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './allocation-canvas.css'

interface CampaignDecision { id: string; name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: 'min' | 'max' | 'floor' | null; suppress: boolean; restore: boolean; currentlySuppressed: boolean }
interface PlanDecision { marketplace: string; month: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; dayOfMonth: number; daysInMonth: number; autoPacing: boolean; stopOverSpend: boolean; capReached: boolean; todayTargetCents: number | null; campaigns: CampaignDecision[] }
export interface StagedChange { budgetCents?: number; minCents?: number | null; maxCents?: number | null; suppress?: boolean }

const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland' }
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪' }
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const MAX_NODES = 14
const hasStage = (s?: StagedChange) => !!s && (s.budgetCents != null || s.suppress != null || s.minCents !== undefined || s.maxCents !== undefined)

function EnvelopeNode({ data }: NodeProps) {
  const d = data as { marketplace: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; todayTargetCents: number | null; capReached: boolean; autoPacing: boolean; stopOverSpend: boolean }
  const pct = d.capCents > 0 ? Math.min(100, (d.mtdSpendCents / d.capCents) * 100) : 0
  return (
    <div className={`bmc-node bmc-env ${d.capReached ? 'over' : ''}`}>
      <span className="eyebrow">{FLAG[d.marketplace] ?? '🌐'} {MARKET_NAME[d.marketplace] ?? d.marketplace} · Monthly envelope</span>
      <b>{eur(d.capCents)}</b>
      <div className="bmc-bar"><span style={{ width: `${pct}%` }} className={d.capReached ? 'over' : ''} /></div>
      <span className="sub">Spent {eur(d.mtdSpendCents)} · {d.capReached ? 'cap reached' : `${eur(d.remainingBudgetCents)} over ${d.remainingDays}d`}</span>
      <span className="sub2">{d.autoPacing ? `Pacing · today ${eur(d.todayTargetCents)}` : 'Pacing off'}{d.stopOverSpend ? ' · Stop-over-spend on' : ''}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
function CampaignNode({ data }: NodeProps) {
  const d = data as { name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: string | null; suppress: boolean; currentlySuppressed: boolean; selected?: boolean; staged?: StagedChange }
  const st = d.staged
  const staged = hasStage(st)
  const suppressed = st?.suppress != null ? st.suppress : (d.suppress || d.currentlySuppressed)
  const up = d.deltaCents > 0, down = d.deltaCents < 0
  return (
    <div className={`bmc-node bmc-camp ${suppressed ? 'suppress' : ''} ${d.selected ? 'sel' : ''} ${staged ? 'staged' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <b title={d.name}>{d.name}</b>
      <span className="flow">{eur(d.currentDailyCents)} <i className={up ? 'up' : down ? 'down' : ''}>→</i> {st?.budgetCents != null ? <em className="stg">{eur(st.budgetCents)}</em> : (d.targetDailyCents != null ? eur(d.targetDailyCents) : '—')}{d.clamp ? <em className="clamp">{d.clamp}</em> : null}</span>
      {suppressed && <span className="supp">bids floored ~€0.02</span>}
      {staged && <span className="stgtag">● staged</span>}
    </div>
  )
}
function MoreNode({ data }: NodeProps) {
  const d = data as { count: number; sumCents: number }
  return (<div className="bmc-node bmc-more"><Handle type="target" position={Position.Left} />+{d.count} more campaigns<span className="sub">{eur(d.sumCents)}/day</span></div>)
}
const nodeTypes = { envelope: EnvelopeNode, campaign: CampaignNode, more: MoreNode }

function buildGraph(plan: PlanDecision, selectedId: string | null, staged: Record<string, StagedChange>): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const ranked = plan.campaigns.slice().sort((a, b) => (b.targetDailyCents ?? b.currentDailyCents) - (a.targetDailyCents ?? a.currentDailyCents))
  const shown = ranked.slice(0, MAX_NODES)
  const rest = ranked.slice(MAX_NODES)
  const rows = shown.length + (rest.length ? 1 : 0)
  const colH = Math.max(1, rows) * 78
  nodes.push({ id: 'env', type: 'envelope', position: { x: 0, y: Math.max(0, colH / 2 - 70) }, data: { ...plan } as Record<string, unknown>, draggable: false, selectable: false })
  const maxTarget = Math.max(1, ...shown.map((c) => c.targetDailyCents ?? c.currentDailyCents))
  shown.forEach((c, i) => {
    const st = staged[c.id]
    nodes.push({ id: c.id, type: 'campaign', position: { x: 420, y: i * 78 }, draggable: false, data: { ...c, selected: selectedId === c.id, staged: st } as Record<string, unknown> })
    const share = (st?.budgetCents ?? c.targetDailyCents ?? c.currentDailyCents) / maxTarget
    const w = 1 + 4 * Math.max(0, share)
    const supp = st?.suppress != null ? st.suppress : (c.suppress || c.currentlySuppressed)
    const stagedEdge = hasStage(st)
    edges.push({ id: `e-${c.id}`, source: 'env', target: c.id, animated: !supp, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: stagedEdge ? '#7c3aed' : supp ? '#d9534f' : c.deltaCents > 0 ? '#1f9d5b' : c.deltaCents < 0 ? '#e0a92e' : '#9aa3b0', strokeWidth: w, strokeDasharray: stagedEdge ? '5 3' : undefined } })
  })
  if (rest.length) {
    const sum = rest.reduce((s, c) => s + (c.targetDailyCents ?? 0), 0)
    nodes.push({ id: 'more', type: 'more', position: { x: 420, y: shown.length * 78 }, draggable: false, selectable: false, data: { count: rest.length, sumCents: sum } })
    edges.push({ id: 'e-more', source: 'env', target: 'more', animated: false, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#cfd6df', strokeWidth: 1 } })
  }
  return { nodes, edges }
}

export function AllocationCanvas({ plan, selectedId = null, onSelect, staged = {} }: {
  plan: PlanDecision
  selectedId?: string | null
  onSelect?: (id: string | null) => void
  staged?: Record<string, StagedChange>
}) {
  const initial = useMemo(() => buildGraph(plan, selectedId, staged), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)
  // Rebuild on plan / selection / staging change (small graph; layout is fixed).
  useEffect(() => { const g = buildGraph(plan, selectedId, staged); setNodes(g.nodes); setEdges(g.edges) }, [plan, selectedId, staged, setNodes, setEdges])

  return (
    <div className="bmc-wrap">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect?.(n.type === 'campaign' ? n.id : null)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={false} edgesFocusable={false} fitView proOptions={{ hideAttribution: true }}
        panOnDrag zoomOnScroll minZoom={0.3}
      >
        <Background gap={18} color="#e6e9ee" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
