'use client'

/**
 * BM.B4 + CP.2 + P1.2 — Control Plane canvas (React Flow). Rooted at the market
 * Envelope → campaigns (with the budget overlay current→paced); P1.2 adds
 * drill-down: focusing a campaign reveals its ad groups (column 3), focusing an
 * ad group reveals its targets (column 4). Any node is selectable (→ Inspector)
 * and reflects STAGED scenario changes (current→staged, dashed accent) before
 * commit. Miller-column drill keeps the layout simple and the budget view intact.
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
export interface OntoNode { id: string; type: 'campaign' | 'adgroup' | 'target'; name: string; status: string; spendCents: number; hasChildren: boolean; dailyBudgetCents?: number; suppressed?: boolean; defaultBidCents?: number; targetingType?: string; bidCents?: number; kind?: string; expressionType?: string }
export interface StagedChange { entityType?: 'campaign' | 'adgroup' | 'target'; budgetCents?: number; minCents?: number | null; maxCents?: number | null; suppress?: boolean; bidCents?: number; status?: 'ENABLED' | 'PAUSED' | 'ARCHIVED'; biddingStrategy?: string; targetAcos?: number; placements?: { tos?: number | null; pdp?: number | null; ros?: number | null } }
export type SelectRef = { id: string; type: 'campaign' | 'adgroup' | 'target' } | null

const MARKET_NAME: Record<string, string> = { IT: 'Italy', DE: 'Germany', FR: 'France', ES: 'Spain', GB: 'United Kingdom', UK: 'United Kingdom', NL: 'Netherlands', SE: 'Sweden', PL: 'Poland', BE: 'Belgium', IE: 'Ireland' }
const FLAG: Record<string, string> = { IT: '🇮🇹', DE: '🇩🇪', FR: '🇫🇷', ES: '🇪🇸', GB: '🇬🇧', UK: '🇬🇧', NL: '🇳🇱', SE: '🇸🇪', PL: '🇵🇱', BE: '🇧🇪', IE: '🇮🇪' }
const eur = (c: number | null | undefined) => (c == null ? '—' : `€${(c / 100).toLocaleString('en-IE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const MAX_CAMP = 14
const MAX_CHILD = 18
const hasStage = (s?: StagedChange) => !!s && (s.budgetCents != null || s.suppress != null || s.minCents !== undefined || s.maxCents !== undefined || s.bidCents != null || s.status != null || s.biddingStrategy != null || s.targetAcos != null || s.placements != null)
const dot = (status: string) => (status === 'ENABLED' ? 'on' : status === 'PAUSED' ? 'pa' : 'ar')

const COL = { env: 0, camp: 380, ag: 760, tg: 1140 }

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
  const d = data as unknown as CampaignDecision & { selected?: boolean; staged?: StagedChange; focused?: boolean }
  const st = d.staged
  const staged = hasStage(st)
  const suppressed = st?.suppress != null ? st.suppress : (d.suppress || d.currentlySuppressed)
  const up = d.deltaCents > 0, down = d.deltaCents < 0
  return (
    <div className={`bmc-node bmc-camp ${suppressed ? 'suppress' : ''} ${d.selected ? 'sel' : ''} ${staged ? 'staged' : ''} ${d.focused ? 'focus' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <b title={d.name}>{d.name}</b>
      <span className="flow">{eur(d.currentDailyCents)} <i className={up ? 'up' : down ? 'down' : ''}>→</i> {st?.budgetCents != null ? <em className="stg">{eur(st.budgetCents)}</em> : (d.targetDailyCents != null ? eur(d.targetDailyCents) : '—')}{d.clamp ? <em className="clamp">{d.clamp}</em> : null}</span>
      {suppressed && <span className="supp">bids floored ~€0.02</span>}
      {staged && <span className="stgtag">● staged</span>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
function AdGroupNode({ data }: NodeProps) {
  const d = data as unknown as OntoNode & { selected?: boolean; staged?: StagedChange; focused?: boolean }
  const st = d.staged
  const status = st?.status ?? d.status
  const bid = st?.bidCents ?? d.defaultBidCents
  return (
    <div className={`bmc-node bmc-ag ${d.selected ? 'sel' : ''} ${hasStage(st) ? 'staged' : ''} ${d.focused ? 'focus' : ''} ${status !== 'ENABLED' ? 'paused' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className="hd"><span className={`cdot ${dot(status)}`} /><b title={d.name}>{d.name}</b></span>
      <span className="meta">{d.targetingType ?? 'MANUAL'} · bid <em className={st?.bidCents != null ? 'stg' : ''}>{eur(bid)}</em> · {eur(d.spendCents)}</span>
      {d.hasChildren && <Handle type="source" position={Position.Right} />}
    </div>
  )
}
function TargetNode({ data }: NodeProps) {
  const d = data as unknown as OntoNode & { selected?: boolean; staged?: StagedChange }
  const st = d.staged
  const status = st?.status ?? d.status
  const bid = st?.bidCents ?? d.bidCents
  return (
    <div className={`bmc-node bmc-tg ${d.selected ? 'sel' : ''} ${hasStage(st) ? 'staged' : ''} ${status !== 'ENABLED' ? 'paused' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <span className="hd"><span className={`cdot ${dot(status)}`} /><b title={d.name}>{d.name}</b></span>
      <span className="meta"><em className="mt">{d.expressionType ?? d.kind}</em> bid <em className={st?.bidCents != null ? 'stg' : ''}>{eur(bid)}</em> · {eur(d.spendCents)}</span>
    </div>
  )
}
function MoreNode({ data }: NodeProps) {
  const d = data as { count: number; sumCents: number }
  return (<div className="bmc-node bmc-more"><Handle type="target" position={Position.Left} />+{d.count} more<span className="sub">{eur(d.sumCents)}/day</span></div>)
}
const nodeTypes = { envelope: EnvelopeNode, campaign: CampaignNode, adgroup: AdGroupNode, target: TargetNode, more: MoreNode }

function buildGraph(plan: PlanDecision, selectedId: string | null, staged: Record<string, StagedChange>, adGroups: OntoNode[] | null, targets: OntoNode[] | null, focusCampaign: string | null, focusAdGroup: string | null): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  const ranked = plan.campaigns.slice().sort((a, b) => (b.targetDailyCents ?? b.currentDailyCents) - (a.targetDailyCents ?? a.currentDailyCents))
  const shown = ranked.slice(0, MAX_CAMP)
  const rest = ranked.slice(MAX_CAMP)
  const rows = shown.length + (rest.length ? 1 : 0)
  const colH = Math.max(1, rows) * 78
  nodes.push({ id: 'env', type: 'envelope', position: { x: COL.env, y: Math.max(0, colH / 2 - 70) }, data: { ...plan } as Record<string, unknown>, draggable: false, selectable: false })
  const maxTarget = Math.max(1, ...shown.map((c) => c.targetDailyCents ?? c.currentDailyCents))
  const edge = (id: string, s: string, t: string, color: string, w = 1.4, dash = false, anim = true): Edge => ({ id, source: s, target: t, animated: anim, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: color, strokeWidth: w, strokeDasharray: dash ? '5 3' : undefined } })
  shown.forEach((c, i) => {
    const st = staged[c.id]
    nodes.push({ id: c.id, type: 'campaign', position: { x: COL.camp, y: i * 78 }, draggable: false, data: { ...c, selected: selectedId === c.id, staged: st, focused: focusCampaign === c.id } as Record<string, unknown> })
    const share = (st?.budgetCents ?? c.targetDailyCents ?? c.currentDailyCents) / maxTarget
    const supp = st?.suppress != null ? st.suppress : (c.suppress || c.currentlySuppressed)
    edges.push(edge(`e-${c.id}`, 'env', c.id, hasStage(st) ? '#7c3aed' : supp ? '#d9534f' : c.deltaCents > 0 ? '#1f9d5b' : c.deltaCents < 0 ? '#e0a92e' : '#9aa3b0', 1 + 4 * Math.max(0, share), hasStage(st), !supp))
  })
  if (rest.length) {
    const sum = rest.reduce((s, c) => s + (c.targetDailyCents ?? 0), 0)
    nodes.push({ id: 'more', type: 'more', position: { x: COL.camp, y: shown.length * 78 }, draggable: false, selectable: false, data: { count: rest.length, sumCents: sum } })
    edges.push(edge('e-more', 'env', 'more', '#cfd6df', 1, false, false))
  }
  // column 3 — ad groups of the focused campaign
  if (focusCampaign && adGroups) {
    const ags = adGroups.slice(0, MAX_CHILD)
    ags.forEach((g, i) => {
      const st = staged[g.id]
      nodes.push({ id: g.id, type: 'adgroup', position: { x: COL.ag, y: i * 72 }, draggable: false, data: { ...g, selected: selectedId === g.id, staged: st, focused: focusAdGroup === g.id } as Record<string, unknown> })
      edges.push(edge(`ea-${g.id}`, focusCampaign, g.id, hasStage(st) ? '#7c3aed' : g.status !== 'ENABLED' ? '#cbd2db' : '#9aa3b0', 1.4, hasStage(st), g.status === 'ENABLED'))
    })
  }
  // column 4 — targets of the focused ad group
  if (focusAdGroup && targets) {
    const tgs = targets.slice(0, MAX_CHILD)
    tgs.forEach((t, i) => {
      const st = staged[t.id]
      nodes.push({ id: t.id, type: 'target', position: { x: COL.tg, y: i * 64 }, draggable: false, data: { ...t, selected: selectedId === t.id, staged: st } as Record<string, unknown> })
      edges.push(edge(`et-${t.id}`, focusAdGroup, t.id, hasStage(st) ? '#7c3aed' : t.status !== 'ENABLED' ? '#cbd2db' : '#9aa3b0', 1.3, hasStage(st), t.status === 'ENABLED'))
    })
  }
  return { nodes, edges }
}

export function AllocationCanvas({ plan, selectedId = null, onSelect, staged = {}, adGroups = null, targets = null, focusCampaign = null, focusAdGroup = null }: {
  plan: PlanDecision
  selectedId?: string | null
  onSelect?: (ref: SelectRef) => void
  staged?: Record<string, StagedChange>
  adGroups?: OntoNode[] | null
  targets?: OntoNode[] | null
  focusCampaign?: string | null
  focusAdGroup?: string | null
}) {
  const initial = useMemo(() => buildGraph(plan, selectedId, staged, adGroups, targets, focusCampaign, focusAdGroup), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)
  useEffect(() => { const g = buildGraph(plan, selectedId, staged, adGroups, targets, focusCampaign, focusAdGroup); setNodes(g.nodes); setEdges(g.edges) }, [plan, selectedId, staged, adGroups, targets, focusCampaign, focusAdGroup, setNodes, setEdges])

  return (
    <div className="bmc-wrap">
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onNodeClick={(_, n) => onSelect?.(n.type === 'campaign' || n.type === 'adgroup' || n.type === 'target' ? { id: n.id, type: n.type } : null)}
        onPaneClick={() => onSelect?.(null)}
        nodesConnectable={false} edgesFocusable={false} fitView proOptions={{ hideAttribution: true }}
        panOnDrag zoomOnScroll minZoom={0.25}
      >
        <Background gap={18} color="#e6e9ee" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
