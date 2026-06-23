'use client'

/**
 * BM.B4 — Budget Allocation Map. A React Flow canvas (same stack as the AI-Control
 * AutopilotCanvas) that visualises the BM.B3 enforcement preview for one market:
 * the monthly Envelope node → each campaign node, current daily budget → paced
 * target, edge thickness ∝ target share, colour-coded by clamp/suppression. Lets
 * operators SEE how Auto Pacing would redistribute the envelope before anything is
 * applied (it's the dry-run preview, rendered).
 */
import { useMemo } from 'react'
import {
  ReactFlow, Background, Controls, Handle, Position, MarkerType,
  useNodesState, useEdgesState, type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './allocation-canvas.css'

interface CampaignDecision { id: string; name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: 'min' | 'max' | 'floor' | null; suppress: boolean; restore: boolean; currentlySuppressed: boolean }
interface PlanDecision { marketplace: string; month: string; capCents: number; mtdSpendCents: number; remainingBudgetCents: number; remainingDays: number; dayOfMonth: number; daysInMonth: number; autoPacing: boolean; stopOverSpend: boolean; capReached: boolean; todayTargetCents: number | null; campaigns: CampaignDecision[] }

const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland' }
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪' }
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const MAX_NODES = 14

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
  const d = data as { name: string; currentDailyCents: number; targetDailyCents: number | null; deltaCents: number; clamp: string | null; suppress: boolean; currentlySuppressed: boolean }
  const up = d.deltaCents > 0, down = d.deltaCents < 0
  return (
    <div className={`bmc-node bmc-camp ${d.suppress || d.currentlySuppressed ? 'suppress' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <b title={d.name}>{d.name}</b>
      <span className="flow">{eur(d.currentDailyCents)} <i className={up ? 'up' : down ? 'down' : ''}>→</i> {d.targetDailyCents != null ? eur(d.targetDailyCents) : '—'}{d.clamp ? <em className="clamp">{d.clamp}</em> : null}</span>
      {(d.suppress || d.currentlySuppressed) && <span className="supp">bids floored ~€0.02</span>}
    </div>
  )
}
function MoreNode({ data }: NodeProps) {
  const d = data as { count: number; sumCents: number }
  return (<div className="bmc-node bmc-more"><Handle type="target" position={Position.Left} />+{d.count} more campaigns<span className="sub">{eur(d.sumCents)}/day</span></div>)
}
const nodeTypes = { envelope: EnvelopeNode, campaign: CampaignNode, more: MoreNode }

function buildGraph(plan: PlanDecision): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const ranked = plan.campaigns.slice().sort((a, b) => (b.targetDailyCents ?? b.currentDailyCents) - (a.targetDailyCents ?? a.currentDailyCents))
  const shown = ranked.slice(0, MAX_NODES)
  const rest = ranked.slice(MAX_NODES)
  const rows = shown.length + (rest.length ? 1 : 0)
  const colH = Math.max(1, rows) * 78
  nodes.push({ id: 'env', type: 'envelope', position: { x: 0, y: Math.max(0, colH / 2 - 70) }, data: { ...plan } as Record<string, unknown>, draggable: false })
  const maxTarget = Math.max(1, ...shown.map((c) => c.targetDailyCents ?? c.currentDailyCents))
  shown.forEach((c, i) => {
    nodes.push({ id: c.id, type: 'campaign', position: { x: 420, y: i * 78 }, data: { ...c } as Record<string, unknown> })
    const w = 1 + 4 * ((c.targetDailyCents ?? c.currentDailyCents) / maxTarget)
    const supp = c.suppress || c.currentlySuppressed
    edges.push({ id: `e-${c.id}`, source: 'env', target: c.id, animated: !supp, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: supp ? '#d9534f' : c.deltaCents > 0 ? '#1f9d5b' : c.deltaCents < 0 ? '#e0a92e' : '#9aa3b0', strokeWidth: w } })
  })
  if (rest.length) {
    const sum = rest.reduce((s, c) => s + (c.targetDailyCents ?? 0), 0)
    nodes.push({ id: 'more', type: 'more', position: { x: 420, y: shown.length * 78 }, data: { count: rest.length, sumCents: sum }, draggable: false })
    edges.push({ id: 'e-more', source: 'env', target: 'more', animated: false, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: '#cfd6df', strokeWidth: 1 } })
  }
  return { nodes, edges }
}

export function AllocationCanvas({ plan }: { plan: PlanDecision }) {
  const initial = useMemo(() => buildGraph(plan), [plan])
  const [nodes, , onNodesChange] = useNodesState(initial.nodes)
  const [edges, , onEdgesChange] = useEdgesState(initial.edges)
  return (
    <div className="bmc-wrap">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} nodesConnectable={false} edgesFocusable={false} fitView proOptions={{ hideAttribution: true }} panOnDrag zoomOnScroll minZoom={0.3}>
        <Background gap={18} color="#e6e9ee" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
