'use client'

/**
 * AC P-D — the AI Control "Autopilot" canvas (React Flow). Renders the control flow as a node
 * graph: Signals → Goal → Control modules → Guardrails → Actions. Module nodes toggle on click;
 * live AutopilotDecisions pulse the module they touch. Used both compact+read-only inside the SP
 * Super Wizard's AI-Control step and full/editable on the control-room page.
 *
 * RC.1 — generalized: pass an optional `spec` to drive the columns with ANY labels (used by Rule
 * Setting's control preview). With no `spec`, it renders the exact AI-Control layout from `config`,
 * so the AI path is unchanged.
 * NOTE: requires `@xyflow/react` (added in P-D). See docs/ai-control-autopilot-spec.md.
 */
import { useEffect, useMemo } from 'react'
import {
  ReactFlow, Background, Controls, MiniMap, Handle, Position, MarkerType,
  useNodesState, useEdgesState, type Node, type Edge, type NodeProps,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import './autopilot-canvas.css'

export interface CanvasConfig {
  goal: string
  modules: Record<string, boolean> // bid·budget·placement·rank·dayparting·harvest·negate
}

// RC.1 — generalized node spec. When provided, drives the canvas columns directly; otherwise the AI
// defaults below (SIGNALS/MODULES/GOAL_LABEL) build the spec from `config`.
export interface CanvasSpec {
  signals: Array<{ id: string; label: string; sub: string }>
  goalEyebrow?: string
  goalLabel: string
  modules: Array<{ key: string; label: string; sub: string; on: boolean; delegated?: boolean }>
  guardrailLabel?: string
  guardrailSub?: string
  outputLabel?: string
  outputSub?: string
}

const GOAL_LABEL: Record<string, string> = { LAUNCH: 'Launch', PROFIT: 'Profit', BALANCED: 'Balanced', LIQUIDATE: 'Liquidate', DEFEND_RANK: 'Defend Rank' }
const SIGNALS = [
  { id: 'sig-perf', label: 'Performance', sub: 'spend · sales · ACoS · CVR' },
  { id: 'sig-profit', label: 'Profit', sub: 'margin · break-even ACoS' },
  { id: 'sig-inv', label: 'Inventory', sub: 'days of supply' },
  { id: 'sig-rank', label: 'Rank', sub: 'Top-of-Search IS' },
]
const MODULES = [
  { key: 'bid', label: 'Bid', sub: 'tACoS · θ_inv · θ_intra' },
  { key: 'budget', label: 'Budget', sub: 'pacing · rebalance' },
  { key: 'placement', label: 'Placement', sub: 'ToS / PDP / RoS' },
  { key: 'rank', label: 'Rank Defense', sub: 'IS controller' },
  { key: 'dayparting', label: 'Dayparting', sub: 'time windows' },
  { key: 'harvest', label: 'Harvest', sub: 'via Rule Setting', delegated: true },
  { key: 'negate', label: 'Negate', sub: 'via Rule Setting', delegated: true },
]

interface ResolvedSpec {
  signals: Array<{ id: string; label: string; sub: string }>
  goalEyebrow: string; goalLabel: string
  modules: Array<{ key: string; label: string; sub: string; on: boolean; delegated?: boolean }>
  guardrailLabel: string; guardrailSub: string
  outputLabel: string; outputSub: string
}

function resolveSpec(config?: CanvasConfig, spec?: CanvasSpec): ResolvedSpec {
  if (spec) return {
    signals: spec.signals,
    goalEyebrow: spec.goalEyebrow ?? 'Goal', goalLabel: spec.goalLabel,
    modules: spec.modules,
    guardrailLabel: spec.guardrailLabel ?? 'Guardrails', guardrailSub: spec.guardrailSub ?? '',
    outputLabel: spec.outputLabel ?? 'Actions', outputSub: spec.outputSub ?? 'write-gated · audited · reversible',
  }
  const cfg = config ?? { goal: 'BALANCED', modules: {} }
  return {
    signals: SIGNALS,
    goalEyebrow: 'Goal', goalLabel: GOAL_LABEL[cfg.goal] ?? cfg.goal,
    modules: MODULES.map((m) => ({ key: m.key, label: m.label, sub: m.sub, on: cfg.modules[m.key] !== false, delegated: m.delegated })),
    guardrailLabel: 'Guardrails', guardrailSub: 'bid · budget · spend cap · ramp · never-pause',
    outputLabel: 'Actions', outputSub: 'write-gated · audited · reversible',
  }
}

// ── custom nodes ──────────────────────────────────────────────────────────
function SignalNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string }
  return (<div className="apc-node apc-signal"><Handle type="source" position={Position.Right} /><b>{d.label}</b><span>{d.sub}</span></div>)
}
function GoalNode({ data }: NodeProps) {
  const d = data as { eyebrow: string; label: string }
  return (<div className="apc-node apc-goal"><Handle type="target" position={Position.Left} /><span className="eyebrow">{d.eyebrow}</span><b>{d.label}</b><Handle type="source" position={Position.Right} /></div>)
}
function ModuleNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string; on: boolean; active: boolean; delegated?: boolean; readOnly?: boolean; onToggle?: () => void }
  return (
    <div className={`apc-node apc-module ${d.on ? 'on' : 'off'} ${d.active ? 'active' : ''} ${d.delegated ? 'delegated' : ''}`} onClick={() => !d.readOnly && d.onToggle?.()} role={d.readOnly ? undefined : 'button'} aria-pressed={d.on}>
      <Handle type="target" position={Position.Left} />
      <span className="dot" /><b>{d.label}</b><span>{d.sub}</span>
      <Handle type="source" position={Position.Right} />
    </div>
  )
}
function GuardrailNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string }
  return (<div className="apc-node apc-guard"><Handle type="target" position={Position.Left} /><b>{d.label}</b><span>{d.sub}</span><Handle type="source" position={Position.Right} /></div>)
}
function OutputNode({ data }: NodeProps) {
  const d = data as { label: string; sub: string }
  return (<div className="apc-node apc-output"><Handle type="target" position={Position.Left} /><b>{d.label}</b><span>{d.sub}</span></div>)
}
const nodeTypes = { signal: SignalNode, goal: GoalNode, module: ModuleNode, guardrail: GuardrailNode, output: OutputNode }

