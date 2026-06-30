import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { OpsNodeData } from './types'

const KIND_LABEL: Record<string, string> = {
  market: 'Market',
  portfolio: 'Portfolio',
  campaign: 'Campaign',
  adgroup: 'Ad Group',
  target: 'Target',
}

export function ObjectNode({ data }: NodeProps) {
  const d = data as OpsNodeData
  const health = d.health ?? 'ok'
  return (
    <div className={`opsn opsn--${health}`}>
      <Handle type="target" position={Position.Left} className="opsn-h" />
      <div className="opsn-kind">{KIND_LABEL[d.kind] ?? d.kind}</div>
      <div className="opsn-title">{d.name}</div>
      <div className="opsn-meta">
        <span className={`opsn-dot opsn-dot--${health}`} />
        <span>{typeof d.spend === 'number' ? `€${d.spend.toLocaleString()}` : '—'}</span>
        {typeof d.acos === 'number' && <span>· {Math.round(d.acos * 100)}%</span>}
      </div>
      <Handle type="source" position={Position.Right} className="opsn-h" />
    </div>
  )
}