// ── layout: 5 columns (signals → goal → modules → guardrail → output) ──────
function buildGraph(spec: ResolvedSpec, active: Set<string>, readOnly: boolean, onToggle: (k: string) => void): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = []
  const edges: Edge[] = []
  spec.signals.forEach((s, i) => nodes.push({ id: s.id, type: 'signal', position: { x: 0, y: i * 92 }, data: { label: s.label, sub: s.sub } }))
  nodes.push({ id: 'goal', type: 'goal', position: { x: 260, y: 130 }, data: { eyebrow: spec.goalEyebrow, label: spec.goalLabel } })
  spec.modules.forEach((m, i) => nodes.push({ id: `mod-${m.key}`, type: 'module', position: { x: 540, y: i * 80 }, data: { label: m.label, sub: m.sub, on: m.on, active: active.has(m.key), delegated: m.delegated, readOnly, onToggle: () => onToggle(m.key) } }))
  nodes.push({ id: 'guard', type: 'guardrail', position: { x: 840, y: 210 }, data: { label: spec.guardrailLabel, sub: spec.guardrailSub } })
  nodes.push({ id: 'output', type: 'output', position: { x: 1110, y: 210 }, data: { label: spec.outputLabel, sub: spec.outputSub } })

  const edge = (id: string, source: string, target: string, on = true): Edge => ({ id, source, target, animated: on, markerEnd: { type: MarkerType.ArrowClosed }, style: { stroke: on ? '#1f6fde' : '#cfd6df', strokeWidth: on ? 1.6 : 1 } })
  spec.signals.forEach((s) => edges.push(edge(`e-${s.id}-goal`, s.id, 'goal')))
  spec.modules.forEach((m) => {
    edges.push(edge(`e-goal-${m.key}`, 'goal', `mod-${m.key}`, m.on))
    edges.push(edge(`e-${m.key}-guard`, `mod-${m.key}`, 'guard', m.on))
  })
  edges.push(edge('e-guard-output', 'guard', 'output'))
  return { nodes, edges }
}

export function AutopilotCanvas({ config, spec, activeModules, readOnly = false, compact = false, onToggleModule }: {
  config?: CanvasConfig
  spec?: CanvasSpec
  activeModules?: string[]
  readOnly?: boolean
  compact?: boolean
  onToggleModule?: (key: string) => void
}) {
  const active = useMemo(() => new Set(activeModules ?? []), [activeModules])
  const resolved = useMemo(() => resolveSpec(config, spec), [config, spec])
  const initial = useMemo(() => buildGraph(resolved, active, readOnly, (k) => onToggleModule?.(k)), []) // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges)

  // reflect config / live activity without clobbering dragged positions
  useEffect(() => {
    setNodes((cur) => cur.map((n) => {
      if (n.type === 'goal') return { ...n, data: { ...n.data, eyebrow: resolved.goalEyebrow, label: resolved.goalLabel } }
      if (n.type === 'guardrail') return { ...n, data: { ...n.data, label: resolved.guardrailLabel, sub: resolved.guardrailSub } }
      if (n.type === 'output') return { ...n, data: { ...n.data, label: resolved.outputLabel, sub: resolved.outputSub } }
      if (n.type === 'module') { const key = n.id.replace('mod-', ''); const m = resolved.modules.find((x) => x.key === key); return { ...n, data: { ...n.data, on: m?.on ?? false, active: active.has(key), readOnly, onToggle: () => onToggleModule?.(key) } } }
      return n
    }))
    setEdges(buildGraph(resolved, active, readOnly, (k) => onToggleModule?.(k)).edges)
  }, [resolved, active, readOnly, onToggleModule, setNodes, setEdges])

  return (
    <div className={`apc-wrap ${compact ? 'compact' : ''}`}>
      <ReactFlow
        nodes={nodes} edges={edges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        nodesConnectable={false} edgesFocusable={false} fitView proOptions={{ hideAttribution: true }}
        nodesDraggable={!readOnly} panOnDrag zoomOnScroll={!compact}
      >
        <Background gap={18} color="#e6e9ee" />
        {!compact && <Controls showInteractive={false} />}
        {!compact && <MiniMap pannable zoomable nodeColor={(n) => (n.type === 'module' ? '#1f6fde' : '#9aa3b0')} />}
      </ReactFlow>
    </div>
  )
}
